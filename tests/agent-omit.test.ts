// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// The wire agent names the receiver, never the
// sender; the prefix keeps raw attribution. Mutant: put a sender agent on the
// wire and the receiver-triple gates redden.
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

function stub204(calls: Array<{ url: string; init?: RequestInit }>) {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/session/status')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    if (u.includes('prompt_async')) { calls.push({ url: u, init }); return { ok: true, status: 204 } as unknown as Response; }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function directBody(root: string, agent: string | undefined): Promise<Record<string, unknown>> {
  const { atomicUpdateRegistry } = await import('../src/registry.js');
  await atomicUpdateRegistry((reg: unknown) => {
    (reg as Record<string, unknown>)['omit-peer'] = { sessionId: 'omit-peer', agent: 'peer-agent', model: 'myprov/my-model', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' };
  }, root);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = stub204(calls);
  const { mesh_send } = await import('../src/tools/mesh_send.js');
  await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)(
    { target: 'omit-peer', text: 'hi omit' } as never,
    { sessionID: 'omit-caller', directory: '/tmp', ...(agent === undefined ? {} : { agent }) } as never
  );
  return JSON.parse(String(calls.find((c) => c.url.includes('prompt_async'))!.init?.body));
}

describe('agent omit matrix', () => {
  it('unknown sender values never reach the wire (receiver triple flows, prefix intact)', async () => {
    const { root, restore } = await freshRoot('mesh-omit-');
    for (const unknown of ['alpha', 'custom-agent-xyz', 'unknown']) {
      vi.resetModules();
      const body = await directBody(root, unknown);
      expect('agent' in body).toBe(true);
      expect(body.agent).toBe('peer-agent');
      expect(body.parts).toEqual([{ type: 'text', text: `[OC-MESH | SENDER: ${unknown} - omit-caller]\n\nhi omit` }]);
      expect('noReply' in body).toBe(false);
    }
    await safeRm(root); restore();
  });

  it('silent leg pins noReply:true with prefix attribution intact', async () => {
    const { root, restore } = await freshRoot('mesh-omitsil-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['omit-peer'] = { sessionId: 'omit-peer', agent: 'peer-agent', model: 'myprov/my-model', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' };
    }, root);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = stub204(calls);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)(
      { target: 'omit-peer', text: 'hi omit', silent: true } as never,
      { sessionID: 'omit-caller', directory: '/tmp', agent: 'alpha' } as never
    );
    const body = JSON.parse(String(calls.find((c) => c.url.includes('prompt_async'))!.init?.body));
    expect('agent' in body).toBe(true);
    expect(body.agent).toBe('peer-agent');
    expect(body.parts).toEqual([{ type: 'text', text: '[OC-MESH | SENDER (SILENT): alpha - omit-caller]\n\nhi omit' }]);
    expect(body.noReply).toBe(true);
    await safeRm(root); restore();
  });

  it('receiver agent stays on the wire with exact body keys', async () => {
    const { root, restore } = await freshRoot('mesh-omitseed-');
    const body = await directBody(root, 'build');
    expect(Object.keys(body).sort()).toEqual(['agent', 'messageID', 'model', 'parts']);
    expect(body.agent).toBe('peer-agent');
    expect('noReply' in body).toBe(false);
    await safeRm(root); restore();
  });

  it('sender custom keys never reach the wire (receiver triple flows)', async () => {
    const { root, restore } = await freshRoot('mesh-omitreg-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['reg-caller'] = { sessionId: 'reg-caller', agent: 'custom-agent-xyz', updatedAt: Date.now() };
    }, root);
    const body = await directBody(root, 'custom-agent-xyz');
    expect(body.agent).toBe('peer-agent');
    await safeRm(root); restore();
  });

  it('claimer inject carries the receiver triple with prefix intact', async () => {
    const { root, restore } = await freshRoot('mesh-omitclaim-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const injected: unknown[] = [];
    const fakeClient = {
      session: {
        status: async () => ({ 'omit-owned': { type: 'idle' } }),
        promptAsync: async (o: unknown) => { injected.push(o); return {}; },
      },
    };
    vi.resetModules();
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const seam = await import('../plugin/test-seam.js');
    const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ client: fakeClient });
    const ob = await import('../src/outbox.js');
    // Pre-seed WITH the model string so the tertiary layer resolves while the
    // fake client (no `get`) keeps the registry layer as the triple source.
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['omit-owned'] = { sessionId: 'omit-owned', agent: 'beta', model: 'myprov/my-model', updatedAt: Date.now() };
    }, root);
    await ob.enqueue({ target_session: 'omit-owned', from_session: 'ses-from', from_agent: 'alpha', text: 'hello claim' }, root);
    await (hooks.event as (e: unknown) => Promise<void>)({ event: { type: 'session.created', properties: { info: { id: 'omit-owned', directory: '/tmp/x', agent: 'beta', title: 'Work' } } } });
    await (seam.pollClaimer as () => Promise<void>)();
    expect(injected.length).toBe(1);
    const call = injected[0] as { body: Record<string, unknown> & { parts: Array<{ text: string }> } };
    expect('agent' in call.body).toBe(true);
    expect(call.body.agent).toBe('beta');
    expect(call.body.parts[0].text).toBe('[OC-MESH | SENDER (QUARANTINED): alpha - ses-from]\n\nhello claim');
    expect('noReply' in call.body).toBe(false);
    expect(await ob.pendingCount(['omit-owned'], root)).toBe(0);
    await (hooks.dispose as () => Promise<void>)();
    await (seam.pollClaimer as () => Promise<void>)();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('mutant probe: stripping the peer model degrades to queued with zero POSTs', async () => {
    const { root, restore } = await freshRoot('mesh-omit-mutant-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['omit-peer'] = { sessionId: 'omit-peer', agent: 'peer-agent', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' };
    }, root);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = stub204(calls);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      String((await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)(
        { target: 'omit-peer', text: 'hi omit' } as never,
        { sessionID: 'omit-caller', directory: '/tmp', agent: 'alpha' } as never,
      )).output),
    ) as { via: string };
    expect(calls.filter((c) => c.url.includes('prompt_async'))).toEqual([]);
    expect(out.via).toBe('queued');
    await safeRm(root); restore();
  });
});
