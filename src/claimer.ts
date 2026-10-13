// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Single owner for the per-process outbox claimer poll.
import {
  CLAIMER_BUSY_BASE_MS,
  CLAIMER_BUSY_JITTER_MS,
  OPENCODE_PORT,
  OUTBOX_CLAIM_TIMEOUT_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_POLL_MS,
  POST_TIMEOUT_MS,
  ROUTE_PROBE_TIMEOUT_MS,
} from "./constants.js";
import { formatMeshPrefix, quarantineText } from "./frontmatter.js";
import { resolveReceiverWireDetailed, type MissStep, type ReceiverWireState } from "./identity.js";
import { getServerAuthHeaderSync } from "./serverAuth.js";
import { isSilent, resolveNoReply } from "./wake.js";
import { appendDeliveryAudit, unwrapStatusMap } from "./registry.js";
import type { OutboxFailReason } from "./outbox.js";
import {
  locateSession,
  postV2Prompt,
  v2RowToTriple,
} from "./v2routes.js";

export interface PromptClient {
  session?: {
    status?: (o?: unknown) => Promise<unknown>;
    promptAsync?: (o: unknown) => Promise<unknown>;
    get?: (o: unknown) => Promise<unknown>;
  };
}

/**
 * v2 in-process inject client (wired by the v2 adapter from its setup
 * context). User admission renders the chat bubble like v1; the claimer
 * only gates on target existence.
 */
export interface V2InjectClient {
  prompt: (input: {
    sessionID: string;
    text: string;
    delivery: "steer" | "queue";
  }) => Promise<unknown>;
}

export interface ClaimerDeps {
  getOwnIds: () => string[];
  getClient: () => PromptClient | null;
  getRegistry: () => Promise<Record<string, { agent?: string; directory?: string; cwd?: string; model?: string }>>;
  /** v2 setups provide this; v1 setups leave it absent (clientless path). */
  getV2Client?: () => V2InjectClient | null;
}

let deps: ClaimerDeps | null = null;
let claimerTimer: ReturnType<typeof setInterval> | null = null;
const claimerOwners = new Set<string>();

/** Plugin init wires its session set plus live client plus registry read here. */
export function configureClaimer(d: ClaimerDeps): void {
  deps = d;
}

function claimerOwnerId(ownIds: string[]): string {
  const first = ownIds[0] ?? "none";
  return `${first}#${process.pid}`;
}

/**
 * Client-shape code for observability only; all non-ok shapes share one path.
 */
export type ClientShape = "ok" | "null-client" | "no-session" | "no-promptAsync";

function describeClientShape(c: PromptClient | null): ClientShape {
  if (c === null || c === undefined) return "null-client";
  if (c.session === null || c.session === undefined) return "no-session";
  if (typeof c.session.promptAsync !== "function") return "no-promptAsync";
  return "ok";
}

// Per-process claimer: polls owned rows, injects via own client; unconfigured reads no-op.
// Poll cadence plus attempt bound sit far short of TTL via deleteExpiredWithAudit.
/**
 * Single poll: claim due rows and inject each via promptAsync.
 * One bad row never stalls the queue.
 */
export async function pollClaimer(): Promise<void> {
  try {
    const d = deps;
    if (!d) return;
    const ownIds = d.getOwnIds();
    if (ownIds.length === 0) return;
    const ownerId = claimerOwnerId(ownIds);
    claimerOwners.add(ownerId);
    const outbox = await import("./outbox.js");
    try {
      await outbox.requeueStale(OUTBOX_CLAIM_TIMEOUT_MS);
    // Why: best-effort — stale requeue failure must not crash the claim loop.
    } catch {}
    let rows: Array<{
      id: string;
      target_session: string;
      from_session: string;
      from_agent: string;
      text: string;
      attempts: number;
      silent?: number;
    }> = [];
    try {
      rows = (await outbox.claim(ownIds, ownerId, 1)) as typeof rows;
    } catch {
      return;
    }
    if (rows.length === 0) return;
    const c = d.getClient();
    const canInject = typeof c?.session?.promptAsync === "function";
    const clientShape = describeClientShape(c);
    const reg = (await d.getRegistry().catch(() => ({}))) as Record<string, { agent?: string; directory?: string; cwd?: string; model?: string }>;
    for (const row of rows) {
      const v2 = d.getV2Client?.() ?? null;
      if (!canInject && v2) {
        await pollV2Row(row, { reg, ownerId, outbox, v2 });
        continue;
      }
      if (!canInject) {
        await pollClientlessRow(row, { c, reg, ownerId, clientShape, outbox });
        continue;
      }
      const entry = reg[row.target_session];
      const directory = entry?.directory ?? entry?.cwd ?? process.cwd();
      // Claim-time re-validation: live registry re-attests sender; unknown renders unverified.
      const senderEntry = reg[row.from_session] as { agent?: string } | undefined;
      const liveAgent =
        senderEntry && typeof senderEntry.agent === "string" && senderEntry.agent !== "unknown" && senderEntry.agent.length > 0
          ? senderEntry.agent
          : null;
      const prefixAgent = liveAgent ?? row.from_agent;
      const verified = liveAgent !== null;
      const silentBit = isSilent({ silent: (row.silent ?? 0) === 1 });
      const prefixed = `${formatMeshPrefix(prefixAgent, row.from_session, verified, silentBit)}\n\n${quarantineText(row.text)}`;
      // Receiver triple uses receiver agent plus model; unresolvable defers, never guesses.
      let receiver: ReceiverWireState | null = null;
      let missTrail: MissStep[] = [];
      let dbEvidence: Record<string, unknown> = {};
      try {
        const detailed = await resolveReceiverWireDetailed(c, row.target_session, reg[row.target_session]);
        receiver = detailed.receiver;
        missTrail = detailed.trail;
        dbEvidence = (detailed.dbEvidence ?? {}) as Record<string, unknown>;
      } catch {
        receiver = null;
        missTrail = [];
        dbEvidence = {};
      }
      if (!receiver) {
        await terminalizeOrRelease(row, ownerId, "receiver-unresolvable", "receiver-unresolvable", outbox, {
          receiverSource: null,
          missTrail,
          ...dbEvidence,
        });
        continue;
      }
      try {
        try {
          const statusRaw = await c.session?.status?.();
          const statusMap = unwrapStatusMap(statusRaw);
          const t = statusMap?.[row.target_session]?.type;
          // Why: queue-policy wait lives in constants so the 550-650ms band is tunable without touching the inject path.
          if (t === "busy" || t === "retry") await new Promise((r) => setTimeout(r, CLAIMER_BUSY_BASE_MS + Math.random() * CLAIMER_BUSY_JITTER_MS));
        // Why: best-effort — busy/retry status check failure must not block the inject path.
        } catch {}
        await c.session?.promptAsync?.({
          path: { id: row.target_session },
          query: { directory },
          body: {
            agent: receiver.agent,
            parts: [{ type: "text", text: prefixed }],
            // Envelope carries row.id on the wire; omit persists empty-part rows.
            // Correlation stays row.id via ack/release.
            messageID: row.id,
            model: receiver.model,
            ...(receiver.variant !== undefined ? { variant: receiver.variant } : {}),
            ...resolveNoReply({ silent: (row.silent ?? 0) === 1 }),
          },
        });
        try {
          await outbox.ack(row.id, ownerId);
        // Why: best-effort — ack failure must not block the current claim cycle.
        } catch {}
        await appendDeliveryAudit(
          "outbox.injected",
          { id: row.id, target_session: row.target_session, owner: ownerId, attempts: row.attempts, maxAttempts: OUTBOX_MAX_ATTEMPTS, via: "client", receiverSource: receiver.source },
        ).catch(() => {});
      } catch {
        await terminalizeOrRelease(row, ownerId, "max-attempts", "inject-failed", outbox, { missTrail });
      }
    }
  // Why: best-effort — any claim loop failure must not crash the process.
  } catch {}
}

interface ClientlessCtx {
  c: PromptClient | null;
  reg: Record<string, { agent?: string; directory?: string; cwd?: string; model?: string }>;
  ownerId: string;
  clientShape: ClientShape;
  outbox: typeof import("./outbox.js");
}

interface V2RowCtx {
  reg: Record<string, { agent?: string; directory?: string; cwd?: string; model?: string }>;
  ownerId: string;
  outbox: typeof import("./outbox.js");
  v2: V2InjectClient;
}

/**
 * v2-client row: injects via in-process user admission (no ports, no
 * auth, no receiver triple; the envelope attribution rides the text prefix
 * as on every leg). Unknown targets terminalize; inject faults defer to the
 * bound like every other transient. Never throws.
 */
async function pollV2Row(
  row: { id: string; target_session: string; from_session: string; from_agent: string; text: string; attempts: number; silent?: number },
  ctx: V2RowCtx,
): Promise<void> {
  const { reg, ownerId, outbox, v2 } = ctx;
  const entry = reg[row.target_session] as { agent?: string } | undefined;
  let known = entry !== undefined;
  let source: "registry" | "db" = "registry";
  if (!known) {
    const { readDbTriple } = await import("./discovery.js");
    const triple = await readDbTriple(row.target_session);
    known = triple !== null;
    if (known) source = "db";
  }
  if (!known) {
    await terminalizeOrRelease(row, ownerId, "receiver-unresolvable", "receiver-unresolvable", outbox, {
      receiverSource: null,
      missTrail: [
        { layer: "db", reason: "db-row-absent" },
        { layer: "registry", reason: "registry-absent" },
      ] as MissStep[],
    });
    return;
  }
  const senderEntry = reg[row.from_session] as { agent?: string } | undefined;
  const liveAgent =
    senderEntry && typeof senderEntry.agent === "string" && senderEntry.agent !== "unknown" && senderEntry.agent.length > 0
      ? senderEntry.agent
      : null;
  const prefixAgent = liveAgent ?? row.from_agent;
  const verified = liveAgent !== null;
  const silentBit = isSilent({ silent: (row.silent ?? 0) === 1 });
  const prefixed = `${formatMeshPrefix(prefixAgent, row.from_session, verified, silentBit)}\n\n${quarantineText(row.text)}`;
  try {
    await v2.prompt({
      sessionID: row.target_session,
      text: prefixed,
      delivery: silentBit ? "queue" : "steer",
    });
  } catch {
    await terminalizeOrRelease(row, ownerId, "clientless-no-route", "v2-client", outbox, {
      route: "v2-client",
      receiverSource: source,
    });
    return;
  }
  try {
    await outbox.ack(row.id, ownerId);
  // Why: best-effort — ack failure must not block the current claim cycle.
  } catch {}
  await appendDeliveryAudit(
    "outbox.injected",
    {
      id: row.id,
      target_session: row.target_session,
      owner: ownerId,
      attempts: row.attempts,
      maxAttempts: OUTBOX_MAX_ATTEMPTS,
      via: "v2-client",
      receiverSource: source,
      route: "v2-client",
    },
  ).catch(() => {});
}

/**
 * Cannot-inject branch for all clientless shapes; no route releases or terminalizes.
 */
async function pollClientlessRow(
  row: { id: string; target_session: string; from_session: string; from_agent: string; text: string; attempts: number; silent?: number },
  ctx: ClientlessCtx
): Promise<void> {
  const { reg, ownerId, clientShape, outbox } = ctx;
  let route: "direct" | "claim" = "claim";
  let probeStatus: number | undefined;
  try {
    const auth = getServerAuthHeaderSync();
    const headers: Record<string, string> = {};
    if (auth) headers.Authorization = auth;
    const res = await fetch(`http://127.0.0.1:${OPENCODE_PORT}/session/status`, {
      headers,
      signal: AbortSignal.timeout(ROUTE_PROBE_TIMEOUT_MS),
    });
    probeStatus = res.status;
    if (res.ok) route = "direct";
  } catch {
    route = "claim";
  }
  if (route === "direct") {
    const delivered = await tryDirectFallback(row, ctx, { route, probeStatus });
    if (delivered) return;
  }
  // v2 leg: a v2-hosted target admits here even with no live client anywhere.
  try {
    if (await tryV2ClaimFallback(row, ctx)) return;
  } catch {
    // Fallthrough shares the deferred release below; a v2 fault never drops.
  }
  // Clientless trail covers DB plus registry only; audit names skipped layers.
  let noRouteTrail: MissStep[] = [];
  let noRouteDbEvidence: Record<string, unknown> = {};
  try {
    const detailed = await resolveReceiverWireDetailed(null, row.target_session, reg[row.target_session]);
    noRouteTrail = detailed.trail;
    noRouteDbEvidence = (detailed.dbEvidence ?? {}) as Record<string, unknown>;
  // Why: best-effort — receiver resolution failure must not block clientless delivery.
  } catch {}
  await terminalizeOrRelease(row, ownerId, "clientless-no-route", "clientless", outbox, {
    clientShape,
    route,
    ...(probeStatus !== undefined ? { status: probeStatus } : {}),
    missTrail: noRouteTrail,
    ...noRouteDbEvidence,
  });
}

/**
 * Clientless direct-POST fallback; true when settled, false falls to release.
 * Typed outcomes mirror the direct leg; never throws.
 */
async function tryDirectFallback(
  row: { id: string; target_session: string; from_session: string; from_agent: string; text: string; attempts: number; silent?: number },
  ctx: ClientlessCtx,
  routeInfo: { route: "direct" | "claim"; probeStatus?: number }
): Promise<boolean> {
  const { c, reg, ownerId, clientShape, outbox } = ctx;
  try {
    const entry = reg[row.target_session];
    const directory = entry?.directory ?? entry?.cwd ?? process.cwd();
    const senderEntry = reg[row.from_session] as { agent?: string } | undefined;
    const liveAgent =
      senderEntry && typeof senderEntry.agent === "string" && senderEntry.agent !== "unknown" && senderEntry.agent.length > 0
        ? senderEntry.agent
        : null;
    const prefixAgent = liveAgent ?? row.from_agent;
    const verified = liveAgent !== null;
    const silentBit = isSilent({ silent: (row.silent ?? 0) === 1 });
    const prefixed = `${formatMeshPrefix(prefixAgent, row.from_session, verified, silentBit)}\n\n${quarantineText(row.text)}`;
    let receiver: ReceiverWireState | null = null;
    let missTrail: MissStep[] = [];
    let dbEvidence: Record<string, unknown> = {};
    try {
      const detailed = await resolveReceiverWireDetailed(c, row.target_session, reg[row.target_session]);
      receiver = detailed.receiver;
      missTrail = detailed.trail;
      dbEvidence = (detailed.dbEvidence ?? {}) as Record<string, unknown>;
    } catch {
      receiver = null;
      missTrail = [];
      dbEvidence = {};
    }
    if (!receiver) {
      await terminalizeOrRelease(row, ownerId, "receiver-unresolvable", "receiver-unresolvable", outbox, {
        receiverSource: null,
        missTrail,
        ...dbEvidence,
      });
      return true;
    }
    const auth = getServerAuthHeaderSync();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth) headers.Authorization = auth;
    if (directory) headers["x-opencode-directory"] = encodeURIComponent(directory);
    const url = `http://127.0.0.1:${OPENCODE_PORT}/session/${row.target_session}/prompt_async?directory=${encodeURIComponent(directory)}`;
    const body = JSON.stringify({
      agent: receiver.agent,
      parts: [{ type: "text", text: prefixed }],
      messageID: row.id,
      model: receiver.model,
      ...(receiver.variant !== undefined ? { variant: receiver.variant } : {}),
      ...resolveNoReply({ silent: (row.silent ?? 0) === 1 }),
    });
    try {
      const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
      if (res.status === 204) {
        try {
          await outbox.ack(row.id, ownerId);
        // Why: best-effort — ack failure must not block direct fallback.
        } catch {}
        await appendDeliveryAudit(
          "outbox.injected",
          {
            id: row.id,
            target_session: row.target_session,
            owner: ownerId,
            attempts: row.attempts,
            maxAttempts: OUTBOX_MAX_ATTEMPTS,
            via: "direct-fallback",
            receiverSource: receiver.source,
            route: routeInfo.route,
            ...(routeInfo.probeStatus !== undefined ? { status: routeInfo.probeStatus } : {}),
            clientShape,
          },
        ).catch(() => {});
        return true;
      }
      if (res.status === 404 || res.status === 401) {
        const reason = `direct-terminal-${res.status}` as OutboxFailReason;
        // Direct trail reuses direct-fetch-miss; status rides on reason plus audit status.
        const directTrail: MissStep[] = [{ layer: "direct", reason: "direct-fetch-miss" }];
        try {
          const ok = await outbox.failRow(row.id, ownerId, reason, {
            layer: "direct",
            missReason: "direct-fetch-miss",
          });
          if (!ok) return true;
          await appendDeliveryAudit("outbox.claim-terminal", {
            id: row.id,
            target_session: row.target_session,
            owner: ownerId,
            attempts: OUTBOX_MAX_ATTEMPTS,
            maxAttempts: OUTBOX_MAX_ATTEMPTS,
            reason,
            status: res.status,
            missTrail: directTrail,
          }).catch(() => {});
        // Why: best-effort — failRow or audit failure must not block terminalization.
        } catch {}
        return true;
      }
      return false;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * v2 prompt fallback for clientless processes (v2 setups own no live
 * client by design). Mirrors the direct-fallback outcomes: admitted rows ack
 * with a v2-prompt audit, terminal misses fail loud, anything else falls
 * through to the deferred release. Never throws.
 */
async function tryV2ClaimFallback(
  row: { id: string; target_session: string; from_session: string; from_agent: string; text: string; attempts: number; silent?: number },
  ctx: ClientlessCtx,
): Promise<boolean> {
  const { reg, ownerId, clientShape, outbox } = ctx;
  try {
    const located = await locateSession(row.target_session);
    if (!located || located.kind !== "v2") return false;
    const triple = v2RowToTriple(located.row);
    const stored = reg[row.target_session] ?? {};
    const merged = { ...stored, ...(triple ?? {}) };
    // Unresolvable here defers through the shared release below: the v1
    // leg ahead already settles every case it can see, so anything left
    // unaddressable simply waits for redelivery like any other deferral.
    const receiver = (
      await resolveReceiverWireDetailed(null, row.target_session, merged, {
        directRow: located.row,
      }).catch(() => null)
    )?.receiver;
    if (!receiver) return false;
    const senderEntry = reg[row.from_session] as { agent?: string } | undefined;
    const liveAgent =
      senderEntry && typeof senderEntry.agent === "string" && senderEntry.agent !== "unknown" && senderEntry.agent.length > 0
        ? senderEntry.agent
        : null;
    const prefixAgent = liveAgent ?? row.from_agent;
    const verified = liveAgent !== null;
    const silentBit = isSilent({ silent: (row.silent ?? 0) === 1 });
    const prefixed = `${formatMeshPrefix(prefixAgent, row.from_session, verified, silentBit)}\n\n${quarantineText(row.text)}`;
    const posted = await postV2Prompt(
      located.port,
      row.target_session,
      prefixed,
      { silent: (row.silent ?? 0) === 1 },
    );
    if (posted.ok) {
      try {
        await outbox.ack(row.id, ownerId);
      // Why: best-effort — ack failure must not block direct fallback.
      } catch {}
      await appendDeliveryAudit(
        "outbox.injected",
        {
          id: row.id,
          target_session: row.target_session,
          owner: ownerId,
          attempts: row.attempts,
          maxAttempts: OUTBOX_MAX_ATTEMPTS,
          via: "v2-prompt",
          receiverSource: receiver.source,
          route: "claim",
          clientShape,
        },
      ).catch(() => {});
      return true;
    }
    if (posted.status === 404 || posted.status === 401) {
      const reason = `direct-terminal-${posted.status}` as OutboxFailReason;
      const directTrail: MissStep[] = [{ layer: "direct", reason: "direct-fetch-miss" }];
      try {
        const ok = await outbox.failRow(row.id, ownerId, reason, {
          layer: "direct",
          missReason: "direct-fetch-miss",
        });
        if (!ok) return true;
        await appendDeliveryAudit("outbox.claim-terminal", {
          id: row.id,
          target_session: row.target_session,
          owner: ownerId,
          attempts: OUTBOX_MAX_ATTEMPTS,
          maxAttempts: OUTBOX_MAX_ATTEMPTS,
          reason,
          status: posted.status,
          missTrail: directTrail,
        }).catch(() => {});
      // Why: best-effort — failRow or audit failure must not block terminalization.
      } catch {}
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Bounded release shared by four call sites; at bound terminalizes via failRow.
 */
async function terminalizeOrRelease(
  row: { id: string; target_session: string; attempts: number },
  ownerId: string,
  terminalReason: OutboxFailReason,
  deferReason: string,
  outbox: typeof import("./outbox.js"),
  extra: Record<string, unknown>
): Promise<void> {
  if (row.attempts + 1 >= OUTBOX_MAX_ATTEMPTS) {
    try {
      // Terminal pair: the last trail step owns the miss columns. Trails
      // stay evidence-only: an absent or shapeless trail terminalizes
      // exactly as before with the miss columns left NULL.
      const trail = Array.isArray(extra.missTrail) ? (extra.missTrail as MissStep[]) : [];
      const last = trail.length > 0 ? trail[trail.length - 1] : undefined;
      const detail =
        last !== undefined && typeof last.layer === "string" && typeof last.reason === "string"
          ? { layer: last.layer as MissStep["layer"], missReason: last.reason as MissStep["reason"] }
          : undefined;
      const ok = await outbox.failRow(row.id, ownerId, terminalReason, detail);
      if (!ok) return;
      await appendDeliveryAudit("outbox.claim-terminal", {
        id: row.id,
        target_session: row.target_session,
        owner: ownerId,
        attempts: OUTBOX_MAX_ATTEMPTS,
        maxAttempts: OUTBOX_MAX_ATTEMPTS,
        reason: terminalReason,
        ...extra,
      }).catch(() => {});
    // Why: best-effort — terminalization failure must not block the release path.
    } catch {}
    return;
  }
  try {
    const ok = await outbox.release(row.id, ownerId);
    if (!ok) return;
    await appendDeliveryAudit("outbox.claim-deferred", {
      id: row.id,
      target_session: row.target_session,
      owner: ownerId,
      attempts: row.attempts + 1,
      maxAttempts: OUTBOX_MAX_ATTEMPTS,
      reason: deferReason,
      ...extra,
    }).catch(() => {});
  // Why: best-effort — release failure must not block the terminalize path.
  } catch {}
}

/**
 * Start per-process poll timer; one unref interval, cadence OUTBOX_POLL_MS.
 */
export function ensureClaimer(): void {
  if (claimerTimer) return;
  claimerTimer = setInterval(() => {
    void pollClaimer();
  }, OUTBOX_POLL_MS);
  if (claimerTimer && typeof (claimerTimer as unknown as { unref: () => void }).unref === "function")
    (claimerTimer as unknown as { unref: () => void }).unref();
}

/** Dispose path: clear the poll timer only. */
export function clearClaimerTimer(): void {
  if (claimerTimer) {
    clearInterval(claimerTimer);
    claimerTimer = null;
  }
}

/** Dispose path: release every unacked claim held by this process owners only. */
export async function releaseClaimerOwner(): Promise<void> {
  try {
    const outbox = await import("./outbox.js");
    for (const owner of claimerOwners) {
      try {
        await outbox.releaseOwner(owner);
      // Why: best-effort — owner release failure must not block cleanup.
      } catch {}
    }
    claimerOwners.clear();
  // Why: best-effort — claimer owner cleanup failure must not crash the dispose path.
  } catch {}
}
