// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Stale-lock reap when unlink fails: Linux equivalent of the darwin
// immutable-flag test (chflags is macOS-only). unlink throws EPERM on
// *.lock paths, so reapVerified declines and the lock exhausts to
// contention instead of tearing.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

const stash = vi.hoisted(() => ({
  realUnlink: null as ((path: unknown, ...rest: unknown[]) => Promise<void>) | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  stash.realUnlink = actual.unlink as (path: unknown, ...rest: unknown[]) => Promise<void>;
  return {
    ...actual,
    unlink: vi.fn(async (path: unknown, ...rest: unknown[]) => {
      if (String(path).endsWith('.lock')) {
        const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return (actual.unlink as (...args: unknown[]) => Promise<void>)(path, ...rest);
    }),
  };
});

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

afterEach(() => {
});

describe('fsAtomic unlink-fails contention', () => {
  it('stale lock with failing unlink exhausts to contention', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-lockunlink-'));
    const prevRoot = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'mesh.db');
    try {
      const { writeFile, utimes } = await import('node:fs/promises');
      await writeFile(join(root, 'registry.json.lock'), '4294967295:0');
      const old = new Date(Date.now() - 60000);
      await utimes(join(root, 'registry.json.lock'), old, old);
      const { withRegistryLock, isLockContention } = await import('../src/fsAtomic.js');
      const err = await withRegistryLock(async () => 'ran').then(
        () => null,
        (e: unknown) => e
      );
      expect(err).not.toBeNull();
      expect(isLockContention(err)).toBe(true);
    } finally {
      if (prevRoot === undefined) delete process.env.OPENCODE_MESH_ROOT;
      else process.env.OPENCODE_MESH_ROOT = prevRoot;
      if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH;
      else process.env.OPENCODE_MESH_DB_PATH = prevDb;
      // Why: teardown bypasses the unlink mock, else the stale *.lock
      // is undeletable and safeRm throws.
      await stash.realUnlink?.(join(root, 'registry.json.lock')).catch(() => {});
      await safeRm(root);
    }
  }, 60_000);
});
