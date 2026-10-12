// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Restart adoption: database-fresh sessions rejoin ownership at setup and
// on the shared tick, so a server restart never strands queued rows with no
// claimant. Existing rows keep their identity (heartbeat only); missing rows
// are inserted from the database triple; stale rows and over-cap rows stay
// out. Given a seeded session database, when adoption passes run, then the
// id sets match recency exactly.
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { ACTIVE_WINDOW_MS } from '../src/constants.js';
import { adoptDbSessions } from '../src/adopt.js';

vi.mock('../src/claimer.js', () => ({
  configureClaimer: vi.fn(),
  ensureClaimer: vi.fn(),
  clearClaimerTimer: vi.fn(),
  releaseClaimerOwner: vi.fn(async () => {}),
}));

vi.mock('../src/attach.js', () => ({
  startAttachPoller: vi.fn(),
  stopAttachPoller: vi.fn(),
  pollAttachOnce: vi.fn(async () => {}),
  getAttachSnapshot: vi.fn(() => null),
}));

afterEach(() => {
  vi.clearAllMocks();
});

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
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      throw err;
    }
  }
}

function seedDb(
  dbPath: string,
  rows: Array<{
    id: string;
    agent: string | null;
    directory: string | null;
    title: string | null;
    updated: number;
    parent?: string | null;
  }>,
): void {
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE session(id TEXT PRIMARY KEY, agent TEXT, directory TEXT, title TEXT, time_updated INTEGER, parent_id TEXT)',
  );
  const ins = db.prepare(
    'INSERT INTO session VALUES(?,?,?,?,?,?)',
  );
  for (const r of rows) {
    ins.run(r.id, r.agent, r.directory, r.title, r.updated, r.parent ?? null);
  }
  db.close();
}

function pointDb(dbPath: string): () => void {
  const prev = process.env.OPENCODE_MESH_DB_PATH;
  process.env.OPENCODE_MESH_DB_PATH = dbPath;
  return () => {
    if (prev === undefined) delete process.env.OPENCODE_MESH_DB_PATH;
    else process.env.OPENCODE_MESH_DB_PATH = prev;
  };
}

async function readEntry(id: string) {
  const { readRegistry } = await import('../src/registry.js');
  const reg = (await readRegistry()) as unknown as Record<
    string,
    Record<string, unknown>
  >;
  return reg[id];
}

describe('restart adoption', () => {
  it('fresh rows missing from the registry are inserted with identity', async () => {
    const { root, restore } = await freshRoot('v2adopt-');
    const dbPath = join(root, 'live.db');
    seedDb(dbPath, [
      {
        id: 'ses-fresh',
        agent: 'alfred',
        directory: '/tmp/adopted',
        title: 'Adopted work',
        updated: Date.now(),
      },
    ]);
    const unpoint = pointDb(dbPath);
    const pass = await adoptDbSessions();
    expect(pass.adopted).toEqual(['ses-fresh']);
    expect(pass.heartbeated).toEqual([]);
    expect(pass.skipped).toBe(0);
    const row = (await readEntry('ses-fresh')) as Record<string, unknown>;
    expect(row.agent).toBe('alfred');
    expect(row.directory).toBe('/tmp/adopted');
    expect(row.repo).toBe('adopted');
    expect(row.title).toBe('Adopted work');
    expect(row.sessionType).toBe('primary');
    unpoint();
    await safeRm(root);
    restore();
  });

  it('stale rows stay out', async () => {
    const { root, restore } = await freshRoot('v2adopt-stale-');
    const dbPath = join(root, 'live.db');
    seedDb(dbPath, [
      {
        id: 'ses-old',
        agent: 'alfred',
        directory: '/tmp/old',
        title: 'Old work',
        updated: Date.now() - ACTIVE_WINDOW_MS - 1000,
      },
    ]);
    const unpoint = pointDb(dbPath);
    const pass = await adoptDbSessions();
    expect(pass.adopted).toEqual([]);
    expect(await readEntry('ses-old')).toBeUndefined();
    unpoint();
    await safeRm(root);
    restore();
  });

  it('known rows keep identity and only heartbeat', async () => {
    const { root, restore } = await freshRoot('v2adopt-known-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: Record<string, unknown>) => {
      reg['ses-kept'] = {
        sessionId: 'ses-kept',
        agent: 'build',
        directory: '/tmp/kept',
        description: 'Kept title',
        updatedAt: Date.now() - 60_000,
      };
    });
    const before = (
      (await readEntry('ses-kept')) as Record<string, unknown>
    ).updatedAt as number;
    const dbPath = join(root, 'live.db');
    seedDb(dbPath, [
      {
        id: 'ses-kept',
        agent: 'other',
        directory: '/tmp/other',
        title: 'Other title',
        updated: Date.now(),
      },
    ]);
    const unpoint = pointDb(dbPath);
    const pass = await adoptDbSessions();
    expect(pass.adopted).toEqual([]);
    expect(pass.heartbeated).toEqual(['ses-kept']);
    const row = (await readEntry('ses-kept')) as Record<string, unknown>;
    expect(row.agent).toBe('build');
    expect(row.directory).toBe('/tmp/kept');
    expect(row.description).toBe('Kept title');
    expect(Number(row.updatedAt)).toBeGreaterThanOrEqual(before);
    unpoint();
    await safeRm(root);
    restore();
  });

  it('over-cap fresh rows report skipped', async () => {
    const { root, restore } = await freshRoot('v2adopt-cap-');
    const dbPath = join(root, 'live.db');
    const now = Date.now();
    seedDb(
      dbPath,
      Array.from({ length: 5 }, (_, i) => ({
        id: `ses-cap-${i}`,
        agent: 'a',
        directory: null,
        title: null,
        updated: now - i * 1000,
      })),
    );
    const unpoint = pointDb(dbPath);
    const pass = await adoptDbSessions({ limit: 3 });
    expect(pass.adopted).toHaveLength(3);
    expect(pass.skipped).toBe(2);
    unpoint();
    await safeRm(root);
    restore();
  });

  it('absent database reads empty without throwing', async () => {
    const { root, restore } = await freshRoot('v2adopt-miss-');
    const unpoint = pointDb(join(root, 'missing.db'));
    await expect(adoptDbSessions()).resolves.toEqual({
      adopted: [],
      heartbeated: [],
      skipped: 0,
    });
    unpoint();
    await safeRm(root);
    restore();
  });
});

describe('v2 table union', () => {
  it('session_v2 rows adopt with identity', async () => {
    const { root, restore } = await freshRoot('v2adopt-v2t-');
    const dbPath = join(root, 'live.db');
    const db = new DatabaseSync(dbPath);
    db.exec(
      'CREATE TABLE session_v2(id TEXT PRIMARY KEY, agent TEXT, directory TEXT, title TEXT, time_updated INTEGER, parent_id TEXT)',
    );
    db.prepare('INSERT INTO session_v2 VALUES(?,?,?,?,?,?)').run(
      'ses-v2only',
      'alfred',
      '/tmp/v2only',
      'V2 work',
      Date.now(),
      null,
    );
    db.close();
    const unpoint = pointDb(dbPath);
    const pass = await adoptDbSessions();
    expect(pass.adopted).toEqual(['ses-v2only']);
    const row = (await readEntry('ses-v2only')) as Record<string, unknown>;
    expect(row.agent).toBe('alfred');
    expect(row.directory).toBe('/tmp/v2only');
    unpoint();
    await safeRm(root);
    restore();
  });

  it('triple resolves from session_v2 with a JSON model cell', async () => {
    const { root, restore } = await freshRoot('v2adopt-v2triple-');
    const dbPath = join(root, 'live.db');
    const db = new DatabaseSync(dbPath);
    db.exec(
      'CREATE TABLE session_v2(id TEXT PRIMARY KEY, agent TEXT, model TEXT)',
    );
    db.prepare('INSERT INTO session_v2(id, agent, model) VALUES(?,?,?)').run(
      'ses-v2triple',
      'alfred',
      JSON.stringify({ providerID: 'acme', id: 'reasoner' }),
    );
    db.close();
    const unpoint = pointDb(dbPath);
    const { readDbTripleDetailed } = await import('../src/discovery.js');
    const r = await readDbTripleDetailed('ses-v2triple');
    expect(r).toEqual({
      ok: true,
      triple: {
        agent: 'alfred',
        model: JSON.stringify({ providerID: 'acme', id: 'reasoner' }),
      },
    });
    unpoint();
    await safeRm(root);
    restore();
  });

  it('part table feeds message recency', async () => {
    const { root, restore } = await freshRoot('v2adopt-recency-');
    const dbPath = join(root, 'live.db');
    const db = new DatabaseSync(dbPath);
    db.exec(
      'CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)',
    );
    const now = Date.now();
    db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(
      'part-1',
      'msg-1',
      'ses-part',
      now,
      now,
      '{}',
    );
    db.close();
    const unpoint = pointDb(dbPath);
    const { clearRecencyCache, readMessageRecency } = await import(
      '../src/discovery.js'
    );
    clearRecencyCache();
    try {
      expect((await readMessageRecency())['ses-part']).toBe(now);
    } finally {
      clearRecencyCache();
      unpoint();
      await safeRm(root);
      restore();
    }
  });

  it('cached recency survives database removal', async () => {
    const { root, restore } = await freshRoot('v2adopt-recache-');
    const dbPath = join(root, 'live.db');
    const db = new DatabaseSync(dbPath);
    db.exec(
      'CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)',
    );
    const now = Date.now();
    db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(
      'part-1',
      'msg-1',
      'ses-cached',
      now,
      now,
      '{}',
    );
    db.close();
    const unpoint = pointDb(dbPath);
    const { clearRecencyCache, readMessageRecency } = await import(
      '../src/discovery.js'
    );
    clearRecencyCache();
    try {
      expect((await readMessageRecency())['ses-cached']).toBe(now);
      await rm(dbPath, { force: true });
      expect((await readMessageRecency())['ses-cached']).toBe(now);
    } finally {
      clearRecencyCache();
      unpoint();
      await safeRm(root);
      restore();
    }
  });

  it('send union skips recency while display keeps it', async () => {
    const { root, restore } = await freshRoot('v2adopt-skip-');
    const dbPath = join(root, 'live.db');
    const db = new DatabaseSync(dbPath);
    db.exec(
      'CREATE TABLE session(id TEXT PRIMARY KEY, agent TEXT, directory TEXT, title TEXT, time_updated INTEGER, parent_id TEXT)',
    );
    const old = Date.now() - 5_000;
    db.prepare('INSERT INTO session VALUES(?,?,?,?,?,?)').run(
      'ses-skip',
      'a',
      '/tmp/s',
      'T',
      old,
      null,
    );
    db.exec(
      'CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)',
    );
    const fresh = Date.now();
    db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(
      'part-1',
      'msg-1',
      'ses-skip',
      fresh,
      fresh,
      '{}',
    );
    db.close();
    const unpoint = pointDb(dbPath);
    const { clearRecencyCache, joinAll } = await import('../src/discovery.js');
    clearRecencyCache();
    try {
      const shown = await joinAll();
      const skipped = await joinAll(undefined, { withRecency: false });
      const shownAt = (shown.peers['ses-skip'] as { lastActionAt: number })
        .lastActionAt;
      const skippedAt = (skipped.peers['ses-skip'] as { lastActionAt: number })
        .lastActionAt;
      expect(shownAt).toBe(fresh);
      expect(skippedAt).toBe(old);
    } finally {
      clearRecencyCache();
      unpoint();
      await safeRm(root);
      restore();
    }
  });
});

describe('setup adoption joins the owned union', () => {
  it('first setup owns database-fresh ids with no manual touch', async () => {
    const { root, restore } = await freshRoot('v2adopt-setup-');
    const dbPath = join(root, 'live.db');
    seedDb(dbPath, [
      {
        id: 'ses-revived',
        agent: 'alfred',
        directory: '/tmp/revived',
        title: 'Revived work',
        updated: Date.now(),
      },
    ]);
    const unpoint = pointDb(dbPath);
    const ctx = {
      session: { get: async () => ({}) },
      location: { directory: root },
      tool: {
        transform: async () => ({ dispose: async () => {} }),
        list: async () => [
          { id: 'mesh_register' },
          { id: 'mesh_peers' },
          { id: 'mesh_send' },
          { id: 'mesh_broadcast' },
        ],
        hook: async () => ({ dispose: async () => {} }),
        reload: async () => {},
      },
      event: {
        subscribe: async function* () {},
      },
      skill: {
        transform: async () => ({ dispose: async () => {} }),
        reload: async () => {},
        list: async () => [],
      },
    };
    const mod = await import('../plugin/opencode-mesh-v2.js');
    const cleanup = await (
      mod.default as unknown as {
        setup: (c: unknown) => Promise<() => Promise<void>>;
      }
    ).setup(ctx);
    const { v2OwnedIds } = await import('../src/v2singleflight.js');
    expect(v2OwnedIds()).toContain('ses-revived');
    await cleanup();
    unpoint();
    await safeRm(root);
    restore();
  });
});
