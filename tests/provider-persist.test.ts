// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Every mesh inject carries explicit model plus
// noReply:true so createUserMessage never takes the NoProviders death path.
// Mutant: drop the model key from one body and the persist gates redden.
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

function stub204(calls?: Array<{ url: string; init?: RequestInit }>) {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
    if (u.includes('prompt_async')) { calls?.push({ url: u, init }); return { ok: true, status: 204 } as unknown as Response; }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('provider persist matrix', () => {
  it('resolveMeshModel requires a verified-present token', async () => {
    const { resolveMeshModel } = await import('../src/outbox.js');
    expect(resolveMeshModel({ model: 'customprov/custom-model' })).toEqual({ providerID: 'customprov', modelID: 'custom-model' });
    expect(resolveMeshModel({ model: 'nomodel' })).toEqual({ providerID: 'opencode', modelID: 'nomodel' });
    expect(() => resolveMeshModel({} as unknown as { model: string })).toThrow();
    expect(() => resolveMeshModel(undefined as unknown as { model: string })).toThrow();
    expect(() => resolveMeshModel({ model: '' } as unknown as { model: string })).toThrow();
  });

  it('model-missing receiver defers with zero POSTs on both wake legs (fail-closed)', async () => {
    const { root, restore } = await freshRoot('mesh-model-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['model-target'] = { sessionId: 'model-target', agent: 'a', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' };
    }, root);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = stub204(calls);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const wakeOut = JSON.parse(
      (await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)({ target: 'model-target', text: 'hi' } as never, { sessionID: 'model-caller', directory: '/tmp' } as never)).output,
    ) as { via: string };
    // Gated tertiary: agent-known/model-missing resolves to null, so the
    // direct leg degrades to claim with zero bytes on the wire.
    expect(calls.filter((c) => c.url.includes('prompt_async'))).toEqual([]);
    expect(wakeOut.via).toBe('queued');
    const silentCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = stub204(silentCalls);
    const silentOut = JSON.parse(
      (await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)({ target: 'model-target', text: 'quiet', silent: true } as never, { sessionID: 'model-caller', directory: '/tmp' } as never)).output,
    ) as { via: string };
    expect(silentCalls.filter((c) => c.url.includes('prompt_async'))).toEqual([]);
    expect(silentOut.via).toBe('queued');
    const ob = await import('../src/outbox.js');
    expect(await ob.pendingCount(['model-target'], root)).toBe(2);
    await safeRm(root); restore();
  });

  it('registry model wins over fallback on the wire', async () => {
    const { root, restore } = await freshRoot('mesh-modelreg-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['regmodel-target'] = { sessionId: 'regmodel-target', agent: 'a', model: 'myprov/my-model', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' };
    }, root);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = stub204(calls);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)({ target: 'regmodel-target', text: 'hi' } as never, { sessionID: 'regmodel-caller', directory: '/tmp' } as never);
    const body = JSON.parse(String(calls.find((c) => c.url.includes('prompt_async'))!.init?.body));
    expect(body.model).toEqual({ providerID: 'myprov', modelID: 'my-model' });
    expect(body.agent).toBe('a');
    expect('noReply' in body).toBe(false);
    await safeRm(root); restore();
  });

  it('silent leg pins noReply under the modeled registry echo', async () => {
    const { root, restore } = await freshRoot('mesh-modelreg-silent-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['regmodel-target'] = { sessionId: 'regmodel-target', agent: 'a', model: 'myprov/my-model', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' };
    }, root);
    const silentCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = stub204(silentCalls);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      (await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)({ target: 'regmodel-target', text: 'quiet', silent: true } as never, { sessionID: 'regmodel-caller', directory: '/tmp' } as never)).output,
    ) as { via: string };
    expect(out.via).toBe('admitted');
    const silentBody = JSON.parse(String(silentCalls.find((c) => c.url.includes('prompt_async'))!.init?.body));
    expect(silentBody.model).toEqual({ providerID: 'myprov', modelID: 'my-model' });
    expect(silentBody.noReply).toBe(true);
    await safeRm(root); restore();
  });

  it('mutant probe: stripping the echo seed model degrades to queued with zero POSTs', async () => {
    const { root, restore } = await freshRoot('mesh-modelreg-mutant-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['regmodel-target'] = { sessionId: 'regmodel-target', agent: 'a', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' };
    }, root);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = stub204(calls);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      (await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)({ target: 'regmodel-target', text: 'hi' } as never, { sessionID: 'regmodel-caller', directory: '/tmp' } as never)).output,
    ) as { via: string };
    expect(calls.filter((c) => c.url.includes('prompt_async'))).toEqual([]);
    expect(out.via).toBe('queued');
    await safeRm(root); restore();
  });

  it('model-missing claim receiver releases for redelivery with zero injects (fail-closed)', async () => {
    const { root, restore } = await freshRoot('mesh-modelclaim-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const injected: unknown[] = [];
    const fakeClient = {
      session: {
        status: async () => ({ 'ses-owned': { type: 'idle' } }),
        promptAsync: async (o: unknown) => { injected.push(o); return {}; },
      },
    };
    vi.resetModules();
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const seam = await import('../plugin/test-seam.js');
    const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ client: fakeClient });
    const ob = await import('../src/outbox.js');
    await ob.enqueue({ target_session: 'ses-owned', from_session: 'ses-from', from_agent: 'alpha', text: 'hello claim' }, root);
    await (hooks.event as (e: unknown) => Promise<void>)({ event: { type: 'session.created', properties: { info: { id: 'ses-owned', directory: '/tmp/x', agent: 'beta', title: 'Work' } } } });
    await (seam.pollClaimer as () => Promise<void>)();
    // Gated tertiary: the model-missing entry resolves to null, so the claim
    // leg releases for redelivery instead of injecting a guessed triple.
    expect(injected).toEqual([]);
    expect(await ob.pendingCount(['ses-owned'], root)).toBe(1);
    await (hooks.dispose as () => Promise<void>)();
    await (seam.pollClaimer as () => Promise<void>)();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('modeled claim receiver keeps branding plus agent plus model with noReply omitted', async () => {
    const { root, restore } = await freshRoot('mesh-modelclaim-echo-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const injected: unknown[] = [];
    const fakeClient = {
      session: {
        status: async () => ({ 'ses-owned': { type: 'idle' } }),
        promptAsync: async (o: unknown) => { injected.push(o); return {}; },
      },
    };
    vi.resetModules();
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const seam = await import('../plugin/test-seam.js');
    const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ client: fakeClient });
    const ob = await import('../src/outbox.js');
    // Pre-seed WITH the model string: inherit-if-absent preserves it across
    // the model-absent session.created event, so the tertiary layer resolves.
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['ses-owned'] = { sessionId: 'ses-owned', agent: 'beta', model: 'myprov/my-model', updatedAt: Date.now() };
    }, root);
    await ob.enqueue({ target_session: 'ses-owned', from_session: 'ses-from', from_agent: 'alpha', text: 'hello claim' }, root);
    await (hooks.event as (e: unknown) => Promise<void>)({ event: { type: 'session.created', properties: { info: { id: 'ses-owned', directory: '/tmp/x', agent: 'beta', title: 'Work' } } } });
    await (seam.pollClaimer as () => Promise<void>)();
    expect(injected.length).toBe(1);
    const body = (injected[0] as { body: Record<string, unknown> }).body;
    // Envelope carried: claimer brands row.id, never omits.
    const { isMsgId } = await import('../src/outbox.js');
    expect(isMsgId(body.messageID as string)).toBe(true);
    expect(body.model).toEqual({ providerID: 'myprov', modelID: 'my-model' });
    expect(body.agent).toBe('beta');
    expect('noReply' in body).toBe(false);
    expect(await ob.pendingCount(['ses-owned'], root)).toBe(0);
    await (hooks.dispose as () => Promise<void>)();
    await (seam.pollClaimer as () => Promise<void>)();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });
});
