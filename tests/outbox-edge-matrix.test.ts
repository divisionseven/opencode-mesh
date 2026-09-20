// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Outbox edge matrix on a real database: depth cap, lost claim race,
// terminal receipt vocabulary, dead letters, vacuum. Each test pins
// observable behavior, never internals.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

function outboxPath(root: string): string {
  return join(root, 'outbox.db');
}

describe('outbox edge matrix', () => {
  it('depth cap rejects the 101st row with STORAGE_FULL, earlier rows intact', async () => {
    const { root, restore } = await freshRoot('mesh-ob-cap-');
    const ob = await import('../src/outbox.js');
    for (let i = 0; i < 100; i++)
      await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: `m-${i}` }, root);
    await expect(
      ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'over' }, root)
    ).rejects.toMatchObject({ code: 'STORAGE_FULL' });
    expect(await ob.pendingCount(['ses-T'], root)).toBe(100);
    await safeRm(root); restore();
  }, 60_000);

  it('second owner claims nothing on an owned row, no throw', async () => {
    const { root, restore } = await freshRoot('mesh-ob-doubleclaim-');
    const ob = await import('../src/outbox.js');
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    expect((await ob.claim(['ses-T'], 'owner-A', 1, root)).length).toBe(1);
    expect(await ob.claim(['ses-T'], 'owner-B', 1, root)).toEqual([]);
    await safeRm(root); restore();
  });

  it('terminal receipt without detail carries reason and no miss keys', async () => {
    const { root, restore } = await freshRoot('mesh-ob-nodetail-');
    const ob = await import('../src/outbox.js');
    const id = await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    await ob.claim(['ses-T'], 'owner-1', 1, root);
    expect(await ob.failRow(id, 'owner-1', 'receiver-unresolvable', undefined, root)).toBe(true);
    const r = await ob.receiptById(id, root);
    expect(r.state).toBe('failed-permanent');
    expect(r.reason).toBe('receiver-unresolvable');
    expect('missLayer' in r).toBe(false);
    expect('missReason' in r).toBe(false);
    await safeRm(root); restore();
  });

  it('terminal receipt with detail carries sender plus terminal generations', async () => {
    const { root, restore } = await freshRoot('mesh-ob-detail-');
    const ob = await import('../src/outbox.js');
    const id = await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    await ob.claim(['ses-T'], 'owner-1', 1, root);
    expect(
      await ob.failRow(id, 'owner-1', 'receiver-unresolvable', { layer: 'registry', missReason: 'registry-absent' }, root)
    ).toBe(true);
    const r = await ob.receiptById(id, root);
    expect(r.state).toBe('failed-permanent');
    expect(typeof r.senderBuild).toBe('string');
    expect(typeof r.build).toBe('string');
    expect(r.missLayer).toBe('registry');
    expect(r.missReason).toBe('registry-absent');
    await safeRm(root); restore();
  });

  it('empty-string terminal columns read absent, empty fail reason reads non-terminal', async () => {
    const { root, restore } = await freshRoot('mesh-ob-emptycols-');
    const ob = await import('../src/outbox.js');
    const id = await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    await ob.claim(['ses-T'], 'owner-1', 1, root);
    await ob.failRow(id, 'owner-1', 'receiver-unresolvable', { layer: 'registry', missReason: 'registry-absent' }, root);
    const db = new DatabaseSync(outboxPath(root));
    db.prepare(`UPDATE outbox SET sender_build = '', miss_layer = '', miss_reason = '', build = '' WHERE id = ?`).run(id);
    const stripped = await ob.receiptById(id, root);
    expect(stripped.state).toBe('failed-permanent');
    expect('senderBuild' in stripped).toBe(false);
    expect('missLayer' in stripped).toBe(false);
    db.prepare(`UPDATE outbox SET fail_reason = '' WHERE id = ?`).run(id);
    expect((await ob.receiptById(id, root)).state).toBe('queued');
    db.close();
    await safeRm(root); restore();
  });

  it('exhausted old row reads dead-lettered and collects', async () => {
    const { root, restore } = await freshRoot('mesh-ob-dead-');
    const ob = await import('../src/outbox.js');
    const id = await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    const db = new DatabaseSync(outboxPath(root));
    db.prepare(`UPDATE outbox SET attempts = 25, created_at = ? WHERE id = ?`).run(Date.now() - 20 * 60 * 1000, id);
    db.close();
    const r = await ob.receiptById(id, root);
    expect(r.state).toBe('dead-lettered');
    expect(r.reason).toBe('max-attempts');
    const collected = await ob.collectOutbox(Date.now(), 10 * 60 * 1000, 25, root);
    expect(collected.deadLetter).toBe(1);
    expect(collected.deleted).toBe(1);
    expect(await ob.pendingCount(['ses-T'], root)).toBe(0);
    await safeRm(root); restore();
  });

  it('bulk delete past the freelist threshold vacuums and stays usable', async () => {    const { root, restore } = await freshRoot('mesh-ob-vacuum-');
    const ob = await import('../src/outbox.js');
    const big = 'x'.repeat(2048);
    for (let batch = 0; batch < 2; batch++) {
      for (let i = 0; i < 100; i++)
        await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: `${big}-${batch}-${i}` }, root);
      const claimed = await ob.claim(['ses-T'], 'owner-1', 100, root);
      for (const row of claimed) await ob.ack(row.id, 'owner-1', root);
    }
    const db = new DatabaseSync(outboxPath(root));
    db.prepare(`UPDATE outbox SET delivered_at = ?`).run(Date.now() - 20 * 60 * 1000);
    db.close();
    const collected = await ob.collectOutbox(Date.now(), 10 * 60 * 1000, 25, root);
    expect(collected.deleted).toBe(200);
    const id = await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'after' }, root);
    expect((await ob.receiptById(id, root)).state).toBe('queued');
    await safeRm(root); restore();
  }, 120_000);
});

describe('outbox store failure surfacing', () => {
  it('body at the 1MB bound refuses, below passes', async () => {
    const ob = await import('../src/outbox.js');
    const { ONE_MB } = await import('../src/constants.js');
    let code: unknown;
    try {
      ob.assertBodySendable(ONE_MB);
    } catch (e) {
      code = (e as { code?: unknown }).code;
    }
    expect(code).toBe('PAYLOAD_TOO_LARGE');
    expect(() => ob.assertBodySendable(ONE_MB - 1)).not.toThrow();
  });

  it('concurrent same-id enqueues converge on one row', async () => {
    const { root, restore } = await freshRoot('mesh-ob-raceid-');
    const ob = await import('../src/outbox.js');
    const input = { target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi', id: 'msg_00000000000000deadbeef0000' };
    const [a, b] = await Promise.all([ob.enqueue({ ...input }, root), ob.enqueue({ ...input }, root)]);
    expect(a).toBe(input.id);
    expect(b).toBe(input.id);
    expect(await ob.pendingCount(['ses-T'], root)).toBe(1);
    await safeRm(root); restore();
  });

  it('directory at the store path surfaces raw errors from readers', async () => {
    const { root, restore } = await freshRoot('mesh-ob-isdir-');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'outbox.db'));
    const ob = await import('../src/outbox.js');
    await expect(ob.pendingCount(['ses-T'], root)).rejects.toThrow();
    await expect(ob.receiptById('msg_00000000000000deadbeef0000', root)).rejects.toThrow();
    await expect(ob.collectOutbox(Date.now(), 1000, 1, root)).rejects.toThrow();
    await safeRm(root); restore();
  });

  it('delivered rows never re-enter the claim path', async () => {
    const { root, restore } = await freshRoot('mesh-ob-noreclaim-');
    const ob = await import('../src/outbox.js');
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    const [row] = await ob.claim(['ses-T'], 'owner-1', 1, root);
    expect(await ob.ack(row.id, 'owner-1', root)).toBe(true);
    expect(await ob.claim(['ses-T'], 'owner-2', 1, root)).toEqual([]);
    await safeRm(root); restore();
  });
});
