// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Crash-safe lock plus fail-closed matrix
// Covers: dead-pid plus legacy plus SIGKILL plus live-old reap; live-young plus
// young-legacy plus malformed wait; ENOENT-race; stamp cleanup; 6-writer burst;
// no-half-write; durability; per-path fail-closed matrix (hooks plus tools).
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const stampFault = vi.hoisted(() => ({ fail: false }));
const unlinkFault = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs/promises')>();
  async function open(
    ...args: Parameters<typeof mod.open>
  ): Promise<Awaited<ReturnType<typeof mod.open>>> {
    const fh = await mod.open(...args);
    if (stampFault.fail && String(args[0]).endsWith('.lock')) {
      stampFault.fail = false;
      const rec = fh as unknown as Record<string, unknown>;
      rec.writeFile = async (): Promise<void> => {
        throw Object.assign(new Error('ENOSPC, write'), { code: 'ENOSPC', errno: 28 });
      };
    }
    return fh;
  }
  async function unlink(...args: Parameters<typeof mod.unlink>): Promise<void> {
    if (unlinkFault.fail && String(args[0]).endsWith('.lock')) {
      unlinkFault.fail = false;
      unlinkFault.calls += 1;
      throw Object.assign(new Error('ENOENT, unlink'), { code: 'ENOENT' });
    }
    return mod.unlink(...args);
  }
  return { ...mod, open, unlink };
});

async function withScratchRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'mesh-locktest-'));
  const prev = process.env.OPENCODE_MESH_ROOT;
  const prevDb = process.env.OPENCODE_MESH_DB_PATH;
  process.env.OPENCODE_MESH_ROOT = root;
  process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
  try {
    await fn(root);
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT;
    else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH;
    else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRmArmed(root);
  }
}

async function safeRm(root: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if ((code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM') && attempt < 2) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      throw err;
    }
  }
}

const DRAIN_POLL_MS = 50;
const DRAIN_BUDGET_MS = 2000;
async function safeRmArmed(root: string): Promise<void> {
  const deadline = Date.now() + DRAIN_BUDGET_MS;
  for (;;) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if ((code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
        continue;
      }
      throw err;
    }
  }
}

async function lockPathFor(root: string): Promise<string> {
  const { resolveRegistryPath } = await import('../src/xdg.js');
  return `${resolveRegistryPath(root)}.lock`;
}

async function registryPathFor(root: string): Promise<string> {
  const { resolveRegistryPath } = await import('../src/xdg.js');
  return resolveRegistryPath(root);
}

async function plantLock(root: string, content: string, ageMs?: number): Promise<string> {
  const lockPath = await lockPathFor(root);
  const { ensureDir0700 } = await import('../src/fsAtomic.js');
  await ensureDir0700(dirname(lockPath));
  await writeFile(lockPath, content, 'utf8');
  if (ageMs !== undefined) {
    const t = new Date(Date.now() - ageMs);
    await utimes(lockPath, t, t);
  }
  return lockPath;
}

async function readLock(lockPath: string): Promise<string> {
  return readFile(lockPath, 'utf8');
}

async function expectLockAbsent(root: string): Promise<void> {
  await expect(stat(await lockPathFor(root))).rejects.toThrow();
}

async function freshDeadPid(): Promise<number> {
  const proc = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await once(proc, 'exit');
  if (typeof proc.pid !== 'number') throw new Error('dead pid unavailable');
  return proc.pid;
}

function startSleeper(): ChildProcess {
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: 'ignore',
  });
  if (typeof proc.pid !== 'number') throw new Error('sleeper pid unavailable');
  return proc;
}

async function stopProc(proc: ChildProcess): Promise<void> {
  try {
    proc.kill('SIGKILL');
  } catch {}
  try {
    await once(proc, 'exit');
  } catch {}
}

async function writeEntry(root: string, id: string): Promise<void> {
  const { atomicUpdateRegistry } = await import('../src/registry.js');
  await atomicUpdateRegistry((reg: Record<string, unknown>) => {
    (reg as Record<string, Record<string, unknown>>)[id] = {
      sessionId: id,
      agent: 'tester',
      updatedAt: Date.now(),
    };
  }, root);
}

describe('crash-safe lock — reap and wait', () => {
  it('reap-dead-pid — dead holder reaps, write lands, new stamp', async () => {
    await withScratchRoot(async (root) => {
      const dead = await freshDeadPid();
      const lockPath = await plantLock(root, `${dead}:${Date.now()}`);
      await writeEntry(root, 'reaped-dead');
      const { readRegistry } = await import('../src/registry.js');
      expect((await readRegistry(root))['reaped-dead']).toBeDefined();
      const after = await readLock(lockPath).catch(() => null);
      // lock either carries the new stamp or released already; never the dead stamp
      if (after !== null) {
        expect(after).not.toBe(`${dead}:${Date.now()}`);
        expect(after.startsWith(`${process.pid}:`)).toBe(true);
      }
      const raw = JSON.parse(await readFile(await registryPathFor(root), 'utf8'));
      expect(raw.version).toBe(1);
    });
  }, 15_000);

  it('reap-zero-byte — old 0-byte legacy file reaps with zero migration', async () => {
    await withScratchRoot(async (root) => {
      const { LOCK_STALE_MS } = await import('../src/constants.js');
      await plantLock(root, '', LOCK_STALE_MS + 5000);
      await writeEntry(root, 'reaped-legacy');
      const { readRegistry } = await import('../src/registry.js');
      expect((await readRegistry(root))['reaped-legacy']).toBeDefined();
      await expectLockAbsent(root);
    });
  }, 15_000);

  it('reap-sigkill — SIGKILLed holder leaves residue the next writer clears', async () => {
    await withScratchRoot(async (root) => {
      // Why .mts: outside the package scope tsx treats .ts as CJS and
      // rejects top-level await; .mts forces ESM like vite-node did.
      const holderSrc = join(root, 'holder.mts');
      await writeFile(
        holderSrc,
        `import { withRegistryLock } from ${JSON.stringify(join(process.cwd(), 'src/fsAtomic.ts'))};\n` +
          `await withRegistryLock(async () => {\n` +
          // Why pid in READY: tsx re-spawns a child to run the file, so
          // spawn pid is the launcher; the holder reports its own pid.
          `  console.log('READY ' + process.pid);\n` +
          `  await new Promise((r) => setTimeout(r, 60000));\n` +
          `});\n`
      );
      // Why tsx: Vitest 4 removed the vite-node binary; tsx (pinned devDep)
      // runs the holder TS directly with identical semantics.
      const holder = spawn(join(process.cwd(), 'node_modules', '.bin', 'tsx'), [holderSrc], {
        cwd: process.cwd(),
        env: { ...process.env, OPENCODE_MESH_ROOT: root },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let ready = '';
      let holderPid = '';
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('holder never ready')), 20_000);
        holder.stdout?.on('data', (d: Buffer) => {
          ready += d.toString();
          const match = ready.match(/READY (\d+)/);
          if (match) {
            holderPid = match[1];
            clearTimeout(timer);
            resolve();
          }
        });
        holder.on('exit', () => reject(new Error('holder exited early')));
      });
      const lockPath = await lockPathFor(root);
      const residue = await readLock(lockPath);
      expect(residue.startsWith(`${holderPid}:`)).toBe(true);
      // Why kill reported pid: SIGKILL to the tsx launcher orphans the
      // real holder (still sleeping, lock unreapable); killing the actual
      // holder leaves true SIGKILL residue like vite-node did.
      process.kill(Number(holderPid), 'SIGKILL');
      await once(holder, 'exit');
      await writeEntry(root, 'reaped-sigkill');
      const { readRegistry } = await import('../src/registry.js');
      const reg = await readRegistry(root);
      expect(reg['reaped-sigkill']).toBeDefined();
      const raw = JSON.parse(await readFile(await registryPathFor(root), 'utf8'));
      expect(raw.version).toBe(1);
    });
  }, 30_000);

  it('live-young-waits — live holder keeps the file, contender waits, zero blind unlink', async () => {
    await withScratchRoot(async (root) => {
      const sleeper = startSleeper();
      try {
        const stamp = `${sleeper.pid}:${Date.now()}`;
        const lockPath = await plantLock(root, stamp);
        const { atomicUpdateRegistry } = await import('../src/registry.js');
        await expect(
          atomicUpdateRegistry((reg: Record<string, unknown>) => {
            (reg as Record<string, Record<string, unknown>>)['never'] = {
              sessionId: 'never',
              agent: 'x',
              updatedAt: Date.now(),
            };
          }, root)
        ).rejects.toMatchObject({ code: 'EEXIST' });
        expect(await readLock(lockPath)).toBe(stamp);
      } finally {
        await stopProc(sleeper);
      }
    });
  }, 30_000);

  it('live-old-reaps — live pid past 3x the bound reaps (reuse backstop)', async () => {
    await withScratchRoot(async (root) => {
      const { LOCK_STALE_MS } = await import('../src/constants.js');
      const sleeper = startSleeper();
      try {
        const stamp = `${sleeper.pid}:${Date.now()}`;
        const lockPath = await plantLock(root, stamp, 3 * LOCK_STALE_MS + 5000);
        await writeEntry(root, 'reaped-live-old');
        const { readRegistry } = await import('../src/registry.js');
        expect((await readRegistry(root))['reaped-live-old']).toBeDefined();
        const after = await readLock(lockPath).catch(() => null);
        if (after !== null) expect(after).not.toBe(stamp);
      } finally {
        await stopProc(sleeper);
      }
    });
  }, 15_000);

  it('young-zero-byte — young 0-byte file waits, never reaps', async () => {
    await withScratchRoot(async (root) => {
      const lockPath = await plantLock(root, '');
      await expect(writeEntry(root, 'never-young')).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(stat(lockPath)).resolves.toBeDefined();
    });
  }, 30_000);

  it('malformed-garbage — garbage content routes to age, waits while young', async () => {
    await withScratchRoot(async (root) => {
      const lockPath = await plantLock(root, 'not-a-stamp');
      await expect(writeEntry(root, 'never-garbage')).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(stat(lockPath)).resolves.toBeDefined();
    });
  }, 30_000);

  it('malformed-zero-neg — zero plus negative pids route to age both sides', async () => {
    await withScratchRoot(async (root) => {
      const { LOCK_STALE_MS } = await import('../src/constants.js');
      const now = Date.now();
      await plantLock(root, `0:${now}`);
      await expect(writeEntry(root, 'never-zero')).rejects.toMatchObject({ code: 'EEXIST' });
      await plantLock(root, `-5:${now}`);
      await expect(writeEntry(root, 'never-neg')).rejects.toMatchObject({ code: 'EEXIST' });
      await plantLock(root, `0:${now}`, LOCK_STALE_MS + 5000);
      await writeEntry(root, 'reaped-zero-old');
      const { readRegistry } = await import('../src/registry.js');
      expect((await readRegistry(root))['reaped-zero-old']).toBeDefined();
      await plantLock(root, `-5:${now}`, LOCK_STALE_MS + 5000);
      await writeEntry(root, 'reaped-neg-old');
      expect((await readRegistry(root))['reaped-neg-old']).toBeDefined();
    });
  }, 60_000);

  it('release-ownership — release never deletes a foreign stamp', async () => {
    await withScratchRoot(async (root) => {
      const { withRegistryLock } = await import('../src/fsAtomic.js');
      const lockPath = await lockPathFor(root);
      await withRegistryLock(async () => {
        // simulate the next holder winning between our acquire and release
        await writeFile(lockPath, '999999:1', 'utf8');
      });
      expect(await readLock(lockPath)).toBe('999999:1');
    });
  }, 15_000);

  it('reap-enoent-race — racing reaps swallow ENOENT, every fn runs', async () => {
    await withScratchRoot(async (root) => {
      const dead = await freshDeadPid();
      await plantLock(root, `${dead}:${Date.now()}`);
      const { withRegistryLock, writeAtomic } = await import('../src/fsAtomic.js');
      const runOne = (i: number) =>
        withRegistryLock(async () => {
          await writeAtomic(join(root, `marker-${i}.json`), JSON.stringify({ i }), {
            mode: 0o600,
          });
          return i;
        });
      // Why: waiter patience is bounded (3 attempts) while the holder rides
      // real fsync, so under load a waiter can exhaust with EEXIST. The
      // pinned claim is every-fn-runs plus never-ENOENT, so exhausted
      // waiters re-race in later rounds instead of failing the run.
      const seen: string[] = [];
      let pending = [0, 1, 2, 3];
      for (let round = 0; round < 10 && pending.length > 0; round++) {
        const results = await Promise.allSettled(pending.map(runOne));
        const next: number[] = [];
        results.forEach((r, k) => {
          if (r.status === 'fulfilled') return;
          const code = (r.reason as { code?: string })?.code;
          seen.push(String(code));
          if (code === 'EEXIST') next.push(pending[k]);
          else throw r.reason;
        });
        pending = next;
      }
      expect(pending).toEqual([]);
      expect(seen).not.toContain('ENOENT');
      for (let i = 0; i < 4; i++) {
        expect(JSON.parse(await readFile(join(root, `marker-${i}.json`), 'utf8'))).toEqual({
          i,
        });
      }
      await writeEntry(root, 'race-landed');
      const { readRegistry } = await import('../src/registry.js');
      expect((await readRegistry(root))['race-landed']).toBeDefined();
      await expectLockAbsent(root);
    });
  }, 30_000);

  // Single fork serializes holders, so the one-shot throw below stands in for
  // the holder-won race; it proves the catch branch, not wall-clock ordering.
  it('reap-enoent-deterministic — losing reaper swallows ENOENT, every fn runs', async () => {
    await withScratchRoot(async (root) => {
      const dead = await freshDeadPid();
      const deadStamp = `${dead}:${Date.now()}`;
      const lockPath = await plantLock(root, deadStamp);
      const { withRegistryLock, writeAtomic } = await import('../src/fsAtomic.js');
      unlinkFault.fail = true;
      unlinkFault.calls = 0;
      let caught: unknown = null;
      let ran = false;
      try {
        await withRegistryLock(async () => {
          ran = true;
          await writeAtomic(join(root, 'marker-deterministic.json'), JSON.stringify({ ok: true }), {
            mode: 0o600,
          });
        });
      } catch (err) {
        caught = err;
      } finally {
        unlinkFault.fail = false;
      }
      expect(caught).toBeNull();
      expect([(caught as { code?: string } | null)?.code]).not.toContain('ENOENT');
      expect(ran).toBe(true);
      expect(unlinkFault.calls).toBe(1);
      expect(JSON.parse(await readFile(join(root, 'marker-deterministic.json'), 'utf8'))).toEqual({
        ok: true,
      });
      await writeEntry(root, 'after-deterministic-enoent');
      const { readRegistry } = await import('../src/registry.js');
      expect((await readRegistry(root))['after-deterministic-enoent']).toBeDefined();
      const after = await readLock(lockPath).catch(() => null);
      // lock either carries the new stamp or released already; never the dead stamp
      if (after !== null) {
        expect(after).not.toBe(deadStamp);
        expect(after.startsWith(`${process.pid}:`)).toBe(true);
      }
    });
  }, 15_000);

  it('stamp-cleanup — failed stamp unlinks the own path, taxonomy propagates', async () => {
    await withScratchRoot(async (root) => {
      const { isNoSpace, withRegistryLock } = await import('../src/fsAtomic.js');
      stampFault.fail = true;
      let caught: unknown = null;
      try {
        await withRegistryLock(async () => {});
      } catch (err) {
        caught = err;
      }
      expect(caught).not.toBeNull();
      expect(isNoSpace(caught)).toBe(true);
      await expectLockAbsent(root);
      await writeEntry(root, 'after-stamp-failure');
      const { readRegistry } = await import('../src/registry.js');
      expect((await readRegistry(root))['after-stamp-failure']).toBeDefined();
    });
  }, 15_000);

  it('burst — 6 parallel writers at twice the base, zero lost writes', async () => {
    await withScratchRoot(async (root) => {
      await Promise.all([0, 1, 2, 3, 4, 5].map((i) => writeEntry(root, `burst-${i}`)));
      const { readRegistry } = await import('../src/registry.js');
      const reg = await readRegistry(root);
      for (let i = 0; i < 6; i++) expect(reg[`burst-${i}`]).toBeDefined();
      await expectLockAbsent(root);
    });
  }, 30_000);

  it('no-half-write — skipped write mutates zero bytes', async () => {
    await withScratchRoot(async (root) => {
      await writeEntry(root, 'stable');
      const regPath = await registryPathFor(root);
      const before = await readFile(regPath, 'utf8');
      const sleeper = startSleeper();
      try {
        await plantLock(root, `${sleeper.pid}:${Date.now()}`);
        const { atomicUpdateRegistry } = await import('../src/registry.js');
        await expect(
          atomicUpdateRegistry((reg: Record<string, unknown>) => {
            (reg as Record<string, Record<string, unknown>>)['half'] = {
              sessionId: 'half',
              agent: 'x',
              updatedAt: Date.now(),
            };
          }, root)
        ).rejects.toMatchObject({ code: 'EEXIST' });
        expect(await readFile(regPath, 'utf8')).toBe(before);
      } finally {
        await stopProc(sleeper);
      }
    });
  }, 30_000);

  it('durability — post-reap write keeps modes plus parse plus version', async () => {
    await withScratchRoot(async (root) => {
      const { LOCK_STALE_MS } = await import('../src/constants.js');
      await plantLock(root, '', LOCK_STALE_MS + 5000);
      await writeEntry(root, 'durable');
      const regPath = await registryPathFor(root);
      expect((await stat(regPath)).mode & 0o777).toBe(0o600);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      const raw = JSON.parse(await readFile(regPath, 'utf8'));
      expect(raw.version).toBe(1);
      expect(raw.entries['durable']).toBeDefined();
    });
  }, 15_000);
});

describe('fail-closed matrix — hooks and tools', () => {
  async function wedgeWithLiveHolder(root: string): Promise<ChildProcess> {
    const sleeper = startSleeper();
    await plantLock(root, `${sleeper.pid}:${Date.now()}`);
    return sleeper;
  }

  async function loadHooks(): Promise<Record<string, unknown>> {
    const mod = await import('../plugin/opencode-mesh.js');
    return (await (mod.default as unknown as (input: unknown) => Promise<unknown>)({
      client: {},
    })) as Record<string, unknown>;
  }

  it('before — tool.execute.before drops the refresh, tool proceeds', async () => {
    await withScratchRoot(async (root) => {
      const regPath = await registryPathFor(root);
      await writeEntry(root, 'steady');
      const before = await readFile(regPath, 'utf8');
      const sleeper = await wedgeWithLiveHolder(root);
      try {
        const hooks = await loadHooks();
        const beforeHook = hooks['tool.execute.before'] as (input: unknown) => Promise<void>;
        await expect(
          beforeHook({ sessionID: 'hook-before-1', agent: 'builder', directory: root })
        ).resolves.toBeUndefined();
        expect(await readFile(regPath, 'utf8')).toBe(before);
        await (hooks.dispose as () => Promise<void>)();
      } finally {
        await stopProc(sleeper);
      }
    });
  }, 30_000);

  it('created — session.created skips the upsert, entry plus arming survive', async () => {
    await withScratchRoot(async (root) => {
      const sleeper = await wedgeWithLiveHolder(root);
      try {
        const hooks = await loadHooks();
        const onEvent = hooks.event as (input: unknown) => Promise<void>;
        await expect(
          onEvent({
            event: {
              type: 'session.created',
              properties: { info: { id: 'hook-created-1', directory: root, agent: 'builder' } },
            },
          })
        ).resolves.toBeUndefined();
        const { readRegistry } = await import('../src/registry.js');
        expect((await readRegistry(root))['hook-created-1']).toBeUndefined();
        await (hooks.dispose as () => Promise<void>)();
      } finally {
        await stopProc(sleeper);
      }
    });
  }, 30_000);

  it('updated — session.updated skips enrichment, memory refresh survives', async () => {
    await withScratchRoot(async (root) => {
      const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
      await atomicUpdateRegistry((reg: Record<string, unknown>) => {
        (reg as Record<string, Record<string, unknown>>)['hook-updated-1'] = {
          sessionId: 'hook-updated-1',
          agent: 'builder',
          description: 'Original title',
          summary: 'Original title',
          title: 'Original title',
          updatedAt: Date.now(),
        };
      }, root);
      const sleeper = await wedgeWithLiveHolder(root);
      try {
        const hooks = await loadHooks();
        const onEvent = hooks.event as (input: unknown) => Promise<void>;
        await expect(
          onEvent({
            event: {
              type: 'session.updated',
              properties: {
                info: { id: 'hook-updated-1', title: 'Refreshed title', agent: 'builder' },
              },
            },
          })
        ).resolves.toBeUndefined();
        expect((await readRegistry(root))['hook-updated-1']?.title).toBe('Original title');
        await (hooks.dispose as () => Promise<void>)();
      } finally {
        await stopProc(sleeper);
      }
    });
  }, 30_000);

  it('deleted — session.deleted still drops the in-memory id, disk waits', async () => {
    await withScratchRoot(async (root) => {
      await writeEntry(root, 'hook-deleted-1');
      const sleeper = await wedgeWithLiveHolder(root);
      try {
        const hooks = await loadHooks();
        const onEvent = hooks.event as (input: unknown) => Promise<void>;
        await expect(
          onEvent({
            event: {
              type: 'session.deleted',
              properties: { info: { id: 'hook-deleted-1' } },
            },
          })
        ).resolves.toBeUndefined();
        const { readRegistry } = await import('../src/registry.js');
        expect((await readRegistry(root))['hook-deleted-1']).toBeDefined();
        await (hooks.dispose as () => Promise<void>)();
      } finally {
        await stopProc(sleeper);
      }
    });
  }, 30_000);

  it('dispose — teardown never throws, timers clear, memory deletes', async () => {
    await withScratchRoot(async (root) => {
      const hooks = await loadHooks();
      const onEvent = hooks.event as (input: unknown) => Promise<void>;
      await onEvent({
        event: {
          type: 'session.created',
          properties: { info: { id: 'hook-dispose-1', directory: root, agent: 'builder' } },
        },
      });
      const sleeper = await wedgeWithLiveHolder(root);
      try {
        const dispose = hooks.dispose as () => Promise<void>;
        await expect(dispose()).resolves.toBeUndefined();
      } finally {
        await stopProc(sleeper);
      }
    });
  }, 30_000);

  it('register — contention answers degraded, validation stays loud', async () => {
    await withScratchRoot(async (root) => {
      const { mesh_register } = await import('../src/tools/mesh_register.js');
      const sleeper = await wedgeWithLiveHolder(root);
      try {
        const out = (await (mesh_register.execute as unknown as (a: unknown, b: unknown) => Promise<{ output: string }>)(
          { summary: 'degraded probe' },
          { sessionID: 'hook-register-1', directory: root, agent: 'builder' }
        )) as { output: string };
        const shaped = JSON.parse(out.output) as {
          registered: string;
          peers: Record<string, unknown>;
          busy: boolean;
        };
        expect(shaped.registered).toBe('hook-register-1');
        expect(shaped.busy).toBe(true);
        expect(typeof shaped.peers).toBe('object');
      } finally {
        await stopProc(sleeper);
      }
      try {
        await (mesh_register.execute as unknown as (a: unknown, b: unknown) => Promise<unknown>)(
          { summary: 'x' },
          { sessionID: 'hook-register-2', directory: '/no/such/dir/xyz', agent: 'builder' }
        );
        throw new Error('stale directory should refuse loud');
      } catch (err) {
        expect((err as { code?: string }).code).toBe('INVALID_DIRECTORY');
      }
    });
  }, 30_000);

  it('peers — persist skip returns the identical ranked union', async () => {
    const prevFetch = globalThis.fetch;
    await withScratchRoot(async (root) => {
      await writeEntry(root, 'peer-a');
      await writeEntry(root, 'peer-b');
      globalThis.fetch = (async (url: string) => {
        if (String(url).includes('/session/status')) {
          return { ok: true, status: 200, json: async () => ({ 'peer-a': { type: 'idle' } }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }) as unknown as typeof fetch;
      try {
        const { mesh_peers } = await import('../src/tools/mesh_peers.js');
        const run = async (): Promise<Record<string, unknown>> => {
          const out = (await (mesh_peers.execute as unknown as (a: unknown, b: unknown) => Promise<{ output: string }>)(
            {},
            { sessionID: 'caller-peers', directory: root }
          )) as { output: string };
          const shaped = JSON.parse(out.output) as Record<string, unknown>;
          for (const entry of Object.values(shaped)) {
            // normalize clock-derived fields so the wedge-vs-control
            // comparison proves display identity, not clock identity
            (entry as Record<string, unknown>).ageSec = 0;
            (entry as Record<string, unknown>).lastActionAt = 0;
          }
          return shaped;
        };
        const control = await run();
        expect(Object.keys(control)).toEqual(expect.arrayContaining(['peer-a', 'peer-b']));
        expect((control['peer-a'] as { rank: number }).rank).toBe(1);
        expect((control['peer-b'] as { rank: number }).rank).toBe(2);
        const sleeper = await wedgeWithLiveHolder(root);
        try {
          const wedge = await run();
          expect(Object.keys(wedge)).toEqual(Object.keys(control));
          expect(wedge).toEqual(control);
        } finally {
          await stopProc(sleeper);
        }
      } finally {
        globalThis.fetch = prevFetch;
      }
    });
  }, 60_000);
});
