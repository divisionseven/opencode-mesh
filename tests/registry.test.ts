// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  pruneStale,
  readRegistry,
  STALE_TTL_MS,
  atomicUpdateRegistry,
} from '../src/registry.js';

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
describe('registry', () => {
  it('pruneStale keeps now - updatedAt <=24h evicts 25h', () => {
    const now = Date.now();
    const reg = {
      a: { sessionId: 'a', agent: 'x', updatedAt: now - 1000 },
      b: { sessionId: 'b', agent: 'y', updatedAt: now - STALE_TTL_MS - 1000 },
      c: { sessionId: 'c', agent: 'z', updatedAt: now - 25 * 60 * 60 * 1000 },
    } as any;
    const pruned = pruneStale(reg, now);
    expect(pruned.a).toBeDefined();
    expect(pruned.b).toBeUndefined();
    expect(pruned.c).toBeUndefined();
  });
  it('atomicUpdateRegistry sequential persists both writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-reg-'));
    process.env.OPENCODE_MESH_ROOT = root;
    await atomicUpdateRegistry((reg: any) => { reg['s1'] = { sessionId: 's1', agent: 'a', updatedAt: Date.now() } as any; }, root);
    await atomicUpdateRegistry((reg: any) => { reg['s2'] = { sessionId: 's2', agent: 'b', updatedAt: Date.now() } as any; }, root);
    const r = await readRegistry(root);
    expect(Object.keys(r).length).toBeGreaterThan(0);
    await safeRm(root);
    delete process.env.OPENCODE_MESH_ROOT;
  });
  it('readRegistry on a fresh explicit root reads empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-regempty-'));
    const r = await readRegistry(root);
    expect(r).toBeDefined();
    expect(Object.keys(r)).toEqual([]);
    await safeRm(root);
  });
  it('no 7 days retention', async () => {
    const src = await import('node:fs/promises').then((m) =>
      m.readFile('src/registry.ts', 'utf8')
    );
    expect(src).not.toMatch(/7 days/);
    expect(src).not.toMatch(/archive/);
    expect(src).not.toMatch(/DEADLOCK/);
  });
  it('STALE_TTL 24h', () => {
    expect(STALE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
  it('herd 20-way in-process burst keeps every key with zero contention throw', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-herd-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const ids = Array.from({ length: 20 }, (_, i) => `ses_herd${String(i).padStart(2, "0")}00000000000000`);
    await Promise.all(
      ids.map((id) => atomicUpdateRegistry((reg: any) => {
        reg[id] = { sessionId: id, agent: "herd", updatedAt: Date.now() } as any;
      }, root))
    );
    const r = (await readRegistry(root)) as Record<string, unknown>;
    expect(ids.every((id) => id in r)).toBe(true);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root);
  });
  it('normalizeEntry with a root directory leaves repo undefined', async () => {
    const { normalizeEntry } = await import('../src/registry.js');
    const n = normalizeEntry({ sessionId: 's', agent: 'a', directory: '/', updatedAt: Date.now() } as never) as unknown as Record<string, unknown>;
    expect(n.repo).toBeUndefined();
  });
  it('normalizeEntry strips display-only rank keys', async () => {
    const { normalizeEntry } = await import('../src/registry.js');
    const n = normalizeEntry({ sessionId: 's', agent: 'a', updatedAt: Date.now(), attachedRank: 1, rank: 2 } as never) as unknown as Record<string, unknown>;
    expect('attachedRank' in n).toBe(false);
    expect('rank' in n).toBe(false);
  });
  it('atomicUpdateRegistry rethrows a non-contention writer error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-regthrow-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    await expect(atomicUpdateRegistry(() => { throw new Error('writer blew up'); }, root)).rejects.toThrow('writer blew up');
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root);
  });
  it('readRegistry reads a raw-shape document without an envelope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-regraw-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'registry.json'), JSON.stringify({
      'ses-raw': { sessionId: 'ses-raw', agent: 'a', description: 'raw row', updatedAt: Date.now() },
    }));
    const r = (await readRegistry(root)) as Record<string, { description?: string }>;
    expect(r['ses-raw'].description).toBe('raw row');
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root);
  });
  it('readRegistry reads corrupt JSON as empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-regcorrupt-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'registry.json'), 'corrupt{{{');
    expect(await readRegistry(root)).toEqual({});
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root);
  });
  it('unwrapStatusMap reads garbage as null', async () => {
    const { unwrapStatusMap } = await import('../src/registry.js');
    expect(unwrapStatusMap(null)).toBeNull();
    expect(unwrapStatusMap([])).toBeNull();
    expect(unwrapStatusMap('nope')).toBeNull();
  });
  it('fetchSessionStatusMap reads non-ok as null', async () => {
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    try {
      const { fetchSessionStatusMap } = await import('../src/registry.js');
      expect(await fetchSessionStatusMap()).toBeNull();
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
  it('fetchSessionStatusMap reads a rejecting fetch as null', async () => {
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    try {
      const { fetchSessionStatusMap } = await import('../src/registry.js');
      expect(await fetchSessionStatusMap()).toBeNull();
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
  it('single-port guard returns the primary view on first hit', async () => {
    const prevPort = process.env.OPENCODE_PORT;
    const prevFetch = globalThis.fetch;
    process.env.OPENCODE_PORT = '5000';
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('127.0.0.1:5000/')) return { ok: true, status: 200, json: async () => ({ 'ses-p': { type: 'idle' } }) };
      return { ok: false, status: 500, json: async () => ({}) };
    }) as unknown as typeof fetch;
    try {
      const { vi } = await import('vitest');
      vi.resetModules();
      const reg = await import('../src/registry.js');
      expect(await reg.fetchSinglePortStatusMap()).toEqual({ 'ses-p': { type: 'idle' } });
      vi.resetModules();
    } finally {
      globalThis.fetch = prevFetch;
      if (prevPort === undefined) delete process.env.OPENCODE_PORT; else process.env.OPENCODE_PORT = prevPort;
    }
  });
  it('single-port guard reads disjoint views as null', async () => {
    const prevPort = process.env.OPENCODE_PORT;
    const prevFetch = globalThis.fetch;
    process.env.OPENCODE_PORT = '5000';
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('127.0.0.1:5000/')) return { ok: true, status: 200, json: async () => ({ 'ses-a': { type: 'idle' } }) };
      if (u.includes('127.0.0.1:4096/')) return { ok: true, status: 200, json: async () => ({ 'ses-b': { type: 'idle' } }) };
      return { ok: false, status: 500, json: async () => ({}) };
    }) as unknown as typeof fetch;
    try {
      const { vi } = await import('vitest');
      vi.resetModules();
      const reg = await import('../src/registry.js');
      expect(await reg.fetchSinglePortStatusMap()).toBeNull();
      vi.resetModules();
    } finally {
      globalThis.fetch = prevFetch;
      if (prevPort === undefined) delete process.env.OPENCODE_PORT; else process.env.OPENCODE_PORT = prevPort;
    }
  });
  it('single-port guard falls back to the default port view', async () => {
    const prevPort = process.env.OPENCODE_PORT;
    const prevFetch = globalThis.fetch;
    process.env.OPENCODE_PORT = '5000';
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('127.0.0.1:4096/')) return { ok: true, status: 200, json: async () => ({ 'ses-f': { type: 'idle' } }) };
      return { ok: false, status: 500, json: async () => ({}) };
    }) as unknown as typeof fetch;
    try {
      const { vi } = await import('vitest');
      vi.resetModules();
      const reg = await import('../src/registry.js');
      expect(await reg.fetchSinglePortStatusMap()).toEqual({ 'ses-f': { type: 'idle' } });
      vi.resetModules();
    } finally {
      globalThis.fetch = prevFetch;
      if (prevPort === undefined) delete process.env.OPENCODE_PORT; else process.env.OPENCODE_PORT = prevPort;
    }
  });
  it('persistConfirmedDead with no view deletes zero', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-regpersist-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { persistConfirmedDead } = await import('../src/registry.js');
    expect(await persistConfirmedDead(null, root)).toBe(0);
    expect(await persistConfirmedDead({}, root)).toBe(0);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root);
  });
});
