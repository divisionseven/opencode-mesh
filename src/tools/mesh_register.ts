// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Register this session in the mesh registry.
import { existsSync } from "node:fs";
import { tool } from "@opencode-ai/plugin";
import { MeshError } from "../errors.js";
import { isLockContention } from "../fsAtomic.js";
import { atomicUpdateRegistry, normalizeEntry, readRegistry } from "../registry.js";
import { isGenericTitle } from "../identity.js";
import { resolveValidDir } from "../xdg.js";

/** mesh_register — upserts caller into registry and returns peers. */
export const mesh_register = tool({
  description: "Register this session in the mesh registry (summary + heartbeat). Returns peers.",
  args: {
    summary: tool.schema.string().optional().describe("One-line summary of this session's purpose"),
    description: tool.schema.string().optional().describe("Canonical description (alias for summary)"),
  },
  async execute(args, ctx) {
    const sessionId = (ctx as unknown as { sessionID: string }).sessionID;
    if (!sessionId) throw new MeshError("PEER_NOT_FOUND", "session.deleted 404: missing sessionID");
    const rawDesc = (args as unknown as { description?: string; summary?: string }).description ?? (args as unknown as { summary?: string }).summary;
    const isGenericNew = isGenericTitle(rawDesc ?? null);
    const dir = (ctx as unknown as { directory?: string }).directory;
    const agent = (ctx as unknown as { agent?: string }).agent;
    const dirFence = resolveValidDir(dir);
    const validDir = dirFence.kind === "valid" ? dirFence.dir : undefined;
    // Directory fence: stale directories refuse loud, never stored.
    // Absent stays absent.
    if (validDir && !existsSync(validDir))
      throw new MeshError("INVALID_DIRECTORY", `stale directory refused: ${validDir}`);
    const base = (validDir || "").split("/").pop() || "";
    const fallback = base ? `${agent ?? "unknown"} @ ${base}` : sessionId.slice(0, 8);
    // Fail-closed: contention degrades, validation stays loud for caller input.
    // Presence enrichment lives in the plugin wrapper via upsertPresence; this tool inherits only.
    // Absent or empty stays absent, one enrichment owner.
    try {
      await atomicUpdateRegistry(async (reg) => {
        const existing = reg[sessionId] as unknown as Record<string, unknown> | undefined;
        const isGenericExisting = isGenericTitle((existing as { description?: string } | undefined)?.description ?? null);
        if (existing && !isGenericExisting && isGenericNew) {
          if (!rawDesc) {
            (existing as { updatedAt: number }).updatedAt = Date.now();
            return;
          }
          if (isGenericNew) {
            (existing as { updatedAt: number }).updatedAt = Date.now();
            return;
          }
        }
        const entry: Record<string, unknown> = {
          sessionId,
          agent: agent ?? (existing as { agent?: string } | undefined)?.agent ?? "unknown",
          model: (existing as { model?: string } | undefined)?.model,
          directory: validDir ?? (existing as { directory?: string } | undefined)?.directory,
          cwd: validDir ?? (existing as { cwd?: string } | undefined)?.cwd,
          summary: rawDesc ?? (existing as { summary?: string } | undefined)?.summary ?? (existing as { description?: string } | undefined)?.description ?? fallback,
          description: rawDesc ?? (existing as { description?: string } | undefined)?.description ?? (existing as { summary?: string } | undefined)?.summary ?? fallback,
          title: rawDesc ?? (existing as { title?: string } | undefined)?.title ?? (existing as { description?: string } | undefined)?.description ?? fallback,
          updatedAt: Date.now(),
        };
        // never store '' directory; omit if undefined
        if (!entry.directory) {
          delete entry.directory;
          delete entry.cwd;
        }
        if (!entry.repo) delete entry.repo;
        // Learned model inherits like agent; absent or empty stays absent
        if (typeof entry.model !== "string" || (entry.model as string).length === 0) {
          delete entry.model;
        }
        reg[sessionId] = normalizeEntry(entry as never) as never;
      });
    } catch (err) {
      if (!isLockContention(err)) throw err;
      const bestPeers: Record<string, unknown> = (await readRegistry().catch(
        () => ({})
      )) as unknown as Record<string, unknown>;
      return {
        output: JSON.stringify({ registered: sessionId, peers: bestPeers, busy: true }, null, 2),
      };
    }
    const peers: Record<string, unknown> = (await readRegistry()) as unknown as Record<string, unknown>;
    return {
      output: JSON.stringify({ registered: sessionId, peers }, null, 2),
    };
  },
});
