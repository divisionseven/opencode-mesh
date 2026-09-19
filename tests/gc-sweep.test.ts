// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// runGc sweep behavior legs.
import { mkdtemp, rm, mkdir, writeFile, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicUpdateRegistry } from '../src/registry.js';
import { readRegistry } from '../src/registry.js';
import { runGc } from '../src/gc.js';

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

async function seedInboxFile(root: string, id: string, name: string, ageMs: number): Promise<string> {
  const dir = join(root, 'inbox', id);
  await mkdir(dir, { recursive: true });
  const p = join(dir, name);
  await writeFile(p, 'x');
  const t = new Date(Date.now() - ageMs);
  await utimes(p, t, t);
  return p;
}

describe('gc sweep behavior legs', () => {
  it('old .owner file unlinks past the owner TTL', async () => {
    const { root, restore } = await freshRoot('mesh-gc-owner-');
    await seedInboxFile(root, 'id-old', '.owner', 10 * 60 * 1000);
    const res = await runGc(root);
    expect(res.prunedInbox).toBe(1);
    await safeRm(root); restore();
  });

  it('fresh .owner file is kept inside the owner TTL', async () => {
    const { root, restore } = await freshRoot('mesh-gc-ownerfresh-');
    await seedInboxFile(root, 'id-fresh', '.owner', 60 * 1000);
    const res = await runGc(root);
    expect(res.prunedInbox).toBe(0);
    await safeRm(root); restore();
  });

  it('old .json message unlinks past the stale TTL', async () => {
    const { root, restore } = await freshRoot('mesh-gc-json-');
    await seedInboxFile(root, 'id-j', 'msg.json', 25 * 60 * 60 * 1000);
    const res = await runGc(root);
    expect(res.prunedInbox).toBe(1);
    await safeRm(root); restore();
  });

  it('old .reply.json unlinks past the stale TTL', async () => {
    const { root, restore } = await freshRoot('mesh-gc-reply-');
    await seedInboxFile(root, 'id-r', 'm.reply.json', 25 * 60 * 60 * 1000);
    const res = await runGc(root);
    expect(res.prunedInbox).toBe(1);
    await safeRm(root); restore();
  });

  it('fresh .json message is kept inside the stale TTL', async () => {
    const { root, restore } = await freshRoot('mesh-gc-jsonfresh-');
    await seedInboxFile(root, 'id-jf', 'msg.json', 60 * 1000);
    const res = await runGc(root);
    expect(res.prunedInbox).toBe(0);
    await safeRm(root); restore();
  });

  it('non-directory inbox entry is skipped', async () => {
    const { root, restore } = await freshRoot('mesh-gc-nondir-');
    await mkdir(join(root, 'inbox'), { recursive: true });
    await writeFile(join(root, 'inbox', 'flat-file'), 'x');
    const res = await runGc(root);
    expect(res.prunedInbox).toBe(0);
    await safeRm(root); restore();
  });

  it('dangling symlink inbox file is skipped', async () => {
    const { root, restore } = await freshRoot('mesh-gc-symlink-');
    const dir = join(root, 'inbox', 'id-sym');
    await mkdir(dir, { recursive: true });
    await symlink(join(dir, 'gone-target'), join(dir, 'ghost.json'));
    const res = await runGc(root);
    expect(res.prunedInbox).toBe(0);
    await safeRm(root); restore();
  });

  it('emptied id directory is removed', async () => {
    const { root, restore } = await freshRoot('mesh-gc-emptydir-');
    await seedInboxFile(root, 'id-e', '.owner', 10 * 60 * 1000);
    await runGc(root);
    const { readdir } = await import('node:fs/promises');
    await expect(readdir(join(root, 'inbox', 'id-e')).catch(() => [])).resolves.toEqual([]);
    await safeRm(root); restore();
  });

  it('stale registry entry prunes and persists through the writer', async () => {
    const { root, restore } = await freshRoot('mesh-gc-prune-');
    const now = Date.now();
    // Raw envelope write: the single writer prunes on write, so stale rows
    // only reach the sweep through the file shape, never through the writer.
    await writeFile(join(root, 'registry.json'), JSON.stringify({
      version: 1,
      entries: {
        'ses-old': { sessionId: 'ses-old', agent: 'a', updatedAt: now - 25 * 60 * 60 * 1000 },
        'ses-new': { sessionId: 'ses-new', agent: 'a', updatedAt: now },
      },
      migratedAt: now,
    }));
    const res = await runGc(root);
    expect(res.prunedRegistry).toBe(1);
    const after = await readRegistry(root) as Record<string, unknown>;
    expect('ses-old' in after).toBe(false);
    expect('ses-new' in after).toBe(true);
    await safeRm(root); restore();
  });

  it('fresh registry skips the persist write', async () => {
    const { root, restore } = await freshRoot('mesh-gc-noprune-');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-new'] = { sessionId: 'ses-new', agent: 'a', updatedAt: Date.now() } as any;
    }, root);
    const res = await runGc(root);
    expect(res.prunedRegistry).toBe(0);
    await safeRm(root); restore();
  });

  it('raw-shape registry reads the unwrapped document', async () => {
    const { root, restore } = await freshRoot('mesh-gc-raw-');
    const now = Date.now();
    await writeFile(join(root, 'registry.json'), JSON.stringify({
      'ses-raw-old': { sessionId: 'ses-raw-old', agent: 'a', updatedAt: now - 25 * 60 * 60 * 1000 },
    }));
    const res = await runGc(root);
    expect(res.prunedRegistry).toBe(1);
    await safeRm(root); restore();
  });

  it('corrupt registry reads as empty and resolves', async () => {
    const { root, restore } = await freshRoot('mesh-gc-corrupt-');
    await writeFile(join(root, 'registry.json'), 'not-json{{{');
    const res = await runGc(root);
    expect(res.prunedRegistry).toBe(0);
    await safeRm(root); restore();
  });

  it('no live view reports the no-single-port-view skip', async () => {
    const { root, restore } = await freshRoot('mesh-gc-live-');
    const res = await runGc(root);
    expect(res.liveSkipped).toBe('no-single-port-view');
    await safeRm(root); restore();
  });

  it('missing outbox passes the header check into collection', async () => {
    const { root, restore } = await freshRoot('mesh-gc-nooutbox-');
    const res = await runGc(root);
    expect(res.prunedOutbox).toBe(0);
    expect(res.deadLetterOutbox).toBe(0);
    await safeRm(root); restore();
  });

  it('existing outbox reads its header and collects', async () => {
    const { root, restore } = await freshRoot('mesh-gc-outbox-');
    const ob = await import('../src/outbox.js');
    await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    const res = await runGc(root);
    expect(res.prunedOutbox).toBe(0);
    await safeRm(root); restore();
  });

  it('corrupt-header outbox resolves without throwing', async () => {
    const { root, restore } = await freshRoot('mesh-gc-badheader-');
    await writeFile(join(root, 'outbox.db'), Buffer.alloc(16, 0x41));
    const res = await runGc(root);
    expect(res.prunedOutbox).toBe(0);
    await safeRm(root); restore();
  });

  it('absent meshRoot argument resolves through the environment', async () => {
    const { root, restore } = await freshRoot('mesh-gc-noarg-');
    const res = await runGc();
    expect(res.liveSkipped).toBe('no-single-port-view');
    await safeRm(root); restore();
  });

  it('live view prunes registry ids absent from the snapshot', async () => {
    const { root, restore } = await freshRoot('mesh-gc-liveprune-');
    const now = Date.now();
    await writeFile(join(root, 'registry.json'), JSON.stringify({
      version: 1,
      entries: {
        'ses-live': { sessionId: 'ses-live', agent: 'a', updatedAt: now },
        'ses-dead': { sessionId: 'ses-dead', agent: 'a', updatedAt: now - 61 * 1000 },
      },
      migratedAt: now,
    }));
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true, status: 200, json: async () => ({ 'ses-live': { type: 'idle' } }),
    })) as unknown as typeof fetch;
    try {
      const res = await runGc(root);
      expect(res.liveSkipped).toBeUndefined();
      expect(res.prunedLive).toBe(1);
      const after = await readRegistry(root) as Record<string, unknown>;
      expect('ses-dead' in after).toBe(false);
      expect('ses-live' in after).toBe(true);
    } finally {
      globalThis.fetch = prevFetch;
    }
    await safeRm(root); restore();
  });
});

describe('gc inbox drain edges', () => {
  it('dangling symlink inbox entry skips without throwing', async () => {
    const { root, restore } = await freshRoot('mesh-gc-dangle-');
    const { mkdir, symlink } = await import('node:fs/promises');
    await mkdir(join(root, 'inbox'), { recursive: true });
    await symlink(join(root, 'nowhere-target'), join(root, 'inbox', 'dangling'));
    const { runGc } = await import('../src/gc.js');
    const res = await runGc(root);
    expect(res.prunedInbox).toBe(0);
    await safeRm(root); restore();
  });

  it('read-only inbox still sweeps old files without throwing', async () => {
    const { root, restore } = await freshRoot('mesh-gc-readonly-');
    const { mkdir, writeFile, chmod, utimes } = await import('node:fs/promises');
    const dir = join(root, 'inbox', 'ses-ro');
    await mkdir(dir, { recursive: true });
    const old = new Date(Date.now() - 30 * 3600 * 1000);
    await writeFile(join(dir, 'stale.json'), '{}');
    await utimes(join(dir, 'stale.json'), old, old);
    await chmod(dir, 0o555);
    const { runGc } = await import('../src/gc.js');
    let res;
    try {
      res = await runGc(root);
    } finally {
      await chmod(dir, 0o755);
    }
    expect(res.prunedInbox).toBe(1);
    expect(res.prunedRegistry).toBe(0);
    await safeRm(root); restore();
  });

  it('cli entry prints the sweep result as JSON', async () => {    const { root, restore } = await freshRoot('mesh-gc-cli-');
    const { execFileSync } = await import('node:child_process');
    const stdout = execFileSync(process.execPath, ['dist/gc.js'], {
      cwd: process.cwd(),
      env: { ...process.env, OPENCODE_MESH_ROOT: root },
      timeout: 60_000,
      encoding: 'utf8',
    });
    const result = JSON.parse(String(stdout)) as Record<string, unknown>;
    expect(result.prunedRegistry).toBe(0);
    expect(result.liveSkipped).toBe('no-single-port-view');
    await safeRm(root); restore();
  }, 90_000);

  it('concurrent join between snapshot and commit survives', async () => {
    const { root, restore } = await freshRoot('mesh-gc-race-');
    const { open, readFile, writeFile, unlink } = await import('node:fs/promises');
    const { constants } = await import('node:fs');
    const target = join(root, 'registry.json');
    await writeFile(target, JSON.stringify({
      version: 1,
      entries: { 'ses-old': { sessionId: 'ses-old', agent: 'a', updatedAt: Date.now() - 30 * 3600 * 1000 } },
    }));
    const holder = await open(join(root, 'registry.json.lock'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    const sweep = runGc(root);
    await new Promise((r) => setTimeout(r, 500));
    const doc = JSON.parse(await readFile(target, 'utf8')) as { entries?: Record<string, unknown> };
    const entries = doc.entries ?? (doc as unknown as Record<string, unknown>);
    entries['ses-join'] = { sessionId: 'ses-join', agent: 'a', updatedAt: Date.now() };
    await writeFile(target, JSON.stringify(doc));
    await holder.close();
    await unlink(join(root, 'registry.json.lock'));
    const res = await sweep;
    expect(res.prunedRegistry).toBe(1);
    const after = await readRegistry(root);
    expect(after['ses-old']).toBeUndefined();
    expect(after['ses-join']).toBeDefined();
    await safeRm(root); restore();
  }, 30_000);
});
