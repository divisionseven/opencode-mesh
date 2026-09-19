// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Peers display matrix: sparse entries list with defaults in id order,
// busy peers rank first. Each test pins displayed output, never internals.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

afterEach(() => {
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

describe('peers display matrix', () => {
  it('sparse entries list with defaults in id order', async () => {
    const { root, restore } = await freshRoot('mesh-peers-sparse-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    const stamp = Date.now();
    await atomicUpdateRegistry((reg: unknown) => {
      const r = reg as Record<string, unknown>;
      r['ses-b'] = { sessionId: 'ses-b', agent: 'b', updatedAt: stamp };
      r['ses-a'] = { sessionId: 'ses-a', agent: 'a', updatedAt: stamp };
    }, root);
    const { mesh_peers } = await import('../src/tools/mesh_peers.js');
    const out = await (mesh_peers.execute as unknown as (a: unknown, c: unknown) => Promise<{ output: string }>)(
      {}, { sessionID: 'caller' }
    );
    const body = JSON.parse(out.output) as { peers?: Record<string, { rank: number; live: string; liveSource: string; ageSec: number }> } & Record<string, { rank: number; live: string; liveSource: string; ageSec: number }>;
    const peers = body.peers ?? body;
    expect(Object.keys(peers)).toEqual(['ses-a', 'ses-b']);
    expect(peers['ses-a'].rank).toBe(1);
    expect(peers['ses-a'].live).toBe('unknown');
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });

  it('busy peer ranks ahead of idle peers', async () => {
    const { root, restore } = await freshRoot('mesh-peers-busy-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    // Why: liveness comes from the live join, never the stored row. The
    // idle peer is newer, so rank 1 proves the busy flag, not recency.
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ 'ses-busy': { type: 'busy' } }) }) as unknown as Response) as unknown as typeof fetch;
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: unknown) => {
      const r = reg as Record<string, unknown>;
      r['ses-idle'] = { sessionId: 'ses-idle', agent: 'a', updatedAt: Date.now() };
      r['ses-busy'] = { sessionId: 'ses-busy', agent: 'b', updatedAt: Date.now() - 5000 };
    }, root);
    const { mesh_peers } = await import('../src/tools/mesh_peers.js');
    const out = await (mesh_peers.execute as unknown as (a: unknown, c: unknown) => Promise<{ output: string }>)(
      {}, { sessionID: 'caller' }
    );
    const body = JSON.parse(out.output) as { peers?: Record<string, { rank: number }> } & Record<string, { rank: number }>;
    const peers = body.peers ?? body;
    expect(peers['ses-busy'].rank).toBe(1);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRm(root); restore();
  });
});
