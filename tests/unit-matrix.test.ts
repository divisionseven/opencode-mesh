// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Pure-unit matrix: expiry predicates, plugin-array splicer, attach
// parser plus poller start, mesh dir creation. No timers, no network,
// no filesystem beyond tmp scratch.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MESH_TTL_OVERRIDES_JSON;
});

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

describe('pure-unit matrix', () => {
  it('null parent reads primary, set parent reads subagent', async () => {
    const ex = await import('../src/expiry.js');
    expect(ex.deriveSessionType(null)).toBe('primary');
    expect(ex.deriveSessionType(undefined)).toBe('primary');
    expect(ex.deriveSessionType('ses-parent')).toBe('subagent');
  });

  it('ttl overrides keep positive integers and drop the rest', async () => {
    process.env.MESH_TTL_OVERRIDES_JSON = '{"a":5,"b":"x","c":-1,"d":1.5}';
    const ex = await import('../src/expiry.js');
    expect(ex.readTtlOverrides()).toEqual({ a: 5 });
    process.env.MESH_TTL_OVERRIDES_JSON = 'not json{{{';
    expect(ex.readTtlOverrides()).toEqual({});
    delete process.env.MESH_TTL_OVERRIDES_JSON;
    expect(ex.readTtlOverrides()).toEqual({});
  });

  it('entry without any stamp collects as expired', async () => {
    const ex = await import('../src/expiry.js');
    expect(ex.collectExpired({ 'ses-x': { agent: 'a' } })).toEqual(['ses-x']);
  });

  it('add to text without a plugin key or brace stays unchanged', async () => {
    const cfg = await import('../src/install/opencodeConfig.js');
    expect(cfg.editPluginArrayText('no braces here', 'opencode-mesh', 'add')).toEqual({ text: 'no braces here', changed: false });
  });

  it('add to a single-line array uses the default indent', async () => {
    const cfg = await import('../src/install/opencodeConfig.js');
    const out = cfg.editPluginArrayText('{"plugin": ["other"]}', 'opencode-mesh', 'add');
    expect(out.changed).toBe(true);
    expect(out.text).toContain('"opencode-mesh"');
    expect(out.text).toContain('"other"');
  });

  it('add to an empty object writes valid JSON', async () => {
    const cfg = await import('../src/install/opencodeConfig.js');
    for (const empty of ['{}', '{\n}', '{\n  \n}']) {
      const out = cfg.editPluginArrayText(empty, 'opencode-mesh', 'add');
      expect(out.changed).toBe(true);
      expect(JSON.parse(out.text)).toEqual({ plugin: ['opencode-mesh'] });
    }
  });

  it('malformed dash-s row counts neither id nor unmapped', async () => {
    const at = await import('../src/attach.js');
    expect(at.parsePsAttach('user 123 opencode -s')).toEqual({ ids: [], unmapped: 0 });
  });

  it('poller starts scoped to a root and stops clean', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-attach-'));
    try {
      const at = await import('../src/attach.js');
      at.startAttachPoller(root);
      at.stopAttachPoller();
      at.startAttachPoller();
      at.stopAttachPoller();
    } finally {
      await safeRm(root);
    }
  });

  it('mesh dirs create owner-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-xdg-'));
    try {
      const { stat } = await import('node:fs/promises');
      const xdg = await import('../src/xdg.js');
      const target = join(root, 'nested', 'state');
      await xdg.ensureMeshDirs(target);
      expect((await stat(target)).mode & 0o777).toBe(0o700);
    } finally {
      await safeRm(root);
    }
  });
});
