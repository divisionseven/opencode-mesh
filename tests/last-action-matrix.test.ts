// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Last-action tracker legs: entries without a stamp still stamp, and an
// idle observation never creates an entry. Pure registry behavior.
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

describe('last-action tracker legs', () => {
  it('entry without a stamp still stamps at the observed time', async () => {
    const { root, restore } = await freshRoot('mesh-la-');
    const reg = await import('../src/registry.js');
    const la = await import('../src/lastAction.js');
    await reg.atomicUpdateRegistry((r: unknown) => {
      (r as Record<string, unknown>)['ses-nostamp'] = { sessionId: 'ses-nostamp', agent: 'a', updatedAt: Date.now() };
    }, root);
    const at = Date.now();
    await la.stampLastAction('ses-nostamp', { at, meshRoot: root });
    const entry = (await reg.readRegistry(root))['ses-nostamp'] as unknown as Record<string, unknown>;
    expect(entry.lastActionAt).toBe(at);
    await safeRm(root); restore();
  });

  it('idle observation creates no entry', async () => {
    const { root, restore } = await freshRoot('mesh-la-idle-');
    const reg = await import('../src/registry.js');
    const la = await import('../src/lastAction.js');
    await la.noteBusyActive('ses-ghost', 'idle', root);
    expect((await reg.readRegistry(root))['ses-ghost']).toBeUndefined();
    await safeRm(root); restore();
  });

  it('poisoned store drops the stamp without throwing', async () => {
    const { root, restore } = await freshRoot('mesh-la-poison-');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'registry.json'));
    const la = await import('../src/lastAction.js');
    await expect(la.stampLastAction('ses-x', { meshRoot: root })).resolves.toBeUndefined();
    await safeRm(root); restore();
  });
});
