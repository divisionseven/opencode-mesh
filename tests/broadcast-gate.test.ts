// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Broadcast opt-in gate (default-off).
// mesh_send broadcast:true / target:"all" and the mesh_broadcast alias fail
// loud with BROADCAST_DISABLED 403 before any fan-out unless MESH_BROADCAST=1.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function saveBroadcastEnv(): string | undefined {
  return process.env.MESH_BROADCAST;
}

function restoreBroadcastEnv(prev: string | undefined): void {
  if (prev === undefined) delete process.env.MESH_BROADCAST;
  else process.env.MESH_BROADCAST = prev;
}

describe('broadcast gate: default-off rejects before fan-out', () => {
  it('broadcast:true rejects with BROADCAST_DISABLED 403, zero fetch, zero rows', async () => {
    const { root, restore } = await freshRoot('mesh-bcgate-');
    const prevBc = saveBroadcastEnv();
    delete process.env.MESH_BROADCAST;
    try {
      const { atomicUpdateRegistry } = await import('../src/registry.js');
      const now = Date.now();
      await atomicUpdateRegistry((reg: unknown) => {
        const r = reg as Record<string, unknown>;
        r['peer-a'] = { sessionId: 'peer-a', agent: 'a', updatedAt: now };
        r['peer-b'] = { sessionId: 'peer-b', agent: 'a', updatedAt: now };
      }, root);
      const fetchCalls: string[] = [];
      globalThis.fetch = (async (url: string) => {
        fetchCalls.push(String(url));
        return { ok: true, status: 204, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch;
      const { mesh_send } = await import('../src/tools/mesh_send.js');
      const err = await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)(
        { target: 'all', text: 'hi', broadcast: true } as never,
        { sessionID: 'gate-caller', directory: '/tmp' } as never,
      ).then(
        () => null,
        (e: unknown) => e as { code?: string; status?: number; message?: string },
      );
      expect(err).not.toBeNull();
      expect(err?.code).toBe('BROADCAST_DISABLED');
      expect(err?.status).toBe(403);
      expect(String(err?.message ?? '')).toMatch(/MESH_BROADCAST=1/);
      expect(fetchCalls.length).toBe(0);
      const ob = await import('../src/outbox.js');
      const rows = await ob.claim(['peer-a', 'peer-b'], 'gate-owner', 10, root);
      expect(rows.length).toBe(0);
    } finally {
      restoreBroadcastEnv(prevBc);
      await safeRm(root); restore();
    }
  });

  it('target:"all" without broadcast flag also rejects (slash spelling)', async () => {
    const { root, restore } = await freshRoot('mesh-bcgate-all-');
    const prevBc = saveBroadcastEnv();
    delete process.env.MESH_BROADCAST;
    try {
      const { atomicUpdateRegistry } = await import('../src/registry.js');
      await atomicUpdateRegistry((reg: unknown) => {
        (reg as Record<string, unknown>)['peer-a'] = { sessionId: 'peer-a', agent: 'a', updatedAt: Date.now() };
      }, root);
      globalThis.fetch = (async () => ({ ok: true, status: 204, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
      const { mesh_send } = await import('../src/tools/mesh_send.js');
      await expect(
        (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)(
          { target: 'all', text: 'hi' } as never,
          { sessionID: 'gate-caller', directory: '/tmp' } as never,
        ),
      ).rejects.toMatchObject({ code: 'BROADCAST_DISABLED', status: 403 });
    } finally {
      restoreBroadcastEnv(prevBc);
      await safeRm(root); restore();
    }
  });

  it('non-exact values (0/true/empty) stay disabled — only "1" opts in', async () => {
    const { root, restore } = await freshRoot('mesh-bcgate-exact-');
    const prevBc = saveBroadcastEnv();
    try {
      const { atomicUpdateRegistry } = await import('../src/registry.js');
      await atomicUpdateRegistry((reg: unknown) => {
        (reg as Record<string, unknown>)['peer-a'] = { sessionId: 'peer-a', agent: 'a', updatedAt: Date.now() };
      }, root);
      globalThis.fetch = (async () => ({ ok: true, status: 204, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
      const { mesh_send } = await import('../src/tools/mesh_send.js');
      for (const v of ['0', 'true', '', 'yes']) {
        process.env.MESH_BROADCAST = v;
        vi.resetModules();
        const { mesh_send: gated } = await import('../src/tools/mesh_send.js');
        await expect(
          (gated.execute as (...a: never[]) => Promise<{ output: string }>)(
            { target: 'all', text: 'hi', broadcast: true } as never,
            { sessionID: 'gate-caller', directory: '/tmp' } as never,
          ),
        ).rejects.toMatchObject({ code: 'BROADCAST_DISABLED' });
      }
      void mesh_send;
    } finally {
      restoreBroadcastEnv(prevBc);
      await safeRm(root); restore();
    }
  });

  it('opt-in MESH_BROADCAST=1 fans out as before (2 peers admitted)', async () => {
    const { root, restore } = await freshRoot('mesh-bcgate-on-');
    const prevBc = saveBroadcastEnv();
    process.env.MESH_BROADCAST = '1';
    try {
      const { atomicUpdateRegistry } = await import('../src/registry.js');
      const now = Date.now();
      await atomicUpdateRegistry((reg: unknown) => {
        const r = reg as Record<string, unknown>;
        r['on-a'] = { sessionId: 'on-a', agent: 'a', updatedAt: now };
        r['on-b'] = { sessionId: 'on-b', agent: 'a', updatedAt: now };
      }, root);
      globalThis.fetch = (async (url: string) => {
        const u = String(url);
        if (u.includes('/session/status')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
        if (u.includes('prompt_async')) return { ok: true, status: 204, json: async () => ({}) } as unknown as Response;
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch;
      const { mesh_send } = await import('../src/tools/mesh_send.js');
      const out = await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)(
        { target: 'all', text: 'hi opt-in', broadcast: true } as never,
        { sessionID: 'gate-caller', directory: '/tmp' } as never,
      );
      const j = JSON.parse(out.output) as { broadcast: boolean; peers: number; ok: number };
      expect(j.broadcast).toBe(true);
      expect(j.peers).toBe(2);
      expect(j.ok).toBe(2);
    } finally {
      restoreBroadcastEnv(prevBc);
      await safeRm(root); restore();
    }
  });

  it('unicast stays byte-identical with gate present (no flag needed)', async () => {
    const { root, restore } = await freshRoot('mesh-bcgate-uni-');
    const prevBc = saveBroadcastEnv();
    delete process.env.MESH_BROADCAST;
    try {
      const { atomicUpdateRegistry } = await import('../src/registry.js');
      await atomicUpdateRegistry((reg: unknown) => {
        (reg as Record<string, unknown>)['uni-target'] = { sessionId: 'uni-target', agent: 'a', model: 'myprov/my-model', updatedAt: Date.now() };
      }, root);
      globalThis.fetch = (async (url: string) => {
        const u = String(url);
        if (u.includes('/session/status')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
        if (u.includes('prompt_async')) return { ok: true, status: 204, json: async () => ({}) } as unknown as Response;
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch;
      const { mesh_send } = await import('../src/tools/mesh_send.js');
      const out = await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)(
        { target: 'uni-target', text: 'hello' } as never,
        { sessionID: 'uni-caller', directory: '/tmp' } as never,
      );
      const j = JSON.parse(out.output) as { ok: boolean; via: string; target: string };
      expect(j.ok).toBe(true);
      expect(j.via).toBe('admitted');
      expect(j.target).toBe('uni-target');
    } finally {
      restoreBroadcastEnv(prevBc);
      await safeRm(root); restore();
    }
  });

  it('plugin mesh_broadcast alias inherits the same gate (default-off rejects)', async () => {
    const { root, restore } = await freshRoot('mesh-bcgate-alias-');
    const prevBc = saveBroadcastEnv();
    delete process.env.MESH_BROADCAST;
    try {
      const { atomicUpdateRegistry } = await import('../src/registry.js');
      const now = Date.now();
      await atomicUpdateRegistry((reg: unknown) => {
        const r = reg as Record<string, unknown>;
        r['alias-caller'] = { sessionId: 'alias-caller', agent: 'a', updatedAt: now };
        r['alias-peer'] = { sessionId: 'alias-peer', agent: 'a', updatedAt: now };
      }, root);
      globalThis.fetch = (async () => ({ ok: true, status: 204, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
      const pluginMod = await import('../plugin/opencode-mesh.js');
      const fakeClient = { session: { status: async () => ({}), get: async () => ({}) } };
      const hooks = (await (pluginMod.default as unknown as (input: unknown) => Promise<{ tool: Record<string, { execute: (a: unknown, b: unknown) => Promise<unknown> }> }>)({ client: fakeClient }));
      await expect(
        hooks.tool.mesh_broadcast.execute({ text: 'hi alias' }, { sessionID: 'alias-caller', directory: '/tmp' }),
      ).rejects.toMatchObject({ code: 'BROADCAST_DISABLED', status: 403 });
      await (hooks as unknown as { dispose: () => Promise<void> }).dispose();
    } finally {
      restoreBroadcastEnv(prevBc);
      await safeRmArmed(root); restore();
    }
  });

  it('broadcast captures a per-peer miss while siblings admit', async () => {
    const { root, restore } = await freshRoot('mesh-bc-perpeer-');
    const prevBc = saveBroadcastEnv();
    process.env.MESH_BROADCAST = '1';
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'nodb.db');
    try {
      const { atomicUpdateRegistry } = await import('../src/registry.js');
      const now = Date.now();
      await atomicUpdateRegistry((reg: unknown) => {
        const r = reg as Record<string, unknown>;
        r['bc-caller'] = { sessionId: 'bc-caller', agent: 'a', updatedAt: now };
        r['bc-ok'] = { sessionId: 'bc-ok', agent: 'a', model: 'myprov/my-model', updatedAt: now };
        r['bc-miss'] = { sessionId: 'bc-miss', agent: 'a', model: 'myprov/my-model', updatedAt: now };
      }, root);
      const posted: string[] = [];
      globalThis.fetch = (async (url: string) => {
        const u = String(url);
        if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
        if (u.includes('/session/bc-miss/')) return { ok: false, status: 404 } as unknown as Response;
        if (u.includes('prompt_async')) {
          posted.push(u);
          return { ok: true, status: 204 } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch;
      const { mesh_send } = await import('../src/tools/mesh_send.js');
      const out = await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)(
        { target: 'all', text: 'fanout', broadcast: true } as never,
        { sessionID: 'bc-caller', directory: '/tmp' } as never,
      );
      const j = JSON.parse(out.output) as { ok: number; peers: number; failed: Array<{ peerId: string; code?: string }> };
      expect(j.peers).toBe(2);
      expect(j.ok).toBe(1);
      expect(j.failed.map((f) => f.peerId)).toEqual(['bc-miss']);
      expect(j.failed[0].code).toBe('PEER_NOT_FOUND');
      // Queue-before-probe second half: a model-missing peer joins the same
      // fan-out and queues honestly — ok counts it, failed stays exactly the
      // probed miss, and zero POSTs carry its id.
      await atomicUpdateRegistry((reg: unknown) => {
        (reg as Record<string, unknown>)['bc-defer'] = { sessionId: 'bc-defer', agent: 'a', updatedAt: Date.now() };
      }, root);
      posted.length = 0;
      const out2 = await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)(
        { target: 'all', text: 'fanout again', broadcast: true } as never,
        { sessionID: 'bc-caller', directory: '/tmp' } as never,
      );
      const j2 = JSON.parse(out2.output) as {
        ok: number;
        peers: number;
        failed: Array<{ peerId: string; code?: string }>;
        via: string;
        results: Array<{ peerId: string; via: string }>;
      };
      expect(j2.peers).toBe(3);
      expect(j2.ok).toBe(2);
      expect(j2.failed.map((f) => f.peerId)).toEqual(['bc-miss']);
      expect(j2.via).toBe('mixed');
      expect(posted.some((u) => u.includes('bc-defer'))).toBe(false);
      expect(j2.results.find((r) => r.peerId === 'bc-defer')?.via).toBe('queued');
    } finally {
      if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
      restoreBroadcastEnv(prevBc);
      await safeRm(root); restore();
    }
  });

  it('broadcast captures a per-peer 413 in the failed tail instead of rethrowing', async () => {
    const { root, restore } = await freshRoot('mesh-bc-413-');
    const prevBc = saveBroadcastEnv();
    process.env.MESH_BROADCAST = '1';
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'nodb.db');
    try {
      const { atomicUpdateRegistry } = await import('../src/registry.js');
      const now = Date.now();
      await atomicUpdateRegistry((reg: unknown) => {
        const r = reg as Record<string, unknown>;
        r['bc413-caller'] = { sessionId: 'bc413-caller', agent: 'a', updatedAt: now };
        r['bc413-peer'] = { sessionId: 'bc413-peer', agent: 'a', model: 'myprov/my-model', updatedAt: now };
        r['bc413-defer'] = { sessionId: 'bc413-defer', agent: 'a', updatedAt: now };
      }, root);
      const posted: string[] = [];
      globalThis.fetch = (async (url: string) => {
        const u = String(url);
        if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
        if (u.includes('prompt_async')) {
          posted.push(u);
          return { ok: false, status: 413 } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch;
      const { mesh_send } = await import('../src/tools/mesh_send.js');
      const out = await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)(
        { target: 'all', text: 'fanout', broadcast: true } as never,
        { sessionID: 'bc413-caller', directory: '/tmp' } as never,
      );
      const tail = JSON.parse(String(out.output)) as { ok: number; failed: Array<{ peerId: string; code?: string }> };
      expect(tail.ok).toBe(1);
      expect(tail.failed.length).toBe(1);
      expect(tail.failed[0].peerId).toBe('bc413-peer');
      expect(tail.failed[0].code).toBe('PAYLOAD_TOO_LARGE');
      // Queue-before-probe second half: the same shape minus the model queues
      // instead of throwing — the claim row proves the degrade. The broadcast
      // above already queued one row for this peer, so the count is two.
      posted.length = 0;
      const deferOut = JSON.parse(
        String((await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)(
          { target: 'bc413-defer', text: 'fanout' } as never,
          { sessionID: 'bc413-caller', directory: '/tmp' } as never,
        )).output),
      ) as { ok: boolean; via: string };
      expect(deferOut.ok).toBe(true);
      expect(deferOut.via).toBe('queued');
      expect(posted).toEqual([]);
      const ob = await import('../src/outbox.js');
      expect(await ob.pendingCount(['bc413-defer'], root)).toBe(2);
    } finally {
      if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
      restoreBroadcastEnv(prevBc);
      await safeRm(root); restore();
    }
  });
});
