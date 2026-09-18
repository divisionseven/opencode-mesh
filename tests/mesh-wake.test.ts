// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Wake-by-default matrix for both legs plus env precedence.
// Default omits noReply so Runner runs; silent pins it. Mutants redden on scope change.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

const origFetch = globalThis.fetch;
const ENV_KEYS = ['OPENCODE_MESH_ROOT', 'OPENCODE_MESH_DB_PATH', 'MESH_WAKE'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.MESH_WAKE;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = origFetch as unknown as typeof fetch;
  vi.resetModules();
  vi.restoreAllMocks();
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

async function seedPeer(root: string, id = 'wake-peer'): Promise<void> {
  const { atomicUpdateRegistry } = await import('../src/registry.js');
  await atomicUpdateRegistry((reg: unknown) => {
    (reg as Record<string, unknown>)[id] = { sessionId: id, agent: 'a', model: 'myprov/my-model', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' };
  }, root);
}

async function directBody(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = stub204(calls);
  const { mesh_send } = await import('../src/tools/mesh_send.js');
  await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)(
    { target: 'wake-peer', text: 'hi wake', ...args } as never,
    { sessionID: 'wake-caller', directory: '/tmp', agent: 'build' } as never
  );
  return JSON.parse(String(calls.find((c) => c.url.includes('prompt_async'))!.init?.body));
}

describe('wake: resolver truth table (global first, then silent ?? noReply)', () => {
  it('wake default with zero configuration', async () => {
    const { resolveNoReply, isWakeEnabled } = await import('../src/wake.js');
    expect(isWakeEnabled()).toBe(true);
    expect(resolveNoReply()).toEqual({});
    expect(resolveNoReply({})).toEqual({});
    expect(resolveNoReply({ silent: false })).toEqual({});
    expect(resolveNoReply({ noReply: false })).toEqual({});
  });

  it('canonical silent wins over legacy noReply', async () => {
    const { resolveNoReply } = await import('../src/wake.js');
    expect(resolveNoReply({ silent: true })).toEqual({ noReply: true });
    expect(resolveNoReply({ silent: false, noReply: true })).toEqual({});
    expect(resolveNoReply({ noReply: true })).toEqual({ noReply: true });
  });

  it('global kill-switch precedes per-message flags', async () => {
    process.env.MESH_WAKE = '0';
    vi.resetModules();
    const { resolveNoReply, isWakeEnabled } = await import('../src/wake.js');
    expect(isWakeEnabled()).toBe(false);
    expect(resolveNoReply()).toEqual({ noReply: true });
    expect(resolveNoReply({ silent: false })).toEqual({ noReply: true });
    expect(resolveNoReply({ noReply: false })).toEqual({ noReply: true });
  });

  it('any non-"0" global value keeps wake enabled', async () => {
    process.env.MESH_WAKE = '1';
    vi.resetModules();
    const { isWakeEnabled, resolveNoReply } = await import('../src/wake.js');
    expect(isWakeEnabled()).toBe(true);
    expect(resolveNoReply()).toEqual({});
  });
});

describe('wake: direct leg key presence', () => {
  it('default omits the key with prefix plus messageID plus model intact', async () => {
    const { root, restore } = await freshRoot('mesh-wakedir-');
    await seedPeer(root);
    const body = await directBody({});
    expect('noReply' in body).toBe(false);
    expect(Object.keys(body).sort()).toEqual(['agent', 'messageID', 'model', 'parts']);
    expect(body.agent).toBe('a');
    expect(body.parts).toEqual([{ type: 'text', text: '[OC-MESH | SENDER: build - wake-caller]\n\nhi wake' }]);
    const { isMsgId } = await import('../src/outbox.js');
    expect(isMsgId(body.messageID as string)).toBe(true);
    expect(body.model).toEqual({ providerID: 'myprov', modelID: 'my-model' });
    await safeRm(root); restore();
  });

  it('mutant probe: stripping the peer model degrades to queued with zero POSTs', async () => {
    const { root, restore } = await freshRoot('mesh-wakemutant-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['wake-peer'] = { sessionId: 'wake-peer', agent: 'a', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' };
    }, root);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = stub204(calls);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      String((await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)(
        { target: 'wake-peer', text: 'hi wake' } as never,
        { sessionID: 'wake-caller', directory: '/tmp', agent: 'build' } as never,
      )).output),
    ) as { via: string };
    expect(calls.filter((c) => c.url.includes('prompt_async'))).toEqual([]);
    expect(out.via).toBe('queued');
    await safeRm(root); restore();
  });

  it('MESH_WAKE=0 pins the key', async () => {
    const { root, restore } = await freshRoot('mesh-wakekill-');
    await seedPeer(root);
    process.env.MESH_WAKE = '0';
    const body = await directBody({});
    expect(body.noReply).toBe(true);
    // global opt-out forces the SILENT marker through the same resolver
    expect((body.parts as Array<{ text: string }>)[0].text).toBe('[OC-MESH | SENDER (SILENT): build - wake-caller]\n\nhi wake');
    await safeRm(root); restore();
  });

  it('silent:true pins the key with global unset', async () => {
    const { root, restore } = await freshRoot('mesh-wakesil-');
    await seedPeer(root);
    const body = await directBody({ silent: true });
    expect(body.noReply).toBe(true);
    expect(Object.keys(body).sort()).toEqual(['agent', 'messageID', 'model', 'noReply', 'parts']);
    // silent direct leg renders the SILENT marker (verified self-attested, never QUARANTINED)
    expect((body.parts as Array<{ text: string }>)[0].text).toBe('[OC-MESH | SENDER (SILENT): build - wake-caller]\n\nhi wake');
    await safeRm(root); restore();
  });

  it('legacy noReply:true pins, noReply:false follows the global', async () => {
    const { root, restore } = await freshRoot('mesh-wakeleg-');
    await seedPeer(root);
    expect((await directBody({ noReply: true })).noReply).toBe(true);
    vi.resetModules();
    await seedPeer(root);
    expect('noReply' in (await directBody({ noReply: false }))).toBe(false);
    vi.resetModules();
    await seedPeer(root);
    process.env.MESH_WAKE = '0';
    expect((await directBody({ noReply: false })).noReply).toBe(true);
    await safeRm(root); restore();
  });

  it('MESH_WAKE=0 plus silent:false still pins (global precedence)', async () => {
    const { root, restore } = await freshRoot('mesh-wakeprec-');
    await seedPeer(root);
    process.env.MESH_WAKE = '0';
    const body = await directBody({ silent: false });
    expect(body.noReply).toBe(true);
    await safeRm(root); restore();
  });
});

describe('wake: claimer leg mirrors the direct leg', () => {
  async function injectFor(row: { target_session: string; from_session: string; from_agent: string; text: string; silent?: boolean }): Promise<{ body: Record<string, unknown>; pending: number }> {
    const prev = process.env.OPENCODE_MESH_ROOT;
    const root = process.env.OPENCODE_MESH_ROOT as string;
    const injected: unknown[] = [];
    const fakeClient = {
      session: {
        status: async () => ({ 'wake-owned': { type: 'idle' } }),
        promptAsync: async (o: unknown) => { injected.push(o); return {}; },
      },
    };
    vi.resetModules();
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const seam = await import('../plugin/test-seam.js');
    const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ client: fakeClient });
    const ob = await import('../src/outbox.js');
    // Pre-seed WITH the model string: inherit-if-absent preserves it across
    // the model-absent session.created event while the fake client (no `get`)
    // keeps the registry layer as the triple source.
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['wake-owned'] = { sessionId: 'wake-owned', agent: 'beta', model: 'myprov/my-model', updatedAt: Date.now() };
    }, root);
    await ob.enqueue(row, root);
    await (hooks.event as (e: unknown) => Promise<void>)({ event: { type: 'session.created', properties: { info: { id: 'wake-owned', directory: '/tmp/x', agent: 'beta', title: 'Work' } } } });
    await (seam.pollClaimer as () => Promise<void>)();
    const body = (injected[0] as { body: Record<string, unknown> }).body;
    const pending = await ob.pendingCount(['wake-owned'], root);
    await (hooks.dispose as () => Promise<void>)();
    await (seam.pollClaimer as () => Promise<void>)();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    return { body, pending };
  }

  it('default omits the key and acks the row', async () => {
    const { root, restore } = await freshRoot('mesh-wakeclaim-');
    process.env.OPENCODE_MESH_ROOT = root;
    const { body, pending } = await injectFor({ target_session: 'wake-owned', from_session: 'ses-from', from_agent: 'alpha', text: 'hello claim' });
    expect('noReply' in body).toBe(false);
    expect(((body.parts as unknown as Array<{ text: string }>)[0].text)).toBe('[OC-MESH | SENDER (QUARANTINED): alpha - ses-from]\n\nhello claim');
    expect(pending).toBe(0);
    await safeRmArmed(root); restore();
  });

  it('MESH_WAKE=0 pins the key on the claim leg', async () => {
    const { root, restore } = await freshRoot('mesh-wakeclaimkill-');
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.MESH_WAKE = '0';
    const { body, pending } = await injectFor({ target_session: 'wake-owned', from_session: 'ses-from', from_agent: 'alpha', text: 'hello claim' });
    expect(body.noReply).toBe(true);
    // global opt-out plus unattested sender coincide: combined shape, fixed order
    expect(((body.parts as unknown as Array<{ text: string }>)[0].text)).toBe('[OC-MESH | SENDER (SILENT) (QUARANTINED): alpha - ses-from]\n\nhello claim');
    expect(pending).toBe(0);
    await safeRmArmed(root); restore();
  });

  it('queue parity: silent row pins, default row omits on the same leg', async () => {
    const { root, restore } = await freshRoot('mesh-wakeparity-');
    process.env.OPENCODE_MESH_ROOT = root;
    const silent = await injectFor({ target_session: 'wake-owned', from_session: 'ses-from', from_agent: 'alpha', text: 'quiet', silent: true });
    expect(silent.body.noReply).toBe(true);
    expect(((silent.body.parts as unknown as Array<{ text: string }>)[0].text)).toBe('[OC-MESH | SENDER (SILENT) (QUARANTINED): alpha - ses-from]\n\nquiet');
    const loud = await injectFor({ target_session: 'wake-owned', from_session: 'ses-from', from_agent: 'alpha', text: 'loud' });
    expect('noReply' in loud.body).toBe(false);
    expect(((loud.body.parts as unknown as Array<{ text: string }>)[0].text)).toBe('[OC-MESH | SENDER (QUARANTINED): alpha - ses-from]\n\nloud');
    await safeRmArmed(root); restore();
  });
});

describe('wake: silent column migration', () => {
  it('fresh DBs carry the column from DDL', async () => {
    const { root, restore } = await freshRoot('mesh-wakeddl-');
    const ob = await import('../src/outbox.js');
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(`${root}/outbox.db`);
    try {
      const cols = db.prepare(`PRAGMA table_info(outbox)`).all() as unknown as Array<{ name: string }>;
      expect(cols.some((c) => c.name === 'silent')).toBe(true);
    } finally {
      db.close();
    }
    await safeRm(root); restore();
  });

  it('pre-existing DBs gain the column on first open with rows intact at wake default', async () => {
    const { root, restore } = await freshRoot('mesh-wakemig-');
    const { ensureOutbox } = await import('../src/outbox.js');
    const { resolveOutboxPath } = await import('../src/xdg.js');
    await ensureOutbox(root);
    const { DatabaseSync } = await import('node:sqlite');
    const legacy = new DatabaseSync(resolveOutboxPath(root));
    try {
      legacy.exec(`CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,target_session TEXT NOT NULL,from_session TEXT NOT NULL,from_agent TEXT NOT NULL,text TEXT NOT NULL,created_at INTEGER NOT NULL,broadcast_id TEXT,claimed_by TEXT,claimed_at INTEGER,delivered_at INTEGER,attempts INTEGER NOT NULL DEFAULT 0)`);
      legacy.exec(`INSERT INTO outbox(id,target_session,from_session,from_agent,text,created_at) VALUES('msg_legacy000001234567890123456789','ses-T','ses-F','a','legacy row',1)`);
    } finally {
      legacy.close();
    }
    vi.resetModules();
    const ob = await import('../src/outbox.js');
    const rows = await ob.claim(['ses-T'], 'owner-mig', 1, root);
    expect(rows.length).toBe(1);
    expect(rows[0].text).toBe('legacy row');
    expect(rows[0].silent).toBe(0);
    expect(await ob.ack(rows[0].id, 'owner-mig', root)).toBe(true);
    await safeRm(root); restore();
  });
});
