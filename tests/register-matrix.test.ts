// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Register matrix: contention degrades to best-peers with the busy flag,
// generic updates touch without clobbering. Each test pins the caller
// contract, never internals.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

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

describe('register matrix', () => {
  it('lock contention degrades to best-peers with the busy flag', async () => {
    const { root, restore } = await freshRoot('mesh-reg-busy-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'registry.json.lock'));
    const { mesh_register } = await import('../src/tools/mesh_register.js');
    const out = await (mesh_register.execute as unknown as (a: unknown, c: unknown) => Promise<{ output: string }>)(
      { summary: 'busy work' }, { sessionID: 'ses-b', directory: '/tmp' }
    );
    expect(JSON.parse(out.output)).toMatchObject({ registered: 'ses-b', busy: true });
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('generic update touches the stamp without clobbering description', async () => {
    const { root, restore } = await freshRoot('mesh-reg-generictouch-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const reg = await import('../src/registry.js');
    await reg.atomicUpdateRegistry((r: unknown) => {
      (r as Record<string, unknown>)['ses-g'] = {
        sessionId: 'ses-g', agent: 'a', description: 'Real work', updatedAt: Date.now() - 1000,
      };
    }, root);
    const { mesh_register } = await import('../src/tools/mesh_register.js');
    await (mesh_register.execute as unknown as (a: unknown, c: unknown) => Promise<unknown>)(
      { summary: 'New session - 2026-09-03T10:00:00.000Z' }, { sessionID: 'ses-g', directory: '/tmp' }
    );
    const entry = (await reg.readRegistry(root))['ses-g'] as unknown as Record<string, unknown>;
    expect(entry.description).toBe('Real work');
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });
});
