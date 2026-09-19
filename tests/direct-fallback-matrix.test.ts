// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Clientless direct-POST fallback over a scripted fetch: 204 injects,
// 404 terminalizes, poisoned registry fails closed. Each test pins the
// delivery outcome, never internals.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import * as cl from '../src/claimer.js';
import * as ob from '../src/outbox.js';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch as unknown as typeof fetch;
  vi.restoreAllMocks();
  delete process.env.OPENCODE_MESH_DB_PATH;
  delete process.env.OPENCODE_SERVER_PASSWORD;
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

describe('clientless direct fallback', () => {
  it('probe ok plus 204 posts the variant body and acks', async () => {
    const { root, restore } = await freshRoot('mesh-direct-204-');
    // Why: audit store unwritable, delivery still completes; covers the audit-failure leg.
    await (await import('node:fs/promises')).mkdir(join(root, 'audit.log'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_SERVER_PASSWORD = 'pw-direct';
    const posted: Array<{ url: string; headers: Record<string, string>; body: { variant?: string } }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return { ok: true, status: 200 } as unknown as Response;
      posted.push({ url: String(url), headers: { ...((init.headers ?? {}) as Record<string, string>) }, body: JSON.parse(String(init.body)) });
      return { ok: true, status: 204 } as unknown as Response;
    }) as unknown as typeof fetch;
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    cl.configureClaimer({
      getOwnIds: () => ['ses-T'],
      getClient: () => ({
        session: {
          get: async () => ({ agent: 'beta', model: { providerID: 'p', modelID: 'm', variant: 'max' } }),
        },
      }),
      getRegistry: async () => ({ 'ses-T': { agent: 'beta', model: 'p/m', cwd: '/tmp/c' } }),
    });
    await cl.pollClaimer();
    expect(posted.length).toBe(1);
    expect(posted[0].body.variant).toBe('max');
    expect(posted[0].headers['x-opencode-directory']).toBe(encodeURIComponent('/tmp/c'));
    expect(posted[0].headers.Authorization).toBe(`Basic ${Buffer.from('opencode:pw-direct').toString('base64')}`);
    expect(await ob.pendingCount(['ses-T'], root)).toBe(0);
    cl.clearClaimerTimer();
    await cl.releaseClaimerOwner();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('probe ok plus 404 terminalizes with the direct reason', async () => {
    const { root, restore } = await freshRoot('mesh-direct-404-');
    // Why: audit store unwritable, terminalization still completes; covers the audit-failure leg.
    await (await import('node:fs/promises')).mkdir(join(root, 'audit.log'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return { ok: true, status: 200 } as unknown as Response;
      return { ok: false, status: 404 } as unknown as Response;
    }) as unknown as typeof fetch;
    const id = await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    cl.configureClaimer({
      getOwnIds: () => ['ses-T'],
      getClient: () => ({
        session: {
          get: async () => ({ agent: 'beta', model: 'myprov/my-model' }),
        },
      }),
      getRegistry: async () => ({ 'ses-T': { agent: 'beta', model: 'myprov/my-model', directory: '/tmp/t' } }),
    });
    await cl.pollClaimer();
    const r = await ob.receiptById(id, root);
    expect(r.state).toBe('failed-permanent');
    expect(r.reason).toBe('direct-terminal-404');
    cl.clearClaimerTimer();
    await cl.releaseClaimerOwner();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('poisoned registry entry terminalizes without throwing the poll', async () => {
    const { root, restore } = await freshRoot('mesh-direct-poison-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const id = await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    const poison = new Proxy({}, { get: () => { throw new Error('poisoned entry'); } });
    cl.configureClaimer({
      getOwnIds: () => ['ses-T'],
      getClient: () => ({ session: {} }),
      getRegistry: async () => ({ 'ses-T': poison }) as unknown as Record<string, { agent?: string }>,
    });
    await expect(cl.pollClaimer()).resolves.toBeUndefined();
    const r = await ob.receiptById(id, root);
    expect(r.state).toBe('queued');
    expect(r.attempts).toBe(1);
    cl.clearClaimerTimer();
    await cl.releaseClaimerOwner();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });
});
