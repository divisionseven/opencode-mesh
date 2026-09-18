// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Alphabet matrix: always-branded direct plus broadcast.
// Branded claimer envelope id; legacy Date form rejected.
// Mutant: swapping brand helper reddens the gates.
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

describe('msg brand alphabet', () => {
  it('isMsgId accepts branded, rejects legacy plus malformed variants', async () => {
    const { isMsgId, newMessageId } = await import('../src/outbox.js');
    const branded = newMessageId();
    expect(isMsgId(branded)).toBe(true);
    // A legacy Date_rand8 id
    expect(isMsgId('1756000000000_ab12cd34')).toBe(false);
    // D short, E illegal char, F numeric only, G empty, H cli- prefix
    expect(isMsgId('msg_abc')).toBe(false);
    expect(isMsgId(`${branded.slice(0, 10)}!${branded.slice(11)}`)).toBe(false);
    expect(isMsgId('12345678901234567890123456')).toBe(false);
    expect(isMsgId('')).toBe(false);
    expect(isMsgId('cli-1756000000000')).toBe(false);
    // uniqueness across generations
    expect(newMessageId()).not.toBe(branded);
  });

  it('direct body always carries branded messageID; return equals wire ID', async () => {
    const { root, restore } = await freshRoot('mesh-brand-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['brand-target'] = { sessionId: 'brand-target', agent: 'a', model: 'myprov/my-model', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' };
    }, root);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) { calls.push({ url: u, init }); return { ok: true, status: 204 } as unknown as Response; }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const { isMsgId } = await import('../src/outbox.js');
    const out = JSON.parse((await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)({ target: 'brand-target', text: 'hi' } as never, { sessionID: 'brand-caller', directory: '/tmp' } as never)).output) as { id: string };
    const body = JSON.parse(String(calls.find((c) => c.url.includes('prompt_async'))!.init?.body));
    expect(isMsgId(body.messageID)).toBe(true);
    expect(out.id).toBe(body.messageID);
    await safeRm(root); restore();
  });

  it('mutant probe: stripping the brand seed model degrades to queued with zero POSTs', async () => {
    const { root, restore } = await freshRoot('mesh-brand-mutant-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['brand-target'] = { sessionId: 'brand-target', agent: 'a', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' };
    }, root);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) { calls.push({ url: u, init }); return { ok: true, status: 204 } as unknown as Response; }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse((await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)({ target: 'brand-target', text: 'hi' } as never, { sessionID: 'brand-caller', directory: '/tmp' } as never)).output) as { via: string };
    expect(calls).toEqual([]);
    expect(out.via).toBe('queued');
    await safeRm(root); restore();
  });

  it('broadcast fan-out brands shared id plus per-peer ids; claim rows carry both', async () => {
    const { root, restore } = await freshRoot('mesh-brandbc-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const prevBc = process.env.MESH_BROADCAST;
    process.env.MESH_BROADCAST = '1';
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      const r = reg as Record<string, unknown>;
      for (let i = 0; i < 3; i++) r[`bcast-${i}`] = { sessionId: `bcast-${i}`, agent: 'a', updatedAt: Date.now() };
    }, root);
    // No URL entries route by loopback pin; refuse to take the claim leg.
    globalThis.fetch = (async () => { throw new Error('loopback down — claim path takes over'); }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse((await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)({ target: 'all', text: 'hi', broadcast: true } as never, { sessionID: 'bcast-caller', directory: '/tmp' } as never)).output) as { ok: number; results: Array<{ id?: string }> };
    expect(out.ok).toBe(3);
    const { isMsgId } = await import('../src/outbox.js');
    for (const res of out.results) expect(isMsgId(res.id ?? '')).toBe(true);
    expect(new Set(out.results.map((r) => r.id)).size).toBe(3);
    const ob = await import('../src/outbox.js');
    const rows = await ob.claim(['bcast-0', 'bcast-1', 'bcast-2'], 'owner-bc', 5, root);
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(isMsgId(row.id)).toBe(true);
      expect(isMsgId(row.broadcast_id ?? '')).toBe(true);
    }
    expect(new Set(rows.map((r) => r.broadcast_id)).size).toBe(1);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevBc === undefined) delete process.env.MESH_BROADCAST; else process.env.MESH_BROADCAST = prevBc;
    await safeRm(root); restore();
  });
});
