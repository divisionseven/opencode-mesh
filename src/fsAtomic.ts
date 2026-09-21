// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Atomic writes, registry-only lock.
import { constants as fsConstants, statSync, unlinkSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DIR_MODE, FILE_MODE, LOCK_STALE_MS } from './constants.js';
import { resolveRegistryPath } from './xdg.js';

/** Contention jitter: random 50-149ms spreads herd retries, avoiding livelock. */
export function jitterMs(): number {
  return 50 + Math.floor(Math.random() * 100);
}

/** True when the error signals exhausted disk; no-space never retries as contention. */
export function isNoSpace(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException;
  return e?.code === 'ENOSPC' || e?.errno === 28 || e?.errno === 27;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Unique temp name beside target; pid plus random avoids writer collision. */
export function tmpName(base: string): string {
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${base}.${process.pid}.${rand}.tmp`;
}

/** Fsync directory so renames survive crashes; failures never throw. */
export async function fsyncDir(dir: string): Promise<void> {
  try {
    const fd = await open(dir, 'r');
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  // Why: best-effort — fsync failure must not block the atomic write.
  } catch {}
}

/** Ensure dir exists 0700 from creation; secrets never widen. */
export async function ensureDir0700(dir: string): Promise<void> {
  const prev = process.umask(0o077);
  try {
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await fsyncDir(dir);
    try {
      await chmod(dir, DIR_MODE);
    // Why: best-effort — chmod failure must not block directory creation.
    } catch {}
  } finally {
    process.umask(prev);
  }
}

// Registry-only RMW lock; messages stay lock-free direct POST.
// Contention reaps dead holders plus old files; decider re-verifies.
function parseStamp(content: string): { pid: number; at: number } | null {
  const text = content.trim();
  const sep = text.indexOf(':');
  if (sep <= 0) return null;
  const pid = Number(text.slice(0, sep));
  const at = Number(text.slice(sep + 1));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(at) || at <= 0) return null;
  return { pid, at };
}

type PidLiveness = 'dead' | 'alive' | 'unproven';

function checkPid(pid: number): PidLiveness {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    // EINVAL plus unknown kill failures read unproven; age decides.
    return 'unproven';
  }
}

async function decideReap(lockPath: string): Promise<{ reap: boolean; content: string }> {
  let content = '';
  let ageMs = 0;
  try {
    content = await readFile(lockPath, 'utf8');
    const st = await stat(lockPath);
    ageMs = Date.now() - st.mtimeMs;
  } catch {
    return { reap: false, content };
  }
  const parsed = parseStamp(content);
  if (parsed && parsed.pid !== process.pid) {
    const live = checkPid(parsed.pid);
    if (live === 'dead') return { reap: true, content };
    if (live === 'unproven') return { reap: ageMs > LOCK_STALE_MS, content };
    // Live past triple bound still reaps; OS recycles pids, numbers never prove holder.
    return { reap: ageMs > 3 * LOCK_STALE_MS, content };
  }
  // Unparsable content (legacy 0-byte files, torn writes, garbage, zero or
  // negative pids) plus own pid take the age branch.
  return { reap: ageMs > LOCK_STALE_MS, content };
}

async function reapVerified(lockPath: string, decided: string): Promise<boolean> {
  let current: string;
  try {
    current = await readFile(lockPath, 'utf8');
  } catch {
    return false;
  }
  if (current !== decided) return false;
  try {
    await unlink(lockPath);
    return true;
  } catch (err) {
    // ENOENT reads as contention; peer won race or holder released.
    // Other unlink errors retry via sleep, never surface.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return false;
    return false;
  }
}

/**
 * Registry-only RMW lock; O_EXCL create plus jitter retries own contention.
 * Crash-safe exclusion for single-writer updates.
 */
export async function withRegistryLock<T>(fn: () => Promise<T>, meshRoot?: string): Promise<T> {
  const lockPath = `${resolveRegistryPath(meshRoot)}.lock`;
  await ensureDir0700(dirname(lockPath));
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    while (fh === null) {
      try {
        fh = await open(
          lockPath,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          FILE_MODE
        );
      } catch (err) {
        if (isNoSpace(err)) throw err;
        lastErr = err;
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'EEXIST') throw err;
        const decided = await decideReap(lockPath);
        if (decided.reap && (await reapVerified(lockPath, decided.content))) continue;
        break;
      }
    }
    if (fh === null) {
      if (attempt === 2) break;
      await sleep(jitterMs());
      continue;
    }
    const stamp = `${process.pid}:${Date.now()}`;
    try {
      await fh.writeFile(stamp, 'utf8');
      await fh.sync();
    } catch (stampErr) {
      try {
        await fh.close();
      // Why: best-effort — file handle close failure must not block error recovery.
      } catch {}
      try {
        await unlink(lockPath);
      // Why: best-effort — lock file cleanup failure must not block error recovery.
      } catch {}
      throw stampErr;
    }
    try {
      return await fn();
    } finally {
      try {
        await fh.close();
      // Why: best-effort — file handle close failure must not block the registry lock.
      } catch {}
      try {
        const current = await readFile(lockPath, 'utf8');
        if (current === stamp) await unlink(lockPath);
      // Why: best-effort — stamp verification failure must not block the registry lock.
      } catch {}
    }
  }
  throw lastErr;
}

/** True for EEXIST only; contention retries, real errors throw. */
export function isLockContention(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException;
  return e?.code === 'EEXIST';
}

/** Crash-safe write via temp plus fsync plus rename; readers never see tears. */
export async function writeAtomic(
  targetPath: string,
  data: string,
  opts?: { mode?: number }
): Promise<void> {
  const mode =
    opts?.mode ??
    (() => {
      try {
        return statSync(targetPath).mode & 0o777;
      } catch {
        return FILE_MODE;
      }
    })();
  const dir = dirname(resolve(targetPath));
  await ensureDir0700(dir);
  const base = targetPath.split('/').pop() ?? 'file';
  const tmp = resolve(dir, tmpName(base));
  const fh = await open(tmp, 'w', mode);
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
    await fh.chmod(mode);
  } catch (e) {
    try {
      await fh.close();
    // Why: best-effort — file handle close failure must not block error recovery.
    } catch {}
    try {
      unlinkSync(tmp);
    // Why: best-effort — temp file cleanup failure must not block the error path.
    } catch {}
    throw e;
  }
  await fh.close();
  try {
    await rename(tmp, targetPath);
    await fsyncDir(dir);
  } catch (e) {
    try {
      unlinkSync(tmp);
    // Why: best-effort — temp file cleanup failure must not block the error path.
    } catch {}
    throw e;
  }
}
