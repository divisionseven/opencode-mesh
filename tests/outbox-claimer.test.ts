// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Outbox FIFO plus atomic claim plus router split.
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

describe('outbox: durable queue with atomic claim', () => {
  it('FIFO per target — claim order equals seq order for 5 rows', async () => {
    const { root, restore } = await freshRoot('mesh-ob-fifo-');
    const ob = await import('../src/outbox.js');
    for (let i = 0; i < 5; i++)
      await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: `msg-${i}` }, root);
    const rows = await ob.claim(['ses-T'], 'owner-1', 5, root);
    expect(rows.map((r) => r.text)).toEqual(['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4']);
    const seqs = rows.map((r) => r.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    await safeRm(root); restore();
  });

  it('claim race — two owners race one row, exactly one wins, loser gets empty, no throw', async () => {
    const { root, restore } = await freshRoot('mesh-ob-race-');
    const ob = await import('../src/outbox.js');
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'once' }, root);
    const [w1, w2] = await Promise.all([
      ob.claim(['ses-T'], 'owner-A', 1, root),
      ob.claim(['ses-T'], 'owner-B', 1, root),
    ]);
    expect(w1.length + w2.length).toBe(1);
    expect(w1.length === 0 || w2.length === 0).toBe(true);
    await safeRm(root); restore();
  });

  it('ack versus release — foreign owner affects zero rows', async () => {
    const { root, restore } = await freshRoot('mesh-ob-own-');
    const ob = await import('../src/outbox.js');
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'x' }, root);
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'y' }, root);
    const mine = await ob.claim(['ses-T'], 'owner-1', 2, root);
    expect(mine.length).toBe(2);
    expect(await ob.ack(mine[0].id, 'owner-2', root)).toBe(false);
    expect(await ob.release(mine[1].id, 'owner-2', root)).toBe(false);
    expect(await ob.ack(mine[0].id, 'owner-1', root)).toBe(true);
    expect(await ob.release(mine[1].id, 'owner-1', root)).toBe(true);
    expect(await ob.pendingCount(['ses-T'], root)).toBe(1);
    await safeRm(root); restore();
  });

  it('crash recovery — stale claims requeue, fresh claims stay held', async () => {
    const { root, restore } = await freshRoot('mesh-ob-stale-');
    const ob = await import('../src/outbox.js');
    const { OUTBOX_CLAIM_TIMEOUT_MS } = await import('../src/constants.js');
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'old' }, root);
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'new' }, root);
    const claimed = await ob.claim(['ses-T'], 'owner-1', 2, root);
    expect(claimed.length).toBe(2);
    // fresh claims stay held under the real timeout
    expect(await ob.requeueStale(OUTBOX_CLAIM_TIMEOUT_MS, root)).toBe(0);
    // clock mutant (timeout zero) releases everything — proves the timeout gates, not the call
    expect(await ob.requeueStale(0, root)).toBe(2);
    const again = await ob.claim(['ses-T'], 'owner-2', 2, root);
    expect(again.length).toBe(2);
    await safeRm(root); restore();
  });

  it('ONE_MB guard runs before any transaction', async () => {
    const { root, restore } = await freshRoot('mesh-ob-1mb-');
    const ob = await import('../src/outbox.js');
    const { ONE_MB } = await import('../src/constants.js');
    await expect(
      ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'x'.repeat(ONE_MB + 1) }, root)
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(await ob.pendingCount(['ses-T'], root)).toBe(0);
    await safeRm(root); restore();
  });

  it('canonical correlation — enqueued id is branded; claim plus ack keyed by row id', async () => {
    const { root, restore } = await freshRoot('mesh-ob-corr-');
    const ob = await import('../src/outbox.js');
    const id = await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    expect(ob.isMsgId(id)).toBe(true);
    const [row] = await ob.claim(['ses-T'], 'owner-1', 1, root);
    expect(row.id).toBe(id);
    // claimer omits messageID on the wire (server brands canonical) — ack by row id succeeds
    expect(await ob.ack(row.id, 'owner-1', root)).toBe(true);
    // mutant swapping in a synthetic name fails lookup
    expect(await ob.ack('synthetic-name.json', 'owner-1', root)).toBe(false);
    await safeRm(root); restore();
  });

  it('router split — unresolvable identity queues on every leg; loopback down queues too', async () => {
    const { root, restore } = await freshRoot('mesh-route-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    const now = Date.now();
    await atomicUpdateRegistry((reg: unknown) => {
      const r = reg as Record<string, unknown>;
      r['ses-direct'] = { sessionId: 'ses-direct', agent: 'a', updatedAt: now, serveUrl: 'http://127.0.0.1:4096' };
      r['ses-claimed'] = { sessionId: 'ses-claimed', agent: 'a', updatedAt: now };
    }, root);
    const posts: string[] = [];
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      if (u.includes('/prompt_async')) {
        posts.push(u);
        return { ok: true, status: 204 } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    // Identity-driven degrade beside the route-driven one: agent-known but
    // model-missing entries resolve to null on every layer (all-miss), so the
    // direct leg queues for the claimer poller instead of POSTing a guess.
    const d = JSON.parse(
      (await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)({ target: 'ses-direct', text: 'hi' } as never, { sessionID: 'caller-x', directory: '/tmp' } as never)).output
    );
    expect(d.via).toBe('queued');
    expect(posts.filter((u) => u.includes('/prompt_async'))).toEqual([]);
    const ob = await import('../src/outbox.js');
    expect(await ob.pendingCount(['ses-direct'], root)).toBe(1);
    // No URL still queues while loopback answers; identity owns routing, not the entry.
    const c = JSON.parse(
      (await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)({ target: 'ses-claimed', text: 'hi' } as never, { sessionID: 'caller-x', directory: '/tmp' } as never)).output
    );
    expect(c.via).toBe('queued');
    expect(typeof c.id).toBe('string');
    expect(posts.filter((u) => u.includes('/prompt_async'))).toEqual([]);
    expect(await ob.pendingCount(['ses-claimed'], root)).toBe(1);
    // loopback down → claim branch, no POST to any peer path
    globalThis.fetch = (async () => { throw new Error('loopback down'); }) as unknown as typeof fetch;
    const q = JSON.parse(
      (await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)({ target: 'ses-claimed', text: 'hi queued' } as never, { sessionID: 'caller-x', directory: '/tmp' } as never)).output
    );
    expect(q.via).toBe('queued');
    expect(await ob.pendingCount(['ses-claimed'], root)).toBe(2);
    // Dead URL ignored; registry addresses never dialed.
    // model-missing entry still queues on identity before any dial
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['ses-deadurl'] = { sessionId: 'ses-deadurl', agent: 'a', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:9' };
    }, root);
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      if (u.includes('/prompt_async')) {
        posts.push(u);
        return { ok: true, status: 204 } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const d2 = JSON.parse(
      (await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)({ target: 'ses-deadurl', text: 'hi' } as never, { sessionID: 'caller-x', directory: '/tmp' } as never)).output
    );
    expect(d2.via).toBe('queued');
    expect(posts.filter((u) => u.includes('/prompt_async'))).toEqual([]);
    expect(await ob.pendingCount(['ses-deadurl'], root)).toBe(1);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('ENOSPC fan-out — one full peer reports failed STORAGE_FULL, siblings ok, no whole throw', async () => {
    const { root, restore } = await freshRoot('mesh-nospc2-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const prevBc = process.env.MESH_BROADCAST;
    process.env.MESH_BROADCAST = '1';
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    const now = Date.now();
    await atomicUpdateRegistry((reg: unknown) => {
      const r = reg as Record<string, unknown>;
      for (let i = 0; i < 3; i++) r[`ok-${i}`] = { sessionId: `ok-${i}`, agent: 'a', updatedAt: now };
    }, root);
    globalThis.fetch = (async () => { throw new Error('loopback down — claim path takes over'); }) as unknown as typeof fetch;
    vi.resetModules();
    vi.doMock('../src/outbox.js', async (importOriginal) => {
      const mod = (await importOriginal()) as Record<string, unknown>;
      const { MeshError } = (await import('../src/errors.js')) as typeof import('../src/errors.js');
      return {
        ...mod,
        enqueue: async (input: { target_session: string }) => {
          if (input.target_session === 'ok-1') throw new MeshError('STORAGE_FULL', 'disk full');
          return (mod.enqueue as (i: unknown, m?: string) => Promise<string>)(input, root);
        },
      };
    });
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)({ target: 'all', text: 'hi', broadcast: true } as never, { sessionID: 'caller-nospc', directory: '/tmp' } as never);
    const j = JSON.parse(out.output) as { peers: number; ok: number; failed: Array<{ peerId: string; code?: string }>; via: string };
    expect(j.peers).toBe(3);
    expect(j.ok).toBe(2);
    expect(j.failed.map((f) => f.peerId)).toContain('ok-1');
    expect(j.failed.find((f) => f.peerId === 'ok-1')?.code).toBe('STORAGE_FULL');
    vi.doUnmock('../src/outbox.js');
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevBc === undefined) delete process.env.MESH_BROADCAST; else process.env.MESH_BROADCAST = prevBc;
    await safeRm(root); restore();
  });

  it('claimer poll — model-missing receiver releases for redelivery with zero injects', async () => {
    const { root, restore } = await freshRoot('mesh-claim-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const injected: unknown[] = [];
    const fakeClient = {
      session: {
        status: async () => ({ 'ses-owned': { type: 'idle' } }),
        promptAsync: async (o: unknown) => {
          injected.push(o);
          return {};
        },
      },
    };
    vi.resetModules();
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const seam = await import('../plugin/test-seam.js');
    const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ client: fakeClient });
    const ob = await import('../src/outbox.js');
    await ob.enqueue({ target_session: 'ses-owned', from_session: 'ses-from', from_agent: 'alpha', text: 'hello claim' }, root);
    // own the session first (session.created registers it in seenSessions)
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

  it('claimer poll — modeled receiver keeps branding plus triple with noReply omitted', async () => {
    const { root, restore } = await freshRoot('mesh-claim-echo-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const injected: unknown[] = [];
    const fakeClient = {
      session: {
        status: async () => ({ 'ses-owned': { type: 'idle' } }),
        promptAsync: async (o: unknown) => {
          injected.push(o);
          return {};
        },
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
    const rowId = await ob.enqueue({ target_session: 'ses-owned', from_session: 'ses-from', from_agent: 'alpha', text: 'hello claim' }, root);
    // own the session first (session.created registers it in seenSessions)
    await (hooks.event as (e: unknown) => Promise<void>)({ event: { type: 'session.created', properties: { info: { id: 'ses-owned', directory: '/tmp/x', agent: 'beta', title: 'Work' } } } });
    await (seam.pollClaimer as () => Promise<void>)();
    expect(injected.length).toBe(1);
    const call = injected[0] as { path: { id: string }; body: { agent?: string; parts: Array<{ text: string }>; model: unknown; messageID: string; noReply: boolean } };
    expect(call.path.id).toBe('ses-owned');
    // receiver triple: the wire agent names the receiver (`beta`), never the sender; the prefix keeps raw attribution
    expect('agent' in call.body).toBe(true);
    expect(call.body.agent).toBe('beta');
    expect(call.body.parts[0].text).toBe('[OC-MESH | SENDER (QUARANTINED): alpha - ses-from]\n\nhello claim');
    // Envelope carried: claimer brands envelope id for empty-part rows.
    expect(call.body.messageID).toBe(rowId);
    expect(call.body.model).toEqual({ providerID: 'myprov', modelID: 'my-model' });
    expect('noReply' in call.body).toBe(false);
    expect(await ob.pendingCount(['ses-owned'], root)).toBe(0);
    await (hooks.dispose as () => Promise<void>)();
    await (seam.pollClaimer as () => Promise<void>)();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('claimer poll — model-missing silent row releases with zero injects', async () => {
    const { root, restore } = await freshRoot('mesh-claimsil-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const injected: unknown[] = [];
    const fakeClient = {
      session: {
        status: async () => ({ 'ses-owned': { type: 'idle' } }),
        promptAsync: async (o: unknown) => {
          injected.push(o);
          return {};
        },
      },
    };
    vi.resetModules();
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const seam = await import('../plugin/test-seam.js');
    const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ client: fakeClient });
    const ob = await import('../src/outbox.js');
    await ob.enqueue({ target_session: 'ses-owned', from_session: 'ses-from', from_agent: 'alpha', text: 'quiet claim', silent: true }, root);
    // own the session first (session.created registers it in seenSessions)
    await (hooks.event as (e: unknown) => Promise<void>)({ event: { type: 'session.created', properties: { info: { id: 'ses-owned', directory: '/tmp/x', agent: 'beta', title: 'Work' } } } });
    await (seam.pollClaimer as () => Promise<void>)();
    // Same shape as the wake defer half: the silent noReply pin is covered by
    // the modeled companion plus the wake parity leg.
    expect(injected).toEqual([]);
    expect(await ob.pendingCount(['ses-owned'], root)).toBe(1);
    await (hooks.dispose as () => Promise<void>)();
    await (seam.pollClaimer as () => Promise<void>)();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('receipt-by-id — queued, injected-progressing, failed-permanent, peers surface', async () => {
    const { root, restore } = await freshRoot('mesh-receipt-');
    const ob = await import('../src/outbox.js');
    const id = await ob.enqueue({ target_session: 'ses-R', from_session: 'ses-F', from_agent: 'a', text: 'rcpt' }, root);
    let r = await ob.receiptById(id, root);
    expect(r.state).toBe('queued');
    expect(r.target_session).toBe('ses-R');
    await ob.claim(['ses-R'], 'owner-r', 1, root);
    r = await ob.receiptById(id, root);
    expect(r.state).toBe('injected-progressing');
    await ob.ack(id, 'owner-r', root);
    r = await ob.receiptById(id, root);
    expect(r.state).toBe('injected-progressing');
    r = await ob.receiptById('msg_00000000000000deadbeef0000', root);
    expect(r.state).toBe('failed-permanent');
    expect(r.reason).toBe('unknown-receipt');
    // peers receipt arg surfaces the same lookup over the tool boundary
    const { mesh_peers } = await import('../src/tools/mesh_peers.js');
    const out = await (mesh_peers.execute as (...a: never[]) => Promise<{ output: string }>)({ receipt: id } as never, { sessionID: 'x' } as never);
    expect(JSON.parse(out.output).receipt.state).toBe('injected-progressing');
    await safeRm(root); restore();
  });

  it('Depth cap overflows reject newest STORAGE_FULL, never silent drop', async () => {
    const { root, restore } = await freshRoot('mesh-depth-');
    const ob = await import('../src/outbox.js');
    const { OUTBOX_DEPTH_CAP } = await import('../src/constants.js');
    for (let i = 0; i < OUTBOX_DEPTH_CAP; i++)
      await ob.enqueue({ target_session: 'ses-deep', from_session: 'ses-F', from_agent: 'a', text: `d-${i}` }, root);
    const err = await ob.enqueue({ target_session: 'ses-deep', from_session: 'ses-F', from_agent: 'a', text: 'overflow' }, root).catch((e: any) => e);
    expect(err.code).toBe('STORAGE_FULL');
    // siblings unaffected: other targets still admit
    const okId = await ob.enqueue({ target_session: 'ses-other', from_session: 'ses-F', from_agent: 'a', text: 'fine' }, root);
    expect(typeof okId).toBe('string');
    expect(await ob.pendingCount(['ses-deep'], root)).toBe(OUTBOX_DEPTH_CAP);
    await safeRm(root); restore();
  });

  it('Idempotent enqueue with same envelope id twice yields one row', async () => {
    const { root, restore } = await freshRoot('mesh-idem-');
    const ob = await import('../src/outbox.js');
    const { newMessageId } = await import('../src/outbox.js');
    const id = newMessageId();
    const first = await ob.enqueue({ id, target_session: 'ses-I', from_session: 'ses-F', from_agent: 'a', text: 'once' }, root);
    const second = await ob.enqueue({ id, target_session: 'ses-I', from_session: 'ses-F', from_agent: 'a', text: 'once' }, root);
    expect(first).toBe(id);
    expect(second).toBe(id);
    expect(await ob.pendingCount(['ses-I'], root)).toBe(1);
    await safeRm(root); restore();
  });

  it('Claimer busy-wait retained in queue policy; inject deferred, then delivered', async () => {
    const { root, restore } = await freshRoot('mesh-qbusy-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const injected: unknown[] = [];
    const fakeClient = {
      session: {
        status: async () => ({ 'busy-owned': { type: 'busy' } }),
        promptAsync: async (o: unknown) => { injected.push(o); return {}; },
      },
    };
    vi.resetModules();
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const seam = await import('../plugin/test-seam.js');
    const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ client: fakeClient });
    const ob = await import('../src/outbox.js');
    // Pre-seed with model so resolver precedes status wait; without seed,
    // gate and inject fail together (vacuous-pass prevention).
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['busy-owned'] = { sessionId: 'busy-owned', agent: 'beta', model: 'myprov/my-model', updatedAt: Date.now() };
    }, root);
    await ob.enqueue({ target_session: 'busy-owned', from_session: 'ses-from', from_agent: 'alpha', text: 'patient' }, root);
    await (hooks.event as (e: unknown) => Promise<void>)({ event: { type: 'session.created', properties: { info: { id: 'busy-owned', directory: '/tmp/x', agent: 'beta', title: 'Work' } } } });
    await (seam.pollClaimer as () => Promise<void>)();
    expect(injected.length).toBe(1);
    expect(await ob.pendingCount(['busy-owned'], root)).toBe(0);
    await (hooks.dispose as () => Promise<void>)();
    await (seam.pollClaimer as () => Promise<void>)();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('mutant probe: stripping the busy seed model releases before the status wait', async () => {
    const { root, restore } = await freshRoot('mesh-qbusy-mutant-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const injected: unknown[] = [];
    const fakeClient = {
      session: {
        status: async () => ({ 'busy-owned': { type: 'busy' } }),
        promptAsync: async (o: unknown) => { injected.push(o); return {}; },
      },
    };
    vi.resetModules();
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const seam = await import('../plugin/test-seam.js');
    const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ client: fakeClient });
    const ob = await import('../src/outbox.js');
    await ob.enqueue({ target_session: 'busy-owned', from_session: 'ses-from', from_agent: 'alpha', text: 'patient' }, root);
    await (hooks.event as (e: unknown) => Promise<void>)({ event: { type: 'session.created', properties: { info: { id: 'busy-owned', directory: '/tmp/x', agent: 'beta', title: 'Work' } } } });
    await (seam.pollClaimer as () => Promise<void>)();
    // Wire resolve precedes the busy wait: unresolvable identity releases
    // fast with zero injects instead of waiting then delivering.
    expect(injected).toEqual([]);
    expect(await ob.pendingCount(['busy-owned'], root)).toBe(1);
    await (hooks.dispose as () => Promise<void>)();
    await (seam.pollClaimer as () => Promise<void>)();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('body guard refuses bodies at or over 1MB, admits below', async () => {
    const { root, restore } = await freshRoot('mesh-ob-body-');
    const ob = await import('../src/outbox.js');
    const { ONE_MB } = await import('../src/constants.js');
    expect(() => ob.assertBodySendable(ONE_MB)).toThrow(/413/);
    expect(() => ob.assertBodySendable(ONE_MB - 1)).not.toThrow();
    expect(() => ob.assertSendable('x', ONE_MB)).toThrow(/413/);
    await safeRm(root); restore();
  });

  it('model parser requires present token', async () => {
    const { root, restore } = await freshRoot('mesh-ob-model-');
    const ob = await import('../src/outbox.js');
    expect(ob.resolveMeshModel({ model: 'nomodel' })).toEqual({ providerID: 'opencode', modelID: 'nomodel' });
    expect(() => ob.resolveMeshModel({} as unknown as { model: string })).toThrow();
    expect(() => ob.resolveMeshModel(undefined as unknown as { model: string })).toThrow();
    expect(() => ob.resolveMeshModel({ model: '' } as unknown as { model: string })).toThrow();
    await safeRm(root); restore();
  });

  it('pre-migration outbox gains the silent column on first open', async () => {
    const { root, restore } = await freshRoot('mesh-ob-migrate-');
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(join(root, 'outbox.db'));
    raw.exec('CREATE TABLE outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, target_session TEXT NOT NULL, from_session TEXT NOT NULL, from_agent TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, broadcast_id TEXT, claimed_by TEXT, claimed_at INTEGER, delivered_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0)');
    raw.close();
    const ob = await import('../src/outbox.js');
    const id = await ob.enqueue({ target_session: 'ses-M', from_session: 'ses-F', from_agent: 'a', text: 'migrated' }, root);
    const r = await ob.receiptById(id, root);
    expect(r.state).toBe('queued');
    await safeRm(root); restore();
  });

  it('concurrent same-id enqueues collapse to one row', async () => {
    const { root, restore } = await freshRoot('mesh-ob-raceid-');
    const ob = await import('../src/outbox.js');
    const id = ob.newMessageId();
    const [a, b] = await Promise.all([
      ob.enqueue({ id, target_session: 'ses-U', from_session: 'ses-F', from_agent: 'a', text: 'once' }, root),
      ob.enqueue({ id, target_session: 'ses-U', from_session: 'ses-F', from_agent: 'a', text: 'once' }, root),
    ]);
    expect(a).toBe(id);
    expect(b).toBe(id);
    expect(await ob.pendingCount(['ses-U'], root)).toBe(1);
    await safeRm(root); restore();
  });

  it('enqueue with an unallowlisted id rejects before storage', async () => {
    const { root, restore } = await freshRoot('mesh-ob-badid-');
    const ob = await import('../src/outbox.js');
    await expect(
      ob.enqueue({ target_session: 'bad id!', from_session: 'ses-F', from_agent: 'a', text: 'x' }, root)
    ).rejects.toThrow(/400/);
    expect(await ob.pendingCount(['ses-F'], root)).toBe(0);
    await safeRm(root); restore();
  });

  it('claim with empty ids or zero limit resolves empty', async () => {
    const { root, restore } = await freshRoot('mesh-ob-emptclaim-');
    const ob = await import('../src/outbox.js');
    expect(await ob.claim([], 'owner-e', 1, root)).toEqual([]);
    expect(await ob.claim(['ses-X'], 'owner-e', 0, root)).toEqual([]);
    await safeRm(root); restore();
  });

  it('pendingCount with empty ids resolves zero', async () => {
    const { root, restore } = await freshRoot('mesh-ob-emptcount-');
    const ob = await import('../src/outbox.js');
    expect(await ob.pendingCount([], root)).toBe(0);
    await safeRm(root); restore();
  });

  it('receipt reads dead-lettered past max attempts and TTL', async () => {
    const { root, restore } = await freshRoot('mesh-ob-dead-');
    const ob = await import('../src/outbox.js');
    const { OUTBOX_TTL_MS, OUTBOX_MAX_ATTEMPTS } = await import('../src/constants.js');
    const id = await ob.enqueue({ target_session: 'ses-D', from_session: 'ses-F', from_agent: 'a', text: 'old' }, root);
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(join(root, 'outbox.db'));
    raw.prepare('UPDATE outbox SET attempts = ?, created_at = ? WHERE id = ?').run(OUTBOX_MAX_ATTEMPTS, Date.now() - OUTBOX_TTL_MS - 1000, id);
    raw.close();
    const r = await ob.receiptById(id, root);
    expect(r.state).toBe('dead-lettered');
    expect(r.reason).toBe('max-attempts');
    await safeRm(root); restore();
  });

  it('collectOutbox deletes delivered rows and counts dead letters', async () => {
    const { root, restore } = await freshRoot('mesh-ob-collect-');
    const ob = await import('../src/outbox.js');
    const { OUTBOX_TTL_MS, OUTBOX_MAX_ATTEMPTS } = await import('../src/constants.js');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push(await ob.enqueue({ target_session: 'ses-C', from_session: 'ses-F', from_agent: 'a', text: `done-${i}` }, root));
    const claimed = await ob.claim(['ses-C'], 'owner-c', 3, root);
    for (const row of claimed) await ob.ack(row.id, 'owner-c', root);
    const d1 = await ob.enqueue({ target_session: 'ses-C', from_session: 'ses-F', from_agent: 'a', text: 'dead-1' }, root);
    const d2 = await ob.enqueue({ target_session: 'ses-C', from_session: 'ses-F', from_agent: 'a', text: 'dead-2' }, root);
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(join(root, 'outbox.db'));
    const ancient = Date.now() - OUTBOX_TTL_MS - 1000;
    raw.prepare('UPDATE outbox SET attempts = ?, created_at = ? WHERE id = ?').run(OUTBOX_MAX_ATTEMPTS, ancient, d1);
    raw.prepare('UPDATE outbox SET attempts = ?, created_at = ? WHERE id = ?').run(OUTBOX_MAX_ATTEMPTS, ancient, d2);
    raw.close();
    const res = await ob.collectOutbox(Date.now() + OUTBOX_TTL_MS + 1000, OUTBOX_TTL_MS, OUTBOX_MAX_ATTEMPTS, root);
    expect(res.deleted).toBe(5);
    expect(res.deadLetter).toBe(2);
    await safeRm(root); restore();
  });

  it('claimer poll with no configuration is a silent no-op', async () => {
    const { root, restore } = await freshRoot('mesh-claim-nocfg-');
    vi.resetModules();
    const cl = await import('../src/claimer.js');
    await expect(cl.pollClaimer()).resolves.toBeUndefined();
    cl.clearClaimerTimer();
    await cl.releaseClaimerOwner();
    await cl.pollClaimer();
    await safeRmArmed(root); restore();
  });

  it('claimer poll drops a throwing own-ids reader without throwing', async () => {
    const { root, restore } = await freshRoot('mesh-claim-throwids-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    vi.resetModules();
    const cl = await import('../src/claimer.js');
    cl.configureClaimer({
      getOwnIds: () => { throw new Error('ids blew up'); },
      getClient: () => null,
      getRegistry: async () => ({}),
    });
    await expect(cl.pollClaimer()).resolves.toBeUndefined();
    cl.clearClaimerTimer();
    await cl.releaseClaimerOwner();
    await cl.pollClaimer();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('claimer poll with a holey own-ids list takes the none owner and releases', async () => {
    const { root, restore } = await freshRoot('mesh-claim-hole-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    vi.resetModules();
    const cl = await import('../src/claimer.js');
    cl.configureClaimer({
      getOwnIds: () => new Array(1) as unknown as string[],
      getClient: () => null,
      getRegistry: async () => ({}),
    });
    await expect(cl.pollClaimer()).resolves.toBeUndefined();
    cl.clearClaimerTimer();
    await cl.releaseClaimerOwner();
    await cl.pollClaimer();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('claimer poll drops a corrupt store without throwing', async () => {
    const { root, restore } = await freshRoot('mesh-claim-corrupt-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'outbox.db'), Buffer.alloc(32, 0x42));
    vi.resetModules();
    const cl = await import('../src/claimer.js');
    cl.configureClaimer({
      getOwnIds: () => ['ses-x'],
      getClient: () => null,
      getRegistry: async () => ({}),
    });
    await expect(cl.pollClaimer()).resolves.toBeUndefined();
    cl.clearClaimerTimer();
    await cl.releaseClaimerOwner();
    await cl.pollClaimer();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('claimer poll without a client releases the row for redelivery', async () => {
    const { root, restore } = await freshRoot('mesh-claim-noclient-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    vi.resetModules();
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const seam = await import('../plugin/test-seam.js');
    const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({} as unknown);
    const ob = await import('../src/outbox.js');
    await ob.enqueue({ target_session: 'ses-nc', from_session: 'ses-from', from_agent: 'alpha', text: 'hold me' }, root);
    await (hooks.event as (e: unknown) => Promise<void>)({ event: { type: 'session.created', properties: { info: { id: 'ses-nc', directory: '/tmp/x', agent: 'beta', title: 'Work' } } } });
    await (seam.pollClaimer as () => Promise<void>)();
    // Single poll under MAX releases for redelivery (pending 1); terminal covered separately.
    expect(await ob.pendingCount(['ses-nc'], root)).toBe(1);
    await (hooks.dispose as () => Promise<void>)();
    await (seam.pollClaimer as () => Promise<void>)();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('claimer poll injects even when the status read throws', async () => {
    const { root, restore } = await freshRoot('mesh-claim-statusthrow-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const injected: unknown[] = [];
    const fakeClient = {
      session: {
        status: async () => { throw new Error('status blew up'); },
        promptAsync: async (o: unknown) => { injected.push(o); return {}; },
      },
    };
    vi.resetModules();
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const seam = await import('../plugin/test-seam.js');
    const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ client: fakeClient });
    const ob = await import('../src/outbox.js');
    const { atomicUpdateRegistry: atomicSt } = await import('../src/registry.js');
    await atomicSt((reg: unknown) => {
      (reg as Record<string, unknown>)['ses-st'] = { sessionId: 'ses-st', agent: 'beta', model: 'myprov/my-model', updatedAt: Date.now() };
    }, root);
    await ob.enqueue({ target_session: 'ses-st', from_session: 'ses-from', from_agent: 'alpha', text: 'despite status' }, root);
    await (hooks.event as (e: unknown) => Promise<void>)({ event: { type: 'session.created', properties: { info: { id: 'ses-st', directory: '/tmp/x', agent: 'beta', title: 'Work' } } } });
    await (seam.pollClaimer as () => Promise<void>)();
    expect(injected.length).toBe(1);
    await (hooks.dispose as () => Promise<void>)();
    await (seam.pollClaimer as () => Promise<void>)();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('claimer poll releases the row when inject throws', async () => {
    const { root, restore } = await freshRoot('mesh-claim-injectthrow-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const fakeClient = {
      session: {
        status: async () => ({}),
        promptAsync: async () => { throw new Error('inject blew up'); },
      },
    };
    vi.resetModules();
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const seam = await import('../plugin/test-seam.js');
    const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ client: fakeClient });
    const ob = await import('../src/outbox.js');
    const { atomicUpdateRegistry: atomicIj } = await import('../src/registry.js');
    await atomicIj((reg: unknown) => {
      (reg as Record<string, unknown>)['ses-ij'] = { sessionId: 'ses-ij', agent: 'beta', model: 'myprov/my-model', updatedAt: Date.now() };
    }, root);
    await ob.enqueue({ target_session: 'ses-ij', from_session: 'ses-from', from_agent: 'alpha', text: 'retry me' }, root);
    await (hooks.event as (e: unknown) => Promise<void>)({ event: { type: 'session.created', properties: { info: { id: 'ses-ij', directory: '/tmp/x', agent: 'beta', title: 'Work' } } } });
    await (seam.pollClaimer as () => Promise<void>)();
    expect(await ob.pendingCount(['ses-ij'], root)).toBe(1);
    await (hooks.dispose as () => Promise<void>)();
    await (seam.pollClaimer as () => Promise<void>)();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('claimer poll holds a max-attempts row claimed without hot redelivery', async () => {
    const { root, restore } = await freshRoot('mesh-claim-maxatt-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const fakeClient = {
      session: {
        status: async () => ({}),
        promptAsync: async () => { throw new Error('still failing'); },
      },
    };
    vi.resetModules();
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const seam = await import('../plugin/test-seam.js');
    const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ client: fakeClient });
    const ob = await import('../src/outbox.js');
    const { OUTBOX_MAX_ATTEMPTS } = await import('../src/constants.js');
    const { atomicUpdateRegistry: atomicMax } = await import('../src/registry.js');
    await atomicMax((reg: unknown) => {
      (reg as Record<string, unknown>)['ses-max'] = { sessionId: 'ses-max', agent: 'beta', model: 'myprov/my-model', updatedAt: Date.now() };
    }, root);
    const id = await ob.enqueue({ target_session: 'ses-max', from_session: 'ses-from', from_agent: 'alpha', text: 'terminal' }, root);
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(join(root, 'outbox.db'));
    raw.prepare('UPDATE outbox SET attempts = ? WHERE id = ?').run(OUTBOX_MAX_ATTEMPTS, id);
    raw.close();
    await (hooks.event as (e: unknown) => Promise<void>)({ event: { type: 'session.created', properties: { info: { id: 'ses-max', directory: '/tmp/x', agent: 'beta', title: 'Work' } } } });
    await (seam.pollClaimer as () => Promise<void>)();
    expect(await ob.claim(['ses-max'], 'owner-other', 1, root)).toEqual([]);
    await (hooks.dispose as () => Promise<void>)();
    await (seam.pollClaimer as () => Promise<void>)();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('releaseClaimerOwner drops a corrupt store without throwing', async () => {
    const { root, restore } = await freshRoot('mesh-claim-relowner-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'outbox.db'), Buffer.alloc(32, 0x43));
    vi.resetModules();
    const cl = await import('../src/claimer.js');
    cl.configureClaimer({
      getOwnIds: () => ['ses-y'],
      getClient: () => null,
      getRegistry: async () => ({}),
    });
    await cl.pollClaimer();
    await expect(cl.releaseClaimerOwner()).resolves.toBeUndefined();
    cl.clearClaimerTimer();
    await cl.releaseClaimerOwner();
    await cl.pollClaimer();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('acks via direct fallback on 204', async () => {
    // given an owned session plus a modeled sender on a fresh root
    const { root, restore } = await freshRoot('mesh-claim-direct-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    vi.resetModules();
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    const now = Date.now();
    await atomicUpdateRegistry((reg: unknown) => {
      const r = reg as Record<string, unknown>;
      r['ses-owned'] = { sessionId: 'ses-owned', agent: 'beta', model: 'myprov/my-model', updatedAt: now };
      r['ses-from'] = { sessionId: 'ses-from', agent: 'alpha', model: 'myprov/my-model', updatedAt: now };
    }, root);
    const ob = await import('../src/outbox.js');
    const rowId = await ob.enqueue({ target_session: 'ses-owned', from_session: 'ses-from', from_agent: 'alpha', text: 'hello direct' }, root);
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      if (u.includes('/prompt_async')) {
        posts.push({ url: u, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return { ok: true, status: 204 } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const cl = await import('../src/claimer.js');
    cl.configureClaimer({
      getOwnIds: () => ['ses-owned'],
      getClient: () => null,
      getRegistry: async () => (await readRegistry(root)) as Record<string, { agent?: string; directory?: string; cwd?: string; model?: string }>,
    });
    // when the claimer polls without a client while loopback answers
    await cl.pollClaimer();
    // then the row is delivered and acked with the receiver identity on the wire
    const receipt = await ob.receiptById(rowId, root);
    expect(receipt.state).toBe('injected-progressing');
    expect(await ob.pendingCount(['ses-owned'], root)).toBe(0);
    expect(posts.length).toBe(1);
    expect(posts[0].body['messageID']).toBe(rowId);
    expect(posts[0].body['agent']).toBe('beta');
    cl.clearClaimerTimer();
    await cl.releaseClaimerOwner();
    await cl.pollClaimer();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('terminalizes on direct 404 without redelivery', async () => {
    // given an owned session plus a modeled sender on a fresh root
    const { root, restore } = await freshRoot('mesh-claim-direct404-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    vi.resetModules();
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    const now = Date.now();
    await atomicUpdateRegistry((reg: unknown) => {
      const r = reg as Record<string, unknown>;
      r['ses-owned'] = { sessionId: 'ses-owned', agent: 'beta', model: 'myprov/my-model', updatedAt: now };
      r['ses-from'] = { sessionId: 'ses-from', agent: 'alpha', model: 'myprov/my-model', updatedAt: now };
    }, root);
    const ob = await import('../src/outbox.js');
    const rowId = await ob.enqueue({ target_session: 'ses-owned', from_session: 'ses-from', from_agent: 'alpha', text: 'gone direct' }, root);
    let postCount = 0;
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      if (u.includes('/prompt_async')) {
        postCount++;
        return { ok: false, status: 404 } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const cl = await import('../src/claimer.js');
    cl.configureClaimer({
      getOwnIds: () => ['ses-owned'],
      getClient: () => null,
      getRegistry: async () => (await readRegistry(root)) as Record<string, { agent?: string; directory?: string; cwd?: string; model?: string }>,
    });
    // when the claimer polls twice while the peer reports gone
    await cl.pollClaimer();
    await cl.pollClaimer();
    // then the row carries the terminal 404 reason and never re-fires
    const receipt = await ob.receiptById(rowId, root);
    expect(receipt.state).toBe('failed-permanent');
    expect(receipt.reason).toBe('direct-terminal-404');
    expect(postCount).toBe(1);
    cl.clearClaimerTimer();
    await cl.releaseClaimerOwner();
    await cl.pollClaimer();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('terminalizes on direct 401 without redelivery', async () => {
    // given an owned session plus a modeled sender on a fresh root
    const { root, restore } = await freshRoot('mesh-claim-direct401-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    vi.resetModules();
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    const now = Date.now();
    await atomicUpdateRegistry((reg: unknown) => {
      const r = reg as Record<string, unknown>;
      r['ses-owned'] = { sessionId: 'ses-owned', agent: 'beta', model: 'myprov/my-model', updatedAt: now };
      r['ses-from'] = { sessionId: 'ses-from', agent: 'alpha', model: 'myprov/my-model', updatedAt: now };
    }, root);
    const ob = await import('../src/outbox.js');
    const rowId = await ob.enqueue({ target_session: 'ses-owned', from_session: 'ses-from', from_agent: 'alpha', text: 'denied direct' }, root);
    let postCount = 0;
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      if (u.includes('/prompt_async')) {
        postCount++;
        return { ok: false, status: 401 } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const cl = await import('../src/claimer.js');
    cl.configureClaimer({
      getOwnIds: () => ['ses-owned'],
      getClient: () => null,
      getRegistry: async () => (await readRegistry(root)) as Record<string, { agent?: string; directory?: string; cwd?: string; model?: string }>,
    });
    // when the claimer polls twice while the peer denies access
    await cl.pollClaimer();
    await cl.pollClaimer();
    // then the row carries the terminal 401 reason and never re-fires
    const receipt = await ob.receiptById(rowId, root);
    expect(receipt.state).toBe('failed-permanent');
    expect(receipt.reason).toBe('direct-terminal-401');
    expect(postCount).toBe(1);
    cl.clearClaimerTimer();
    await cl.releaseClaimerOwner();
    await cl.pollClaimer();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });
});
