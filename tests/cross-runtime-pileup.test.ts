// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Forked loader claims on both drivers.
// Mock proves the fork leg without a Bun runner; live Bun 1.4.2 leg proven scratch-only.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock('bun:sqlite');
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

interface FakeRow {
  seq: number; id: string; target_session: string; from_session: string;
  from_agent: string; text: string; created_at: number; broadcast_id: string | null;
  claimed_by: string | null; claimed_at: number | null; delivered_at: number | null;
  attempts: number;
}

function installFakeBun(): { constructed: () => number } {
  const stores = new Map<string, { rows: FakeRow[]; seq: number; constructed: number }>();
  const storeFor = (path: string) => {
    let s = stores.get(path);
    if (!s) { s = { rows: [], seq: 0, constructed: 0 }; stores.set(path, s); }
    return s;
  };
  class FakeStmt {
    constructor(private store: { rows: FakeRow[]; seq: number }, private sql: string) {}
    run(...p: unknown[]): { changes: bigint } {
      const q = this.sql;
      const rows = this.store.rows;
      if (q.startsWith('INSERT INTO outbox')) {
        const [id, target_session, from_session, from_agent, text, created_at, broadcast_id] = p as [string, string, string, string, string, number, string | null];
        this.store.seq += 1;
        rows.push({ seq: this.store.seq, id, target_session, from_session, from_agent, text, created_at, broadcast_id, claimed_by: null, claimed_at: null, delivered_at: null, attempts: 0 });
        return { changes: BigInt(1) };
      }
      if (q.startsWith('UPDATE outbox SET claimed_by = ?, claimed_at = ? WHERE id = ? AND claimed_by IS NULL')) {
        const [owner, at, id] = p as [string, number, string];
        const r = rows.find((r) => r.id === id && r.claimed_by === null);
        if (!r) return { changes: BigInt(0) };
        r.claimed_by = owner; r.claimed_at = at;
        return { changes: BigInt(1) };
      }
      if (q.startsWith('UPDATE outbox SET delivered_at')) {
        const [at, id, owner] = p as [number, string, string];
        const r = rows.find((r) => r.id === id && r.claimed_by === owner);
        if (!r) return { changes: BigInt(0) };
        r.delivered_at = at;
        return { changes: BigInt(1) };
      }
      if (q.startsWith('UPDATE outbox SET claimed_by = NULL, claimed_at = NULL, attempts = attempts + 1 WHERE id = ?')) {
        const [id, owner] = p as [string, string];
        const r = rows.find((r) => r.id === id && r.claimed_by === owner);
        if (!r) return { changes: BigInt(0) };
        r.claimed_by = null; r.claimed_at = null; r.attempts += 1;
        return { changes: BigInt(1) };
      }
      if (q.includes('claimed_at < ?')) {
        const [maxAttempts, cutoff] = p as [number, number];
        let n = 0;
        for (const r of rows) {
          if (r.claimed_by !== null && r.delivered_at === null && r.attempts < maxAttempts && (r.claimed_at ?? 0) < cutoff) {
            r.claimed_by = null; r.claimed_at = null; r.attempts += 1; n += 1;
          }
        }
        return { changes: BigInt(n) };
      }
      if (q.includes('WHERE claimed_by = ? AND delivered_at IS NULL')) {
        const [owner] = p as [string];
        let n = 0;
        for (const r of rows) {
          if (r.claimed_by === owner && r.delivered_at === null) {
            r.claimed_by = null; r.claimed_at = null; r.attempts += 1; n += 1;
          }
        }
        return { changes: BigInt(n) };
      }
      if (q.startsWith('DELETE FROM outbox')) {
        const [deliveredCut, maxAttempts, createdCut] = p as [number, number, number];
        const before = rows.length;
        this.store.rows = rows.filter(
          (r) => !((r.delivered_at !== null && r.delivered_at < deliveredCut) || (r.delivered_at === null && r.attempts >= maxAttempts && r.created_at < createdCut))
        );
        return { changes: BigInt(before - this.store.rows.length) };
      }
      return { changes: BigInt(0) };
    }
    all(...p: unknown[]): FakeRow[] {
      const q = this.sql;
      if (q.startsWith('SELECT * FROM outbox')) {
        const [target, limit] = p as [string, number];
        return this.store.rows
          .filter((r) => r.target_session === target && r.claimed_by === null && r.delivered_at === null)
          .sort((a, b) => a.seq - b.seq)
          .slice(0, limit)
          .map((r) => ({ ...r }));
      }
      return [];
    }
    get(...p: unknown[]): { n: number } | undefined {
      const q = this.sql;
      if (q.startsWith('SELECT COUNT(*)')) {
        if (q.includes('target_session IN')) {
          const ids = p as string[];
          return { n: this.store.rows.filter((r) => ids.includes(r.target_session) && r.delivered_at === null).length };
        }
        const [maxAttempts, cutoff] = p as [number, number];
        return { n: this.store.rows.filter((r) => r.delivered_at === null && r.attempts >= maxAttempts && r.created_at < cutoff).length };
      }
      return undefined;
    }
  }
  class FakeDb {
    private store: { rows: FakeRow[]; seq: number; constructed: number };
    constructor(path: string, _options?: { readOnly?: boolean }) {
      this.store = storeFor(path);
      this.store.constructed += 1;
      void _options;
    }
    exec(_sql: string): void {}
    prepare(sql: string): FakeStmt { return new FakeStmt(this.store, sql); }
    query(sql: string): FakeStmt { return new FakeStmt(this.store, sql); }
    close(): void {}
  }
  vi.doMock('bun:sqlite', () => ({ Database: FakeDb }));
  return { constructed: () => [...stores.values()].reduce((n, s) => n + s.constructed, 0) };
}

function forceBunMarker(): () => void {
  const orig = process.versions;
  Object.defineProperty(process, 'versions', { value: { ...orig, bun: '1.3.14' }, configurable: true });
  return () => {
    Object.defineProperty(process, 'versions', { value: orig, configurable: true });
  };
}

describe('cross-runtime pile-up gate', () => {
  it('fork uses the bun leg when the marker is present (mock driver full lifecycle)', async () => {
    const { root, restore } = await freshRoot('mesh-pileup-');
    const restoreMarker = forceBunMarker();
    try {
      vi.resetModules();
      const fake = installFakeBun();
      const ob = await import('../src/outbox.js');
      const { isMsgId } = ob;
      // FIFO triple through the forked (mock bun) leg
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push(await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'build', text: `fifo-${i}` }, root));
        expect(isMsgId(ids[i])).toBe(true);
      }
      const rows = await ob.claim(['ses-T'], 'owner-bun', 5, root);
      expect(rows.map((r) => r.text)).toEqual(['fifo-0', 'fifo-1', 'fifo-2']);
      for (const row of rows) expect(await ob.ack(row.id, 'owner-bun', root)).toBe(true);
      expect(await ob.pendingCount(['ses-T'], root)).toBe(0);
      // No pile-up left for GC to dead-letter
      const gc = await ob.collectOutbox(Date.now(), 1000, 25, root);
      expect(gc).toEqual({ deleted: 0, deadLetter: 0 });
      // Fork proof: the mock bun constructor drove this lifecycle, not node:sqlite.
      expect(fake.constructed()).toBeGreaterThan(0);
    } finally {
      restoreMarker();
      await safeRm(root); restore();
    }
  });

  it('node leg unaffected without the marker (real driver full lifecycle)', async () => {
    const { root, restore } = await freshRoot('mesh-pileupnode-');
    const ob = await import('../src/outbox.js');
    const id = await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'build', text: 'hi' }, root);
    const rows = await ob.claim(['ses-T'], 'owner-node', 1, root);
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(id);
    expect(await ob.ack(id, 'owner-node', root)).toBe(true);
    expect(await ob.pendingCount(['ses-T'], root)).toBe(0);
    await safeRm(root); restore();
  });

  it('both drivers down maps to fail-closed contracts (claim empty, ack false, display narrows)', async () => {
    const { root, restore } = await freshRoot('mesh-pileupdown-');
    const restoreMarker = forceBunMarker();
    try {
      vi.resetModules();
      vi.doMock('bun:sqlite', () => { throw new Error('mutant: no bun driver'); });
      vi.doMock('node:sqlite', () => { throw new Error('mutant: no node driver'); });
      const ob = await import('../src/outbox.js');
      await expect(
        ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root)
      ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      expect(await ob.claim(['ses-T'], 'owner-1', 1, root)).toEqual([]);
      expect(await ob.ack('x', 'owner-1', root)).toBe(false);
      expect(await ob.release('x', 'owner-1', root)).toBe(false);
      expect(await ob.pendingCount(['ses-T'], root)).toBe(0);
      expect(await ob.collectOutbox(Date.now(), 1000, 1, root)).toEqual({ deleted: 0, deadLetter: 0 });
      const d = await import('../src/discovery.js');
      expect(await d.readDbSessions(join(tmpdir(), 'mesh-nope.db'))).toEqual({});
    } finally {
      restoreMarker();
      await safeRm(root); restore();
    }
  });
});
