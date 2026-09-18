// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Loopback pin: delivery POSTs the loopback base.
// Registry serve columns stripped on sight, valid or not.
import { mkdtemp, rm } from 'node:fs/promises';
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

const LOOPBACK_PORT = String(process.env.OPENCODE_PORT ?? 4096);

function stubProbing(posts: string[]) {
  return (async (url: string) => {
    const u = String(url);
    if (u.includes('/session/status')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    if (u.includes('/prompt_async')) {
      posts.push(u);
      return { ok: true, status: 204 } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('loopback pin: POST base is OPENCODE_PORT loopback, never registry addresses', () => {
  it('diverging serveUrl ignored — POST dials loopback, entry stored stripped', async () => {
    const { root, restore } = await freshRoot('mesh-port-');
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['port-target'] = {
        sessionId: 'port-target', agent: 'build', model: 'myprov/my-model', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4101', servePort: 4101,
      };
    }, root);
    // stored stripped: serve columns deleted as trusted route state
    const stored = ((await readRegistry(root)) as unknown as Record<string, Record<string, unknown>>)['port-target'];
    expect(stored.serveUrl).toBeUndefined();
    expect(stored.servePort).toBeUndefined();
    const posts: string[] = [];
    globalThis.fetch = stubProbing(posts);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      (await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)({ target: 'port-target', text: 'hi port' } as never, { sessionID: 'port-caller', directory: '/tmp', agent: 'build' } as never)).output
    );
    expect(out.via).toBe('admitted');
    const post = posts.find((u) => u.includes('port-target'));
    expect(post).toBeDefined();
    expect(new URL(post!).hostname).toBe('127.0.0.1');
    expect(new URL(post!).port).toBe(LOOPBACK_PORT);
    await safeRm(root); restore();
  });

  it('loopback down routes via claim (no POST dialed anywhere)', async () => {
    const { root, restore } = await freshRoot('mesh-portsingle-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['plain-target'] = { sessionId: 'plain-target', agent: 'build', updatedAt: Date.now() };
    }, root);
    const posts: string[] = [];
    // Loopback refuses everything: claim path takes over (server-down-degraded queues).
    globalThis.fetch = (async (url: string) => {
      throw new Error(`refused ${String(url).slice(0, 40)}`);
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      (await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)({ target: 'plain-target', text: 'hi' } as never, { sessionID: 'plain-caller', directory: '/tmp', agent: 'build' } as never)).output
    );
    expect(out.via).toBe('queued');
    expect(posts.length).toBe(0);
    await safeRm(root); restore();
  });

  it('loopback entry builds the pinned string', async () => {
    const { root, restore } = await freshRoot('mesh-portsame-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['same-target'] = {
        sessionId: 'same-target', agent: 'build', model: 'myprov/my-model', updatedAt: Date.now(),
      };
    }, root);
    const posts: string[] = [];
    globalThis.fetch = stubProbing(posts);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)({ target: 'same-target', text: 'hi' } as never, { sessionID: 'same-caller', directory: '/tmp', agent: 'build' } as never);
    const post = posts.find((u) => u.includes('same-target'))!;
    expect(post).toContain(`http://127.0.0.1:${LOOPBACK_PORT}/session/same-target/prompt_async?directory=`);
    await safeRm(root); restore();
  });

  it('broadcast fans out to the loopback pin for every member', async () => {
    const { root, restore } = await freshRoot('mesh-portbc-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const prevBc = process.env.MESH_BROADCAST;
    process.env.MESH_BROADCAST = '1';
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    const now = Date.now();
    await atomicUpdateRegistry((reg: unknown) => {
      const r = reg as Record<string, unknown>;
      r['bc-a'] = { sessionId: 'bc-a', agent: 'build', model: 'myprov/my-model', updatedAt: now, serveUrl: 'http://127.0.0.1:4101' };
      r['bc-b'] = { sessionId: 'bc-b', agent: 'build', model: 'myprov/my-model', updatedAt: now };
    }, root);
    const posts: string[] = [];
    globalThis.fetch = stubProbing(posts);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      (await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)({ target: 'all', text: 'hi bc', broadcast: true } as never, { sessionID: 'bc-caller', directory: '/tmp', agent: 'build' } as never)).output
    );
    expect(out.ok).toBe(2);
    expect(new URL(posts.find((u) => u.includes('bc-a'))!).port).toBe(LOOPBACK_PORT);
    expect(new URL(posts.find((u) => u.includes('bc-b'))!).port).toBe(LOOPBACK_PORT);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevBc === undefined) delete process.env.MESH_BROADCAST; else process.env.MESH_BROADCAST = prevBc;
    await safeRm(root); restore();
  });

  it('mutant probe: stripping the pin seed model degrades to queued with zero POSTs', async () => {
    const { root, restore } = await freshRoot('mesh-port-mutant-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['port-target'] = {
        sessionId: 'port-target', agent: 'build', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4101', servePort: 4101,
      };
    }, root);
    const posts: string[] = [];
    globalThis.fetch = stubProbing(posts);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      (await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)({ target: 'port-target', text: 'hi port' } as never, { sessionID: 'port-caller', directory: '/tmp', agent: 'build' } as never)).output
    );
    expect(out.via).toBe('queued');
    expect(posts).toEqual([]);
    await safeRm(root); restore();
  });
});
