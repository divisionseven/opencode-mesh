// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Loader failure maps every outbox entry to its fail-closed value behind
// an unresolvable driver. Single evaluation: one mock, every mapping in
// one pass, no resets.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import * as ob from '../src/outbox.js';

vi.mock('node:sqlite', () => {
  throw new Error('mutant: no sqlite build');
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

describe('outbox loader fail-closed', () => {
  it('writes reject unavailable', async () => {
    const { root, restore } = await freshRoot('mesh-ob-loader-');
    await expect(
      ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root)
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(await ob.failRow('x', 'owner-1', 'max-attempts', undefined, root)).toBe(false);
    await safeRm(root); restore();
  });

  it('reads degrade to empty values', async () => {
    const { root, restore } = await freshRoot('mesh-ob-loaderread-');
    expect(await ob.claim(['ses-T'], 'owner-1', 1, root)).toEqual([]);
    expect(await ob.ack('x', 'owner-1', root)).toBe(false);
    expect(await ob.release('x', 'owner-1', root)).toBe(false);
    expect(await ob.requeueStale(0, root)).toBe(0);
    expect(await ob.releaseOwner('owner-1', root)).toBe(0);
    expect(await ob.pendingCount(['ses-T'], root)).toBe(0);
    expect(await ob.collectOutbox(Date.now(), 1000, 1, root)).toEqual({ deleted: 0, deadLetter: 0 });
    const r = await ob.receiptById('msg_00000000000000deadbeef0000', root);
    expect(r.state).toBe('failed-permanent');
    expect(r.reason).toBe('storage-unavailable');
    await safeRm(root); restore();
  });
});
