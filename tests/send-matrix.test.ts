// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Send resolution matrix: agent@repo addressing, agent@repo miss labels,
// authed probe plus post, cwd fence, broadcast fan-out plus 413 stop.
// Each test pins the delivery outcome, never internals.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch as unknown as typeof fetch;
  vi.restoreAllMocks();
  delete process.env.OPENCODE_MESH_DB_PATH;
  delete process.env.OPENCODE_SERVER_PASSWORD;
  delete process.env.MESH_BROADCAST;
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

function liveRow(agent = 'beta', model = 'myprov/my-model') {
  return { agent, model };
}

describe('send resolution matrix', () => {
  it('agent at repo address resolves the single match', async () => {
    const { root, restore } = await freshRoot('mesh-send-agentrepo-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, status: 204 } as unknown as Response;
      return { ok: true, status: 200, json: async () => liveRow() } as unknown as Response;
    }) as unknown as typeof fetch;
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['ses-T'] = { sessionId: 'ses-T', agent: 'beta', repo: 'myrepo', directory: '/tmp/x', updatedAt: Date.now() };
      (reg as Record<string, unknown>)['ses-sparse'] = { sessionId: 'ses-sparse', updatedAt: Date.now() };
    }, root);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = await (mesh_send.execute as unknown as (a: unknown, c: unknown) => Promise<{ output: string }>)(
      { target: 'beta@myrepo', text: 'hi' }, { sessionID: 'caller', directory: '/tmp' }
    );
    expect(JSON.parse(out.output)).toMatchObject({ ok: true, via: 'admitted', target: 'ses-T' });
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('miss label falls back to agent at repo when no display fields exist', async () => {
    const { root, restore } = await freshRoot('mesh-send-dym-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['ses-T'] = { sessionId: 'ses-T', agent: 'beta', repo: 'myrepo', updatedAt: Date.now() };
      (reg as Record<string, unknown>)['ses-sparse'] = { sessionId: 'ses-sparse', updatedAt: Date.now() };
    }, root);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const err = await (mesh_send.execute as unknown as (a: unknown, c: unknown) => Promise<unknown>)(
      { target: 'nope', text: 'hi' }, { sessionID: 'caller', directory: '/tmp' }
    ).then(() => null, (e: unknown) => e as { code?: string; didYouMean?: string[] });
    expect(err?.code).toBe('PEER_NOT_FOUND');
    expect(err?.didYouMean).toContain('beta@myrepo');
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('authed probe plus post carry the Basic header', async () => {
    const { root, restore } = await freshRoot('mesh-send-auth-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_SERVER_PASSWORD = 'pw-send';
    const seen: Array<{ url: string; auth?: string }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      if (init?.method === 'POST') return { ok: true, status: 204 } as unknown as Response;
      return { ok: true, status: 200, json: async () => liveRow() } as unknown as Response;
    }) as unknown as typeof fetch;
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['ses-T'] = { sessionId: 'ses-T', agent: 'beta', model: 'myprov/my-model', directory: '/tmp/x', updatedAt: Date.now() };
    }, root);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = await (mesh_send.execute as unknown as (a: unknown, c: unknown) => Promise<{ output: string }>)(
      { target: 'ses-T', text: 'hi' }, { sessionID: 'caller', directory: '/tmp' }
    );
    expect(JSON.parse(out.output)).toMatchObject({ ok: true, via: 'admitted' });
    const want = `Basic ${Buffer.from('opencode:pw-send').toString('base64')}`;
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((s) => s.auth === want)).toBe(true);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('cwd-only entry scopes the post to the entry directory', async () => {
    const { root, restore } = await freshRoot('mesh-send-cwd-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const posted: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted.push(String(url));
        return { ok: true, status: 204 } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => liveRow() } as unknown as Response;
    }) as unknown as typeof fetch;
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['ses-T'] = { sessionId: 'ses-T', agent: 'beta', model: 'myprov/my-model', cwd: '/tmp/c', updatedAt: Date.now() };
    }, root);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    await (mesh_send.execute as unknown as (a: unknown, c: unknown) => Promise<{ output: string }>)(
      { target: 'ses-T', text: 'hi' }, { sessionID: 'caller' }
    );
    expect(posted.length).toBe(1);
    expect(posted[0]).toContain(`directory=${encodeURIComponent('/tmp/c')}`);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('broadcast partial failure records code plus labels and continues', async () => {
    const { root, restore } = await freshRoot('mesh-send-bcast404-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.MESH_BROADCAST = '1';
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (!init?.method || init.method === 'GET') {
        if (u.includes('/session/status')) return { ok: true, status: 200 } as unknown as Response;
        return { ok: true, status: 200, json: async () => liveRow() } as unknown as Response;
      }
      if (u.includes('/session/ses-A/')) return { ok: false, status: 404 } as unknown as Response;
      return { ok: true, status: 204 } as unknown as Response;
    }) as unknown as typeof fetch;
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      const r = reg as Record<string, unknown>;
      r['ses-A'] = { sessionId: 'ses-A', agent: 'a', model: 'myprov/my-model', directory: '/tmp/a', updatedAt: Date.now() };
      r['ses-B'] = { sessionId: 'ses-B', agent: 'b', model: 'myprov/my-model', directory: '/tmp/b', updatedAt: Date.now() };
    }, root);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = await (mesh_send.execute as unknown as (a: unknown, c: unknown) => Promise<{ output: string }>)(
      { target: 'all', text: 'hi', broadcast: true }, { sessionID: 'caller', directory: '/tmp' }
    );
    const body = JSON.parse(out.output) as { ok: number; failed: Array<{ peerId: string; code?: string; didYouMean?: string[] }> };
    expect(body.ok).toBe(1);
    expect(body.failed.length).toBe(1);
    expect(body.failed[0].peerId).toBe('ses-A');
    expect(body.failed[0].code).toBe('PEER_NOT_FOUND');
    expect(Array.isArray(body.failed[0].didYouMean)).toBe(true);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('broadcast oversize text stops loud with zero rows queued', async () => {    const { root, restore } = await freshRoot('mesh-send-bcast413-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.MESH_BROADCAST = '1';
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['ses-A'] = { sessionId: 'ses-A', agent: 'a', updatedAt: Date.now() };
    }, root);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const ob = await import('../src/outbox.js');
    const err = await (mesh_send.execute as unknown as (a: unknown, c: unknown) => Promise<unknown>)(
      { target: 'all', text: 'x'.repeat(2 * 1024 * 1024), broadcast: true }, { sessionID: 'caller', directory: '/tmp' }
    ).then(() => null, (e: unknown) => e as { code?: string });
    expect(err?.code).toBe('PAYLOAD_TOO_LARGE');
    expect(await ob.pendingCount(['ses-A'], root)).toBe(0);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('non-ok probe claims instead of throwing', async () => {
    const { root, restore } = await freshRoot('mesh-send-probe500-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    globalThis.fetch = (async () => ({ ok: false, status: 500 }) as unknown as Response) as unknown as typeof fetch;
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['ses-T'] = { sessionId: 'ses-T', agent: 'beta', model: 'myprov/my-model', directory: '/tmp/x', updatedAt: Date.now() };
    }, root);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const ob = await import('../src/outbox.js');
    const out = await (mesh_send.execute as unknown as (a: unknown, c: unknown) => Promise<{ output: string }>)(
      { target: 'ses-T', text: 'hi' }, { sessionID: 'caller', directory: '/tmp' }
    );
    expect(JSON.parse(out.output)).toMatchObject({ ok: true, via: 'queued' });
    expect(await ob.pendingCount(['ses-T'], root)).toBe(1);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('non-200 direct read falls through to the claim leg', async () => {
    const { root, restore } = await freshRoot('mesh-send-get500-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'POST') return { ok: true, status: 204 } as unknown as Response;
      if (u.includes('/session/status')) return { ok: true, status: 200 } as unknown as Response;
      return { ok: false, status: 500 } as unknown as Response;
    }) as unknown as typeof fetch;
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['ses-T'] = { sessionId: 'ses-T', agent: 'beta', model: 'myprov/my-model', directory: '/tmp/x', updatedAt: Date.now() };
    }, root);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const ob = await import('../src/outbox.js');
    const out = await (mesh_send.execute as unknown as (a: unknown, c: unknown) => Promise<{ output: string }>)(
      { target: 'ses-T', text: 'hi' }, { sessionID: 'caller', directory: '/tmp' }
    );
    expect(JSON.parse(out.output)).toMatchObject({ ok: true, via: 'admitted' });
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('broadcast throwing peer queues instead of failing', async () => {
    const { root, restore } = await freshRoot('mesh-send-bcastthrow-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.MESH_BROADCAST = '1';
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (!init?.method || init.method === 'GET') {
        if (u.includes('/session/status')) return { ok: true, status: 200 } as unknown as Response;
        return { ok: true, status: 200, json: async () => liveRow() } as unknown as Response;
      }
      if (u.includes('/session/ses-A/')) throw new Error('socket hang up');
      return { ok: true, status: 204 } as unknown as Response;
    }) as unknown as typeof fetch;
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      const r = reg as Record<string, unknown>;
      r['ses-A'] = { sessionId: 'ses-A', agent: 'a', model: 'myprov/my-model', directory: '/tmp/a', updatedAt: Date.now() };
      r['ses-B'] = { sessionId: 'ses-B', agent: 'b', model: 'myprov/my-model', directory: '/tmp/b', updatedAt: Date.now() };
    }, root);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = await (mesh_send.execute as unknown as (a: unknown, c: unknown) => Promise<{ output: string }>)(
      { target: 'all', text: 'hi', broadcast: true }, { sessionID: 'caller', directory: '/tmp' }
    );
    const body = JSON.parse(out.output) as { ok: number; failed: Array<{ peerId: string; code?: string; error: string }> };
    expect(body.ok).toBe(2);
    expect(body.failed.length).toBe(0);
    const ob = await import('../src/outbox.js');
    expect(await ob.pendingCount(['ses-A'], root)).toBe(1);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('resolved target on 404 still misses with recovery hints', async () => {
    const { root, restore } = await freshRoot('mesh-send-404miss-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'POST') return { ok: false, status: 404 } as unknown as Response;
      if (u.includes('/session/status')) return { ok: true, status: 200 } as unknown as Response;
      return { ok: true, status: 200, json: async () => liveRow() } as unknown as Response;
    }) as unknown as typeof fetch;
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      const r = reg as Record<string, unknown>;
      r['ses-T'] = { sessionId: 'ses-T', agent: 'beta', model: 'myprov/my-model', directory: '/tmp/t', updatedAt: Date.now() };
      r['ses-other'] = { sessionId: 'ses-other', agent: 'other', directory: '/tmp/o', updatedAt: Date.now() };
    }, root);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const ob = await import('../src/outbox.js');
    const err = await (mesh_send.execute as unknown as (a: unknown, c: unknown) => Promise<unknown>)(
      { target: 'ses-T', text: 'hi' }, { sessionID: 'caller', directory: '/tmp' }
    ).then(() => null, (e: unknown) => e as { code?: string; didYouMean?: string[] });
    expect(err?.code).toBe('PEER_NOT_FOUND');
    expect(Array.isArray(err?.didYouMean)).toBe(true);
    expect(await ob.pendingCount(['ses-T'], root)).toBe(0);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('flapping 500 queues the same text for the claim leg', async () => {
    const { root, restore } = await freshRoot('mesh-send-500queue-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'POST') return { ok: false, status: 500 } as unknown as Response;
      if (u.includes('/session/status')) return { ok: true, status: 200 } as unknown as Response;
      return { ok: true, status: 200, json: async () => liveRow() } as unknown as Response;
    }) as unknown as typeof fetch;
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['ses-T'] = { sessionId: 'ses-T', agent: 'beta', model: 'myprov/my-model', directory: '/tmp/t', updatedAt: Date.now() };
    }, root);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const ob = await import('../src/outbox.js');
    const out = await (mesh_send.execute as unknown as (a: unknown, c: unknown) => Promise<{ output: string }>)(
      { target: 'ses-T', text: 'flap me' }, { sessionID: 'caller', directory: '/tmp' }
    );
    expect(JSON.parse(out.output)).toMatchObject({ ok: true, via: 'queued', target: 'ses-T' });
    const rows = await ob.claim(['ses-T'], 'probe-owner', 1, root);
    expect(rows.length).toBe(1);
    expect(rows[0].text).toBe('flap me');
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });
});
