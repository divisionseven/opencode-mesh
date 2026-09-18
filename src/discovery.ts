// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Single owner for the registry plus status join (DB-grounded existence).
// Existence reads opencode.db unconditionally (read-only); the registry is a freshness overlay, never the sole source.
import { homedir } from "node:os";
import { join } from "node:path";
// Type-only node shape (erased; the driver resolves lazily in loadSqlite).
// Forked SqliteDb adapter converges node plus bun via loadSqlite.
import type { DatabaseSync } from "node:sqlite";
import { ACTIVE_WINDOW_MS, ATTACH_GONE_GRACE_MS, ATTACH_POLL_MS, EVICT_GRACE_MS } from "./constants.js";
import { deriveSessionType } from "./expiry.js";
import { isGenericTitle } from "./identity.js";
import { loadSqlite, type SqliteDb } from "./outbox.js";

import { fetchSinglePortStatusMap, readRegistry, unwrapStatusMap, type Registry } from "./registry.js";
import { getAttachSnapshot } from "./attach.js";

export type StatusMap = Record<string, { type: string }>;

export interface DbSession {
  id: string;
  agent: string | null;
  directory: string | null;
  title: string | null;
  dbUpdatedAt: number;
  /** Derived type: primary when parent_id is NULL, subagent otherwise. Absent reads primary. */
  sessionType?: string;
}

export type DbSessionMap = Record<string, DbSession>;

function defaultDbPath(): string {
  if (process.env.OPENCODE_MESH_DB_PATH) return process.env.OPENCODE_MESH_DB_PATH;
  return join(homedir(), ".local", "share", "opencode", "opencode.db");
}

let liveClientHolder: unknown = null;

/** Plugin sets its in-process client here at init; tools read live status through it. */
export function setLiveClient(client: unknown): void {
  liveClientHolder = client;
}

/**
 * DB session scrape, read-only; failures yield partial maps, delete zero.
 */
export async function readDbSessions(dbPath?: string): Promise<DbSessionMap> {
  const out: DbSessionMap = {};
  let db: SqliteDb | null = null;
  try {
    const Ctor = await loadSqlite();
    db = new Ctor(dbPath ?? defaultDbPath(), { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA query_only = ON");
    type Row = { id: unknown; agent: unknown; directory: unknown; title: unknown; time_updated: unknown; parent_id?: unknown };
    let rows: Row[] | null = null;
    try {
      rows = db
        .prepare(`SELECT id, agent, directory, title, time_updated, parent_id FROM session`)
        .all() as unknown as Row[];
    } catch {
      rows = null;
    }
    if (!rows) {
      // Fallback for stores without parent_id. Every
      // type defaults to primary, so the fallback never expires early.
      try {
        const legacy = db
          .prepare(`SELECT id, agent, directory, title, time_updated FROM session`)
          .all() as unknown as Row[];
        rows = legacy.map((r) => ({ ...r, parent_id: null }));
      } catch {
        return out;
      }
    }
    for (const r of rows) {
      if (typeof r.id === "string" && r.id.length > 0) {
        const rawTs = typeof r.time_updated === "number" ? r.time_updated : 0;
        // ms-normalize guard: live rows are ms scale; second-scale values scale
        // by 1000 so fixtures in seconds badge correctly (no-op live).
        const dbUpdatedAt = rawTs > 0 && rawTs < 1e12 ? rawTs * 1000 : rawTs;
        out[r.id] = {
          id: r.id,
          agent: typeof r.agent === "string" && r.agent.length > 0 ? r.agent : null,
          directory: typeof r.directory === "string" ? r.directory : null,
          title: typeof r.title === "string" ? r.title : null,
          dbUpdatedAt,
          sessionType: deriveSessionType(r.parent_id),
        };
      }
    }
  } catch {
    return out;
  } finally {
    try {
      db?.close();
    // Why: best-effort — DB close failure must not crash the session scrape.
    } catch {}
  }
  return out;
}

/**
 * Tagged DB triple with classified miss; read-only, never throws.
 * Evidence rides beside verdict for terminal audit lines.
 */
export async function readDbTripleDetailed(
  sessionId: string,
  dbPath?: string
): Promise<
  | { ok: true; triple: { agent: string | null; model: string | null } }
  | { ok: false; reason: "db-throw"; dbPath: string; dbCode?: string; dbError?: string }
  | { ok: false; reason: "db-row-absent"; dbPath: string }
> {
  const attempted = dbPath ?? defaultDbPath();
  let db: SqliteDb | null = null;
  try {
    const Ctor = await loadSqlite();
    db = new Ctor(attempted, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA query_only = ON");
    type Row = { agent: unknown; model: unknown };
    let row: Row | null = null;
    try {
      const stmt = db.prepare(`SELECT agent, model FROM session WHERE id = ? LIMIT 1`);
      const raw = stmt.get(sessionId) as unknown as Row | undefined;
      row = raw ?? null;
    } catch (err) {
      return { ok: false, reason: "db-throw", dbPath: attempted, dbCode: codeOf(err), dbError: String(err).slice(0, 300) };
    }
    if (!row) return { ok: false, reason: "db-row-absent", dbPath: attempted };
    return {
      ok: true,
      triple: {
        agent: typeof row.agent === "string" ? row.agent : null,
        model: typeof row.model === "string" ? row.model : null,
      },
    };
  } catch (err) {
    return { ok: false, reason: "db-throw", dbPath: attempted, dbCode: codeOf(err), dbError: String(err).slice(0, 300) };
  } finally {
    try {
      db?.close();
    // Why: best-effort — DB close failure must not crash the triple read.
    } catch {}
  }
}

/** Non-throwing driver-code read: string codes pass through, all else yields undefined. */
function codeOf(err: unknown): string | undefined {
  try {
    const code = (err as { code?: unknown })?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Narrow receiver triple, read-only; failures yield null for miss fallthrough. */
export async function readDbTriple(
  sessionId: string,
  dbPath?: string
): Promise<{ agent: string | null; model: string | null } | null> {
  try {
    const detailed = await readDbTripleDetailed(sessionId, dbPath);
    return detailed.ok ? detailed.triple : null;
  } catch {
    return null;
  }
}

/** DB message-leg recency at display time; failures yield empty maps. */
export async function readMessageRecency(dbPath?: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  let db: SqliteDb | null = null;
  try {
    const Ctor = await loadSqlite();
    db = new Ctor(dbPath ?? defaultDbPath(), { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA query_only = ON");
    const rows = db
      .prepare(`SELECT session_id, MAX(time_updated) AS t FROM message GROUP BY session_id`)
      .all() as unknown as Array<{ session_id: unknown; t: unknown }>;
    for (const r of rows) {
      if (typeof r.session_id === "string" && r.session_id.length > 0 && typeof r.t === "number" && r.t > 0) {
        out[r.session_id] = r.t > 0 && r.t < 1e12 ? r.t * 1000 : r.t;
      }
    }
  } catch {
    return out;
  } finally {
    try {
      db?.close();
    // Why: best-effort — DB close failure must not crash the recency read.
    } catch {}
  }
  return out;
}

/**
 * In-process live status where the plugin holder exists. Never a TCP fetch.
 * Null means unknown, never empty (fail-closed: null deletes zero).
 */
export async function readLiveStatus(): Promise<StatusMap | null> {
  try {
    const c = liveClientHolder as { session?: { status?: (o?: unknown) => Promise<unknown> } } | null;
    if (!c?.session?.status) return null;
    const raw = (await c.session.status()) as unknown;
    return unwrapStatusMap(raw);
  // Why: best-effort — live status lookup failure degrades to null, not a crash.
  } catch {}
  return null;
}

/** Union of the TCP single-port view and the in-process view; live wins per id. */
export function mergeStatus(tcp: StatusMap | null, live: StatusMap | null): StatusMap | null {
  if (!tcp && !live) return null;
  return { ...(tcp ?? {}), ...(live ?? {}) };
}

/** TCP single-port map only: the one view safe for confirmed-dead persistence. */
export async function readTcpStatus(): Promise<StatusMap | null> {
  return fetchSinglePortStatusMap();
}

function baseRepo(dir: string): string {
  return dir.split("/").pop() || dir;
}

/**
 * Extra rank inputs for the tiered join. Every field is optional so existing
 * four-arg callers keep compiling and behaving identically when omitted.
 */
export interface JoinExtra {
  /** Attached ids from the oracle tier (unioned with registry markers). */
  attached?: Iterable<string>;
  /** Tracker stamps per id (tool plus session-event activity). */
  lastAction?: Record<string, number>;
  /** DB message-leg recency per id, read at display time. */
  messageRecency?: Record<string, number>;
}

/**
 * Visible peers from DB plus registry plus live; never hides, one badge each.
 */
export function joinSessions(
  db: DbSessionMap,
  reg: Registry,
  status: StatusMap | null,
  now = Date.now(),
  extra?: JoinExtra
): Record<string, unknown> {
  if (status && Object.keys(status).length === 0) status = null; // db-truth: empty view is unknown, never a delete signal
  const merged: Record<string, unknown> = {};
  const attachedSet = new Set(extra?.attached ?? []);
  const ids = new Set([...Object.keys(db), ...Object.keys(reg)]);
  for (const id of ids) {
    const entry = reg[id] as unknown as Record<string, unknown> | undefined;
    const row = db[id];
    const inStatus = !!status && id in status;
    const regAge = entry && typeof entry.updatedAt === "number" ? now - (entry.updatedAt as number) : Number.POSITIVE_INFINITY;
    const dbAge = row ? now - row.dbUpdatedAt : Number.POSITIVE_INFINITY;
    let source: "status" | "heartbeat-recent" | "db-truth" | "stale";
    if (inStatus) source = "status";
    else if (status && entry && regAge <= EVICT_GRACE_MS) source = "heartbeat-recent";
    else if (!status && entry && regAge <= ACTIVE_WINDOW_MS) source = "heartbeat-recent";
    else if (row && dbAge <= ACTIVE_WINDOW_MS) source = "db-truth";
    else source = "stale";
    const e = { ...((entry ?? {}) as Record<string, unknown>) } as Record<string, unknown>;
    if (!e.sessionId) e.sessionId = id;
    // agent priority: registry non-unknown, then DB non-empty, then unknown.
    const regAgent = typeof e.agent === "string" ? (e.agent as string) : "";
    if (!regAgent || regAgent === "unknown") {
      e.agent = row?.agent && row.agent.length > 0 ? row.agent : regAgent || "unknown";
    }
    const dir = (e.directory as string | undefined) ?? (e.cwd as string | undefined) ?? row?.directory ?? undefined;
    if (typeof dir === "string" && dir.length > 0) {
      e.directory = dir;
      e.cwd = dir;
      e.repo = (e.repo as string | undefined) ?? baseRepo(dir);
    }
    // Title reads the title column; registry generic plus DB real overwrites description.
    const regTitle = typeof e.title === "string" ? (e.title as string) : undefined;
    if ((!regTitle || isGenericTitle(regTitle)) && row?.title && !isGenericTitle(row.title)) {
      e.description = row.title;
      e.summary = row.title;
      e.title = row.title;
    }
    if (!e.description) e.description = (e.summary as string | undefined) ?? (e.title as string | undefined) ?? id.slice(0, 8);
    const live = inStatus ? (status as StatusMap)[id]?.type ?? "unknown" : "unknown";
    const freshest = Math.min(
      entry && typeof entry.updatedAt === "number" ? (entry.updatedAt as number) : Number.POSITIVE_INFINITY,
      row ? row.dbUpdatedAt : Number.POSITIVE_INFINITY
    );
    // Tier inputs ride beside badge: attached, type, and last-action union.
    const regRec = entry as unknown as Record<string, unknown> | undefined;
    const attached = attachedSet.has(id) || regRec?.attached === true;
    const sessionType =
      row?.sessionType ?? (typeof regRec?.sessionType === "string" ? (regRec.sessionType as string) : undefined) ?? "primary";
    const trackerAt = extra?.lastAction?.[id] ?? (typeof regRec?.lastActionAt === "number" ? (regRec.lastActionAt as number) : 0);
    const msgAt = extra?.messageRecency?.[id] ?? 0;
    const lastActionAt = Math.max(trackerAt, msgAt, row ? row.dbUpdatedAt : 0);
    merged[id] = {
      ...e,
      live,
      status: live,
      liveSource: source,
      ageSec: freshest === Number.POSITIVE_INFINITY ? 0 : Math.max(0, Math.floor((now - freshest) / 1000)),
      attached,
      sessionType,
      lastActionAt,
    };
  }
  return merged;
}

export interface JoinResult {
  peers: Record<string, unknown>;
  statusMap: StatusMap | null;
  tcpMap: StatusMap | null;
  degraded: boolean;
}

// Snapshot age bound: one missed poll plus the gone-grace the registry path
// enforces, so the snapshot never outlives its own marker clearing.
// Exported: the staleness test imports the bound instead of naming a literal.
export const ATTACH_SNAPSHOT_MAX_AGE_MS = ATTACH_POLL_MS + ATTACH_GONE_GRACE_MS;

/** Full join for display surfaces: DB existence unconditionally plus registry claims plus live overlay. */
export async function joinAll(meshRoot?: string): Promise<JoinResult> {
  const reg: Registry = await readRegistry(meshRoot);
  const db = await readDbSessions();
  const messageRecency = await readMessageRecency();
  const live = await readLiveStatus();
  const tcp = await readTcpStatus();
  const statusMap = mergeStatus(tcp, live);
  const now = Date.now();
  // Snapshot tier: fresh snapshot threads through; null, empty, failed-poll,
  // and stale snapshots all read as empty, so the join degrades to today's
  // registry-marker behavior instead of showing stale badges.
  const snap = getAttachSnapshot();
  const snapAttached = snap !== null && now - snap.at <= ATTACH_SNAPSHOT_MAX_AGE_MS ? snap.attached : [];
  return { peers: joinSessions(db, reg, statusMap, now, { messageRecency, attached: snapAttached }), statusMap, tcpMap: tcp, degraded: statusMap === null };
}
