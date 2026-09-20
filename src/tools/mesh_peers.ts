// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Ranked union display: attach-first decision-tree ordering, rank-last.
import { tool } from "@opencode-ai/plugin";
import { ACTIVE_WINDOW_MS } from "../constants.js";
import { isGenericTitle } from "../identity.js";

/** L1 directory score: exact outranks ancestor outranks basename outranks miss; miss scores zero, stays listed. */
export function scoreDirectory(candidateDirs: Array<string | undefined>, query: string | undefined): number {
  if (!query || query.length === 0) return 0;
  const q = query.toLowerCase();
  const dirs = candidateDirs.filter((d): d is string => typeof d === "string" && d.length > 0);
  if (dirs.some((d) => d.toLowerCase() === q)) return 3;
  if (dirs.some((d) => { const l = d.toLowerCase(); return l.startsWith(q + "/") || q.startsWith(l + "/"); })) return 2;
  if (
    dirs.some((d) => {
      const l = d.toLowerCase();
      return l.split("/").pop() === q || l.split("/").pop() === q.split("/").pop() || l.includes(q);
    })
  )
    return 1;
  return 0;
}

/** L2 agent score inside the directory order: substring match scores, miss scores zero, stays listed. */
export function scoreAgent(agent: string, query: string | undefined): number {
  if (!query || query.length === 0) return 0;
  return agent.toLowerCase().includes(query.toLowerCase()) ? 1 : 0;
}

/** L4 title confirmation score: non-generic title-family match scores, generic scores zero, miss stays listed. */
export function scoreTitle(fields: Array<string | undefined>, query: string | undefined): number {
  if (!query || query.length === 0) return 0;
  const q = query.toLowerCase();
  for (const f of fields) {
    if (typeof f !== "string" || f.length === 0 || isGenericTitle(f)) continue;
    if (f.toLowerCase().includes(q)) return 1;
  }
  return 0;
}

/** Ranked peer union display (never hides; freshness badge per row). */
export const mesh_peers = tool({
  description: "List mesh peers from registry merged with live session status.",
  args: {
    includeSelf: tool.schema.boolean().optional().describe("Include caller in results"),
    agent: tool.schema.string().optional().describe("Filter by agent substring case-insensitive"),
    description: tool.schema.string().optional().describe("Filter by description substring case-insensitive"),
    cwd: tool.schema.string().optional().describe("Filter by cwd/repo substring case-insensitive"),
    repo: tool.schema.string().optional().describe("Filter by repo substring case-insensitive"),
    receipt: tool.schema.string().optional().describe("Outbox receipt id (msg_…) — returns delivery state instead of peers"),
  },
  async execute(args, ctx) {
    const receiptArg = (args as unknown as { receipt?: string }).receipt;
    // Why: receipt-by-id — terminal-aware delivery state for one outbox row.
    if (typeof receiptArg === "string" && receiptArg.length > 0) {
      const { receiptById } = await import("../outbox.js");
      const receipt = await receiptById(receiptArg);
      return { output: JSON.stringify({ receipt }, null, 2) };
    }
    const includeSelf = args.includeSelf ?? false;
    const agentArg = (args as unknown as { agent?: string }).agent;
    const descArg = (args as unknown as { description?: string }).description;
    const cwdArg = (args as unknown as { cwd?: string }).cwd;
    const repoArg = (args as unknown as { repo?: string }).repo;
    const callerId = (ctx as unknown as { sessionID: string }).sessionID;
    // Discovery join: DB ground truth plus heartbeat claims plus live confirmation.
    // Display reads the join, never raw registry alone. Lazy import defers the
    // sqlite edge to call time so peers loads on sqlite-less hosts.
    const { joinAll } = await import("../discovery.js");
    const { peers: joined, degraded } = await joinAll();
    const reason = degraded ? "registry-only" : undefined;
    // Why: rank-last L0-L4 scoring — compat args feed stages, never remove ids.
    const scored: Array<{ id: string; entry: Record<string, unknown>; key: [number, number, number, number, number, number] }> = [];
    for (const [id, entry] of Object.entries(joined)) {
      if (!includeSelf && id === callerId) continue;
      const e = entry as unknown as Record<string, unknown>;
      const s = (v: unknown) => (typeof v === "string" ? v : "");
      const dir = s(e.directory) || s(e.cwd);
      const cwd = s(e.cwd) || s(e.directory);
      const repo = s(e.repo) || dir.split("/").pop() || "";
      const agent = s(e.agent);
      const l0 = (e.attached as boolean | undefined) === true ? 1 : 0;
      const l1 = Math.max(scoreDirectory([dir, cwd], cwdArg), scoreDirectory([repo, dir.split("/").pop()], repoArg));
      const l2 = scoreAgent(agent, agentArg);
      const liveType = s(e.live) !== "unknown" ? s(e.live) : s(e.status);
      const busy = liveType === "busy" || liveType === "retry" ? 1 : 0;
      const recency = typeof e.lastActionAt === "number" ? (e.lastActionAt as number) : 0;
      const l4 = scoreTitle([s(e.title), s(e.description), s(e.summary)], descArg);
      scored.push({ id, entry: e, key: [l0, l1, l2, busy, recency, l4] });
    }
    scored.sort((a, b) => {
      for (let i = 0; i < a.key.length; i++) {
        if (b.key[i] !== a.key[i]) return b.key[i] - a.key[i];
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const merged: Record<string, unknown> = {};
    scored.forEach((row, i) => {
      const e = row.entry as unknown as Record<string, string>;
      merged[row.id] = {
        ...(row.entry as Record<string, unknown>),
        description: e.description ?? e.summary ?? e.title,
        cwd: e.cwd ?? e.directory,
        directory: e.directory ?? e.cwd,
        repo: e.repo ?? (e.directory || e.cwd || "").split("/").pop(),
        live: e.live ?? "unknown",
        status: e.status ?? "unknown",
        // Four-value taxonomy (status / heartbeat-recent / db-truth / stale):
        // heartbeat-recent is assigned by the join only; unknowns fall to stale.
        liveSource: e.liveSource ?? "stale",
        ageSec: e.ageSec ?? 0,
        rank: i + 1,
      };
    });
    const meta = { count: Object.keys(merged).length, degraded, reason, activeWindowMs: ACTIVE_WINDOW_MS };
    // preserve backward compat: return merged map, but include meta when degraded for harness
    if (degraded) return { output: JSON.stringify({ peers: merged, meta }, null, 2) };
    return { output: JSON.stringify(merged, null, 2) };
  },
});
