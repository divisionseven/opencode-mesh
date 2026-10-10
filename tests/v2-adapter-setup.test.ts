// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// V2 adapter setup behavior at unit level: with a fake host ctx
// plus mocked pollers, setup registers four tools through pure-sync
// transforms, fails loud on zero registration, stamps presence on the
// execute.before hook and session events, delegates executors to the shared
// cores (same JSON envelopes, {output} mapped to {content}), and tears down
// by refcount (first setup arms once, last cleanup clears). Given a hermetic
// root, when setup runs twice, then claimer configures once and merged ids
// survive the first cleanup. Poller modules are the mocked boundary (owned
// elsewhere); registry, guard, and cores are real.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { MeshError } from '../src/errors.js';

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

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch as unknown as typeof fetch;
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
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      throw err;
    }
  }
}

async function waitFor(cond: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface CapturedDef {
  name: string;
  description: string;
  input: unknown;
  execute: (input: unknown, context: unknown) => Promise<unknown>;
}

interface FakeHost {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
  tools: CapturedDef[];
  hooks: Record<string, (event: { sessionID: string; agent: string }) => unknown>;
  events: unknown[];
  skillAdds: unknown[];
  listedIds: Array<{ id: string }>;
}

function fakeHost(events: unknown[] = []): FakeHost {
  const tools: CapturedDef[] = [];
  const hooks: Record<string, (event: { sessionID: string; agent: string }) => unknown> = {};
  const skillAdds: unknown[] = [];
  const listedIds = [
    { id: 'mesh_register' },
    { id: 'mesh_peers' },
    { id: 'mesh_send' },
    { id: 'mesh_broadcast' },
  ];
  const ctx = {
    tool: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({
          add: (t: CapturedDef) => {
            tools.push(t);
          },
          list: () => tools,
          get: () => undefined,
          namespace: () => {},
          update: () => {},
          remove: () => {},
        });
        return { dispose: async () => {} };
      },
      list: async () => listedIds,
      hook: async (name: string, cb: (event: { sessionID: string; agent: string }) => unknown) => {
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
      transform: async (cb: (editor: unknown) => void) => {
        cb({
          add: (s: unknown) => {
            skillAdds.push(s);
          },
          list: () => [],
          get: () => undefined,
          update: () => {},
          remove: () => {},
        });
        return { dispose: async () => {} };
      },
      reload: async () => {},
      list: async () => [],
    },
  };
  return { ctx, tools, hooks, events, skillAdds, listedIds };
}

type SetupFn = (ctx: never) => Promise<(() => Promise<void> | void) | void>;

async function loadSetup(): Promise<SetupFn> {
  const mod = await import('../plugin/opencode-mesh-v2.js');
  return mod.default.setup as unknown as SetupFn;
}

function mockCalls(fn: unknown): unknown[][] {
  return (fn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
}

describe('v2 adapter setup: tools, presence, delegation, refcounted teardown', () => {
  it('setup registers four tools with JSON Schema inputs through a sync transform', async () => {
    const { root, restore } = await freshRoot('mesh-v2a-reg-');
    try {
      const { resetV2Singleflight } = await import('../src/v2singleflight.js');
      resetV2Singleflight();
      const setup = await loadSetup();
      const host = fakeHost();
      const cleanup = await setup(host.ctx as never);
      expect(host.tools.map((t) => t.name).sort()).toEqual([
        'mesh_broadcast',
        'mesh_peers',
        'mesh_register',
        'mesh_send',
      ]);
      for (const t of host.tools) {
        expect(typeof t.description).toBe('string');
        expect(typeof t.execute).toBe('function');
        expect((t.input as { additionalProperties?: boolean }).additionalProperties).toBe(false);
      }
      expect(typeof host.hooks['execute.before']).toBe('function');
      if (typeof cleanup === 'function') await cleanup();
      resetV2Singleflight();
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('setup fails loud when the host replays zero tools', async () => {
    const { root, restore } = await freshRoot('mesh-v2a-zero-');
    try {
      const { resetV2Singleflight } = await import('../src/v2singleflight.js');
      resetV2Singleflight();
      const setup = await loadSetup();
      const host = fakeHost();
      host.listedIds.length = 0;
      const err = await setup(host.ctx as never).then(
        () => null,
        (e: unknown) => e as MeshError,
      );
      expect(err?.code).toBe('SERVER_UNAVAILABLE');
      resetV2Singleflight();
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('registered mesh_register delegates to the shared core with a content envelope', async () => {
    const { root, restore } = await freshRoot('mesh-v2a-del-');
    try {
      const { resetV2Singleflight } = await import('../src/v2singleflight.js');
      resetV2Singleflight();
      const setup = await loadSetup();
      const host = fakeHost();
      const cleanup = await setup(host.ctx as never);
      const def = host.tools.find((t) => t.name === 'mesh_register');
      expect(def).toBeDefined();
      const out = (await def?.execute({ summary: 'V2 work' }, { sessionID: 'ses-v2-reg', agent: 'beta' })) as {
        content: string;
      };
      const parsed = JSON.parse(out.content) as { registered: string; peers: Record<string, unknown> };
      expect(parsed.registered).toBe('ses-v2-reg');
      const reg = await import('../src/registry.js');
      const rows = (await reg.readRegistry(root)) as unknown as Record<string, Record<string, unknown>>;
      expect(rows['ses-v2-reg']?.description).toBe('V2 work');
      if (typeof cleanup === 'function') await cleanup();
      resetV2Singleflight();
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('broadcast default-off refuses verbatim through the v2 envelope', async () => {
    const { root, restore } = await freshRoot('mesh-v2a-bgate-');
    try {
      delete process.env.MESH_BROADCAST;
      const { resetV2Singleflight } = await import('../src/v2singleflight.js');
      resetV2Singleflight();
      const setup = await loadSetup();
      const host = fakeHost();
      const cleanup = await setup(host.ctx as never);
      const def = host.tools.find((t) => t.name === 'mesh_broadcast');
      const err = await def?.execute({ text: 'hi' }, { sessionID: 'ses-v2-c', agent: 'beta' }).then(
        () => null,
        (e: unknown) => e as { code?: string; status?: number },
      );
      expect(err?.code).toBe('BROADCAST_DISABLED');
      expect(err?.status).toBe(403);
      if (typeof cleanup === 'function') await cleanup();
      resetV2Singleflight();
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('session.deleted evicts the row with an audit line, created touches presence', async () => {
    const { root, restore } = await freshRoot('mesh-v2a-evt-');
    try {
      const { resetV2Singleflight, v2OwnedIds } = await import('../src/v2singleflight.js');
      resetV2Singleflight();
      const reg = await import('../src/registry.js');
      await reg.atomicUpdateRegistry((r: unknown) => {
        (r as Record<string, unknown>)['ses-v2-gone'] = {
          sessionId: 'ses-v2-gone',
          agent: 'beta',
          updatedAt: Date.now(),
        };
      }, root);
      const setup = await loadSetup();
      const host = fakeHost([
        { type: 'session.created', id: 'ses-v2-born', data: {} },
        { type: 'session.deleted', id: 'ses-v2-gone', data: { sessionID: 'ses-v2-gone' } },
        { type: 'session.updated', id: 'ses-v2-born', data: {} },
        { type: 'message.updated', id: 'ses-v2-born', data: {} },
      ]);
      const cleanup = await setup(host.ctx as never);
      await waitFor(async () => {
        const rows = (await reg.readRegistry(root)) as unknown as Record<string, unknown>;
        return !('ses-v2-gone' in rows);
      }, 'deleted row eviction');
      await waitFor(() => v2OwnedIds().includes('ses-v2-born'), 'created presence merge');
      if (typeof cleanup === 'function') await cleanup();
      resetV2Singleflight();
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('double setup configures once, merges ownership, tears down by refcount', async () => {
    const { root, restore } = await freshRoot('mesh-v2a-dbl-');
    try {
      const guard = await import('../src/v2singleflight.js');
      guard.resetV2Singleflight();
      const claimer = await import('../src/claimer.js');
      const attach = await import('../src/attach.js');
      const setup = await loadSetup();
      const hostA = fakeHost();
      const hostB = fakeHost();
      const cleanupA = await setup(hostA.ctx as never);
      const cleanupB = await setup(hostB.ctx as never);
      expect(mockCalls(claimer.configureClaimer).length).toBe(1);
      expect(mockCalls(claimer.ensureClaimer).length).toBe(1);
      expect(mockCalls(attach.startAttachPoller).length).toBe(1);
      await hostB.hooks['execute.before']({ sessionID: 'ses-v2-hook', agent: 'beta' });
      await waitFor(() => guard.v2OwnedIds().includes('ses-v2-hook'), 'hook presence merge');
      expect(typeof cleanupA === 'function' && typeof cleanupB === 'function').toBe(true);
      await (cleanupA as () => Promise<void>)();
      expect(mockCalls(claimer.clearClaimerTimer).length).toBe(0);
      expect(guard.v2OwnedIds()).toContain('ses-v2-hook');
      await (cleanupB as () => Promise<void>)();
      expect(mockCalls(claimer.clearClaimerTimer).length).toBe(1);
      expect(mockCalls(attach.stopAttachPoller).length).toBe(1);
      guard.resetV2Singleflight();
    } finally {
      await safeRm(root);
      restore();
    }
  });
});
