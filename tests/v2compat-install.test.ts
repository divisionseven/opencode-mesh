// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Installer dual-key plus snapshot restore: the V1 "plugin" key and the
// V2 "plugins" key splice independently, a leading-dash disabled entry never
// counts as installed, and the snapshot unit restores byte-equal. Given
// config text, when either splicer adds, then the untouched key stays
// byte-identical and the disabled marker stays distinct. Given a sandboxed
// HOME plus mesh root, when install runs twice, then the second run is a
// noop; when the live file is clobbered, then uninstall --restore returns
// the exact pre-install bytes.
// Revision note: these splicer checks guard against prefix-matcher
// regressions (the quote-terminated key match plus the dash guard plus the
// additive V2 splicer); they now lock that contract. V1 single-key
// idempotence stays owned by tests/install-lifecycle.test.ts plus
// tests/install-lifecycle-boundaries.test.ts (not restated here).
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  editPluginArrayText,
  editPluginsArrayText,
  listPluginSpecs,
  normalizePluginEntry,
} from '../src/install/opencodeConfig.js';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
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

// Depth-2 root for spawned CLI flows: validateMeshRoot rejects depth-1 tmp
// paths, so CLI sandboxes nest one level and remove the outer dir.
async function freshNestedRoot(
  prefix: string,
): Promise<{ root: string; outer: string; restore: () => void }> {
  const outer = await mkdtemp(join(tmpdir(), prefix));
  const root = join(outer, 'nested', 'mesh');
  await mkdir(root, { recursive: true });
  const prev = process.env.OPENCODE_MESH_ROOT;
  const prevDb = process.env.OPENCODE_MESH_DB_PATH;
  process.env.OPENCODE_MESH_ROOT = root;
  process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
  return {
    root,
    outer,
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
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      throw err;
    }
  }
}

function runCli(
  args: string[],
  env: Record<string, string>,
): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', ['bin/cli.js', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolveListen) => {
    srv.listen(0, '127.0.0.1', () => resolveListen());
  });
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((resolveClose) => {
    srv.close(() => resolveClose());
  });
  return port;
}

async function sandbox(): Promise<{
  home: string;
  root: string;
  outer: string;
  restore: () => void;
  env: Record<string, string>;
}> {
  const home = await mkdtemp(join(tmpdir(), 'mesh-inst-home-'));
  const { root, outer, restore } = await freshNestedRoot('mesh-inst-root-');
  const port = await closedPort();
  const env: Record<string, string> = {
    HOME: home,
    OPENCODE_MESH_ROOT: root,
    OPENCODE_MESH_DB_PATH: join(root, 'empty.db'),
    OPENCODE_PORT: String(port),
  };
  return { home, root, outer, restore, env };
}

function livePath(home: string): string {
  return resolve(home, '.config', 'opencode', 'opencode.json');
}

describe('installer splicer: dual keys plus disable marker', () => {
  it('disabled dash guard keeps the marker distinct from installed', async () => {
    const { root, restore } = await freshRoot('mesh-inst-dash-');
    try {
      expect(normalizePluginEntry('-opencode-mesh')).not.toBe('opencode-mesh');
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('add on a disabled-only array treats it as absent', async () => {
    const { root, restore } = await freshRoot('mesh-inst-dashadd-');
    try {
      const res = editPluginArrayText(
        '{"plugin": ["-opencode-mesh"]}',
        'opencode-mesh',
        'add',
      );
      expect(res.changed).toBe(true);
      expect(res.text).toContain('"-opencode-mesh"');
      expect(res.text).toContain('"opencode-mesh"');
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('add never splices the v2 array when only the plugins key exists', async () => {
    const { root, restore } = await freshRoot('mesh-inst-dual-');
    try {
      const res = editPluginArrayText(
        '{"plugins": ["other"]}',
        'opencode-mesh',
        'add',
      );
      expect(res.text).toContain('"plugins": ["other"]');
      expect(res.text).toContain('"plugin"');
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('v2 splicer add is idempotent and leaves the v1 key identical', async () => {
    const { root, restore } = await freshRoot('mesh-inst-v2add-');
    try {
      const before = '{"plugin": ["opencode-mesh"]}';
      const first = editPluginsArrayText(before, 'opencode-mesh', 'add');
      expect(first.text).toContain('"plugin": ["opencode-mesh"]');
      expect(first.text).toContain('"plugins": ["opencode-mesh"]');
      const second = editPluginsArrayText(first.text, 'opencode-mesh', 'add');
      expect(second.changed).toBe(false);
      expect(second.text).toBe(first.text);
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('v2 splicer dedupes the object form by package field', async () => {
    const { root, restore } = await freshRoot('mesh-inst-v2obj-');
    try {
      const before = '{"plugins": [{"package": "opencode-mesh"}]}';
      const res = editPluginsArrayText(before, 'opencode-mesh', 'add');
      expect(res.changed).toBe(false);
      expect(res.text).toBe(before);
      expect(listPluginSpecs(before, 'plugins')).toEqual(['opencode-mesh']);
      expect(listPluginSpecs(before, 'plugin')).toEqual([]);
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('v2 splicer remove cuts the entry and keeps the rest', async () => {
    const { root, restore } = await freshRoot('mesh-inst-v2rm-');
    try {
      const before = '{"plugins": ["opencode-mesh", "other"]}';
      const res = editPluginsArrayText(before, 'opencode-mesh', 'remove');
      expect(res.changed).toBe(true);
      expect(res.text).not.toContain('opencode-mesh');
      expect(res.text).toContain('other');
      const again = editPluginsArrayText(res.text, 'opencode-mesh', 'remove');
      expect(again.changed).toBe(false);
    } finally {
      await safeRm(root);
      restore();
    }
  });
});

describe('installer lifecycle: idempotent install plus byte-equal restore', () => {
  it('install writes once, second run is a noop', async () => {
    const { home, outer, restore, env } = await sandbox();
    try {
      await mkdir(resolve(home, '.config', 'opencode'), { recursive: true });
      await writeFile(livePath(home), '{"plugin": ["other"]}', 'utf8');
      const first = runCli(['install'], env);
      expect(first.status).toBe(0);
      const live1 = await readFile(livePath(home), 'utf8');
      expect(live1).toContain('opencode-mesh');
      expect(live1).toContain('other');
      const second = runCli(['install'], env);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain('already installed');
      const live2 = await readFile(livePath(home), 'utf8');
      expect(live2).toBe(live1);
      const skill = resolve(
        home,
        '.config',
        'opencode',
        'skills',
        'opencode-mesh',
        'SKILL.md',
      );
      await stat(skill);
      const mode = (await stat(livePath(home))).mode & 0o777;
      expect(mode).toBe(0o644);
    } finally {
      await safeRm(home);
      await safeRm(outer);
      restore();
    }
  });

  it('uninstall --restore returns the exact pre-install bytes', async () => {
    const { home, outer, restore, env } = await sandbox();
    try {
      await mkdir(resolve(home, '.config', 'opencode'), { recursive: true });
      const live0 = '{"plugin": ["other"], "keep": 1}';
      await writeFile(livePath(home), live0, 'utf8');
      const installed = runCli(['install'], env);
      expect(installed.status).toBe(0);
      await writeFile(livePath(home), '{"plugin": ["junk"]}', 'utf8');
      const restored = runCli(['uninstall', '--restore'], env);
      expect(restored.status).toBe(0);
      expect(await readFile(livePath(home), 'utf8')).toBe(live0);
      const snapBase = resolve(home, '.cache', 'opencode-mesh', 'snapshots');
      const stamped = (await readdir(snapBase)).filter((e) => /^\d+$/.test(e));
      expect(stamped.length).toBeGreaterThan(0);
      const rawPath = resolve(
        snapBase,
        stamped[stamped.length - 1],
        'opencode.json.raw',
      );
      expect(await readFile(rawPath, 'utf8')).toBe(live0);
      const rawMode = (await stat(rawPath)).mode & 0o777;
      expect(rawMode).toBe(0o600);
    } finally {
      await safeRm(home);
      await safeRm(outer);
      restore();
    }
  });
});
