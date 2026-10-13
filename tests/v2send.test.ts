// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// v2 send legs: v1 dead plus v2 alive admits via user admission, v2
// dead queues, v2 misses stay loud, and v1 admits never touch v2 paths.
// Given a hermetic root plus stubbed loopback fetch, when mesh_send runs,
// then the via vocabulary matches the reachable horizontals exactly.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch as unknown as typeof fetch;
  vi.restoreAllMocks();
  delete process.env.MESH_ENUM_PORTS;
});

async function freshRoot(
  prefix: string,
): Promise<{ root: string; restore: () => void }> {
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
      if (
        (code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM') &&
        attempt < 2
      ) {
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      throw err;
    }
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function seedPeer(
  peerId: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const { atomicUpdateRegistry } = await import('../src/registry.js');
  await atomicUpdateRegistry((reg: Record<string, unknown>) => {
    reg['v2-caller'] = {
      sessionId: 'v2-caller',
      agent: 'manager',
      updatedAt: Date.now(),
    };
    reg[peerId] = { sessionId: peerId, updatedAt: Date.now(), ...entry };
  });
}

/** v1 horizontal dead, v2 horizontal alive on 4501 with a full triple. */
function stubV2Alive(calls: string[], promptStatus = 200) {
  return (async (url: unknown, init?: unknown) => {
    const u = String(url);
    calls.push(`${(init as { method?: string })?.method ?? 'GET'} ${u}`);
    if (u === 'http://127.0.0.1:4096/session/status') {
      return new Response('down', { status: 404 });
    }
    if (u === 'http://127.0.0.1:4501/session/status') {
      return new Response('gone', { status: 404 });
    }
    if (u === 'http://127.0.0.1:4501/api/session/active') {
      return jsonResponse({ data: { 'v2-peer': { type: 'running' } } });
    }
    if (u === 'http://127.0.0.1:4501/session/v2-peer') {
      return new Response('gone', { status: 404 });
    }
    if (u === 'http://127.0.0.1:4501/api/session/v2-peer') {
      return jsonResponse({
        data: {
          id: 'v2-peer',
          agent: 'alfred',
          model: { providerID: 'acme', id: 'reasoner' },
          title: 'Alfred relay',
        },
      });
    }
    if (u === 'http://127.0.0.1:4501/api/session/v2-peer/prompt') {
      if (promptStatus === 200) return jsonResponse({ id: 'inbox_9' });
      return new Response('miss', { status: promptStatus });
    }
    return new Response('miss', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('v2 send legs', () => {
  it('v1 dead plus v2 alive admits via user prompt with steer delivery', async () => {
    const { root, restore } = await freshRoot('v2send-');
    process.env.MESH_ENUM_PORTS = '4501';
    await seedPeer('v2-peer', { agent: 'alfred' });
    const calls: string[] = [];
    globalThis.fetch = stubV2Alive(calls);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      String(
        (
          await (mesh_send.execute as any)(
            { target: 'v2-peer', text: 'hello v2' },
            {
              sessionID: 'v2-caller',
              directory: '/tmp/repo',
              agent: 'manager',
            },
          )
        ).output,
      ),
    ) as { ok: boolean; via: string; id: string };
    expect(out.ok).toBe(true);
    expect(out.via).toBe('admitted');
    expect(out.id).toBe('inbox_9');
    const posts = calls.filter((c) => c.includes('/prompt'));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('POST http://127.0.0.1:4501/api/session/v2-peer/prompt');
    expect(calls.some((c) => c.includes('prompt_async'))).toBe(false);
    await safeRm(root);
    restore();
  });

  it('silent messages ride user prompt with queue delivery', async () => {
    const { root, restore } = await freshRoot('v2send-quiet-');
    process.env.MESH_ENUM_PORTS = '4501';
    await seedPeer('v2-peer', { agent: 'alfred' });
    const bodies: string[] = [];
    const base = stubV2Alive([]);
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      const res = await (base as (u: unknown, i?: unknown) => Promise<Response>)(
        url,
        init,
      );
      if (String(url).includes('/prompt')) {
        bodies.push(String((init as { body?: string })?.body ?? ''));
      }
      return res;
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      String(
        (
          await (mesh_send.execute as any)(
            { target: 'v2-peer', text: 'quiet v2', silent: true },
            { sessionID: 'v2-caller', agent: 'manager' },
          )
        ).output,
      ),
    ) as { via: string };
    expect(out.via).toBe('admitted');
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]).delivery).toBe('queue');
    await safeRm(root);
    restore();
  });

  it('every horizontal dark queues the row', async () => {
    const { root, restore } = await freshRoot('v2send-dark-');
    process.env.MESH_ENUM_PORTS = '4501';
    await seedPeer('v2-peer', { agent: 'alfred' });
    globalThis.fetch = (async () => {
      throw new Error('refused');
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      String(
        (
          await (mesh_send.execute as any)(
            { target: 'v2-peer', text: 'hello?' },
            { sessionID: 'v2-caller', agent: 'manager' },
          )
        ).output,
      ),
    ) as { via: string };
    expect(out.via).toBe('queued');
    await safeRm(root);
    restore();
  });

  it('v2 prompt miss stays loud with peer hints', async () => {
    const { root, restore } = await freshRoot('v2send-miss-');
    process.env.MESH_ENUM_PORTS = '4501';
    await seedPeer('v2-peer', { agent: 'alfred' });
    globalThis.fetch = stubV2Alive([], 404);
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    await expect(
      (mesh_send.execute as any)(
        { target: 'v2-peer', text: 'hello?' },
        { sessionID: 'v2-caller', agent: 'manager' },
      ),
    ).rejects.toMatchObject({ code: 'PEER_NOT_FOUND' });
    await safeRm(root);
    restore();
  });

describe('v2 prompt status mapping', () => {
  async function sendWithPromptStatus(status: number | 'throw') {
    const { root, restore } = await freshRoot('v2send-status-');
    process.env.MESH_ENUM_PORTS = '4501';
    await seedPeer('v2-peer', { agent: 'alfred' });
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u === 'http://127.0.0.1:4501/api/session/active') {
        return jsonResponse({ data: { 'v2-peer': { type: 'running' } } });
      }
      if (u === 'http://127.0.0.1:4501/api/session/v2-peer') {
        return jsonResponse({
          data: {
            id: 'v2-peer',
            agent: 'alfred',
            model: { providerID: 'p', id: 'm' },
          },
        });
      }
      if (u === 'http://127.0.0.1:4501/api/session/v2-peer/prompt') {
        if (status === 'throw') throw new Error('reset');
        return new Response('miss', { status: status as number });
      }
      return new Response('down', { status: 404 });
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    try {
      const out = JSON.parse(
        String(
          (
            await (mesh_send.execute as any)(
              { target: 'v2-peer', text: 'hello' },
              { sessionID: 'v2-caller', agent: 'manager' },
            )
          ).output,
        ),
      ) as { via: string };
      return { outcome: 'resolved' as const, via: out.via };
    } catch (err) {
      return {
        outcome: 'rejected' as const,
        code: (err as { code?: string }).code,
      };
    } finally {
      delete process.env.MESH_ENUM_PORTS;
      await safeRm(root);
      restore();
    }
  }

  it('busy retries queue instead of surfacing', async () => {
    const r = await sendWithPromptStatus(429);
    expect(r).toEqual({ outcome: 'resolved', via: 'queued' });
  });

  it('auth mismatch stays loud', async () => {
    const r = await sendWithPromptStatus(401);
    expect(r).toEqual({ outcome: 'rejected', code: 'UNAUTHORIZED' });
  });

  it('oversize stays loud', async () => {
    const r = await sendWithPromptStatus(413);
    expect(r).toEqual({ outcome: 'rejected', code: 'PAYLOAD_TOO_LARGE' });
  });

  it('transport faults degrade to queue', async () => {
    const r = await sendWithPromptStatus('throw');
    expect(r).toEqual({ outcome: 'resolved', via: 'queued' });
  });
});

  it('v1 admit never touches v2 paths', async () => {
    const { root, restore } = await freshRoot('v2send-v1-');
    await seedPeer('v2-peer', { agent: 'alfred', model: 'acme/reasoner' });
    const calls: string[] = [];
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      const u = String(url);
      calls.push(`${(init as { method?: string })?.method ?? 'GET'} ${u}`);
      if (u.includes('prompt_async')) {
        return { ok: true, status: 204 } as unknown as Response;
      }
      if (u.includes('/session/status')) return jsonResponse({});
      if (u.includes('/session/v2-peer') && !u.includes('/api/')) {
        return jsonResponse({ agent: 'alfred', model: 'acme/reasoner' });
      }
      return new Response('miss', { status: 404 });
    }) as unknown as typeof fetch;
    const { mesh_send } = await import('../src/tools/mesh_send.js');
    const out = JSON.parse(
      String(
        (
          await (mesh_send.execute as any)(
            { target: 'v2-peer', text: 'hello v1' },
            { sessionID: 'v2-caller', agent: 'manager' },
          )
        ).output,
      ),
    ) as { via: string };
    expect(out.via).toBe('admitted');
    expect(calls.some((c) => c.includes('/api/'))).toBe(false);
    await safeRm(root);
    restore();
  });
});
