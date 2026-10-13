// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// v2 route legs: v1 shape first (unchanged when a v1 server answers), v2
// shape as fallback, misses read null or failure (never throw).
// Given stubbed loopback fetch, when each helper runs, then v1 hits win,
// v2 fills the gaps, and dead ports stay silent.
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  activeUnion,
  fetchV2Active,
  fetchV2Session,
  locateSession,
  portsToProbe,
  postV2Prompt,
  v2DeliveryForWake,
  v2ModelString,
  v2RowToTriple,
  v2SessionPath,
  v2PromptPath,
  V2_ACTIVE_PATH,
} from '../src/v2routes.js';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch as unknown as typeof fetch;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('v2 path builders use the /api namespace', () => {
  it('status, session, and prompt paths live under /api', () => {
    expect(V2_ACTIVE_PATH).toBe('/api/session/active');
    expect(v2SessionPath('ses_abc')).toBe('/api/session/ses_abc');
    expect(v2PromptPath('ses_abc')).toBe('/api/session/ses_abc/prompt');
  });

  it('wake admits now while silent queues', () => {
    expect(v2DeliveryForWake(undefined)).toBe('steer');
    expect(v2DeliveryForWake({})).toBe('steer');
    expect(v2DeliveryForWake({ silent: true })).toBe('queue');
    expect(v2DeliveryForWake({ noReply: true })).toBe('queue');
  });
});

describe('v2 active view unwraps the data envelope', () => {
  it('wrapped map resolves to the session map', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ data: { ses_a: { type: 'running' } } })) as typeof fetch;
    await expect(fetchV2Active(4107, undefined)).resolves.toEqual({
      ses_a: { type: 'running' },
    });
  });

  it('non-ok and network faults read null', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 404 })) as typeof fetch;
    await expect(fetchV2Active(4107, undefined)).resolves.toBeNull();
    globalThis.fetch = (async () => {
      throw new Error('refused');
    }) as typeof fetch;
    await expect(fetchV2Active(4107, undefined)).resolves.toBeNull();
  });
});

describe('session locator prefers v1 rows then v2 rows', () => {
  it('v1 hit on the first port wins without touching v2', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      seen.push(String(url));
      return jsonResponse({ info: { id: 'ses_a' } });
    }) as typeof fetch;
    const found = await locateSession('ses_a', [4107], undefined);
    expect(found).toEqual({
      kind: 'v1',
      port: 4107,
      row: { info: { id: 'ses_a' } },
    });
    expect(seen).toEqual(['http://127.0.0.1:4107/session/ses_a']);
  });

  it('v1 miss falls back to the v2 session row on the same port', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      seen.push(u);
      if (u === 'http://127.0.0.1:4107/session/ses_b') return new Response('x', { status: 404 });
      return jsonResponse({
        data: { id: 'ses_b', agent: 'alfred', model: { providerID: 'p', id: 'm' } },
      });
    }) as typeof fetch;
    const found = await locateSession('ses_b', [4107], undefined);
    expect(found?.kind).toBe('v2');
    expect(found?.port).toBe(4107);
    expect(seen).toEqual([
      'http://127.0.0.1:4107/session/ses_b',
      'http://127.0.0.1:4107/api/session/ses_b',
    ]);
  });

  it('all ports dark reads null', async () => {
    globalThis.fetch = (async () => {
      throw new Error('refused');
    }) as typeof fetch;
    await expect(locateSession('ses_z', [4107, 4108], undefined)).resolves.toBeNull();
  });
});

describe('v2 prompt inject admits on 2xx and reports misses', () => {
  it('ok with an inbox id returns it', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ id: 'inbox_1', type: 'user' })) as typeof fetch;
    await expect(
      postV2Prompt(4107, 'ses_a', 'hello', undefined, undefined),
    ).resolves.toEqual({ ok: true, id: 'inbox_1' });
  });

  it('ok without a parsable id still admits', async () => {
    globalThis.fetch = (async () =>
      new Response('done', { status: 200 })) as typeof fetch;
    const r = await postV2Prompt(4107, 'ses_a', 'hello', undefined, undefined);
    expect(r.ok).toBe(true);
  });

  it('miss statuses ride along without throwing', async () => {
    globalThis.fetch = (async () =>
      new Response('gone', { status: 404 })) as typeof fetch;
    await expect(
      postV2Prompt(4107, 'ses_a', 'hello', undefined, undefined),
    ).resolves.toEqual({ ok: false, status: 404 });
  });

  it('network faults read failure without throwing', async () => {
    globalThis.fetch = (async () => {
      throw new Error('refused');
    }) as typeof fetch;
    await expect(
      postV2Prompt(4107, 'ses_a', 'hello', undefined, undefined),
    ).resolves.toEqual({ ok: false });
  });
});

describe('active union merges v1 status with v2 active views', () => {
  it('v1 hit wins and v2 fills the next port', async () => {
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u === 'http://127.0.0.1:4096/session/status') {
        return jsonResponse({ ses_v1: { type: 'idle' } });
      }
      if (u === 'http://127.0.0.1:4107/session/status') {
        return new Response('nope', { status: 404 });
      }
      if (u === 'http://127.0.0.1:4107/api/session/active') {
        return jsonResponse({ data: { ses_v2: { type: 'running' } } });
      }
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    await expect(activeUnion([4096, 4107], undefined)).resolves.toEqual({
      ses_v1: { type: 'idle' },
      ses_v2: { type: 'running' },
    });
  });

  it('every port dark reads null', async () => {
    globalThis.fetch = (async () => {
      throw new Error('refused');
    }) as typeof fetch;
    await expect(activeUnion([4096], undefined)).resolves.toBeNull();
  });

  it('alive-but-empty servers read null without deleting anything', async () => {
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes('/session/status')) {
        return new Response('down', { status: 404 });
      }
      return jsonResponse({ data: {} });
    }) as typeof fetch;
    await expect(activeUnion([4107], undefined)).resolves.toBeNull();
  });
});

describe('v2 row helpers normalize SessionInfo to wire triples', () => {
  it('provider plus id stringify to the registry model shape', () => {
    expect(v2ModelString({ providerID: 'anthropic', id: 'claude' })).toBe(
      'anthropic/claude',
    );
    expect(v2ModelString({ providerID: 'p', modelID: 'm' })).toBe('p/m');
    expect(v2ModelString(null)).toBeUndefined();
    expect(v2ModelString({})).toBeUndefined();
  });

  it('full rows map while unknown agents and absent models read null', () => {
    expect(
      v2RowToTriple({ agent: 'alfred', model: { providerID: 'p', id: 'm' } }),
    ).toEqual({ agent: 'alfred', model: 'p/m' });
    expect(v2RowToTriple({ agent: 'unknown', model: 'p/m' })).toBeNull();
    expect(v2RowToTriple({ agent: 'alfred' })).toBeNull();
    expect(v2RowToTriple(null)).toBeNull();
  });

  it('default port probing honors the probe list', () => {
    expect(portsToProbe([4107])).toEqual([4107]);
    expect(portsToProbe([])).toEqual([4096]);
  });

  it('garbage probe env falls back to the default pin', async () => {
    process.env.MESH_ENUM_PORTS = 'abc';
    const dialed: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      dialed.push(String(url));
      return new Response('down', { status: 404 });
    }) as typeof fetch;
    try {
      await expect(activeUnion(undefined, undefined)).resolves.toBeNull();
      expect(dialed).toEqual([
        'http://127.0.0.1:4096/session/status',
        'http://127.0.0.1:4096/api/session/active',
      ]);
    } finally {
      delete process.env.MESH_ENUM_PORTS;
    }
  });
});

describe('v2 union failure modes', () => {
  it('throwing v1 leg still fills from v2 active', async () => {
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/session/status')) throw new Error('reset');
      return jsonResponse({ data: { ses_v2: { type: 'running' } } });
    }) as typeof fetch;
    await expect(activeUnion([4107], undefined)).resolves.toEqual({
      ses_v2: { type: 'running' },
    });
  });

  it('bare session rows pass through without a data envelope', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ id: 'ses_b', agent: 'a' })) as typeof fetch;
    await expect(fetchV2Session(4107, 'ses_b', undefined)).resolves.toEqual({
      id: 'ses_b',
      agent: 'a',
    });
  });

  it('scalar bodies read null instead of throwing', async () => {
    globalThis.fetch = (async () =>
      jsonResponse('bare')) as typeof fetch;
    await expect(fetchV2Session(4107, 'ses_b', undefined)).resolves.toBeNull();
  });
});

describe('v2 auth and merge precedence', () => {
  it('configured passwords ride every leg as one header', async () => {
    const seen: Array<{ url: string; auth: unknown }> = [];
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      seen.push({
        url: String(url),
        auth: (init as { headers?: Record<string, string> })?.headers?.[
          'Authorization'
        ],
      });
      if (String(url).endsWith('/api/session/active')) {
        return jsonResponse({ data: {} });
      }
      return jsonResponse({ id: 'x' });
    }) as typeof fetch;
    await fetchV2Active(4107, 'Basic abc');
    await postV2Prompt(4107, 'ses_a', 'hi', undefined, 'Basic abc');
    expect(seen).toHaveLength(2);
    for (const call of seen) expect(call.auth).toBe('Basic abc');
  });

  it('first port wins shared ids across the union', async () => {
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.startsWith('http://127.0.0.1:4107')) {
        return jsonResponse({ ses_dup: { type: 'idle' } });
      }
      if (u.startsWith('http://127.0.0.1:4108')) {
        return jsonResponse({ ses_dup: { type: 'busy' } });
      }
      return new Response('down', { status: 404 });
    }) as typeof fetch;
    await expect(activeUnion([4107, 4108], undefined)).resolves.toEqual({
      ses_dup: { type: 'idle' },
    });
  });

  it('bare json admits without an inbox id', async () => {
    globalThis.fetch = (async () =>
      new Response('"bare"', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    await expect(
      postV2Prompt(4107, 'ses_a', 'hi', undefined, undefined),
    ).resolves.toEqual({ ok: true });
  });
});
