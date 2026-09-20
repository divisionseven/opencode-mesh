// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Filesystem edge matrix: missing dirs fsync clean, foreign live holder
// blocks reap, permission denial fails fast. Each test pins the exact
// failure mode, never internals.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

const openCtl = vi.hoisted(() => ({ calls: 0, lockCalls: 0, fail: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: [string, ...unknown[]]) => {
      openCtl.calls++;
      if (String(args[0]).endsWith('.lock')) openCtl.lockCalls++;
      if (openCtl.fail && String(args[0]).endsWith('.lock')) {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return (actual.open as (...a: [string, ...unknown[]]) => Promise<unknown>)(...args);
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OPENCODE_MESH_DB_PATH;
});

async function freshRoot(prefix: string): Promise<{ root: string; restore: () => void }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const prev = process.env.OPENCODE_MESH_ROOT;
  const prevDb = process.env.OPENCODE_MESH_DB_PATH;
  process.env.OPENCODE_MESH_ROOT = root;
  process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
  return { root, restore: () => {
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT;
    else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH;
    else process.env.OPENCODE_MESH_DB_PATH = prevDb;
  } };
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

describe('filesystem edge matrix', () => {
  it('missing directory fsyncs clean', async () => {
    const fs = await import('../src/fsAtomic.js');
    await expect(fs.fsyncDir(join(tmpdir(), 'mesh-no-such-dir-xyz'))).resolves.toBeUndefined();
  });

  it('foreign live holder blocks reap with contention', async () => {
    const { root, restore } = await freshRoot('mesh-fs-live1-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'registry.json.lock'), `1:${Date.now()}`);
    const fs = await import('../src/fsAtomic.js');
    const reg = await import('../src/registry.js');
    const err = await reg.atomicUpdateRegistry(() => {}, root).then(
      () => null,
      (e: unknown) => e as { code?: string }
    );
    expect(err).not.toBeNull();
    expect(fs.isLockContention(err)).toBe(true);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('permission denial fails fast instead of retrying as contention', async () => {
    const { root, restore } = await freshRoot('mesh-fs-eacces-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    openCtl.calls = 0;
    openCtl.lockCalls = 0;
    openCtl.fail = true;
    const fs = await import('../src/fsAtomic.js');
    try {
      const err = await fs.withRegistryLock(async () => 'ran').then(
        () => null,
        (e: unknown) => e as { code?: string }
      );
      expect(err?.code).toBe('EACCES');
      expect(openCtl.lockCalls).toBe(1);
    } finally {
      openCtl.fail = false;
    }
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });
});
