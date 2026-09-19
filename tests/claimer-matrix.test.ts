// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Claimer poll matrix over scripted deps: client shapes, direct fallback,
// terminal detail, concurrent delete, owner disposal. Each test pins
// observable queue behavior through pollClaimer, never internals.
// Single module instance for the file (no per-test resets) so every leg
// attributes; deps are reconfigured per test, owner disposal runs first.
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

function outboxPath(root: string): string {
  return join(root, 'outbox.db');
}

type Deps = Parameters<typeof cl.configureClaimer>[0];

describe('claimer poll matrix', () => {
  it('owner disposal releases held claims back to pending', async () => {
    const { root, restore } = await freshRoot('mesh-clm-dispose-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    cl.configureClaimer({
      getOwnIds: () => ['ses-T'],
      getClient: () => null,
      getRegistry: async () => ({}),
    });
    cl.ensureClaimer();
    cl.ensureClaimer();
    await cl.pollClaimer();
    await cl.releaseClaimerOwner();
    expect(await ob.pendingCount(['ses-T'], root)).toBe(1);
    cl.clearClaimerTimer();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('session-less client shape releases the row for redelivery', async () => {
    const { root, restore } = await freshRoot('mesh-clm-nosession-');
    // Why: audit store unwritable, delivery still completes; covers the audit-failure leg.
    await mkdir(join(root, 'audit.log'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    cl.configureClaimer({
      getOwnIds: () => ['ses-T'],
      getClient: () => ({ session: null }) as unknown as ReturnType<Deps['getClient']>,
      getRegistry: async () => ({}),
    });
    await expect(cl.pollClaimer()).resolves.toBeUndefined();
    expect(await ob.pendingCount(['ses-T'], root)).toBe(1);
    cl.clearClaimerTimer();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('promptAsync-less client shape releases the row for redelivery', async () => {
    const { root, restore } = await freshRoot('mesh-clm-noprompt-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    cl.configureClaimer({
      getOwnIds: () => ['ses-T'],
      getClient: () => ({ session: {} }),
      getRegistry: async () => ({}),
    });
    await expect(cl.pollClaimer()).resolves.toBeUndefined();
    expect(await ob.pendingCount(['ses-T'], root)).toBe(1);
    cl.clearClaimerTimer();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('live registry re-attests a known sender on the injected prefix', async () => {
    const { root, restore } = await freshRoot('mesh-clm-attest-');
    // Why: audit store unwritable, delivery still completes; covers the audit-failure leg.
    await mkdir(join(root, 'audit.log'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const injected: Array<{ body: { parts: Array<{ text: string }> } }> = [];
    const fakeClient = {
      session: {
        status: async () => ({}),
        get: async () => ({ agent: 'beta', model: 'myprov/my-model' }),
        promptAsync: async (o: unknown) => { injected.push(o as { body: { parts: Array<{ text: string }> } }); return {}; },
      },
    };
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'stale-name', text: 'hi' }, root);
    cl.configureClaimer({
      getOwnIds: () => ['ses-T'],
      getClient: () => fakeClient,
      getRegistry: async () => ({
        'ses-T': { agent: 'beta', model: 'myprov/my-model', directory: '/tmp/t' },
        'ses-F': { agent: 'fresh-name' },
      }),
    });
    await cl.pollClaimer();
    expect(injected.length).toBe(1);
    expect(injected[0].body.parts[0].text).toContain('fresh-name');
    expect(injected[0].body.parts[0].text).not.toContain('stale-name');
    cl.clearClaimerTimer();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('variant-carrying receiver lands on the injected wire body', async () => {
    const { root, restore } = await freshRoot('mesh-clm-variant-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const injected: Array<{ body: { variant?: string } }> = [];
    const fakeClient = {
      session: {
        status: async () => ({}),
        get: async () => ({ agent: 'beta', model: { providerID: 'p', modelID: 'm', variant: 'max' } }),
        promptAsync: async (o: unknown) => { injected.push(o as { body: { variant?: string } }); return {}; },
      },
    };
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    cl.configureClaimer({
      getOwnIds: () => ['ses-T'],
      getClient: () => fakeClient,
      getRegistry: async () => ({ 'ses-T': { agent: 'beta', model: 'p/m', directory: '/tmp/t' } }),
    });
    await cl.pollClaimer();
    expect(injected.length).toBe(1);
    expect(injected[0].body.variant).toBe('max');
    cl.clearClaimerTimer();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('throwing live lookup defers without throwing the poll', async () => {
    const { root, restore } = await freshRoot('mesh-clm-getthrow-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const fakeClient = {
      session: {
        status: async () => ({}),
        get: async () => { throw new Error('lookup blew up'); },
        promptAsync: async () => ({}),
      },
    };
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    cl.configureClaimer({
      getOwnIds: () => ['ses-T'],
      getClient: () => fakeClient,
      getRegistry: async () => ({}),
    });
    await expect(cl.pollClaimer()).resolves.toBeUndefined();
    expect(await ob.pendingCount(['ses-T'], root)).toBe(1);
    cl.clearClaimerTimer();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('busy target waits out the queue policy then injects', async () => {
    const { root, restore } = await freshRoot('mesh-clm-busy-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const injected: unknown[] = [];
    const fakeClient = {
      session: {
        status: async () => ({ 'ses-T': { type: 'busy' } }),
        get: async () => ({ agent: 'beta', model: 'myprov/my-model' }),
        promptAsync: async (o: unknown) => { injected.push(o); return {}; },
      },
    };
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    cl.configureClaimer({
      getOwnIds: () => ['ses-T'],
      getClient: () => fakeClient,
      getRegistry: async () => ({ 'ses-T': { agent: 'beta', model: 'myprov/my-model', directory: '/tmp/t' } }),
    });
    await cl.pollClaimer();
    expect(injected.length).toBe(1);
    cl.clearClaimerTimer();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  }, 30_000);

  it('throwing registry reader defers the row without throwing the poll', async () => {
    const { root, restore } = await freshRoot('mesh-clm-regthrow-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    cl.configureClaimer({
      getOwnIds: () => ['ses-T'],
      getClient: () => ({ session: {} }),
      getRegistry: async () => { throw new Error('registry blew up'); },
    });
    await expect(cl.pollClaimer()).resolves.toBeUndefined();
    expect(await ob.pendingCount(['ses-T'], root)).toBe(1);
    cl.clearClaimerTimer();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('exhausted row terminalizes with the trail detail on the receipt', async () => {
    const { root, restore } = await freshRoot('mesh-clm-exhaust-');
    // Why: audit store unwritable, terminalization still completes; covers the audit-failure leg.
    await mkdir(join(root, 'audit.log'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const id = await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    const db = new DatabaseSync(outboxPath(root));
    db.prepare(`UPDATE outbox SET attempts = 24 WHERE id = ?`).run(id);
    db.close();
    cl.configureClaimer({
      getOwnIds: () => ['ses-T'],
      getClient: () => ({ session: {} }),
      getRegistry: async () => ({}),
    });
    await cl.pollClaimer();
    const r = await ob.receiptById(id, root);
    expect(r.state).toBe('failed-permanent');
    expect(r.missLayer).toBe('registry');
    cl.clearClaimerTimer();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('row deleted mid-poll releases cleanly and reads unknown receipt', async () => {
    const { root, restore } = await freshRoot('mesh-clm-middelete-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const id = await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    cl.configureClaimer({
      getOwnIds: () => ['ses-T'],
      getClient: () => ({ session: {} }),
      getRegistry: async () => {
        const db = new DatabaseSync(outboxPath(root));
        db.prepare(`DELETE FROM outbox WHERE id = ?`).run(id);
        db.close();
        return {};
      },
    });
    await expect(cl.pollClaimer()).resolves.toBeUndefined();
    expect((await ob.receiptById(id, root)).state).toBe('failed-permanent');
    cl.clearClaimerTimer();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('non-ok probe response claims instead of throwing', async () => {
    const { root, restore } = await freshRoot('mesh-clm-probe500-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    globalThis.fetch = (async () => ({ ok: false, status: 500 }) as unknown as Response) as unknown as typeof fetch;
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    cl.configureClaimer({
      getOwnIds: () => ['ses-T'],
      getClient: () => ({ session: {} }),
      getRegistry: async () => ({}),
    });
    await expect(cl.pollClaimer()).resolves.toBeUndefined();
    expect(await ob.pendingCount(['ses-T'], root)).toBe(1);
    cl.clearClaimerTimer();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('non-terminal post status releases for redelivery', async () => {
    const { root, restore } = await freshRoot('mesh-clm-post500-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (!init?.method || init.method === 'GET') {
        if (u.includes('/session/status')) return { ok: true, status: 200 } as unknown as Response;
        return { ok: true, status: 200, json: async () => ({ agent: 'beta', model: 'myprov/my-model' }) } as unknown as Response;
      }
      return { ok: false, status: 500 } as unknown as Response;
    }) as unknown as typeof fetch;
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    cl.configureClaimer({
      getOwnIds: () => ['ses-T'],
      getClient: () => ({ session: {} }),
      getRegistry: async () => ({ 'ses-T': { agent: 'beta', model: 'myprov/my-model', directory: '/tmp/t' } }),
    });
    await expect(cl.pollClaimer()).resolves.toBeUndefined();
    expect(await ob.pendingCount(['ses-T'], root)).toBe(1);
    cl.clearClaimerTimer();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });
});
