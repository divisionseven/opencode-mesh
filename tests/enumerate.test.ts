// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Bounded local enumeration.
// Mocked fetch: deterministic sightings, timeout budget, bounded set.
import { describe, expect, it, vi, afterEach } from 'vitest';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch as unknown as typeof fetch;
  vi.resetModules();
  vi.restoreAllMocks();
  delete process.env.MESH_ENUM_PORTS;
});

describe('enumerateServers', () => {
  it('reports reachable + unreachable with epoch and fingerprint, bounded set', async () => {
    process.env.MESH_ENUM_PORTS = '4096,4101,4199,4200,4201,4202,4203,4204,4205';
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('127.0.0.1:4096/')) return { ok: true, status: 200, text: async () => '{"a":{}}' } as unknown as Response;
      if (u.includes('127.0.0.1:4101/')) return { ok: true, status: 200, text: async () => '{"b":{}}' } as unknown as Response;
      throw new Error('refused');
    }) as unknown as typeof fetch;
    const { enumerateServers, ENUM_MAX_PORTS } = await import('../src/enumerate.js');
    const seen = await enumerateServers(undefined, 500);
    // bounded: 9 requested, capped at ENUM_MAX_PORTS
    expect(seen.length).toBe(ENUM_MAX_PORTS);
    const up = seen.filter((s) => s.reachable);
    expect(up.length).toBe(2);
    for (const s of seen) {
      expect(typeof s.observedAt).toBe('number');
      expect(s.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(up[0].fingerprint.length).toBe(40);
    expect(up[0].fingerprint).not.toBe(up[1].fingerprint);
    const down = seen.find((s) => s.port === 4199)!;
    expect(down.reachable).toBe(false);
    expect(down.fingerprint).toBe('');
  });

  it('defaults to OPENCODE_PORT loopback when no env set', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return { ok: true, status: 200, text: async () => '{}' } as unknown as Response;
    }) as unknown as typeof fetch;
    const { enumerateServers } = await import('../src/enumerate.js');
    const seen = await enumerateServers();
    expect(seen.length).toBe(1);
    expect(urls[0]).toContain('127.0.0.1');
    expect(seen[0].reachable).toBe(true);
  });

  it('garbage env entries filter out before the default applies', async () => {
    process.env.MESH_ENUM_PORTS = 'abc,,99999,0,-5';
    globalThis.fetch = (async () => ({ ok: false, status: 500, text: async () => '' })) as unknown as typeof fetch;
    const { enumerateServers } = await import('../src/enumerate.js');
    const seen = await enumerateServers(undefined, 50);
    expect(seen.length).toBe(1);
    expect(seen[0].port).toBe(4096);
  });

  it('explicit ports beat the env list', async () => {
    process.env.MESH_ENUM_PORTS = '4101';
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return { ok: false, status: 500, text: async () => '' } as unknown as Response;
    }) as unknown as typeof fetch;
    const { enumerateServers } = await import('../src/enumerate.js');
    await enumerateServers([4201], 50);
    expect(urls.length).toBe(1);
    expect(urls[0]).toContain('127.0.0.1:4201/');
  });

  it('duplicate ports dedupe and cap at the max', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 500, text: async () => '' })) as unknown as typeof fetch;
    const { enumerateServers, ENUM_MAX_PORTS } = await import('../src/enumerate.js');
    const seen = await enumerateServers([4096, 4096, 4101, 4102, 4103, 4104, 4105, 4106, 4107, 4108], 50);
    expect(seen.length).toBe(ENUM_MAX_PORTS);
    expect(new Set(seen.map((s) => s.port)).size).toBe(seen.length);
  });

  it('probe attaches the auth header when a server password is set', async () => {
    const prev = process.env.OPENCODE_SERVER_PASSWORD;
    process.env.OPENCODE_SERVER_PASSWORD = 's3cret';
    const headers: unknown[] = [];
    globalThis.fetch = (async (_url: string, init: { headers?: unknown }) => {
      headers.push(init?.headers);
      return { ok: true, status: 200, text: async () => '{}' } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      const { probePort } = await import('../src/enumerate.js');
      const sight = await probePort(4096, 500);
      expect(sight.reachable).toBe(true);
      expect(headers[0]).toMatchObject({ Authorization: expect.stringContaining('Basic ') });
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
      else process.env.OPENCODE_SERVER_PASSWORD = prev;
    }
  });

  it('non-ok probe reads unreachable with an empty body', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 500, text: async () => 'err' })) as unknown as typeof fetch;
    const { probePort } = await import('../src/enumerate.js');
    const sight = await probePort(4096, 500);
    expect(sight.reachable).toBe(false);
    expect(sight.fingerprint).toBe('');
  });

  it('ok probe with an empty body reads an empty fingerprint', async () => {
    globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => '' })) as unknown as typeof fetch;
    const { probePort } = await import('../src/enumerate.js');
    const sight = await probePort(4096, 500);
    expect(sight.reachable).toBe(true);
    expect(sight.fingerprint).toBe('');
  });
});
