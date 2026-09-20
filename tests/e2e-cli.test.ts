// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// CLI end to end: real bin/cli.js spawns against a sandboxed home.
// Asserts exit codes, JSON output, and store effects, never internals.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, afterEach, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OPENCODE_MESH_DB_PATH;
});

async function freshHome(prefix: string): Promise<{ home: string; restore: () => void }> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const prevHome = process.env.HOME;
  const prevRoot = process.env.OPENCODE_MESH_ROOT;
  const prevDb = process.env.OPENCODE_MESH_DB_PATH;
  const prevSession = process.env.SESSION_ID;
  process.env.HOME = home;
  process.env.OPENCODE_MESH_ROOT = join(home, '.local', 'state', 'opencode', 'mesh');
  process.env.OPENCODE_MESH_DB_PATH = join(home, '.local', 'state', 'opencode', 'mesh', 'db.sqlite');
  process.env.SESSION_ID = 'e2e-caller';
  return { home, restore: () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevRoot === undefined) delete process.env.OPENCODE_MESH_ROOT;
    else process.env.OPENCODE_MESH_ROOT = prevRoot;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH;
    else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    if (prevSession === undefined) delete process.env.SESSION_ID;
    else process.env.SESSION_ID = prevSession;
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

function cli(home: string, args: string[]): string {
  return execFileSync(process.execPath, ['bin/cli.js', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    timeout: 60_000,
    encoding: 'utf8',
  });
}

describe('e2e cli', () => {
  it('per-verb help prints usage with exit zero', async () => {
    const { home, restore } = await freshHome('mesh-e2e-help-');
    try {
      const sendHelp = cli(home, ['send', '--help']);
      expect(sendHelp).toContain('Usage: opencode-mesh send <target|all> <text...>');
      expect(sendHelp).not.toContain('opencode-mesh gc');
      const peersHelp = cli(home, ['peers', '--help']);
      expect(peersHelp).toContain('Usage: opencode-mesh peers');
      const topHelp = cli(home, ['--help']);
      expect(topHelp).toContain('opencode-mesh gc');
    } finally {
      await safeRm(home); restore();
    }
  });

  it('multiword send queues the full text', async () => {
    const { home, restore } = await freshHome('mesh-e2e-send-');
    try {
      const { atomicUpdateRegistry } = await import('../src/registry.js');
      const root = process.env.OPENCODE_MESH_ROOT as string;
      await atomicUpdateRegistry((reg: unknown) => {
        (reg as Record<string, unknown>)['ses-T'] = { sessionId: 'ses-T', agent: 'beta', model: 'myprov/my-model', directory: '/tmp/t', updatedAt: Date.now() };
      }, root);
      const out = cli(home, ['send', 'ses-T', 'hello', 'brave', 'new', 'world']);
      expect(JSON.parse(out)).toMatchObject({ via: 'queued' });
      const { DatabaseSync } = await import('node:sqlite');
      const { resolveOutboxPath } = await import('../src/xdg.js');
      const db = new DatabaseSync(resolveOutboxPath(root));
      const row = db.prepare(`SELECT text FROM outbox WHERE target_session = ?`).get('ses-T') as unknown as { text: string };
      db.close();
      expect(row.text).toBe('hello brave new world');
    } finally {
      await safeRm(home); restore();
    }
  });

  it('peers --json lists as parseable JSON', async () => {
    const { home, restore } = await freshHome('mesh-e2e-peers-');
    try {
      const { atomicUpdateRegistry } = await import('../src/registry.js');
      const root = process.env.OPENCODE_MESH_ROOT as string;
      await atomicUpdateRegistry((reg: unknown) => {
        (reg as Record<string, unknown>)['ses-T'] = { sessionId: 'ses-T', agent: 'beta', updatedAt: Date.now() };
      }, root);
      const out = cli(home, ['peers', '--json']);
      const body = JSON.parse(out) as { peers?: Record<string, unknown> } & Record<string, unknown>;
      const peers = body.peers ?? body;
      expect(peers['ses-T']).toBeDefined();
    } finally {
      await safeRm(home); restore();
    }
  });
});
