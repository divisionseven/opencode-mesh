// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// v2-client claimer: rows owned by a v2 process inject via in-process
// user admission (no ports, no auth, no receiver triple). Known targets
// admit and ack, unknown targets terminalize without firing, and inject
// faults defer to the bound like every other transient.
// Given a hermetic root plus a stubbed v2 client, when the claimer polls,
// then delivery matches the row state exactly.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import * as ob from '../src/outbox.js';
import * as cl from '../src/claimer.js';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch as unknown as typeof fetch;
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

async function teardown(root: string, restore: () => void): Promise<void> {
  cl.clearClaimerTimer();
  await cl.releaseClaimerOwner();
  await safeRm(root);
  restore();
}

describe('v2-client claimer', () => {
  it('known target admits via user prompt with steer delivery and acks', async () => {
    const { root, restore } = await freshRoot('v2claim-');
    await (await import('node:fs/promises')).mkdir(join(root, 'audit.log'));
    const calls: Array<{ sessionID: string; text: string; delivery: string }> =
      [];
    await ob.enqueue(
      {
        target_session: 'ses-T',
        from_session: 'ses-F',
        from_agent: 'a',
        text: 'hi v2',
      },
      root,
    );
    cl.configureClaimer({
      getOwnIds: () => ['ses-T'],
      getClient: () => null,
      getV2Client: () => ({
        prompt: async (input: {
          sessionID: string;
          text: string;
          delivery: 'steer' | 'queue';
        }) => {
          calls.push({ ...input });
          return { id: 'inbox_1' };
        },
      }),
      getRegistry: async () => ({ 'ses-T': { agent: 'beta' } }),
    });
    await cl.pollClaimer();
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionID).toBe('ses-T');
    expect(calls[0].delivery).toBe('steer');
    expect(calls[0].text).toContain('hi v2');
    expect(calls[0].text).toContain('ses-F');
    expect(await ob.pendingCount(['ses-T'], root)).toBe(0);
    await teardown(root, restore);
  });

  it('silent rows ride user prompt with queue delivery', async () => {
    const { root, restore } = await freshRoot('v2claim-quiet-');
    await (await import('node:fs/promises')).mkdir(join(root, 'audit.log'));
    const calls: Array<{ delivery: string }> = [];
    await ob.enqueue(
      {
        target_session: 'ses-T',
        from_session: 'ses-F',
        from_agent: 'a',
        text: 'quiet',
        silent: true,
      },
      root,
    );
    cl.configureClaimer({
      getOwnIds: () => ['ses-T'],
      getClient: () => null,
      getV2Client: () => ({
        prompt: async (input: { delivery: 'steer' | 'queue' }) => {
          calls.push({ delivery: input.delivery });
          return {};
        },
      }),
      getRegistry: async () => ({ 'ses-T': { agent: 'beta' } }),
    });
    await cl.pollClaimer();
    expect(calls).toEqual([{ delivery: 'queue' }]);
    expect(await ob.pendingCount(['ses-T'], root)).toBe(0);
    await teardown(root, restore);
  });

  it('unknown target never fires and the row defers to the bound', async () => {
    const { root, restore } = await freshRoot('v2claim-miss-');
    await (await import('node:fs/promises')).mkdir(join(root, 'audit.log'));
    let fired = 0;
    await ob.enqueue(
      {
        target_session: 'ses-ghost',
        from_session: 'ses-F',
        from_agent: 'a',
        text: 'hello?',
      },
      root,
    );
    cl.configureClaimer({
      getOwnIds: () => ['ses-ghost'],
      getClient: () => null,
      getV2Client: () => ({
        prompt: async () => {
          fired += 1;
          return {};
        },
      }),
      getRegistry: async () => ({}),
    });
    await cl.pollClaimer();
    expect(fired).toBe(0);
    expect(await ob.pendingCount(['ses-ghost'], root)).toBe(1);
    await teardown(root, restore);
  });

  it('inject faults defer the row instead of dropping it', async () => {
    const { root, restore } = await freshRoot('v2claim-defer-');
    await (await import('node:fs/promises')).mkdir(join(root, 'audit.log'));
    await ob.enqueue(
      {
        target_session: 'ses-T',
        from_session: 'ses-F',
        from_agent: 'a',
        text: 'retry me',
      },
      root,
    );
    cl.configureClaimer({
      getOwnIds: () => ['ses-T'],
      getClient: () => null,
      getV2Client: () => ({
        prompt: async () => {
          throw new Error('server away');
        },
      }),
      getRegistry: async () => ({ 'ses-T': { agent: 'beta' } }),
    });
    await cl.pollClaimer();
    expect(await ob.pendingCount(['ses-T'], root)).toBe(1);
    await teardown(root, restore);
  });
});
