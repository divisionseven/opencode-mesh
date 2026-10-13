// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Four tools delegate to the shared core: the plugin wrappers add
// auto-register, then run the same executors the tools barrel carries, so
// every verbatim guard answers identically on both paths. Given one hermetic
// root, when each verb runs through the wrapper and through the barrel, then
// registrations land the same rows, listings match, deliveries queue to the
// same target, and BROADCAST_DISABLED plus PEER_NOT_FOUND plus
// PAYLOAD_TOO_LARGE refuse with identical codes before any fan-out.
// Parity framing is novel to this file; single-path guard behavior stays
// owned by tests/send-matrix.test.ts (oversize plus agent at repo),
// tests/broadcast-gate.test.ts (default-off), and
// tests/mesh-register-branches.test.ts (missing sessionID plus stale dir).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

const origFetch = globalThis.fetch;
const savedBroadcast = process.env.MESH_BROADCAST;
afterEach(() => {
  globalThis.fetch = origFetch as unknown as typeof fetch;
  vi.resetModules();
  vi.restoreAllMocks();
  if (savedBroadcast === undefined) delete process.env.MESH_BROADCAST;
  else process.env.MESH_BROADCAST = savedBroadcast;
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

async function safeRmArmed(root: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (
        (code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM') &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      throw err;
    }
  }
}

type Executor = {
  execute: (a: unknown, c: unknown) => Promise<unknown>;
};
type Hooks = {
  dispose: () => Promise<void>;
  tool: Record<string, Executor>;
};
type Barrel = Record<string, Executor>;

async function init(client: unknown): Promise<Hooks> {
  const pluginMod = await import('../plugin/opencode-mesh.js');
  const entry = pluginMod.default as unknown as (
    input: unknown,
  ) => Promise<Hooks>;
  return entry({ client });
}

async function loadBarrel(): Promise<Barrel> {
  return (await import(
    '../src/tools/index.js'
  )) as unknown as Barrel;
}

function stubFetchReject(calls: string[]): void {
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    throw new Error('no net in hermetic probe');
  }) as unknown as typeof fetch;
}

async function seedPeer(
  sessionId: string,
  description: string,
  root: string,
): Promise<void> {
  const reg = await import('../src/registry.js');
  await reg.atomicUpdateRegistry((r: unknown) => {
    (r as Record<string, unknown>)[sessionId] = {
      sessionId,
      agent: 'beta',
      model: 'myprov/my-model',
      directory: '/tmp/peer',
      description,
      summary: description,
      title: description,
      updatedAt: Date.now(),
    };
  }, root);
}

describe('tools delegation: wrappers and barrel share one core', () => {
  it('register lands the same row on both paths', async () => {
    const { root, restore } = await freshRoot('mesh-del-reg-');
    try {
      const hooks = await init({});
      const barrel = await loadBarrel();
      await hooks.tool.mesh_register.execute(
        { summary: 'Wrap work' },
        { sessionID: 'ses-del-w', directory: '/tmp' },
      );
      await barrel.mesh_register.execute(
        { summary: 'Barrel work' },
        { sessionID: 'ses-del-b', directory: '/tmp' },
      );
      const reg = await import('../src/registry.js');
      const rows = (await reg.readRegistry(
        root,
      )) as unknown as Record<string, Record<string, unknown>>;
      expect(rows['ses-del-w'].description).toBe('Wrap work');
      expect(rows['ses-del-b'].description).toBe('Barrel work');
      await hooks.dispose();
    } finally {
      await safeRmArmed(root);
      restore();
    }
  });

  it('peers lists the same ids on both paths', async () => {
    const { root, restore } = await freshRoot('mesh-del-peers-');
    try {
      const hooks = await init({});
      const barrel = await loadBarrel();
      await seedPeer('ses-del-p1', 'Alpha Work', root);
      await seedPeer('ses-del-p2', 'Beta Work', root);
      const ctx = { sessionID: 'ses-del-caller', directory: '/tmp' };
      const viaWrap = (await hooks.tool.mesh_peers.execute(
        { includeSelf: true },
        ctx,
      )) as { output: string };
      const viaBarrel = (await barrel.mesh_peers.execute(
        { includeSelf: true },
        ctx,
      )) as { output: string };
      const idsWrap = Object.keys(JSON.parse(viaWrap.output).peers).sort();
      const idsBarrel = Object.keys(JSON.parse(viaBarrel.output).peers).sort();
      expect(idsWrap).toContain('ses-del-p1');
      expect(idsWrap).toContain('ses-del-p2');
      expect(idsBarrel).toEqual(idsWrap);
      await hooks.dispose();
    } finally {
      await safeRmArmed(root);
      restore();
    }
  });

  it('unicast send queues to the same target on both paths', async () => {
    const { root, restore } = await freshRoot('mesh-del-send-');
    const calls: string[] = [];
    stubFetchReject(calls);
    try {
      const hooks = await init({});
      const barrel = await loadBarrel();
      await seedPeer('ses-del-peer', 'Gamma Work', root);
      const ctx = { sessionID: 'ses-del-caller', directory: '/tmp' };
      const viaWrap = (await hooks.tool.mesh_send.execute(
        { target: 'ses-del-peer', text: 'hello one' },
        ctx,
      )) as { output: string };
      const viaBarrel = (await barrel.mesh_send.execute(
        { target: 'ses-del-peer', text: 'hello two' },
        ctx,
      )) as { output: string };
      expect(JSON.parse(viaWrap.output)).toMatchObject({
        ok: true,
        via: 'queued',
        target: 'ses-del-peer',
      });
      expect(JSON.parse(viaBarrel.output)).toMatchObject({
        ok: true,
        via: 'queued',
        target: 'ses-del-peer',
      });
      await hooks.dispose();
    } finally {
      await safeRmArmed(root);
      restore();
    }
  });

  it('broadcast default-off refuses verbatim on all three paths', async () => {
    const { root, restore } = await freshRoot('mesh-del-bgate-');
    const calls: string[] = [];
    stubFetchReject(calls);
    delete process.env.MESH_BROADCAST;
    try {
      const hooks = await init({});
      const barrel = await loadBarrel();
      await seedPeer('ses-del-p1', 'Alpha Work', root);
      const ctx = { sessionID: 'ses-del-caller', directory: '/tmp' };
      const attempts: Array<() => Promise<unknown>> = [
        () => hooks.tool.mesh_broadcast.execute({ text: 'hi' }, ctx),
        () =>
          barrel.mesh_broadcast.execute(
            { target: 'all', text: 'hi', broadcast: true },
            ctx,
          ),
        () =>
          hooks.tool.mesh_send.execute(
            { target: 'all', text: 'hi', broadcast: true },
            ctx,
          ),
      ];
      for (const run of attempts) {
        const err = await run().then(
          () => null,
          (e: unknown) => e as { code?: string; status?: number },
        );
        expect(err?.code).toBe('BROADCAST_DISABLED');
        expect(err?.status).toBe(403);
      }
      expect(calls).toEqual([]);
      await hooks.dispose();
    } finally {
      await safeRmArmed(root);
      restore();
    }
  });

  it('opt-in fan-out reaches two peers with the same shape on both paths', async () => {
    const { root, restore } = await freshRoot('mesh-del-fanout-');
    const calls: string[] = [];
    stubFetchReject(calls);
    process.env.MESH_BROADCAST = '1';
    try {
      const hooks = await init({});
      const barrel = await loadBarrel();
      await seedPeer('ses-del-p1', 'Alpha Work', root);
      await seedPeer('ses-del-p2', 'Beta Work', root);
      const ctx = { sessionID: 'ses-del-caller', directory: '/tmp' };
      const viaWrap = (await hooks.tool.mesh_broadcast.execute(
        { text: 'hello all' },
        ctx,
      )) as { output: string };
      const viaBarrel = (await barrel.mesh_broadcast.execute(
        { target: 'all', text: 'hello all', broadcast: true },
        ctx,
      )) as { output: string };
      const parsedWrap = JSON.parse(viaWrap.output) as {
        peers: number;
        ok: number;
      };
      const parsedBarrel = JSON.parse(viaBarrel.output) as {
        peers: number;
        ok: number;
      };
      expect(parsedWrap.peers).toBe(2);
      expect(parsedWrap.ok).toBe(2);
      expect(parsedBarrel.peers).toBe(2);
      expect(parsedBarrel.ok).toBe(2);
      await hooks.dispose();
    } finally {
      await safeRmArmed(root);
      restore();
    }
  });

  it('unknown target misses verbatim with recovery hints on both paths', async () => {
    const { root, restore } = await freshRoot('mesh-del-miss-');
    const calls: string[] = [];
    stubFetchReject(calls);
    try {
      const hooks = await init({});
      const barrel = await loadBarrel();
      await seedPeer('ses-del-p1', 'Alpha Work', root);
      const ctx = { sessionID: 'ses-del-caller', directory: '/tmp' };
      const viaWrap = await hooks.tool.mesh_send
        .execute({ target: 'no-such-peer', text: 'hi' }, ctx)
        .then(
          () => null,
          (e: unknown) => e as { code?: string; didYouMean?: string[] },
        );
      const viaBarrel = await barrel.mesh_send
        .execute({ target: 'no-such-peer', text: 'hi' }, ctx)
        .then(
          () => null,
          (e: unknown) => e as { code?: string; didYouMean?: string[] },
        );
      for (const err of [viaWrap, viaBarrel]) {
        expect(err?.code).toBe('PEER_NOT_FOUND');
        expect(err?.didYouMean).toContain('Alpha Work');
      }
      await hooks.dispose();
    } finally {
      await safeRmArmed(root);
      restore();
    }
  });

  it('unicast oversize refuses verbatim with zero fetch on both paths', async () => {
    const { root, restore } = await freshRoot('mesh-del-413-');
    const calls: string[] = [];
    stubFetchReject(calls);
    try {
      const hooks = await init({});
      const barrel = await loadBarrel();
      await seedPeer('ses-del-peer', 'Gamma Work', root);
      const big = 'x'.repeat(2 * 1024 * 1024);
      const ctx = { sessionID: 'ses-del-caller', directory: '/tmp' };
      const viaWrap = await hooks.tool.mesh_send
        .execute({ target: 'ses-del-peer', text: big }, ctx)
        .then(
          () => null,
          (e: unknown) => e as { code?: string; status?: number },
        );
      const viaBarrel = await barrel.mesh_send
        .execute({ target: 'ses-del-peer', text: big }, ctx)
        .then(
          () => null,
          (e: unknown) => e as { code?: string; status?: number },
        );
      for (const err of [viaWrap, viaBarrel]) {
        expect(err?.code).toBe('PAYLOAD_TOO_LARGE');
        expect(err?.status).toBe(413);
      }
      expect(calls).toEqual([]);
      await hooks.dispose();
    } finally {
      await safeRmArmed(root);
      restore();
    }
  });
});
