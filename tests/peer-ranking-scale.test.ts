// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Thousands-scale ordered narrowing.
// The planted targets must surface at the documented rank positions under a
// thousands-scale union; input-order traversal (no narrowing) cannot do this.
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach, vi } from 'vitest';

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
  process.env.OPENCODE_MESH_ROOT = root;
  process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
  return { root, restore: () => {
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT;
    else process.env.OPENCODE_MESH_ROOT = prev;
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

function rejectFetch(): typeof fetch {
  return (async () => { throw new Error('unreachable'); }) as unknown as typeof fetch;
}

describe('thousands-scale narrowing', () => {
  it('planted targets surface at the documented rank positions', async () => {
    const { root, restore } = await freshRoot('mesh-scale-');
    const plants = JSON.parse(readFileSync(join('tests', 'fixtures', 'narrowing-plants.json'), 'utf8')) as {
      plants: Array<{ id: string }>;
      scale: { total: number; fillerPrefix: string };
    };
    const now = Date.now();
    const dir = '/tmp/target-proj';
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      const r = reg as Record<string, unknown>;
      // Filler FIRST so input order buries the plants: only ordered
      // narrowing (never input order) can surface them at the top.
      for (let i = 0; i < plants.scale.total - plants.plants.length; i++) {
        const id = `${plants.scale.fillerPrefix}${i}`;
        r[id] = {
          sessionId: id,
          agent: i % 2 === 0 ? 'worker' : 'helper',
          description: i % 3 === 0 ? `New session - 2026-09-04T10:00:00.000Z` : `Filler chore ${i}`,
          directory: `/tmp/filler-${i % 97}`,
          updatedAt: now,
          lastActionAt: now - (i + 5) * 60 * 1000,
        } as unknown;
      }
      // Planted targets, each winning exactly one level.
      r['ses-plant-attach'] = { sessionId: 'ses-plant-attach', agent: 'other', description: 'Unrelated chore', directory: '/tmp/elsewhere', updatedAt: now, attached: true, lastActionAt: now - 60 * 1000 } as unknown;
      r['ses-plant-exact'] = { sessionId: 'ses-plant-exact', agent: 'other', description: 'Unrelated chore', directory: dir, updatedAt: now, lastActionAt: now - 60 * 1000 } as unknown;
      r['ses-plant-agent'] = { sessionId: 'ses-plant-agent', agent: 'manager', description: 'Unrelated chore', directory: dir + '/sub', updatedAt: now, lastActionAt: now - 60 * 1000 } as unknown;
      r['ses-plant-recent'] = { sessionId: 'ses-plant-recent', agent: 'other', description: 'Unrelated chore', directory: '/tmp/far', updatedAt: now, lastActionAt: now - 1000 } as unknown;
      r['ses-plant-title'] = { sessionId: 'ses-plant-title', agent: 'other', description: 'Refactoring auth flow', directory: '/tmp/far', updatedAt: now, lastActionAt: now - 60 * 1000 } as unknown;
    }, root);
    globalThis.fetch = rejectFetch();
    const { mesh_peers } = await import('../src/tools/mesh_peers.js');
    const out = await (mesh_peers.execute as (...a: never[]) => Promise<{ output: string }>)(
      { includeSelf: true, cwd: dir, agent: 'manager', description: 'Refactoring' } as never,
      { sessionID: 'caller-x' } as never
    );
    const raw = JSON.parse(out.output) as Record<string, unknown>;
    const j = ((raw as { peers?: Record<string, { rank?: number }> }).peers ?? raw) as Record<string, { rank?: number }>;
    const ids = Object.keys(j);
    expect(ids.length).toBe(plants.scale.total);
    // Rank-last order: attached plant first, then exact-dir, then agent-inside-order,
    // then most-recent, then title-confirmed — every plant ahead of all filler.
    expect(j['ses-plant-attach']?.rank).toBe(1);
    const ranks = ids.map((id) => j[id]?.rank ?? 0);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    const plantRanks = plants.plants.map((p) => j[p.id]?.rank ?? 0);
    expect(Math.max(...plantRanks)).toBeLessThanOrEqual(plants.plants.length);
    // Input-order traversal would bury the plants; narrowing must not.
    expect(j['ses-plant-title']?.rank).toBeLessThanOrEqual(5);
    await safeRm(root); restore();
  }, 30000);
});
