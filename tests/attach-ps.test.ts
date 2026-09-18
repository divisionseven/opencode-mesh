// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// pollAttachOnce ps-oracle legs behind an execFile mock.
// The source consumes execFile through promisify (custom {stdout} shape), so
// the mock implements Symbol.for('nodejs.util.promisify.custom') like the real
// binary; a plain-callback mock would resolve the bare string and prove nothing.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

type PsCb = (err: unknown, stdout?: unknown, stderr?: unknown) => void;
const CUSTOM = Symbol.for('nodejs.util.promisify.custom');
const psCtl = vi.hoisted(() => ({ mode: 'empty' as 'undef' | 'throw' | 'rows' | 'empty' }));

vi.mock('node:child_process', () => {
  const fake = (_cmd: string, _args: string[], cb: PsCb) => {
    cb(new Error('attach-ps mock serves the promisified shape only'));
  };
  (fake as unknown as Record<symbol, unknown>)[CUSTOM] = async () => {
    if (psCtl.mode === 'throw') throw new Error('no ps here');
    if (psCtl.mode === 'undef') return { stdout: undefined, stderr: '' };
    if (psCtl.mode === 'rows') return { stdout: 'u 1 0:00 opencode -s ses-ps1\nu 2 0:00 opencode -s ses-ps2\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  return { execFile: fake };
});

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch as unknown as typeof fetch;
  psCtl.mode = 'empty';
  vi.resetModules();
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

describe('attach ps-oracle legs', () => {
  it('undefined ps stdout reads as empty text', async () => {
    const { root, restore } = await freshRoot('mesh-ps-undef-');
    psCtl.mode = 'undef';
    const { pollAttachOnce } = await import('../src/attach.js');
    const snap = await pollAttachOnce({ meshRoot: root, statusMap: {} });
    expect(snap.attached).toEqual([]);
    expect(snap.unmapped).toBe(0);
    await safeRm(root); restore();
  });

  it('ps failure reads as empty text', async () => {
    const { root, restore } = await freshRoot('mesh-ps-fail-');
    psCtl.mode = 'throw';
    const { pollAttachOnce } = await import('../src/attach.js');
    const snap = await pollAttachOnce({ meshRoot: root, statusMap: {} });
    expect(snap.attached).toEqual([]);
    await safeRm(root); restore();
  });

  it('ps rows parse into the attached set', async () => {
    const { root, restore } = await freshRoot('mesh-ps-rows-');
    psCtl.mode = 'rows';
    const { pollAttachOnce } = await import('../src/attach.js');
    const snap = await pollAttachOnce({ meshRoot: root, statusMap: {} });
    expect(snap.attached).toEqual(['ses-ps1', 'ses-ps2']);
    await safeRm(root); restore();
  });
});
