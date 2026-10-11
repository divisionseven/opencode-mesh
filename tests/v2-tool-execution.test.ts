// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// V2 tool callbacks run the shared cores through the v2 envelope.
// Given a hermetic root, when each registered tool executes, then output
// matches the v1 core contract ({output} mapped to {content}), presence
// stamps the caller, and malformed lifecycle events change nothing.
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
  execute: (input: unknown, context: unknown) => Promise<unknown>;
}

function fakeHost(events: unknown[] = []): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
  tools: CapturedDef[];
  hooks: Record<string, (event: { sessionID: string }) => unknown>;
} {
  const tools: CapturedDef[] = [];
  const hooks: Record<string, (event: { sessionID: string }) => unknown> = {};
  const ctx = {
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

type SetupFn = (ctx: never) => Promise<(() => Promise<void> | void) | void>;

async function loadSetup(): Promise<SetupFn> {
  const mod = await import('../plugin/opencode-mesh-v2.js');
  return mod.default.setup as unknown as SetupFn;
}

describe('v2 tool callbacks execute the shared cores', () => {
  it('peers callback returns the registry listing as content', async () => {
    const { root, restore } = await freshRoot('mesh-v2x-peers-');
    try {
      const { resetV2Singleflight } = await import('../src/v2singleflight.js');
      resetV2Singleflight();
      const setup = await loadSetup();
      const host = fakeHost();
      const cleanup = await setup(host.ctx as never);
      const def = host.tools.find((t) => t.name === 'mesh_peers');
      expect(def).toBeDefined();
      const out = (await def?.execute({}, { sessionID: 'ses-v2x-p' })) as { content: string };
      expect(typeof out.content).toBe('string');
      expect(JSON.parse(out.content)).toEqual(expect.any(Object));
      if (typeof cleanup === 'function') await cleanup();
      resetV2Singleflight();
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('send callback to an unknown target rejects with peer not found', async () => {
    const { root, restore } = await freshRoot('mesh-v2x-miss-');
    try {
      const { resetV2Singleflight } = await import('../src/v2singleflight.js');
      resetV2Singleflight();
      const setup = await loadSetup();
      const host = fakeHost();
      const cleanup = await setup(host.ctx as never);
      const def = host.tools.find((t) => t.name === 'mesh_send');
      const err = await def
        ?.execute({ target: 'ses-does-not-exist', text: 'hi' }, { sessionID: 'ses-v2x-s', agent: 'beta' })
        .then(
          () => null,
          (e: unknown) => e as { code?: string },
        );
      expect(err?.code).toBe('PEER_NOT_FOUND');
      if (typeof cleanup === 'function') await cleanup();
      resetV2Singleflight();
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('send callback to a registered peer resolves with queued content', async () => {
    const { root, restore } = await freshRoot('mesh-v2x-send-');
    try {
      const { resetV2Singleflight } = await import('../src/v2singleflight.js');
      resetV2Singleflight();
      const setup = await loadSetup();
      const host = fakeHost();
      const cleanup = await setup(host.ctx as never);
      const register = host.tools.find((t) => t.name === 'mesh_register');
      await register?.execute({ summary: 'V2 target' }, { sessionID: 'ses-v2x-t', agent: 'beta' });
      const send = host.tools.find((t) => t.name === 'mesh_send');
      const out = (await send?.execute(
        { target: 'ses-v2x-t', text: 'hello' },
        { sessionID: 'ses-v2x-t', agent: 'beta' },
      )) as { content: string };
      expect(typeof out.content).toBe('string');
      expect(JSON.parse(out.content)).toEqual(expect.any(Object));
      if (typeof cleanup === 'function') await cleanup();
      resetV2Singleflight();
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('broadcast opt-in delivers through the v2 envelope', async () => {
    const { root, restore } = await freshRoot('mesh-v2x-bcast-');
    const prev = process.env.MESH_BROADCAST;
    process.env.MESH_BROADCAST = '1';
    try {
      const { resetV2Singleflight } = await import('../src/v2singleflight.js');
      resetV2Singleflight();
      const setup = await loadSetup();
      const host = fakeHost();
      const cleanup = await setup(host.ctx as never);
      const register = host.tools.find((t) => t.name === 'mesh_register');
      await register?.execute({ summary: 'V2 listener' }, { sessionID: 'ses-v2x-l', agent: 'beta' });
      const def = host.tools.find((t) => t.name === 'mesh_broadcast');
      const out = (await def?.execute({ text: 'hello all' }, { sessionID: 'ses-v2x-l', agent: 'beta' })) as {
        content: string;
      };
      expect(typeof out.content).toBe('string');
      expect(JSON.parse(out.content)).toEqual(expect.any(Object));
      if (typeof cleanup === 'function') await cleanup();
      resetV2Singleflight();
    } finally {
      if (prev === undefined) delete process.env.MESH_BROADCAST;
      else process.env.MESH_BROADCAST = prev;
      await safeRm(root);
      restore();
    }
  });

  it('callbacks without a session id still delegate instead of throwing', async () => {
    const { root, restore } = await freshRoot('mesh-v2x-nosid-');
    try {
      const { resetV2Singleflight } = await import('../src/v2singleflight.js');
      resetV2Singleflight();
      const setup = await loadSetup();
      const host = fakeHost();
      const cleanup = await setup(host.ctx as never);
      const def = host.tools.find((t) => t.name === 'mesh_peers');
      const out = (await def?.execute({}, { sessionID: '' })) as { content: string };
      expect(typeof out.content).toBe('string');
      if (typeof cleanup === 'function') await cleanup();
      resetV2Singleflight();
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('execute hook with an empty session id records nothing and throws nothing', async () => {
    const { root, restore } = await freshRoot('mesh-v2x-hook-');
    try {
      const { resetV2Singleflight, v2OwnedIds } = await import('../src/v2singleflight.js');
      resetV2Singleflight();
      const setup = await loadSetup();
      const host = fakeHost();
      const cleanup = await setup(host.ctx as never);
      await host.hooks['execute.before']({ sessionID: '' });
      expect(v2OwnedIds()).toEqual([]);
      if (typeof cleanup === 'function') await cleanup();
      resetV2Singleflight();
    } finally {
      await safeRm(root);
      restore();
    }
  });
});

describe('v2 lifecycle events ignore malformed and id-less payloads', () => {
  it('null, untyped, and unknown events leave the registry untouched', async () => {
    const { root, restore } = await freshRoot('mesh-v2x-mal-');
    try {
      const { resetV2Singleflight, v2OwnedIds } = await import('../src/v2singleflight.js');
      resetV2Singleflight();
      const reg = await import('../src/registry.js');
      const setup = await loadSetup();
      const host = fakeHost([
        {},
        { type: 'other.event', id: 'ses-v2x-o', data: {} },
        { type: 'session.created', id: 'ses-v2x-done', data: {} },
      ]);
      const cleanup = await setup(host.ctx as never);
      await waitFor(() => v2OwnedIds().includes('ses-v2x-done'), 'sentinel presence');
      const rows = (await reg.readRegistry(root)) as unknown as Record<string, unknown>;
      expect('ses-v2x-o' in rows).toBe(false);
      if (typeof cleanup === 'function') await cleanup();
      resetV2Singleflight();
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('deleted event without an id keeps the existing row', async () => {
    const { root, restore } = await freshRoot('mesh-v2x-noid-');
    try {
      const { resetV2Singleflight } = await import('../src/v2singleflight.js');
      resetV2Singleflight();
      const reg = await import('../src/registry.js');
      await reg.atomicUpdateRegistry((r: unknown) => {
        (r as Record<string, unknown>)['ses-v2x-keep'] = {
          sessionId: 'ses-v2x-keep',
          agent: 'beta',
          updatedAt: Date.now(),
        };
      }, root);
      const setup = await loadSetup();
      const host = fakeHost([{ type: 'session.deleted', data: {} }]);
      const cleanup = await setup(host.ctx as never);
      await new Promise((r) => setTimeout(r, 100));
      const rows = (await reg.readRegistry(root)) as unknown as Record<string, unknown>;
      expect('ses-v2x-keep' in rows).toBe(true);
      if (typeof cleanup === 'function') await cleanup();
      resetV2Singleflight();
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('deleted event for an attached id keeps the row', async () => {
    const { root, restore } = await freshRoot('mesh-v2x-att-');
    try {
      const { resetV2Singleflight, v2OwnedIds } = await import('../src/v2singleflight.js');
      resetV2Singleflight();
      const reg = await import('../src/registry.js');
      await reg.atomicUpdateRegistry((r: unknown) => {
        (r as Record<string, unknown>)['ses-v2x-att'] = {
          sessionId: 'ses-v2x-att',
          agent: 'beta',
          updatedAt: Date.now(),
          attached: true,
        };
      }, root);
      const setup = await loadSetup();
      const host = fakeHost([
        { type: 'session.deleted', id: 'ses-v2x-att', data: {} },
        { type: 'session.created', id: 'ses-v2x-done', data: {} },
      ]);
      const cleanup = await setup(host.ctx as never);
      await waitFor(() => v2OwnedIds().includes('ses-v2x-done'), 'sentinel presence');
      const rows = (await reg.readRegistry(root)) as unknown as Record<string, unknown>;
      expect('ses-v2x-att' in rows).toBe(true);
      if (typeof cleanup === 'function') await cleanup();
      resetV2Singleflight();
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('repeat created events for one id merge ownership once', async () => {
    const { root, restore } = await freshRoot('mesh-v2x-dedupe-');
    try {
      const { resetV2Singleflight, v2OwnedIds } = await import('../src/v2singleflight.js');
      resetV2Singleflight();
      const setup = await loadSetup();
      const host = fakeHost([
        { type: 'session.created', id: 'ses-v2x-d', data: {} },
        { type: 'session.created', id: 'ses-v2x-d', data: {} },
      ]);
      const cleanup = await setup(host.ctx as never);
      await waitFor(() => v2OwnedIds().filter((id) => id === 'ses-v2x-d').length === 1, 'single merge');
      if (typeof cleanup === 'function') await cleanup();
      resetV2Singleflight();
    } finally {
      await safeRm(root);
      restore();
    }
  });
});

describe('v2 setup cleanup evicts only its own past-grace ids', () => {
  it('cleanup with no tool calls releases the slot and stops', async () => {
    const { root, restore } = await freshRoot('mesh-v2x-clean-');
    try {
      const guard = await import('../src/v2singleflight.js');
      guard.resetV2Singleflight();
      const setup = await loadSetup();
      const host = fakeHost();
      const cleanup = await setup(host.ctx as never);
      await (cleanup as () => Promise<void>)();
      expect(guard.v2SetupCount()).toBe(0);
      expect(guard.v2OwnedIds()).toEqual([]);
      guard.resetV2Singleflight();
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('cleanup deletes its stale id and keeps fresh and attached ids', async () => {
    const { root, restore } = await freshRoot('mesh-v2x-evict-');
    try {
      const { resetV2Singleflight } = await import('../src/v2singleflight.js');
      resetV2Singleflight();
      const reg = await import('../src/registry.js');
      const setup = await loadSetup();
      const host = fakeHost();
      const cleanup = await setup(host.ctx as never);
      const register = host.tools.find((t) => t.name === 'mesh_register');
      await register?.execute({ summary: 'stale' }, { sessionID: 'ses-v2x-old', agent: 'beta' });
      await register?.execute({ summary: 'fresh' }, { sessionID: 'ses-v2x-new', agent: 'beta' });
      await register?.execute({ summary: 'pinned' }, { sessionID: 'ses-v2x-pin', agent: 'beta' });
      const hour = 3600000;
      await reg.atomicUpdateRegistry((r: unknown) => {
        const rows = r as Record<string, Record<string, unknown>>;
        rows['ses-v2x-old'].updatedAt = Date.now() - hour;
        rows['ses-v2x-pin'].attached = true;
      }, root);
      await (cleanup as () => Promise<void>)();
      const rows = (await reg.readRegistry(root)) as unknown as Record<string, unknown>;
      expect('ses-v2x-old' in rows).toBe(false);
      expect('ses-v2x-new' in rows).toBe(true);
      expect('ses-v2x-pin' in rows).toBe(true);
      resetV2Singleflight();
    } finally {
      await safeRm(root);
      restore();
    }
  });
});
