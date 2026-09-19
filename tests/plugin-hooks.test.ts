// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Plugin hook uncovered-branch legs (coverage 90 floor).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { EVICT_GRACE_MS, HEARTBEAT_INTERVAL_MS } from '../src/constants.js';

const GENERIC = 'New session - 2026-09-02T00:20:17.077Z';

const origFetch = globalThis.fetch;
const fsCtl = { exists: null as null | ((...a: never[]) => boolean) };

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (...args: never[]) => (fsCtl.exists ? fsCtl.exists(...args) : (actual.existsSync as (...a: never[]) => boolean)(...args)),
  };
});

afterEach(() => {
  globalThis.fetch = origFetch as unknown as typeof fetch;
  fsCtl.exists = null;
  vi.useRealTimers();
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

function scriptedClient() {
  let statusMap: unknown = {};
  const injected: unknown[] = [];
  const client = {
    session: {
      status: async () => statusMap,
      promptAsync: async (o: unknown) => { injected.push(o); return {}; },
    },
  };
  return { client, injected, setStatus: (m: unknown) => { statusMap = m; } };
}

type Hooks = {
  event: (e: unknown) => Promise<unknown>;
  dispose: () => Promise<void>;
  config: (c: unknown) => Promise<void>;
  tool: Record<string, { execute: (a: unknown, b: unknown) => Promise<unknown> }>;
};

async function init(client: unknown): Promise<Hooks> {
  vi.resetModules();
  const pluginMod = await import('../plugin/opencode-mesh.js');
  const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Hooks>)({ client });
  const { clearClaimerTimer } = await import('../src/claimer.js');
  const { stopAttachPoller } = await import('../src/attach.js');
  clearClaimerTimer();
  stopAttachPoller();
  return hooks;
}

function created(id: string, info?: Record<string, unknown>) {
  return { event: { type: 'session.created', properties: { info: { id, ...info } } } };
}

// Tick drive: one heartbeat interval plus a small overrun so the interval
// fires exactly once even with scheduling jitter.
const TICK_ADVANCE_MS = HEARTBEAT_INTERVAL_MS + 1000;
// Evict backdate: past the grace window with 120s margin so the evict leg is
// unambiguous even if the clock wobbles a few seconds under load.
const EVICT_BACKDATE_MS = EVICT_GRACE_MS + 120_000;

// Tick flush: drain promise chain on fake timers, then drop to real timers.
// Switching first orphans the chain and races assertions.
async function flushTick(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 1500));
}

describe('plugin heartbeat tick legs', () => {
  it('empty status view reads unknown and keeps heartbeating', async () => {
    const { root, restore } = await freshRoot('mesh-ph-empty-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    vi.useFakeTimers();
    try {
      const { client, setStatus } = scriptedClient();
      setStatus({});
      const hooks = await init(client);
      await hooks.event(created('ses-hb', { directory: '/tmp/x', agent: 'beta', title: 'Work' }));
      const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
      const backdated = Date.now() - EVICT_GRACE_MS;
      await atomicUpdateRegistry((reg: any) => { reg['ses-hb'].updatedAt = backdated; }, root);
      await vi.advanceTimersByTimeAsync(TICK_ADVANCE_MS);
      await flushTick();
      // Why: the tick's heartbeat write rides real fs IO and can land
      // after the fixed flush sleep under load, so poll for the stamp
      // instead of asserting once. A dead tick still fails at the cap.
      let stamped = 0;
      for (let i = 0; i < 100; i++) {
        stamped = ((await readRegistry(root)) as any)['ses-hb'].updatedAt;
        if (stamped > backdated) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(stamped).toBeGreaterThan(backdated);
      await hooks.dispose();
    } finally {
      vi.useRealTimers();
    }
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('session older than the stale window drops from the tick set', async () => {
    const { root, restore } = await freshRoot('mesh-ph-ttl-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    vi.useFakeTimers();
    try {
      const { client } = scriptedClient();
      const hooks = await init(client);
      await hooks.event(created('ses-old-tick', { directory: '/tmp/x', agent: 'beta', title: 'Work' }));
      const { atomicUpdateRegistry } = await import('../src/registry.js');
      const backdated = Date.now() - EVICT_GRACE_MS;
      await atomicUpdateRegistry((reg: any) => { reg['ses-old-tick'].updatedAt = backdated; }, root);
      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(TICK_ADVANCE_MS);
      await flushTick();
      // The tick drops the stale id from its set before heartbeating: the raw
      // envelope still carries the backdated stamp (readRegistry would prune
      // the row, so the file is read directly).
      const { readFile } = await import('node:fs/promises');
      const doc = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8')) as { entries: Record<string, { updatedAt: number }> };
      expect(doc.entries['ses-old-tick'].updatedAt).toBe(backdated);
      await hooks.dispose();
    } finally {
      vi.useRealTimers();
    }
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('busy status stamps liveness beside the tick', async () => {
    const { root, restore } = await freshRoot('mesh-ph-busy-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    vi.useFakeTimers();
    try {
      const { client, setStatus } = scriptedClient();
      const hooks = await init(client);
      await hooks.event(created('ses-busy-tick', { directory: '/tmp/x', agent: 'beta', title: 'Work' }));
      const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
      await atomicUpdateRegistry((reg: any) => { reg['ses-busy-tick'].lastActionAt = 1; }, root);
      setStatus({ 'ses-busy-tick': { type: 'busy' } });
      await vi.advanceTimersByTimeAsync(TICK_ADVANCE_MS);
      await flushTick();
      // Poll for the stamp: a single read after a fixed sleep flakes under
      // load, so wait up to 10s for the tick's FS writes to land.
      let stamped = 1;
      const busyDeadline = Date.now() + 10_000;
      while (Date.now() < busyDeadline) {
        stamped = ((await readRegistry(root)) as any)['ses-busy-tick'].lastActionAt;
        if (stamped > 1) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(stamped).toBeGreaterThan(1);
      await hooks.dispose();
    } finally {
      vi.useRealTimers();
    }
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('id absent from a live view evicts with an audit line', async () => {
    const { root, restore } = await freshRoot('mesh-ph-evict-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    vi.useFakeTimers();
    try {
      const { client, setStatus } = scriptedClient();
      const hooks = await init(client);
      await hooks.event(created('ses-evict', { directory: '/tmp/x', agent: 'beta', title: 'Work' }));
      const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
      await atomicUpdateRegistry((reg: any) => { reg['ses-evict'].updatedAt = Date.now() - EVICT_BACKDATE_MS; }, root);
      setStatus({ 'ses-other': { type: 'idle' } });
      await vi.advanceTimersByTimeAsync(TICK_ADVANCE_MS);
      await flushTick();
      // Poll for the evict: a single read after a fixed sleep flakes under
      // load, so wait up to 10s for the tick's FS writes to land.
      let evictPresent = true;
      const evictDeadline = Date.now() + 10_000;
      while (Date.now() < evictDeadline) {
        evictPresent = 'ses-evict' in ((await readRegistry(root)) as Record<string, unknown>);
        if (!evictPresent) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(evictPresent).toBe(false);
      const { readFile } = await import('node:fs/promises');
      expect(await readFile(join(root, 'audit.log'), 'utf8')).toContain('tick-evict');
      await hooks.dispose();
    } finally {
      vi.useRealTimers();
    }
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('attached id absent from a live view is kept', async () => {
    const { root, restore } = await freshRoot('mesh-ph-attached-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    vi.useFakeTimers();
    try {
      const { client, setStatus } = scriptedClient();
      const hooks = await init(client);
      await hooks.event(created('ses-att', { directory: '/tmp/x', agent: 'beta', title: 'Work' }));
      const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
      await atomicUpdateRegistry((reg: any) => {
        reg['ses-att'].updatedAt = Date.now() - EVICT_BACKDATE_MS;
        reg['ses-att'].attached = true;
      }, root);
      setStatus({ 'ses-other': { type: 'idle' } });
      await vi.advanceTimersByTimeAsync(TICK_ADVANCE_MS);
      await flushTick();
      const after = (await readRegistry(root)) as any;
      expect('ses-att' in after).toBe(true);
      expect(after['ses-att'].attached).toBe(true);
      await hooks.dispose();
    } finally {
      vi.useRealTimers();
    }
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('evict write contention drops without killing the tick', async () => {
    const { root, restore } = await freshRoot('mesh-ph-lock-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    vi.useFakeTimers();
    try {
      const { client, setStatus } = scriptedClient();
      const hooks = await init(client);
      await hooks.event(created('ses-locked-tick', { directory: '/tmp/x', agent: 'beta', title: 'Work' }));
      const { atomicUpdateRegistry } = await import('../src/registry.js');
      await atomicUpdateRegistry((reg: any) => { reg['ses-locked-tick'].updatedAt = Date.now() - EVICT_BACKDATE_MS; }, root);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(root, 'registry.json.lock'), `${process.pid}:${Date.now()}`);
      setStatus({ 'ses-other': { type: 'idle' } });
      await vi.advanceTimersByTimeAsync(TICK_ADVANCE_MS);
      await flushTick();
      await hooks.dispose();
    } finally {
      vi.useRealTimers();
    }
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  }, 60_000);

  it('live id missing from the registry recreates', async () => {
    const { root, restore } = await freshRoot('mesh-ph-recreate-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    vi.useFakeTimers();
    try {
      const { client, setStatus } = scriptedClient();
      const hooks = await init(client);
      await hooks.event(created('ses-re', { directory: '/tmp/x', agent: 'beta', title: 'Work' }));
      const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
      await atomicUpdateRegistry((reg: any) => { delete reg['ses-re']; }, root);
      setStatus({ 'ses-re': { type: 'idle' } });
      await vi.advanceTimersByTimeAsync(TICK_ADVANCE_MS);
      await flushTick();
      // Poll for the recreate: a single read after a fixed sleep flakes under
      // load, so wait up to 10s for the tick's FS writes to land.
      let after: any = {};
      const recreateDeadline = Date.now() + 10_000;
      while (Date.now() < recreateDeadline) {
        after = (await readRegistry(root)) as any;
        if ('ses-re' in after) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect('ses-re' in after).toBe(true);
      expect(after['ses-re'].agent).toBe('unknown');
      await hooks.dispose();
    } finally {
      vi.useRealTimers();
    }
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });
});

describe('plugin session event legs', () => {
  it('created without an id returns', async () => {
    const { root, restore } = await freshRoot('mesh-ph-noid-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { client } = scriptedClient();
    const hooks = await init(client);
    await expect(hooks.event({ event: { type: 'session.created', properties: { info: {} } } })).resolves.toBeUndefined();
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('created inside the debounce window returns early', async () => {
    const { root, restore } = await freshRoot('mesh-ph-debounce-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { client } = scriptedClient();
    const hooks = await init(client);
    await hooks.event(created('ses-deb', { directory: '/tmp/x', agent: 'beta', title: 'Work' }));
    await hooks.event(created('ses-deb', { directory: '/tmp/x', agent: 'beta', title: 'Work' }));
    const { readRegistry } = await import('../src/registry.js');
    expect(Object.keys((await readRegistry(root)) as Record<string, unknown>)).toEqual(['ses-deb']);
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('created without a directory registers with a short-id fallback', async () => {
    const { root, restore } = await freshRoot('mesh-ph-nodir-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { client } = scriptedClient();
    const hooks = await init(client);
    await hooks.event(created('ses-nodir-abcdef', { agent: 'beta', title: 'Work' }));
    const { readRegistry } = await import('../src/registry.js');
    const e = ((await readRegistry(root)) as any)['ses-nodir-abcdef'];
    expect(e.summary).toBe('Work');
    expect(e.directory).toBeUndefined();
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('created with a relative directory registers without storing it', async () => {
    const { root, restore } = await freshRoot('mesh-ph-reldir-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { client } = scriptedClient();
    const hooks = await init(client);
    await hooks.event(created('ses-rel', { directory: 'rel/path', agent: 'beta', title: 'Work' }));
    const { readRegistry } = await import('../src/registry.js');
    const e = ((await readRegistry(root)) as any)['ses-rel'];
    expect(e.directory).toBeUndefined();
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('created with an unknown agent keeps the existing real agent', async () => {
    const { root, restore } = await freshRoot('mesh-ph-agentkeep-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-ak'] = { sessionId: 'ses-ak', agent: 'reviewer', description: 'Real work', updatedAt: Date.now() } as any;
    }, root);
    const { client } = scriptedClient();
    const hooks = await init(client);
    await hooks.event(created('ses-ak', { directory: '/tmp/x', agent: 'unknown', title: 'More real work' }));
    expect(((await readRegistry(root)) as any)['ses-ak'].agent).toBe('reviewer');
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('created without any agent records unknown', async () => {
    const { root, restore } = await freshRoot('mesh-ph-agentunk-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { client } = scriptedClient();
    const hooks = await init(client);
    await hooks.event(created('ses-au', { directory: '/tmp/x', title: 'Work' }));
    const { readRegistry } = await import('../src/registry.js');
    expect(((await readRegistry(root)) as any)['ses-au'].agent).toBe('unknown');
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('created without a directory keeps the existing absolute directory', async () => {
    const { root, restore } = await freshRoot('mesh-ph-dkeep-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-dk'] = { sessionId: 'ses-dk', agent: 'a', directory: '/tmp/keep', description: 'Real work', updatedAt: Date.now() } as any;
    }, root);
    const { client } = scriptedClient();
    const hooks = await init(client);
    await hooks.event(created('ses-dk', { agent: 'a', title: 'More real work' }));
    expect(((await readRegistry(root)) as any)['ses-dk'].directory).toBe('/tmp/keep');
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('created with a generic title keeps the existing summary chain', async () => {
    const { root, restore } = await freshRoot('mesh-ph-genchain-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-gc'] = { sessionId: 'ses-gc', agent: 'a', description: GENERIC, summary: 'Real summary', title: GENERIC, updatedAt: Date.now() } as any;
    }, root);
    const { client } = scriptedClient();
    const hooks = await init(client);
    await hooks.event(created('ses-gc', { directory: '/tmp/x', agent: 'a', title: GENERIC }));
    expect(((await readRegistry(root)) as any)['ses-gc'].summary).toBe('Real summary');
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('created with a generic title never clobbers a real description', async () => {
    const { root, restore } = await freshRoot('mesh-ph-clobber-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-cl'] = { sessionId: 'ses-cl', agent: 'a', description: 'Real work', updatedAt: Date.now() } as any;
    }, root);
    const { client } = scriptedClient();
    const hooks = await init(client);
    await hooks.event(created('ses-cl', { directory: '/tmp/x', agent: 'a', title: GENERIC }));
    expect(((await readRegistry(root)) as any)['ses-cl'].description).toBe('Real work');
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('created with a broken writer rethrows non-contention', async () => {
    const { root, restore } = await freshRoot('mesh-ph-rethrow-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'registry.json'));
    const { client } = scriptedClient();
    const hooks = await init(client);
    await expect(hooks.event(created('ses-rt', { directory: root, agent: 'a', title: 'Work' }))).rejects.toThrow();
    await hooks.dispose().catch(() => {});
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('created under lock contention still resolves', async () => {
    const { root, restore } = await freshRoot('mesh-ph-stamplock-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'registry.json.lock'), `${process.pid}:${Date.now()}`);
    const { client } = scriptedClient();
    const hooks = await init(client);
    await hooks.event(created('ses-sl', { directory: '/tmp/x', agent: 'a', title: 'Work' }));
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  }, 60_000);

  it('updated without an id returns', async () => {
    const { root, restore } = await freshRoot('mesh-ph-updnoid-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { client } = scriptedClient();
    const hooks = await init(client);
    await expect(hooks.event({ event: { type: 'session.updated', properties: { info: {} } } })).resolves.toBeUndefined();
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('updated for an unknown id resolves without writing', async () => {
    const { root, restore } = await freshRoot('mesh-ph-updunknown-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { client } = scriptedClient();
    const hooks = await init(client);
    await hooks.event({ event: { type: 'session.updated', properties: { info: { id: 'ses-ghost-upd', title: 'Work' } } } });
    const { readRegistry } = await import('../src/registry.js');
    expect('ses-ghost-upd' in ((await readRegistry(root)) as Record<string, unknown>)).toBe(false);
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('deleted without an id returns', async () => {
    const { root, restore } = await freshRoot('mesh-ph-delnoid-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { client } = scriptedClient();
    const hooks = await init(client);
    await expect(hooks.event({ event: { type: 'session.deleted', properties: { info: {} } } })).resolves.toBeUndefined();
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('deleted keeps an attached id', async () => {
    const { root, restore } = await freshRoot('mesh-ph-delatt-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-delatt'] = { sessionId: 'ses-delatt', agent: 'a', updatedAt: Date.now(), attached: true } as any;
    }, root);
    const { client } = scriptedClient();
    const hooks = await init(client);
    await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'ses-delatt' } } } });
    expect('ses-delatt' in ((await readRegistry(root)) as Record<string, unknown>)).toBe(true);
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('unknown event type returns', async () => {
    const { root, restore } = await freshRoot('mesh-ph-unk-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { client } = scriptedClient();
    const hooks = await init(client);
    await expect(hooks.event({ event: { type: 'session.bogus', properties: {} } })).resolves.toBeUndefined();
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('tool execute before without a session id returns', async () => {
    const { root, restore } = await freshRoot('mesh-ph-befnosid-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { client } = scriptedClient();
    const hooks = await init(client);
    const before = (hooks as unknown as Record<string, (i: unknown) => Promise<unknown>>)['tool.execute.before'];
    await expect(before({})).resolves.toBeUndefined();
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('tool execute before inside the debounce window returns early', async () => {
    const { root, restore } = await freshRoot('mesh-ph-befdeb-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { client } = scriptedClient();
    const hooks = await init(client);
    const before = (hooks as unknown as Record<string, (i: unknown) => Promise<unknown>>)['tool.execute.before'];
    await before({ sessionID: 'ses-bef', directory: '/tmp/x', agent: 'a' });
    await before({ sessionID: 'ses-bef', directory: '/tmp/x', agent: 'a' });
    const { readRegistry } = await import('../src/registry.js');
    expect('ses-bef' in ((await readRegistry(root)) as Record<string, unknown>)).toBe(true);
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('identity falls back to info when the client fetch throws', async () => {
    const { root, restore } = await freshRoot('mesh-ph-identthrow-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const throwingClient = { session: { get: async () => { throw new Error('fetch blew up'); }, status: async () => ({}) } };
    const hooks = await init(throwingClient);
    await hooks.event(created('ses-it', { directory: '/tmp/x', agent: 'beta', title: 'Work' }));
    const { readRegistry } = await import('../src/registry.js');
    expect(((await readRegistry(root)) as any)['ses-it'].agent).toBe('beta');
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('identity reads nested info fields behind a missing direct field', async () => {
    const { root, restore } = await freshRoot('mesh-ph-identnested-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const nestedClient = { session: { get: async () => ({ info: { agent: 'nested-agent', directory: '/tmp/n', title: 'Nested work' } }), status: async () => ({}) } };
    const hooks = await init(nestedClient);
    await hooks.event(created('ses-nested', {}));
    const { readRegistry } = await import('../src/registry.js');
    expect(((await readRegistry(root)) as any)['ses-nested'].agent).toBe('nested-agent');
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });
});

describe('plugin dispose legs', () => {
  it('dispose with zero sessions resolves', async () => {
    const { root, restore } = await freshRoot('mesh-ph-disempty-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { client } = scriptedClient();
    const hooks = await init(client);
    await expect(hooks.dispose()).resolves.toBeUndefined();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('dispose deletes an id absent from the status view', async () => {
    const { root, restore } = await freshRoot('mesh-ph-disdel-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { client, setStatus } = scriptedClient();
    const hooks = await init(client);
    await hooks.event(created('ses-disdel', { directory: '/tmp/x', agent: 'a', title: 'Work' }));
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => { reg['ses-disdel'].updatedAt = Date.now() - 120000; }, root);
    setStatus({ 'ses-other': { type: 'idle' } });
    await hooks.dispose();
    expect('ses-disdel' in ((await readRegistry(root)) as Record<string, unknown>)).toBe(false);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('dispose holds an id inside the grace window', async () => {
    const { root, restore } = await freshRoot('mesh-ph-disgrace-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { client, setStatus } = scriptedClient();
    const hooks = await init(client);
    await hooks.event(created('ses-disgrace', { directory: '/tmp/x', agent: 'a', title: 'Work' }));
    setStatus({ 'ses-other': { type: 'idle' } });
    await hooks.dispose();
    const { readRegistry } = await import('../src/registry.js');
    expect('ses-disgrace' in ((await readRegistry(root)) as Record<string, unknown>)).toBe(true);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('dispose holds an attached id', async () => {
    const { root, restore } = await freshRoot('mesh-ph-disatt-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { client, setStatus } = scriptedClient();
    const hooks = await init(client);
    await hooks.event(created('ses-disatt', { directory: '/tmp/x', agent: 'a', title: 'Work' }));
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-disatt'].updatedAt = Date.now() - 120000;
      reg['ses-disatt'].attached = true;
    }, root);
    setStatus({ 'ses-other': { type: 'idle' } });
    await hooks.dispose();
    const after = (await readRegistry(root)) as any;
    expect('ses-disatt' in after).toBe(true);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('dispose with an empty status view keeps every id', async () => {
    const { root, restore } = await freshRoot('mesh-ph-disempty-view-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { client, setStatus } = scriptedClient();
    setStatus({});
    const hooks = await init(client);
    await hooks.event(created('ses-diskeep', { directory: '/tmp/x', agent: 'a', title: 'Work' }));
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => { reg['ses-diskeep'].updatedAt = Date.now() - 120000; }, root);
    await hooks.dispose();
    expect('ses-diskeep' in ((await readRegistry(root)) as Record<string, unknown>)).toBe(true);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('dispose with a broken writer rethrows non-contention', async () => {
    const { root, restore } = await freshRoot('mesh-ph-disrethrow-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { client } = scriptedClient();
    const hooks = await init(client);
    await hooks.event(created('ses-disrt', { directory: '/tmp/x', agent: 'a', title: 'Work' }));
    const { readRegistry } = await import('../src/registry.js');
    expect('ses-disrt' in ((await readRegistry(root)) as Record<string, unknown>)).toBe(true);
    const { rm: rmf, unlink } = await import('node:fs/promises');
    await unlink(join(root, 'registry.json'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'registry.json'));
    await expect(hooks.dispose()).rejects.toThrow();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });
});

describe('plugin config skills legs', () => {
  it('config falls back to the built-layout skills root', async () => {
    const { root, restore } = await freshRoot('mesh-ph-skills-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    fsCtl.exists = () => false;
    try {
      const { client } = scriptedClient();
      const hooks = await init(client);
      const cfg: Record<string, unknown> = {};
      await hooks.config(cfg);
      const paths = (cfg.skills as { paths: string[] }).paths;
      expect(paths.length).toBe(1);
      expect(paths[0].endsWith('skills')).toBe(true);
      await hooks.dispose();
    } finally {
      fsCtl.exists = null;
    }
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('config drops an existsSync failure and still sets a root', async () => {
    const { root, restore } = await freshRoot('mesh-ph-skillsfail-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    fsCtl.exists = () => { throw new Error('fs blew up'); };
    try {
      const { client } = scriptedClient();
      const hooks = await init(client);
      const cfg: Record<string, unknown> = {};
      await hooks.config(cfg);
      expect(((cfg.skills as { paths: string[] }).paths).length).toBe(1);
      await hooks.dispose();
    } finally {
      fsCtl.exists = null;
    }
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });
});
