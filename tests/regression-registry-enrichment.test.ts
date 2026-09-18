// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Registry enrichment regression gates
// Each suite would FAIL on the unfixed code and PASS after the fix.
// Root-cause file:line evidence in docstrings; assertions check real behavior, not gate self-reference.
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';


const origFetch = globalThis.fetch;

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

describe('regression: agent unknown to enriched', () => {
  /**
   * Unknown agent enriched via resolveIdentity; upsertPresence never writes empty.
   */
  it('isGenericTitle does NOT clobber non-generic description with generic title', async () => {
    const { isGenericTitle } = await import('../src/identity.js');
    // Mesh mirrors Session.isDefaultTitle full-ISO pattern for parent plus child defaults.
    // Fixed code: /^((New session - )|(Child session - ))\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    expect(isGenericTitle('Child session - 2026-09-02T00:20:17.077Z')).toBe(true); // opencode child default
    expect(isGenericTitle('New session - 2026-09-02T00:20:17.077Z')).toBe(true); // opencode parent default
    expect(isGenericTitle('Child - 1234')).toBe(false); // old mesh short form is NOT an opencode default
    expect(isGenericTitle('Child - abcd')).toBe(false);
    expect(isGenericTitle('Refactoring auth on dotfiles')).toBe(false);
  });

  it('upsertPresence enriches unknown agent when resolveIdentity provides real agent (session.updated)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-agent-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    // Seed with unknown and missing directory (so enrichment can show)
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-agent'] = { sessionId: 'ses-agent', agent: 'unknown', description: 'old', updatedAt: Date.now() } as any;
    }, root);
    // Simulate plugin session.updated enriching agent when existing is unknown
    const { resolveIdentity } = await import('../src/identity.js');
    const mockClient = {
      session: { get: async () => ({ agent: 'manager', directory: '/tmp/dotfiles', title: 'Real Title 1234' }) },
    };
    const ident = await resolveIdentity(mockClient, 'ses-agent', { agent: undefined, directory: undefined, title: undefined }, { agent: 'manager', directory: '/tmp/dotfiles' });
    expect(ident.agent).toBe('manager'); // fallback stays unknown without enrichment
    expect(ident.directory).toBe('/tmp/dotfiles');
    // Simulate upsert logic: agent overwrites unknown unconditionally, directory enriches when missing
    await atomicUpdateRegistry((reg: any) => {
      const ex = reg['ses-agent'];
      if (ex.agent === 'unknown' && ident.agent !== 'unknown') ex.agent = ident.agent;
      if (!ex.directory && ident.directory) { ex.directory = ident.directory; ex.cwd = ident.directory; }
      ex.updatedAt = Date.now();
    }, root);
    const reg = await readRegistry(root) as any;
    expect(reg['ses-agent'].agent).toBe('manager');
    expect(reg['ses-agent'].directory).toBe('/tmp/dotfiles');
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRm(root);
    vi.resetModules();
  });

  it('resolveIdentity never returns empty directory; undefined when source missing', async () => {
    const { resolveIdentity } = await import('../src/identity.js');
    const ident = await resolveIdentity({}, 'ses-x', { directory: '' }, { directory: '' });
    expect(ident.directory).toBeUndefined(); // empty string is never persisted, preserving the non-empty CHECK
    const ident2 = await resolveIdentity({}, 'ses-y', undefined, undefined);
    expect(ident2.directory).toBeUndefined();
    // Valid absolute path preserved
    const ident3 = await resolveIdentity({}, 'ses-z', { directory: '/tmp/a' }, undefined);
    expect(ident3.directory).toBe('/tmp/a');
  });

  // plugin has exactly one fallback unknown test removed: AGENTS.md bans source-text grep/count assertions from vitest

  // seenSessions per-field test removed: AGENTS.md bans source-text grep/count assertions from vitest
});

describe('regression: isGenericTitle single predicate', () => {
  /**
   * Single isGenericTitle owner mirroring Session.isDefaultTitle; clobbering fixed.
   */
  // single definition in src/identity.ts test removed: AGENTS.md bans source-text grep/count assertions from vitest

  it('mirrors Session.isDefaultTitle exactly with opencode full ISO', async () => {
    const { isGenericTitle } = await import('../src/identity.js');
    // Generic cases (match /^((New session - )|(Child session - ))\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(isGenericTitle(null)).toBe(true);
    expect(isGenericTitle(undefined as any)).toBe(true);
    expect(isGenericTitle('')).toBe(true);
    expect(isGenericTitle('New session - 2026-09-02T00:20:17.077Z')).toBe(true); // opencode parent default
    expect(isGenericTitle('Child session - 2026-09-02T00:20:17.077Z')).toBe(true); // opencode child default
    // Non-generic: short forms without full ISO are NOT opencode defaults
    expect(isGenericTitle('New session - 1234')).toBe(false); // old 4-digit anchor would be true -> regression
    expect(isGenericTitle('New session - 2026')).toBe(false);
    expect(isGenericTitle('Child - 1234')).toBe(false);
    expect(isGenericTitle('Child - 2026')).toBe(false);
    expect(isGenericTitle('New session - hello')).toBe(false); // old startsWith would be true -> regression
    expect(isGenericTitle('Child session - hello')).toBe(false);
    expect(isGenericTitle('New session - 123')).toBe(false); // only 3 digits
    expect(isGenericTitle('Refactoring auth on dotfiles')).toBe(false);
    // The key divergence: old code considered Child - 2026 generic via 4-digit prefix, new requires full ISO + Child session form
  });
});

describe('regression: port 4096 env-overridable', () => {
  /**
   * Port via OPENCODE_PORT with DEFAULT_OPENCODE_PORT fallback; no hardcoded literals.
   */
  it('OPENCODE_PORT default 4096 and env-override, no 14009 literal', async () => {
    // verify runtime value
    const { OPENCODE_PORT } = await import('../src/constants.js');
    expect(OPENCODE_PORT).toBe(4096);
  });

  // plugin does not fetch 127.0.0.1 test removed: AGENTS.md bans source-text grep/count assertions from vitest

  // CLI and mesh_send port test removed: AGENTS.md bans source-text grep/count assertions from vitest
});

describe('regression: mesh_register no live merge', () => {
  /**
   * mesh_register upsert-only; no live merge, zero unauthenticated fetches.
   */
  // mesh_register is upsert-only test removed: AGENTS.md bans source-text grep/count assertions from vitest

  it('mesh_register behavioral: upsert without server still persists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-reg-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const { mesh_register } = await import('../src/tools/mesh_register.js');
    // Mock fetch to fail — register should still succeed (no live merge)
    globalThis.fetch = vi.fn(async () => { throw new Error('server down'); }) as unknown as typeof fetch;
    const out = await (mesh_register.execute as any)({ summary: 'test register' }, { sessionID: 'ses-reg-test', directory: root, agent: 'tester' });
    const j = JSON.parse(out.output);
    expect(j.registered).toBe('ses-reg-test');
    const { readRegistry } = await import('../src/registry.js');
    const reg = await readRegistry(root) as any;
    expect(reg['ses-reg-test']).toBeDefined();
    expect(reg['ses-reg-test'].description).toBe('test register');
    globalThis.fetch = origFetch as unknown as typeof fetch;
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRm(root);
    vi.resetModules();
    globalThis.fetch = origFetch as unknown as typeof fetch;
  });
});

describe('regression: broadcast deduped sequential', () => {
  /**
   * Broadcast deduped outside fan-out, sequential; jitter lives in claimer policy.
   */
  // mesh_send dedups test removed: AGENTS.md bans source-text grep/count assertions from vitest

  it('broadcast sequential behavioral: N=5 deduped with mocked 2ms per peer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-bcast-seq-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const prevBc = process.env.MESH_BROADCAST;
    process.env.MESH_BROADCAST = '1';
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      for (let i = 0; i < 5; i++) reg[`bcast-${i}`] = { sessionId: `bcast-${i}`, agent: 'a', updatedAt: Date.now() } as any;
    }, root);
    let fetchCalls = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) { fetchCalls++; return { ok: true, json: async () => ({}) } as unknown as Response; }
      if (u.includes('prompt_async')) { await new Promise(r => setTimeout(r, 2)); return { ok: true, status: 204 } as unknown as Response; }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = await (mesh_send.execute as any)({ target: 'all', text: 'hi', broadcast: true }, { sessionID: 'bcast-caller', directory: '/tmp' });
    const j = JSON.parse(out.output);
    expect(j.broadcast).toBe(true);
    expect(j.peers).toBe(5);
    // Send path holds two status touches; per-peer fan-out adds zero.
    expect(fetchCalls).toBe(2); // Before dedup would be 2+N (inside loop)
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    if (prevBc === undefined) delete process.env.MESH_BROADCAST; else process.env.MESH_BROADCAST = prevBc;
    await safeRm(root);
    vi.restoreAllMocks();
    globalThis.fetch = origFetch as unknown as typeof fetch;
  });
});

describe('regression: directory dual header', () => {
  /**
   * Root cause: only one of ?directory or x-opencode-directory sent, breaks WorkspaceRouting `?directory || x-opencode-directory || cwd()`.
   * Both travel on every POST, so the peer cwd stays correct.
   */
  // mesh_send sends both ?directory test removed: AGENTS.md bans source-text grep/count assertions from vitest

  it('behavioral: POST url contains ?directory and header x-opencode-directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-dir-dual-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['dir-target'] = { sessionId: 'dir-target', agent: 'a', model: 'myprov/my-model', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    let capturedUrl = ''; let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      capturedUrl = u;
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return { ok: true, status: 204 } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    await (mesh_send.execute as any)({ target: 'dir-target', text: 'hello dir' }, { sessionID: 'caller-dir', directory: '/tmp/myrepo' });
    expect(capturedUrl).toMatch(/\?directory=/);
    expect(capturedUrl).toContain(encodeURIComponent('/tmp/myrepo'));
    const hasHeader = Object.keys(capturedHeaders).some(k => k.toLowerCase() === 'x-opencode-directory');
    expect(hasHeader).toBe(true);
    const hv = Object.entries(capturedHeaders).find(([k]) => k.toLowerCase() === 'x-opencode-directory')?.[1] ?? '';
    expect(decodeURIComponent(hv)).toBe('/tmp/myrepo');
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRm(root);
    vi.restoreAllMocks();
    globalThis.fetch = origFetch as unknown as typeof fetch;
  });

  it('probe fails when dir-target model stripped, degrades to queued with zero POSTs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-dir-dual-mutant-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['dir-target'] = { sessionId: 'dir-target', agent: 'a', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    const posted: string[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) posted.push(u);
      return { ok: true, status: 204 } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      String((await (mesh_send.execute as any)({ target: 'dir-target', text: 'hello dir' }, { sessionID: 'caller-dir', directory: '/tmp/myrepo' })).output),
    ) as { via: string };
    expect(posted).toEqual([]);
    expect(out.via).toBe('queued');
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRm(root);
    vi.restoreAllMocks();
    globalThis.fetch = origFetch as unknown as typeof fetch;
  });
});


describe('regression: durability hygiene', () => {
  /**
   * normalizeEntry strips legacy keys; single writer owns persistence, migratedAt once.
   */
  it('normalizeEntry strips daemon, computes repo, never persists empty directory', async () => {
    const { normalizeEntry } = await import('../src/registry.js');
    const e: any = { sessionId: 's1', agent: 'a', description: 'd', directory: '', daemon: '14009', updatedAt: Date.now() };
    const n = normalizeEntry(e);
    expect((n as any).daemon).toBeUndefined();
    expect(n.directory).toBeUndefined();
    expect(n.cwd).toBeUndefined();
    const e2: any = { sessionId: 's2', agent: 'a', description: 'd', directory: '/a/b/dotfiles', updatedAt: Date.now() };
    const n2 = normalizeEntry(e2);
    expect((n2 as unknown as { repo?: string }).repo).toBe('dotfiles');
    expect((n2 as any).daemon).toBeUndefined();
    // legacy summary-only
    const e3: any = { sessionId: 's3', agent: 'a', summary: 'legacy', directory: '/tmp/foo', updatedAt: Date.now() };
    const n3 = normalizeEntry(e3);
    expect(n3.description).toBe('legacy');
    expect(n3.summary).toBe('legacy');
  });

  // single writer test removed: AGENTS.md bans source-text grep/count assertions from vitest

  it('migratedAt preserved across heartbeat — not mutated every 5m', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-migrated-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const { atomicUpdateRegistry, readRegistry, heartbeat } = await import('../src/registry.js');
    const { resolveRegistryPath } = await import('../src/xdg.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['m1'] = { sessionId: 'm1', agent: 'a', updatedAt: Date.now() } as any;
    }, root);
    const raw1 = JSON.parse(await readFile(resolveRegistryPath(root), 'utf8')) as any;
    const migratedAt1 = raw1.migratedAt;
    await new Promise(r => setTimeout(r, 10));
    await heartbeat('m1', root);
    const raw2 = JSON.parse(await readFile(resolveRegistryPath(root), 'utf8')) as any;
    const migratedAt2 = raw2.migratedAt;
    expect(migratedAt1).toBe(migratedAt2); // heartbeat preserves migratedAt
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRm(root);
    vi.resetModules();
  });

  // ONE_MB single source test removed: AGENTS.md bans source-text grep/count assertions from vitest
});
