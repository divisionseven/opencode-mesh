// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Peers ranking and field fallbacks: direct core calls with crafted rows.
// Given rows with tied scores and missing fields, when listing peers, then
// ties break by id and every missing field falls back instead of throwing.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeMeshPeers } from '../src/tools/mesh_peers.core.js';
import { atomicUpdateRegistry } from '../src/registry.js';

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

describe('peers ranking breaks ties by id and fills missing fields', () => {
  const readRows = (body: unknown): Record<string, unknown> => {
    const parsed = JSON.parse(body as string) as { peers?: Record<string, unknown> } &
      Record<string, unknown>;
    return parsed.peers ?? parsed;
  };

  it('lists tied, minimal, busy, and generic rows with ranks', async () => {
    const { root, restore } = await freshRoot('mesh-peer-rank-');
    try {
      const now = Date.now();
      await atomicUpdateRegistry((r: unknown) => {
        const rows = r as Record<string, unknown>;
        rows['ses-zzz'] = { sessionId: 'ses-zzz', agent: 'beta', updatedAt: now };
        rows['ses-aaa'] = { sessionId: 'ses-aaa', agent: 'beta', updatedAt: now };
        rows['ses-busy'] = {
          sessionId: 'ses-busy',
          agent: 'beta',
          live: 'busy',
          lastActionAt: now,
          updatedAt: now,
          directory: '/tmp',
          title: 'Real work',
        };
        rows['ses-gen'] = { sessionId: 'ses-gen', agent: 'beta', title: 'New Session', updatedAt: now };
      }, root);
      const out = await executeMeshPeers({ includeSelf: true }, { sessionID: 'ses-caller' });
      const parsed = readRows(out.output) as Record<string, { rank: number; description: string }>;
      const ids = Object.keys(parsed);
      expect(ids).toHaveLength(4);
      expect(ids.indexOf('ses-aaa')).toBeLessThan(ids.indexOf('ses-zzz'));
      for (const id of ids) {
        expect(parsed[id]?.rank).toBeGreaterThan(0);
        expect(typeof parsed[id]?.description).toBe('string');
      }
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('filters rank without hiding, and receipt returns delivery state', async () => {
    const { root, restore } = await freshRoot('mesh-peer-filter-');
    try {
      await atomicUpdateRegistry((r: unknown) => {
        (r as Record<string, unknown>)['ses-one'] = { sessionId: 'ses-one', agent: 'alpha', updatedAt: Date.now() };
      }, root);
      const byAgent = readRows(
        (await executeMeshPeers({ agent: 'alpha', includeSelf: true }, { sessionID: 'ses-caller' }))
          .output,
      );
      expect('ses-one' in byAgent).toBe(true);
      const unfiltered = readRows(
        (await executeMeshPeers({ agent: 'nobody', includeSelf: true }, { sessionID: 'ses-caller' }))
          .output,
      );
      expect('ses-one' in unfiltered).toBe(true);
      const receipt = JSON.parse(
        (await executeMeshPeers({ receipt: 'msg_missing' }, { sessionID: 'ses-caller' })).output,
      ) as { receipt: unknown };
      expect('receipt' in receipt).toBe(true);
    } finally {
      await safeRm(root);
      restore();
    }
  });
});
