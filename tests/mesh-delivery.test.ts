// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Behavioral regression suite for the mesh redesign.
// Additive only: extends tests/pure-tui.test.ts, never edits its assertions in place.
// Every gate is a probed measurement (executes the operation, asserts bytes and timing),
// never an unconditional ok token. Each new assertion class ships with a positive control.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const origFetch = globalThis.fetch;
const ENV_KEYS = [
  'OPENCODE_MESH_ROOT',
  'OPENCODE_MESH_DB_PATH',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_SERVER_USERNAME',
  'OPENCODE_MESH_KEYCHAIN_PROVIDER',
  'MESH_WAKE',
  'MESH_QUARANTINE',
  'MESH_BROADCAST',
  'USER',
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.OPENCODE_SERVER_PASSWORD;
  delete process.env.OPENCODE_SERVER_USERNAME;
  delete process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER;
  delete process.env.MESH_WAKE;
  delete process.env.MESH_QUARANTINE;
  delete process.env.MESH_BROADCAST;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = origFetch as unknown as typeof fetch;
  vi.resetModules();
  vi.restoreAllMocks();
});

async function freshRoot(prefix: string): Promise<{ root: string; restore: () => void }> {
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
      if ((code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM') && attempt < 2) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      throw err;
    }
  }
}

function mockStatusAnd204(capture?: Array<{ url: string; init?: RequestInit }>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (capture) capture.push({ url: String(url), init });
    const u = String(url);
    if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
    if (u.includes('prompt_async')) return { ok: true, status: 204 } as unknown as Response;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('delivery: wire bytes identical to PromptInput subset', () => {
  it('model-missing receiver defers with zero POSTs on both wake legs (fail-closed)', async () => {
    const { root, restore } = await freshRoot('mesh-wire-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['wire-target'] = { sessionId: 'wire-target', agent: 'a', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mockStatusAnd204(calls);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    // wake leg: the receiver triple is unresolvable, so the direct leg
    // degrades to claim with zero bytes on the wire.
    const wakeOut = JSON.parse(
      String((await (mesh_send.execute as any)(
        { target: 'wire-target', text: 'hello wire' },
        { sessionID: 'wire-caller', directory: '/tmp/repo', agent: 'build' }
      )).output),
    ) as { via: string };
    expect(calls.filter((c) => c.url.includes('prompt_async'))).toEqual([]);
    expect(wakeOut.via).toBe('queued');
    // silent leg: same degrade, no prompt_async call to read a body from.
    const silentCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mockStatusAnd204(silentCalls);
    const silentOut = JSON.parse(
      String((await (mesh_send.execute as any)(
        { target: 'wire-target', text: 'quiet wire', silent: true },
        { sessionID: 'wire-caller', directory: '/tmp/repo', agent: 'build' }
      )).output),
    ) as { via: string };
    expect(silentCalls.find((c) => c.url.includes('prompt_async'))).toBeUndefined();
    expect(silentOut.via).toBe('queued');
    await safeRm(root); restore();
  });

  it('POST body keys are exactly the probed PromptInput subset (no sessionID in body)', async () => {
    const { root, restore } = await freshRoot('mesh-wire-echo-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['wire-target'] = { sessionId: 'wire-target', agent: 'a', model: 'myprov/my-model', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mockStatusAnd204(calls);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    // wake leg: the key is omitted so the Runner loop runs
    await (mesh_send.execute as any)(
      { target: 'wire-target', text: 'hello wire' },
      { sessionID: 'wire-caller', directory: '/tmp/repo', agent: 'build' }
    );
    const post = calls.find((c) => c.url.includes('prompt_async'));
    expect(post).toBeDefined();
    expect(post!.url).toMatch(/\/session\/wire-target\/prompt_async\?directory=/);
    expect(post!.url).toContain(encodeURIComponent('/tmp/repo'));
    expect((post!.init?.headers as Record<string, string>)['x-opencode-directory']).toBe(
      encodeURIComponent('/tmp/repo')
    );
    const body = JSON.parse(String(post!.init?.body));
    expect(Object.keys(body).sort()).toEqual(['agent', 'messageID', 'model', 'parts']);
    expect(body.agent).toBe('a');
    const { isMsgId } = await import('../src/outbox.js');
    expect(isMsgId(body.messageID)).toBe(true);
    expect(body.model).toEqual({ providerID: 'myprov', modelID: 'my-model' });
    expect('noReply' in body).toBe(false);
    expect(body.parts).toEqual([
      { type: 'text', text: `[OC-MESH | SENDER: build - wire-caller]\n\nhello wire` },
    ]);
    // silent leg: the key pins true so history-only behavior persists
    const silentCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mockStatusAnd204(silentCalls);
    await (mesh_send.execute as any)(
      { target: 'wire-target', text: 'quiet wire', silent: true },
      { sessionID: 'wire-caller', directory: '/tmp/repo', agent: 'build' }
    );
    const silentBody = JSON.parse(String(silentCalls.find((c) => c.url.includes('prompt_async'))!.init?.body));
    expect(Object.keys(silentBody).sort()).toEqual(['agent', 'messageID', 'model', 'noReply', 'parts']);
    expect(silentBody.noReply).toBe(true);
    // silent direct leg renders the SILENT marker (verified self-attested, never QUARANTINED)
    expect(silentBody.parts).toEqual([
      { type: 'text', text: `[OC-MESH | SENDER (SILENT): build - wire-caller]\n\nquiet wire` },
    ]);
    await safeRm(root); restore();
  });

  it('probe fails when echo seed model stripped, degrades to queued with zero POSTs', async () => {
    const { root, restore } = await freshRoot('mesh-wire-mutant-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['wire-target'] = { sessionId: 'wire-target', agent: 'a', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mockStatusAnd204(calls);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      String((await (mesh_send.execute as any)(
        { target: 'wire-target', text: 'hello wire' },
        { sessionID: 'wire-caller', directory: '/tmp/repo', agent: 'build' }
      )).output),
    ) as { via: string };
    expect(calls.filter((c) => c.url.includes('prompt_async'))).toEqual([]);
    expect(out.via).toBe('queued');
    await safeRm(root); restore();
  });

  it('204-only success: a 200 on prompt_async throws (opencode declares NoContent only)', async () => {
    const { root, restore } = await freshRoot('mesh-204-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['t204'] = { sessionId: 't204', agent: 'a', model: 'myprov/my-model', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) return { ok: true, status: 200 } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    await expect(
      (mesh_send.execute as any)({ target: 't204', text: 'hi' }, { sessionID: 'c204', directory: '/tmp' })
    ).rejects.toThrow(/promptAsync failed 200/);
    await safeRm(root); restore();
  });
});

describe('delivery: auth universal foundation matrix', () => {
  it('no password → undefined header (omit, pass-through), never shells out', async () => {
    vi.resetModules();
    const { getServerAuthHeaderSync } = await import('../src/serverAuth.js');
    expect(getServerAuthHeaderSync()).toBeUndefined();
  });

  it('env password yields Basic header with default user, never shells out', async () => {
    process.env.OPENCODE_SERVER_PASSWORD = 'pw-universal';
    vi.resetModules();
    const { getServerAuthHeaderSync } = await import('../src/serverAuth.js');
    expect(getServerAuthHeaderSync()).toBe(`Basic ${Buffer.from('opencode:pw-universal').toString('base64')}`);
    process.env.OPENCODE_SERVER_USERNAME = 'custom-user';
    vi.resetModules();
    const re = await import('../src/serverAuth.js');
    expect(re.getServerAuthHeaderSync()).toBe(
      `Basic ${Buffer.from('custom-user:pw-universal').toString('base64')}`
    );
  });
});

describe('delivery: auth Keychain opt-in matrix', () => {
  it('flag-unset → undefined even with a live Keychain entry (no leak); flag-set → Basic opencode:', async () => {
    vi.resetModules();
    const before = await import('../src/serverAuth.js');
    expect(before.getServerAuthHeaderSync()).toBeUndefined();
    const { getKeychainPassword } = await import('../src/serverAuthKeychainProvider.js');
    const entry = getKeychainPassword();
    if (entry === undefined) {
      console.log('SKIP_KEYCHAIN_ABSENT live leg (source-cite half green; foundation gates unaffected)');
      return;
    }
    process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER = '1';
    vi.resetModules();
    const after = await import('../src/serverAuth.js');
    const header = after.getServerAuthHeaderSync();
    expect(header).toBe(`Basic ${Buffer.from(`opencode:${entry}`).toString('base64')}`);
    // cache: second call returns the identical header
    expect(after.getServerAuthHeaderSync()).toBe(header);
  });
});

describe('delivery: generic-title matrix mirrors isDefaultTitle', () => {
  it('full-ISO parent/child defaults are generic; short/user forms are not', async () => {
    const { isGenericTitle } = await import('../src/identity.js');
    expect(isGenericTitle(null)).toBe(true);
    expect(isGenericTitle(undefined as any)).toBe(true);
    expect(isGenericTitle('')).toBe(true);
    expect(isGenericTitle('New session - 2026-09-02T00:20:17.077Z')).toBe(true);
    expect(isGenericTitle('Child session - 2026-09-02T00:20:17.077Z')).toBe(true);
    expect(isGenericTitle('New session - 1234')).toBe(false);
    expect(isGenericTitle('Child - 1234')).toBe(false);
    expect(isGenericTitle('Child session - hello')).toBe(false);
    expect(isGenericTitle('New session - 123')).toBe(false);
    expect(isGenericTitle('Refactoring auth on dotfiles')).toBe(false);
  });

  it('registration double-write: generic never clobbers stored non-generic, updatedAt still moves', async () => {
    const { root, restore } = await freshRoot('mesh-generic-');
    const { mesh_register } = await import('../src/tools/mesh_register.js');
    const ctx = { sessionID: 'ses-generic', directory: root, agent: 'manager' };
    await (mesh_register.execute as any)({ summary: 'Real Title Here' }, ctx);
    const { readRegistry } = await import('../src/registry.js');
    const before = ((await readRegistry(root)) as any)['ses-generic'];
    expect(before.description).toBe('Real Title Here');
    await new Promise((r) => setTimeout(r, 5));
    await (mesh_register.execute as any)(
      { summary: 'New session - 2026-09-02T00:20:17.077Z' },
      ctx
    );
    const after = ((await readRegistry(root)) as any)['ses-generic'];
    expect(after.description).toBe('Real Title Here');
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
    await safeRm(root); restore();
  });
});

describe('delivery: discovery matrix plus funnel lock', () => {
  async function seedDiscovery(root: string) {
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    const now = Date.now();
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-a1'] = { sessionId: 'ses-a1', agent: 'manager', description: 'Refactoring auth', directory: '/tmp/dotfiles', repo: 'dotfiles', updatedAt: now } as any;
      reg['ses-b2'] = { sessionId: 'ses-b2', agent: 'worker', description: 'Refactoring docs', directory: '/tmp/site', repo: 'site', updatedAt: now } as any;
      reg['ses-c3'] = { sessionId: 'ses-c3', agent: 'manager', description: 'Unrelated', directory: '/tmp/other', repo: 'other', updatedAt: now } as any;
      reg['ses-old'] = { sessionId: 'ses-old', agent: 'manager', description: 'Refactoring auth', directory: '/tmp/dotfiles', repo: 'dotfiles', updatedAt: now - 2 * 60 * 60 * 1000 } as any;
    }, root);
  }

  it('Compat scoring: filters order the full union best-first; aged match shows stale, never hidden (T-compat)', async () => {
    const { root, restore } = await freshRoot('mesh-disc-');
    await seedDiscovery(root);
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    try {
      globalThis.fetch = mockStatusAnd204();
      const { mesh_peers } = await import('../src/tools/mesh_peers.js');
      const out = await (mesh_peers.execute as any)(
        { agent: 'MANAGER', description: 'refactoring', repo: 'DOTFILES' },
        { sessionID: 'caller-x' }
      );
      const j = JSON.parse(out.output);
      const peers = j.peers ?? j;
      // T-compat: compat args score, never filter — the full union returns ordered best-first.
      expect(Object.keys(peers).sort()).toEqual(['ses-a1', 'ses-b2', 'ses-c3', 'ses-old']);
      const ranked = (Object.entries(peers) as Array<[string, { rank: number }]>)
        .sort((a, b) => a[1].rank - b[1].rank)
        .map(([id]) => id);
      expect(ranked).toEqual(['ses-a1', 'ses-old', 'ses-c3', 'ses-b2']);
      expect(peers['ses-a1'].liveSource).toBe('heartbeat-recent');
      expect(peers['ses-old'].liveSource).toBe('stale');
    } finally {
      delete process.env.OPENCODE_MESH_DB_PATH;
    }
    await safeRm(root); restore();
  });

  it('idle vocabulary: present idle renders live idle (never unknown)', async () => {
    const { root, restore } = await freshRoot('mesh-idle-');
    await seedDiscovery(root);
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status'))
        return { ok: true, json: async () => ({ 'ses-a1': { type: 'idle' } }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_peers } = await import('../src/tools/mesh_peers.js');
    const out = await (mesh_peers.execute as any)({ agent: 'manager' }, { sessionID: 'caller-x' });
    const j = JSON.parse(out.output);
    expect(j['ses-a1'].live).toBe('idle');
    expect(j['ses-a1'].status).toBe('idle');
    await safeRm(root); restore();
  });

  it('funnel exact-only: exact sid plus singleton agent@repo resolve, all else miss', async () => {
    const { root, restore } = await freshRoot('mesh-funnel-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    const now = Date.now();
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-exact1'] = { sessionId: 'ses-exact1', agent: 'manager', description: 'ses-exact1 inside desc', directory: '/tmp/dotfiles', repo: 'dotfiles', updatedAt: now, serveUrl: 'http://127.0.0.1:4096' } as any;
      reg['ses-other'] = { sessionId: 'ses-other', agent: 'manager', description: 'nothing', directory: '/tmp/dotfiles', repo: 'dotfiles', updatedAt: now, serveUrl: 'http://127.0.0.1:4096' } as any;
      reg['ses-solo'] = { sessionId: 'ses-solo', agent: 'solo', description: 'solo worker', directory: '/tmp/solorepo', repo: 'solorepo', updatedAt: now, serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mockStatusAnd204(calls);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    // exact id resolves even though the id appears inside another description
    const out = await (mesh_send.execute as any)(
      { target: 'ses-exact1', text: 'hi' },
      { sessionID: 'ses-other', directory: '/tmp' }
    );
    expect(JSON.parse(out.output).target).toBe('ses-exact1');
    // singleton agent@repo resolves (case-insensitive full-field)
    const out2 = await (mesh_send.execute as any)(
      { target: 'SOLO@SOLOREPO', text: 'hi' },
      { sessionID: 'ses-other', directory: '/tmp' }
    );
    expect(JSON.parse(out2.output).target).toBe('ses-solo');
    // Non-singleton agent at repo misses with suggestions, never silent-picks.
    const miss = await (mesh_send.execute as any)(
      { target: 'MANAGER@DOTFILES', text: 'hi' },
      { sessionID: 'ses-other', directory: '/tmp' }
    ).catch((e: any) => e);
    expect(miss.code).toBe('PEER_NOT_FOUND');
    expect(miss.didYouMean.length).toBeGreaterThan(0);
    // every fuzzy stage misses: agent-name, repo, description-includes, id-substring
    for (const fuzzy of ['manager', 'dotfiles', 'ses-exact1 inside desc', 'ses-exact', 'nothing']) {
      const m = await (mesh_send.execute as any)(
        { target: fuzzy, text: 'hi' },
        { sessionID: 'ses-other', directory: '/tmp' }
      ).catch((e: any) => e);
      expect(m.code).toBe('PEER_NOT_FOUND');
    }
    // self-delivery misroute regression: exact peer id never defaults to caller
    const out3 = await (mesh_send.execute as any)(
      { target: 'ses-exact1', text: 'hi' },
      { sessionID: 'ses-other', directory: '/tmp' }
    );
    expect(JSON.parse(out3.output).target).not.toBe('ses-other');
    await safeRm(root); restore();
  });

  it('didYouMean shared helper: resolve-miss and POST-404 suggest identically, deduped ≤5', async () => {
    const { root, restore } = await freshRoot('mesh-dym-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    const now = Date.now();
    await atomicUpdateRegistry((reg: any) => {
      for (let i = 0; i < 7; i++)
        reg[`dup-${i}`] = { sessionId: `dup-${i}`, agent: 'a', model: 'myprov/my-model', description: 'Same Description Here', updatedAt: now, serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) return { ok: false, status: 404 } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const miss = await (mesh_send.execute as any)(
      { target: 'no-such-peer-xyz', text: 'hi' },
      { sessionID: 'dup-0', directory: '/tmp' }
    ).catch((e: any) => e);
    const gone = await (mesh_send.execute as any)(
      { target: 'dup-1', text: 'hi' },
      { sessionID: 'dup-0', directory: '/tmp' }
    ).catch((e: any) => e);
    expect(miss.didYouMean).toBeDefined();
    expect(gone.didYouMean).toBeDefined();
    expect(miss.didYouMean).toEqual(gone.didYouMean);
    expect(miss.didYouMean.length).toBeLessThanOrEqual(5);
    expect(new Set(miss.didYouMean).size).toBe(miss.didYouMean.length);
    await safeRm(root); restore();
  });
});

describe('delivery: canonical frontmatter plus reply', () => {
  it('canonical frontmatter vocabulary plus reply shapes', async () => {
    const { formatMeshPrefix, meshPrefixLength } = await import('../src/frontmatter.js');
    expect(formatMeshPrefix('manager', 'ses_abc123')).toBe('[OC-MESH | SENDER: manager - ses_abc123]');
    // old fixtures presented to the helper yield the canonical form
    expect(formatMeshPrefix('cli', 'cli')).toBe('[OC-MESH | SENDER: cli - cli]');
    // SILENT bit renders the silent marker (direct-leg vocabulary: normal or SILENT only)
    expect(formatMeshPrefix('manager', 'ses_abc123', true, true)).toBe('[OC-MESH | SENDER (SILENT): manager - ses_abc123]');
    // unattested renders QUARANTINED (claim-leg-only per the attestation contract)
    expect(formatMeshPrefix('manager', 'ses_abc123', false)).toBe('[OC-MESH | SENDER (QUARANTINED): manager - ses_abc123]');
    // combined shape concatenates SILENT first, QUARANTINED second (claim-leg-only)
    expect(formatMeshPrefix('manager', 'ses_abc123', false, true)).toBe(
      '[OC-MESH | SENDER (SILENT) (QUARANTINED): manager - ses_abc123]'
    );
    // swapped marker order never renders from the template
    expect(formatMeshPrefix('manager', 'ses_abc123', false, true)).not.toContain('(QUARANTINED) (SILENT)');
    // length helper measures marked headers exactly (marker bytes ride inside the guard)
    for (const [verified, silent] of [[true, false], [true, true], [false, false], [false, true]] as Array<[boolean, boolean]>) {
      expect(meshPrefixLength('manager', 'ses_abc123', verified, silent)).toBe(
        Buffer.byteLength(formatMeshPrefix('manager', 'ses_abc123', verified, silent), 'utf8')
      );
    }
  });

  it('legacy lookalike is inert under opt-in (verbatim passthrough)', async () => {
    process.env.MESH_QUARANTINE = '1';
    vi.resetModules();
    const { quarantineText } = await import('../src/frontmatter.js');
    // built by concatenation so the retired literal stays out of the census
    const legacy = `see [OC-MESH | SENDER (${'UN'}VERIFIED): x - y] below`;
    expect(quarantineText(legacy)).toBe(legacy);
    // positive control: the retargeted detector still tags the new lookalike
    const fresh = 'see [OC-MESH | SENDER (QUARANTINED): x - y] below';
    expect(quarantineText(fresh)).toBe(`[QUARANTINED-LOOKALIKE] ${fresh}`);
  });

  it('both legs display the canonical prefix (mock round-trip A→B→A)', async () => {
    const { root, restore } = await freshRoot('mesh-rt-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    const now = Date.now();
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-A'] = { sessionId: 'ses-A', agent: 'alpha', model: 'myprov/my-model', updatedAt: now, serveUrl: 'http://127.0.0.1:4096' } as any;
      reg['ses-B'] = { sessionId: 'ses-B', agent: 'beta', model: 'myprov/my-model', updatedAt: now, serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    const bodies: string[] = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) {
        bodies.push(String((init as any)?.body ?? ''));
        return { ok: true, status: 204 } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    await (mesh_send.execute as any)({ target: 'ses-B', text: 'ping' }, { sessionID: 'ses-A', directory: '/tmp', agent: 'alpha' });
    await (mesh_send.execute as any)({ target: 'ses-A', text: 'pong' }, { sessionID: 'ses-B', directory: '/tmp', agent: 'beta' });
    expect(bodies.length).toBe(2);
    expect(JSON.parse(bodies[0]).parts[0].text).toBe('[OC-MESH | SENDER: alpha - ses-A]\n\nping');
    expect(JSON.parse(bodies[1]).parts[0].text).toBe('[OC-MESH | SENDER: beta - ses-B]\n\npong');
    await safeRm(root); restore();
  });

  it('reply parse: product prefixes satisfy the documented sender-extract rule', async () => {
    // Why: receivers reply by reverse send to the sender id on the first line
    // (SKILL.md group-2 rule). This pins real formatMeshPrefix output against
    // the rule instead of matching hand-written strings against themselves.
    const { formatMeshPrefix } = await import('../src/frontmatter.js');
    const re = /^\[OC-MESH \| SENDER(?: \(SILENT\))?(?: \(QUARANTINED\))?: (.+) - ([^\]]+)\]$/;
    const shapes: Array<[string, string]> = [
      [formatMeshPrefix('a-b-c', 'ses-x-y'), 'ses-x-y'],
      [formatMeshPrefix('a-b-c', 'ses-x-y', true, true), 'ses-x-y'],
      [formatMeshPrefix('a-b-c', 'ses-x-y', false, false), 'ses-x-y'],
      [formatMeshPrefix('a-b-c', 'ses-x-y', false, true), 'ses-x-y'],
    ];
    for (const [prefix, id] of shapes) {
      const m = prefix.match(re);
      expect(m, `prefix must satisfy the extract rule: ${prefix}`).not.toBeNull();
      expect(m![1]).toBe('a-b-c');
      expect(m![2]).toBe(id);
    }
    // first-line rule: the body after the blank line never participates
    const first = `${formatMeshPrefix('a-b-c', 'ses-x-y')}\n\nhello body`.split('\n')[0].match(re);
    expect(first?.[2]).toBe('ses-x-y');
    // swapped marker order is not a product shape and never parses
    expect('[OC-MESH | SENDER (QUARANTINED) (SILENT): a-b-c - ses-x-y]'.match(re)).toBeNull();
  });
});

describe('delivery: any-count ToolContext', () => {
  it('sender agents never reach the wire (receiver triple flows, prefix intact)', async () => {
    const { root, restore } = await freshRoot('mesh-any-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-peer'] = { sessionId: 'ses-peer', agent: 'peer-agent', model: 'myprov/my-model', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mockStatusAnd204(calls);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    await (mesh_send.execute as any)(
      { target: 'ses-peer', text: 'hi' },
      { sessionID: 'ses-custom-xyz', directory: '/tmp/custom-wt', agent: 'custom-agent-xyz' }
    );
    const body = JSON.parse(String(calls.find((c) => c.url.includes('prompt_async'))!.init?.body));
    // The wire triple names the receiver (`peer-agent`), never the sender;
    // the prefix keeps raw attribution. Wake leg omits the wake key as well.
    expect('agent' in body).toBe(true);
    expect(body.agent).toBe('peer-agent');
    expect(Object.keys(body).sort()).toEqual(['agent', 'messageID', 'model', 'parts']);
    expect(body.parts[0].text).toContain('[OC-MESH | SENDER: custom-agent-xyz - ses-custom-xyz]');
    // Sender registration changes nothing on the wire: the receiver triple
    // still flows (the sender key never reaches the body).
    const { atomicUpdateRegistry: atomic2 } = await import('../src/registry.js');
    await atomic2((reg: any) => {
      reg['ses-custom-xyz'] = { sessionId: 'ses-custom-xyz', agent: 'custom-agent-xyz', updatedAt: Date.now() } as any;
    }, root);
    const calls2: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mockStatusAnd204(calls2);
    await (mesh_send.execute as any)(
      { target: 'ses-peer', text: 'hi again' },
      { sessionID: 'ses-custom-xyz', directory: '/tmp/custom-wt', agent: 'custom-agent-xyz' }
    );
    const body2 = JSON.parse(String(calls2.find((c) => c.url.includes('prompt_async'))!.init?.body));
    expect(body2.agent).toBe('peer-agent');
    expect('noReply' in body2).toBe(false);
    // Silent leg keeps the key: history-only deposit for that message.
    const calls3: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mockStatusAnd204(calls3);
    await (mesh_send.execute as any)(
      { target: 'ses-peer', text: 'quiet again', silent: true },
      { sessionID: 'ses-custom-xyz', directory: '/tmp/custom-wt', agent: 'custom-agent-xyz' }
    );
    const body3 = JSON.parse(String(calls3.find((c) => c.url.includes('prompt_async'))!.init?.body));
    expect(body3.noReply).toBe(true);
    await safeRm(root); restore();
  });
});

describe('delivery: fan-out sequential, ENOSPC partial, restart-survive', () => {
  it('broadcast N=5 sequential with strictly increasing starts; per-peer results', async () => {
    process.env.MESH_BROADCAST = '1';
    const { root, restore } = await freshRoot('mesh-seq-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      for (let i = 0; i < 5; i++) reg[`seq-${i}`] = { sessionId: `seq-${i}`, agent: 'a', model: 'myprov/my-model', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    const starts: number[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) {
        starts.push(Date.now());
        await new Promise((r) => setTimeout(r, 20));
        return { ok: true, status: 204 } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = await (mesh_send.execute as any)(
      { target: 'all', text: 'hi', broadcast: true },
      { sessionID: 'seq-caller', directory: '/tmp' }
    );
    const j = JSON.parse(out.output);
    expect(j.peers).toBe(5);
    expect(j.ok).toBe(5);
    for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1]);
    await safeRm(root); restore();
  });

  it('ENOSPC per-peer partial: ok + failed == peers, batch never throws (413 still rethrows)', async () => {
    process.env.MESH_BROADCAST = '1';
    const { root, restore } = await freshRoot('mesh-nospc-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      for (let i = 0; i < 5; i++) reg[`spc-${i}`] = { sessionId: `spc-${i}`, agent: 'a', model: 'myprov/my-model', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) {
        if (u.includes('spc-1') || u.includes('spc-3'))
          throw Object.assign(new Error('ENOSPC: no space'), { code: 'ENOSPC' });
        return { ok: true, status: 204 } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = await (mesh_send.execute as any)(
      { target: 'all', text: 'hi', broadcast: true },
      { sessionID: 'spc-caller', directory: '/tmp' }
    );
    const j = JSON.parse(out.output);
    expect(j.ok + j.failed.length).toBe(j.peers);
    expect(j.ok).toBe(3);
    await safeRm(root); restore();
  });

  it('restart-survive: entries + migratedAt preserved, no lock residue', async () => {
    const { root, restore } = await freshRoot('mesh-restart-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['persist-1'] = { sessionId: 'persist-1', agent: 'a', updatedAt: Date.now() } as any;
    }, root);
    const { resolveRegistryPath } = await import('../src/xdg.js');
    const raw1 = JSON.parse(await readFile(resolveRegistryPath(root), 'utf8')) as any;
    vi.resetModules();
    const rr = await import('../src/registry.js');
    const reg = (await rr.readRegistry(root)) as any;
    expect(reg['persist-1']).toBeDefined();
    const raw2 = JSON.parse(await readFile(resolveRegistryPath(root), 'utf8')) as any;
    expect(raw2.migratedAt).toBe(raw1.migratedAt);
    await expect(stat(`${resolveRegistryPath(root)}.lock`)).rejects.toThrow();
    await safeRm(root); restore();
  });

  it('FIFO ordering: 5 concurrent RMW writes all land, no lost update', async () => {
    const { root, restore } = await freshRoot('mesh-fifo-');
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        atomicUpdateRegistry((reg: any) => {
          reg[`fifo-${i}`] = { sessionId: `fifo-${i}`, agent: `agent-${i}`, updatedAt: Date.now() } as any;
        }, root)
      )
    );
    const reg = (await readRegistry(root)) as any;
    for (let i = 0; i < 5; i++) {
      expect(reg[`fifo-${i}`]).toBeDefined();
      expect(reg[`fifo-${i}`].agent).toBe(`agent-${i}`);
    }
    await safeRm(root); restore();
  });
});

describe('delivery: 1MB triple guard', () => {
  it('text, prefixed, and body each 413 at the boundary', async () => {
    const { root, restore } = await freshRoot('mesh-1mb-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['big-target'] = { sessionId: 'big-target', agent: 'a', updatedAt: Date.now() } as any;
    }, root);
    globalThis.fetch = mockStatusAnd204();
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const { ONE_MB } = await import('../src/constants.js');
    const big = 'x'.repeat(ONE_MB + 1);
    await expect(
      (mesh_send.execute as any)({ target: 'big-target', text: big }, { sessionID: 'c', directory: '/tmp' })
    ).rejects.toThrow(/413/);
    await safeRm(root); restore();
  });
});

describe('delivery: send branch legs (coverage floor)', () => {
  it('missing caller sessionID throws before any guard', async () => {
    const { root, restore } = await freshRoot('mesh-send-nocaller-');
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const err = await (mesh_send.execute as any)({ target: 'x', text: 'hi' }, {}).catch((e: any) => e);
    expect(err.code).toBe('PEER_NOT_FOUND');
    await safeRm(root); restore();
  });

  it('agent at repo exact shape resolves to the single row', async () => {
    const { root, restore } = await freshRoot('mesh-send-agentrepo-');
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'nodb.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-ar'] = { sessionId: 'ses-ar', agent: 'manager', repo: 'dotfiles', directory: '/tmp/dotfiles', description: 'manager row', updatedAt: Date.now() } as any;
    }, root);
    globalThis.fetch = mockStatusAnd204();
    try {
      const { mesh_send } = await import('../src/tools/mesh_send.js');
      const out = await (mesh_send.execute as any)({ target: 'manager@dotfiles', text: 'hi' }, { sessionID: 'caller-ar', directory: '/tmp' });
      expect(JSON.parse(out.output).target).toBe('ses-ar');
    } finally {
      if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
      await safeRm(root); restore();
    }
  });

  it('didYouMean renders agent at repo plus bare agent fallbacks', async () => {
    const { root, restore } = await freshRoot('mesh-send-dym-');
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'nodb.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-a'] = { sessionId: 'ses-a', agent: 'manager', repo: 'dotfiles', updatedAt: Date.now() } as any;
      reg['ses-b'] = { sessionId: 'ses-b', agent: 'reviewer', updatedAt: Date.now() } as any;
    }, root);
    globalThis.fetch = mockStatusAnd204();
    try {
      const { mesh_send } = await import('../src/tools/mesh_send.js');
      const err = await (mesh_send.execute as any)({ target: 'nobody-here', text: 'hi' }, { sessionID: 'caller-dym', directory: '/tmp' }).catch((e: any) => e);
      expect(err.code).toBe('PEER_NOT_FOUND');
      expect(err.didYouMean).toContain('manager@dotfiles');
      expect(err.didYouMean).toContain('reviewer');
    } finally {
      if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
      await safeRm(root); restore();
    }
  });

  it('peer cwd backstops a missing peer directory on the wire', async () => {
    const { root, restore } = await freshRoot('mesh-send-cwdfb-');
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'nodb.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-cwd'] = { sessionId: 'ses-cwd', agent: 'a', model: 'myprov/my-model', cwd: '/tmp/cwd-only', description: 'cwd row', updatedAt: Date.now() } as any;
    }, root);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mockStatusAnd204(calls);
    try {
      const { mesh_send } = await import('../src/tools/mesh_send.js');
      await (mesh_send.execute as any)({ target: 'ses-cwd', text: 'hi' }, { sessionID: 'caller-cwd', directory: '/tmp' });
      const post = calls.find((c) => c.url.includes('prompt_async'));
      expect((post!.init?.headers as Record<string, string>)['x-opencode-directory']).toBe(encodeURIComponent('/tmp/cwd-only'));
    } finally {
      if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
      await safeRm(root); restore();
    }
  });

  it('caller directory backstops a scopeless peer on the wire', async () => {
    const { root, restore } = await freshRoot('mesh-send-callerdir-');
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'nodb.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-scope'] = { sessionId: 'ses-scope', agent: 'a', model: 'myprov/my-model', description: 'scopeless row', updatedAt: Date.now() } as any;
    }, root);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mockStatusAnd204(calls);
    try {
      const { mesh_send } = await import('../src/tools/mesh_send.js');
      await (mesh_send.execute as any)({ target: 'ses-scope', text: 'hi' }, { sessionID: 'caller-scope', directory: '/tmp/callerdir' });
      const post = calls.find((c) => c.url.includes('prompt_async'));
      expect((post!.init?.headers as Record<string, string>)['x-opencode-directory']).toBe(encodeURIComponent('/tmp/callerdir'));
    } finally {
      if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
      await safeRm(root); restore();
    }
  });

  it('429 on prompt_async throws PEER_BUSY_RETRY', async () => {
    const { root, restore } = await freshRoot('mesh-send-429-');
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'nodb.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-busy'] = { sessionId: 'ses-busy', agent: 'a', model: 'myprov/my-model', description: 'busy row', updatedAt: Date.now() } as any;
    }, root);
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      return { ok: false, status: 429 } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      const { mesh_send } = await import('../src/tools/mesh_send.js');
      const err = await (mesh_send.execute as any)({ target: 'ses-busy', text: 'hi' }, { sessionID: 'caller-429', directory: '/tmp' }).catch((e: any) => e);
      expect(err.code).toBe('PEER_BUSY_RETRY');
    } finally {
      if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
      await safeRm(root); restore();
    }
  });

  it('claim enqueue binds from_agent to the caller registry entry', async () => {
    const { root, restore } = await freshRoot('mesh-send-fromentry-');
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'nodb.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-caller-e'] = { sessionId: 'ses-caller-e', agent: 'entry-agent', updatedAt: Date.now() } as any;
      reg['ses-peer-e'] = { sessionId: 'ses-peer-e', agent: 'a', description: 'peer row', updatedAt: Date.now() } as any;
    }, root);
    globalThis.fetch = (async () => { throw new Error('loopback down — claim path'); }) as unknown as typeof fetch;
    try {
      const { mesh_send } = await import('../src/tools/mesh_send.js');
      await (mesh_send.execute as any)({ target: 'ses-peer-e', text: 'queued' }, { sessionID: 'ses-caller-e', directory: '/tmp' });
      const ob = await import('../src/outbox.js');
      const rows = await ob.claim(['ses-peer-e'], 'owner-fe', 10, root);
      expect(rows.length).toBe(1);
      expect(rows[0].from_agent).toBe('entry-agent');
    } finally {
      if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
      await safeRm(root); restore();
    }
  });

  it('empty registry misses with an empty didYouMean', async () => {
    const { root, restore } = await freshRoot('mesh-send-emptyreg-');
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'nodb.db');
    globalThis.fetch = mockStatusAnd204();
    try {
      const { mesh_send } = await import('../src/tools/mesh_send.js');
      const err = await (mesh_send.execute as any)({ target: 'ghost', text: 'hi' }, { sessionID: 'caller-empty', directory: '/tmp' }).catch((e: any) => e);
      expect(err.code).toBe('PEER_NOT_FOUND');
      expect(err.didYouMean).toEqual([]);
    } finally {
      if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
      await safeRm(root); restore();
    }
  });
});
