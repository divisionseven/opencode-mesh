// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Install classifier edge rules: wildcard disable directives and unreadable
// config text. Given raw config text, when a wildcard disable matches the
// mesh id, then the install reads disabled; when text is malformed, then the
// install reads absent instead of throwing.
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyPluginInstall } from '../src/install/statusMatrix.js';

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
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      throw err;
    }
  }
}

describe('install classifier disable wildcards', () => {
  it('wildcard prefix matching the mesh id reads disabled', async () => {
    const raw = JSON.stringify({ plugin: ['-o*'] });
    expect(classifyPluginInstall(raw, null).state).toBe('disabled');
  });

  it('wildcard prefix outside the mesh id reads absent', async () => {
    const raw = JSON.stringify({ plugin: ['-zzz*'] });
    expect(classifyPluginInstall(raw, null).state).toBe('absent');
  });

  it('malformed config text reads absent instead of throwing', async () => {
    expect(classifyPluginInstall('{{{not json', null).state).toBe('absent');
    expect(classifyPluginInstall('{"plugin": ["opencode-mesh"', null).state).toBe('absent');
  });
});

describe('split snapshot read tolerates partial units', () => {
  it('missing unit directory reads null', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-snap-miss-'));
    try {
      const { readSplitSnapshot } = await import('../src/install/stow.js');
      await expect(readSplitSnapshot(join(root, 'nope'))).resolves.toBeNull();
    } finally {
      await safeRm(root);
    }
  });

  it('unit with only the opencode raw reads null cli raw and empty manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-snap-part-'));
    try {
      const dir = join(root, 'snap');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'opencode.json.raw'), '{"plugin":[]}', 'utf8');
      const { readSplitSnapshot } = await import('../src/install/stow.js');
      const out = await readSplitSnapshot(dir);
      expect(out?.opencodeRaw).toBe('{"plugin":[]}');
      expect(out?.cliRaw).toBeNull();
      expect(out?.manifest).toEqual({});
    } finally {
      await safeRm(root);
    }
  });

  it('absent marker on the cli raw reads null cli raw', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-snap-abs-'));
    try {
      const { writeSplitSnapshot, readSplitSnapshot, CLI_ABSENT_MARKER } =
        await import('../src/install/stow.js');
      const snap = await writeSplitSnapshot('{"plugin":[]}', null, {
        isStowed: false,
        sourcePath: root,
      });
      expect(CLI_ABSENT_MARKER).toBe('ABSENT\n');
      const out = await readSplitSnapshot(snap.dir);
      expect(out?.cliRaw).toBeNull();
      expect(out?.manifest).toMatchObject({ cliExisted: false });
      await safeRm(snap.dir);
    } finally {
      await safeRm(root);
    }
  });
});
