// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Register under lock contention degrades to a best-effort answer instead of
// failing the caller. Given a held registry lock, when registering, then the
// tool reports busy true with the readable peers.
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeMeshRegister } from '../src/tools/mesh_register.core.js';
import { resolveRegistryPath } from '../src/xdg.js';

async function freshRoot(
  prefix: string,
): Promise<{ root: string; restore: () => void }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const prev = process.env.OPENCODE_MESH_ROOT;
  const prevDb = process.env.OPENCODE_MESH_DB_PATH;
  process.env.OPENCODE_MESH_ROOT = root;
  process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
  return {
    root,
    restore: () => {
      if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT;
      else process.env.OPENCODE_MESH_ROOT = prev;
      if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH;
      else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    },
  };
}

async function safeRm(root: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (
        (code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM') &&
        attempt < 2
      ) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      throw err;
    }
  }
}

describe('register under a held lock answers busy instead of failing', () => {
  it('returns busy true with readable peers while the lock is held elsewhere', async () => {
    const { root, restore } = await freshRoot('mesh-reg-busy-');
    try {
      await mkdir(root, { recursive: true });
      await writeFile(`${resolveRegistryPath()}.lock`, `1:${Date.now()}`, 'utf8');
      const out = await executeMeshRegister({ summary: 'contended' }, { sessionID: 'ses-busy' });
      const parsed = JSON.parse(out.output) as { registered: string; busy: boolean };
      expect(parsed.registered).toBe('ses-busy');
      expect(parsed.busy).toBe(true);
    } finally {
      await safeRm(root);
      restore();
    }
  });
});
