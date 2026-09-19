// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Garbage collection for stale registry plus the inbox drain owned here.
import { execFile } from "node:child_process";
import { readdir, rm, rmdir, stat, unlink, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { LEGACY_OWNER_TTL_MS, STALE_TTL_MS, OUTBOX_TTL_MS, OUTBOX_MAX_ATTEMPTS } from "./constants.js";
import { ensureDir0700 } from "./fsAtomic.js";
import { atomicUpdateRegistry, fetchSinglePortStatusMap, pruneDeadByStatus, pruneStale } from "./registry.js";
import { resolveMeshRoot, resolveOutboxPath, resolveRegistryPath } from "./xdg.js";

const pExecFile = promisify(execFile);

// trash owns user-data deletes (durability contract; same pattern as src/install/stow.ts).
// Trash runs first for recoverability; when both trash binaries are absent or throw,
// removePathFallback deletes via filesystem recursive force. Outbox/token artifacts regenerate safely.
// Why: best-effort, trash-less hosts (CI ubuntu runner) must still delete;
// the outer GC sweep already swallows all errors, so this helper never throws.
async function removePathFallback(p: string): Promise<void> {
  try {
    await rm(p, { recursive: true, force: true });
  } catch {}
}

async function trashPath(p: string): Promise<void> {
  try {
    await pExecFile("trash", [p]);
    return;
  } catch {}
  try {
    await pExecFile("/usr/bin/trash", [p]);
    return;
  } catch {}
  await removePathFallback(p);
}

// Why: owner age lives in constants beside the other TTLs; the inbox drain below owns removal.
const OWNER_TTL_MS = LEGACY_OWNER_TTL_MS;

export interface GcResult {
  prunedRegistry: number;
  prunedInbox: number;
  prunedAudit: number;
  prunedLive: number;
  prunedOutbox: number;
  deadLetterOutbox?: number;
  liveSkipped?: string;
}

async function trashOldInbox(): Promise<number> {
  let pruned = 0;
  try {
    const root = resolveMeshRoot();
    const inboxRoot = resolve(root, "inbox");
    const ents = await readdir(inboxRoot).catch(() => [] as string[]);
    for (const id of ents) {
      const dir = join(inboxRoot, id);
      const st = await stat(dir).catch(() => null);
      if (!st?.isDirectory()) continue;
      const files = await readdir(dir).catch(() => [] as string[]);
      for (const f of files) {
        const p = join(dir, f);
        const s = await stat(p).catch(() => null);
        if (!s) continue;
        const age = Date.now() - s.mtimeMs;
        const ownerFile = ".owner";
        const replySuffix = ".reply.json";
        if (f === ownerFile && age > OWNER_TTL_MS) {
          await unlink(p).catch(() => {});
          pruned++;
        } else if ((f.endsWith(".json") || f.endsWith(replySuffix)) && age > STALE_TTL_MS) {
          await unlink(p).catch(() => {});
          pruned++;
        }
      }
      const remain = await readdir(dir).catch(() => [] as string[]);
      if (remain.length === 0) await rmdir(dir).catch(() => {});
    }
    await trashPath(resolve(root, "outbox"));
    await trashPath(resolve(root, "token"));
  // Why: best-effort — inbox cleanup failure must not halt the GC sweep.
  } catch {}
  return pruned;
}

/**
 * Nightly sweep for stale registry plus inbox drain plus outbox TTL.
 * One sweep owns every time delete so storage stays bounded.
 */
export async function runGc(meshRoot?: string): Promise<GcResult> {
  const root = meshRoot ?? resolveMeshRoot();
  await ensureDir0700(root);
  let prunedRegistry = 0;
  let prunedInbox = 0;
  let prunedOutbox = 0;
  let deadLetterOutbox = 0;
  try {
    // candidate snapshot is read-only; deletion re-validates each id
    // against live data inside the writer. A concurrent join or refresh
    // between the two can neither be deleted nor misreported.
    const { readFile } = await import("node:fs/promises");
    let candidates: string[] = [];
    try {
      const raw = JSON.parse(await readFile(resolveRegistryPath(meshRoot), "utf8")) as unknown as Record<string, unknown> & {
        version?: number;
        entries?: Record<string, { updatedAt: number }>;
      };
      const regEntries = raw.version === 1 && raw.entries ? (raw.entries as Record<string, { updatedAt: number }>) : (raw as Record<string, { updatedAt: number }>);
      const kept = pruneStale(regEntries as unknown as Parameters<typeof pruneStale>[0]);
      candidates = Object.keys(regEntries).filter((k) => !(k in kept));
    } catch {
      candidates = [];
    }
    let prunedCount = 0;
    if (candidates.length > 0) {
      await atomicUpdateRegistry((reg) => {
        // write persists the pruned live view, which drops the
        // stale candidates on its own. Counting only: absent means pruned
        // here or concurrently gone elsewhere, both leave the store clean.
        for (const k of candidates) if (!((reg as Record<string, unknown>)[k])) prunedCount++;
      }, meshRoot);
    }
    prunedRegistry = prunedCount;
  // Why: best-effort — registry read failure must not block the GC sweep.
  } catch {}
  let prunedLive = 0;
  let liveSkipped: string | undefined;
  try {
    const statusMap = await fetchSinglePortStatusMap();
    if (statusMap) {
      await atomicUpdateRegistry((reg) => {
        prunedLive = pruneDeadByStatus(reg, statusMap);
      }, meshRoot);
    } else {
      liveSkipped = "no-single-port-view";
    }
  } catch {
    liveSkipped = "no-single-port-view";
  }
  prunedInbox = await trashOldInbox();
  try {
    const outboxPath = resolveOutboxPath(meshRoot);
    let headerOk = true;
    try {
      const fh = await open(outboxPath, "r").catch(() => null);
      if (fh) {
        try {
          const buf = Buffer.alloc(16);
          const { bytesRead } = await fh.read(buf, 0, 16, 0);
          if (bytesRead === 16 && buf.toString("utf8", 0, 6) !== "SQLite") headerOk = false;
        } finally {
          await fh.close().catch(() => {});
        }
      }
    } catch {
      headerOk = true;
    }
    if (!headerOk) {
      await trashPath(outboxPath);
    } else {
      const { collectOutbox } = await import("./outbox.js");
      const now = Date.now();
      const collected = await collectOutbox(now, OUTBOX_TTL_MS, OUTBOX_MAX_ATTEMPTS, meshRoot);
      prunedOutbox = collected.deleted;
      deadLetterOutbox = collected.deadLetter;
    }
  // Why: best-effort — outbox VACUUM or collection failure must not block the GC sweep.
  } catch {}
  return { prunedRegistry, prunedInbox, prunedAudit: 0, prunedLive, prunedOutbox, deadLetterOutbox, liveSkipped };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  runGc()
    .then((r) => console.log(JSON.stringify(r)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
