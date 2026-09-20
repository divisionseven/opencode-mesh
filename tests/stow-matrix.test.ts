// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Stow detection plus leaf census over tmp fixtures: symlinked roots read
// stowed, plain files read live, census degrades on missing paths. The
// homedir write path stays untested by design (it targets real config).
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

const homedirCtl = vi.hoisted(() => ({ dir: null as string | null }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => homedirCtl.dir ?? actual.homedir() };
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  homedirCtl.dir = null;
  delete process.env.OPENCODE_STOW_ROOT;
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

describe('stow detection plus census', () => {
  it('symlink into a dotfiles tree reads stowed with the real source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-stow-'));
    try {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(root, 'dotfiles', 'opencode'), { recursive: true });
      const source = join(root, 'dotfiles', 'opencode', 'x.json');
      await writeFile(source, '{}');
      const live = join(root, 'live.json');
      await symlink(source, live);
      const stow = await import('../src/install/stow.js');
      const det = stow.detectStowRoot(live);
      const { realpathSync } = await import('node:fs');
      expect(det.isStowed).toBe(true);
      expect(det.sourcePath).toBe(realpathSync(source));
      expect(det.livePath).toBe(live);
    } finally {
      await safeRm(root);
    }
  });

  it('plain file reads live with itself as source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-stow-plain-'));
    try {
      const live = join(root, 'live.json');
      await writeFile(live, '{}');
      const stow = await import('../src/install/stow.js');
      const det = stow.detectStowRoot(live);
      expect(det.isStowed).toBe(false);
      expect(det.sourcePath).toBe(live);
    } finally {
      await safeRm(root);
    }
  });

  it('census reports shell output on present files, empty on missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-stow-leaf-'));
    try {
      const withMark = join(root, 'with.json');
      await writeFile(withMark, 'opencode-mesh probe');
      const stow = await import('../src/install/stow.js');
      const hit = await stow.verifyLeaf(withMark, withMark);
      expect(hit.lsLive.length).toBeGreaterThan(0);
      expect(hit.rgLHit).toBe(true);
      const miss = await stow.verifyLeaf(join(root, 'absent.json'), join(root, 'absent.json'));
      expect(miss.lsLive).toBe('');
      expect(miss.rgLHit).toBe(false);
    } finally {
      await safeRm(root);
    }
  });

  it('purge resolves on a deep tmp root with a method', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-stow-purge-'));
    try {
      const { mkdir } = await import('node:fs/promises');
      const victim = join(root, 'a', 'b');
      await mkdir(victim, { recursive: true });
      const stow = await import('../src/install/stow.js');
      await expect(stow.purgeMeshRoot(victim)).resolves.toMatch(/^(trash|system-trash|filesystem)$/);
      await safeRm(root);
    } finally {
      await safeRm(root).catch(() => {});
    }
  });

  it('env stow root exact match reads stowed', async () => {
    const { realpathSync } = await import('node:fs');
    const root = await mkdtemp(join(realpathSync(tmpdir()), 'mesh-stow-env-'));
    const prevStow = process.env.OPENCODE_STOW_ROOT;
    try {
      const { mkdir } = await import('node:fs/promises');
      const source = join(root, 'opencode', '.config', 'opencode', 'opencode.json');
      await mkdir(join(root, 'opencode', '.config', 'opencode'), { recursive: true });
      await writeFile(source, '{}');
      process.env.OPENCODE_STOW_ROOT = root;
      const live = join(root, 'live.json');
      await symlink(source, live);
      const stow = await import('../src/install/stow.js');
      const det = stow.detectStowRoot(live);
      expect(det.isStowed).toBe(true);
      expect(det.sourcePath).toBe(source);
    } finally {
      if (prevStow === undefined) delete process.env.OPENCODE_STOW_ROOT;
      else process.env.OPENCODE_STOW_ROOT = prevStow;
      await safeRm(root);
    }
  });

  it('unstowed write lands on the live path with default mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-stow-write-'));
    const home = join(root, 'home');
    homedirCtl.dir = home;
    try {
      const { mkdir, readFile, stat } = await import('node:fs/promises');
      await mkdir(home, { recursive: true });
      const stow = await import('../src/install/stow.js');
      const source = join(root, 'source.json');
      await stow.stowedWrite(source, '{"a":1}');
      const live = join(home, '.config', 'opencode', 'opencode.json');
      expect(await readFile(live, 'utf8')).toBe('{"a":1}');
      expect((await stat(live)).mode & 0o777).toBe(0o644);
    } finally {
      await safeRm(root);
    }
  });

  it('explicit mode wins over the existing file mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-stow-mode-'));
    const home = join(root, 'home');
    homedirCtl.dir = home;
    try {
      const { stat } = await import('node:fs/promises');
      const stow = await import('../src/install/stow.js');
      const source = join(root, 'source.json');
      await stow.stowedWrite(source, '{}', { mode: 0o600 });
      const live = join(home, '.config', 'opencode', 'opencode.json');
      expect((await stat(live)).mode & 0o777).toBe(0o600);
    } finally {
      await safeRm(root);
    }
  });

  it('stowed write updates the source and restows without throwing', async () => {
    const { realpathSync } = await import('node:fs');
    const root = await mkdtemp(join(realpathSync(tmpdir()), 'mesh-stow-restow-'));
    const home = join(root, 'home');
    homedirCtl.dir = home;
    const prevStow = process.env.OPENCODE_STOW_ROOT;
    try {
      const { mkdir, readFile } = await import('node:fs/promises');
      const stowDir = join(root, 'stowpkg');
      const source = join(stowDir, 'opencode', '.config', 'opencode', 'opencode.json');
      await mkdir(join(stowDir, 'opencode', '.config', 'opencode'), { recursive: true });
      await writeFile(source, '{"old":true}');
      await mkdir(join(home, '.config', 'opencode'), { recursive: true });
      const live = join(home, '.config', 'opencode', 'opencode.json');
      await symlink(source, live);
      process.env.OPENCODE_STOW_ROOT = stowDir;
      const stow = await import('../src/install/stow.js');
      await expect(stow.stowedWrite(source, '{"new":true}')).resolves.toBeUndefined();
      expect(await readFile(source, 'utf8')).toBe('{"new":true}');
    } finally {
      if (prevStow === undefined) delete process.env.OPENCODE_STOW_ROOT;
      else process.env.OPENCODE_STOW_ROOT = prevStow;
      await safeRm(root);
    }
  });

  it('latest snapshot resolves newest stamped dir, null when absent', async () => {    const root = await mkdtemp(join(tmpdir(), 'mesh-stow-snap-'));
    const prevHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const stow = await import('../src/install/stow.js');
      expect(await stow.latestSnapshot()).toBeNull();
      await mkdir(join(root, '.cache', 'opencode-mesh', 'snapshots', '1000'), { recursive: true });
      await mkdir(join(root, '.cache', 'opencode-mesh', 'snapshots', '2000'), { recursive: true });
      await mkdir(join(root, '.cache', 'opencode-mesh', 'snapshots', 'notes'), { recursive: true });
      await writeFile(join(root, '.cache', 'opencode-mesh', 'snapshots', '2000', 'opencode.json.raw'), '{}');
      const snap = await stow.latestSnapshot();
      expect(snap?.dir).toBe(join(root, '.cache', 'opencode-mesh', 'snapshots', '2000'));
      expect(snap?.path).toBe(join(root, '.cache', 'opencode-mesh', 'snapshots', '2000', 'opencode.json.raw'));
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await safeRm(root);
    }
  });

  it('latest snapshot with no stamped dirs reads null', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mesh-stow-snapempty-'));
    const prevHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(root, '.cache', 'opencode-mesh', 'snapshots', 'notes'), { recursive: true });
      const stow = await import('../src/install/stow.js');
      expect(await stow.latestSnapshot()).toBeNull();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await safeRm(root);
    }
  });
});
