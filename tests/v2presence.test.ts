// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// v2 presence identity: created events persist agent, directory, model, and
// title; tool calls enrich incomplete rows via session.get; complete rows
// skip the read. Given a hermetic root plus a stubbed setup context, when
// the adapter handles events and tools, then the registry carries v1-grade
// identity for every v2 row.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('../src/claimer.js', () => ({
  configureClaimer: vi.fn(),
  ensureClaimer: vi.fn(),
  clearClaimerTimer: vi.fn(),
  releaseClaimerOwner: vi.fn(async () => {}),
}));

vi.mock('../src/attach.js', () => ({
  startAttachPoller: vi.fn(),
  stopAttachPoller: vi.fn(),
  pollAttachOnce: vi.fn(async () => {}),
  getAttachSnapshot: vi.fn(() => null),
}));

afterEach(() => {
  vi.clearAllMocks();
});

async function freshRoot(
  prefix: string,
): Promise<{ root: string; restore: () => void }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const prev = process.env.OPENCODE_MESH_ROOT;
  const prevDb = process.env.OPENCODE_MESH_DB_PATH;
  process.env.OPENCODE_MESH_ROOT = root;
  process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
  return {
    root,
    restore: () => {
      if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT;
      else process.env.OPENCODE_MESH_ROOT = prev;
      if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH;
      else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    },
  };
}

async function safeRm(root: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (
        (code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM') &&
        attempt < 2
      ) {
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      throw err;
    }
  }
}

async function waitFor(
  cond: () => Promise<boolean> | boolean,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface CapturedDef {
  name: string;
  execute: (input: unknown, context: unknown) => Promise<unknown>;
}

function fakeSetupCtx(
  events: unknown[] = [],
  sessionGet?: (input: { sessionID: string }) => Promise<unknown>,
  locationDir = '/tmp/v2loc',
) {
  const tools: CapturedDef[] = [];
  const hooks: Record<string, (event: { sessionID: string }) => unknown> = {};
  const ctx = {
    session: {
      get: sessionGet ?? (async () => ({})),
    },
    location: { directory: locationDir },
    tool: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({ add: (t: CapturedDef) => tools.push(t) });
        return { dispose: async () => {} };
      },
      list: async () => [
        { id: 'mesh_register' },
        { id: 'mesh_peers' },
        { id: 'mesh_send' },
        { id: 'mesh_broadcast' },
      ],
      hook: async (name: string, cb: (event: { sessionID: string }) => unknown) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
      reload: async () => {},
    },
    event: {
      subscribe: async function* () {
        yield* events;
      },
    },
    skill: {
      transform: async () => ({ dispose: async () => {} }),
      reload: async () => {},
      list: async () => [],
    },
  };
  return { ctx, tools, hooks };
}

async function readEntry(id: string) {
  const { readRegistry } = await import('../src/registry.js');
  const reg = (await readRegistry()) as unknown as Record<
    string,
    Record<string, unknown>
  >;
  return reg[id];
}

describe('v2 created events persist full identity', () => {
  it('agent, directory, model, and title land on the row', async () => {
    const { root, restore } = await freshRoot('v2pres-');
    const created = {
      type: 'session.created',
      id: 'evt_1',
      data: {
        sessionID: 'ses_v2new',
        agent: 'alfred',
        title: 'Alfred relay',
        location: { directory: '/tmp/v2proj' },
        model: { providerID: 'acme', id: 'reasoner' },
      },
    };
    const { ctx } = fakeSetupCtx([created]);
    const mod = await import('../plugin/opencode-mesh-v2.js');
    const cleanup = await (
      mod.default as unknown as {
        setup: (c: unknown) => Promise<() => Promise<void>>;
      }
    ).setup(ctx);
    await waitFor(async () => (await readEntry('ses_v2new')) !== undefined, 'row');
    const row = (await readEntry('ses_v2new')) as Record<string, unknown>;
    expect(row.agent).toBe('alfred');
    expect(row.directory).toBe('/tmp/v2proj');
    expect(row.cwd).toBe('/tmp/v2proj');
    expect(row.repo).toBe('v2proj');
    expect(row.model).toBe('acme/reasoner');
    expect(row.title).toBe('Alfred relay');
    await cleanup();
    await safeRm(root);
    restore();
  });
});

describe('v2 tool calls enrich incomplete rows', () => {
  it('register fills identity from session.get plus location fallback', async () => {
    const { root, restore } = await freshRoot('v2pres-reg-');
    let gets = 0;
    const { ctx, tools } = fakeSetupCtx(
      [],
      async () => {
        gets += 1;
        return {
          data: {
            id: 'ses_v2tool',
            agent: 'plan',
            title: 'Plan work',
            model: { providerID: 'acme', id: 'thinker' },
          },
        };
      },
      root,
    );
    const mod = await import('../plugin/opencode-mesh-v2.js');
    const cleanup = await (
      mod.default as unknown as {
        setup: (c: unknown) => Promise<() => Promise<void>>;
      }
    ).setup(ctx);
    const register = tools.find((t) => t.name === 'mesh_register');
    expect(register).toBeDefined();
    await register?.execute(
      { summary: 'relay' },
      { sessionID: 'ses_v2tool', agent: 'plan' },
    );
    const row = (await readEntry('ses_v2tool')) as Record<string, unknown>;
    expect(gets).toBe(1);
    expect(row.agent).toBe('plan');
    expect(row.model).toBe('acme/thinker');
    expect(row.directory).toBe(root);
    expect(row.repo).toBe(root.split('/').pop());
    await cleanup();
    await safeRm(root);
    restore();
  });

  it('complete rows skip the session read', async () => {
    const { root, restore } = await freshRoot('v2pres-skip-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: Record<string, unknown>) => {
      reg['ses_full'] = {
        sessionId: 'ses_full',
        agent: 'build',
        directory: '/tmp/kept',
        cwd: '/tmp/kept',
        model: 'acme/builder',
        title: 'Kept',
        updatedAt: Date.now(),
      };
    });
    let gets = 0;
    const { ctx, tools } = fakeSetupCtx([], async () => {
      gets += 1;
      return {};
    });
    const mod = await import('../plugin/opencode-mesh-v2.js');
    const cleanup = await (
      mod.default as unknown as {
        setup: (c: unknown) => Promise<() => Promise<void>>;
      }
    ).setup(ctx);
    const peers = tools.find((t) => t.name === 'mesh_peers');
    await peers?.execute({ includeSelf: true }, { sessionID: 'ses_full' });
    expect(gets).toBe(0);
    const row = (await readEntry('ses_full')) as Record<string, unknown>;
    expect(row.directory).toBe('/tmp/kept');
    await cleanup();
    await safeRm(root);
    restore();
  });
});

describe('v2 presence failure modes', () => {
  it('title-only events store unknown agent instead of throwing', async () => {
    const { root, restore } = await freshRoot('v2pres-bare-');
    const created = {
      type: 'session.created',
      id: 'evt_9',
      data: { sessionID: 'ses_bare', title: 'Bare title' },
    };
    const { ctx } = fakeSetupCtx([created]);
    const mod = await import('../plugin/opencode-mesh-v2.js');
    const cleanup = await (
      mod.default as unknown as {
        setup: (c: unknown) => Promise<() => Promise<void>>;
      }
    ).setup(ctx);
    await waitFor(async () => (await readEntry('ses_bare')) !== undefined, 'row');
    const row = (await readEntry('ses_bare')) as Record<string, unknown>;
    expect(row.agent).toBe('unknown');
    expect(row.title).toBe('Bare title');
    await cleanup();
    await safeRm(root);
    restore();
  });

  it('session read faults fall back to tool context without throwing', async () => {
    const { root, restore } = await freshRoot('v2pres-fault-');
    const { ctx, tools } = fakeSetupCtx(
      [],
      async () => {
        throw new Error('host away');
      },
      root,
    );
    const mod = await import('../plugin/opencode-mesh-v2.js');
    const cleanup = await (
      mod.default as unknown as {
        setup: (c: unknown) => Promise<() => Promise<void>>;
      }
    ).setup(ctx);
    const register = tools.find((t) => t.name === 'mesh_register');
    await register?.execute(
      { summary: 'relay' },
      { sessionID: 'ses_fault', agent: 'plan' },
    );
    const row = (await readEntry('ses_fault')) as Record<string, unknown>;
    expect(row.agent).toBe('plan');
    expect(row.directory).toBe(root);
    await cleanup();
    await safeRm(root);
    restore();
  });

  it('setup hands the claimer live closures over the setup context', async () => {
    const { root, restore } = await freshRoot('v2pres-closures-');
    const prompted: unknown[] = [];
    const { ctx } = fakeSetupCtx([]);
    (ctx.session as Record<string, unknown>)['prompt'] = async (
      input: unknown,
    ) => {
      prompted.push(input);
      return { id: 'inbox_1' };
    };
    const { resetV2Singleflight } = await import('../src/v2singleflight.js');
    resetV2Singleflight();
    const mod = await import('../plugin/opencode-mesh-v2.js');
    const cleanup = await (
      mod.default as unknown as {
        setup: (c: unknown) => Promise<() => Promise<void>>;
      }
    ).setup(ctx);
    const claimerMod = await import('../src/claimer.js');
    const calls = (
      claimerMod.configureClaimer as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const deps = calls[calls.length - 1][0] as {
      getOwnIds: () => string[];
      getClient: () => null;
      getV2Client: () => {
        prompt: (input: {
          sessionID: string;
          text: string;
          delivery: 'steer' | 'queue';
        }) => Promise<unknown>;
      } | null;
      getRegistry: () => Promise<Record<string, unknown>>;
    };
    expect(Array.isArray(deps.getOwnIds())).toBe(true);
    expect(deps.getClient()).toBeNull();
    await deps.getV2Client()?.prompt({
      sessionID: 'ses_x',
      text: 'hi',
      delivery: 'steer',
    });
    expect(prompted).toEqual([
      { sessionID: 'ses_x', text: 'hi', delivery: 'steer' },
    ]);
    await expect(deps.getRegistry()).resolves.toBeDefined();
    await cleanup();
    await safeRm(root);
    restore();
  });

  it('tool hooks own the acting session for later claims', async () => {
    const { root, restore } = await freshRoot('v2pres-hookown-');
    const { ctx, hooks } = fakeSetupCtx([]);
    const {
      resetV2Singleflight,
      v2OwnedIds,
    } = await import('../src/v2singleflight.js');
    resetV2Singleflight();
    const mod = await import('../plugin/opencode-mesh-v2.js');
    const cleanup = await (
      mod.default as unknown as {
        setup: (c: unknown) => Promise<() => Promise<void>>;
      }
    ).setup(ctx);
    await hooks['execute.before']({ sessionID: 'ses-hooked' });
    await new Promise((r) => setTimeout(r, 50));
    expect(v2OwnedIds()).toContain('ses-hooked');
    resetV2Singleflight();
    await cleanup();
    await safeRm(root);
    restore();
  });

  it('string models persist verbatim from events', async () => {
    const { root, restore } = await freshRoot('v2pres-strmodel-');
    const created = {
      type: 'session.created',
      id: 'evt_s',
      data: {
        sessionID: 'ses_strmodel',
        agent: 'alfred',
        model: 'acme/reasoner',
      },
    };
    const { ctx } = fakeSetupCtx([created]);
    const mod = await import('../plugin/opencode-mesh-v2.js');
    const cleanup = await (
      mod.default as unknown as {
        setup: (c: unknown) => Promise<() => Promise<void>>;
      }
    ).setup(ctx);
    await waitFor(
      async () => (await readEntry('ses_strmodel')) !== undefined,
      'row',
    );
    const row = (await readEntry('ses_strmodel')) as Record<string, unknown>;
    expect(row.model).toBe('acme/reasoner');
    await cleanup();
    await safeRm(root);
    restore();
  });

  it('id-less created events write nothing and throw nothing', async () => {
    const { root, restore } = await freshRoot('v2pres-noid-');
    const created = { type: 'session.created', id: 'evt_n', data: {} };
    const { ctx } = fakeSetupCtx([created]);
    const mod = await import('../plugin/opencode-mesh-v2.js');
    const cleanup = await (
      mod.default as unknown as {
        setup: (c: unknown) => Promise<() => Promise<void>>;
      }
    ).setup(ctx);
    await new Promise((r) => setTimeout(r, 50));
    const { readRegistry } = await import('../src/registry.js');
    expect(Object.keys(await readRegistry())).toHaveLength(0);
    await cleanup();
    await safeRm(root);
    restore();
  });

  it('parented events record the subagent type', async () => {
    const { root, restore } = await freshRoot('v2pres-sub-');
    const created = {
      type: 'session.created',
      id: 'evt_p',
      data: {
        sessionID: 'ses_sub',
        agent: 'builder',
        parentID: 'ses_parent',
      },
    };
    const { ctx } = fakeSetupCtx([created]);
    const mod = await import('../plugin/opencode-mesh-v2.js');
    const cleanup = await (
      mod.default as unknown as {
        setup: (c: unknown) => Promise<() => Promise<void>>;
      }
    ).setup(ctx);
    await waitFor(
      async () => (await readEntry('ses_sub')) !== undefined,
      'row',
    );
    const row = (await readEntry('ses_sub')) as Record<string, unknown>;
    expect(row.sessionType).toBe('subagent');
    await cleanup();
    await safeRm(root);
    restore();
  });

  it('empty hook ids own nothing and throw nothing', async () => {
    const { root, restore } = await freshRoot('v2pres-emptyhook-');
    const { ctx, hooks } = fakeSetupCtx([]);
    const {
      resetV2Singleflight,
      v2OwnedIds,
    } = await import('../src/v2singleflight.js');
    resetV2Singleflight();
    const mod = await import('../plugin/opencode-mesh-v2.js');
    const cleanup = await (
      mod.default as unknown as {
        setup: (c: unknown) => Promise<() => Promise<void>>;
      }
    ).setup(ctx);
    await hooks['execute.before']({ sessionID: '' });
    await new Promise((r) => setTimeout(r, 50));
    expect(v2OwnedIds()).toEqual([]);
    resetV2Singleflight();
    await cleanup();
    await safeRm(root);
    restore();
  });

  it('setup survives a corrupt registry without losing tools', async () => {
    const { root, restore } = await freshRoot('v2pres-corrupt-');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'registry.json'), '{garbage');
    const { DatabaseSync } = await import('node:sqlite');
    const during = join(root, 'during.db');
    const db = new DatabaseSync(during);
    db.exec(
      'CREATE TABLE session(id TEXT PRIMARY KEY, agent TEXT, directory TEXT, title TEXT, time_updated INTEGER, parent_id TEXT)',
    );
    db.prepare('INSERT INTO session VALUES(?,?,?,?,?,?)').run(
      'ses-corrupt-adopt',
      'a',
      '/tmp/c',
      'T',
      Date.now(),
      null,
    );
    db.close();
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_DB_PATH = during;
    const { ctx, tools } = fakeSetupCtx([]);
    const mod = await import('../plugin/opencode-mesh-v2.js');
    const cleanup = await (
      mod.default as unknown as {
        setup: (c: unknown) => Promise<() => Promise<void>>;
      }
    ).setup(ctx);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'mesh_broadcast',
      'mesh_peers',
      'mesh_register',
      'mesh_send',
    ]);
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH;
    else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await cleanup();
    await safeRm(root);
    restore();
  });
});
