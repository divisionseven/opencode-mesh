// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Receiver keeps its own agent plus model.
// Server diff computes zero difference; mutant sender triple reddens non-controls.
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

type ModelRef = { providerID: string; modelID: string };
type LiveRow = { agent: string; model: ModelRef | { providerID: string; id: string }; variant?: string };
type WireBody = {
  agent?: string;
  model?: ModelRef;
  variant?: string;
  parts: Array<{ type: string; text: string }>;
  messageID: string;
  noReply?: boolean;
};
type WirePost = { id: string; body: WireBody };

// Host default agent observed on omitted-agent delivery (this host resolves it
// to `manager`); the simulator mirrors that single value, never a guess.
const HOST_DEFAULT_AGENT = 'manager';
// Per-agent configured defaults mirroring the report's sight-to-mimo shape:
// an agent WITH a default beats the wire model under S3 when the wire omits it.
const AGENT_DEFAULTS: Record<string, ModelRef> = {
  beta: { providerID: 'opencode', modelID: 'default' },
  build: { providerID: 'opencode', modelID: 'default' },
  sight: { providerID: 'acme', modelID: 'sight-default' },
  manager: { providerID: 'opencode', modelID: 'default' },
};

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

function stubDirect(posts: WirePost[]) {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/session/status')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    if (u.includes('prompt_async')) {
      const body = JSON.parse(String(init?.body)) as WireBody;
      const id = u.split('/session/')[1]?.split('/')[0] ?? '';
      posts.push({ id, body });
      return { ok: true, status: 204 } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

function makeClient(live: Map<string, LiveRow>, wireBodies: WirePost[], setAgentLog: unknown[]) {
  return {
    session: {
      status: async () => Object.fromEntries([...live.keys()].map((id) => [id, { type: 'idle' }])),
      get: async (o: unknown) => {
        const id = (o as { path?: { id?: string } }).path?.id;
        const row = id !== undefined ? live.get(id) : undefined;
        if (!row) return null;
        const m = row.model;
        return {
          agent: row.agent,
          model: { providerID: m.providerID, modelID: 'modelID' in m ? m.modelID : m.id },
          ...(row.variant !== undefined ? { variant: row.variant } : {}),
        };
      },
      // Server-semantics simulator: S2 wire-or-host-default agent, S3
      // wire??agent-default??stored model, S4 persist-on-any-diff.
      promptAsync: async (o: unknown) => {
        const { path, body } = o as { path: { id: string }; body: WireBody };
        wireBodies.push({ id: path.id, body });
        const stored = live.get(path.id);
        if (!stored) return {};
        const agent = typeof body.agent === 'string' && body.agent.length > 0 ? body.agent : HOST_DEFAULT_AGENT;
        const storedModel = 'modelID' in stored.model ? { ...stored.model } : { providerID: stored.model.providerID, modelID: stored.model.id };
        const model = body.model ?? AGENT_DEFAULTS[agent] ?? storedModel;
        const variant = body.variant ?? stored.variant;
        const sameModel = model.providerID === storedModel.providerID && model.modelID === storedModel.modelID;
        const sameVariant = body.variant === undefined || variant === stored.variant;
        if (agent !== stored.agent || !sameModel || !sameVariant) {
          live.set(path.id, { agent, model: { ...model }, ...(variant !== undefined ? { variant } : {}) });
          setAgentLog.push({ id: path.id, agent, model: { ...model }, ...(variant !== undefined ? { variant } : {}) });
        }
        return {};
      },
    },
  };
}

async function runClaim(
  root: string,
  live: Map<string, LiveRow>,
  row: { target_session: string; from_session: string; from_agent: string; text: string; silent?: boolean },
  targetInfo: { agent?: string },
  senderAgent?: string,
): Promise<{ wireBodies: WirePost[]; setAgentLog: unknown[]; pending: number }> {
  const prev = process.env.OPENCODE_MESH_ROOT;
  process.env.OPENCODE_MESH_ROOT = root;
  const wireBodies: WirePost[] = [];
  const setAgentLog: unknown[] = [];
  const fakeClient = makeClient(live, wireBodies, setAgentLog);
  vi.resetModules();
  const pluginMod = await import('../plugin/opencode-mesh.js');
  const seam = await import('../plugin/test-seam.js');
  const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ client: fakeClient });
  const ob = await import('../src/outbox.js');
  if (senderAgent !== undefined) {
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)[row.from_session] = {
        sessionId: row.from_session,
        agent: senderAgent,
        directory: '/tmp',
        updatedAt: Date.now(),
      };
    }, root);
  }
  await ob.enqueue(
    { target_session: row.target_session, from_session: row.from_session, from_agent: row.from_agent, text: row.text, silent: row.silent },
    root,
  );
  await (hooks.event as (e: unknown) => Promise<void>)({
    event: {
      type: 'session.created',
      properties: { info: { id: row.target_session, directory: '/tmp/x', title: 'Work', ...(targetInfo.agent !== undefined ? { agent: targetInfo.agent } : {}) } },
    },
  });
  await (seam.pollClaimer as () => Promise<void>)();
  const pending = await ob.pendingCount([row.target_session], root);
  await (hooks.dispose as () => Promise<void>)();
  await (seam.pollClaimer as () => Promise<void>)();
  if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
  return { wireBodies, setAgentLog, pending };
}

describe('identity-neutral delivery: receiver keeps its own triple', () => {
  it('known modelless sender leaves a default target untouched with zero captures', async () => {
    const { root, restore } = await freshRoot('mesh-ind-a-');
    const live = new Map<string, LiveRow>([
      ['ses-a', { agent: 'build', model: { providerID: 'opencode', modelID: 'default' } }],
      ['ses-tgt', { agent: 'beta', model: { providerID: 'opencode', modelID: 'default' } }],
    ]);
    const { wireBodies, setAgentLog, pending } = await runClaim(
      root, live,
      { target_session: 'ses-tgt', from_session: 'ses-a', from_agent: 'build', text: 'hello a' },
      { agent: 'beta' }, 'build',
    );
    expect(wireBodies.length).toBe(1);
    expect(wireBodies[0].body.agent).toBe('beta');
    expect(wireBodies[0].body.model).toEqual({ providerID: 'opencode', modelID: 'default' });
    expect(live.get('ses-tgt')).toEqual({ agent: 'beta', model: { providerID: 'opencode', modelID: 'default' } });
    expect(setAgentLog).toEqual([]);
    expect(pending).toBe(0);
    await safeRmArmed(root); restore();
  });

  it('unknown sender leaves the target untouched with quarantined prefix intact', async () => {
    const { root, restore } = await freshRoot('mesh-ind-b-');
    const live = new Map<string, LiveRow>([
      ['ses-tgt', { agent: 'beta', model: { providerID: 'opencode', modelID: 'default' } }],
    ]);
    const { wireBodies, setAgentLog, pending } = await runClaim(
      root, live,
      { target_session: 'ses-tgt', from_session: 'ses-ghost', from_agent: 'alpha', text: 'hello ghost' },
      { agent: 'beta' },
    );
    expect(wireBodies.length).toBe(1);
    expect(wireBodies[0].body.agent).toBe('beta');
    expect(wireBodies[0].body.parts[0].text).toBe('[OC-MESH | SENDER (QUARANTINED): alpha - ses-ghost]\n\nhello ghost');
    expect(live.get('ses-tgt')).toEqual({ agent: 'beta', model: { providerID: 'opencode', modelID: 'default' } });
    expect(setAgentLog).toEqual([]);
    expect(pending).toBe(0);
    await safeRmArmed(root); restore();
  });

  it('explicitly modeled target keeps its triple on the claim leg', async () => {
    const { root, restore } = await freshRoot('mesh-ind-c-');
    const live = new Map<string, LiveRow>([
      ['ses-sight', { agent: 'sight', model: { providerID: 'acme', modelID: 'sight-default' } }],
      ['ses-tgt', { agent: 'beta', model: { providerID: 'myprov', modelID: 'my-model' }, variant: 'max' }],
    ]);
    const { wireBodies, setAgentLog, pending } = await runClaim(
      root, live,
      { target_session: 'ses-tgt', from_session: 'ses-sight', from_agent: 'sight', text: 'hello modeled' },
      { agent: 'beta' }, 'sight',
    );
    expect(wireBodies.length).toBe(1);
    expect(wireBodies[0].body.agent).toBe('beta');
    expect(wireBodies[0].body.model).toEqual({ providerID: 'myprov', modelID: 'my-model' });
    expect(wireBodies[0].body.variant).toBe('max');
    expect(live.get('ses-tgt')).toEqual({ agent: 'beta', model: { providerID: 'myprov', modelID: 'my-model' }, variant: 'max' });
    expect(setAgentLog).toEqual([]);
    expect(pending).toBe(0);
    await safeRmArmed(root); restore();
  });

  it('direct leg sends the receiver triple for a modeled target', async () => {
    const { root, restore } = await freshRoot('mesh-ind-cdir-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['ses-tgt'] = {
        sessionId: 'ses-tgt', agent: 'beta', model: 'myprov/my-model', updatedAt: Date.now(),
      };
    }, root);
    const posts: WirePost[] = [];
    globalThis.fetch = stubDirect(posts);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      (await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)(
        { target: 'ses-tgt', text: 'hello modeled' } as never,
        { sessionID: 'ses-sight', directory: '/tmp', agent: 'sight' } as never,
      )).output,
    ) as { ok: boolean; via: string };
    expect(out.ok).toBe(true);
    expect(out.via).toBe('admitted');
    expect(posts.length).toBe(1);
    expect(posts[0].body.agent).toBe('beta');
    expect(posts[0].body.model).toEqual({ providerID: 'myprov', modelID: 'my-model' });
    expect('noReply' in posts[0].body).toBe(false);
    await safeRm(root); restore();
  });

  it('sender session row is unchanged by its own send', async () => {
    const { root, restore } = await freshRoot('mesh-ind-d-');
    const live = new Map<string, LiveRow>([
      ['ses-sight', { agent: 'sight', model: { providerID: 'acme', modelID: 'sight-default' } }],
      ['ses-tgt', { agent: 'beta', model: { providerID: 'opencode', modelID: 'default' } }],
    ]);
    const before = JSON.parse(JSON.stringify(live.get('ses-sight')));
    const { pending } = await runClaim(
      root, live,
      { target_session: 'ses-tgt', from_session: 'ses-sight', from_agent: 'sight', text: 'hello control' },
      { agent: 'beta' }, 'sight',
    );
    expect(live.get('ses-sight')).toEqual(before);
    expect(pending).toBe(0);
    await safeRmArmed(root); restore();
  });

  it('unresolvable receiver releases for redelivery with zero writes', async () => {
    const { root, restore } = await freshRoot('mesh-ind-e-');
    const live = new Map<string, LiveRow>();
    const { wireBodies, setAgentLog, pending } = await runClaim(
      root, live,
      { target_session: 'ses-tgt', from_session: 'ses-a', from_agent: 'build', text: 'hello lost' },
      {}, 'build',
    );
    expect(wireBodies).toEqual([]);
    expect(setAgentLog).toEqual([]);
    expect(pending).toBe(1);
    await safeRmArmed(root); restore();
  });

  it('direct leg degrades to claim for an unresolvable receiver', async () => {
    const { root, restore } = await freshRoot('mesh-ind-edir-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      (reg as Record<string, unknown>)['ses-tgt'] = { sessionId: 'ses-tgt', agent: 'unknown', updatedAt: Date.now() };
    }, root);
    const posts: WirePost[] = [];
    globalThis.fetch = stubDirect(posts);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      (await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)(
        { target: 'ses-tgt', text: 'hello lost' } as never,
        { sessionID: 'ses-a', directory: '/tmp', agent: 'build' } as never,
      )).output,
    ) as { ok: boolean; via: string };
    expect(posts).toEqual([]);
    expect(out.ok).toBe(true);
    expect(out.via).toBe('queued');
    const ob = await import('../src/outbox.js');
    expect(await ob.pendingCount(['ses-tgt'], root)).toBe(1);
    await safeRm(root); restore();
  });

  it('silent row keeps noReply under the receiver triple', async () => {
    const { root, restore } = await freshRoot('mesh-ind-f-');
    const live = new Map<string, LiveRow>([
      ['ses-a', { agent: 'build', model: { providerID: 'opencode', modelID: 'default' } }],
      ['ses-tgt', { agent: 'beta', model: { providerID: 'opencode', modelID: 'default' } }],
    ]);
    const { wireBodies, setAgentLog, pending } = await runClaim(
      root, live,
      { target_session: 'ses-tgt', from_session: 'ses-a', from_agent: 'build', text: 'quiet please', silent: true },
      { agent: 'beta' }, 'build',
    );
    expect(wireBodies.length).toBe(1);
    expect(wireBodies[0].body.noReply).toBe(true);
    expect(wireBodies[0].body.agent).toBe('beta');
    expect(wireBodies[0].body.model).toEqual({ providerID: 'opencode', modelID: 'default' });
    expect(wireBodies[0].body.parts[0].text).toContain('(SILENT)');
    expect(setAgentLog).toEqual([]);
    expect(pending).toBe(0);
    await safeRmArmed(root); restore();
  });
});

describe('identity-neutral delivery: receiver resolution order', () => {
  it('live session state wins over a stale registry model', async () => {
    const { resolveReceiverWire } = await import('../src/identity.js');
    const client = {
      session: {
        get: async () => ({ agent: 'beta', model: { providerID: 'otherprov', modelID: 'live-model' } }),
      },
    };
    const receiver = await resolveReceiverWire(client, 'ses-tgt', { agent: 'beta', model: 'myprov/stale-model' });
    expect(receiver?.agent).toBe('beta');
    expect(receiver?.model).toEqual({ providerID: 'otherprov', modelID: 'live-model' });
    expect(receiver?.source).toBe('live');
  });

  it('registry entry resolves without a client', async () => {
    const { resolveReceiverWire } = await import('../src/identity.js');
    const receiver = await resolveReceiverWire(null, 'ses-t', { agent: 'beta', model: 'myprov/my-model' });
    expect(receiver?.agent).toBe('beta');
    expect(receiver?.model).toEqual({ providerID: 'myprov', modelID: 'my-model' });
    expect(receiver?.source).toBe('registry');
  });

  it('unresolvable receiver reads null on both layers', async () => {
    const { resolveReceiverWire } = await import('../src/identity.js');
    expect(await resolveReceiverWire(null, 'ses-x', { agent: 'unknown' })).toBeNull();
    expect(await resolveReceiverWire(null, 'ses-y', undefined)).toBeNull();
    expect(await resolveReceiverWire(null, 'ses-z', { agent: 'beta' })).toBeNull();
  });

  it('live id-branch blob resolves as live without a registry seed', async () => {
    const { resolveReceiverWire } = await import('../src/identity.js');
    const client = {
      session: {
        get: async () => ({ agent: 'build', model: { providerID: 'acme', id: 'acme-model' } }),
      },
    };
    const receiver = await resolveReceiverWire(client, 'ses-idblob', undefined);
    expect(receiver?.agent).toBe('build');
    expect(receiver?.model).toEqual({ providerID: 'acme', modelID: 'acme-model' });
    expect(receiver?.source).toBe('live');
  });

  it('claim leg delivers on a live id-branch hit with an empty registry', async () => {
    const { root, restore } = await freshRoot('mesh-ind-idblob-');
    const live = new Map<string, LiveRow>([
      ['ses-tgt', { agent: 'build', model: { providerID: 'acme', id: 'acme-model' } }],
    ]);
    const { wireBodies, setAgentLog, pending } = await runClaim(
      root, live,
      { target_session: 'ses-tgt', from_session: 'ses-from', from_agent: 'alpha', text: 'hello idblob' },
      {},
    );
    expect(wireBodies.length).toBe(1);
    expect(wireBodies[0].body.agent).toBe('build');
    expect(wireBodies[0].body.model).toEqual({ providerID: 'acme', modelID: 'acme-model' });
    expect(setAgentLog).toEqual([]);
    expect(pending).toBe(0);
    await safeRmArmed(root); restore();
  });
});

describe('identity-neutral delivery: negative guards', () => {
  it('sender agent appears nowhere in the wire body outside the text prefix', async () => {
    const { root, restore } = await freshRoot('mesh-ind-t4a-');
    const live = new Map<string, LiveRow>([
      ['ses-sight', { agent: 'sight', model: { providerID: 'acme', modelID: 'sight-default' } }],
      ['ses-tgt', { agent: 'beta', model: { providerID: 'myprov', modelID: 'my-model' } }],
    ]);
    const { wireBodies } = await runClaim(
      root, live,
      { target_session: 'ses-tgt', from_session: 'ses-sight', from_agent: 'sight', text: 'hello guard' },
      { agent: 'beta' }, 'sight',
    );
    expect(wireBodies.length).toBe(1);
    const { parts, ...rest } = wireBodies[0].body;
    expect(JSON.stringify(rest)).not.toContain('sight');
    expect(parts[0].text).toContain('sight');
    await safeRmArmed(root); restore();
  });

  it('pre-fix sender-plus-fallback body is absent for a modeled receiver', async () => {
    const { root, restore } = await freshRoot('mesh-ind-t4b-');
    const live = new Map<string, LiveRow>([
      ['ses-sight', { agent: 'sight', model: { providerID: 'acme', modelID: 'sight-default' } }],
      ['ses-tgt', { agent: 'beta', model: { providerID: 'myprov', modelID: 'my-model' } }],
    ]);
    const { wireBodies } = await runClaim(
      root, live,
      { target_session: 'ses-tgt', from_session: 'ses-sight', from_agent: 'sight', text: 'hello guard' },
      { agent: 'beta' }, 'sight',
    );
    expect(wireBodies.length).toBe(1);
    const shaped = JSON.stringify({ agent: wireBodies[0].body.agent, model: wireBodies[0].body.model });
    expect(shaped).not.toBe(JSON.stringify({ agent: 'sight', model: { providerID: 'opencode', modelID: 'default' } }));
    expect(wireBodies[0].body.model).toEqual({ providerID: 'myprov', modelID: 'my-model' });
    await safeRmArmed(root); restore();
  });
});

// T-1 harness: GET stub legs plus fixture-DB rows for the (a)-(g) matrix.
// The GET leg mirrors the loopback read the direct leg issues beside the
// route probe; the fixture store mirrors the session table the DB layer reads.
type GetLeg = { status: number; body?: unknown } | { abort: true };

function stubDelivery(posts: WirePost[], getMap: Record<string, GetLeg>, opts?: { postStatus?: number }) {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/session/status')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    if (u.includes('prompt_async')) {
      const body = JSON.parse(String(init?.body)) as WireBody;
      const id = u.split('/session/')[1]?.split('/')[0] ?? '';
      posts.push({ id, body });
      const st = opts?.postStatus ?? 204;
      return { ok: st === 204, status: st, json: async () => ({}) } as unknown as Response;
    }
    const m = u.match(/\/session\/([^/?]+)$/);
    if (m) {
      const leg = getMap[m[1]];
      if (!leg) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      if ('abort' in leg) throw new Error('aborted: loopback GET miss');
      if (leg.status !== 200) return { ok: false, status: leg.status, json: async () => ({}) } as unknown as Response;
      if (leg.body === '##THROW##') return { ok: true, status: 200, json: async () => { throw new Error('bad json'); } } as unknown as Response;
      return { ok: true, status: 200, json: async () => (leg.body ?? {}) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

type DbFixtureRow = { id: string; agent?: string | null; model?: string | null };

const blob = (providerID: string, modelID: string, variant?: string): string =>
  JSON.stringify({ providerID, modelID, ...(variant !== undefined ? { variant } : {}) });

async function makeFixtureDb(rows: DbFixtureRow[]): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-inddb-'));
  const path = join(dir, 'opencode.db');
  const { loadSqlite } = await import('../src/outbox.js');
  const Ctor = await loadSqlite();
  const db = new Ctor(path);
  db.exec('CREATE TABLE session(id TEXT PRIMARY KEY, agent TEXT, model TEXT, directory TEXT, title TEXT, time_updated INTEGER, parent_id INTEGER)');
  for (const r of rows) {
    db.prepare('INSERT INTO session(id, agent, model, directory, title, time_updated, parent_id) VALUES(?,?,?,?,?,?,?)').run(
      r.id, r.agent ?? null, r.model ?? null, '/tmp', 'Work', Date.now(), null,
    );
  }
  db.close();
  return { path, cleanup: async () => { await rm(dir, { recursive: true, force: true }); } };
}

async function withDbPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.OPENCODE_MESH_DB_PATH;
  process.env.OPENCODE_MESH_DB_PATH = path;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_MESH_DB_PATH;
    else process.env.OPENCODE_MESH_DB_PATH = prev;
  }
}

async function seedRegistry(root: string, entries: Record<string, Record<string, unknown>>): Promise<void> {
  const { atomicUpdateRegistry } = await import('../src/registry.js');
  await atomicUpdateRegistry((reg: unknown) => {
    for (const [id, e] of Object.entries(entries)) {
      (reg as Record<string, unknown>)[id] = { sessionId: id, updatedAt: Date.now(), ...e };
    }
  }, root);
}

async function runDirect(
  target: string,
  caller: string,
  callerAgent: string,
  getMap: Record<string, GetLeg>,
  postStatus = 204,
): Promise<{ out: { ok: boolean; via: string }; posts: WirePost[] }> {
  const posts: WirePost[] = [];
  globalThis.fetch = stubDelivery(posts, getMap, { postStatus });
  const { mesh_send } = await import('../src/tools/mesh_send.js');
  const out = JSON.parse(
    (await (mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)(
      { target, text: 'hello matrix' } as never,
      { sessionID: caller, directory: '/tmp', agent: callerAgent } as never,
    )).output,
  ) as { ok: boolean; via: string };
  return { out, posts };
}

const MATRIX_ROWS: DbFixtureRow[] = [
  { id: 'ses-live', agent: 'build', model: blob('staleprov', 'stale-model') },
  { id: 'ses-dbtgt', agent: 'beta', model: blob('myprov', 'my-model', 'max') },
  { id: 'ses-null' },
  { id: 'ses-sib404', agent: 'beta', model: blob('myprov', 'my-model') },
  { id: 'ses-fresh', agent: 'beta', model: blob('freshprov', 'fresh-model') },
  { id: 'ses-gate', agent: 'beta' },
  { id: 'ses-duality-id', agent: 'build', model: JSON.stringify({ providerID: 'acme', id: 'acme-model' }) },
  { id: 'ses-duality-str', agent: 'build', model: 'flatprov/flat-model' },
  { id: 'ses-duality-bad', agent: 'build', model: '{not-json' },
  { id: 'ses-duality-novariant', agent: 'build', model: blob('p', 'm') },
  { id: 'ses-duality-defvariant', agent: 'build', model: blob('p', 'm', 'default') },
  { id: 'ses-duality-nullagent', model: 'p/m' },
];

describe('identity-neutral delivery: resolution matrix (a)-(g)', () => {
  it('(a) live-hit: loopback GET wins over a stale DB row with no registry seed', async () => {
    const { root, restore } = await freshRoot('mesh-mtx-a-');
    const db = await makeFixtureDb(MATRIX_ROWS);
    await seedRegistry(root, {});
    const liveRow = { agent: 'build', model: { providerID: 'myprov', modelID: 'my-model', variant: 'max' } };
    const { out, posts } = await withDbPath(db.path, () => runDirect('ses-live', 'ses-a', 'build', { 'ses-live': { status: 200, body: liveRow } }));
    expect(out.ok).toBe(true);
    expect(out.via).toBe('admitted');
    expect(posts.length).toBe(1);
    expect(posts[0].body.agent).toBe('build');
    expect(posts[0].body.model).toEqual({ providerID: 'myprov', modelID: 'my-model' });
    expect(posts[0].body.variant).toBe('max');
    await db.cleanup(); await safeRm(root); restore();
  });

  it('(b) DB-hit: populated row resolves past a 404 GET and a model-missing registry seed', async () => {
    const { root, restore } = await freshRoot('mesh-mtx-b-');
    const db = await makeFixtureDb(MATRIX_ROWS);
    await seedRegistry(root, { 'ses-dbtgt': { agent: 'beta' } });
    const { out, posts } = await withDbPath(db.path, () => runDirect('ses-dbtgt', 'ses-a', 'build', {}));
    expect(out.ok).toBe(true);
    expect(out.via).toBe('admitted');
    expect(posts.length).toBe(1);
    expect(posts[0].body.agent).toBe('beta');
    expect(posts[0].body.model).toEqual({ providerID: 'myprov', modelID: 'my-model' });
    expect(posts[0].body.variant).toBe('max');
    await db.cleanup(); await safeRm(root); restore();
  });

  it('(c) NULL-defer: orphan row on every layer defers on both legs', async () => {
    const live = new Map<string, LiveRow>();
    {
      const { root, restore } = await freshRoot('mesh-mtx-c-');
      const db = await makeFixtureDb(MATRIX_ROWS);
      await seedRegistry(root, {});
      const { out, posts } = await withDbPath(db.path, () => runDirect('ses-null', 'ses-a', 'build', {}));
      expect(posts).toEqual([]);
      expect(out.ok).toBe(true);
      expect(out.via).toBe('queued');
      await db.cleanup(); await safeRm(root); restore();
    }
    {
      const { root, restore } = await freshRoot('mesh-mtx-c-claim-');
      const db = await makeFixtureDb(MATRIX_ROWS);
      const claimed = await withDbPath(db.path, () => runClaim(
        root, live,
        { target_session: 'ses-null', from_session: 'ses-a', from_agent: 'build', text: 'hello orphan' },
        {}, 'build',
      ));
      expect(claimed.wireBodies).toEqual([]);
      expect(claimed.setAgentLog).toEqual([]);
      expect(claimed.pending).toBe(1);
      await db.cleanup(); await safeRmArmed(root); restore();
    }
  });

  it('(d) sibling-defer: absent everywhere defers; the DB-hit sibling keeps the typed POST-404', async () => {
    {
      const { root, restore } = await freshRoot('mesh-mtx-d-');
      const db = await makeFixtureDb(MATRIX_ROWS);
      await seedRegistry(root, { 'ses-sib': { directory: '/tmp' } });
      const { out, posts } = await withDbPath(db.path, () => runDirect('ses-sib', 'ses-a', 'build', {}));
      expect(posts).toEqual([]);
      expect(out.ok).toBe(true);
      expect(out.via).toBe('queued');
      await db.cleanup(); await safeRm(root); restore();
    }
    {
      const { root, restore } = await freshRoot('mesh-mtx-d-claim-');
      const db = await makeFixtureDb(MATRIX_ROWS);
      const live = new Map<string, LiveRow>();
      const claimed = await withDbPath(db.path, () => runClaim(
        root, live,
        { target_session: 'ses-sib', from_session: 'ses-a', from_agent: 'build', text: 'hello sibling' },
        {}, 'build',
      ));
      expect(claimed.wireBodies).toEqual([]);
      expect(claimed.pending).toBe(1);
      await db.cleanup(); await safeRmArmed(root); restore();
    }
    const { root, restore } = await freshRoot('mesh-mtx-d-404-');
    const db = await makeFixtureDb(MATRIX_ROWS);
    await seedRegistry(root, { 'ses-sib404': { agent: 'beta' } });
    await withDbPath(db.path, async () => {
      const posts404: WirePost[] = [];
      globalThis.fetch = stubDelivery(posts404, {}, { postStatus: 404 });
      const { mesh_send } = await import('../src/tools/mesh_send.js');
      await expect((mesh_send.execute as (...a: never[]) => Promise<{ output: string }>)(
        { target: 'ses-sib404', text: 'hello moved' } as never,
        { sessionID: 'ses-a', directory: '/tmp', agent: 'build' } as never,
      )).rejects.toMatchObject({ code: 'PEER_NOT_FOUND' });
      expect(posts404.length).toBe(1);
    });
    await db.cleanup(); await safeRm(root); restore();
  });

  it('(e) stale-switch: the DB-fresh triple beats the registry-stale string', async () => {
    const { root, restore } = await freshRoot('mesh-mtx-e-');
    const db = await makeFixtureDb(MATRIX_ROWS);
    await seedRegistry(root, { 'ses-fresh': { agent: 'beta', model: 'staleprov/stale-model' } });
    const { out, posts } = await withDbPath(db.path, () => runDirect('ses-fresh', 'ses-a', 'build', {}));
    expect(out.ok).toBe(true);
    expect(out.via).toBe('admitted');
    expect(posts.length).toBe(1);
    expect(posts[0].body.agent).toBe('beta');
    expect(posts[0].body.model).toEqual({ providerID: 'freshprov', modelID: 'fresh-model' });
    await db.cleanup(); await safeRm(root); restore();
  });

  it('(f) tertiary: a modeled registry string still echoes past a GET and DB miss', async () => {
    const { root, restore } = await freshRoot('mesh-mtx-f-');
    const db = await makeFixtureDb(MATRIX_ROWS);
    await seedRegistry(root, { 'ses-tertiary': { agent: 'beta', model: 'myprov/my-model' } });
    const { out, posts } = await withDbPath(db.path, () => runDirect('ses-tertiary', 'ses-a', 'build', {}));
    expect(out.ok).toBe(true);
    expect(out.via).toBe('admitted');
    expect(posts.length).toBe(1);
    expect(posts[0].body.agent).toBe('beta');
    expect(posts[0].body.model).toEqual({ providerID: 'myprov', modelID: 'my-model' });
    await db.cleanup(); await safeRm(root); restore();
  });

  it('(g) gate: agent-known/model-missing on every layer defers on both legs', async () => {
    const gateGet: Record<string, GetLeg> = { 'ses-gate': { status: 200, body: { agent: 'beta' } } };
    {
      const { root, restore } = await freshRoot('mesh-mtx-g-');
      const db = await makeFixtureDb(MATRIX_ROWS);
      await seedRegistry(root, { 'ses-gate': { agent: 'beta' } });
      const { out, posts } = await withDbPath(db.path, () => runDirect('ses-gate', 'ses-a', 'build', gateGet));
      expect(posts).toEqual([]);
      expect(out.ok).toBe(true);
      expect(out.via).toBe('queued');
      await db.cleanup(); await safeRm(root); restore();
    }
    {
      const { root, restore } = await freshRoot('mesh-mtx-g-claim-');
      const db = await makeFixtureDb(MATRIX_ROWS);
      const live = new Map<string, LiveRow>();
      const claimed = await withDbPath(db.path, () => runClaim(
        root, live,
        { target_session: 'ses-gate', from_session: 'ses-a', from_agent: 'build', text: 'hello gate' },
        { agent: 'beta' }, 'build',
      ));
      expect(claimed.wireBodies).toEqual([]);
      expect(claimed.setAgentLog).toEqual([]);
      expect(claimed.pending).toBe(1);
      await db.cleanup(); await safeRmArmed(root); restore();
    }
  });

  it('direct leg keeps the sender key out of the body outside the text prefix', async () => {
    const { root, restore } = await freshRoot('mesh-mtx-guard-');
    const db = await makeFixtureDb(MATRIX_ROWS);
    await seedRegistry(root, {});
    const { posts } = await withDbPath(db.path, () => runDirect('ses-live', 'ses-sight', 'sight', {}));
    expect(posts.length).toBe(1);
    expect(posts[0].body.agent).toBe('build');
    const { parts, ...rest } = posts[0].body;
    expect(JSON.stringify(rest)).not.toContain('sight');
    expect(parts[0].text).toContain('sight');
    await db.cleanup(); await safeRm(root); restore();
  });

  it('loopback GET miss legs (abort, 500, bad JSON) read as layer-skip, never a throw', async () => {
    const { root, restore } = await freshRoot('mesh-mtx-getmiss-');
    const db = await makeFixtureDb(MATRIX_ROWS);
    await seedRegistry(root, { 'ses-tertiary': { agent: 'beta', model: 'myprov/my-model' } });
    const missMaps: Array<Record<string, GetLeg>> = [
      { 'ses-tertiary': { abort: true } },
      { 'ses-tertiary': { status: 500, body: {} } },
      { 'ses-tertiary': { status: 200, body: '##THROW##' } },
    ];
    for (const getMap of missMaps) {
      const { out, posts } = await withDbPath(db.path, () => runDirect('ses-tertiary', 'ses-a', 'build', getMap));
      expect(out.via).toBe('admitted');
      expect(posts.length).toBe(1);
      expect(posts[0].body.model).toEqual({ providerID: 'myprov', modelID: 'my-model' });
    }
    await db.cleanup(); await safeRm(root); restore();
  });
});

describe('identity-neutral delivery: row-parser duality', () => {
  it('id-branch blob resolves through the direct row as live', async () => {
    const { resolveReceiverWire } = await import('../src/identity.js');
    const row = { agent: 'build', model: { providerID: 'acme', id: 'acme-model' } };
    const receiver = await resolveReceiverWire(null, 'ses-x', undefined, { directRow: row });
    expect(receiver?.agent).toBe('build');
    expect(receiver?.model).toEqual({ providerID: 'acme', modelID: 'acme-model' });
    expect(receiver?.source).toBe('live');
  });

  it('string-form model resolves through the direct row as live', async () => {
    const { resolveReceiverWire } = await import('../src/identity.js');
    const row = { agent: 'build', model: 'flatprov/flat-model' };
    const receiver = await resolveReceiverWire(null, 'ses-x', undefined, { directRow: row });
    expect(receiver?.model).toEqual({ providerID: 'flatprov', modelID: 'flat-model' });
    expect(receiver?.source).toBe('live');
  });

  it('variant default reads absent while a named variant rides the wire', async () => {
    const { resolveReceiverWire } = await import('../src/identity.js');
    const def = await resolveReceiverWire(null, 's', undefined, {
      directRow: { agent: 'build', model: { providerID: 'p', modelID: 'm', variant: 'default' } },
    });
    expect(def?.model).toEqual({ providerID: 'p', modelID: 'm' });
    expect(def?.variant).toBeUndefined();
    const named = await resolveReceiverWire(null, 's', undefined, {
      directRow: { agent: 'build', model: { providerID: 'p', modelID: 'm', variant: 'max' } },
    });
    expect(named?.variant).toBe('max');
  });

  it('agent-unknown direct row reads miss', async () => {
    const { resolveReceiverWire } = await import('../src/identity.js');
    const receiver = await resolveReceiverWire(null, 's', undefined, {
      directRow: { agent: 'unknown', model: { providerID: 'p', modelID: 'm' } },
    });
    expect(receiver).toBeNull();
  });

  it('DB JSON blob resolves as db while agent-NULL rows fall to the modeled registry', async () => {
    const { resolveReceiverWire } = await import('../src/identity.js');
    const db = await makeFixtureDb(MATRIX_ROWS);
    await withDbPath(db.path, async () => {
      const viaDb = await resolveReceiverWire(null, 'ses-duality-id', undefined);
      expect(viaDb?.model).toEqual({ providerID: 'acme', modelID: 'acme-model' });
      expect(viaDb?.source).toBe('db');
      const viaStr = await resolveReceiverWire(null, 'ses-duality-str', undefined);
      expect(viaStr?.model).toEqual({ providerID: 'flatprov', modelID: 'flat-model' });
      expect(viaStr?.source).toBe('db');
      const viaNullAgent = await resolveReceiverWire(
        null, 'ses-duality-nullagent', { agent: 'beta', model: 'myprov/my-model' },
      );
      expect(viaNullAgent?.model).toEqual({ providerID: 'myprov', modelID: 'my-model' });
      expect(viaNullAgent?.source).toBe('registry');
      const viaBad = await resolveReceiverWire(null, 'ses-duality-bad', undefined);
      expect(viaBad).toBeNull();
      const viaDefVariant = await resolveReceiverWire(null, 'ses-duality-defvariant', undefined);
      expect(viaDefVariant?.variant).toBeUndefined();
      const viaNoVariant = await resolveReceiverWire(null, 'ses-duality-novariant', undefined);
      expect(viaNoVariant?.model).toEqual({ providerID: 'p', modelID: 'm' });
    });
    await db.cleanup();
  });

  it('DB reader misses fail closed on stores without the session table', async () => {
    const { readDbTriple } = await import('../src/discovery.js');
    const dir = await mkdtemp(join(tmpdir(), 'mesh-inddb-miss-'));
    try {
      const { loadSqlite } = await import('../src/outbox.js');
      const Ctor = await loadSqlite();
      const bare = new Ctor(join(dir, 'bare.db'));
      bare.exec('CREATE TABLE other(id TEXT)');
      bare.close();
      expect(await readDbTriple('ses-x', join(dir, 'bare.db'))).toBeNull();
      expect(await readDbTriple('ses-x', join(dir, 'missing.db'))).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
