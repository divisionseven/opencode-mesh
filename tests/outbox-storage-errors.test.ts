// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
 // SPDX-License-Identifier: MIT
// Outbox storage-error vocabulary behind a fake node:sqlite driver.
// Each variant pins a fail-closed mapping: FULL, CORRUPT, missing driver
// methods, undefined reads, commit failure, migration races.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import * as ob from '../src/outbox.js';

const ctl = vi.hoisted(() => ({
  mode: 'full' as 'full' | 'corrupt' | 'bare-corrupt' | 'no-prepare' | 'undef' | 'no-stmt-fns' | 'commit-throw' | 'rollback-throw' | 'alter-duplicate' | 'alter-bare' | 'alter-other' | 'alter-mid' | 'alter-loop' | 'bare-code' | 'plain-error' | 'has-cols' | 'prepare-throw' | 'prepare-dup',
}));

vi.mock('node:sqlite', () => {
  const fullCols = ['id', 'silent', 'fail_reason', 'sender_build', 'miss_layer', 'miss_reason', 'build'].map((name) => ({ name }));
  const stmt = () => {
    if (ctl.mode === 'no-stmt-fns') return {};
    if (ctl.mode === 'undef')
      return { get: () => undefined, all: () => [], run: () => ({ changes: 0 }) };
    return {
      get: () => [{ name: 'id' }],
      all: () => {
        if (ctl.mode === 'has-cols') return fullCols;
        if (ctl.mode === 'alter-mid') return [{ name: 'id' }, { name: 'silent' }];
        if (ctl.mode === 'alter-loop') return [{ name: 'id' }, { name: 'silent' }, { name: 'fail_reason' }];
        return [{ name: 'id' }];
      },
      run: () => {
        if (ctl.mode === 'full') throw Object.assign(new Error('database is full'), { code: 'SQLITE_FULL' });
        if (ctl.mode === 'corrupt') throw Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' });
        if (ctl.mode === 'bare-corrupt') throw { code: 'SQLITE_CORRUPT' };
        if (ctl.mode === 'bare-code') throw { code: 'SQLITE_FULL' };
        if (ctl.mode === 'plain-error') throw new Error('disk gone');
        return { changes: 0 };
      },
    };
  };
  class FakeDb {
    exec(sql: string): void {
      if (ctl.mode === 'commit-throw' && sql === 'COMMIT') throw new Error('commit failed');
      if (ctl.mode === 'rollback-throw' && (sql === 'COMMIT' || sql === 'ROLLBACK')) throw new Error('txn failed');
      if (ctl.mode === 'alter-duplicate' && sql.startsWith('ALTER TABLE')) throw new Error('duplicate column name: silent');
      if (ctl.mode === 'alter-bare' && sql.startsWith('ALTER TABLE')) throw { code: 'SQLITE_ERROR' };
      if (ctl.mode === 'alter-other' && sql.startsWith('ALTER TABLE')) throw new Error('disk i/o error');
      if (ctl.mode === 'alter-mid' && sql.startsWith('ALTER TABLE')) throw { code: 'SQLITE_ERROR' };
      if (ctl.mode === 'alter-loop' && sql.startsWith('ALTER TABLE')) throw { code: 'SQLITE_ERROR' };
      if (ctl.mode === 'has-cols' && sql.startsWith('ALTER TABLE')) throw new Error('migrated store must not alter');
    }
    close(): void {}
  }
  (FakeDb.prototype as unknown as Record<string, unknown>).prepare = (_sql: string) => {
    if (ctl.mode === 'prepare-throw') throw { code: 'E_IO' };
    if (ctl.mode === 'prepare-dup' && _sql.startsWith('PRAGMA')) throw new Error('duplicate column name: race');
    return stmt();
  };
  // Why: method presence must follow the mode per open, not per import, or
  // the no-prepare leg cannot share the single evaluation with the rest.
  const Shaped = new Proxy(FakeDb, {
    construct(target, args) {
      const inst = new target(...(args as []));
      return new Proxy(inst, {
        get(o, p) {
          if (ctl.mode === 'no-prepare' && (p === 'prepare' || p === 'query')) return undefined;
          const v = (o as unknown as Record<string | symbol, unknown>)[p as string];
          return typeof v === 'function' ? (v as (...a: never[]) => unknown).bind(o) : v;
        },
      });
    },
  });
  return { DatabaseSync: Shaped };
});

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

describe('outbox storage-error vocabulary', () => {
  it('full disk on insert maps to STORAGE_FULL, never silent drop', async () => {
    const { root, restore } = await freshRoot('mesh-ob-full-');
    ctl.mode = 'full';
    await expect(
      ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root)
    ).rejects.toMatchObject({ code: 'STORAGE_FULL' });
    await safeRm(root); restore();
  });

  it('corrupt disk on insert maps to STORAGE_CORRUPT', async () => {
    const { root, restore } = await freshRoot('mesh-ob-corrupt-');
    ctl.mode = 'corrupt';
    await expect(
      ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root)
    ).rejects.toMatchObject({ code: 'STORAGE_CORRUPT' });
    await safeRm(root); restore();
  });

  it('messageless corrupt failure still maps by code', async () => {
    const { root, restore } = await freshRoot('mesh-ob-barecorrupt-');
    ctl.mode = 'bare-corrupt';
    await expect(
      ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root)
    ).rejects.toMatchObject({ code: 'STORAGE_CORRUPT' });
    await safeRm(root); restore();
  });

  it('driver without prepare or query maps open to STORAGE_UNAVAILABLE', async () => {
    const { root, restore } = await freshRoot('mesh-ob-noprepare-');
    ctl.mode = 'no-prepare';
    await expect(
      ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root)
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await safeRm(root); restore();
  });

  it('undefined reads map to empty: pending 0, collect zeros', async () => {
    const { root, restore } = await freshRoot('mesh-ob-undef-');
    ctl.mode = 'undef';
    expect(await ob.pendingCount(['ses-T'], root)).toBe(0);
    expect(await ob.collectOutbox(Date.now(), 1000, 1, root)).toEqual({ deleted: 0, deadLetter: 0 });
    await safeRm(root); restore();
  });

  it('statement without methods degrades: enqueue returns id, claim reads empty', async () => {
    const { root, restore } = await freshRoot('mesh-ob-nofns-');
    ctl.mode = 'no-stmt-fns';
    const id = await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    expect(id.startsWith('msg_')).toBe(true);
    expect(await ob.claim(['ses-T'], 'owner-1', 1, root)).toEqual([]);
    await safeRm(root); restore();
  });

  it('commit failure releases the claim without throwing', async () => {
    const { root, restore } = await freshRoot('mesh-ob-commit-');
    ctl.mode = 'commit-throw';
    expect(await ob.claim(['ses-T'], 'owner-1', 1, root)).toEqual([]);
    await safeRm(root); restore();
  });

  it('commit plus rollback failure still releases without throwing', async () => {
    const { root, restore } = await freshRoot('mesh-ob-rollback-');
    ctl.mode = 'rollback-throw';
    expect(await ob.claim(['ses-T'], 'owner-1', 1, root)).toEqual([]);
    await safeRm(root); restore();
  });

  it('lost migration race on duplicate columns still opens', async () => {
    const { root, restore } = await freshRoot('mesh-ob-alterrace-');
    ctl.mode = 'alter-duplicate';
    const id = await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    expect(id.startsWith('msg_')).toBe(true);
    await safeRm(root); restore();
  });

  it('messageless alter race surfaces instead of swallowing', async () => {
    const { root, restore } = await freshRoot('mesh-ob-alterbare-');
    ctl.mode = 'alter-bare';
    await expect(
      ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root)
    ).rejects.toMatchObject({ code: 'SQLITE_ERROR' });
    await safeRm(root); restore();
  });

  it('migration failure beyond duplicate columns surfaces', async () => {
    const { root, restore } = await freshRoot('mesh-ob-alterother-');
    ctl.mode = 'alter-other';
    await expect(
      ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root)
    ).rejects.toThrow('disk i/o error');
    await safeRm(root); restore();
  });

  it('codeless insert failure propagates verbatim', async () => {
    const { root, restore } = await freshRoot('mesh-ob-plainerror-');
    ctl.mode = 'plain-error';
    await expect(
      ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root)
    ).rejects.toThrow('disk gone');
    await safeRm(root); restore();
  });

  it('messageless code failure still maps by code', async () => {
    const { root, restore } = await freshRoot('mesh-ob-barecode-');
    ctl.mode = 'bare-code';
    await expect(
      ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root)
    ).rejects.toMatchObject({ code: 'STORAGE_FULL' });
    await safeRm(root); restore();
  });

  it('migrated store opens without altering', async () => {
    const { root, restore } = await freshRoot('mesh-ob-hascols-');
    ctl.mode = 'has-cols';
    const id = await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    expect(id.startsWith('msg_')).toBe(true);
    await safeRm(root); restore();
  });

  it('prepare failure surfaces from open', async () => {
    const { root, restore } = await freshRoot('mesh-ob-preparethrow-');
    ctl.mode = 'prepare-throw';
    await expect(
      ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root)
    ).rejects.toThrow();
    await safeRm(root); restore();
  });

  it('mid-migration messageless failure surfaces', async () => {
    const { root, restore } = await freshRoot('mesh-ob-altermid-');
    ctl.mode = 'alter-mid';
    await expect(
      ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root)
    ).rejects.toMatchObject({ code: 'SQLITE_ERROR' });
    await safeRm(root); restore();
  });

  it('loop-migration messageless failure surfaces', async () => {
    const { root, restore } = await freshRoot('mesh-ob-alterloop-');
    ctl.mode = 'alter-loop';
    await expect(
      ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root)
    ).rejects.toMatchObject({ code: 'SQLITE_ERROR' });
    await safeRm(root); restore();
  });

  it('prepare racing migration still opens', async () => {
    const { root, restore } = await freshRoot('mesh-ob-preparedup-');
    ctl.mode = 'prepare-dup';
    const id = await ob.enqueue({ target_session: 'ses-T', from_session: 'ses-F', from_agent: 'a', text: 'hi' }, root);
    expect(id.startsWith('msg_')).toBe(true);
    await safeRm(root); restore();
  });
});
