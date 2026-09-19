// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Discovery store matrix over crafted databases: legacy tables without
// parent_id, null-id rows skipped, missing triples read null, message
// recency shapes, directory paths classify db-throw with evidence.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

describe('discovery store matrix', () => {
  it('legacy table without parent_id reads every row as primary', async () => {
    const { root, restore } = await freshRoot('mesh-disc-legacy-');
    const fx = join(root, 'legacy.db');
    const db = new DatabaseSync(fx);
    db.exec('CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, title TEXT, agent TEXT, time_updated INTEGER)');
    db.prepare('INSERT INTO session VALUES(?,?,?,?,?)').run('ses-old', '/tmp/o', 'Old', 'a', Date.now());
    db.close();
    const d = await import('../src/discovery.js');
    const rows = await d.readDbSessions(fx);
    expect(rows['ses-old']).toMatchObject({ id: 'ses-old', sessionType: 'primary' });
    await safeRm(root); restore();
  });

  it('null-id row never surfaces', async () => {
    const { root, restore } = await freshRoot('mesh-disc-nullid-');
    const fx = join(root, 'nullid.db');
    const db = new DatabaseSync(fx);
    db.exec('CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, title TEXT, agent TEXT, time_updated INTEGER, parent_id TEXT)');
    db.prepare('INSERT INTO session VALUES(?,?,?,?,?,?)').run(null, '/tmp/n', 'Null', 'a', Date.now(), null);
    db.prepare('INSERT INTO session VALUES(?,?,?,?,?,?)').run('ses-ok', '/tmp/o', 'Ok', 'a', Date.now(), null);
    db.close();
    const d = await import('../src/discovery.js');
    const rows = await d.readDbSessions(fx);
    expect(Object.keys(rows)).toEqual(['ses-ok']);
    await safeRm(root); restore();
  });

  it('missing triple reads null without throwing', async () => {
    const { root, restore } = await freshRoot('mesh-disc-triple-');
    const fx = join(root, 'triple.db');
    const db = new DatabaseSync(fx);
    db.exec('CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, title TEXT, agent TEXT, time_updated INTEGER, parent_id TEXT)');
    db.close();
    const d = await import('../src/discovery.js');
    expect(await d.readDbTriple('ses-absent', fx)).toBeNull();
    await safeRm(root); restore();
  });

  it('message recency keeps shaped rows and drops the rest', async () => {
    const { root, restore } = await freshRoot('mesh-disc-recency-');
    const fx = join(root, 'recency.db');
    const db = new DatabaseSync(fx);
    db.exec('CREATE TABLE message(session_id TEXT, time_updated INTEGER)');
    db.prepare('INSERT INTO message VALUES(?,?)').run('ses-good', 1700000000);
    db.prepare('INSERT INTO message VALUES(?,?)').run('', 1700000000);
    db.prepare('INSERT INTO message VALUES(?,?)').run('ses-zero', 0);
    db.close();
    const d = await import('../src/discovery.js');
    const recency = await d.readMessageRecency(fx);
    expect(recency['ses-good']).toBe(1700000000000);
    expect('' in recency).toBe(false);
    expect('ses-zero' in recency).toBe(false);
    await safeRm(root); restore();
  });

  it('directory path classifies db-throw with a string code', async () => {
    const { root, restore } = await freshRoot('mesh-disc-dircode-');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'not-a-db'));
    const d = await import('../src/discovery.js');
    const triple = await d.readDbTripleDetailed('ses-x', join(root, 'not-a-db'));
    expect(triple.ok).toBe(false);
    if (!triple.ok && triple.reason === 'db-throw') {
      expect(typeof triple.dbCode).toBe('string');
    } else {
      throw new Error('expected db-throw with evidence');
    }
    await safeRm(root); restore();
  });
});
