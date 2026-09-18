// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// DB plus registry plus status join.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi, afterEach } from 'vitest';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch as unknown as typeof fetch;
  vi.resetModules();
  vi.restoreAllMocks();
  delete process.env.OPENCODE_MESH_DB_PATH;
});

async function freshRoot(prefix: string): Promise<{ root: string; restore: () => void }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const prev = process.env.OPENCODE_MESH_ROOT;
  process.env.OPENCODE_MESH_ROOT = root;
  return { root, restore: () => {
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT;
    else process.env.OPENCODE_MESH_ROOT = prev;
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

function fixtureDb(path: string, now: number): void {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, title TEXT, agent TEXT, time_updated INTEGER)');
  const ins = db.prepare('INSERT INTO session VALUES(?,?,?,?,?)');
  ins.run('ses-db-fresh', '/tmp/proj', 'Fresh db work', 'manager', now - 5000);
  ins.run('ses-db-stale', '/tmp/old', 'Stale db work', '', now - 2 * 60 * 60 * 1000);
  db.close();
}

describe('discovery join', () => {
  it('DB ground truth — fresh DB row shows db-truth, stale DB row shows stale, never hides', async () => {
    const { root, restore } = await freshRoot('mesh-dj-db-');
    fixtureDb(join(root, 'fx.db'), Date.now());
    const d = await import('../src/discovery.js');
    const db = await d.readDbSessions(join(root, 'fx.db'));
    expect(Object.keys(db).sort()).toEqual(['ses-db-fresh', 'ses-db-stale']);
    const now = Date.now();
    const vis = d.joinSessions(db, {}, null, now);
    expect(vis['ses-db-fresh']).toBeDefined();
    expect((vis['ses-db-fresh'] as { liveSource: string }).liveSource).toBe('db-truth');
    expect(vis['ses-db-stale']).toBeDefined();
    expect((vis['ses-db-stale'] as { liveSource: string }).liveSource).toBe('stale');
    expect((vis['ses-db-fresh'] as { agent: string }).agent).toBe('manager');
    expect((vis['ses-db-stale'] as { agent: string }).agent).toBe('unknown');
    await safeRm(root); restore();
  });

  it('live confirmation — status presence sets liveSource status', async () => {
    const d = await import('../src/discovery.js');
    const now = Date.now();
    const db = { 'ses-s': { id: 'ses-s', agent: null, directory: '/tmp/p', title: 'T', dbUpdatedAt: now - 1000 } };
    const vis = d.joinSessions(db, {}, { 'ses-s': { type: 'busy' } }, now);
    const e = vis['ses-s'] as { liveSource: string; live: string; status: string };
    expect(e.liveSource).toBe('status');
    expect(e.live).toBe('busy');
    expect(e.status).toBe('busy');
  });

  it('dual grace — just-registered kept inside EVICT_GRACE on success; aged ids show stale, null deletes zero', async () => {
    const d = await import('../src/discovery.js');
    const { EVICT_GRACE_MS, ACTIVE_WINDOW_MS } = await import('../src/constants.js');
    const now = Date.now();
    const reg = {
      'ses-fresh': { sessionId: 'ses-fresh', agent: 'a', updatedAt: now - 5000 },
      'ses-old': { sessionId: 'ses-old', agent: 'a', updatedAt: now - 2 * 60 * 60 * 1000 },
    } as unknown as Parameters<typeof d.joinSessions>[1];
    // successful view missing both: fresh kept via grace, old shows stale (never hides)
    const vis = d.joinSessions({}, reg, { 'ses-else': { type: 'idle' } }, now);
    expect(vis['ses-fresh']).toBeDefined();
    expect((vis['ses-fresh'] as { liveSource: string }).liveSource).toBe('heartbeat-recent');
    expect(vis['ses-old']).toBeDefined();
    expect((vis['ses-old'] as { liveSource: string }).liveSource).toBe('stale');
    expect(EVICT_GRACE_MS).toBe(60 * 1000);
    // null view deletes zero (persistConfirmedDead) and keeps the union with badges
    const { persistConfirmedDead } = await import('../src/registry.js');
    expect(await persistConfirmedDead(null)).toBe(0);
    const visNull = d.joinSessions({}, reg, null, now);
    expect(visNull['ses-fresh']).toBeDefined();
    expect(visNull['ses-old']).toBeDefined();
    expect((visNull['ses-old'] as { liveSource: string }).liveSource).toBe('stale');
    expect(ACTIVE_WINDOW_MS).toBe(10 * 60 * 1000);
  });

  it('metadata precedence — registry agent wins, generic title yields to DB, directory never empty, repo is basename', async () => {
    const d = await import('../src/discovery.js');
    const now = Date.now();
    const db = { 'ses-m': { id: 'ses-m', agent: null, directory: '/tmp/realproj', title: 'Real db title', dbUpdatedAt: now - 1000 } };
    const reg = {
      'ses-m': { sessionId: 'ses-m', agent: 'manager', title: 'New session - 2026-09-03T10:00:00.000Z', updatedAt: now - 1000 },
    } as unknown as Parameters<typeof d.joinSessions>[1];
    const vis = d.joinSessions(db, reg, null, now);
    const e = vis['ses-m'] as Record<string, string>;
    expect(e.agent).toBe('manager');
    expect(e.description).toBe('Real db title');
    expect(e.directory).toBe('/tmp/realproj');
    expect(e.repo).toBe('realproj');
    // registry directory wins over DB directory (production entries always carry
    // title via normalizeEntry, so the kept-text shape names its title)
    const reg2 = {
      'ses-m': { sessionId: 'ses-m', agent: 'manager', title: 'Kept work', description: 'Kept work', directory: '/tmp/regdir', updatedAt: now - 1000 },
    } as unknown as Parameters<typeof d.joinSessions>[1];
    const vis2 = d.joinSessions(db, reg2, null, now);
    expect((vis2['ses-m'] as Record<string, string>).directory).toBe('/tmp/regdir');
    expect((vis2['ses-m'] as Record<string, string>).description).toBe('Kept work');
  });

  it('mesh_peers end to end — fixture DB plus registry plus mocked status', async () => {
    const { root, restore } = await freshRoot('mesh-dj-e2e-');
    const fx = join(root, 'fx.db');
    fixtureDb(fx, Date.now());
    process.env.OPENCODE_MESH_DB_PATH = fx;
    try {
      const { atomicUpdateRegistry } = await import('../src/registry.js');
      await atomicUpdateRegistry((reg: unknown) => {
        (reg as Record<string, unknown>)['ses-reg'] = { sessionId: 'ses-reg', agent: 'a', description: 'Reg work', directory: '/tmp/r', updatedAt: Date.now() };
      }, root);
      globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ 'ses-reg': { type: 'idle' } }) })) as unknown as typeof fetch;
      const { mesh_peers } = await import('../src/tools/mesh_peers.js');
      const out = await (mesh_peers.execute as (...a: never[]) => Promise<{ output: string }>)({ includeSelf: true } as never, { sessionID: 'caller' } as never);
      const j = JSON.parse(out.output) as Record<string, { liveSource: string }>;
      expect(j['ses-reg']?.liveSource).toBe('status');
      expect(j['ses-db-fresh']).toBeDefined();
      expect(j['ses-db-stale']).toBeDefined();
    } finally {
      delete process.env.OPENCODE_MESH_DB_PATH;
    }
    await safeRm(root); restore();
  });

  it('db leg always-on — joinAll shows DB-only rows', async () => {
    const { root, restore } = await freshRoot('mesh-dj-off-');
    const fx = join(root, 'fx.db');
    fixtureDb(fx, Date.now());
    process.env.OPENCODE_MESH_DB_PATH = fx;
    try {
      const d = await import('../src/discovery.js');
      const off = await d.joinAll(root);
      expect(off.peers['ses-db-fresh']).toBeDefined();
      const on = await d.joinAll(root);
      expect(on.peers['ses-db-fresh']).toBeDefined();
    } finally {
      delete process.env.OPENCODE_MESH_DB_PATH;
    }
    await safeRm(root); restore();
  });

  it('opt-in keychain — default graph excludes the provider, env flag owns the gate', async () => {
    delete process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER;
    const { getServerAuthHeaderSync } = await import('../src/serverAuth.js');
    expect(getServerAuthHeaderSync()).toBeUndefined();
  });

  it('registry URL columns stripped on sight, valid or not', async () => {
    const { normalizeEntry } = await import('../src/registry.js');
    const good = normalizeEntry({ sessionId: 's', agent: 'a', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096', servePort: 4096 } as never);
    expect((good as unknown as Record<string, unknown>).serveUrl).toBeUndefined();
    expect((good as unknown as Record<string, unknown>).servePort).toBeUndefined();
    const bad = normalizeEntry({ sessionId: 's', agent: 'a', updatedAt: Date.now(), serveUrl: 'ftp://x', servePort: 'abc' } as never);
    expect((bad as unknown as Record<string, unknown>).serveUrl).toBeUndefined();
    expect((bad as unknown as Record<string, unknown>).servePort).toBeUndefined();
    const bare = normalizeEntry({ sessionId: 's', agent: 'a', updatedAt: Date.now() } as never);
    expect((bare as unknown as Record<string, unknown>).serveUrl).toBeUndefined();
  });

  it('status entry without a type reads live unknown', async () => {
    const now = Date.now();
    const d = await import('../src/discovery.js');
    const reg = { 'ses-t': { sessionId: 'ses-t', agent: 'a', updatedAt: now } } as unknown as Parameters<typeof d.joinSessions>[1];
    const out = d.joinSessions({}, reg, { 'ses-t': {} } as never, now)['ses-t'] as Record<string, unknown>;
    expect(out.live).toBe('unknown');
  });

  it('registry session type survives without a db row', async () => {
    const now = Date.now();
    const d = await import('../src/discovery.js');
    const reg = { 'ses-sub': { sessionId: 'ses-sub', agent: 'a', sessionType: 'subagent', updatedAt: now } } as unknown as Parameters<typeof d.joinSessions>[1];
    const out = d.joinSessions({}, reg, null, now)['ses-sub'] as Record<string, unknown>;
    expect(out.sessionType).toBe('subagent');
  });

  it('tracker lastAction rides the join union', async () => {
    const now = Date.now();
    const d = await import('../src/discovery.js');
    const reg = { 'ses-tr': { sessionId: 'ses-tr', agent: 'a', updatedAt: now } } as unknown as Parameters<typeof d.joinSessions>[1];
    const out = d.joinSessions({}, reg, null, now, { lastAction: { 'ses-tr': now - 100 } })['ses-tr'] as Record<string, unknown>;
    expect(out.lastActionAt).toBe(now - 100);
  });

  it('entry without timestamps reads ageSec zero', async () => {
    const now = Date.now();
    const d = await import('../src/discovery.js');
    const reg = { 'ses-nt': { sessionId: 'ses-nt', agent: 'a' } } as unknown as Parameters<typeof d.joinSessions>[1];
    const out = d.joinSessions({}, reg, null, now)['ses-nt'] as Record<string, unknown>;
    expect(out.ageSec).toBe(0);
  });

  it('snapshot tier — joinSessions badges attached ids from the extra inlet', async () => {
    const now = Date.now();
    const d = await import('../src/discovery.js');
    const db = {
      'ses-a': { id: 'ses-a', agent: null, directory: '/tmp/p', title: 'A work', dbUpdatedAt: now - 1000 },
      'ses-b': { id: 'ses-b', agent: null, directory: '/tmp/p', title: 'B work', dbUpdatedAt: now - 1000 },
    };
    const vis = d.joinSessions(db, {}, null, now, { attached: ['ses-a'] });
    expect((vis['ses-a'] as Record<string, unknown>).attached).toBe(true);
    expect((vis['ses-b'] as Record<string, unknown>).attached).toBe(false);
  });

  it('snapshot tier — registry marker alone still badges without the extra inlet', async () => {
    const now = Date.now();
    const d = await import('../src/discovery.js');
    const reg = {
      'ses-r': { sessionId: 'ses-r', agent: 'a', attached: true, updatedAt: now },
    } as unknown as Parameters<typeof d.joinSessions>[1];
    const vis = d.joinSessions({}, reg, null, now);
    expect((vis['ses-r'] as Record<string, unknown>).attached).toBe(true);
  });

  it('snapshot tier — unknown attached id adds no row, never hides', async () => {
    const now = Date.now();
    const d = await import('../src/discovery.js');
    const db = {
      'ses-keep': { id: 'ses-keep', agent: null, directory: '/tmp/p', title: 'Kept work', dbUpdatedAt: now - 1000 },
    };
    const vis = d.joinSessions(db, {}, null, now, { attached: ['ses-ghost'] });
    expect(vis['ses-ghost']).toBeUndefined();
    expect(vis['ses-keep']).toBeDefined();
  });

  it('snapshot tier — joinAll threads a fresh snapshot into a DB-only row', async () => {
    const { root, restore } = await freshRoot('mesh-dj-att-');
    const fx = join(root, 'fx.db');
    const now = Date.now();
    const db = new DatabaseSync(fx);
    db.exec('CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, title TEXT, agent TEXT, time_updated INTEGER)');
    db.prepare('INSERT INTO session VALUES(?,?,?,?,?)').run('ses-att-live', '/tmp/proj', 'Live work', 'manager', now - 5000);
    db.close();
    process.env.OPENCODE_MESH_DB_PATH = fx;
    try {
      const a = await import('../src/attach.js');
      const d = await import('../src/discovery.js');
      await a.pollAttachOnce({ meshRoot: root, psText: 'u 1 0:00 opencode -s ses-att-live\n', statusMap: {} });
      const out = await d.joinAll(root);
      expect((out.peers['ses-att-live'] as Record<string, unknown>).attached).toBe(true);
    } finally {
      delete process.env.OPENCODE_MESH_DB_PATH;
    }
    await safeRm(root); restore();
  });

  it('snapshot tier — stale snapshot degrades to registry markers, row stays', async () => {
    const { root, restore } = await freshRoot('mesh-dj-stale-');
    const fx = join(root, 'fx.db');
    const now = Date.now();
    const db = new DatabaseSync(fx);
    db.exec('CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, title TEXT, agent TEXT, time_updated INTEGER)');
    db.prepare('INSERT INTO session VALUES(?,?,?,?,?)').run('ses-att-live', '/tmp/proj', 'Live work', 'manager', now - 5000);
    db.close();
    process.env.OPENCODE_MESH_DB_PATH = fx;
    try {
      const a = await import('../src/attach.js');
      const d = await import('../src/discovery.js');
      const snap = await a.pollAttachOnce({ meshRoot: root, psText: 'u 1 0:00 opencode -s ses-att-live\n', statusMap: {} });
      vi.spyOn(Date, 'now').mockReturnValue(snap.at + d.ATTACH_SNAPSHOT_MAX_AGE_MS + 1);
      const out = await d.joinAll(root);
      expect(out.peers['ses-att-live']).toBeDefined();
      expect((out.peers['ses-att-live'] as Record<string, unknown>).attached).toBe(false);
    } finally {
      delete process.env.OPENCODE_MESH_DB_PATH;
    }
    await safeRm(root); restore();
  });
});
