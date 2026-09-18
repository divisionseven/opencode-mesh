// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Lazy node:sqlite gate: zero static edges, fail-closed on loader throw.
// Mutant: restore a static `import { DatabaseSync } from "node:sqlite"` in src/outbox.ts
// and the census test reddens; stub loadSqlite to throw and the fail-closed tests redden
// when any path propagates instead of mapping to STORAGE_UNAVAILABLE / [] / false / 0.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

const bunCtl = vi.hoisted(() => ({ shape: 'full' as 'full' | 'nofns' | 'bigint' | 'noquery' | 'noprepare' | 'neither' }));

// Virtual bun:sqlite: unresolvable on Node, so virtual:true carries the fake.
// Shapes drive each adapter fork: missing methods, bigint changes, and prepare presence.
// bigint changes (bun parity), and prepare/query presence per driver.
vi.mock('bun:sqlite', () => {
  function stmtFor() {
    if (bunCtl.shape === 'nofns') return {};
    if (bunCtl.shape === 'bigint') return { run: () => ({ changes: 10n }) };
    return {
      get: (...p: unknown[]) => ({ one: 1, params: p.length }),
      all: () => [{ one: 1 }],
      run: () => ({ changes: 1 }),
    };
  }
  class FakeDb {
    prepare?: (_sql: string) => unknown;
    query?: (_sql: string) => unknown;
    constructor(..._a: unknown[]) {
      // Bun-shaped drivers expose query; node-shaped expose prepare. A leg
      // missing from the instance reads as absent (never a throw), matching
      // how the adapter probes with typeof before binding.
      if (bunCtl.shape !== 'noprepare' && bunCtl.shape !== 'neither')
        this.prepare = (_sql: string) => stmtFor();
      if (bunCtl.shape !== 'noquery' && bunCtl.shape !== 'neither')
        this.query = (_sql: string) => stmtFor();
    }
    exec(_sql: string): void {}
    close(): void {}
  }
  return { Database: FakeDb };
  // Virtual mock types allow 1-2 args only; suppression stays while suite is green.
  // Self-canarying: future 3rd-arg support errors as unused directive.
  // @ts-expect-error — virtual flag on the unresolvable bun:sqlite id.
}, { virtual: true });

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock('node:sqlite');
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

describe('sqlite lazy gate', () => {
  it('src modules load with zero static sqlite resolves', async () => {
    const ob = await import('../src/outbox.js');
    expect(typeof ob.enqueue).toBe('function');
    expect(typeof ob.loadSqlite).toBe('function');
    const ms = await import('../src/tools/mesh_send.js');
    expect(ms.mesh_send).toBeDefined();
    const mp = await import('../src/tools/mesh_peers.js');
    expect(mp.mesh_peers).toBeDefined();
  });

  it('readDbSessions fail-closed to {} on loader throw (deletes zero)', async () => {
    vi.resetModules();
    vi.doMock('node:sqlite', () => {
      throw new Error('mutant: no sqlite build');
    });
    const d = await import('../src/discovery.js');
    expect(await d.readDbSessions(join(tmpdir(), 'mesh-nope.db'))).toEqual({});
    vi.doUnmock('node:sqlite');
  });

  it('enqueue maps loader throw to STORAGE_UNAVAILABLE; reads map to empty', async () => {
    const { root, restore } = await freshRoot('mesh-lazy-');
    vi.resetModules();
    vi.doMock('node:sqlite', () => {
      throw new Error('mutant: no sqlite build');
    });
    const ob = await import('../src/outbox.js');
    await expect(
      ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root)
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(await ob.claim(['ses-T'], 'owner-1', 1, root)).toEqual([]);
    expect(await ob.ack('x', 'owner-1', root)).toBe(false);
    expect(await ob.release('x', 'owner-1', root)).toBe(false);
    expect(await ob.requeueStale(0, root)).toBe(0);
    expect(await ob.pendingCount(['ses-T'], root)).toBe(0);
    expect(await ob.collectOutbox(Date.now(), 1000, 1, root)).toEqual({ deleted: 0, deadLetter: 0 });
    vi.doUnmock('node:sqlite');
    await safeRm(root); restore();
  });

  it('receipt maps loader throw to failed-permanent storage-unavailable', async () => {
    const { root, restore } = await freshRoot('mesh-lazy-receipt-');
    vi.resetModules();
    vi.doMock('node:sqlite', () => {
      throw new Error('mutant: no sqlite build');
    });
    const ob = await import('../src/outbox.js');
    const r = await ob.receiptById('msg_00000000000000deadbeef0000', root);
    expect(r.state).toBe('failed-permanent');
    expect(r.reason).toBe('storage-unavailable');
    vi.doUnmock('node:sqlite');
    await safeRm(root); restore();
  });

  it('bun marker plus virtual driver resolves the bun leg', async () => {
    (globalThis as Record<string, unknown>).Bun = {};
    try {
      vi.resetModules();
      bunCtl.shape = 'full';
      const ob = await import('../src/outbox.js');
      const Ctor = await ob.loadSqlite();
      expect(typeof Ctor).toBe('function');
      const db = new Ctor(':memory:');
      db.exec('CREATE TABLE t(a)');
      const st = db.prepare('SELECT 1');
      expect((st.get as (...p: unknown[]) => unknown)()).toMatchObject({ one: 1 });
      expect((st.all as () => unknown[])()).toEqual([{ one: 1 }]);
      expect((st.run as () => unknown)()).toEqual({ changes: 1 });
      db.close();
    } finally {
      delete (globalThis as Record<string, unknown>).Bun;
    }
  });

  it('bun driver without statement methods reads miss sides', async () => {
    (globalThis as Record<string, unknown>).Bun = {};
    try {
      vi.resetModules();
      bunCtl.shape = 'nofns';
      const ob = await import('../src/outbox.js');
      const Ctor = await ob.loadSqlite();
      const db = new Ctor(':memory:');
      const st = db.prepare('SELECT 1');
      expect((st.get as (...p: unknown[]) => unknown)()).toBeUndefined();
      expect((st.all as () => unknown[])()).toEqual([]);
      expect((st.run as () => unknown)()).toEqual({ changes: 0 });
      db.close();
    } finally {
      delete (globalThis as Record<string, unknown>).Bun;
    }
  });

  it('bun driver bigint changes normalize to number', async () => {
    (globalThis as Record<string, unknown>).Bun = {};
    try {
      vi.resetModules();
      bunCtl.shape = 'bigint';
      const ob = await import('../src/outbox.js');
      const Ctor = await ob.loadSqlite();
      const db = new Ctor(':memory:');
      const st = db.prepare('UPDATE t SET a = 1');
      expect((st.run as () => unknown)()).toEqual({ changes: 10 });
      db.close();
    } finally {
      delete (globalThis as Record<string, unknown>).Bun;
    }
  });

  it('bun driver prepare leg serves statements', async () => {
    (globalThis as Record<string, unknown>).Bun = {};
    try {
      vi.resetModules();
      bunCtl.shape = 'full';
      const ob = await import('../src/outbox.js');
      const Ctor = await ob.loadSqlite();
      const db = new Ctor(':memory:');
      expect((db.prepare('SELECT 1').get as (...p: unknown[]) => unknown)()).toMatchObject({ one: 1 });
      db.close();
    } finally {
      delete (globalThis as Record<string, unknown>).Bun;
    }
  });

  it('bun driver without prepare falls back to query', async () => {
    (globalThis as Record<string, unknown>).Bun = {};
    try {
      vi.resetModules();
      bunCtl.shape = 'noprepare';
      const ob = await import('../src/outbox.js');
      const Ctor = await ob.loadSqlite();
      const db = new Ctor(':memory:');
      expect((db.prepare('SELECT 1').get as (...p: unknown[]) => unknown)()).toMatchObject({ one: 1 });
      db.close();
    } finally {
      delete (globalThis as Record<string, unknown>).Bun;
    }
  });

  it('bun driver without prepare or query throws STORAGE_UNAVAILABLE', async () => {
    (globalThis as Record<string, unknown>).Bun = {};
    try {
      vi.resetModules();
      bunCtl.shape = 'neither';
      const ob = await import('../src/outbox.js');
      const Ctor = await ob.loadSqlite();
      const db = new Ctor(':memory:');
      const err = (() => { try { db.prepare('SELECT 1'); return null; } catch (e) { return e as { code?: string }; } })();
      expect(err?.code).toBe('STORAGE_UNAVAILABLE');
      db.close();
    } finally {
      delete (globalThis as Record<string, unknown>).Bun;
    }
  });

  it('versions bun flag also selects the bun leg', async () => {
    (process.versions as Record<string, string | undefined>).bun = '1.2.3';
    try {
      vi.resetModules();
      bunCtl.shape = 'full';
      const ob = await import('../src/outbox.js');
      const Ctor = await ob.loadSqlite();
      expect(typeof Ctor).toBe('function');
    } finally {
      delete (process.versions as Record<string, string | undefined>).bun;
    }
  });
});
