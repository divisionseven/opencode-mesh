// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Attach-first ordering plus per-level
// scoring plus per-type expiry plus docs gates, one row per rated case.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, afterEach, vi } from 'vitest';

const origFetch = globalThis.fetch;
const ENV_KEYS = ['OPENCODE_MESH_ROOT', 'OPENCODE_MESH_DB_PATH', 'MESH_TTL_OVERRIDES_JSON', 'MESH_SUBAGENT_TTL_MS', 'MESH_PRIMARY_TTL_MS'] as const;
let savedEnv: Record<string, string | undefined> = {};
function saveEnv(): void {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
}
function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}
afterEach(() => {
  globalThis.fetch = origFetch as unknown as typeof fetch;
  vi.resetModules();
  vi.restoreAllMocks();
  vi.useRealTimers();
  restoreEnv();
});

async function freshRoot(prefix: string): Promise<{ root: string; restore: () => void }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  saveEnv();
  process.env.OPENCODE_MESH_ROOT = root;
  process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
  delete process.env.MESH_TTL_OVERRIDES_JSON;
  delete process.env.MESH_SUBAGENT_TTL_MS;
  delete process.env.MESH_PRIMARY_TTL_MS;
  return { root, restore: () => {} };
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

const DRAIN_POLL_MS = 50;
const DRAIN_BUDGET_MS = 2000;
async function safeRmArmed(root: string): Promise<void> {
  const deadline = Date.now() + DRAIN_BUDGET_MS;
  for (;;) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if ((code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
        continue;
      }
      throw err;
    }
  }
}

function rejectFetch(): typeof fetch {
  return (async () => { throw new Error('unreachable'); }) as unknown as typeof fetch;
}
function okStatus(map: unknown): typeof fetch {
  return (async (url: string) => {
    if (String(url).includes('/session/status')) return { ok: true, status: 200, json: async () => map };
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
}
async function seed(root: string, entries: Record<string, Record<string, unknown>>): Promise<void> {
  const { atomicUpdateRegistry } = await import('../src/registry.js');
  await atomicUpdateRegistry((reg: unknown) => {
    for (const [id, e] of Object.entries(entries)) (reg as Record<string, unknown>)[id] = e;
  }, root);
}
async function peersOf(args: unknown): Promise<Record<string, Record<string, unknown>>> {
  const { mesh_peers } = await import('../src/tools/mesh_peers.js');
  const out = await (mesh_peers.execute as (...a: never[]) => Promise<{ output: string }>)(
    args as never, { sessionID: 'caller-x' } as never
  );
  const j = JSON.parse(out.output) as Record<string, unknown>;
  return ((j as { peers?: Record<string, Record<string, unknown>> }).peers ?? j) as Record<string, Record<string, unknown>>;
}
function orderOf(peers: Record<string, Record<string, unknown>>): string[] {
  return Object.entries(peers).sort((a, b) => Number(a[1].rank ?? 0) - Number(b[1].rank ?? 0)).map(([id]) => id);
}

describe('decision-tree ordering (rank-last)', () => {
  it('attached id outside the queried directory ranks first, both ids present', async () => {
    const { root, restore } = await freshRoot('mesh-t1-');
    const now = Date.now();
    await seed(root, {
      'ses-detached-in': { sessionId: 'ses-detached-in', agent: 'a', description: 'Work', directory: '/tmp/proj', updatedAt: now, lastActionAt: now },
      'ses-attached-out': { sessionId: 'ses-attached-out', agent: 'a', description: 'Work', directory: '/tmp/elsewhere', updatedAt: now, attached: true, lastActionAt: now - 1000 },
    });
    globalThis.fetch = rejectFetch();
    const peers = await peersOf({ includeSelf: true, cwd: '/tmp/proj' });
    expect(Object.keys(peers).sort()).toEqual(['ses-attached-out', 'ses-detached-in']);
    expect(orderOf(peers)[0]).toBe('ses-attached-out');
    await safeRm(root); restore();
  });

  it('exact outranks ancestor outranks basename outranks miss, miss stays listed', async () => {
    const { root, restore } = await freshRoot('mesh-t2-');
    const now = Date.now();
    await seed(root, {
      'ses-miss': { sessionId: 'ses-miss', agent: 'a', description: 'Work', directory: '/tmp/other', updatedAt: now, lastActionAt: now },
      'ses-base': { sessionId: 'ses-base', agent: 'a', description: 'Work', directory: '/tmp/x/proj', updatedAt: now, lastActionAt: now },
      'ses-anc': { sessionId: 'ses-anc', agent: 'a', description: 'Work', directory: '/tmp/proj/sub', updatedAt: now, lastActionAt: now },
      'ses-exact': { sessionId: 'ses-exact', agent: 'a', description: 'Work', directory: '/tmp/proj', updatedAt: now, lastActionAt: now },
    });
    globalThis.fetch = rejectFetch();
    const peers = await peersOf({ includeSelf: true, cwd: '/tmp/proj' });
    expect(orderOf(peers)).toEqual(['ses-exact', 'ses-anc', 'ses-base', 'ses-miss']);
    await safeRm(root); restore();
  });

  it('agent score applies inside the directory order, non-match stays present', async () => {
    const { root, restore } = await freshRoot('mesh-t3-');
    const now = Date.now();
    await seed(root, {
      'ses-nomatch': { sessionId: 'ses-nomatch', agent: 'worker', description: 'Work', directory: '/tmp/proj', updatedAt: now, lastActionAt: now },
      'ses-match': { sessionId: 'ses-match', agent: 'manager', description: 'Work', directory: '/tmp/proj', updatedAt: now, lastActionAt: now },
    });
    globalThis.fetch = rejectFetch();
    const peers = await peersOf({ includeSelf: true, cwd: '/tmp/proj', agent: 'manager' });
    expect(orderOf(peers)).toEqual(['ses-match', 'ses-nomatch']);
    await safeRm(root); restore();
  });

  it('busy outranks newer idle; stamp order beats raw time_updated', async () => {
    const { root, restore } = await freshRoot('mesh-t4-');
    const now = Date.now();
    await seed(root, {
      // Idle id whose session-table time is NEWER but whose stamp is OLDER.
      'ses-idle-newrow': { sessionId: 'ses-idle-newrow', agent: 'a', description: 'Work', directory: '/tmp/p', updatedAt: now - 1000, lastActionAt: now - 3600 * 1000 },
      'ses-busy-old': { sessionId: 'ses-busy-old', agent: 'a', description: 'Work', directory: '/tmp/p', updatedAt: now - 1000, lastActionAt: now - 7200 * 1000 },
      'ses-idle-stamped': { sessionId: 'ses-idle-stamped', agent: 'a', description: 'Work', directory: '/tmp/p', updatedAt: now - 7200 * 1000, lastActionAt: now - 2000 },
    });
    globalThis.fetch = okStatus({ 'ses-busy-old': { type: 'busy' } });
    const peers = await peersOf({ includeSelf: true });
    const order = orderOf(peers);
    // Busy exemption first even with the oldest stamp.
    expect(order[0]).toBe('ses-busy-old');
    // Stamp order beats raw row time among idle ids (M-time kills this).
    expect(order.indexOf('ses-idle-stamped')).toBeLessThan(order.indexOf('ses-idle-newrow'));
    await safeRm(root); restore();
  });

  it('non-generic match outranks, generic scores zero, miss stays listed', async () => {
    const { root, restore } = await freshRoot('mesh-t5-');
    const now = Date.now();
    await seed(root, {
      'ses-miss': { sessionId: 'ses-miss', agent: 'a', description: 'Unrelated chore', directory: '/tmp/p', updatedAt: now, lastActionAt: now },
      'ses-generic': { sessionId: 'ses-generic', agent: 'a', description: 'New session - 2026-09-04T10:00:00.000Z', directory: '/tmp/p', updatedAt: now, lastActionAt: now },
      'ses-hit': { sessionId: 'ses-hit', agent: 'a', description: 'Refactoring auth', directory: '/tmp/p', updatedAt: now, lastActionAt: now },
    });
    globalThis.fetch = rejectFetch();
    const peers = await peersOf({ includeSelf: true, description: 'Refactoring' });
    const order = orderOf(peers);
    expect(order[0]).toBe('ses-hit');
    expect(order).toContain('ses-miss');
    // Generic-title zero weight: generic ranks with the miss, never with the hit (M-title kills this).
    expect(order.indexOf('ses-generic')).toBeGreaterThan(0);
    await safeRm(root); restore();
  });

  it('compat: old-style filtered query returns the full union ordered best-first', async () => {
    const { root, restore } = await freshRoot('mesh-compat-');
    const now = Date.now();
    await seed(root, {
      'ses-best': { sessionId: 'ses-best', agent: 'manager', description: 'Refactoring auth', directory: '/tmp/dotfiles', updatedAt: now, lastActionAt: now },
      'ses-out1': { sessionId: 'ses-out1', agent: 'worker', description: 'Docs', directory: '/tmp/site', updatedAt: now, lastActionAt: now },
      'ses-out2': { sessionId: 'ses-out2', agent: 'manager', description: 'Unrelated', directory: '/tmp/other', updatedAt: now, lastActionAt: now },
    });
    globalThis.fetch = rejectFetch();
    const peers = await peersOf({ includeSelf: true, agent: 'manager', description: 'refactoring', repo: 'dotfiles' });
    expect(Object.keys(peers).length).toBe(3);
    expect(orderOf(peers)[0]).toBe('ses-best');
    await safeRm(root); restore();
  });
});

describe('per-type expiry boundaries', () => {
  it('T7a subagent 29min stays; T7b subagent 31min expires with audit (M-single needs both)', async () => {
    const ex = await import('../src/expiry.js');
    const now = Date.now();
    const young = ex.evaluateExpiry({ sessionType: 'subagent', agent: 'w', attached: false, statusType: null, lastActionAt: now - 29 * 60 * 1000, now });
    const old = ex.evaluateExpiry({ sessionType: 'subagent', agent: 'w', attached: false, statusType: null, lastActionAt: now - 31 * 60 * 1000, now });
    expect(young.state).toBe('live');
    expect(old.state).toBe('expired');
    const { root, restore } = await freshRoot('mesh-t7-');
    await seed(root, { 'ses-sub-old': { sessionId: 'ses-sub-old', agent: 'w', updatedAt: now - 31 * 60 * 1000, lastActionAt: now - 31 * 60 * 1000, sessionType: 'subagent' } });
    const n = await ex.deleteExpiredWithAudit(['ses-sub-old'], { reason: 'ttl-past', ttlClass: 'subagent', override: false }, root);
    expect(n).toBe(1);
    const { readRegistry } = await import('../src/registry.js');
    expect((await readRegistry(root))['ses-sub-old']).toBeUndefined();
    await safeRm(root); restore();
  });

  it('primary 25h and 47h stay live-badged while 49h expires', async () => {
    const ex = await import('../src/expiry.js');
    const d = await import('../src/discovery.js');
    const now = Date.now();
    expect(ex.evaluateExpiry({ sessionType: 'primary', attached: false, statusType: null, lastActionAt: now - 25 * 60 * 60 * 1000, now }).state).toBe('live');
    expect(ex.evaluateExpiry({ sessionType: 'primary', attached: false, statusType: null, lastActionAt: now - 47 * 60 * 60 * 1000, now }).state).toBe('live');
    expect(ex.evaluateExpiry({ sessionType: 'primary', attached: false, statusType: null, lastActionAt: now - 49 * 60 * 60 * 1000, now }).state).toBe('expired');
    // 25h idle primary badges stale yet stays: inside the 48h primary TTL, past the 24h display window.
    const db = { 'ses-25h': { id: 'ses-25h', agent: 'a', directory: '/tmp/p', title: 'Work', dbUpdatedAt: now - 25 * 60 * 60 * 1000 } };
    const vis = d.joinSessions(db, {}, null, now);
    expect((vis['ses-25h'] as { liveSource: string }).liveSource).toBe('stale');
    expect(vis['ses-25h']).toBeDefined();
  });

  it('attached id past every TTL stays', async () => {
    const ex = await import('../src/expiry.js');
    const now = Date.now();
    const v = ex.evaluateExpiry({ sessionType: 'subagent', attached: true, statusType: null, lastActionAt: now - 30 * 24 * 60 * 60 * 1000, now });
    expect(v.state).toBe('attached');
    expect(v.reason).toBe('attached-exempt');
    const { root, restore } = await freshRoot('mesh-t10-');
    await seed(root, { 'ses-att': { sessionId: 'ses-att', agent: 'w', updatedAt: now - 30 * 24 * 60 * 60 * 1000, lastActionAt: now - 30 * 24 * 60 * 60 * 1000, sessionType: 'subagent', attached: true } });
    const { readRegistry } = await import('../src/registry.js');
    const reg = (await readRegistry(root)) as unknown as Record<string, unknown>;
    expect(ex.collectExpired(reg, { now })).toEqual([]);
    await safeRm(root); restore();
  });

  it('T10b 59s stays attached; T10c 61s transitions on a successful view', async () => {
    const { root, restore } = await freshRoot('mesh-t10bc-');
    const now = Date.now();
    const at = await import('../src/attach.js');
    await seed(root, {
      'ses-59': { sessionId: 'ses-59', agent: 'w', updatedAt: now, attached: true, attachedAt: now - 59 * 1000 },
      'ses-61': { sessionId: 'ses-61', agent: 'w', updatedAt: now, attached: true, attachedAt: now - 61 * 1000 },
    });
    await at.pollAttachOnce({ meshRoot: root, psText: '', statusMap: {} });
    const { readRegistry } = await import('../src/registry.js');
    const reg = (await readRegistry(root)) as unknown as Record<string, Record<string, unknown>>;
    expect(reg['ses-59'].attached).toBe(true);
    expect(reg['ses-61'].attached).toBe(false);
    await safeRm(root); restore();
  });

  it('quiet attached id with old stamp stays live-attached', async () => {
    const ex = await import('../src/expiry.js');
    const d = await import('../src/discovery.js');
    const now = Date.now();
    const v = ex.evaluateExpiry({ sessionType: 'primary', attached: true, statusType: 'idle', lastActionAt: now - 40 * 60 * 1000, now });
    expect(v.state).toBe('attached');
    const reg = { 'ses-quiet': { sessionId: 'ses-quiet', agent: 'a', updatedAt: now - 40 * 60 * 1000, attached: true } } as unknown as Parameters<typeof d.joinSessions>[1];
    const vis = d.joinSessions({}, reg, null, now);
    expect((vis['ses-quiet'] as { attached: boolean }).attached).toBe(true);
  });

  it('per-agent override governs members, defaults govern the rest', async () => {
    const { root, restore } = await freshRoot('mesh-t12-');
    saveEnv();
    process.env.MESH_TTL_OVERRIDES_JSON = JSON.stringify({ special: 60 * 1000 });
    const ex = await import('../src/expiry.js');
    const now = Date.now();
    const member = ex.evaluateExpiry({ sessionType: 'subagent', agent: 'special', attached: false, statusType: null, lastActionAt: now - 90 * 1000, now });
    const outsider = ex.evaluateExpiry({ sessionType: 'subagent', agent: 'plain', attached: false, statusType: null, lastActionAt: now - 90 * 1000, now });
    expect(member.state).toBe('expired');
    expect(member.override).toBe(true);
    expect(outsider.state).toBe('live');
    expect(outsider.override).toBe(false);
    restoreEnv();
    await safeRm(root); restore();
  });

  it('attached-exempt beats busy-exempt beats override beats type-default', async () => {
    const ex = await import('../src/expiry.js');
    const now = Date.now();
    saveEnv();
    process.env.MESH_TTL_OVERRIDES_JSON = JSON.stringify({ vip: 60 * 1000 });
    const both = ex.evaluateExpiry({ sessionType: 'subagent', agent: 'vip', attached: true, statusType: 'busy', lastActionAt: now - 10 * 60 * 1000, now });
    expect(both.reason).toBe('attached-exempt');
    const busyBeatsOverride = ex.evaluateExpiry({ sessionType: 'subagent', agent: 'vip', attached: false, statusType: 'busy', lastActionAt: now - 10 * 60 * 1000, now });
    expect(busyBeatsOverride.reason).toBe('busy-exempt');
    expect(ex.precedenceIndex('attached-exempt')).toBeLessThan(ex.precedenceIndex('busy-exempt'));
    expect(ex.precedenceIndex('busy-exempt')).toBeLessThan(ex.precedenceIndex('override'));
    expect(ex.precedenceIndex('override')).toBeLessThan(ex.precedenceIndex('type-default'));
    expect(ex.precedenceIndex('type-default')).toBeLessThan(ex.precedenceIndex('dampening-hold'));
    restoreEnv();
  });

  it('T14a 4min normal; T14b 6min suspends plus re-anchors then resumes (M-jump)', async () => {
    const ex = await import('../src/expiry.js');
    const now = Date.now();
    const idle: Parameters<typeof ex.evaluateExpiry>[0] = { sessionType: 'subagent', attached: false, statusType: null, lastActionAt: now - 31 * 60 * 1000, now };
    ex.noteForwardJump(now, 4 * 60 * 1000);
    expect(ex.isDampeningHold(now)).toBe(false);
    expect(ex.evaluateExpiry(idle).state).toBe('expired');
    ex.noteForwardJump(now, 6 * 60 * 1000);
    expect(ex.isDampeningHold(now)).toBe(true);
    expect(ex.evaluateExpiry(idle).state).toBe('live');
    expect(ex.evaluateExpiry(idle).reason).toBe('dampening-hold');
    // Next cycle past one poller window resumes normal evaluation.
    const { ATTACH_POLL_MS } = await import('../src/constants.js');
    expect(ex.isDampeningHold(now + ATTACH_POLL_MS + 1000)).toBe(false);
    expect(ex.evaluateExpiry({ ...idle, now: now + ATTACH_POLL_MS + 1000 }).state).toBe('expired');
  });
});

describe('oracle plus tracker mechanics', () => {
  it('ps parse: -s rows attach, serve rows skip, grep self-skips', async () => {
    const at = await import('../src/attach.js');
    const text = [
      'tb_mini 72291 93.2 3.2 opencode -s ses_aaa111',
      'tb_mini 64684 86.7 2.9 opencode',
      'tb_mini 19002 1.0 0.7 /opt/homebrew/bin/opencode serve --port 4096',
      'tb_mini 85796 0.0 0.0 grep -i opencode',
      'tb_mini 78415 85.8 2.6 opencode -s ses_bbb222',
    ].join('\n');
    const ps = at.parsePsAttach(text);
    expect(ps.ids.sort()).toEqual(['ses_aaa111', 'ses_bbb222']);
    expect(ps.unmapped).toBe(1);
  });

  it('bare row surfaces a count, creates zero ids, deletes zero', async () => {
    const { root, restore } = await freshRoot('mesh-t15-');
    const now = Date.now();
    await seed(root, { 'ses-kept': { sessionId: 'ses-kept', agent: 'w', updatedAt: now } });
    const at = await import('../src/attach.js');
    const snap = await at.pollAttachOnce({ meshRoot: root, psText: 'tb_mini 64684 86.7 opencode\n', statusMap: null });
    expect(snap.unmapped).toBe(1);
    expect(snap.attached).toEqual([]);
    const { readRegistry } = await import('../src/registry.js');
    expect(Object.keys(await readRegistry(root)).sort()).toEqual(['ses-kept']);
    await safeRm(root); restore();
  });

  it('attached records carry the unknown focus marker', async () => {
    const { root, restore } = await freshRoot('mesh-t16-');
    const now = Date.now();
    await seed(root, { 'ses-live1': { sessionId: 'ses-live1', agent: 'w', updatedAt: now } });
    const at = await import('../src/attach.js');
    await at.pollAttachOnce({ meshRoot: root, psText: 'tb_mini 1 0.0 opencode -s ses-live1\n', statusMap: null });
    const { readRegistry } = await import('../src/registry.js');
    const reg = (await readRegistry(root)) as unknown as Record<string, Record<string, unknown>>;
    expect(reg['ses-live1'].attached).toBe(true);
    expect(reg['ses-live1'].focus).toBe(at.ATTACH_FOCUS_UNKNOWN);
    expect(reg['ses-live1'].focus).toBe('unknown');
    await safeRm(root); restore();
  });

  it('old-schema: store without parent_id yields the full union, every type primary', async () => {
    const { root, restore } = await freshRoot('mesh-oldschema-');
    const fx = join(root, 'legacy.db');
    const db = new DatabaseSync(fx);
    db.exec('CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, title TEXT, agent TEXT, time_updated INTEGER)');
    const ins = db.prepare('INSERT INTO session VALUES(?,?,?,?,?)');
    const now = Date.now();
    ins.run('ses-leg1', '/tmp/a', 'Legacy work', 'manager', now - 1000);
    ins.run('ses-leg2', '/tmp/b', 'More legacy', '', now - 2000);
    db.close();
    const d = await import('../src/discovery.js');
    const map = await d.readDbSessions(fx);
    expect(Object.keys(map).sort()).toEqual(['ses-leg1', 'ses-leg2']);
    expect(map['ses-leg1'].sessionType).toBe('primary');
    expect(map['ses-leg2'].sessionType).toBe('primary');
    await safeRm(root); restore();
  });

  it('message leg: freshest message time joins the last-action union at display time', async () => {
    const { root, restore } = await freshRoot('mesh-msgleg-');
    const fx = join(root, 'msg.db');
    const db = new DatabaseSync(fx);
    const now = Date.now();
    db.exec('CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, title TEXT, agent TEXT, time_updated INTEGER, parent_id TEXT)');
    db.prepare('INSERT INTO session VALUES(?,?,?,?,?,?)').run('ses-m1', '/tmp/a', 'Work', 'manager', now - 3600 * 1000, null);
    db.exec('CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER)');
    db.prepare('INSERT INTO message VALUES(?,?,?,?)').run('msg_1', 'ses-m1', now - 5000, now - 5000);
    db.close();
    const d = await import('../src/discovery.js');
    const recency = await d.readMessageRecency(fx);
    expect(recency['ses-m1']).toBeGreaterThan(now - 60 * 1000);
    const sessions = await d.readDbSessions(fx);
    expect(sessions['ses-m1'].sessionType).toBe('primary');
    const vis = d.joinSessions(sessions, {}, null, now, { messageRecency: recency });
    expect((vis['ses-m1'] as { lastActionAt: number }).lastActionAt).toBeGreaterThan(now - 60 * 1000);
    await safeRm(root); restore();
  });

  it('stamp-drop: tracker write throwing under updated plus tool firings completes with zero throw', async () => {
    vi.resetModules();
    vi.doMock('../src/lastAction.js', () => ({
      isBusyActive: () => false,
      clampLastAction: (a: number, b: number) => Math.max(a, b),
      isForwardJump: () => false,
      readLastActionAt: () => null,
      stampLastAction: async () => { throw new Error('mutant: tracker down'); },
      noteBusyActive: async () => {},
    }));
    const { root, restore } = await freshRoot('mesh-stampdrop-');
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const hooks = await (pluginMod.default as unknown as (...a: never[]) => Promise<Record<string, (...a: never[]) => Promise<unknown>>>)({ client: { session: { get: async () => ({}), status: async () => ({}) } } } as never);
    const sid = 'ses-drop1';
    await (hooks['tool.execute.before'] as (...a: never[]) => Promise<unknown>)({ sessionID: sid, agent: 'w', directory: tmpdir() } as never);
    await (hooks.event as (...a: never[]) => Promise<unknown>)({ event: { type: 'session.updated', properties: { info: { id: sid, title: 'Real work', agent: 'boss' } } } } as never);
    const { readRegistry } = await import('../src/registry.js');
    expect((await readRegistry(root))[sid]).toBeDefined();
    vi.doUnmock('../src/lastAction.js');
    await hooks.dispose();
    await safeRmArmed(root); restore();
  });

  it('stamp-clamp: backward wall-clock move keeps the max stamp', async () => {
    const { root, restore } = await freshRoot('mesh-clamp-');
    const now = Date.now();
    await seed(root, { 'ses-c1': { sessionId: 'ses-c1', agent: 'w', updatedAt: now } });
    const la = await import('../src/lastAction.js');
    await la.stampLastAction('ses-c1', { at: now, meshRoot: root });
    await la.stampLastAction('ses-c1', { at: now - 3600 * 1000, meshRoot: root });
    const { readRegistry } = await import('../src/registry.js');
    const reg = (await readRegistry(root)) as unknown as Record<string, Record<string, unknown>>;
    expect(reg['ses-c1'].lastActionAt).toBe(now);
    expect(la.clampLastAction(now - 5000, now - 9000)).toBe(now - 5000);
    await safeRm(root); restore();
  });
});

describe('docs plus single-source gates', () => {
  // SKILL and single-source tests removed: AGENTS.md bans source-text grep/count assertions from vitest

  it('TTL values plus env overrides resolve', async () => {
    const c = await import('../src/constants.js');
    expect(c.SUBAGENT_TTL_MS).toBe(30 * 60 * 1000);
    expect(c.PRIMARY_TTL_MS).toBe(48 * 60 * 60 * 1000);
    expect(c.ATTACH_POLL_MS).toBe(60 * 1000);
    expect(c.LAST_ACTION_DAMPEN_MS).toBe(5 * 60 * 1000);
    expect(c.ATTACH_GONE_GRACE_MS).toBe(60 * 1000);
    saveEnv();
    process.env.MESH_SUBAGENT_TTL_MS = '60000';
    expect(c.resolveSubagentTtlMs()).toBe(60000);
    process.env.MESH_SUBAGENT_TTL_MS = 'junk';
    expect(c.resolveSubagentTtlMs()).toBe(c.SUBAGENT_TTL_MS);
    restoreEnv();
  });

  it('primary TTL override reads an integer and falls back on garbage', async () => {
    const c = await import('../src/constants.js');
    saveEnv();
    process.env.MESH_PRIMARY_TTL_MS = '60000';
    expect(c.resolvePrimaryTtlMs()).toBe(60000);
    process.env.MESH_PRIMARY_TTL_MS = 'abc';
    expect(c.resolvePrimaryTtlMs()).toBe(c.PRIMARY_TTL_MS);
    restoreEnv();
  });

  it('malformed overrides JSON reads empty', async () => {
    const { root, restore } = await freshRoot('mesh-exp-malformed-');
    process.env.MESH_TTL_OVERRIDES_JSON = 'not-json{{{';
    const { readTtlOverrides } = await import('../src/expiry.js');
    expect(readTtlOverrides()).toEqual({});
    await safeRm(root); restore();
  });

  it('non-object overrides read empty', async () => {
    const { root, restore } = await freshRoot('mesh-exp-nonobj-');
    const { readTtlOverrides } = await import('../src/expiry.js');
    process.env.MESH_TTL_OVERRIDES_JSON = '"just-a-string"';
    expect(readTtlOverrides()).toEqual({});
    process.env.MESH_TTL_OVERRIDES_JSON = '[1,2]';
    expect(readTtlOverrides()).toEqual({});
    await safeRm(root); restore();
  });

  it('per-agent override wins the verdict with the override reason', async () => {
    const { root, restore } = await freshRoot('mesh-exp-override-');
    process.env.MESH_TTL_OVERRIDES_JSON = '{"builder":999999999}';
    const { evaluateExpiry } = await import('../src/expiry.js');
    const now = Date.now();
    const v = evaluateExpiry({ sessionType: 'subagent', agent: 'builder', attached: false, lastActionAt: now - 1000, now });
    expect(v.state).toBe('live');
    expect(v.reason).toBe('override');
    expect(v.override).toBe(true);
    await safeRm(root); restore();
  });

  it('collectExpired honors an explicit now with busy exemption', async () => {
    const { root, restore } = await freshRoot('mesh-exp-busy-');
    const { collectExpired } = await import('../src/expiry.js');
    const now = Date.now();
    const reg = { 'ses-busy': { sessionId: 'ses-busy', agent: 'a', updatedAt: now - 49 * 60 * 60 * 1000 } };
    expect(collectExpired(reg as Record<string, unknown>, { now, statusTypeOf: () => 'busy' })).toEqual([]);
    await safeRm(root); restore();
  });

  it('collectExpired with an idle lookup expires past the TTL', async () => {
    const { root, restore } = await freshRoot('mesh-exp-idle-');
    const { collectExpired } = await import('../src/expiry.js');
    const now = Date.now();
    const reg = { 'ses-idle': { sessionId: 'ses-idle', agent: 'a', updatedAt: now - 49 * 60 * 60 * 1000 } };
    expect(collectExpired(reg as Record<string, unknown>, { now, statusTypeOf: () => null })).toEqual(['ses-idle']);
    await safeRm(root); restore();
  });

  it('collectExpired covers sparse entries and the default clock', async () => {
    const { root, restore } = await freshRoot('mesh-exp-sparse-');
    const { collectExpired } = await import('../src/expiry.js');
    const now = Date.now();
    const reg = {
      'ses-noagent': { sessionId: 'ses-noagent', updatedAt: now },
      'ses-sub': { sessionId: 'ses-sub', agent: 'a', sessionType: 'subagent', updatedAt: now },
      'ses-notime': { sessionId: 'ses-notime', agent: 'a' },
    };
    const found = collectExpired(reg as Record<string, unknown>, { now });
    expect(found).toContain('ses-notime');
    expect(collectExpired(reg as Record<string, unknown>)).toBeDefined();
    await safeRm(root); restore();
  });

  it('deleteExpiredWithAudit with zero ids resolves zero', async () => {
    const { root, restore } = await freshRoot('mesh-exp-zero-');
    const { deleteExpiredWithAudit } = await import('../src/expiry.js');
    expect(await deleteExpiredWithAudit([], { reason: 't', ttlClass: 'primary', override: false }, root)).toBe(0);
    await safeRm(root); restore();
  });

  it('deleteExpiredWithAudit deletes and audits the override class', async () => {
    const { root, restore } = await freshRoot('mesh-exp-del-');
    const now = Date.now();
    await seed(root, { 'ses-gone': { sessionId: 'ses-gone', agent: 'a', updatedAt: now - 49 * 60 * 60 * 1000 } });
    const { deleteExpiredWithAudit } = await import('../src/expiry.js');
    const n = await deleteExpiredWithAudit(['ses-gone'], { reason: 'ttl', ttlClass: 'primary', override: true }, root);
    expect(n).toBe(1);
    const { readRegistry } = await import('../src/registry.js');
    expect('ses-gone' in ((await readRegistry(root)) as Record<string, unknown>)).toBe(false);
    await safeRm(root); restore();
  });

  it('deleteExpiredWithAudit resolves zero when the write throws', async () => {
    const { root, restore } = await freshRoot('mesh-exp-throw-');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'registry.json'));
    const { deleteExpiredWithAudit } = await import('../src/expiry.js');
    expect(await deleteExpiredWithAudit(['ses-x'], { reason: 't', ttlClass: 'primary', override: false }, root)).toBe(0);
    await safeRm(root); restore();
  });

  it('parsePsAttach reads empty output as empty', async () => {
    const { parsePsAttach } = await import('../src/attach.js');
    expect(parsePsAttach('')).toEqual({ ids: [], unmapped: 0 });
  });

  it('parsePsAttach skips grep and serve rows and counts bare rows', async () => {
    const { parsePsAttach } = await import('../src/attach.js');
    const out = parsePsAttach([
      'u 100 0:00 opencode -s ses-a',
      'u 101 0:00 opencode -s ses-a',
      'u 102 0:00 grep opencode',
      'u 103 0:00 opencode serve --port 4096',
      'u 104 0:00 /usr/bin/opencode --version',
      'u 105 0:00 other daemon',
    ].join('\n'));
    expect(out.ids).toEqual(['ses-a']);
    expect(out.unmapped).toBe(1);
  });

  it('pollAttachOnce with a null seam view reads the ps set alone', async () => {
    const { root, restore } = await freshRoot('mesh-att-nullview-');
    const { pollAttachOnce } = await import('../src/attach.js');
    const snap = await pollAttachOnce({ meshRoot: root, psText: 'u 1 0:00 opencode -s ses-ps', statusMap: null });
    expect(snap.attached).toEqual(['ses-ps']);
    await safeRm(root); restore();
  });

  it('pollAttachOnce leaves a status-only id out of the ps set', async () => {
    const { root, restore } = await freshRoot('mesh-att-union-');
    const { pollAttachOnce } = await import('../src/attach.js');
    const snap = await pollAttachOnce({
      meshRoot: root,
      psText: 'u 1 0:00 opencode -s ses-ps',
      statusMap: { 'ses-ps': { type: 'idle' }, 'ses-tcp': { type: 'idle' } },
    });
    expect(snap.attached).toEqual(['ses-ps']);
    await safeRm(root); restore();
  });

  it('pollAttachOnce drops a throwing status seam without throwing', async () => {
    const { root, restore } = await freshRoot('mesh-att-throwseam-');
    const { pollAttachOnce } = await import('../src/attach.js');
    const opts = { meshRoot: root, psText: 'u 1 0:00 opencode -s ses-ps' } as Record<string, unknown>;
    Object.defineProperty(opts, 'statusMap', { get() { throw new Error('seam blew up'); }, enumerable: true });
    const snap = await pollAttachOnce(opts as never);
    expect(snap.attached).toEqual(['ses-ps']);
    await safeRm(root); restore();
  });

  it('pollAttachOnce without seams reads live ps plus a failing fetch', async () => {
    const { root, restore } = await freshRoot('mesh-att-live-');
    const { pollAttachOnce } = await import('../src/attach.js');
    const snap = await pollAttachOnce({ meshRoot: root });
    expect(Array.isArray(snap.attached)).toBe(true);
    expect(typeof snap.unmapped).toBe('number');
    await safeRm(root); restore();
  });

  it('pollAttachOnce without seams ignores a live status view', async () => {
    const { root, restore } = await freshRoot('mesh-att-tcpview-');
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ 'ses-tcp': { type: 'idle' } }) })) as unknown as typeof fetch;
    const { pollAttachOnce } = await import('../src/attach.js');
    const snap = await pollAttachOnce({ meshRoot: root, psText: '' });
    expect(snap.attached).toEqual([]);
    await safeRm(root); restore();
  });

  it('pollAttachOnce with a null ps seam reads empty', async () => {
    const { root, restore } = await freshRoot('mesh-att-nullps-');
    const { pollAttachOnce } = await import('../src/attach.js');
    const snap = await pollAttachOnce({ meshRoot: root, psText: null as unknown as string, statusMap: {} });
    expect(snap.attached).toEqual([]);
    await safeRm(root); restore();
  });

  it('pollAttachOnce marks attach and clears past the gone grace', async () => {
    const { root, restore } = await freshRoot('mesh-att-trans-');
    const now = Date.now();
    await seed(root, {
      'ses-live': { sessionId: 'ses-live', agent: 'a', updatedAt: now },
      'ses-gone': { sessionId: 'ses-gone', agent: 'a', updatedAt: now - 1000, attached: true },
    });
    const { pollAttachOnce } = await import('../src/attach.js');
    const { readRegistry } = await import('../src/registry.js');
    await pollAttachOnce({ meshRoot: root, psText: 'u 1 0:00 opencode -s ses-live', statusMap: { 'ses-live': { type: 'idle' } } });
    expect(((await readRegistry(root)) as any)['ses-live'].attached).toBe(true);
    await pollAttachOnce({ meshRoot: root, psText: '', statusMap: {} });
    expect(((await readRegistry(root)) as any)['ses-gone'].attached).toBe(false);
    await safeRm(root); restore();
  });

  it('pollAttachOnce skips registry-unknown observed ids', async () => {
    const { root, restore } = await freshRoot('mesh-att-ghost-');
    const now = Date.now();
    await seed(root, { 'ses-keep': { sessionId: 'ses-keep', agent: 'a', updatedAt: now, attached: true, attachedAt: now } });
    const { pollAttachOnce } = await import('../src/attach.js');
    const snap = await pollAttachOnce({ meshRoot: root, psText: 'u 1 0:00 opencode -s ses-ghost', statusMap: {} });
    expect(snap.attached).toEqual(['ses-ghost']);
    const { readRegistry } = await import('../src/registry.js');
    const reg = (await readRegistry(root)) as Record<string, unknown>;
    expect('ses-ghost' in reg).toBe(false);
    expect((reg['ses-keep'] as { attached?: boolean }).attached).toBe(true);
    await safeRm(root); restore();
  });

  it('pollAttachOnce drops a persist failure without throwing', async () => {
    const { root, restore } = await freshRoot('mesh-att-persist-');
    const now = Date.now();
    await seed(root, { 'ses-held': { sessionId: 'ses-held', agent: 'a', updatedAt: now, attached: true, attachedAt: now } });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'registry.json.lock'), `${process.pid}:${Date.now()}`);
    const { pollAttachOnce } = await import('../src/attach.js');
    const snap = await pollAttachOnce({ meshRoot: root, psText: '', statusMap: {} });
    expect(snap.attached).toEqual([]);
    await safeRm(root); restore();
  }, 60_000);

  it('pollAttachOnce with a non-string seam resolves the empty snapshot', async () => {
    const { root, restore } = await freshRoot('mesh-att-badseam-');
    const { pollAttachOnce } = await import('../src/attach.js');
    const snap = await pollAttachOnce({ meshRoot: root, psText: 12345 as unknown as string });
    expect(snap).toMatchObject({ attached: [], unmapped: 0 });
    await safeRm(root); restore();
  });

  it('attach poller double-start is a no-op with teardown', async () => {
    const { startAttachPoller, stopAttachPoller } = await import('../src/attach.js');
    startAttachPoller();
    startAttachPoller();
    stopAttachPoller();
    stopAttachPoller();
  });

  it('stampLastAction on an unknown id resolves with zero locks', async () => {
    const { root, restore } = await freshRoot('mesh-lastact-');
    const { stampLastAction } = await import('../src/lastAction.js');
    await expect(stampLastAction('ghost-id', { meshRoot: root })).resolves.toBeUndefined();
    const { readRegistry } = await import('../src/registry.js');
    expect('ghost-id' in ((await readRegistry(root)) as Record<string, unknown>)).toBe(false);
    await safeRm(root); restore();
  });

  it('stampLastAction on a known id persists the max stamp', async () => {
    const { root, restore } = await freshRoot('mesh-lastact-known-');
    const now = Date.now();
    await seed(root, { 'ses-stamp': { sessionId: 'ses-stamp', agent: 'a', updatedAt: now } });
    const { stampLastAction } = await import('../src/lastAction.js');
    await stampLastAction('ses-stamp', { at: now + 5000, meshRoot: root });
    const { readRegistry } = await import('../src/registry.js');
    expect(((await readRegistry(root)) as any)['ses-stamp'].lastActionAt).toBe(now + 5000);
    await safeRm(root); restore();
  });

  it('stampLastAction drops a contended write without throwing', async () => {
    const { root, restore } = await freshRoot('mesh-lastact-locked-');
    const now = Date.now();
    await seed(root, { 'ses-locked': { sessionId: 'ses-locked', agent: 'a', updatedAt: now } });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'registry.json.lock'), `${process.pid}:${Date.now()}`);
    const { stampLastAction } = await import('../src/lastAction.js');
    await expect(stampLastAction('ses-locked', { meshRoot: root })).resolves.toBeUndefined();
    await safeRm(root); restore();
  }, 60_000);

  it('status-only ids never attach, ps ids do', async () => {
    const { root, restore } = await freshRoot('mesh-attach-psonly-');
    const { pollAttachOnce } = await import('../src/attach.js');
    const snap = await pollAttachOnce({
      meshRoot: root,
      psText: 'user 123 opencode -s ses-ps',
      statusMap: { 'ses-ps': { type: 'idle' }, 'ses-statusonly': { type: 'idle' } },
    });
    expect(snap.attached).toEqual(['ses-ps']);
    await safeRm(root); restore();
  });
});
