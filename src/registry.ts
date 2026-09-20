// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Mesh registry with STALE_TTL pruning and flock-guarded writes.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_OPENCODE_PORT, FILE_MODE, LOCK_OUTER_ROUNDS, OPENCODE_PORT, ROUTE_PROBE_TIMEOUT_MS, STALE_TTL_MS, EVICT_GRACE_MS } from "./constants.js";
import { getServerAuthHeaderSync } from "./serverAuth.js";
import { ensureDir0700, writeAtomic } from "./fsAtomic.js";
import { MeshError } from "./errors.js";
import { BUILD_STAMP } from "./version.js";
import { resolveMeshRoot, resolveRegistryPath } from "./xdg.js";

/** Single peer entry in the mesh registry. */
export interface RegistryEntry {
  sessionId: string;
  agent: string;
  title?: string;
  description?: string;
  directory?: string;
  cwd?: string;
  summary?: string;
  model?: string;
  updatedAt: number;
  migratedAt?: number;
  /** Attach tier: true while an oracle (ps plus guarded status) lists the id. Optional so old rows parse. */
  attached?: boolean;
  /** Last oracle observation of attachment (epoch ms). Drives the ps-gone grace. */
  attachedAt?: number;
  /** Focus state is unknown from every oracle; the marker documents that, never a focus value. */
  focus?: string;
  /** Last action (tool use, session event, or message leg) as epoch ms. Backward jumps clamp to max. */
  lastActionAt?: number;
  /** Session type driving per-type TTLs: primary (parent_id NULL) or subagent. Absent reads primary. */
  sessionType?: string;
  /** Per-agent override tag naming the TTL class applied at delete time (audit taxonomy). */
  ttlOverrideTag?: string;
}

/** Normalize entry aliases: description↔summary, cwd↔directory, repo derived, title fallback. */
export function normalizeEntry(entry: RegistryEntry): RegistryEntry {
  const e = { ...entry } as unknown as Record<string, unknown>;
  // legacy daemon key stripped — never persisted for new rows
  if ("daemon" in e) delete e.daemon;
  // repo computed via basename(directory) — keep for compat but derived if missing
  if (!e.repo && (e.directory || e.cwd)) e.repo = ((e.directory || e.cwd) as string).split("/").pop() || undefined;
  // summary/cwd are read-alias only for legacy rows — synthesize if missing
  const desc = e.description as string | undefined;
  const summ = e.summary as string | undefined;
  if (!desc && summ) e.description = summ;
  if (!summ && desc) e.summary = desc;
  const dir = e.directory as string | undefined;
  const cwd = e.cwd as string | undefined;
  if (!cwd && dir) e.cwd = dir;
  if (!dir && cwd) e.directory = cwd;
  // directory never '' — delete if empty or not absolute
  const d = e.directory as string | undefined;
  if (typeof d === "string" && (d.length === 0 || !d.startsWith("/"))) {
    delete e.directory;
    delete e.cwd;
  }
  const t = e.title as string | undefined;
  const d2 = e.description as string | undefined;
  if (!t && d2) e.title = d2;
  // Why: serve columns deleted as trusted route state — strip on sight, valid or
  // not. Loopback pin owns routing; enumeration owns multi-instance discovery.
  if ("serveUrl" in e) delete e.serveUrl;
  if ("servePort" in e) delete e.servePort;
  // Display-only rank keys are wire-only: strip on sight, never persisted.
  for (const k of ["attachedRank", "dirRank", "agentRank", "recencyRank", "titleRank", "rank"]) {
    if (k in e) delete e[k];
  }
  return e as unknown as RegistryEntry;
}
/** Registry maps sessionId → peer metadata. */
export type Registry = Record<string, RegistryEntry>;

/** Re-exported stale TTL for consumers (canonical in constants.ts). */
export { STALE_TTL_MS } from "./constants.js";

// In-process mutex to serialize registry writes; combined with fs flock for cross-process safety.
let registryChain: Promise<void> = Promise.resolve();
function withRegistryChain<T>(fn: () => Promise<T>): Promise<T> {
  const p = registryChain.then(fn, fn);
  registryChain = p.then(
    () => {},
    () => {}
  );
  return p;
}

/** Atomic RMW holding registryChain across read→mutate→write (prevents heartbeat lost-update). */
export async function atomicUpdateRegistry(fn: (reg: Registry) => void | Promise<void>, meshRoot?: string): Promise<void> {
  await withRegistryChain(async () => {
    // Herd armor: inner lock throws EEXIST under burst; bounded jitter retries.
    // Exhaustion rethrows, never half-writes; outer bound owns bursts.
    let lastErr: unknown = null;
    for (let round = 0; round < LOCK_OUTER_ROUNDS; round++) {
      try {
        await writeUnderLock(fn, meshRoot);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
        lastErr = err;
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 200));
      }
    }
    throw lastErr;
  });
}

async function writeUnderLock(fn: (reg: Registry) => void | Promise<void>, meshRoot?: string): Promise<void> {
  const mod = await import("./fsAtomic.js");
  await mod.withRegistryLock(async () => {
    // Why: corrupt-then-wipe guard. A present but unparseable store fails
    // loud before any mutation persists. Missing files still write fresh.
    const target = resolveRegistryPath(meshRoot);
    let raw: string | null = null;
    try {
      raw = await readFile(target, "utf8");
    } catch {
      raw = null;
    }
    if (raw !== null) {
      try {
        JSON.parse(raw);
      } catch {
        throw new MeshError("STORAGE_CORRUPT", `registry unreadable, refusing write: ${target}`);
      }
    }
    const reg = await readRegistry(meshRoot);
    await fn(reg);
    for (const [k, v] of Object.entries(reg)) reg[k] = normalizeEntry(v as RegistryEntry);
    const pruned = pruneStale(reg);
    const root = meshRoot ?? resolveMeshRoot();
    await ensureDir0700(resolve(target, "..") === root ? root : resolve(target, ".."));
    // migratedAt set once on migration, not on every heartbeat — preserve existing
    let existingMigratedAt: number | undefined;
    try {
      const rawData = await readFile(target, "utf8");
      const rawDoc = JSON.parse(rawData) as { migratedAt?: number; version?: number };
      if (rawDoc && typeof rawDoc.migratedAt === "number") existingMigratedAt = rawDoc.migratedAt;
    // Why: best-effort — registry read or parse failure must not block the session.
    } catch {}
    const doc = {
      version: 1 as const,
      entries: pruned,
      migratedAt: existingMigratedAt ?? Date.now(),
    };
    await writeAtomic(target, JSON.stringify(doc, null, 2), {
      mode: FILE_MODE,
    });
  }, meshRoot);
}

/** Read registry from the mesh root. */
export async function readRegistry(meshRoot?: string): Promise<Registry> {
  const target = resolveRegistryPath(meshRoot);
  let data: string | null = null;
  try {
    data = await readFile(target, "utf8");
  } catch {
    data = null;
  }
  let parsed: Registry = {};
  if (data) {
    try {
      const raw = JSON.parse(data) as unknown as Registry & {
        version?: number;
        entries?: Registry;
      };
      if (raw && typeof raw.version === "number" && raw.version === 1 && raw.entries) {
        parsed = raw.entries as Registry;
      } else {
        parsed = raw as Registry;
      }
    } catch {
      parsed = {};
    }
  }
  for (const [k, v] of Object.entries(parsed)) parsed[k] = normalizeEntry(v as RegistryEntry);
  return pruneStale(parsed);
}

/** Heartbeat — update updatedAt for sessionId and persist. */
export async function heartbeat(sessionId: string, meshRoot?: string): Promise<void> {
  await atomicUpdateRegistry((reg) => {
    if (reg[sessionId]) reg[sessionId].updatedAt = Date.now();
  }, meshRoot);
}

/** Drop entries older than STALE_TTL_MS. */
export function pruneStale(registry: Registry, now = Date.now()): Registry {
  const out: Registry = {};
  for (const [k, v] of Object.entries(registry)) {
    if (now - v.updatedAt <= STALE_TTL_MS) out[k] = v;
  }
  return out;
}

/**
 * Unwrap data-wrapped or raw status payloads; null on other shapes, deletes zero.
 */
export function unwrapStatusMap(raw: unknown): Record<string, { type: string }> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const maybe = raw as Record<string, unknown>;
    if (maybe.data && typeof maybe.data === "object") return maybe.data as Record<string, { type: string }>;
    return raw as Record<string, { type: string }>;
  }
  return null;
}

/** Fetch live status; null on failure, unwraps data wrapper via unwrapStatusMap. */
export async function fetchSessionStatusMap(port: number = OPENCODE_PORT): Promise<Record<string, { type: string }> | null> {
  try {
    const auth = getServerAuthHeaderSync();
    const headers: Record<string, string> = {};
    if (auth) headers.Authorization = auth;
    const res = await fetch(`http://127.0.0.1:${port}/session/status`, { headers, signal: AbortSignal.timeout(ROUTE_PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const raw = (await res.json()) as unknown;
    return unwrapStatusMap(raw);
  } catch {
    return null;
  }
}

/** Single-port guard: live map when one port answers, null on split or empty. */
export async function fetchSinglePortStatusMap(): Promise<Record<string, { type: string }> | null> {
  const primary = await fetchSessionStatusMap(OPENCODE_PORT);
  if (OPENCODE_PORT === DEFAULT_OPENCODE_PORT) return primary && Object.keys(primary).length > 0 ? primary : null;
  const fallback = await fetchSessionStatusMap(DEFAULT_OPENCODE_PORT);
  const pKeys = primary ? Object.keys(primary) : [];
  const fKeys = fallback ? Object.keys(fallback) : [];
  if (pKeys.length > 0 && fKeys.length > 0 && pKeys.some((k) => !fKeys.includes(k)) && fKeys.some((k) => !pKeys.includes(k))) return null;
  if (pKeys.length > 0) return primary;
  if (fKeys.length > 0) return fallback;
  return null;
}

/**
 * Delete ids absent from status view; null or young ids delete zero.
 */
export function pruneDeadByStatus(registry: Registry, statusMap: Record<string, { type: string }> | null, now = Date.now()): number {
  if (!statusMap || Object.keys(statusMap).length === 0) return 0;
  let n = 0;
  for (const [id, e] of Object.entries(registry)) {
    if (!(id in statusMap) && now - e.updatedAt > EVICT_GRACE_MS) {
      delete registry[id];
      n++;
    }
  }
  return n;
}

/** Delete audit to audit.log; twin writer with appendDeliveryAudit, separate vocabularies. */
export async function appendDeleteAudit(reason: string, ids: string[], meshRoot?: string): Promise<void> {
  if (ids.length === 0) return;
  try {
    const { appendFile, chmod } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const root = meshRoot ?? resolveMeshRoot();
    const target = resolve(root, "audit.log");
    const now = Date.now();
    const lines = ids.map((id) => JSON.stringify({ at: now, reason, id }) + "\n").join("");
    try {
      await appendFile(target, lines, { mode: FILE_MODE });
    } catch {
      await appendFile(target, lines);
    }
    try {
      await chmod(target, FILE_MODE);
    // Why: best-effort — chmod failure must not block the delete audit.
    } catch {}
  // Why: best-effort — audit write failure must not block the registry operation.
  } catch {}
}

/**
 * Closed delivery vocabulary to audit.log; claimed reserved never emitted.
 * Zero-extra-I/O holds by not emitting claimed.
 */
export type DeliveryAuditEvent = "outbox.claimed" | "outbox.injected" | "outbox.claim-deferred" | "outbox.claim-terminal";

/** Best-effort delivery audit: one JSON line per event to `<meshRoot>/audit.log`. Never throws. */
export async function appendDeliveryAudit(
  event: DeliveryAuditEvent,
  detail: Record<string, unknown>,
  meshRoot?: string
): Promise<void> {
  try {
    const { appendFile, chmod } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const root = meshRoot ?? resolveMeshRoot();
    const target = resolve(root, "audit.log");
    const line = JSON.stringify({ at: Date.now(), event, build: BUILD_STAMP, ...detail }) + "\n";
    try {
      await appendFile(target, line, { mode: FILE_MODE });
    } catch {
      await appendFile(target, line);
    }
    try {
      await chmod(target, FILE_MODE);
    // Why: best-effort — chmod failure must not block the delivery audit.
    } catch {}
  // Why: best-effort — audit write failure must not block the delivery path.
  } catch {}
}

/** Audit-file line per init to audit.log; carries build plus version plus pid, never read by wire. */
export async function appendBootAudit(build: string, version: string, meshRoot?: string): Promise<void> {
  try {
    const { appendFile, chmod } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const root = meshRoot ?? resolveMeshRoot();
    const target = resolve(root, "audit.log");
    const line = JSON.stringify({ at: Date.now(), event: "mesh.boot", build, version, pid: process.pid }) + "\n";
    try {
      await appendFile(target, line, { mode: FILE_MODE });
    } catch {
      await appendFile(target, line);
    }
    try {
      await chmod(target, FILE_MODE);
    // Why: best-effort — chmod failure must not block the boot audit.
    } catch {}
  // Why: best-effort — audit write failure must not block the boot path.
  } catch {}
}

/** Persist confirmed-dead deletions through the single writer. No-op on null or keyless map. */
export async function persistConfirmedDead(statusMap: Record<string, { type: string }> | null, meshRoot?: string): Promise<number> {
  if (!statusMap || Object.keys(statusMap).length === 0) return 0;
  let deleted = 0;
  const deletedIds: string[] = [];
  await atomicUpdateRegistry((reg) => {
    const before = new Set(Object.keys(reg));
    deleted = pruneDeadByStatus(reg, statusMap);
    for (const id of before) if (!(id in reg)) deletedIds.push(id);
  }, meshRoot);
  await appendDeleteAudit("persist-confirmed-dead", deletedIds, meshRoot);
  return deleted;
}
