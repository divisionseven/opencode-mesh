// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Corrupt registry guard: a torn store refuses writes instead of wiping
// peers, and surfaces STORAGE_CORRUPT loud.
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import * as reg from '../src/registry.js';

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

describe('registry corrupt guard', () => {
  it('torn store refuses the write with STORAGE_CORRUPT and keeps bytes', async () => {
    const { root, restore } = await freshRoot('mesh-reg-corrupt-');
    const target = join(root, 'registry.json');
    await writeFile(target, '{"torn": ');
    const before = await readFile(target, 'utf8');
    await expect(
      reg.atomicUpdateRegistry(() => {}, root)
    ).rejects.toMatchObject({ code: 'STORAGE_CORRUPT' });
    expect(await readFile(target, 'utf8')).toBe(before);
    await safeRm(root); restore();
  });

  it('missing store still writes fresh', async () => {
    const { root, restore } = await freshRoot('mesh-reg-fresh-');
    await reg.atomicUpdateRegistry((r: unknown) => {
      (r as Record<string, unknown>)['ses-n'] = { sessionId: 'ses-n', agent: 'a', updatedAt: Date.now() };
    }, root);
    expect(((await reg.readRegistry(root))['ses-n'] as unknown as { agent: string }).agent).toBe('a');
    await safeRm(root); restore();
  });
});
