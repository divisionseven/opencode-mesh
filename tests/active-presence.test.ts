// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Active-only presence: display shows live-confirmed ids;
// confirmed-dead ids are deleted on three helper-routed paths (tick, GC, peers persist).
// Locks (1, 2, 3b, 3c, 5) pass before and after; true-red (3a, 4) fail before, pass after.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';

const origFetch = globalThis.fetch;
const ENV_KEYS = ['OPENCODE_MESH_ROOT', 'OPENCODE_MESH_DB_PATH', 'OPENCODE_PORT', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_MESH_KEYCHAIN_PROVIDER'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.OPENCODE_SERVER_PASSWORD;
  delete process.env.OPENCODE_SERVER_USERNAME;
  delete process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER;
  delete process.env.OPENCODE_PORT;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = origFetch as unknown as typeof fetch;
  vi.resetModules();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// File-level containment: OPENCODE_MESH_ROOT points at temp for the whole
// file duration, so a missed tick after a per-test restore still lands in
// temp. Per-test freshRoot isolation is unchanged.
let fileGuardRoot = '';
let fileGuardPrev: string | undefined;
beforeAll(async () => {
  fileGuardPrev = process.env.OPENCODE_MESH_ROOT;
  fileGuardRoot = await mkdtemp(join(tmpdir(), 'mesh-ap-file-'));
  process.env.OPENCODE_MESH_ROOT = fileGuardRoot;
});
afterAll(async () => {
  if (fileGuardPrev === undefined) delete process.env.OPENCODE_MESH_ROOT;
  else process.env.OPENCODE_MESH_ROOT = fileGuardPrev;
  if (fileGuardRoot) await rm(fileGuardRoot, { recursive: true, force: true });
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

async function seed(root: string, entries: Record<string, number>): Promise<void> {
  const { atomicUpdateRegistry } = await import('../src/registry.js');
  const now = Date.now();
  await atomicUpdateRegistry((reg: any) => {
    for (const [id, age] of Object.entries(entries))
      reg[id] = { sessionId: id, agent: 'tester', model: 'myprov/my-model', description: `Title ${id}`, directory: '/tmp/x', updatedAt: now - age } as any;
  }, root);
}

async function disk(root: string): Promise<Record<string, any>> {
  const { readRegistry } = await import('../src/registry.js');
  return (await readRegistry(root)) as unknown as Record<string, any>;
}

// The tick's async body (dynamic import + flocked file I/O) can lag the fake
// clock under parallel load; poll on real timers until the predicate holds.
async function pollDisk(root: string, id: string, pred: (e: any) => boolean, timeoutMs = 8000): Promise<any> {
  const start = Date.now();
  let entry: any;
  for (;;) {
    entry = (await disk(root))[id];
    if (pred(entry)) return entry;
    if (Date.now() - start > timeoutMs) return entry;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function fakeClient(statusImpl: () => Promise<unknown>): unknown {
  return { session: { get: async () => ({}), status: statusImpl } };
}

async function loadPlugin(client: unknown): Promise<any> {
  vi.resetModules();
  const m = await import('../plugin/opencode-mesh.js');
  return await (m.default as any)({ client });
}

function okStatus(map: unknown) {
  return vi.fn(async (url: string) => {
    if (String(url).includes('/session/status')) return { ok: true, status: 200, json: async () => map } as unknown as Response;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

function rejectFetch() {
  return (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
}

const created = (id: string, title = 'Real Title') => ({ event: { type: 'session.created', properties: { info: { id, agent: 'tester', directory: '/tmp/x', title } } } });
const deleted = (id: string) => ({ event: { type: 'session.deleted', properties: { info: { id } } } });

describe('active presence', () => {
  it('1 graceful end — holds: session.deleted unconditionally removes the entry', async () => {
    const { root, restore } = await freshRoot('mesh-ap1-');
    await seed(root, { 'ses-dead': 1000 });
    const hooks = await loadPlugin(fakeClient(async () => ({})));
    await hooks.event(deleted('ses-dead'));
    expect((await disk(root))['ses-dead']).toBeUndefined();
    await hooks.dispose();
    await safeRmArmed(root); restore();
  });

  it('2a dispose fail-closed — holds: rejecting status keeps the own entry', async () => {
    const { root, restore } = await freshRoot('mesh-ap2a-');
    const hooks = await loadPlugin(fakeClient(async () => { throw new Error('down'); }));
    await hooks.event(created('ses-own'));
    await hooks.dispose();
    expect((await disk(root))['ses-own']).toBeDefined();
    await safeRmArmed(root); restore();
  });

  it('2b dispose scope — holds: foreign ids survive a successful dispose view', async () => {
    const { root, restore } = await freshRoot('mesh-ap2b-');
    await seed(root, { 'ses-own': 1000, 'ses-foreign': 1000 });
    const hooks = await loadPlugin(fakeClient(async () => ({ 'ses-own': { type: 'idle' } })));
    await hooks.event(created('ses-own'));
    await hooks.dispose();
    const reg = await disk(root);
    expect(reg['ses-own']).toBeDefined();
    expect(reg['ses-foreign']).toBeDefined();
    await safeRmArmed(root); restore();
  });

  // NOTE (timing flake): parallel-load sensitive — tick async body + flocked I/O
  // can lag under parallel load; serial gate — no threshold change without reviewer approval.
  it('3a heartbeat evict — fails-before: absent own sid older than grace is deleted', async () => {
    vi.useFakeTimers();
    const { root, restore } = await freshRoot('mesh-ap3a-');
    const hooks = await loadPlugin(fakeClient(async () => ({ 'ses-other': { type: 'idle' } })));
    await hooks.event(created('ses-tick-a'));
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    const now = Date.now();
    await atomicUpdateRegistry((reg: any) => { reg['ses-tick-a'].updatedAt = now - 10 * 60 * 1000; }, root);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 500);
    vi.useRealTimers();
    expect(await pollDisk(root, 'ses-tick-a', (e) => e === undefined)).toBeUndefined();
    await hooks.dispose();
    await safeRmArmed(root); restore();
  });

  // NOTE (timing flake): parallel-load sensitive — tick async body + flocked I/O
  // can lag under parallel load; serial gate — no threshold change without reviewer approval.
  it('3b heartbeat null — holds: rejecting status takes the heartbeat path and keeps', { timeout: 20000 }, async () => {
    vi.useFakeTimers();
    const { root, restore } = await freshRoot('mesh-ap3b-');
    const hooks = await loadPlugin(fakeClient(async () => { throw new Error('down'); }));
    await hooks.event(created('ses-tick-b'));
    const t0 = (await disk(root))['ses-tick-b'].updatedAt;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 500);
    vi.useRealTimers();
    const entry = await pollDisk(root, 'ses-tick-b', (e) => e && e.updatedAt > t0);
    expect(entry).toBeDefined();
    expect(entry.updatedAt).toBeGreaterThan(t0);
    await hooks.dispose();
    await safeRmArmed(root); restore();
  });

  it('3c heartbeat grace — holds: absent sid refreshed inside the grace window is kept', async () => {
    vi.useFakeTimers();
    const { root, restore } = await freshRoot('mesh-ap3c-');
    const hooks = await loadPlugin(fakeClient(async () => ({ 'ses-other': { type: 'idle' } })));
    await hooks.event(created('ses-tick-c'));
    // touch 10s before the 5m tick so the entry is inside the 60s grace window when the tick joins
    await vi.advanceTimersByTimeAsync(290 * 1000);
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    const t = Date.now();
    await atomicUpdateRegistry((reg: any) => { reg['ses-tick-c'].updatedAt = t - 10 * 1000; }, root);
    await vi.advanceTimersByTimeAsync(15 * 1000);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 50));
    expect((await disk(root))['ses-tick-c']).toBeDefined();
    await hooks.dispose();
    await safeRmArmed(root); restore();
  });

  it('4a gc join — fails-before: confirmed-dead pruned, live kept, both status shapes', async () => {
    const { root, restore } = await freshRoot('mesh-ap4a-');
    await seed(root, { 'ses-live': 1000, 'ses-dead': 2 * 60 * 60 * 1000 });
    globalThis.fetch = okStatus({ 'ses-live': { type: 'idle' } });
    const { runGc } = await import('../src/gc.js');
    const res = await runGc(root);
    expect(res.prunedLive).toBe(1);
    const reg = await disk(root);
    expect(reg['ses-live']).toBeDefined();
    expect(reg['ses-dead']).toBeUndefined();
    const { fetchSessionStatusMap } = await import('../src/registry.js');
    globalThis.fetch = okStatus({ data: { 'ses-w': { type: 'busy' } } });
    expect(await fetchSessionStatusMap()).toEqual({ 'ses-w': { type: 'busy' } });
    globalThis.fetch = okStatus({ 'ses-r': { type: 'idle' } });
    expect(await fetchSessionStatusMap()).toEqual({ 'ses-r': { type: 'idle' } });
    globalThis.fetch = rejectFetch();
    expect(await fetchSessionStatusMap()).toBeNull();
    await safeRm(root); restore();
  });

  it('4b gc fail-closed — fails-before: unreachable status keeps in-TTL ids, prunedLive 0', async () => {
    const { root, restore } = await freshRoot('mesh-ap4b-');
    await seed(root, { 'ses-a': 1000, 'ses-old': 2 * 60 * 60 * 1000 });
    globalThis.fetch = rejectFetch();
    const { runGc } = await import('../src/gc.js');
    const res = await runGc(root);
    expect(res.prunedLive).toBe(0);
    const reg = await disk(root);
    expect(reg['ses-a']).toBeDefined();
    expect(reg['ses-old']).toBeDefined();
    await safeRm(root); restore();
  });

  it('4c peers never-hides — fails-before: union display with badges, display never deletes', async () => {
    const { root, restore } = await freshRoot('mesh-ap4c-');
    await seed(root, { 'ses-live': 5000, 'ses-fresh': 5000, 'ses-dead': 2 * 60 * 60 * 1000 });
    const { mesh_peers } = await import('../src/tools/mesh_peers.js');
    globalThis.fetch = rejectFetch();
    let j = JSON.parse((await (mesh_peers.execute as any)({ includeSelf: true }, { sessionID: 'caller-x' })).output);
    let peers = j.peers ?? j;
    expect(peers['ses-live'].liveSource).toBe('heartbeat-recent');
    expect(peers['ses-dead'].liveSource).toBe('stale');
    globalThis.fetch = okStatus({ 'ses-live': { type: 'idle' } });
    j = JSON.parse((await (mesh_peers.execute as any)({ includeSelf: true }, { sessionID: 'caller-x' })).output);
    peers = j.peers ?? j;
    expect(peers['ses-live'].liveSource).toBe('status');
    expect(peers['ses-fresh'].liveSource).toBe('heartbeat-recent');
    expect(peers['ses-dead'].liveSource).toBe('stale');
    expect((await disk(root))['ses-dead']).toBeDefined();
    await safeRm(root); restore();
  });

  it('4d multi-port ambiguity — fails-before: disjoint live views delete zero, liveSkipped set', async () => {
    process.env.OPENCODE_PORT = '5001';
    vi.resetModules();
    const { root, restore } = await freshRoot('mesh-ap4d-');
    await seed(root, { 'ses-p1': 2 * 60 * 60 * 1000, 'ses-p2': 2 * 60 * 60 * 1000 });
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes(':5001/')) return { ok: true, status: 200, json: async () => ({ 'ses-p1': { type: 'idle' } }) } as unknown as Response;
      if (u.includes(':4096/')) return { ok: true, status: 200, json: async () => ({ 'ses-p2': { type: 'idle' } }) } as unknown as Response;
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { runGc } = await import('../src/gc.js');
    const res = await runGc(root);
    expect(res.prunedLive).toBe(0);
    expect(res.liveSkipped).toBeDefined();
    const reg = await disk(root);
    expect(reg['ses-p1']).toBeDefined();
    expect(reg['ses-p2']).toBeDefined();
    delete process.env.OPENCODE_PORT;
    vi.resetModules();
    await safeRm(root); restore();
  });

  it('5 send consistency — holds: stored-but-gone id 404s with didYouMean', async () => {
    const { root, restore } = await freshRoot('mesh-ap5-');
    await seed(root, { 'ses-gone': 2 * 60 * 60 * 1000 });
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      ((reg as Record<string, Record<string, unknown>>)['ses-gone'] as Record<string, unknown>).serveUrl = 'http://127.0.0.1:4096';
    }, root);
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      if (u.includes('/prompt_async')) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const err = await (mesh_send.execute as any)({ target: 'ses-gone', text: 'hi' }, { sessionID: 'ses-caller', directory: '/tmp' }).catch((e: any) => e);
    expect(err?.code).toBe('PEER_NOT_FOUND');
    expect(err?.status).toBe(404);
    expect(err?.didYouMean?.length).toBeGreaterThan(0);
    await safeRm(root); restore();
  });

  it('probe queues stored-but-gone without a model instead of POST-404ing', async () => {
    const { root, restore } = await freshRoot('mesh-ap5-mutant-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['ses-gone'] = { sessionId: 'ses-gone', agent: 'tester', description: 'Title ses-gone', directory: '/tmp/x', updatedAt: Date.now() };
    }, root);
    const posted: string[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      if (u.includes('/prompt_async')) {
        posted.push(u);
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      String((await (mesh_send.execute as any)({ target: 'ses-gone', text: 'hi' }, { sessionID: 'ses-caller', directory: '/tmp' })).output),
    ) as { via: string };
    expect(posted).toEqual([]);
    expect(out.via).toBe('queued');
    await safeRm(root); restore();
  });
});
