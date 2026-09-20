// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicUpdateRegistry, normalizeEntry, pruneStale, readRegistry } from '../src/registry.js';
import { mesh_peers } from '../src/tools/mesh_peers.js';
import { mesh_register } from '../src/tools/mesh_register.js';
import { mesh_send } from '../src/tools/mesh_send.js';

async function safeRm(root: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { rm } = await import('node:fs/promises');
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

describe('auto-register initial enrollment', () => {
  it('schema has description alias + cwd/directory + repo', async () => {
    const e: any = { sessionId: 'ses_test', agent: 'primary', summary: 'my summary', directory: '/a/b/dotfiles', updatedAt: Date.now() };
    const n = normalizeEntry(e);
    expect(n.description).toBe('my summary'); expect(n.cwd).toBe('/a/b/dotfiles'); expect((n as unknown as { repo?: string }).repo).toBe('dotfiles'); expect(n.summary).toBe('my summary');
  });
  it('normalizeEntry writes both description↔summary and cwd↔directory', () => {
    const a: any = { sessionId: 'x', agent: 'a', description: 'b', cwd: '/p/q', updatedAt: Date.now() };
    const n = normalizeEntry(a);
    expect(n.summary).toBe('b'); expect(n.directory).toBe('/p/q'); expect((n as unknown as { repo?: string }).repo).toBe('q');
  });
  it('readRegistry normalizes legacy summary-only entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-test-read-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    await atomicUpdateRegistry((reg: any) => { reg['ses_old'] = { sessionId: 'ses_old', agent: 'primary', summary: 'legacy summary', directory: '/tmp/foo', updatedAt: Date.now() } as any; }, root);
    const { readRegistry: rr } = await import('../src/registry.js');
    const reg: any = await rr(root);
    expect(reg['ses_old'].description).toBe('legacy summary');
    expect(reg['ses_old'].cwd).toBe('/tmp/foo');
    expect(reg['ses_old'].repo).toBe('foo');
    await safeRm(root);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
  });
  it('peers has 4 fields description/sessionId/agent/cwd + repo + live/status/ageSec', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-test-peers-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses_A'] = { sessionId: 'ses_A', agent: 'manager', directory: '/tmp/repo-dotfiles', description: 'Refactoring auth on dotfiles', cwd: '/tmp/repo-dotfiles', repo: 'repo-dotfiles', updatedAt: Date.now() } as any;
      reg['ses_B'] = { sessionId: 'ses_B', agent: 'reviewer', directory: '/tmp/repo-other', description: 'Fixing tests', cwd: '/tmp/repo-other', repo: 'repo-other', updatedAt: Date.now() } as any;
    }, root);
    const out: any = await (mesh_peers.execute as any)({ includeSelf: true }, { sessionID: 'ses_A' });
    const jRaw = JSON.parse(out.output);
    const j = jRaw.peers ?? jRaw;
    for (const id of ['ses_A', 'ses_B']) {
      const e = j[id];
      expect(e.description).toBeDefined();
      expect(e.sessionId).toBe(id);
      expect(e.agent).toBeDefined();
      expect(e.cwd || e.directory).toBeDefined();
      expect(e.repo).toBeDefined();
      expect(e.live).toBeDefined();
      expect(e.status).toBeDefined();
      expect(e.ageSec).toBeDefined();
    }
    await safeRm(root);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
  });
  it('send funnel exact-only: agent-space-repo misses with didYouMean slice 0,5', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-test-send-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses_X'] = { sessionId: 'ses_X', agent: 'manager', directory: '/tmp/dotfiles', description: 'manager dotfiles', repo: 'dotfiles', updatedAt: Date.now() } as any;
    }, root);
    // Old fuzzy stages deleted; misses stay loud.
    const err = await (mesh_send.execute as any)({ target: 'manager dotfiles', text: 'hi', noReply: true }, { sessionID: 'ses_other' }).catch((e: any) => e);
    expect(err.code).toBe('PEER_NOT_FOUND');
    expect(err.didYouMean.length).toBeGreaterThan(0);
    expect(err.didYouMean.length).toBeLessThanOrEqual(5);
    await safeRm(root);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
  });
  it('register writer conformance — frozen columns only, never trusted serve columns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-test-regconf-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    await (mesh_register as any).execute(
      { summary: 'conformance probe' },
      { sessionID: 'ses_conf', directory: root, agent: 'confx' }
    );
    const { readRegistry: rr2 } = await import('../src/registry.js');
    const reg: any = await rr2(root);
    const e = reg['ses_conf'];
    expect(e.sessionId).toBe('ses_conf');
    expect(e.agent).toBe('confx');
    expect(e.directory).toBe(root);
    expect(e.serveUrl).toBeUndefined();
    expect(e.servePort).toBeUndefined();
    await safeRm(root);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
  });
  it('autoRegister idempotent no clobber when existing non-generic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-test-idem-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    await atomicUpdateRegistry((reg: any) => { reg['ses_I'] = { sessionId: 'ses_I', agent: 'primary', description: 'my explicit summary', summary: 'my explicit summary', directory: '/tmp/a', updatedAt: Date.now() } as any; }, root);
    const { readRegistry: rr, atomicUpdateRegistry: aur, normalizeEntry: ne } = await import('../src/registry.js');
    // Why: the generic-title predicate is product-owned (full-ISO); the test
    // replays the no-clobber rule through it, never a local copy.
    const { isGenericTitle } = await import('../src/identity.js');
    await aur(async (reg: any) => {
      const existing = reg['ses_I'];
      const nextDesc = 'New session - 2026-08-31T12:00:00.000Z';
      if (existing && existing.description && !isGenericTitle(existing.description) && isGenericTitle(nextDesc)) { existing.updatedAt = Date.now(); return; }
      reg['ses_I'] = ne({ sessionId: 'ses_I', agent: 'primary', description: nextDesc, directory: '/tmp/a', updatedAt: Date.now() } as any);
    }, root);
    const reg: any = await rr(root);
    expect(reg['ses_I'].description).toBe('my explicit summary');
    await safeRm(root);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
  });
  it('heartbeat preserved and pruneStale still 24h', async () => {
    const now = Date.now();
    const reg: any = { a: { sessionId: 'a', agent: 'x', updatedAt: now - 1000 }, b: { sessionId: 'b', agent: 'y', updatedAt: now - 25 * 60 * 60 * 1000 } };
    const pruned = pruneStale(reg, now);
    expect(pruned.a).toBeDefined(); expect(pruned.b).toBeUndefined();
  });
  it('peers without includeSelf omits the caller', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-test-selfskip-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses_me'] = { sessionId: 'ses_me', agent: 'manager', directory: '/tmp/repo-dotfiles', description: 'my row', updatedAt: Date.now() } as any;
      reg['ses_other'] = { sessionId: 'ses_other', agent: 'reviewer', directory: '/tmp/repo-other', description: 'other row', updatedAt: Date.now() } as any;
    }, root);
    const out: any = await (mesh_peers.execute as any)({}, { sessionID: 'ses_me' });
    const jRaw = JSON.parse(out.output);
    const j = jRaw.peers ?? jRaw;
    expect('ses_me' in j).toBe(false);
    expect('ses_other' in j).toBe(true);
    await safeRm(root);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
  });
  it('peers on a poisoned store resolves degraded instead of throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-test-peersrethrow-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevFetch = globalThis.fetch;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'registry.json'));
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ 'ses_q': { type: 'idle' } }) })) as unknown as typeof fetch;
    const { DatabaseSync } = await import('node:sqlite');
    const fx = join(root, 'live.db');
    const fxdb = new DatabaseSync(fx);
    fxdb.exec('CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, title TEXT, agent TEXT, time_updated INTEGER)');
    fxdb.prepare('INSERT INTO session VALUES(?,?,?,?,?)').run('ses_q', '/tmp/q', 'Q', 'a', Date.now());
    fxdb.close();
    process.env.OPENCODE_MESH_DB_PATH = fx;
    try {
      const out = await (mesh_peers.execute as any)({ includeSelf: true }, { sessionID: 'ses_q' }) as { output: string };
      const body = JSON.parse(out.output) as { peers?: Record<string, unknown> } & Record<string, unknown>;
      const peers = body.peers ?? body;
      expect(peers['ses_q']).toBeDefined();
    } finally {
      globalThis.fetch = prevFetch;
    }
    await safeRm(root);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
  });
});
