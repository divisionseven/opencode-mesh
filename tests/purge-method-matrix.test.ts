// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Purge method matrix: each trash tier reports its own name, and the
// filesystem fallback runs when both binaries fail. Behavior switches
// through the hoisted control under one module evaluation.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { purgeMeshRoot } from '../src/install/stow.js';

const ctl = vi.hoisted(() => ({ trashFails: false, systemFails: false }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (cmd: string, args: string[], cb: (err: Error | null) => void) => {
      const fail = cmd === 'trash' ? ctl.trashFails : ctl.systemFails;
      if (fail) {
        const err = new Error(`not found: ${cmd}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        cb(err);
      } else {
        cb(null);
      }
      return undefined as never;
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OPENCODE_MESH_DB_PATH;
  ctl.trashFails = false;
  ctl.systemFails = false;
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

describe('purge method matrix', () => {
  it('first tier reports trash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-purge-tier1-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'a', 'b'), { recursive: true });
    expect(await purgeMeshRoot(join(root, 'a', 'b'))).toBe('trash');
    await safeRm(root);
  });

  it('second tier reports system trash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-purge-tier2-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'a', 'b'), { recursive: true });
    ctl.trashFails = true;
    expect(await purgeMeshRoot(join(root, 'a', 'b'))).toBe('system-trash');
    await safeRm(root);
  });

  it('both tiers down falls back to filesystem delete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-purge-tier3-'));
    const { mkdir } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const victim = join(root, 'a', 'b');
    await mkdir(victim, { recursive: true });
    ctl.trashFails = true;
    ctl.systemFails = true;
    expect(await purgeMeshRoot(victim)).toBe('filesystem');
    expect(existsSync(victim)).toBe(false);
    await safeRm(root);
  });
});
