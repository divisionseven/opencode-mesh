// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Double-probe single-flight: two plugin instances in one
// process share one heartbeat, one claimer, one attach poller, with merged
// ownership by union, never overwrite. Given two inits on one hermetic root,
// when both callers register, then both rows persist with their own
// descriptions; when the first hook disposes, then the second hook still
// registers and queues; when both dispose, then re-init works clean.
// Setup laziness joins here: given a fresh root, when double init runs with
// zero tool calls, then no sqlite file appears (the queue driver resolves
// only on the execute and poll paths).
// Timer singularity counting lives in bench/, never in vitest walls (one
// enforcement per layer). The V2 cohabitation leg is covered by the import
// check at the bottom of this file; live setup invocation against the V2
// context stays owned by tests/v2-adapter-setup.test.ts.
// Related single-path coverage (not restated here):
// tests/plugin-tool-matrix.test.ts peers-plus-send, tests/export-shape.test.ts
// legacy host scan shape.
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { resolveOutboxPath } from '../src/xdg.js';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch as unknown as typeof fetch;
  vi.resetModules();
  vi.restoreAllMocks();
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

async function safeRmArmed(root: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (
        (code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM') &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      throw err;
    }
  }
}

type Hooks = {
  event: (e: unknown) => Promise<void>;
  dispose: () => Promise<void>;
  tool: Record<string, { execute: (a: unknown, c: unknown) => Promise<unknown> }>;
};

async function init(client: unknown): Promise<Hooks> {
  const pluginMod = await import('../plugin/opencode-mesh.js');
  const entry = pluginMod.default as unknown as (
    input: unknown,
  ) => Promise<Hooks>;
  return entry({ client });
}

function stubFetchReject(): void {
  globalThis.fetch = (async () => {
    throw new Error('no net in hermetic probe');
  }) as unknown as typeof fetch;
}

describe('double-probe single-flight: two inits share one core', () => {
  it('double init exposes four tools with execute on both hooks', async () => {
    const { root, restore } = await freshRoot('mesh-dp-shape-');
    try {
      const hooks1 = await init({});
      const hooks2 = await init({});
      for (const hooks of [hooks1, hooks2]) {
        const names = Object.keys(hooks.tool).sort();
        expect(names).toEqual([
          'mesh_broadcast',
          'mesh_peers',
          'mesh_register',
          'mesh_send',
        ]);
        for (const name of names) {
          expect(typeof hooks.tool[name].execute).toBe('function');
        }
      }
      await hooks1.dispose();
      await hooks2.dispose();
    } finally {
      await safeRmArmed(root);
      restore();
    }
  });

  it('two registers merge by union, generic re-register never clobbers', async () => {
    const { root, restore } = await freshRoot('mesh-dp-union-');
    try {
      const hooks1 = await init({});
      const hooks2 = await init({});
      await hooks1.tool.mesh_register.execute(
        { summary: 'Alpha work' },
        { sessionID: 'ses-dp-a', directory: '/tmp' },
      );
      await hooks2.tool.mesh_register.execute(
        { summary: 'Beta work' },
        { sessionID: 'ses-dp-b', directory: '/tmp' },
      );
      await hooks2.tool.mesh_register.execute(
        { summary: 'New session - 2026-09-03T10:00:00.000Z' },
        { sessionID: 'ses-dp-a', directory: '/tmp' },
      );
      const reg = await import('../src/registry.js');
      const rows = (await reg.readRegistry(
        root,
      )) as unknown as Record<string, Record<string, unknown>>;
      expect(rows['ses-dp-a']).toBeDefined();
      expect(rows['ses-dp-b']).toBeDefined();
      expect(rows['ses-dp-a'].description).toBe('Alpha work');
      expect(rows['ses-dp-b'].description).toBe('Beta work');
      await hooks1.dispose();
      await hooks2.dispose();
    } finally {
      await safeRmArmed(root);
      restore();
    }
  });

  it('first dispose leaves the second hook registering and queueing', async () => {
    const { root, restore } = await freshRoot('mesh-dp-teardown-');
    stubFetchReject();
    try {
      const hooks1 = await init({});
      const hooks2 = await init({});
      const reg = await import('../src/registry.js');
      await reg.atomicUpdateRegistry((r: unknown) => {
        (r as Record<string, unknown>)['ses-dp-peer'] = {
          sessionId: 'ses-dp-peer',
          agent: 'beta',
          model: 'myprov/my-model',
          directory: '/tmp/peer',
          updatedAt: Date.now(),
        };
      }, root);
      await hooks1.dispose();
      await hooks2.tool.mesh_register.execute(
        { summary: 'Carry on' },
        { sessionID: 'ses-dp-c', directory: '/tmp' },
      );
      const sent = (await hooks2.tool.mesh_send.execute(
        { target: 'ses-dp-peer', text: 'still here' },
        { sessionID: 'ses-dp-c', directory: '/tmp' },
      )) as { output: string };
      expect(JSON.parse(sent.output)).toMatchObject({
        ok: true,
        via: 'queued',
        target: 'ses-dp-peer',
      });
      await hooks2.dispose();
      const hooks3 = await init({});
      await hooks3.tool.mesh_register.execute(
        { summary: 'Fresh start' },
        { sessionID: 'ses-dp-d', directory: '/tmp' },
      );
      const rows = (await reg.readRegistry(
        root,
      )) as unknown as Record<string, unknown>;
      expect(rows['ses-dp-d']).toBeDefined();
      await hooks3.dispose();
    } finally {
      await safeRmArmed(root);
      restore();
    }
  });

  it('double setup performs zero sqlite loads before first use', async () => {
    const { root, restore } = await freshRoot('mesh-dp-lazy-');
    try {
      const hooks1 = await init({});
      const hooks2 = await init({});
      const names = await readdir(root);
      expect(names.filter((n) => n.endsWith('.db'))).toEqual([]);
      expect(existsSync(resolveOutboxPath())).toBe(false);
      expect(existsSync(join(root, 'empty.db'))).toBe(false);
      await hooks1.dispose();
      await hooks2.dispose();
    } finally {
      await safeRmArmed(root);
      restore();
    }
  });

  it('V2 adapter module imports (setup behavior is pinned in v2-adapter-setup)', async () => {
    try {
      await import('../plugin/opencode-mesh-v2.js');
    } catch (err) {
      throw new Error(
        'V2 adapter absent: plugin/opencode-mesh-v2.ts is missing; '
          + 'the setup suite in tests/v2-adapter-setup.test.ts owns the live proof. '
          + `Import failed with: ${String((err as Error)?.message ?? err)}`,
      );
    }
  });
});
