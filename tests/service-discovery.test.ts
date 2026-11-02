// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  parseServiceRecord,
  readServiceRecord,
  readServiceRecordSync,
  resetServiceRecordCache,
  withDiscoveredPorts,
  getServiceAuthHeader,
  getServiceAuthHeaderSync,
  resolveServiceStateDir,
  resolveServiceRecordPath,
} from '../src/serviceDiscovery.js';

afterEach(() => {
  resetServiceRecordCache();
  delete process.env.XDG_STATE_HOME;
  delete process.env.MESH_SERVICE_DISCOVERY;
  vi.restoreAllMocks();
});

describe('serviceDiscovery: parser unit', () => {
  it('parses valid loopback service.json flat shape', () => {
    const json = JSON.stringify({
      url: 'http://127.0.0.1:49374',
      password: 'test-pw-123',
    });
    const parsed = parseServiceRecord(json);
    expect(parsed).not.toBeNull();
    expect(parsed?.port).toBe(49374);
    expect(parsed?.password).toBe('test-pw-123');
    expect(parsed?.username).toBeUndefined();
  });

  it('parses localhost and custom username', () => {
    const json = JSON.stringify({
      url: 'http://localhost:19999',
      username: 'custom-admin',
      password: 'xyz',
    });
    const parsed = parseServiceRecord(json);
    expect(parsed?.port).toBe(19999);
    expect(parsed?.username).toBe('custom-admin');
    expect(parsed?.password).toBe('xyz');
  });

  it('rejects non-loopback host url', () => {
    const json = JSON.stringify({
      url: 'http://10.0.0.1:4096',
      password: 'leak',
    });
    expect(parseServiceRecord(json)).toBeNull();
  });

  it('returns null on invalid JSON or missing port', () => {
    expect(parseServiceRecord('{')).toBeNull();
    expect(parseServiceRecord(JSON.stringify({ password: 'no-url' }))).toBeNull();
  });
});

describe('serviceDiscovery: path resolution and file reads', () => {
  it('respects XDG_STATE_HOME for record location', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'mesh-xdg-'));
    process.env.XDG_STATE_HOME = tempDir;
    expect(resolveServiceStateDir()).toBe(join(tempDir, 'opencode'));
    expect(resolveServiceRecordPath()).toBe(join(tempDir, 'opencode', 'service.json'));
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads record async and sync when file exists under XDG_STATE_HOME', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'mesh-state-'));
    const opencodeDir = join(tempDir, 'opencode');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(opencodeDir, { recursive: true });
    const recordFile = join(opencodeDir, 'service.json');
    await writeFile(
      recordFile,
      JSON.stringify({ url: 'http://127.0.0.1:52345', password: 'secret-pass' }),
      'utf8',
    );
    process.env.XDG_STATE_HOME = tempDir;

    const asyncRec = await readServiceRecord({ noCache: true });
    expect(asyncRec?.port).toBe(52345);
    expect(asyncRec?.password).toBe('secret-pass');

    const syncRec = readServiceRecordSync();
    expect(syncRec?.port).toBe(52345);

    const asyncAuth = await getServiceAuthHeader(asyncRec);
    expect(asyncAuth).toBe(`Basic ${Buffer.from('opencode:secret-pass').toString('base64')}`);

    const syncAuth = getServiceAuthHeaderSync(syncRec);
    expect(syncAuth).toBe(`Basic ${Buffer.from('opencode:secret-pass').toString('base64')}`);

    await rm(tempDir, { recursive: true, force: true });
  });

  it('honors MESH_SERVICE_DISCOVERY=0 opt-out', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'mesh-optout-'));
    const opencodeDir = join(tempDir, 'opencode');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(
      join(opencodeDir, 'service.json'),
      JSON.stringify({ url: 'http://127.0.0.1:52345', password: 'secret-pass' }),
      'utf8',
    );
    process.env.XDG_STATE_HOME = tempDir;
    process.env.MESH_SERVICE_DISCOVERY = '0';

    expect(await readServiceRecord()).toBeNull();
    expect(readServiceRecordSync()).toBeNull();
    await rm(tempDir, { recursive: true, force: true });
  });
});

describe('serviceDiscovery: withDiscoveredPorts folding', () => {
  it('prepends discovered port and dedupes without exceeding limit', async () => {
    const fakeRecord = { port: 49374, username: 'opencode', password: 'pw', mtimeMs: 1 };
    const ports = [4096, 4100, 49374, 4200];
    const folded = await withDiscoveredPorts(ports, { record: fakeRecord, limit: 3 });
    expect(folded).toEqual([49374, 4096, 4100]);
  });

  it('returns untouched list when no record discovered', async () => {
    const ports = [4096, 4100];
    const folded = await withDiscoveredPorts(ports, { record: null });
    expect(folded).toEqual([4096, 4100]);
  });
});
