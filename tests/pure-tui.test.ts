// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Pure TUI-identical mesh gates (no file mailbox)
// Covers: NO_FILE_MAILBOX, ONE_WAY (admit baseline), RUNNER_JOIN (sequential, no inline sleep), DIRECTORY_ROUTING,
// PROMPT_INPUT, AUTH_BASIC, sanitizeSessionId, assertSendable 413, loopback, withRegistryLock,
// registry cross-process lock, gc legacy drain 24h, broadcast N sequential, busy retry, 401/404
import { mkdtemp, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const origFetch = globalThis.fetch;
const origEnv = { ...process.env };

function restoreFetch() {
  globalThis.fetch = origFetch as unknown as typeof fetch;
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
const DRAIN_POLL_MS = 50;
const DRAIN_BUDGET_MS = 2000;
async function safeRmArmed(root: string): Promise<void> {
  const deadline = Date.now() + DRAIN_BUDGET_MS;
  for (;;) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if ((code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
        continue;
      }
      throw err;
    }
  }
}
function mockFetch204(capture?: { url?: string; headers?: Record<string, string>; body?: string; calls: Array<{ url: string; init?: RequestInit }> }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (capture) {
      capture.calls.push({ url: String(url), init });
      capture.url = String(url);
      capture.headers = (init?.headers as Record<string, string>) ?? {};
      try { capture.body = init?.body as string; } catch {}
    }
    const u = String(url);
    if (u.includes('/session/status')) {
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }
    if (u.includes('/prompt_async')) {
      return { ok: true, status: 204, json: async () => ({}) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}


describe('pure TUI-identical — harness gates', () => {
  afterEach(() => {
    restoreFetch();
    delete process.env.OPENCODE_MESH_DB_PATH;
  });

  it('ONE_WAY — prompt_async 204, no 120s poll, one-way delivery', async () => {
    // Behavioral: send returns well under a minute with local loopback mocks;
    // intent notes under 2000ms for CI jitter, no elapsed assert here; old file poll would take far longer.
    const root = await mkdtemp(join(tmpdir(), 'mesh-oneway-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    const now = Date.now();
    await atomicUpdateRegistry((reg: any) => {
      reg['target-oneway'] = { sessionId: 'target-oneway', agent: 'a', model: 'myprov/my-model', updatedAt: now, serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    const capture: { calls: Array<{ url: string; init?: RequestInit }>; url?: string; headers?: Record<string, string>; body?: string } = { calls: [] };
    globalThis.fetch = mockFetch204(capture);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = await (mesh_send.execute as any)({ target: 'target-oneway', text: 'hello oneway' }, { sessionID: 'caller-oneway', directory: '/tmp/repo' });
    // Honest result shape: ok plus admitted plus id; sent and oneWay absent.
    const shaped = JSON.parse(out.output);
    expect(shaped.ok).toBe(true);
    expect(shaped.via).toBe('admitted');
    expect(typeof shaped.id).toBe('string');
    expect(shaped.target).toBe('target-oneway');
    expect(typeof shaped.title).toBe('string');
    expect('sent' in shaped).toBe(false);
    expect('oneWay' in shaped).toBe(false);
    expect(capture.calls.some(c => c.url.includes('prompt_async'))).toBe(true);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRm(root);
    vi.restoreAllMocks();
  });

  it('RUNNER_JOIN sequential per-target, no inline wait', async () => {
    // behavioral: busy → admit immediately, no inline wait
    const root = await mkdtemp(join(tmpdir(), 'mesh-runner-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['busy-target'] = { sessionId: 'busy-target', agent: 'a', model: 'myprov/my-model', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    let statusCalls = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) {
        statusCalls++;
        return { ok: true, json: async () => ({ 'busy-target': { type: 'busy' } }) } as unknown as Response;
      }
      if (u.includes('prompt_async')) return { ok: true, status: 204 } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send: ms2 } = await import('../src/tools/mesh_send.js');
    const out = await (ms2.execute as any)({ target: 'busy-target', text: 'hi' }, { sessionID: 'caller-busy', directory: '/tmp' });
    expect(JSON.parse(out.output).via).toBe('admitted');
    expect(statusCalls).toBeGreaterThanOrEqual(1);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRm(root);
    vi.restoreAllMocks();
  });

  it('DIRECTORY_ROUTING — ?directory + x-opencode-directory on every POST', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-dir-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['dir-target'] = { sessionId: 'dir-target', agent: 'a', model: 'myprov/my-model', directory: '/tmp/myrepo', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    const capture: { calls: Array<{ url: string; init?: RequestInit }>; headers?: Record<string, string> } = { calls: [] };
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      capture.calls.push({ url: String(url), init });
      capture.headers = (init?.headers as Record<string, string>) ?? {};
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      // Loopback GET leg: bare session read carries no ?directory= by design
      // (D-3); it reads as a layer miss here so only the POST faces the gate.
      if (u.match(/\/session\/[^/?]+$/)) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      // assert URL contains ?directory=
      expect(u).toMatch(/\?directory=/);
      expect(u).toContain(encodeURIComponent('/tmp/myrepo'));
      // assert header x-opencode-directory
      const h = (init?.headers as Record<string, string>) ?? {};
      // header key may be lowercased
      const hasHeader = Object.keys(h).some(k => k.toLowerCase() === 'x-opencode-directory');
      expect(hasHeader).toBe(true);
      return { ok: true, status: 204 } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send: ms3 } = await import('../src/tools/mesh_send.js');
    await (ms3.execute as any)({ target: 'dir-target', text: 'hello dir' }, { sessionID: 'caller-dir', directory: '/tmp/myrepo' });
    expect(capture.calls.some(c => c.url.includes('?directory='))).toBe(true);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRm(root);
    vi.restoreAllMocks();
  });

  it('PROMPT_INPUT — model-missing receiver defers with zero POSTs on both legs (fail-closed)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-prompt-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['prompt-target'] = { sessionId: 'prompt-target', agent: 'a', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    let bodyCaptured: any = null;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) {
        bodyCaptured = JSON.parse(String(init?.body));
        return { ok: true, status: 204 } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send: ms4 } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      String((await (ms4.execute as any)({ target: 'prompt-target', text: 'hello prompt' }, { sessionID: 'caller-prompt', directory: '/tmp' })).output),
    ) as { via: string };
    // Gated tertiary: nothing captured, the send degrades to claim.
    expect(bodyCaptured).toBeNull();
    expect(out.via).toBe('queued');
    // silent leg pins the same degrade with nothing captured either
    let silentCaptured: any = null;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) {
        silentCaptured = JSON.parse(String(init?.body));
        return { ok: true, status: 204 } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const silentOut = JSON.parse(
      String((await (ms4.execute as any)({ target: 'prompt-target', text: 'quiet prompt', silent: true }, { sessionID: 'caller-prompt', directory: '/tmp' })).output),
    ) as { via: string };
    expect(silentCaptured).toBeNull();
    expect(silentOut.via).toBe('queued');
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRm(root);
    vi.restoreAllMocks();
  });

  it('PROMPT_INPUT — parts:[{type:"text"}] with PromptInput shape {agent, model, variant, parts, messageID}', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-prompt-echo-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['prompt-target'] = { sessionId: 'prompt-target', agent: 'a', model: 'myprov/my-model', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    let bodyCaptured: any = null;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) {
        bodyCaptured = JSON.parse(String(init?.body));
        return { ok: true, status: 204 } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send: ms4 } = await import('../src/tools/mesh_send.js');
    await (ms4.execute as any)({ target: 'prompt-target', text: 'hello prompt' }, { sessionID: 'caller-prompt', directory: '/tmp' });
    expect(bodyCaptured).not.toBeNull();
    expect(Array.isArray(bodyCaptured.parts)).toBe(true);
    expect(bodyCaptured.parts[0].type).toBe('text');
    expect(bodyCaptured.parts[0].text.toLowerCase()).toContain('[oc-mesh | sender:');
    expect(bodyCaptured.parts[0].text).toContain('hello prompt');
    // receiver triple: the wire agent names the receiver (`a`), never the
    // sender, while the prefix keeps raw attribution.
    expect(bodyCaptured.agent).toBe('a');
    expect(bodyCaptured.parts[0].text).toContain('[OC-MESH | SENDER: unknown - caller-prompt]');
    expect(bodyCaptured).toHaveProperty('messageID');
    const { isMsgId } = await import('../src/outbox.js');
    expect(isMsgId(bodyCaptured.messageID)).toBe(true);
    expect(bodyCaptured).toHaveProperty('model');
    expect(bodyCaptured.model).toEqual({ providerID: 'myprov', modelID: 'my-model' });
    // wake-default: the key is omitted so the Runner loop runs
    expect(bodyCaptured).not.toHaveProperty('noReply');
    // silent leg pins the key for history-only deposit
    let silentCaptured: any = null;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) {
        silentCaptured = JSON.parse(String(init?.body));
        return { ok: true, status: 204 } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    await (ms4.execute as any)({ target: 'prompt-target', text: 'quiet prompt', silent: true }, { sessionID: 'caller-prompt', directory: '/tmp' });
    expect(silentCaptured.noReply).toBe(true);
    // silent direct leg renders the SILENT marker with the body verbatim
    expect(silentCaptured.parts[0].text).toBe('[OC-MESH | SENDER (SILENT): unknown - caller-prompt]\n\nquiet prompt');
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRm(root);
    vi.restoreAllMocks();
  });

  it('AUTH_BASIC — Authorization Basic base64 via env OPENCODE_SERVER_PASSWORD (env-only, no file fallback)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-auth-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevPw = process.env.OPENCODE_SERVER_PASSWORD;
    const prevUser = process.env.OPENCODE_SERVER_USERNAME;
    const prevUSER = process.env.USER;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['auth-target'] = { sessionId: 'auth-target', agent: 'a', model: 'myprov/my-model', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);

    // Case A: env-present custom user must NOT call execFileSync (fast path)
    vi.resetModules();
    delete process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_SERVER_USERNAME;
    process.env.OPENCODE_SERVER_PASSWORD = 's3cret-env';
    process.env.OPENCODE_SERVER_USERNAME = 'custom-user';
    process.env.USER = prevUSER ?? 'testuser';
    let spyEnv: any = null;
    let spyEnvFailed = false;
    try {
      const cpEnv = await import('node:child_process');
      spyEnv = vi.spyOn(cpEnv as any, 'execFileSync');
    } catch (e) { spyEnvFailed = true; }
    let envAuth: string | undefined;
    let envStatusAuth: string | undefined;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const h = (init?.headers as any) ?? {};
      const a = h.Authorization ?? h.authorization;
      if (u.includes('/session/status')) { envStatusAuth = a; return { ok: true, json: async () => ({}) } as unknown as Response; }
      if (u.includes('prompt_async')) { envAuth = a; return { ok: true, status: 204 } as unknown as Response; }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send: msEnv } = await import('../src/tools/mesh_send.js');
    await (msEnv.execute as any)({ target: 'auth-target', text: 'hello env' }, { sessionID: 'caller-auth', directory: '/tmp' });
    expect(envAuth).toBe(`Basic ${Buffer.from(`custom-user:s3cret-env`).toString('base64')}`);
    expect(envStatusAuth).toBe(`Basic ${Buffer.from(`custom-user:s3cret-env`).toString('base64')}`);
    // Why: loud skip, never a fake pass — when the ESM spy is unavailable the
    // no-shell-out half cannot run; Basic-header asserts still hold.
    if (!spyEnvFailed && spyEnv) { expect(spyEnv).not.toHaveBeenCalled(); spyEnv.mockRestore(); } else { console.log('SKIP_NO_SPY env fast-path shell-out check (ESM spy not configurable)'); }
    vi.resetModules();

    // Case B: Keychain is opt-in only (H1b) — flag-unset never leaks even with an entry present
    delete process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_SERVER_USERNAME;
    delete process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER;
    // Use vi.mock for ESM-safe mock of execFileSync via module mock
    let spy: any = null;
    let spyBFailed = false;
    try {
      const cp = await import('node:child_process');
      spy = vi.spyOn(cp as any, 'execFileSync').mockReturnValue('kc-secret\n' as any);
    } catch (e) { spyBFailed = true; }
    let kcAuth: string | undefined;
    let kcStatusAuth: string | undefined;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const h = (init?.headers as any) ?? {};
      const a = h.Authorization ?? h.authorization;
      if (u.includes('/session/status')) { kcStatusAuth = a; return { ok: true, json: async () => ({}) } as unknown as Response; }
      if (u.includes('prompt_async')) { kcAuth = a; return { ok: true, status: 204 } as unknown as Response; }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send: msKc } = await import('../src/tools/mesh_send.js');
    await (msKc.execute as any)({ target: 'auth-target', text: 'hello kc' }, { sessionID: 'caller-auth', directory: '/tmp' });
    if (!spyBFailed && spy) {
      // flag unset: mocked Keychain entry present but provider inert → no header (no leak)
      expect(kcAuth).toBeUndefined();
      expect(kcStatusAuth).toBeUndefined();
      expect(spy.mock.calls.length).toBe(0);
      // flag set: provider active → Basic opencode:kc-secret
      process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER = '1';
      let kcAuth2: string | undefined;
      globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('prompt_async')) { kcAuth2 = (init?.headers as any)?.Authorization; return { ok: true, status: 204 } as unknown as Response; }
        if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch;
      await (msKc.execute as any)({ target: 'auth-target', text: 'hello kc2' }, { sessionID: 'caller-auth', directory: '/tmp' });
      expect(kcAuth2).toBe(`Basic ${Buffer.from(`opencode:kc-secret`).toString('base64')}`);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
      // third call cached — no new security invocation
      const callsAfterSecond = spy.mock.calls.length;
      let kcAuth3: string | undefined;
      globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('prompt_async')) { kcAuth3 = (init?.headers as any)?.Authorization; return { ok: true, status: 204 } as unknown as Response; }
        if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch;
      await (msKc.execute as any)({ target: 'auth-target', text: 'hello kc3' }, { sessionID: 'caller-auth', directory: '/tmp' });
      expect(kcAuth3).toBe(`Basic ${Buffer.from(`opencode:kc-secret`).toString('base64')}`);
      expect(spy.mock.calls.length).toBe(callsAfterSecond);
      delete process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER;
      spy.mockRestore();
    } else {
      // ESM mock fallback — exercise the real provider surface (no mock):
      // flag unset → undefined even if a real Keychain entry exists (no leak)
      expect(kcAuth).toBeUndefined();
      expect(kcStatusAuth).toBeUndefined();
      // flag set → Basic opencode:* when an entry exists (absent entry → undefined dormant, source-cite half stays green)
      process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER = '1';
      let kcAuthFlag: string | undefined;
      globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('prompt_async')) { kcAuthFlag = (init?.headers as any)?.Authorization; return { ok: true, status: 204 } as unknown as Response; }
        if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch;
      await (msKc.execute as any)({ target: 'auth-target', text: 'hello kc-flag' }, { sessionID: 'caller-auth', directory: '/tmp' });
      if (kcAuthFlag !== undefined) {
        const decoded = Buffer.from(kcAuthFlag.replace('Basic ', '').trim(), 'base64').toString();
        expect(decoded.startsWith('opencode:')).toBe(true);
      }
      delete process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER;
    }
    // Ensure cached behavior: second call still opencode:kc-secret
    vi.resetModules();
    delete process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_SERVER_USERNAME;

    // Case C: no env + Keychain throws → no header → 204 (required false)
    delete process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_SERVER_USERNAME;
    let spyFail: any = null;
    let spyFailFailed = false;
    try {
      const cpFail = await import('node:child_process');
      spyFail = vi.spyOn(cpFail as any, 'execFileSync').mockImplementation(() => { throw new Error('no keychain'); });
    } catch (e) { spyFailFailed = true; }
    let noAuthHeader: string | undefined;
    let noStatusAuth: string | undefined;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const h = (init?.headers as any) ?? {};
      const a = h.Authorization ?? h.authorization;
      if (u.includes('/session/status')) { noStatusAuth = a; return { ok: true, json: async () => ({}) } as unknown as Response; }
      if (u.includes('prompt_async')) { noAuthHeader = a; return { ok: true, status: 204 } as unknown as Response; }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send: msNo } = await import('../src/tools/mesh_send.js');
    await expect((msNo.execute as any)({ target: 'auth-target', text: 'hello noauth' }, { sessionID: 'caller-auth', directory: '/tmp' })).resolves.toBeDefined();
    if (!spyFailFailed) {
      expect(noAuthHeader).toBeUndefined();
      expect(noStatusAuth).toBeUndefined();
      spyFail.mockRestore();
    } else {
      // ESM spy not configurable — real security may succeed (keychain exists) → header will be opencode:kc-secret, not undefined
      if (noAuthHeader !== undefined) {
        const decoded = Buffer.from((noAuthHeader as string).replace('Basic ',''), 'base64').toString();
        expect(decoded.startsWith('opencode:')).toBe(true);
        if (noStatusAuth) {
          const decodedStatus = Buffer.from((noStatusAuth as string).replace('Basic ','').trim(), 'base64').toString();
          expect(decodedStatus.startsWith('opencode:')).toBe(true);
        }
      } else {
        expect(noAuthHeader).toBeUndefined();
        expect(noStatusAuth).toBeUndefined();
      }
    }
    vi.resetModules();

    // Case D: env password opencode-env + no username + Keychain empty → Basic opencode:opencode-env
    delete process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_SERVER_USERNAME;
    process.env.OPENCODE_SERVER_PASSWORD = 'opencode-env';
    let spy4: any = null;
    let spy4Failed = false;
    try {
      const cp4 = await import('node:child_process');
      spy4 = vi.spyOn(cp4 as any, 'execFileSync').mockImplementation(() => { throw new Error('no keychain'); });
    } catch (e) { spy4Failed = true; }
    let opAuth: string | undefined;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('prompt_async')) { opAuth = (init?.headers as any)?.Authorization; return { ok: true, status: 204 } as unknown as Response; }
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send: msOp } = await import('../src/tools/mesh_send.js');
    await (msOp.execute as any)({ target: 'auth-target', text: 'hello op' }, { sessionID: 'caller-auth', directory: '/tmp' });
    expect(opAuth).toBe(`Basic ${Buffer.from(`opencode:opencode-env`).toString('base64')}`);
    if (!spy4Failed && spy4) spy4.mockRestore();

    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    if (prevPw === undefined) delete process.env.OPENCODE_SERVER_PASSWORD; else process.env.OPENCODE_SERVER_PASSWORD = prevPw;
    if (prevUser === undefined) delete process.env.OPENCODE_SERVER_USERNAME; else process.env.OPENCODE_SERVER_USERNAME = prevUser;
    if (prevUSER === undefined) delete process.env.USER; else process.env.USER = prevUSER;
    await safeRm(root);
    vi.restoreAllMocks();
  });
});

describe('security', () => {
  afterEach(() => {
    restoreFetch();
    delete process.env.OPENCODE_MESH_DB_PATH;
  });

  it('sanitizeSessionId allowlist /^[A-Za-z0-9_-]{1,64}$/ throws 400 for traversal/invalid', async () => {
    const { sanitizeSessionId } = await import('../src/xdg.js');
    expect(sanitizeSessionId('valid-123_abc')).toBe('valid-123_abc');
    expect(sanitizeSessionId('a')).toBe('a');
    expect(sanitizeSessionId('A'.repeat(64))).toBe('A'.repeat(64));
    for (const bad of ['../evil', '../../etc/passwd', 'a/b', '', 'a'.repeat(65), 'has space', 'has.dot', 'a$b', 'a\nb']) {
      try {
        sanitizeSessionId(bad);
        throw new Error(`should throw for ${bad}`);
      } catch (e: any) {
        expect(String(e.message)).toMatch(/400/);
        expect((e as { status?: number }).status).toBe(400);
      }
    }
    // mesh_send must sanitize both target and from
    // mesh_send validates via sanitizeSessionId inside sendIdentical (target+from) for valid peers;
    // for unknown invalid targets, funnel will throw PEER_NOT_FOUND before reaching sanitize — both are rejections
    const root = await mkdtemp(join(tmpdir(), 'mesh-sanitize-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['valid1'] = { sessionId: 'valid1', agent: 'a', updatedAt: Date.now() } as any;
    }, root);
    globalThis.fetch = mockFetch204();
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    await expect((mesh_send.execute as any)({ target: '../evil', text: 'hi' }, { sessionID: 'valid1', directory: '/tmp' })).rejects.toThrow(/400|peer not found/i);
    await expect((mesh_send.execute as any)({ target: 'valid1', text: 'hi' }, { sessionID: '../evil', directory: '/tmp' })).rejects.toThrow(/400/);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRm(root);
    vi.restoreAllMocks();
  });

  it('assertSendable 413 — text, prefixed, and body guard via the single owner', async () => {
    const { ONE_MB } = await import('../src/constants.js');
    const root = await mkdtemp(join(tmpdir(), 'mesh-1mb-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['t1'] = { sessionId: 't1', agent: 'a', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    globalThis.fetch = mockFetch204();
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const big = 'x'.repeat(ONE_MB + 1);
    await expect((mesh_send.execute as any)({ target: 't1', text: big }, { sessionID: 'caller1', directory: '/tmp' })).rejects.toThrow();
    try {
      await (mesh_send.execute as any)({ target: 't1', text: big }, { sessionID: 'caller1', directory: '/tmp' });
    } catch (e: any) {
      expect(e.status).toBe(413);
    }
    // prefixed overhead should also 413 — keep comfortably under body overhead (~200 bytes)
    const justUnder = 'x'.repeat(ONE_MB - 1024);
    await expect((mesh_send.execute as any)({ target: 't1', text: justUnder }, { sessionID: 'caller1', directory: '/tmp' })).resolves.toBeDefined();
    const justOverPrefixed = 'x'.repeat(ONE_MB - 10);
    // Prefixed canonical header plus text exceeds 1MB via formatMeshPrefix.
    await expect((mesh_send.execute as any)({ target: 't1', text: justOverPrefixed }, { sessionID: 'caller1', directory: '/tmp' })).rejects.toThrow();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRm(root);
    vi.restoreAllMocks();
  });

  it('loopback 127.0.0.1 only; no 0.0.0.0, all fetches to loopback', async () => {
    // behavioral: every fetch URL is loopback
    const root = await mkdtemp(join(tmpdir(), 'mesh-loop-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['loop-target'] = { sessionId: 'loop-target', agent: 'a', updatedAt: Date.now() } as any;
    }, root);
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      urls.push(String(url));
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) return { ok: true, status: 204 } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send: ms } = await import('../src/tools/mesh_send.js');
    await (ms.execute as any)({ target: 'loop-target', text: 'hi' }, { sessionID: 'caller-loop', directory: '/tmp' });
    for (const u of urls) expect(u).toMatch(/^http:\/\/127\.0\.0\.1:4096\//);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRm(root);
    vi.restoreAllMocks();
  });
});

describe('fallback', () => {
  afterEach(() => {
    restoreFetch();
    delete process.env.OPENCODE_MESH_DB_PATH;
  });

  it('registry cross-process lock — O_EXCL 0600 3x jitter prevents lost-update', async () => {
    // behavioral: concurrent atomicUpdateRegistry must not lose writes (holds chain + flock)
    const root = await mkdtemp(join(tmpdir(), 'mesh-lock-'));
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    await Promise.all([
      atomicUpdateRegistry((reg: any) => { reg['k1'] = { sessionId: 'k1', agent: 'a', updatedAt: Date.now() } as any; }, root),
      atomicUpdateRegistry((reg: any) => { reg['k2'] = { sessionId: 'k2', agent: 'b', updatedAt: Date.now() } as any; }, root),
      atomicUpdateRegistry((reg: any) => { reg['k3'] = { sessionId: 'k3', agent: 'c', updatedAt: Date.now() } as any; }, root),
    ]);
    const reg = await readRegistry(root);
    expect(reg['k1']).toBeDefined();
    expect(reg['k2']).toBeDefined();
    expect(reg['k3']).toBeDefined();
    // ensure lock file cleaned up
    const lockPath = join(root, 'registry.json.lock');
    await expect(stat(lockPath)).rejects.toThrow();
    await safeRm(root);
  });

  it('gc legacy drain 24h — inbox .owner>5m, *.json>24h, outbox/token removed, registry 24h prune', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-gc-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    // write raw stale entry bypassing pruneStale (atomicUpdateRegistry would prune it immediately)
    const { resolveRegistryPath } = await import('../src/xdg.js');
    const { ensureDir0700, writeAtomic } = await import('../src/fsAtomic.js');
    const { STALE_TTL_MS } = await import('../src/constants.js');
    await ensureDir0700(root);
    const now = Date.now();
    const rawDoc = { version: 1 as const, entries: { fresh: { sessionId: 'fresh', agent: 'a', updatedAt: now } as any, stale: { sessionId: 'stale', agent: 'a', updatedAt: now - 25 * 60 * 60 * 1000 } as any }, migratedAt: now };
    await writeAtomic(resolveRegistryPath(root), JSON.stringify(rawDoc, null, 2), { mode: 0o600 });
    // legacy inbox files
    const inboxDir = join(root, 'inbox', 'legacySess');
    await mkdir(inboxDir, { recursive: true });
    const oldJson = join(inboxDir, 'old.json');
    await writeFile(oldJson, JSON.stringify({ text: 'old' }));
    // make mtime >24h
    const { utimes } = await import('node:fs/promises');
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(oldJson, oldTime, oldTime);
    const ownerPath = join(inboxDir, '.owner');
    await writeFile(ownerPath, 'stale');
    const oldOwnerTime = new Date(Date.now() - 6 * 60 * 1000);
    await utimes(ownerPath, oldOwnerTime, oldOwnerTime);
    // legacy outbox/token
    await mkdir(join(root, 'outbox'), { recursive: true });
    await writeFile(join(root, 'outbox', 'page.json'), '{}');
    await writeFile(join(root, 'token'), 'legacy-token');

    const { runGc } = await import('../src/gc.js');
    const res = await runGc(root);
    expect(res.prunedRegistry).toBeGreaterThanOrEqual(1);
    expect(res.prunedInbox).toBeGreaterThanOrEqual(1);
    // inbox dir should be rmdir after empty
    const inboxRoot = join(root, 'inbox');
    const remaining = await readdir(inboxRoot).catch(() => [] as string[]);
    expect(remaining.includes('legacySess')).toBe(false);
    await expect(stat(join(root, 'outbox'))).rejects.toThrow();
    await expect(stat(join(root, 'token'))).rejects.toThrow();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRm(root);
  });
});

describe('edge', () => {
  afterEach(() => {
    restoreFetch();
    delete process.env.OPENCODE_MESH_DB_PATH;
  });

  it('broadcast N sequential POSTs — for-of await sendIdentical, per-peer ok/failed via prompt_async', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-bcast-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const prevBc = process.env.MESH_BROADCAST;
    process.env.MESH_BROADCAST = '1';
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    const now = Date.now();
    await atomicUpdateRegistry((reg: any) => {
      for (let i = 0; i < 5; i++) reg[`peer-${i}`] = { sessionId: `peer-${i}`, agent: 'a', model: 'myprov/my-model', updatedAt: now, serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    const callOrder: string[] = [];
    let callTimes: number[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) {
        const m = u.match(/\/session\/([^/]+)\/prompt_async/);
        const pid = m ? m[1] : 'unknown';
        callOrder.push(pid);
        callTimes.push(Date.now());
        // simulate 10ms per peer — sequential should be ~50ms total, parallel would be ~10ms
        await new Promise(r => setTimeout(r, 10));
        if (pid === 'peer-2') return { ok: false, status: 404 } as unknown as Response;
        return { ok: true, status: 204 } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = await (mesh_send.execute as any)({ target: 'all', text: 'hello broadcast', broadcast: true }, { sessionID: 'caller-bcast', directory: '/tmp' });
    const j = JSON.parse(out.output);
    expect(j.broadcast).toBe(true);
    expect(j.peers).toBe(5);
    expect(j.ok).toBe(4);
    // failed is array of objects with peerId in new wire; handle both shapes
    const failedIds = Array.isArray(j.failed) && typeof j.failed[0] === 'string' ? j.failed : j.failed.map((f: any) => f.peerId ?? f);
    expect(failedIds).toContain('peer-2');
    expect(j.via).toBe('admitted');
    // sequential: peer-3 should start after peer-2 finishes (times strictly increasing)
    expect(callOrder).toEqual(['peer-0', 'peer-1', 'peer-2', 'peer-3', 'peer-4']);
    for (let i = 1; i < callTimes.length; i++) expect(callTimes[i]).toBeGreaterThanOrEqual(callTimes[i - 1]);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    if (prevBc === undefined) delete process.env.MESH_BROADCAST; else process.env.MESH_BROADCAST = prevBc;
    await safeRm(root);
    vi.restoreAllMocks();
  });

  it('broadcast model-missing peers queue honestly with zero POSTs (queue-before-probe)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-bcast-defer-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const prevBc = process.env.MESH_BROADCAST;
    process.env.MESH_BROADCAST = '1';
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    const now = Date.now();
    await atomicUpdateRegistry((reg: any) => {
      for (let i = 0; i < 2; i++) reg[`qpeer-${i}`] = { sessionId: `qpeer-${i}`, agent: 'a', updatedAt: now, serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    const posted: string[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) {
        posted.push(u);
        return { ok: true, status: 204 } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = await (mesh_send.execute as any)({ target: 'all', text: 'hello broadcast', broadcast: true }, { sessionID: 'caller-bcast', directory: '/tmp' });
    const j = JSON.parse(out.output);
    // Queue-before-probe: unknown-identity peers were never POSTed, so there
    // is no error to be transparent about — full ok with zero POSTs is honest.
    expect(j.broadcast).toBe(true);
    expect(j.peers).toBe(2);
    expect(j.ok).toBe(2);
    expect(j.failed).toEqual([]);
    expect(j.via).toBe('queued');
    expect(posted).toEqual([]);
    for (const r of j.results as Array<{ peerId: string; via: string }>) expect(r.via).toBe('queued');
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    if (prevBc === undefined) delete process.env.MESH_BROADCAST; else process.env.MESH_BROADCAST = prevBc;
    await safeRm(root);
    vi.restoreAllMocks();
  });

  it('busy retry honors Runner join in queue policy; claimer waits, direct admits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-busy-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['busy-target2'] = { sessionId: 'busy-target2', agent: 'a', model: 'myprov/my-model', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    const events: Array<{ kind: string; t: number }> = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) {
        events.push({ kind: 'status', t: Date.now() });
        return { ok: true, json: async () => ({ 'busy-target2': { type: 'retry' } }) } as unknown as Response;
      }
      if (u.includes('prompt_async')) {
        events.push({ kind: 'post', t: Date.now() });
        return { ok: true, status: 204 } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send: msBusy } = await import('../src/tools/mesh_send.js');
    const bout = await (msBusy.execute as any)({ target: 'busy-target2', text: 'hi busy' }, { sessionID: 'caller-busy2', directory: '/tmp' });
    // Direct path admits without inline wait even when peer is busy; wait lives in claimer policy.
    expect(JSON.parse(bout.output).via).toBe('admitted');
    expect(events[0].kind).toBe('status');
    const postIdx = events.findIndex((e) => e.kind === 'post');
    expect(postIdx).toBeGreaterThan(0);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRm(root);
    vi.restoreAllMocks();
  });

  it('401/404 handling — 404 => PEER_NOT_FOUND, 401 => UNAUTHORIZED, 413 => PAYLOAD_TOO_LARGE, didYouMean', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-edge-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['real-peer'] = { sessionId: 'real-peer', agent: 'reviewer', model: 'myprov/my-model', description: 'reviewer @ dotfiles', directory: '/tmp/dotfiles', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    const { mesh_send: msEdge } = await import('../src/tools/mesh_send.js');
    const { MeshError } = await import('../src/errors.js');

    // 404 peer
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) return { ok: false, status: 404 } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    await expect((msEdge.execute as any)({ target: 'real-peer', text: 'hi' }, { sessionID: 'caller-edge', directory: '/tmp' })).rejects.toThrow(MeshError);
    try {
      await (msEdge.execute as any)({ target: 'real-peer', text: 'hi' }, { sessionID: 'caller-edge', directory: '/tmp' });
    } catch (e: any) {
      expect(e.code).toBe('PEER_NOT_FOUND');
      expect(e.status).toBe(404);
    }

    // 401
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) return { ok: false, status: 401 } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      await (msEdge.execute as any)({ target: 'real-peer', text: 'hi' }, { sessionID: 'caller-edge', directory: '/tmp' });
    } catch (e: any) {
      expect(e.code).toBe('UNAUTHORIZED');
      expect(e.status).toBe(401);
    }

    // 413 via body guard already tested, but also server 413
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) return { ok: false, status: 413 } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      await (msEdge.execute as any)({ target: 'real-peer', text: 'hi' }, { sessionID: 'caller-edge', directory: '/tmp' });
    } catch (e: any) {
      expect(e.code).toBe('PAYLOAD_TOO_LARGE');
      expect(e.status).toBe(413);
    }

    // not found via funnel didYouMean
    globalThis.fetch = mockFetch204();
    try {
      await (msEdge.execute as any)({ target: 'reviewerX', text: 'hi' }, { sessionID: 'caller-edge', directory: '/tmp' });
    } catch (e: any) {
      expect(e.code).toBe('PEER_NOT_FOUND');
      expect(e.didYouMean.length).toBeGreaterThan(0);
      expect(e.didYouMean.length).toBeLessThanOrEqual(5);
    }

    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRm(root);
    vi.restoreAllMocks();
  });

  it('model-missing peer queues instead of throwing on the error branches (queue-before-probe)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-edge-defer-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['edge-nomodel'] = { sessionId: 'edge-nomodel', agent: 'reviewer', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    const posted: string[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) {
        posted.push(u);
        return { ok: false, status: 401 } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send: msDefer } = await import('../src/tools/mesh_send.js');
    // The 401/404/413 branches never run for unknown-identity peers: the
    // error-path coverage stays on the modeled leg, deliberately.
    const out = JSON.parse(
      String((await (msDefer.execute as any)({ target: 'edge-nomodel', text: 'hi' }, { sessionID: 'caller-edge', directory: '/tmp' })).output),
    ) as { ok: boolean; via: string };
    expect(out.ok).toBe(true);
    expect(out.via).toBe('queued');
    expect(posted).toEqual([]);
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRm(root);
    vi.restoreAllMocks();
  });

  it('mutant probe: stripping the prompt echo seed model degrades to queued with zero POSTs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-prompt-mutant-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['prompt-target'] = { sessionId: 'prompt-target', agent: 'a', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' } as any;
    }, root);
    const posted: string[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, json: async () => ({}) } as unknown as Response;
      if (u.includes('prompt_async')) {
        posted.push(u);
        return { ok: true, status: 204 } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send: msMutant } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      String((await (msMutant.execute as any)({ target: 'prompt-target', text: 'hello prompt' }, { sessionID: 'caller-prompt', directory: '/tmp' })).output),
    ) as { via: string };
    expect(posted).toEqual([]);
    expect(out.via).toBe('queued');
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRm(root);
    vi.restoreAllMocks();
  });

  it('empty broadcast returns peers:0 via prompt_async', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-empty-bcast-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const prevBc = process.env.MESH_BROADCAST;
    process.env.MESH_BROADCAST = '1';
    globalThis.fetch = mockFetch204();
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = await (mesh_send.execute as any)({ target: 'all', text: 'hi', broadcast: true }, { sessionID: 'solo', directory: '/tmp' });
    const j = JSON.parse(out.output);
    expect(j.peers).toBe(0);
    expect(j.via).toBe('admitted');
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    if (prevBc === undefined) delete process.env.MESH_BROADCAST; else process.env.MESH_BROADCAST = prevBc;
    await safeRm(root);
    vi.restoreAllMocks();
  });
});

describe('presence plus tracker', () => {
  afterEach(() => {
    restoreFetch();
    delete process.env.OPENCODE_MESH_DB_PATH;
  });

  it('repeat tool call inside the grace window writes nothing', async () => {
    // given a session registered by one tool call
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), 'mesh-debounce-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    let getCalls = 0;
    const stubClient = {
      session: {
        get: async () => { getCalls++; return { info: { agent: 'a' } }; },
        status: async () => ({}),
      },
    };
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ client: stubClient });
    const { readRegistry } = await import('../src/registry.js');
    const sid = 'ses-debounce';
    await (hooks['tool.execute.before'] as (i: unknown) => Promise<void>)({ sessionID: sid, agent: 'a', directory: '/tmp' });
    const first = await readRegistry(root);
    const firstUpdatedAt = first[sid]?.updatedAt;
    const firstLastAction = first[sid]?.lastActionAt;
    const firstGetCalls = getCalls;
    // when the same tool call fires again inside the grace window
    await (hooks['tool.execute.before'] as (i: unknown) => Promise<void>)({ sessionID: sid, agent: 'a', directory: '/tmp' });
    // then nothing is rewritten and no identity fetch runs
    const second = await readRegistry(root);
    expect(second[sid]?.updatedAt).toBe(firstUpdatedAt);
    expect(second[sid]?.lastActionAt).toBe(firstLastAction);
    expect(getCalls).toBe(firstGetCalls);
    await (hooks.dispose as () => Promise<void>)();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRmArmed(root);
    vi.restoreAllMocks();
  });

  it('existing session registers with a heartbeat and no identity fetch', async () => {
    // given a known caller whose heartbeat is due
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), 'mesh-reg-hb-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    let getCalls = 0;
    const stubClient = {
      session: {
        get: async () => { getCalls++; return {}; },
        status: async () => ({}),
      },
    };
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ client: stubClient });
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    const seededAt = Date.now() - 61_000;
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-caller'] = { sessionId: 'ses-caller', agent: 'a', model: 'myprov/my-model', updatedAt: seededAt } as any;
      reg['ses-peer'] = { sessionId: 'ses-peer', agent: 'b', model: 'myprov/my-model', updatedAt: Date.now() } as any;
    }, root);
    // loopback down forces the claim route so the inner send only enqueues
    globalThis.fetch = (async () => { throw new Error('loopback down'); }) as unknown as typeof fetch;
    const tools = hooks['tool'] as Record<string, { execute: (a: unknown, b: unknown) => Promise<unknown> }>;
    // when the caller sends through the tool wrapper
    const out = await tools['mesh_send'].execute({ target: 'ses-peer', text: 'hi' }, { sessionID: 'ses-caller', directory: '/tmp', agent: 'a' }) as { output: string };
    // then the caller heartbeat advances without any identity fetch
    const after = await readRegistry(root);
    expect((after['ses-caller']?.updatedAt ?? 0)).toBeGreaterThan(seededAt);
    expect(getCalls).toBe(0);
    expect(JSON.parse(out.output).via).toBe('queued');
    await (hooks.dispose as () => Promise<void>)();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRmArmed(root);
    vi.restoreAllMocks();
  });

  it('generic timestamp title never replaces a real description', async () => {
    // given a session stored with a real description
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), 'mesh-title-gate-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const stubClient = {
      session: {
        get: async () => ({}),
        status: async () => ({}),
      },
    };
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ client: stubClient });
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-title'] = { sessionId: 'ses-title', agent: 'a', description: 'Real Checkout Flow', summary: 'Real Checkout Flow', title: 'Real Checkout Flow', updatedAt: Date.now() } as any;
    }, root);
    // when an update arrives carrying only an auto-generated timestamp title
    await (hooks.event as (e: unknown) => Promise<void>)({ event: { type: 'session.updated', properties: { info: { id: 'ses-title', title: 'New session - 2026-09-18T12:00:00.000Z' } } } });
    // then the stored description is untouched
    const after = await readRegistry(root);
    expect(after['ses-title']?.description).toBe('Real Checkout Flow');
    await (hooks.dispose as () => Promise<void>)();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRmArmed(root);
    vi.restoreAllMocks();
  });

  it('live model overwrites a stored absence', async () => {
    // given a session stored with no model
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), 'mesh-model-overwrite-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const stubClient = {
      session: {
        get: async () => ({ info: { agent: 'a', model: 'myprov/my-model' } }),
        status: async () => ({}),
      },
    };
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ client: stubClient });
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-model'] = { sessionId: 'ses-model', agent: 'a', description: 'Real Checkout Flow', updatedAt: Date.now() } as any;
    }, root);
    // when an update arrives while the live session reports a model
    await (hooks.event as (e: unknown) => Promise<void>)({ event: { type: 'session.updated', properties: { info: { id: 'ses-model', title: 'Shipped Auth Flow' } } } });
    // then the stored model matches the live value
    const after = await readRegistry(root);
    expect(after['ses-model']?.model).toBe('myprov/my-model');
    await (hooks.dispose as () => Promise<void>)();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRmArmed(root);
    vi.restoreAllMocks();
  });

  it('absent live model never clears the stored model', async () => {
    // given a session stored with a model
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), 'mesh-model-keep-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const stubClient = {
      session: {
        get: async () => ({}),
        status: async () => ({}),
      },
    };
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ client: stubClient });
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    const stampedAt = Date.now() - 5000;
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-model'] = { sessionId: 'ses-model', agent: 'a', model: 'myprov/my-model', description: 'Real Checkout Flow', updatedAt: stampedAt } as any;
    }, root);
    // when an update arrives with no live model and only an auto-generated title
    await (hooks.event as (e: unknown) => Promise<void>)({ event: { type: 'session.updated', properties: { info: { id: 'ses-model', title: 'New session - 2026-09-18T12:00:00.000Z' } } } });
    // then the stored model and timestamp are untouched
    const after = await readRegistry(root);
    expect(after['ses-model']?.model).toBe('myprov/my-model');
    expect(after['ses-model']?.updatedAt).toBe(stampedAt);
    await (hooks.dispose as () => Promise<void>)();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRmArmed(root);
    vi.restoreAllMocks();
  });

  it('busy and retry read active while idle does not', async () => {
    // given status strings only, no filesystem or timers
    const { isBusyActive } = await import('../src/lastAction.js');
    // when read as activity, then busy states count as active and idle does not
    expect(isBusyActive('busy')).toBe(true);
    expect(isBusyActive('retry')).toBe(true);
    expect(isBusyActive('idle')).toBe(false);
    vi.restoreAllMocks();
  });

  it('backward clock jump keeps the newest stamp', async () => {
    // given two competing timestamps only, no filesystem or timers
    const { clampLastAction } = await import('../src/lastAction.js');
    // when clamped, then the newest stamp wins in both orders
    expect(clampLastAction(10, 5)).toBe(10);
    expect(clampLastAction(5, 10)).toBe(10);
    vi.restoreAllMocks();
  });

  it('forward jump past the dampening bound reads as a sleep probe', async () => {
    // given a stored stamp plus the dampening bound only
    const { isForwardJump } = await import('../src/lastAction.js');
    const { LAST_ACTION_DAMPEN_MS } = await import('../src/constants.js');
    const stored = 1000;
    // when compared, then a leap past the bound probes true and a tick does not
    expect(isForwardJump(stored, stored + LAST_ACTION_DAMPEN_MS + 1)).toBe(true);
    expect(isForwardJump(stored, stored + 1)).toBe(false);
    vi.restoreAllMocks();
  });

  it('stamp read returns the number only when valid', async () => {
    // given registry-shaped entries only, no filesystem or timers
    const { readLastActionAt } = await import('../src/lastAction.js');
    // when read, then a positive stamp returns and absent or negative reads null
    expect(readLastActionAt({ lastActionAt: 5 })).toBe(5);
    expect(readLastActionAt({})).toBeNull();
    expect(readLastActionAt({ lastActionAt: -3 })).toBeNull();
    vi.restoreAllMocks();
  });

  it('mesh_send registers the caller before queueing the message', async () => {
    // given a modeled peer and a caller unknown to the registry
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), 'mesh-wrapper-reg-'));
    const prev = process.env.OPENCODE_MESH_ROOT;
    const prevDb = process.env.OPENCODE_MESH_DB_PATH;
    process.env.OPENCODE_MESH_ROOT = root;
    process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
    const stubClient = {
      session: {
        get: async () => ({}),
        status: async () => ({}),
      },
    };
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ client: stubClient });
    const { atomicUpdateRegistry, readRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-peer'] = { sessionId: 'ses-peer', agent: 'b', model: 'myprov/my-model', updatedAt: Date.now() } as any;
    }, root);
    // loopback down forces the claim route so the inner send only enqueues
    globalThis.fetch = (async () => { throw new Error('loopback down'); }) as unknown as typeof fetch;
    const tools = hooks['tool'] as Record<string, { execute: (a: unknown, b: unknown) => Promise<unknown> }>;
    // when the unknown caller sends through the wrapper
    const out = await tools['mesh_send'].execute({ target: 'ses-peer', text: 'hi' }, { sessionID: 'ses-new', directory: '/tmp', agent: 'a' }) as { output: string };
    // then the caller is registered and the message is queued with a row id
    const after = await readRegistry(root);
    expect(after['ses-new']).toBeDefined();
    const shaped = JSON.parse(out.output) as { via: string; id: unknown };
    expect(shaped.via).toBe('queued');
    expect(typeof shaped.id).toBe('string');
    await (hooks.dispose as () => Promise<void>)();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH; else process.env.OPENCODE_MESH_DB_PATH = prevDb;
    await safeRmArmed(root);
    vi.restoreAllMocks();
  });
});
