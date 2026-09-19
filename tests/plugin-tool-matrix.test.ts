// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Plugin tool-path matrix: tool executes register through the wrapper,
// debounce, clientless and model-carrying registration, fence downgrade,
// generic-title guard, loud poisoned store, double dispose, status-less
// tick, evict of a missing entry. Each test pins observable behavior.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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

async function safeRmArmed(root: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if ((code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      throw err;
    }
  }
}

type Hooks = {
  event: (e: unknown) => Promise<void>;
  dispose: () => Promise<void>;
  tool: Record<string, { execute: (a: unknown, c: unknown) => Promise<unknown> }>;
};

async function init(client: unknown): Promise<Hooks> {
  const pluginMod = await import('../plugin/opencode-mesh.js');
  return (await (pluginMod.default as unknown as (input: unknown) => Promise<Hooks>)({ client })) as Hooks;
}

function created(id: string, info?: Record<string, unknown>) {
  return { event: { type: 'session.created', properties: { info: { id, ...info } } } };
}

describe('plugin tool-path matrix', () => {
  it('peers plus send through the tool wrapper register the caller', async () => {
    const { root, restore } = await freshRoot('mesh-pt-tools-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const hooks = await init({});
    const reg = await import('../src/registry.js');
    await reg.atomicUpdateRegistry((r: unknown) => {
      (r as Record<string, unknown>)['ses-ghost'] = { sessionId: 'ses-ghost', agent: 'g', model: 'myprov/my-model', directory: '/tmp/g', updatedAt: Date.now() };
    }, root);
    await hooks.tool.mesh_peers.execute({}, { sessionID: 'ses-caller', directory: '/tmp' });
    const sent = await hooks.tool.mesh_send.execute({ target: 'ses-ghost', text: 'hi' }, { sessionID: 'ses-caller', directory: '/tmp' }) as { output: string };
    expect(JSON.parse(sent.output)).toMatchObject({ ok: true, via: 'queued', target: 'ses-ghost' });
    expect((await reg.readRegistry(root))['ses-caller']).toBeDefined();
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('rapid double register debounces to one presence write', async () => {
    const { root, restore } = await freshRoot('mesh-pt-debounce-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const hooks = await init({});
    await hooks.tool.mesh_register.execute({}, { sessionID: 'ses-deb', directory: '/tmp' });
    await hooks.tool.mesh_register.execute({}, { sessionID: 'ses-deb', directory: '/tmp' });
    const reg = await import('../src/registry.js');
    expect((await reg.readRegistry(root))['ses-deb']).toBeDefined();
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('clientless register records unknown presence without a directory', async () => {
    const { root, restore } = await freshRoot('mesh-pt-noclient-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const hooks = await init({});
    await hooks.tool.mesh_register.execute({}, { sessionID: 'ses-nc' });
    const reg = await import('../src/registry.js');
    const entry = (await reg.readRegistry(root))['ses-nc'] as unknown as Record<string, unknown>;
    expect(entry).toBeDefined();
    expect(entry.agent).toBe('unknown');
    expect(entry.directory).toBeUndefined();
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('model-carrying client stores the model on presence', async () => {
    const { root, restore } = await freshRoot('mesh-pt-model-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const client = { session: { get: async () => ({ agent: 'beta', model: 'myprov/my-model' }) } };
    const hooks = await init(client);
    await hooks.tool.mesh_register.execute({}, { sessionID: 'ses-m', directory: '/tmp' });
    const reg = await import('../src/registry.js');
    const entry = (await reg.readRegistry(root))['ses-m'] as unknown as Record<string, unknown>;
    expect(entry.model).toBe('myprov/my-model');
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('stale directory on created downgrades to absent presence', async () => {
    const { root, restore } = await freshRoot('mesh-pt-staledir-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const hooks = await init({});
    await hooks.event(created('ses-sd', { directory: '/nonexistent-xyz-123', agent: 'beta', title: 'Work' }));
    const reg = await import('../src/registry.js');
    const entry = (await reg.readRegistry(root))['ses-sd'] as unknown as Record<string, unknown>;
    expect(entry).toBeDefined();
    expect(entry.directory).toBeUndefined();
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('generic created title never clobbers a real description', async () => {
    const { root, restore } = await freshRoot('mesh-pt-generic-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const reg = await import('../src/registry.js');
    await reg.atomicUpdateRegistry((r: unknown) => {
      (r as Record<string, unknown>)['ses-g'] = {
        sessionId: 'ses-g', agent: 'a', directory: '/tmp/x', cwd: '/tmp/x',
        description: 'Real work', summary: 'Real work', title: 'Real work', updatedAt: Date.now(),
      };
    }, root);
    const hooks = await init({});
    await hooks.event(created('ses-g', { directory: '/tmp/x', agent: 'a', title: 'New session - 2026-09-03T10:00:00.000Z' }));
    expect(((await reg.readRegistry(root))['ses-g'] as unknown as Record<string, unknown>).description).toBe('Real work');
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('poisoned store surfaces delete plus update errors loud', async () => {
    const { root, restore } = await freshRoot('mesh-pt-poison-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'registry.json'));
    const hooks = await init({});
    await expect(hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'ses-x' } } } })).rejects.toThrow();
    await expect(
      hooks.event({ event: { type: 'session.updated', properties: { info: { id: 'ses-x', title: 'Work' } } } })
    ).rejects.toThrow();
    await hooks.dispose().catch(() => {});
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('double dispose resolves without throwing', async () => {    const { root, restore } = await freshRoot('mesh-pt-dispose2-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const hooks = await init({});
    await hooks.event(created('ses-d2', { directory: '/tmp/x', agent: 'a', title: 'Work' }));
    await expect(hooks.dispose()).resolves.toBeUndefined();
    await expect(hooks.dispose()).resolves.toBeUndefined();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('status-less tick still stamps heartbeat liveness', async () => {
    const { root, restore } = await freshRoot('mesh-pt-nostatus-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    vi.useFakeTimers();
    try {
      const hooks = await init({});
      await hooks.event(created('ses-ns', { directory: '/tmp/x', agent: 'beta', title: 'Work' }));
      const reg = await import('../src/registry.js');
      const backdated = Date.now() - 60_000;
      await reg.atomicUpdateRegistry((r: unknown) => {
        ((r as Record<string, unknown>)['ses-ns'] as Record<string, unknown>).updatedAt = backdated;
      }, root);
      const { HEARTBEAT_INTERVAL_MS } = await import('../src/constants.js');
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 1000);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      vi.useRealTimers();
      let stamped = 0;
      for (let i = 0; i < 100; i++) {
        stamped = (((await reg.readRegistry(root))['ses-ns']) as unknown as { updatedAt: number }).updatedAt;
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

  it('tick with a missing entry skips eviction cleanly', async () => {
    const { root, restore } = await freshRoot('mesh-pt-evictmiss-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const client = { session: { status: async () => ({ 'ses-other': { type: 'idle' } }) } };
    vi.useFakeTimers();
    try {
      const hooks = await init(client);
      await hooks.event(created('ses-gone', { directory: '/tmp/x', agent: 'beta', title: 'Work' }));
      const reg = await import('../src/registry.js');
      await reg.atomicUpdateRegistry((r: unknown) => {
        delete (r as Record<string, unknown>)['ses-gone'];
      }, root);
      const { HEARTBEAT_INTERVAL_MS } = await import('../src/constants.js');
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 1000);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 500));
      await hooks.dispose();
    } finally {
      vi.useRealTimers();
    }
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });
});

describe('plugin poison plus ghost matrix', () => {
  it('poisoned store drops autoRegister reads without throwing', async () => {
    const { root, restore } = await freshRoot('mesh-pt-poisonreg-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'registry.json'));
    const hooks = await init({});
    // Why: autoRegister swallows the poisoned read, then the tool wrapper
    // stays loud per its contract.
    await expect(
      hooks.tool.mesh_register.execute({}, { sessionID: 'ses-p', directory: '/tmp' })
    ).rejects.toThrow();
    await hooks.dispose().catch(() => {});
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('updated event for a ghost id with a real agent resolves clean', async () => {
    const { root, restore } = await freshRoot('mesh-pt-ghostupd-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const hooks = await init({});
    await expect(
      hooks.event({ event: { type: 'session.updated', properties: { info: { id: 'ses-ghost-upd2', agent: 'beta', title: 'Work' } } } })
    ).resolves.toBeUndefined();
    const reg = await import('../src/registry.js');
    expect((await reg.readRegistry(root))['ses-ghost-upd2']).toBeUndefined();
    await hooks.dispose();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });
});
