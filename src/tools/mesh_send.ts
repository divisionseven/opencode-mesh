// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Capability-routed send (direct TCP where reachable, outbox claim otherwise)
import { tool } from "@opencode-ai/plugin";
import { OPENCODE_PORT, POST_TIMEOUT_MS, ROUTE_PROBE_TIMEOUT_MS } from "../constants.js";
import { MeshError } from "../errors.js";
import { formatMeshPrefix, meshPrefixLength, quarantineText } from "../frontmatter.js";
import { resolveReceiverWireDetailed } from "../identity.js";
import { isSilent, resolveNoReply } from "../wake.js";
import { assertBodySendable, assertSendable } from "../outbox.js";
import { readRegistry } from "../registry.js";
import { getServerAuthHeaderSync } from "../serverAuth.js";
import { sanitizeSessionId } from "../xdg.js";

type RegistryLike = Record<string, { description?: string; summary?: string; title?: string; agent?: string; repo?: string }>;

// Single shared didYouMean builder for both miss paths (resolve-miss + POST-404), deduped slice(0,5).
function buildDidYouMean(reg: Record<string, unknown>): string[] {
  const rawPeers = Object.values(reg)
    .map(
      (r) =>
        (r as RegistryLike).description ??
        (r as RegistryLike).summary ??
        (r as RegistryLike).title ??
        ((r as RegistryLike).agent && (r as RegistryLike).repo
          ? `${(r as RegistryLike).agent}@${(r as RegistryLike).repo}`
          : ((r as RegistryLike).agent ?? (r as RegistryLike).repo ?? ""))
    )
    .filter(Boolean) as string[];
  return [...new Set(rawPeers)].slice(0, 5);
}

type RegEntry = {
  agent?: string;
  directory?: string;
  cwd?: string;
  model?: string;
};

/** Transient direct-leg failures queue for the claim leg; misses stay loud. */
function isTransientDirectError(err: unknown): boolean {
  if (err instanceof MeshError) {
    if (err.code === "PEER_BUSY_RETRY") return true;
    if (err.code === "SERVER_UNAVAILABLE" && typeof err.status === "number" && err.status >= 500) return true;
    return false;
  }
  return true;
}

/** Broadcast opt-in gate: exact MESH_BROADCAST=1 only, default-off. Single owner. */
function isBroadcastEnabled(): boolean {
  return process.env.MESH_BROADCAST === "1";
}

/**
 * Loopback pin: dials only 127.0.0.1 OPENCODE_PORT; registry addresses never dialed.
 * Probe failure claims instead of throwing, so down servers queue.
 */
async function resolveRoute(viaAuth: string | undefined): Promise<"direct" | "claim"> {
  try {
    const headers: Record<string, string> = {};
    if (viaAuth) headers.Authorization = viaAuth;
    const res = await fetch(`http://127.0.0.1:${OPENCODE_PORT}/session/status`, { headers, signal: AbortSignal.timeout(ROUTE_PROBE_TIMEOUT_MS) });
    if (res.ok) return "direct";
    // Why: degraded leg — any probe failure (timeout, refused, non-ok) claims
    // instead of throwing, so a down server queues instead of dropping.
  } catch {}
  return "claim";
}

/** Loopback POST base; never a registry address. */
function resolvePostBase(): string {
  return `http://127.0.0.1:${OPENCODE_PORT}`;
}

/**
 * Tagged direct-leg outcome; miss degrades to claim with identical behavior.
 */
export type DirectRowOutcome =
  | { ok: true; row: unknown }
  | { ok: false; reason: "direct-fetch-miss" | "direct-parse-fail"; status?: number };

/**
 * Loopback GET under route-probe conventions; miss reads fallthrough, never throws.
 */
export async function fetchDirectRow(peerId: string, viaAuth: string | undefined): Promise<DirectRowOutcome> {
  try {
    const headers: Record<string, string> = {};
    if (viaAuth) headers.Authorization = viaAuth;
    const res = await fetch(`${resolvePostBase()}/session/${peerId}`, {
      headers,
      signal: AbortSignal.timeout(ROUTE_PROBE_TIMEOUT_MS),
    });
    if (res.status !== 200) return { ok: false, reason: "direct-fetch-miss", status: res.status };
    try {
      return { ok: true, row: (await res.json()) as unknown };
    } catch {
      return { ok: false, reason: "direct-parse-fail", status: res.status };
    }
  } catch {
    return { ok: false, reason: "direct-fetch-miss" };
  }
}

export const mesh_send = tool({
  description: "Send text to a peer session via mesh (pure TUI prompt_async). The wire carries the receiver agent as observed; attribution stays in the prefix.",
  args: {
    target: tool.schema.string().describe("Target sessionId or registry name"),
    text: tool.schema.string().describe("Message text to deliver"),
    noReply: tool.schema.boolean().optional().describe("Legacy compat; maps to silent deposit, reply by reverse send"),
    silent: tool.schema.boolean().optional().describe("Canonical per-message silent flag; true deposits history-only, omit follows MESH_WAKE"),
    broadcast: tool.schema.boolean().optional().describe("If true, N sequential POSTs (opt-in MESH_BROADCAST=1, default-off)"),
  },
  async execute(args, ctx) {
    const caller = (ctx as unknown as { sessionID: string }).sessionID;
    const { target, text, noReply, silent, broadcast } = args as { target: string; text: string; noReply?: boolean; silent?: boolean; broadcast?: boolean };
    if (!caller) throw new MeshError("PEER_NOT_FOUND", "session.deleted 404: missing caller sessionID");
    assertSendable(text);
    // Broadcast opt-in gate (default-off): fail loud before any fan-out —
    // zero per-peer sends, zero rows queued. Exact MESH_BROADCAST=1 only.
    if (broadcast || target.trim().toLowerCase() === "all") {
      if (!isBroadcastEnabled()) {
        throw new MeshError("BROADCAST_DISABLED", "broadcast disabled by default; set MESH_BROADCAST=1 to enable");
      }
    }
    // deduped outside N — single readRegistry for the whole operation; the one
    // loopback route probe happens once per operation (broadcast) or once per send.
    const reg = await readRegistry();
    // Unicast resolves against the display union (DB existence plus registry
    // claims): DB-only peers are sendable. Lazy import defers the sqlite edge
    // to call time, same pattern as mesh_peers (no static sqlite edge).
    const { joinAll } = await import("../discovery.js");
    const { peers: unionPeers } = await joinAll();
    const registryIds = new Set(Object.keys(reg));
    for (const [id, peer] of Object.entries(unionPeers)) {
      if (!(id in reg)) (reg as Record<string, unknown>)[id] = peer;
    }
    const auth = getServerAuthHeaderSync();
    const basename = (p: string) => p.split("/").pop() || p;
    const q = (s: string) => s.toLowerCase();
    const needle = q(target.trim());
    // Why: exact-only resolution (evaluated at 404 time):
    // exact session id, or exact full-field agent@repo denoting exactly one
    // row. Every other shape misses with PEER_NOT_FOUND + didYouMean[0..5].
    const resolveTarget = (): string | null => {
      const entries = Object.entries(reg) as unknown as Array<[string, Record<string, unknown>]>;
      const rawTarget = target.trim();
      const hit = entries.find(([id]) => id === rawTarget);
      if (hit) return hit[0];
      const matches = entries.filter(([, v]) => {
        const a = q((v.agent as string) ?? "");
        const repo = q((v.repo as string) ?? basename((v.directory as string) ?? (v.cwd as string) ?? ""));
        return `${a}@${repo}` === needle;
      });
      if (matches.length === 1) return matches[0][0];
      return null;
    };

    const directoryFromCtx = (ctx as unknown as { directory: string }).directory;
    const agentFromCtx = (ctx as unknown as { agent: string }).agent;
    const sendDirect = async (peerId: string, from: string, msgText: string, viaAuth: string | undefined, dir: string | undefined, wakeOpts?: { silent?: boolean; noReply?: boolean }): Promise<string | null> => {
      // Lazy outbox import at call time (module carries zero static sqlite edges,
      // so the direct TCP path never touches storage): always-branded wire ID rule.
      const { newMessageId } = await import("../outbox.js");
      const fromEntry = (reg as Record<string, { agent?: string; directory?: string; cwd?: string }>)[from];
      const fromAgent = agentFromCtx ?? fromEntry?.agent ?? "unknown";
      const silentBit = isSilent(wakeOpts);
      const prefixed = `${formatMeshPrefix(fromAgent, from, true, silentBit)}\n\n${quarantineText(msgText)}`;
      // Why: single-owned guard — runtime-measured prefix plus body, never estimated.
      assertSendable(msgText, meshPrefixLength(fromAgent, from, true, silentBit));
      // Direct-leg live read feeds resolver live layer; miss falls through to DB.
      // Unresolvable rows queue for claim leg with full-trail deferred lines.
      const direct = await fetchDirectRow(peerId, viaAuth);
      const directRow = direct.ok ? direct.row : null;
      // Directory fence: wire uses target scope, never sender cwd; unknown falls back.
      const peerEntry = (reg as Record<string, { directory?: string; cwd?: string }>)[peerId];
      const directory = peerEntry?.directory ?? peerEntry?.cwd ?? dir ?? fromEntry?.directory ?? fromEntry?.cwd ?? process.cwd();
      // Receiver triple uses receiver agent plus model; unresolvable degrades to claim.
      const receiver = (
        await resolveReceiverWireDetailed(null, peerId, (reg as Record<string, RegEntry>)[peerId], { directRow })
      ).receiver;
      if (!receiver) return null;
      const parts = [{ type: "text" as const, text: prefixed }];
      // Why: no inline send-path sleeps — jitter lives inside queue policy
      // (claimer busy-wait). Direct admit never waits on peer state.
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (viaAuth) headers.Authorization = viaAuth;
      if (directory) headers["x-opencode-directory"] = encodeURIComponent(directory);
      const url = `${resolvePostBase()}/session/${peerId}/prompt_async?directory=${encodeURIComponent(directory)}`;
      // Always-branded messageID: 204 carries no body, so wire ID is by construction.
      const body = JSON.stringify({
        agent: receiver.agent,
        parts,
        messageID: newMessageId(),
        model: receiver.model,
        ...(receiver.variant !== undefined ? { variant: receiver.variant } : {}),
        ...resolveNoReply(wakeOpts),
      });
      assertBodySendable(Buffer.byteLength(body, "utf8"));
      const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
      if (res.status === 404) {
        const peers = buildDidYouMean(reg);
        throw new MeshError("PEER_NOT_FOUND", `peer not found: ${peerId}`, { didYouMean: peers });
      }
      if (res.status === 401) throw new MeshError("UNAUTHORIZED", "unauthorized 401 Basic mismatch");
      if (res.status === 413) throw new MeshError("PAYLOAD_TOO_LARGE", "1MB guard 413");
      // Every non-204 is typed; 429 retries, others are server-side with raw status.
      // Upstream 204-only NoContent success; live pair deferred, never superset.
      if (res.status === 429) throw new MeshError("PEER_BUSY_RETRY", `peer busy 429: ${peerId}`, { status: 429 });
      if (res.status !== 204) throw new MeshError("SERVER_UNAVAILABLE", `promptAsync failed ${res.status}`, { status: res.status });
      return JSON.parse(body).messageID as string;
    };

    const sendClaim = async (peerId: string, from: string, msgText: string, fanoutId?: string, wakeOpts?: { silent?: boolean; noReply?: boolean }): Promise<string> => {
      const { enqueue } = await import("../outbox.js");
      const fromEntry = (reg as Record<string, { agent?: string }>)[from];
      const fromAgent = agentFromCtx ?? fromEntry?.agent ?? "unknown";
      return enqueue(
        { target_session: peerId, from_session: from, from_agent: fromAgent, text: msgText, broadcast_id: fanoutId, silent: wakeOpts?.silent ?? wakeOpts?.noReply ?? false },
        undefined
      );
    };

    const sendIdentical = async (
      peerId: string,
      from: string,
      msgText: string,
      viaAuth: string | undefined,
      dir: string | undefined,
      route: "direct" | "claim",
      fanoutId?: string
    ): Promise<{ id: string; via: string }> => {
      sanitizeSessionId(peerId);
      sanitizeSessionId(from);
      if (route === "direct") {
        try {
          const id = await sendDirect(peerId, from, msgText, viaAuth, dir, { silent, noReply });
          if (id !== null) return { id, via: "admitted" };
          // Identity degrade: unresolvable triple queues for claimer with live client.
        } catch (err) {
          // Why: transient direct faults queue instead of dropping. Misses
          // (404, 401) and oversize (413) keep throwing under the exact-only
          // contract; only 429, 5xx, and network failures fall through.
          if (!isTransientDirectError(err)) throw err;
        }
      }
      const id = await sendClaim(peerId, from, msgText, fanoutId, { silent, noReply });
      return { id, via: "queued" };
    };

    if (broadcast) {
      // Why: registry-scoped fan-out — DB-only rows carry no model key, so
      // union-scoped delivery would fall back on every such id.
      const peerIds = Object.keys(reg).filter((id) => id !== caller && registryIds.has(id));
      if (peerIds.length === 0) return { output: JSON.stringify({ broadcast: true, peers: 0, ok: 0, via: "admitted" }) };
      const { newMessageId: newFanoutId } = await import("../outbox.js");
      const sharedFanoutId = newFanoutId();
      const sharedRoute = await resolveRoute(auth);
      const results: Array<{ peerId: string; ok: boolean; via?: string; id?: string; error?: string; code?: string; status?: number; didYouMean?: string[] }> = [];
      for (const pid of peerIds) {
        try {
          const r = await sendIdentical(pid, caller, text, auth, directoryFromCtx, sharedRoute, sharedFanoutId);
          results.push({ peerId: pid, ok: true, via: r.via, id: r.id });
        } catch (e) {
          const code = (e as { code?: string })?.code ?? (e instanceof MeshError ? e.code : undefined);
          const status = (e as { status?: number })?.status ?? (e instanceof MeshError ? e.status : undefined);
          const didYouMean = (e as { didYouMean?: string[] })?.didYouMean;
          results.push({ peerId: pid, ok: false, error: String((e as Error).message ?? e), code, status, didYouMean });
          // Why: no mid-fanout abort. Every peer reports, even when the
          // failure is identical across peers; the tail is data, not noise.
        }
      }
      const okCount = results.filter((r) => r.ok).length;
      const vias = new Set(results.filter((r) => r.ok).map((r) => r.via));
      const via = vias.size === 1 ? [...vias][0] : "mixed";
      const failed = results.filter((r) => !r.ok).map((r) => ({ peerId: r.peerId, code: r.code, error: r.error, didYouMean: r.didYouMean }));
      return {
        output: JSON.stringify(
          { broadcast: true, peers: peerIds.length, ok: okCount, failed, via, results },
          null,
          2
        ),
      };
    } else {
      const resolved = resolveTarget();
      if (!resolved) {
        if (Object.keys(reg).length > 0) {
          const peers = buildDidYouMean(reg);
          throw new MeshError("PEER_NOT_FOUND", `peer not found: ${target}`, { didYouMean: peers });
        } else throw new MeshError("PEER_NOT_FOUND", `peer not found: ${target}`, { didYouMean: [] });
      }
      const r = await sendIdentical(resolved, caller, text, auth, directoryFromCtx, await resolveRoute(auth));
      // Why: honest vocabulary — admitted (204) vs queued (row exists); sent:true-on-204 is forbidden, verify via receipt-by-id.
      const entry = (reg as Record<string, { title?: string; description?: string; summary?: string }>)[resolved];
      const title = entry?.title ?? entry?.description ?? entry?.summary ?? resolved.slice(0, 8);
      return { output: JSON.stringify({ ok: true, via: r.via, target: resolved, title, id: r.id }) };
    }
  },
});
