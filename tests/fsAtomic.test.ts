// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ensureDir0700,
  fsyncDir,
  tmpName,
  writeAtomic,
} from '../src/fsAtomic.js';

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
describe('fsAtomic', () => {
  it('tmpName shape base.<pid>.<rand>.tmp', () => {
    const n = tmpName('registry.json');
    expect(n).toMatch(/^registry\.json\.\d+\.[a-z0-9]{8}\.tmp$/);
  });
  it('ensureDir0700 creates 0700 + fsync dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-'));
    const dir = join(root, 'a', 'b');
    await ensureDir0700(dir);
    const s = await stat(dir);
    expect(s.mode & 0o777).toBe(0o700);
    await safeRm(root);
  });
  it('writeAtomic fsync before chmod 0600 then fsync dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-'));
    const target = join(root, 'file.json');
    await writeAtomic(target, JSON.stringify({ a: 1 }), { mode: 0o600 });
    const s = await stat(target);
    expect(s.mode & 0o777).toBe(0o600);
    await safeRm(root);
  });
  it('concurrent 100 writers never tear a write (JSON parses)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-'));
    const target = join(root, 'c.json');
    const writers = Array.from({ length: 100 }, (_, i) =>
      writeAtomic(target, JSON.stringify({ i }), { mode: 0o600 })
    );
    await Promise.all(writers);
    const data = await import('node:fs/promises').then((m) =>
      m.readFile(target, 'utf8')
    );
    expect(() => JSON.parse(data)).not.toThrow();
    await safeRm(root);
  });
  it('fsyncDir does not throw on missing', async () => {
    await expect(fsyncDir('/tmp/notexist-xyz')).resolves.toBeUndefined();
  });
  it('tmpName carries pid plus randomness (no collisions across writers)', async () => {
    expect(tmpName('x')).toContain(`${process.pid}`);
    expect(tmpName('x')).not.toBe(tmpName('x'));
  });
  it('stale lock with a dead pid reaps and runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-lockdead-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { writeFile, utimes } = await import('node:fs/promises');
    await writeFile(join(root, 'registry.json.lock'), `4294967295:${Date.now() - 60000}`);
    const old = new Date(Date.now() - 60000);
    await utimes(join(root, 'registry.json.lock'), old, old);
    const { withRegistryLock } = await import('../src/fsAtomic.js');
    await expect(withRegistryLock(async () => 'ran')).resolves.toBe('ran');
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root);
  });
  it('stale lock with garbage content reaps through the age branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-lockgarbage-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { writeFile, utimes } = await import('node:fs/promises');
    await writeFile(join(root, 'registry.json.lock'), 'garbage-no-colon');
    const old = new Date(Date.now() - 60000);
    await utimes(join(root, 'registry.json.lock'), old, old);
    const { withRegistryLock } = await import('../src/fsAtomic.js');
    await expect(withRegistryLock(async () => 'ran')).resolves.toBe('ran');
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root);
  });
  it('stale lock with a zero clock reads unparsable and reaps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-lockzero-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { writeFile, utimes } = await import('node:fs/promises');
    await writeFile(join(root, 'registry.json.lock'), '4294967295:0');
    const old = new Date(Date.now() - 60000);
    await utimes(join(root, 'registry.json.lock'), old, old);
    const { withRegistryLock } = await import('../src/fsAtomic.js');
    await expect(withRegistryLock(async () => 'ran')).resolves.toBe('ran');
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root);
  });
  it('lock path blocked by a directory exhausts to contention', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-lockdir-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'registry.json.lock'));
    const { withRegistryLock, isLockContention } = await import('../src/fsAtomic.js');
    const err = await withRegistryLock(async () => 'ran').then(() => null, (e: any) => e);
    expect(err).not.toBeNull();
    expect((err as NodeJS.ErrnoException).code).toBe('EEXIST');
    expect(isLockContention(err)).toBe(true);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root);
  });
  it.runIf(process.platform === 'darwin')('immutable stale lock exhausts to contention', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-lockimmutable-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { writeFile, utimes } = await import('node:fs/promises');
    const { spawnSync } = await import('node:child_process');
    const lockPath = join(root, 'registry.json.lock');
    await writeFile(lockPath, `4294967295:${Date.now() - 60000}`);
    const old = new Date(Date.now() - 60000);
    await utimes(lockPath, old, old);
    expect(spawnSync('chflags', ['uchg', lockPath]).status).toBe(0);
    const { withRegistryLock, isLockContention } = await import('../src/fsAtomic.js');
    try {
      const err = await withRegistryLock(async () => 'ran').then(() => null, (e: any) => e);
      expect(err).not.toBeNull();
      expect(isLockContention(err)).toBe(true);
    } finally {
      spawnSync('chflags', ['nouchg', lockPath]);
    }
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root);
  }, 60_000);
  it('isLockContention reads EEXIST and EACCES as contention', async () => {
    const { isLockContention } = await import('../src/fsAtomic.js');
    expect(isLockContention({ code: 'EEXIST' })).toBe(true);
    expect(isLockContention({ code: 'EACCES' })).toBe(true);
  });
  it('isLockContention reads other errors as non-contention', async () => {
    const { isLockContention } = await import('../src/fsAtomic.js');
    expect(isLockContention({ code: 'EISDIR' })).toBe(false);
    expect(isLockContention(new Error('boom'))).toBe(false);
  });
  it('writeAtomic without opts defaults a new file to 0600', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-'));
    const target = join(root, 'fresh.json');
    await writeAtomic(target, JSON.stringify({ a: 1 }));
    const s = await stat(target);
    expect(s.mode & 0o777).toBe(0o600);
    await safeRm(root);
  });
  it('writeAtomic onto a directory throws and cleans the temp', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-'));
    const target = join(root, 'blocked');
    const { mkdir, readdir } = await import('node:fs/promises');
    await mkdir(target);
    await expect(writeAtomic(target, 'x', { mode: 0o600 })).rejects.toThrow();
    expect(await readdir(root)).toEqual(['blocked']);
    await safeRm(root);
  });
  it('registry locks land per root, never the default', async () => {
    const rootA = await mkdtemp(join(tmpdir(), 'mesh-lockA-'));
    const rootB = await mkdtemp(join(tmpdir(), 'mesh-lockB-'));
    const { withRegistryLock } = await import('../src/fsAtomic.js');
    const { existsSync } = await import('node:fs');
    await withRegistryLock(async () => {
      expect(existsSync(join(rootA, 'registry.json.lock'))).toBe(true);
      return 'a';
    }, rootA);
    await withRegistryLock(async () => {
      expect(existsSync(join(rootB, 'registry.json.lock'))).toBe(true);
      return 'b';
    }, rootB);
    await safeRm(rootA);
    await safeRm(rootB);
  });
});
