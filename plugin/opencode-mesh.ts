// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// OpenCode plugin wiring mesh tools with auto-register.
import type { Plugin } from "@opencode-ai/plugin";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EVICT_GRACE_MS, HEARTBEAT_INTERVAL_MS, STALE_TTL_MS } from "../src/constants.js";
import { isLockContention } from "../src/fsAtomic.js";
import { atomicUpdateRegistry, appendBootAudit, readRegistry, unwrapStatusMap } from "../src/registry.js";
import { pruneDeadByStatus, type Registry } from "../src/registry.js";
import { BUILD_STAMP, VERSION } from "../src/version.js";
import { isAttachedExempt } from "../src/expiry.js";
import { noteBusyActive, stampLastAction } from "../src/lastAction.js";
import { resolveValidDir } from "../src/xdg.js";
import { startAttachPoller, stopAttachPoller } from "../src/attach.js";
import { mesh_register } from "../src/tools/mesh_register.js";
import { tool } from "@opencode-ai/plugin";
import { isGenericTitle, resolveIdentity } from "../src/identity.js";
import { clearClaimerTimer, configureClaimer, ensureClaimer, releaseClaimerOwner, type PromptClient } from "../src/claimer.js";

const mesh_broadcast = tool({
  description: "Broadcast to all peers (opt-in MESH_BROADCAST=1, default-off; alias for mesh_send broadcast:true)",
  args: {
    text: tool.schema.string().describe("Message text to broadcast"),
    noReply: tool.schema.boolean().optional().describe("Legacy compat; maps to silent deposit, reply by reverse send"),
    silent: tool.schema.boolean().optional().describe("Canonical per-message silent flag; true deposits history-only, omit follows MESH_WAKE"),
  },
  async execute(args, ctx) {
    const { mesh_send } = await import("../src/tools/mesh_send.js");
    return mesh_send.execute({ target: "all", text: args.text, broadcast: true, noReply: args.noReply, silent: args.silent }, ctx);
  },
});

const seenSessions = new Map<string, { agentAt: number; titleAt: number }>();
// In-process client for the heartbeat liveness join. Set at plugin init; the
// tick reads it (never a port fetch) so the join costs no port discovery.
let liveClient: unknown = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
function ensureHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(async () => {
    const now = Date.now();
    let statusMap: Record<string, { type: string }> | null = null;
    try {
      const c = liveClient as unknown as { session?: { status?: (o?: unknown) => Promise<unknown> } };
      if (c.session?.status) {
        const raw = (await c.session.status()) as unknown;
        statusMap = unwrapStatusMap(raw);
      }
    } catch {}
    if (statusMap && Object.keys(statusMap).length === 0) statusMap = null; // empty view is unknown, never a delete signal
    for (const [sid, last] of seenSessions.entries()) {
      const lag = now - Math.max(last.agentAt, last.titleAt);
      if (lag > STALE_TTL_MS) {
        seenSessions.delete(sid);
        continue;
      }
      // Busy liveness input: a Runner turn counts as activity regardless of
      // timestamp. The stamp sits beside the heartbeat so tracker failure
      // never breaks the tick.
      try {
        const t = statusMap?.[sid]?.type;
        if (t === "busy" || t === "retry") await noteBusyActive(sid, t);
      } catch {}
      // Liveness join: null map keeps and heartbeats; absent ids delete via shared helper.
      if (statusMap && !(sid in statusMap)) {
        let evicted = false;
        try {
          await atomicUpdateRegistry((reg) => {
            const entry = (reg as Record<string, unknown>)[sid];
            if (!entry) return;
            // Attached-exempt: an attached id never deletes by time alone.
            if (isAttachedExempt(entry)) return;
            const scoped = { [sid]: entry } as unknown as Registry;
            pruneDeadByStatus(scoped, statusMap, now);
            if (!(sid in scoped)) {
              delete (reg as Record<string, unknown>)[sid];
              evicted = true;
            }
          });
        } catch {}
        try {
          const { appendDeleteAudit } = await import("../src/registry.js");
          if (evicted) await appendDeleteAudit("tick-evict", [sid]);
        } catch {}
        seenSessions.set(sid, { agentAt: now, titleAt: now });
        continue;
      }
      // Recreate: own sid live but missing re-inserts inside writer; never read-then-write.
      if (statusMap && sid in statusMap) {
        try {
          await atomicUpdateRegistry((reg) => {
            if ((reg as Record<string, unknown>)[sid]) return;
            (reg as Record<string, unknown>)[sid] = { sessionId: sid, agent: "unknown", updatedAt: now };
          });
        } catch {}
      }
      try {
        const { heartbeat } = await import("../src/registry.js");
        await heartbeat(sid);
        const cur = seenSessions.get(sid);
        if (cur) seenSessions.set(sid, { agentAt: now, titleAt: now });
      } catch {}
    }
  }, HEARTBEAT_INTERVAL_MS);
  if (heartbeatTimer && typeof (heartbeatTimer as unknown as { unref: () => void }).unref === "function")
    (heartbeatTimer as unknown as { unref: () => void }).unref();
}
/** Test/harness teardown: stop the heartbeat tick so stale module instances never fire into a later root. */
function clearHeartbeatTimer(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// Skills root for config-hook auto-load; both layouts probed, first hit wins.
// Fail-closed fallback pushes a path the host scans to nothing.
function resolveSkillsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "..", "skills"), resolve(here, "..", "..", "skills")];
  for (const c of candidates) {
    try {
      if (existsSync(resolve(c, "opencode-mesh", "SKILL.md"))) return c;
    } catch {}
  }
  return candidates[1];
}

async function upsertPresence(
  sessionId: string,
  directory: string | undefined,
  agent: string,
  title: string | null,
  model?: string
): Promise<void> {
  const dirFence = resolveValidDir(directory);
  const absDir = dirFence.kind === "valid" ? dirFence.dir : undefined;
  // Why: fence (event paths never throw): a stale directory downgrades to absent,
  // never stored. The tool boundary (mesh_register) refuses loud instead.
  const validDir = absDir && existsSync(absDir) ? absDir : undefined;
  const base = validDir ? basename(validDir) : "";
  const fallback = base ? `${agent ?? 'unknown'} @ ${base}` : sessionId.slice(0, 8);
  const isGeneric = isGenericTitle(title ?? undefined);
  // Fail-closed: lock contention drops the presence refresh and the next
  // firing retries; all other errors keep current propagation.
  try {
    await atomicUpdateRegistry(async (reg) => {
      const existing = (reg as Record<string, unknown>)[sessionId] as Record<string, unknown> | undefined;
      let finalAgent: string;
      if (agent && agent !== "unknown") finalAgent = agent;
      else if (existing && typeof (existing as { agent?: string }).agent === "string" && (existing as { agent?: string }).agent !== "unknown")
        finalAgent = (existing as { agent?: string }).agent as string;
      else finalAgent = agent ?? "unknown";
      const existingDir = (existing as { directory?: string; cwd?: string } | undefined)?.directory ?? (existing as { cwd?: string } | undefined)?.cwd;
      const finalDir = validDir ?? (typeof existingDir === "string" && existingDir.length > 0 && existingDir.startsWith("/") ? existingDir : undefined);
      const finalCwd = finalDir;
      const finalRepo = finalDir ? basename(finalDir) : (existing as { repo?: string } | undefined)?.repo;
      // Parameter wins, else stored inherits; absent stays absent.
      // Fallback stays wire-time concern only.
      const existingModel = (existing as { model?: string } | undefined)?.model;
      const finalModel =
        typeof model === "string" && model.length > 0
          ? model
          : typeof existingModel === "string" && existingModel.length > 0
            ? existingModel
            : undefined;
      const next: Record<string, unknown> = {
        sessionId,
        agent: finalAgent,
        directory: finalDir,
        cwd: finalCwd,
        repo: finalRepo,
        description: isGeneric ? ((existing as { description?: string })?.description ?? (existing as { summary?: string })?.summary ?? fallback) : title!,
        summary: isGeneric ? ((existing as { summary?: string })?.summary ?? (existing as { description?: string })?.description ?? fallback) : title!,
        title: isGeneric ? ((existing as { title?: string })?.title ?? title ?? fallback) : title!,
        updatedAt: Date.now(),
        ...(finalModel !== undefined ? { model: finalModel } : {}),
      };
      // never persist '' directory — omit if undefined
      if (!finalDir) {
        delete (next as Record<string, unknown>).directory;
        delete (next as Record<string, unknown>).cwd;
      }
      if (finalRepo === undefined) delete (next as Record<string, unknown>).repo;
      if (
        existing &&
        (existing as { description?: string }).description &&
        !isGenericTitle((existing as { description?: string }).description) &&
        isGenericTitle(next.description as string)
      ) {
        (reg as Record<string, unknown>)[sessionId] = { ...existing, updatedAt: Date.now() };
        return;
      }
      (reg as Record<string, unknown>)[sessionId] = next;
    });
  } catch (err) {
    if (!isLockContention(err)) throw err;
  }
}
async function autoRegister(sessionId: string, directory: string | undefined, ctx?: { agent?: string; directory?: string }, client?: unknown): Promise<void> {
  const now = Date.now();
  const last = seenSessions.get(sessionId);
  // Why: debounce window is EVICT_GRACE_MS by definition (constants own the value).
  if (last && now - last.agentAt < EVICT_GRACE_MS && now - last.titleAt < EVICT_GRACE_MS) {
    ensureHeartbeat();
    ensureClaimer();
    return;
  }
  // Per-field freshness: stale fields proceed to enrichment with current values.
  seenSessions.set(sessionId, { agentAt: now, titleAt: now });
  ensureHeartbeat();
  ensureClaimer();
  try {
    const reg = (await readRegistry().catch(() => ({} as Record<string, unknown>))) as Record<string, unknown>;
    if (reg[sessionId]) {
      const { heartbeat } = await import("../src/registry.js");
      await heartbeat(sessionId);
      return;
    }
    const ident = client
      ? await resolveIdentity(client, sessionId, { directory }, ctx)
      : { agent: ctx?.agent ?? "unknown", title: null, directory };
    await upsertPresence(
      sessionId,
      ident.directory ?? directory,
      ident.agent,
      ident.title,
      "model" in ident ? ident.model : undefined
    );
  } catch {}
}

// pure: delivery is POST prompt_async, no file poll

async function deletePresence(sessionId: string): Promise<void> {
  // Fail-closed: contention still runs in-memory delete; disk waits for next writer.
  try {
    await atomicUpdateRegistry((reg) => {
      delete (reg as Record<string, unknown>)[sessionId];
    });
  } catch (err) {
    if (!isLockContention(err)) throw err;
  }
  seenSessions.delete(sessionId);
}

// @ts-ignore — Plugin Hooks narrow ToolResult vs Promise<unknown> widen; typed Plugin preserved, no as unknown cast
const plugin: Plugin = async (input) => {
  const client = input.client;
  liveClient = client;
  try {
    const { setLiveClient } = await import("../src/discovery.js");
    setLiveClient(client);
  } catch {}
  // Init record: one audit-file line per init via appendBootAudit carrying the live
  // stamp; screen output stays unchanged (the tests/mesh-delivery.test.ts console census locks zero new screen lines).
  try {
    await appendBootAudit(BUILD_STAMP, VERSION).catch(() => {});
  } catch {}
  ensureHeartbeat();
  configureClaimer({
    getOwnIds: () => [...seenSessions.keys()],
    getClient: () => (liveClient as unknown as PromptClient | null) ?? null,
    getRegistry: async () => (await readRegistry().catch(() => ({}))) as Record<string, { agent?: string; directory?: string; cwd?: string; model?: string }>,
  });
  ensureClaimer();
  startAttachPoller();
  // Lazy tool imports at first use: mesh_send/mesh_peers reach node:sqlite
  // transitively, so no static edge may resolve at plugin load.
  const { mesh_peers } = await import("../src/tools/mesh_peers.js");
  const { mesh_send } = await import("../src/tools/mesh_send.js");
  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created": {
          const info = (event as { properties: { info: { id: string; directory?: string; title?: string; agent?: string } } }).properties.info;
          const id = info.id;
          if (!id) return;
          const now = Date.now();
          const last = seenSessions.get(id);
          if (last && now - last.agentAt < EVICT_GRACE_MS && now - last.titleAt < EVICT_GRACE_MS) return;
          seenSessions.set(id, { agentAt: now, titleAt: now });
          const ident = await resolveIdentity(client, id, { agent: info.agent, directory: info.directory, title: info.title });
          await upsertPresence(
            id,
            ident.directory ?? info.directory,
            ident.agent,
            ident.title,
            ident.model
          );
          // Last-action stamp after the debounce guard: repeat firings inside
          // the window cost zero writes; stamp failure drops, never throws.
          try {
            await stampLastAction(id);
          } catch {}
          ensureHeartbeat();
          ensureClaimer();
          break;
        }
        case "session.updated": {
          const info = (event as { properties: { info: { id: string; title?: string; agent?: string; directory?: string } } }).properties.info;
          const id = info.id;
          if (!id) return;
          const ident = await resolveIdentity(client, id, { agent: info.agent, directory: info.directory, title: info.title });
          const resolved = ident.title;
          // Fail-closed: contention skips enrichment; in-memory updates still run for retry.
          try {
            await atomicUpdateRegistry(async (reg) => {
              const existing = (reg as Record<string, unknown>)[id] as Record<string, unknown> | undefined;
              if (!existing) return;
              let mutated = false;
              if (
                (existing as { agent?: string }).agent === "unknown" &&
                ident.agent !== "unknown" &&
                typeof ident.agent === "string" &&
                ident.agent.length > 0
              ) {
                (existing as { agent: string }).agent = ident.agent;
                mutated = true;
              }
              const curDir = (existing as { directory?: string }).directory ?? (existing as { cwd?: string }).cwd;
              if (
                (!curDir || (typeof curDir === "string" && curDir.length === 0)) &&
                ident.directory &&
                typeof ident.directory === "string" &&
                ident.directory.startsWith("/")
              ) {
                (existing as { directory: string }).directory = ident.directory;
                (existing as { cwd: string }).cwd = ident.directory;
                (existing as { repo: string }).repo = basename(ident.directory);
                mutated = true;
              }
              // Title gating: a generic title never clobbers a real one.
              const kept = (existing as { description?: string }).description;
              if (resolved && !isGenericTitle(resolved) && (!kept || isGenericTitle(kept))) {
                (existing as { description: string }).description = resolved!;
                (existing as { summary: string }).summary = resolved!;
                (existing as { title: string }).title = resolved!;
                mutated = true;
              }
              // Model refresh: a non-empty live model overwrites, absent never
              // clobbers (additive, staleness is bounded by live-first reads).
              if (
                typeof ident.model === "string" &&
                ident.model.length > 0 &&
                (existing as { model?: string }).model !== ident.model
              ) {
                (existing as { model: string }).model = ident.model;
                mutated = true;
              }
              if (mutated) (existing as { updatedAt: number }).updatedAt = Date.now();
            });
          } catch (err) {
            if (!isLockContention(err)) throw err;
          }
          if (resolved && !isGenericTitle(resolved)) {
            const cur = seenSessions.get(id);
            if (cur) seenSessions.set(id, { agentAt: cur.agentAt, titleAt: Date.now() });
            else seenSessions.set(id, { agentAt: Date.now(), titleAt: Date.now() });
            // Non-generic title transitions stamp last action; stamp failure drops.
            try {
              await stampLastAction(id);
            } catch {}
          }
          if (ident.agent !== "unknown") {
            const cur = seenSessions.get(id);
            if (cur) seenSessions.set(id, { agentAt: Date.now(), titleAt: cur.titleAt });
          }
          ensureClaimer();
          break;
        }
        case "session.deleted": {
          const info = (event as { properties: { info: { id: string } } }).properties.info;
          const id = info.id;
          if (!id) return;
          // Attached-exempt: the oracle still lists this id, so the delete
          // path alone never removes it; expiry owns the transition.
          try {
            const reg = (await readRegistry().catch(() => ({} as Record<string, unknown>))) as Record<string, unknown>;
            if (isAttachedExempt(reg[id])) return;
          } catch {}
          await deletePresence(id);
          try {
            const { appendDeleteAudit } = await import("../src/registry.js");
            await appendDeleteAudit("session.deleted", [id]);
          } catch {}
          break;
        }
        default:
          return;
      }
    },
    "tool.execute.before": async (input) => {
      const sid = (input as { sessionID: string }).sessionID;
      if (!sid) return;
      const now = Date.now();
      const last = seenSessions.get(sid);
      if (last && now - last.agentAt < EVICT_GRACE_MS && now - last.titleAt < EVICT_GRACE_MS) return;
      seenSessions.set(sid, { agentAt: now, titleAt: now });
      const ctx = { agent: (input as { agent?: string }).agent, directory: (input as { directory?: string }).directory };
      const ident = await resolveIdentity(client, sid, undefined, ctx);
      await upsertPresence(sid, ident.directory, ident.agent, ident.title, ident.model);
      // Stamp placement follows session.created: after the debounce guard.
      try {
        await stampLastAction(sid);
      } catch {}
      ensureClaimer();
    },
    tool: {
      mesh_register: {
        ...mesh_register,
        async execute(args: unknown, ctx: unknown): Promise<unknown> {
          const c = ctx as { sessionID: string; directory: string; agent?: string };
          await autoRegister(c.sessionID, c.directory, { agent: c.agent, directory: c.directory }, client);
          return (mesh_register.execute as unknown as (a: unknown, b: unknown) => Promise<unknown>)(args, ctx);
        },
      },
      mesh_peers: {
        ...mesh_peers,
        async execute(args: unknown, ctx: unknown): Promise<unknown> {
          const c = ctx as { sessionID: string; directory: string; agent?: string };
          await autoRegister(c.sessionID, c.directory, { agent: c.agent, directory: c.directory }, client);
          return (mesh_peers.execute as unknown as (a: unknown, b: unknown) => Promise<unknown>)(args, ctx);
        },
      },
      mesh_send: {
        ...mesh_send,
        async execute(args: unknown, ctx: unknown): Promise<unknown> {
          const c = ctx as { sessionID: string; directory: string; agent?: string };
          await autoRegister(c.sessionID, c.directory, { agent: c.agent, directory: c.directory }, client);
          return (mesh_send.execute as unknown as (a: unknown, b: unknown) => Promise<unknown>)(args, ctx);
        },
      },
      mesh_broadcast,
    },
    config: async (input) => {
      // Skill auto-load pushes skills root once; errors drop auto-load, copy fallback delivers.
      try {
        const cfg = input as unknown as { skills?: { paths?: unknown } };
        const root = resolveSkillsRoot();
        if (!cfg.skills) cfg.skills = {};
        const paths = cfg.skills.paths;
        if (Array.isArray(paths)) {
          if (!paths.includes(root)) paths.push(root);
        } else {
          cfg.skills.paths = [root];
        }
      } catch {}
    },
    dispose: async () => {
      // Scope invariant: dispose deletes own seenSessions ids only, past grace window.
      // Cross-process eviction belongs to runGc live-join; partial view never deletes alone.
      // Claimer teardown mirrors the scope: clear the poll timer and release owned unacked claims only.
      // Heartbeat teardown matches: a disposed instance must never tick into a later root.
      clearHeartbeatTimer();
      clearClaimerTimer();
      stopAttachPoller();
      await releaseClaimerOwner();
      const ids = [...seenSessions.keys()];
      if (ids.length === 0) return;
      let statusMap: Record<string, { type: string }> | null = null;
      try {
        const c = client as unknown as { session?: { status?: (o?: unknown) => Promise<unknown> } };
        if (c.session?.status) {
          const raw = (await c.session.status()) as unknown;
          statusMap = unwrapStatusMap(raw);
        }
      } catch {}
      if (statusMap && Object.keys(statusMap).length === 0) statusMap = null; // empty view is unknown, never a delete signal
      const now = Date.now();
      const deleted: string[] = [];
      // Fail-closed: contention skips the disk write while timer clear,
      // claimer release, audit attempt, and in-memory deletes still run;
      // teardown paths never throw a lock error to the host.
      try {
        await atomicUpdateRegistry((reg) => {
          for (const id of ids) {
            const entry = (reg as Record<string, unknown>)[id] as { updatedAt?: unknown } | undefined;
            if (!entry) continue;
            // Attached-exempt regardless of age: dispose never deletes an attached id.
            if (isAttachedExempt(entry)) continue;
            if (statusMap && !(id in statusMap)) {
              if (typeof entry.updatedAt === "number" && now - entry.updatedAt <= EVICT_GRACE_MS) continue;
              delete (reg as Record<string, unknown>)[id];
              deleted.push(id);
            }
          }
        });
      } catch (err) {
        if (!isLockContention(err)) throw err;
      }
      try {
        const { appendDeleteAudit } = await import("../src/registry.js");
        await appendDeleteAudit("dispose", deleted);
      } catch {}
      for (const id of ids) {
        seenSessions.delete(id);
      }
    },
  };
};
export default plugin;
