// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Mesh-owned durable queue with atomic claim (single owner).
// One row per delivery, FIFO per target via seq; SQLite transactions own concurrency, never a file lock.
import { existsSync } from "node:fs";
import { chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { FILE_MODE, MSG_ID_B62_LEN, MSG_ID_HEX_LEN, MSG_ID_PREFIX, ONE_MB, OUTBOX_CLAIM_TIMEOUT_MS, OUTBOX_DEPTH_CAP, OUTBOX_MAX_ATTEMPTS, OUTBOX_TTL_MS, OUTBOX_VACUUM_MIN_PAGES } from "./constants.js";
import { MeshError } from "./errors.js";
import { ensureDir0700, fsyncDir, isNoSpace, writeAtomic } from "./fsAtomic.js";
import type { MissLayer, MissReason } from "./identity.js";
import { BUILD_STAMP } from "./version.js";
import { resolveOutboxPath, sanitizeSessionId } from "./xdg.js";
import { dirname, resolve } from "node:path";

const OUTBOX_DDL = `CREATE TABLE IF NOT EXISTS outbox(
seq INTEGER PRIMARY KEY AUTOINCREMENT,
id TEXT UNIQUE NOT NULL,
target_session TEXT NOT NULL,
from_session TEXT NOT NULL,
from_agent TEXT NOT NULL,
text TEXT NOT NULL,
created_at INTEGER NOT NULL,
broadcast_id TEXT,
claimed_by TEXT,
claimed_at INTEGER,
delivered_at INTEGER,
attempts INTEGER NOT NULL DEFAULT 0,
silent INTEGER NOT NULL DEFAULT 0,
fail_reason TEXT
)`;
const OUTBOX_INDEX_TARGET = `CREATE INDEX IF NOT EXISTS idx_outbox_target_seq ON outbox(target_session, seq)`;
const OUTBOX_INDEX_CLAIM = `CREATE INDEX IF NOT EXISTS idx_outbox_claim ON outbox(claimed_by, delivered_at)`;

/** One queued delivery row. */
export interface OutboxRow {
  seq: number;
  id: string;
  target_session: string;
  from_session: string;
  from_agent: string;
  text: string;
  created_at: number;
  broadcast_id: string | null;
  claimed_by: string | null;
  claimed_at: number | null;
  delivered_at: number | null;
  attempts: number;
  /** Silent deposit bit: 1 pins `noReply:true` on the claim inject, 0 wakes. Pre-migration rows read back 0. */
  silent: number;
  /** Terminal failure reason: NULL while routable, closed-set string after `failRow` commits. Pre-migration rows read back NULL. */
  fail_reason: string | null;
  /** Generation that enqueued the row, recorded where the sender cannot later rewrite it. Pre-migration rows read back NULL. */
  sender_build?: string | null;
  /** Terminal miss layer from the resolver trail, NULL until `failRow` commits. Pre-migration rows read back NULL. */
  miss_layer?: string | null;
  /** Terminal miss reason from the resolver trail, NULL until `failRow` commits. Pre-migration rows read back NULL. */
  miss_reason?: string | null;
  /** Generation that terminalized the row, NULL until `failRow` commits. Pre-migration rows read back NULL. */
  build?: string | null;
}

export interface EnqueueInput {
  target_session: string;
  from_session: string;
  from_agent: string;
  text: string;
  broadcast_id?: string;
  /** Per-message silent deposit; survives the queue so the claim leg matches the direct leg. Defaults to wake. */
  silent?: boolean;
  /** Envelope id for idempotent enqueue: a row with this id already present is a duplicate no-op returning the id. */
  id?: string;
}

/** Single-owned size guard: all three points live here; throws 413, never clips. */
export function assertSendable(text: string, prefixLength = 0): void {
  const textBytes = Buffer.byteLength(text, "utf8");
  if (textBytes > ONE_MB) throw new MeshError("PAYLOAD_TOO_LARGE", `1MB guard 413: text ${textBytes} exceeds ${ONE_MB}`);
  if (prefixLength + 2 + textBytes > ONE_MB)
    throw new MeshError("PAYLOAD_TOO_LARGE", `1MB guard 413: prefixed ${prefixLength + 2 + textBytes} exceeds ${ONE_MB}`);
}

/** Serialized-body point of the same guard: bodies at or over 1MB refuse. */
export function assertBodySendable(bodyBytes: number): void {
  if (bodyBytes >= ONE_MB) throw new MeshError("PAYLOAD_TOO_LARGE", `1MB guard 413: body ${bodyBytes} >= ${ONE_MB}`);
}

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let msgCounter = 0;

/** Single-owner branded message ID (12 hex plus 14 base62; counter orders, random uniquifies). */
export function newMessageId(): string {
  const hex = randomBytes(MSG_ID_HEX_LEN / 2).toString("hex");
  msgCounter = (msgCounter + 1) % 0xffffffff;
  const buf = randomBytes(10);
  buf.writeUInt32BE(msgCounter, 6);
  let n = BigInt(`0x${buf.toString("hex")}`);
  let s = "";
  for (let i = 0; i < MSG_ID_B62_LEN; i++) {
    s = B62[Number(n % 62n)] + s;
    n /= 62n;
  }
  return `${MSG_ID_PREFIX}${hex}${s}`;
}

/** Brand predicate for the msg_ alphabet (row keys are equality-matched, never brand-checked). */
export function isMsgId(s: string): boolean {
  return /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(s);
}

/**
 * Mesh model parser over a verified-present model token; slash-less takes the opencode provider prefix.
 * Absent never reaches here (every caller guards; missing reads null at the resolver and defers, never synthesizes).
 */
export function resolveMeshModel(entry: { model: string }): { providerID: string; modelID: string } {
  const raw = entry?.model;
  if (typeof raw !== "string" || raw.length === 0) throw new Error("resolveMeshModel requires a verified-present model token");
  const i = raw.indexOf("/");
  if (i > 0) return { providerID: raw.slice(0, i), modelID: raw.slice(i + 1) };
  return { providerID: "opencode", modelID: raw };
}

/** Shared lazy sqlite loader (single fork point). Tries `bun:sqlite` where the
 * Bun marker is present, else `node:sqlite`; throws STORAGE_UNAVAILABLE when
 * neither driver resolves. Call sites keep their SQL plus PRAGMA text verbatim. */
export async function loadSqlite(): Promise<SqliteCtor> {
  if (hasBunMarker()) {
    try {
      // @ts-ignore — bun:sqlite types exist only under Bun; Node benches resolve this leg lazily at runtime.
      const m = (await import("bun:sqlite")) as Record<string, unknown>;
      const Raw = (m.Database ?? m.DatabaseSync) as new (...a: unknown[]) => unknown;
      if (typeof Raw === "function") return wrapCtor(Raw, true);
    // Why: best-effort — bun:sqlite driver not available must not block SQLite loading.
    } catch {}
  }
  try {
    const m = await import("node:sqlite");
    return wrapCtor(m.DatabaseSync as unknown as new (...a: unknown[]) => unknown, false);
  } catch (err) {
    throw new MeshError("STORAGE_UNAVAILABLE", `outbox unavailable: ${String((err as Error)?.message ?? err)}`);
  }
}

/** Bun runtime marker (exact predicate: version flag plus global). */
function hasBunMarker(): boolean {
  try {
    if (typeof (process.versions as Record<string, string | undefined>)?.bun === "string") return true;
    if (typeof (globalThis as Record<string, unknown>).Bun !== "undefined") return true;
  // Why: best-effort — bun version detection failure must not block driver selection.
  } catch {}
  return false;
}

/** Normalized statement: `node:sqlite` prepare plus `bun:sqlite` query shapes converge here. */
export interface SqliteStatement {
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  run: (...params: unknown[]) => { changes: number };
}

/** Normalized database handle: exec plus prepare plus close converge here. */
export interface SqliteDb {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
}

/** Normalized constructor: path plus optional read-only open, driver-agnostic. */
export interface SqliteCtor {
  new (path: string, options?: { readOnly?: boolean }): SqliteDb;
}

function normalizeChanges(res: unknown): number {
  const c = (res as { changes?: unknown } | null | undefined)?.changes;
  if (typeof c === "bigint") return Number(c); // BigInt (bun:sqlite) to Number (node:sqlite parity)
  return Number(c ?? 0);
}

function adaptStatement(raw: unknown): SqliteStatement {
  const s = raw as Record<string, (...a: unknown[]) => unknown>;
  // Bind to the statement handle: both drivers' methods require receiver `this`.
  const get = typeof s.get === "function" ? s.get.bind(raw) : undefined;
  const all = typeof s.all === "function" ? s.all.bind(raw) : undefined;
  const run = typeof s.run === "function" ? s.run.bind(raw) : undefined;
  return {
    get: (...p) => (get ? get(...p) : undefined),
    all: (...p) => (all ? (all(...p) as unknown[]) : []),
    run: (...p) => {
      if (run) return { changes: normalizeChanges(run(...p)) };
      return { changes: 0 };
    },
  };
}

function adaptDb(raw: unknown): SqliteDb {
  const db = raw as Record<string, ((sql: string) => unknown) | (() => void) | undefined>;
  // Bind to the db handle: both drivers' methods require receiver `this`.
  const prepareRaw = db.prepare as unknown as ((sql: string) => unknown) | undefined;
  const queryRaw = db.query as unknown as ((sql: string) => unknown) | undefined;
  const execRaw = db.exec as unknown as ((sql: string) => void) | undefined;
  const closeRaw = db.close as unknown as (() => void) | undefined;
  const prepare = typeof prepareRaw === "function" ? prepareRaw.bind(raw) : undefined;
  const query = typeof queryRaw === "function" ? queryRaw.bind(raw) : undefined;
  const exec = typeof execRaw === "function" ? execRaw.bind(raw) : undefined;
  const close = typeof closeRaw === "function" ? closeRaw.bind(raw) : undefined;
  return {
    exec: (sql) => {
      if (exec) exec(sql);
    },
    prepare: (sql: string) => {
      if (prepare) return adaptStatement(prepare(sql));
      if (query) return adaptStatement(query(sql));
      throw new MeshError("STORAGE_UNAVAILABLE", "outbox unavailable: driver has no prepare/query");
    },
    close: () => {
      try {
        close?.();
      // Why: best-effort — DB close failure must not block the adapter cleanup.
      } catch {}
    },
  };
}

function wrapCtor(Raw: new (...a: unknown[]) => unknown, isBun: boolean): SqliteCtor {
  function Ctor(path: string, options?: { readOnly?: boolean }): SqliteDb {
    // node:sqlite rejects an explicit undefined options arg; bun accepts omission.
    // Pass options only when defined so both drivers open identically.
    if (options === undefined) return adaptDb(new Raw(path));
    if (isBun) {
      // bun:sqlite opens read-only via lowercase `readonly`; camelCase is ignored.
      // Defined-but-absent stays omission so both drivers open identically.
      if (options.readOnly === undefined) return adaptDb(new Raw(path));
      return adaptDb(new Raw(path, { readonly: options.readOnly }));
    }
    return adaptDb(new Raw(path, options));
  }
  return Ctor as unknown as SqliteCtor;
}

// Erased shape: drivers resolve lazily in loadSqlite; zero static edges.
// Adapter normalizes exec/prepare/close; covered by the loadSqlite lazy-driver suite.

function isUnavailable(err: unknown): boolean {
  return err instanceof MeshError && err.code === "STORAGE_UNAVAILABLE";
}

function storageError(err: unknown): MeshError {
  const code = (err as { code?: string })?.code ?? "";
  const errno = (err as { errno?: number })?.errno;
  if (isNoSpace(err) || code.includes("FULL") || errno === 13)
    return new MeshError("STORAGE_FULL", `outbox full: ${String((err as Error)?.message ?? err)}`);
  if (code.includes("CORRUPT") || errno === 11)
    return new MeshError("STORAGE_CORRUPT", `outbox corrupt: ${String((err as Error)?.message ?? err)}`);
  throw err;
}

async function openOutbox(meshRoot?: string): Promise<SqliteDb> {
  const Ctor = await loadSqlite();
  const target = resolveOutboxPath(meshRoot);
  const db = new Ctor(target);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = FULL");
  db.exec(OUTBOX_DDL);
  db.exec(OUTBOX_INDEX_TARGET);
  db.exec(OUTBOX_INDEX_CLAIM);
  // Additive migration: old DBs gain silent on first open; rows read 0.
  // PRAGMA skips migrated DBs; duplicate-column catch guards races.
  try {
    const cols = db.prepare(`PRAGMA table_info(outbox)`).all() as unknown as Array<{ name?: string }>;
    if (!cols.some((c) => c?.name === "silent")) {
      try {
        db.exec(`ALTER TABLE outbox ADD COLUMN silent INTEGER NOT NULL DEFAULT 0`);
      } catch (err) {
        if (!/duplicate column/i.test(String((err as Error)?.message ?? err))) throw err;
      }
    }
    // Additive migration: old DBs gain fail_reason on first open; rows read NULL.
    // Same PRAGMA plus catch for races; column exists before queries run.
    if (!cols.some((c) => c?.name === "fail_reason")) {
      try {
        db.exec(`ALTER TABLE outbox ADD COLUMN fail_reason TEXT`);
      } catch (err) {
        if (!/duplicate column/i.test(String((err as Error)?.message ?? err))) throw err;
      }
    }
    // Additive migrations: old DBs gain sender_build plus miss pair plus build.
    // Same PRAGMA plus catch per column; pre-migration rows read NULL.
    for (const name of ["sender_build", "miss_layer", "miss_reason", "build"]) {
      if (!cols.some((c) => c?.name === name)) {
        try {
          db.exec(`ALTER TABLE outbox ADD COLUMN ${name} TEXT`);
        } catch (err) {
          if (!/duplicate column/i.test(String((err as Error)?.message ?? err))) throw err;
        }
      }
    }
  } catch (err) {
    if (!/duplicate column/i.test(String((err as Error)?.message ?? err))) throw err;
  }
  return db;
}

/** Ensure dir 0700 plus first-byte file 0600 through the atomic path, then open. */
export async function ensureOutbox(meshRoot?: string): Promise<string> {
  const target = resolveOutboxPath(meshRoot);
  await ensureDir0700(dirname(resolve(target)));
  if (!existsSync(target)) {
    await writeAtomic(target, "", { mode: FILE_MODE });
    try {
      chmodSync(target, FILE_MODE);
    // Why: best-effort — chmod failure must not block outbox creation.
    } catch {}
    await fsyncDir(dirname(resolve(target)));
  }
  return target;
}

async function withDb<T>(meshRoot: string | undefined, fn: (db: SqliteDb) => T): Promise<T> {
  const db = await openOutbox(meshRoot);
  try {
    return fn(db);
  } finally {
    try {
      db.close();
    // Why: best-effort — DB close failure must not block the withDb wrapper.
    } catch {}
  }
}

/** Enqueue one canonical row. ONE_MB guard runs before any transaction. */
export async function enqueue(input: EnqueueInput, meshRoot?: string): Promise<string> {
  sanitizeSessionId(input.target_session);
  sanitizeSessionId(input.from_session);
  assertSendable(input.text);
  await ensureOutbox(meshRoot);
  const id = input.id ?? newMessageId();
  const now = Date.now();
  try {
    return await withDb(meshRoot, (db) => {
      // Why: idempotency lookup: envelope id already present → duplicate no-op.
      if (input.id) {
        const dup = db.prepare(`SELECT id FROM outbox WHERE id = ?`).get(input.id) as unknown as { id?: string } | undefined;
        if (dup?.id === input.id) return input.id;
      }
      // Why: depth cap: overflow rejects newest with STORAGE_FULL, never silent drop.
      const depth = db
        .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE target_session = ? AND delivered_at IS NULL`)
        .get(input.target_session) as unknown as { n: number };
      if (Number(depth?.n ?? 0) >= OUTBOX_DEPTH_CAP)
        throw new MeshError("STORAGE_FULL", `outbox depth cap: ${input.target_session} holds ${OUTBOX_DEPTH_CAP}, newest rejected`);
      try {
        db.prepare(
          `INSERT INTO outbox(id,target_session,from_session,from_agent,text,created_at,broadcast_id,silent,sender_build) VALUES(?,?,?,?,?,?,?,?,?)`
        ).run(id, input.target_session, input.from_session, input.from_agent, input.text, now, input.broadcast_id ?? null, input.silent === true ? 1 : 0, BUILD_STAMP);
      } catch (err) {
        // Lost insert race under the UNIQUE(id) key: re-lookup decides.
        if (/constraint|unique/i.test(String((err as Error)?.message ?? err))) {
          const raced = db.prepare(`SELECT id FROM outbox WHERE id = ?`).get(id) as unknown as { id?: string } | undefined;
          if (raced?.id === id) return id;
        }
        throw storageError(err);
      }
      return id;
    });
  } catch (err) {
    throw storageError(err);
  }
}

/**
 * Atomically claim the oldest unclaimed undelivered row per target session.
 * Lost race returns [] (fail-closed, never throws). Limit bounds rows per target.
 */
export async function claim(
  targetSessions: string[],
  owner: string,
  limitPerTarget = 1,
  meshRoot?: string
): Promise<OutboxRow[]> {
  const ids = [...new Set(targetSessions)];
  for (const id of ids) sanitizeSessionId(id);
  if (ids.length === 0 || limitPerTarget < 1) return [];
  await ensureOutbox(meshRoot);
  try {
    return await withDb(meshRoot, (db) => {
      const claimed: OutboxRow[] = [];
      const pick = db.prepare(
        `SELECT * FROM outbox WHERE target_session = ? AND claimed_by IS NULL AND delivered_at IS NULL AND fail_reason IS NULL ORDER BY seq ASC LIMIT ?`
      );
      const take = db.prepare(
        `UPDATE outbox SET claimed_by = ?, claimed_at = ? WHERE id = ? AND claimed_by IS NULL AND delivered_at IS NULL AND fail_reason IS NULL`
      );
      for (const target of ids) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const rows = pick.all(target, limitPerTarget) as unknown as OutboxRow[];
          for (const row of rows) {
            const at = Date.now();
            const res = take.run(owner, at, row.id);
            if (Number(res.changes) === 1) claimed.push({ ...row, claimed_by: owner, claimed_at: at });
          }
          db.exec("COMMIT");
        } catch {
          try {
            db.exec("ROLLBACK");
          } catch {}
        }
      }
      return claimed;
    });
  } catch (err) {
    if (isUnavailable(err)) return [];
    throw err;
  }
}

/** Ack delivery. Only the owning claimer affects the row; foreign owner affects zero. */
export async function ack(id: string, owner: string, meshRoot?: string): Promise<boolean> {
  await ensureOutbox(meshRoot);
  try {
    return await withDb(meshRoot, (db) => {
      const res = db.prepare(`UPDATE outbox SET delivered_at = ? WHERE id = ? AND claimed_by = ?`).run(Date.now(), id, owner);
      return Number(res.changes) === 1;
    });
  } catch (err) {
    if (isUnavailable(err)) return false;
    throw err;
  }
}

/** Release a claim for redelivery. Only the owning claimer affects the row. */
export async function release(id: string, owner: string, meshRoot?: string): Promise<boolean> {
  await ensureOutbox(meshRoot);
  try {
    return await withDb(meshRoot, (db) => {
      const res = db
        .prepare(`UPDATE outbox SET claimed_by = NULL, claimed_at = NULL, attempts = attempts + 1 WHERE id = ? AND claimed_by = ?`)
        .run(id, owner);
      return Number(res.changes) === 1;
    });
  } catch (err) {
    if (isUnavailable(err)) return false;
    throw err;
  }
}

/** Closed failure vocabulary; marked via fail_reason, never delivered_at. */
export type OutboxFailReason =
  | "clientless-no-route"
  | "receiver-unresolvable"
  | "max-attempts"
  | `direct-terminal-${number}`;

/**
 * Terminalize one row under the owner guard; claim exclusion is absolute.
 * Miss columns stay NULL when detail is omitted; failed writes change nothing.
 */
export async function failRow(
  id: string,
  owner: string,
  reason: OutboxFailReason,
  detail?: { layer: MissLayer; missReason: MissReason },
  meshRoot?: string
): Promise<boolean> {
  await ensureOutbox(meshRoot);
  try {
    return await withDb(meshRoot, (db) => {
      const res = db
        .prepare(
          `UPDATE outbox SET claimed_by = NULL, claimed_at = NULL, attempts = ?, fail_reason = ?, miss_layer = ?, miss_reason = ?, build = ? WHERE id = ? AND claimed_by = ?`
        )
        .run(
          OUTBOX_MAX_ATTEMPTS,
          reason,
          detail?.layer ?? null,
          detail?.missReason ?? null,
          BUILD_STAMP,
          id,
          owner
        );
      return Number(res.changes) === 1;
    });
  } catch (err) {
    if (isUnavailable(err)) return false;
    throw storageError(err);
  }
}

/** Crash recovery: release claims older than the timeout; fresh claims stay held. */
export async function requeueStale(timeoutMs: number = OUTBOX_CLAIM_TIMEOUT_MS, meshRoot?: string): Promise<number> {
  await ensureOutbox(meshRoot);
  try {
    return await withDb(meshRoot, (db) => {
      const res = db
        .prepare(
          `UPDATE outbox SET claimed_by = NULL, claimed_at = NULL, attempts = attempts + 1 WHERE claimed_by IS NOT NULL AND delivered_at IS NULL AND attempts < ? AND claimed_at < ?`
        )
        .run(OUTBOX_MAX_ATTEMPTS, Date.now() - timeoutMs);
      return Number(res.changes);
    });
  } catch (err) {
    if (isUnavailable(err)) return 0;
    throw err;
  }
}

/** Dispose path: release every unacked claim held by one owner only. */
export async function releaseOwner(owner: string, meshRoot?: string): Promise<number> {
  await ensureOutbox(meshRoot);
  try {
    return await withDb(meshRoot, (db) => {
      const res = db
        .prepare(`UPDATE outbox SET claimed_by = NULL, claimed_at = NULL, attempts = attempts + 1 WHERE claimed_by = ? AND delivered_at IS NULL`)
        .run(owner);
      return Number(res.changes);
    });
  } catch (err) {
    if (isUnavailable(err)) return 0;
    throw err;
  }
}

/** Count undelivered rows waiting for the given sessions (harness probe, no claim). */
export async function pendingCount(targetSessions: string[], meshRoot?: string): Promise<number> {
  const ids = [...new Set(targetSessions)];
  for (const id of ids) sanitizeSessionId(id);
  if (ids.length === 0) return 0;
  await ensureOutbox(meshRoot);
  try {
    return await withDb(meshRoot, (db) => {
      const q = `SELECT COUNT(*) AS n FROM outbox WHERE target_session IN (${ids.map(() => "?").join(",")}) AND delivered_at IS NULL AND fail_reason IS NULL`;
      const row = db.prepare(q).get(...ids) as unknown as { n: number };
      return Number(row?.n ?? 0);
    });
  } catch (err) {
    if (isUnavailable(err)) return 0;
    throw err;
  }
}

/** Terminal-aware receipt for one delivery (state vocabulary owned by receiptById below). */
export interface OutboxReceipt {
  id: string;
  state: "queued" | "injected-progressing" | "failed-permanent" | "dead-lettered";
  reason?: string;
  target_session?: string;
  attempts?: number;
  /** Generation that enqueued the row. Present only on the `failed-permanent` branch for a stored terminal row (absent-tolerant read of `sender_build`); other branches omit it. */
  senderBuild?: string;
  /** Generation that terminalized the row. Present only on the `failed-permanent` branch for a stored terminal row; other branches omit it. */
  build?: string;
  /** Terminal miss layer from the resolver trail. Present only on the `failed-permanent` branch for a stored terminal row whose terminalizer knew it; other branches omit it. */
  missLayer?: string;
  /** Terminal miss reason from the resolver trail. Present only on the `failed-permanent` branch for a stored terminal row whose terminalizer knew it; other branches omit it. */
  missReason?: string;
}
/**
 * Receipt lookup for one delivery; read-only, never mutates rows.
 * @param id Receipt id returned at send time.
 */
export async function receiptById(id: string, meshRoot?: string): Promise<OutboxReceipt> {
  await ensureOutbox(meshRoot);
  try {
    return await withDb(meshRoot, (db) => {
      const row = db.prepare(`SELECT * FROM outbox WHERE id = ?`).get(id) as unknown as (OutboxRow & { fail_reason?: unknown }) | undefined;
      if (!row) return { id, state: "failed-permanent", reason: "unknown-receipt" };
      // Absent-tolerant: pre-migration rows read NULL, omitting keys exactly
      // like the silent precedent; unknown miss strings pass through.
      const opt = row as unknown as Record<string, unknown>;
      const senderBuild = typeof opt.sender_build === "string" && opt.sender_build.length > 0 ? (opt.sender_build as string) : undefined;
      const build = typeof opt.build === "string" && opt.build.length > 0 ? (opt.build as string) : undefined;
      const missLayer = typeof opt.miss_layer === "string" && opt.miss_layer.length > 0 ? (opt.miss_layer as string) : undefined;
      const missReason = typeof opt.miss_reason === "string" && opt.miss_reason.length > 0 ? (opt.miss_reason as string) : undefined;
      const failReason = (row as { fail_reason?: unknown }).fail_reason;
      if (typeof failReason === "string" && failReason.length > 0)
        return {
          id,
          state: "failed-permanent",
          reason: failReason,
          target_session: row.target_session,
          attempts: row.attempts,
          ...(senderBuild !== undefined ? { senderBuild } : {}),
          ...(build !== undefined ? { build } : {}),
          ...(missLayer !== undefined ? { missLayer } : {}),
          ...(missReason !== undefined ? { missReason } : {}),
        };
      if (row.delivered_at !== null) return { id, state: "injected-progressing", target_session: row.target_session, attempts: row.attempts };
      if (row.attempts >= OUTBOX_MAX_ATTEMPTS && row.created_at < Date.now() - OUTBOX_TTL_MS)
        return { id, state: "dead-lettered", reason: "max-attempts", target_session: row.target_session, attempts: row.attempts };
      if (row.claimed_by !== null) return { id, state: "injected-progressing", target_session: row.target_session, attempts: row.attempts };
      return { id, state: "queued", target_session: row.target_session, attempts: row.attempts };
    });
  } catch (err) {
    if (isUnavailable(err)) return { id, state: "failed-permanent", reason: "storage-unavailable" };
    throw err;
  }
}

/** GC collection: delete delivered past TTL plus dead-letter rows; VACUUM past threshold. */
export async function collectOutbox(now: number, ttlMs: number, maxAttempts: number, meshRoot?: string): Promise<{ deleted: number; deadLetter: number }> {
  await ensureOutbox(meshRoot);
  try {
    return await withDb(meshRoot, (db) => {
      const dead = db
        .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NULL AND attempts >= ? AND created_at < ?`)
        .get(maxAttempts, now - ttlMs) as unknown as { n: number };
      const deadLetter = Number(dead?.n ?? 0);
      const res = db
        .prepare(
          `DELETE FROM outbox WHERE (delivered_at IS NOT NULL AND delivered_at < ?) OR (delivered_at IS NULL AND attempts >= ? AND created_at < ?)`
        )
        .run(now - ttlMs, maxAttempts, now - ttlMs);
      const deleted = Number(res.changes);
      // Why: VACUUM conditional on the freed-pages threshold (single GC owns it).
      if (deleted > 0) {
        try {
          const free = db.prepare(`PRAGMA freelist_count`).get() as unknown as { freelist_count?: number } | undefined;
          if (Number(free?.freelist_count ?? 0) >= OUTBOX_VACUUM_MIN_PAGES) db.exec("VACUUM");
        } catch {}
      }
      return { deleted, deadLetter };
    });
  } catch (err) {
    if (isUnavailable(err)) return { deleted: 0, deadLetter: 0 };
    throw err;
  }
}
