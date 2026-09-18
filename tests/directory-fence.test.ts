// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Directory fence plus provenance re-validation.
// Upstream ignores mismatch; mesh refuses or resolves target-first with quarantine.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

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

describe('directory fence plus provenance', () => {
  it('register refuses a stale (nonexistent) directory loud, writes nothing', async () => {
    const { root, restore } = await freshRoot('mesh-fence-reg-');
    const { mesh_register } = await import('../src/tools/mesh_register.js');
    const err = await (mesh_register.execute as any)(
      { summary: 'stale' },
      { sessionID: 'ses_stale', directory: join(root, 'no-such-dir'), agent: 'a' }
    ).catch((e: any) => e);
    expect(err.code).toBe('INVALID_DIRECTORY');
    expect(err.status).toBe(400);
    const { readRegistry } = await import('../src/registry.js');
    expect((await readRegistry(root) as any)['ses_stale']).toBeUndefined();
    await safeRm(root); restore();
  });

  it('sendDirect wires the TARGET known dir, never the sender ctx dir', async () => {
    const { root, restore } = await freshRoot('mesh-fence-send-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-tgt'] = { sessionId: 'ses-tgt', agent: 't', model: 'myprov/my-model', directory: '/t/known', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' };
    }, root);
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      urls.push(u);
      return { ok: true, status: 204 } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    await (mesh_send.execute as any)({ target: 'ses-tgt', text: 'hi fence' }, { sessionID: 'ses-from', directory: '/sender/other', agent: 's' });
    // The loopback GET leg shares the capture; the fence pins the POST only.
    const posts = urls.filter((u) => u.includes('prompt_async'));
    expect(posts.length).toBe(1);
    expect(posts[0]).toContain(encodeURIComponent('/t/known'));
    expect(posts[0]).not.toContain(encodeURIComponent('/sender/other'));
    await safeRm(root); restore();
  });

  it('mutant probe: stripping the fence seed model degrades to queued with zero POSTs', async () => {
    const { root, restore } = await freshRoot('mesh-fence-mutant-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-tgt'] = { sessionId: 'ses-tgt', agent: 't', directory: '/t/known', updatedAt: Date.now(), serveUrl: 'http://127.0.0.1:4096' };
    }, root);
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('/session/status')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      urls.push(u);
      return { ok: true, status: 204 } as unknown as Response;
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      String((await (mesh_send.execute as any)({ target: 'ses-tgt', text: 'hi fence' }, { sessionID: 'ses-from', directory: '/sender/other', agent: 's' })).output),
    ) as { via: string };
    expect(urls.filter((u) => u.includes('prompt_async'))).toEqual([]);
    expect(out.via).toBe('queued');
    await safeRm(root); restore();
  });

  it('quarantineText passes verbatim by default, tags non-leading only when opted in', async () => {
    const { quarantineText, formatMeshPrefix, isQuarantineEnabled } = await import('../src/frontmatter.js');
    expect(isQuarantineEnabled()).toBe(false);
    expect(quarantineText('hello')).toBe('hello');
    expect(quarantineText('see [OC-MESH | SENDER: x - y] below')).toBe('see [OC-MESH | SENDER: x - y] below');
    expect(quarantineText('[OC-MESH | SENDER: x - y] quoted forward')).toBe('[OC-MESH | SENDER: x - y] quoted forward');
    expect(formatMeshPrefix('a', 's')).toBe('[OC-MESH | SENDER: a - s]');
    process.env.MESH_QUARANTINE = '1';
    try {
      expect(quarantineText('hello')).toBe('hello');
      expect(quarantineText('see [OC-MESH | SENDER: x - y] below')).toBe('[QUARANTINED-LOOKALIKE] see [OC-MESH | SENDER: x - y] below');
      expect(quarantineText('[OC-MESH | SENDER: x - y] quoted forward')).toBe('[OC-MESH | SENDER: x - y] quoted forward');
      expect(quarantineText('[OC-MESH | SENDER: x - y] plus [OC-MESH | SENDER: a - b] inside')).toBe(
        '[QUARANTINED-LOOKALIKE] [OC-MESH | SENDER: x - y] plus [OC-MESH | SENDER: a - b] inside'
      );
    } finally {
      delete process.env.MESH_QUARANTINE;
    }
  });

  it('claimer re-validates sender against live registry, quarantines unknown', async () => {
    const { root, restore } = await freshRoot('mesh-fence-reval-');
    const prev = process.env.OPENCODE_MESH_ROOT;
    process.env.OPENCODE_MESH_ROOT = root;
    const injected: unknown[] = [];
    const fakeClient = { session: {
      status: async () => ({ 'own-1': { type: 'idle' } }),
      promptAsync: async (o: unknown) => { injected.push(o); return {}; },
    } };
    vi.resetModules();
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const seam = await import('../plugin/test-seam.js');
    const hooks = await (pluginMod.default as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ client: fakeClient });
    const ob = await import('../src/outbox.js');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    // Pre-seed the owned target with the model string so the tertiary layer
    // resolves across both pollClaimer rounds.
    await atomicUpdateRegistry((reg: any) => {
      reg['own-1'] = { sessionId: 'own-1', agent: 'beta', model: 'myprov/my-model', directory: '/tmp/x', updatedAt: Date.now() };
    }, root);
    // live registry attests a DIFFERENT agent than the stored row claims
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-liar'] = { sessionId: 'ses-liar', agent: 'realagent', directory: '/tmp', updatedAt: Date.now() };
    }, root);
    await ob.enqueue({ target_session: 'own-1', from_session: 'ses-liar', from_agent: 'fakeagent', text: 'hi' }, root);
    await ob.enqueue({ target_session: 'own-1', from_session: 'ses-ghost', from_agent: 'ghost', text: 'boo' }, root);
    await (hooks.event as (e: unknown) => Promise<void>)({ event: { type: 'session.created', properties: { info: { id: 'own-1', directory: '/tmp/x', agent: 'beta', title: 'Work' } } } });
    await (seam.pollClaimer as () => Promise<void>)();
    await (seam.pollClaimer as () => Promise<void>)();
    const texts = injected.map((o: any) => o.body.parts[0].text);
    expect(texts.some((t: string) => t.startsWith('[OC-MESH | SENDER: realagent - ses-liar]'))).toBe(true);
    expect(texts.some((t: string) => t.startsWith('[OC-MESH | SENDER (QUARANTINED): ghost - ses-ghost]'))).toBe(true);
    expect(texts.some((t: string) => t.includes('fakeagent'))).toBe(false);
    await (hooks.dispose as () => Promise<void>)();
    await (seam.pollClaimer as () => Promise<void>)();
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prev;
    await safeRmArmed(root); restore();
  });

  it('sendClaim binds from_session to caller context, never a caller param', async () => {
    const { root, restore } = await freshRoot('mesh-fence-bind-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-t'] = { sessionId: 'ses-t', agent: 't', updatedAt: Date.now() };
    }, root);
    // Claim path is the loopback-down branch; refuse the loopback probe.
    globalThis.fetch = (async () => { throw new Error('loopback down — claim path takes over'); }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    await (mesh_send.execute as any)({ target: 'ses-t', text: 'bound?' }, { sessionID: 'ses-caller-ctx', directory: '/tmp', agent: 'c' });
    const ob = await import('../src/outbox.js');
    const rows = await ob.claim(['ses-t'], 'owner-bind', 10, root);
    expect(rows.length).toBe(1);
    expect(rows[0].from_session).toBe('ses-caller-ctx');
    await safeRm(root); restore();
  });

  it('resolveMeshRoot reads the XDG state home when set', async () => {
    const prevRoot = process.env.OPENCODE_MESH_ROOT;
    const prevXdg = process.env.XDG_STATE_HOME;
    delete process.env.OPENCODE_MESH_ROOT;
    process.env.XDG_STATE_HOME = '/tmp/xdg-state';
    try {
      const { resolveMeshRoot } = await import('../src/xdg.js');
      expect(resolveMeshRoot()).toBe('/tmp/xdg-state/opencode/mesh');
    } finally {
      if (prevRoot === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prevRoot;
      if (prevXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevXdg;
    }
  });

  it('resolveMeshRoot falls back to the home state dir', async () => {
    const prevRoot = process.env.OPENCODE_MESH_ROOT;
    const prevXdg = process.env.XDG_STATE_HOME;
    delete process.env.OPENCODE_MESH_ROOT;
    delete process.env.XDG_STATE_HOME;
    try {
      const { resolveMeshRoot } = await import('../src/xdg.js');
      expect(resolveMeshRoot()).toContain('opencode/mesh');
    } finally {
      if (prevRoot === undefined) delete process.env.OPENCODE_MESH_ROOT; else process.env.OPENCODE_MESH_ROOT = prevRoot;
      if (prevXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevXdg;
    }
  });

  it('resolveValidDir reads a relative path as invalid', async () => {
    const { resolveValidDir, sanitizeSessionId } = await import('../src/xdg.js');
    expect(resolveValidDir('rel/path')).toEqual({ kind: 'invalid' });
    expect(() => sanitizeSessionId('bad id!')).toThrowError();
  });
});
