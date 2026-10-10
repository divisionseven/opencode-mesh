// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Thin V2 adapter: delegation only. Exports Plugin.define({id, setup}) and
// delegates every behavior to the same src/ functions V1 uses. No tool logic,
// no presence logic, no TTL values live here. Sole host-SDK import in the tree
// beside the frozen V1 entry (beta-drift isolation: a docs shift touches this
// file only; src/ never imports the host SDK minus the three V1 shells).
import { Plugin } from "@opencode/plugin";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EVICT_GRACE_MS } from "../src/constants.js";
import { MeshError } from "../src/errors.js";
import {
  appendDeleteAudit,
  appendBootAudit,
  atomicUpdateRegistry,
  heartbeat,
  readRegistry,
} from "../src/registry.js";
import { BUILD_STAMP, VERSION } from "../src/version.js";
import { isAttachedExempt } from "../src/expiry.js";
import { stampLastAction } from "../src/lastAction.js";
import {
  clearClaimerTimer,
  configureClaimer,
  ensureClaimer,
  releaseClaimerOwner,
} from "../src/claimer.js";
import { startAttachPoller, stopAttachPoller } from "../src/attach.js";
import {
  MESH_REGISTER_DESCRIPTION,
  executeMeshRegister,
} from "../src/tools/mesh_register.core.js";
import {
  MESH_PEERS_DESCRIPTION,
  executeMeshPeers,
} from "../src/tools/mesh_peers.core.js";
import {
  MESH_SEND_DESCRIPTION,
  executeMeshSend,
} from "../src/tools/mesh_send.core.js";
import {
  acquireV2Setup,
  armV2SharedTimer,
  mergeV2Ids,
  releaseV2Setup,
  removeV2Ids,
  v2OwnedIds,
} from "../src/v2singleflight.js";

/** Stable V2 plugin id (also the status/diagnostics identity). */
const MESH_V2_PLUGIN_ID = "opencode-mesh";

/** The four tool names both entries register (single source for the zero-registration check). */
const MESH_TOOL_NAMES = ["mesh_register", "mesh_peers", "mesh_send", "mesh_broadcast"] as const;

/** Narrow view of a V2 event the lifecycle handler reads (union members all carry type/id/data). */
interface V2LifecycleEvent {
  type: string;
  id?: string;
  data?: Record<string, unknown> | null;
}

// Per-setup debounce mirroring the V1 EVICT_GRACE_MS fast path: repeat firings
// inside the window cost zero writes. Shared-ownership merges into the guard;
// this map stays per-setup so teardown never touches foreign ids.
const v2SeenAt = new Map<string, number>();

/**
 * Best-effort presence touch for one session id: guard-merge plus registry
 * heartbeat plus last-action stamp. Never throws (event/hook paths drop, never break).
 */
async function touchV2Presence(sessionId: string): Promise<void> {
  if (!sessionId) return;
  const now = Date.now();
  const last = v2SeenAt.get(sessionId);
  if (last !== undefined && now - last < EVICT_GRACE_MS) return;
  v2SeenAt.set(sessionId, now);
  mergeV2Ids([sessionId]);
  try {
    await heartbeat(sessionId);
  } catch {}
  try {
    await stampLastAction(sessionId);
  } catch {}
}

/**
 * V2 session lifecycle handler. Created touches presence; deleted
 * evicts with the attached-exempt guard; updated has no V2 counterpart
 * (manifest grep count 0) so freshness beyond this relies on TTL expiry with
 * ghost bound STALE_TTL_MS, never a name-matched silent subscribe. Other
 * events are no-ops by construction.
 */
async function handleV2Event(raw: unknown): Promise<void> {
  const event = raw as unknown as V2LifecycleEvent;
  if (!event || typeof event.type !== "string") return;
  if (event.type === "session.created") {
    const data = event.data ?? {};
    const id =
      (typeof data["sessionID"] === "string" ? (data["sessionID"] as string) : undefined) ??
      event.id ??
      "";
    await touchV2Presence(id);
    return;
  }
  if (event.type === "session.deleted") {
    const data = event.data ?? {};
    const id =
      (typeof data["sessionID"] === "string" ? (data["sessionID"] as string) : undefined) ??
      event.id ??
      "";
    if (!id) return;
    // Attached-exempt: the oracle still lists this id, so the delete path
    // alone never removes it; expiry owns the transition (mirrors V1).
    try {
      const reg = (await readRegistry().catch(() => ({} as Record<string, unknown>))) as Record<string, unknown>;
      if (isAttachedExempt(reg[id])) return;
    } catch {}
    try {
      await atomicUpdateRegistry((reg) => {
        delete (reg as Record<string, unknown>)[id];
      });
    } catch {}
    v2SeenAt.delete(id);
    try {
      await appendDeleteAudit("session.deleted", [id]);
    } catch {}
    return;
  }
  return;
}

/** Skills root probe: both layouts, first hit wins (mirrors the V1 resolver). */
function resolveV2SkillsRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "..", "skills"), resolve(here, "..", "..", "skills")];
  for (const c of candidates) {
    try {
      if (existsSync(resolve(c, "opencode-mesh", "SKILL.md"))) return c;
    } catch {}
  }
  return null;
}

export default Plugin.define({
  id: MESH_V2_PLUGIN_ID,
  async setup(ctx) {
    const ownership = acquireV2Setup();
    // Per-setup owned ids (subset of the guard union); teardown deletes only these.
    const mine = new Set<string>();
    const noteMine = (id: string): void => {
      if (id) mine.add(id);
    };
    // Init record: one audit-file line per init, screen output unchanged.
    try {
      await appendBootAudit(BUILD_STAMP, VERSION).catch(() => {});
    } catch {}

    // Prebuilt tool defs (loaded before registration; transform callbacks stay
    // synchronous, pure editor.add only, zero await/import/IO, reload-idempotent).
    const registerDef = {
      name: "mesh_register" as const,
      description: MESH_REGISTER_DESCRIPTION,
      input: {
        type: "object",
        properties: {
          summary: { type: "string", description: "One-line summary of this session's purpose" },
          description: { type: "string", description: "Canonical description (alias for summary)" },
        },
        additionalProperties: false,
      },
      execute: async (input: unknown, context: { sessionID: string; agent: string }) => {
        const args = input as { summary?: string; description?: string };
        if (context.sessionID) {
          noteMine(context.sessionID);
          await touchV2Presence(context.sessionID);
        }
        const r = await executeMeshRegister(args, {
          sessionID: context.sessionID,
          agent: context.agent,
        });
        return { content: r.output };
      },
    };
    const peersDef = {
      name: "mesh_peers" as const,
      description: MESH_PEERS_DESCRIPTION,
      input: {
        type: "object",
        properties: {
          includeSelf: { type: "boolean" },
          agent: { type: "string" },
          description: { type: "string" },
          cwd: { type: "string" },
          repo: { type: "string" },
          receipt: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: async (input: unknown, context: { sessionID: string }) => {
        const args = input as {
          includeSelf?: boolean;
          agent?: string;
          description?: string;
          cwd?: string;
          repo?: string;
          receipt?: string;
        };
        if (context.sessionID) {
          noteMine(context.sessionID);
          await touchV2Presence(context.sessionID);
        }
        const r = await executeMeshPeers(args, { sessionID: context.sessionID });
        return { content: r.output };
      },
    };
    const sendDef = {
      name: "mesh_send" as const,
      description: MESH_SEND_DESCRIPTION,
      input: {
        type: "object",
        properties: {
          target: { type: "string" },
          text: { type: "string" },
          noReply: { type: "boolean" },
          silent: { type: "boolean" },
          broadcast: { type: "boolean" },
        },
        required: ["target", "text"],
        additionalProperties: false,
      },
      execute: async (input: unknown, context: { sessionID: string; agent: string }) => {
        const args = input as {
          target: string;
          text: string;
          noReply?: boolean;
          silent?: boolean;
          broadcast?: boolean;
        };
        if (context.sessionID) {
          noteMine(context.sessionID);
          await touchV2Presence(context.sessionID);
        }
        const r = await executeMeshSend(args, {
          sessionID: context.sessionID,
          agent: context.agent,
        });
        return { content: r.output };
      },
    };
    const broadcastDef = {
      name: "mesh_broadcast" as const,
      description:
        "Broadcast to all peers (opt-in MESH_BROADCAST=1, default-off; alias for mesh_send broadcast:true)",
      input: {
        type: "object",
        properties: {
          text: { type: "string" },
          noReply: { type: "boolean" },
          silent: { type: "boolean" },
        },
        required: ["text"],
        additionalProperties: false,
      },
      execute: async (input: unknown, context: { sessionID: string; agent: string }) => {
        const args = input as { text: string; noReply?: boolean; silent?: boolean };
        if (context.sessionID) {
          noteMine(context.sessionID);
          await touchV2Presence(context.sessionID);
        }
        const r = await executeMeshSend(
          { target: "all", text: args.text, broadcast: true, noReply: args.noReply, silent: args.silent },
          { sessionID: context.sessionID, agent: context.agent }
        );
        return { content: r.output };
      },
    };
    await ctx.tool.transform((editor) => {
      editor.add(registerDef);
      editor.add(peersDef);
      editor.add(sendDef);
      editor.add(broadcastDef);
    });

    // Fail-loud registration proof: zero tools registered means the host
    // replayed nothing and every call would miss. Uses the existing
    // SERVER_UNAVAILABLE channel (no new codes in slice).
    const listed = await ctx.tool.list();
    const listedIds = new Set(listed.map((t) => t.id));
    const missing = MESH_TOOL_NAMES.filter((n) => !listedIds.has(n));
    if (missing.length > 0) {
      throw new MeshError(
        "SERVER_UNAVAILABLE",
        `v2 setup registered zero tools for ${missing.join(",")}: host transform replay missed`
      );
    }

    // Presence hook: sessionID plus agent arrive on the V2 event; directory is
    // absent by schema, so this stamps liveness only (never identity).
    await ctx.tool.hook("execute.before", (event) => {
      void touchV2Presence(event.sessionID).then((v) => {
        if (event.sessionID) noteMine(event.sessionID);
        return v;
      });
    });

    // Event subscription with AbortController teardown so dispose stops
    // the loop and a second setup never inherits a stale subscription.
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const id = (event as unknown as V2LifecycleEvent).id;
          if (typeof id === "string" && id) noteMine(id);
          await handleV2Event(event);
        }
      } catch {
        // Abort or transport drop ends the loop; cleanup owns teardown.
      }
    })();

    // Skill registration via the owning domain (V2 has no mutable global
    // config). Failure never breaks setup: the installer file-copy leg
    // already delivers the skill on V2 through the installer file copy,
    // so setup stays green when this registration throws.
    try {
      const skillsRoot = resolveV2SkillsRoot();
      if (skillsRoot) {
        const skillDir = resolve(skillsRoot, "opencode-mesh");
        const content = readFileSync(resolve(skillDir, "SKILL.md"), "utf8");
        const path = skillDir;
        const description = "Agent-to-agent mesh messaging between OpenCode sessions.";
        await ctx.skill.transform((editor) => {
          editor.add({
            id: "opencode-mesh" as never,
            name: "opencode-mesh" as never,
            description,
            path: path as never,
            content,
          });
        });
      }
    } catch {
      // File-copy leg covers delivery; setup stays green.
    }

    // Shared pollers arm exactly once per process (first setup only). Later
    // setups merge ids by union, register cheaply, arm zero timers. The V1
    // entry predates this guard, so same-process V1+V2 claimer-config overlap
    // is a named gap (V1 always reconfigures); V2-only processes are exact.
    if (ownership.first) {
      configureClaimer({
        getOwnIds: () => v2OwnedIds(),
        getClient: () => null,
        getRegistry: async () =>
          (await readRegistry().catch(() => ({}))) as Record<
            string,
            { agent?: string; directory?: string; cwd?: string; model?: string }
          >,
      });
      ensureClaimer();
      startAttachPoller();
      armV2SharedTimer(() => {
        void (async () => {
          for (const sid of v2OwnedIds()) {
            try {
              await heartbeat(sid);
            } catch {}
          }
        })();
      });
    }

    // Setup cleanup (replaces the V1 dispose hook; hook/transform
    // registrations auto-dispose, timers and sockets need explicit cleanup).
    return async () => {
      controller.abort();
      const mineIds = [...mine];
      const { last } = releaseV2Setup();
      removeV2Ids(mineIds);
      for (const id of mineIds) v2SeenAt.delete(id);
      if (last) {
        clearClaimerTimer();
        stopAttachPoller();
        try {
          await releaseClaimerOwner();
        } catch {}
      }
      if (mineIds.length === 0) return;
      const now = Date.now();
      const deleted: string[] = [];
      try {
        await atomicUpdateRegistry((reg) => {
          for (const id of mineIds) {
            const entry = (reg as Record<string, unknown>)[id] as { updatedAt?: unknown } | undefined;
            if (!entry) continue;
            // Attached-exempt regardless of age: cleanup never deletes an attached id.
            if (isAttachedExempt(entry)) continue;
            // V2 has no live status feed to confirm absence: delete only
            // past the grace window, never on a partial view alone.
            if (typeof entry.updatedAt === "number" && now - entry.updatedAt <= EVICT_GRACE_MS) continue;
            delete (reg as Record<string, unknown>)[id];
            deleted.push(id);
          }
        });
      } catch {}
      try {
        await appendDeleteAudit("dispose", deleted);
      } catch {}
    };
  },
});
