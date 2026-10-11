// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Status six-state matrix: the status contract discriminates six
// cells, absent, legacy-only, native-only, dual-server, cli-augmented, and
// disabled, with a backward-compatible present/absent rollup. Given a
// sandboxed HOME plus mesh root plus loopback port, when status --json runs,
// then each cell reads its own state and a disabled entry rolls up to absent,
// never present. Revision note: the disabled cell guards against
// substring-match regressions; the classifier in
// src/install/statusMatrix.ts owns that table and this file locks it. Provenance under a
// sandbox stays owned here; the real-home provenance variant stays owned by
// tests/install-lifecycle-boundaries.test.ts (not restated here).
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcp } from 'node:net';
import {
  mkdir,
  mkdtemp,
  rm,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

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

// Async spawn variant: spawnSync blocks the event loop, so an in-test
// loopback server could never answer a child dialing it. Async spawn keeps
// the loop alive to serve the port-reachable probe.
function runCliAsync(
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolveP, reject) => {
    const child = spawn('node', ['bin/cli.js', ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('cli spawn timed out'));
    }, 15000);
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (status: number | null) => {
      clearTimeout(timer);
      resolveP({ stdout, stderr, status });
    });
  });
}

async function closedPort(): Promise<number> {
  const srv = createTcp();
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
  envFor: (port: number) => Record<string, string>;
}> {
  const home = await mkdtemp(join(tmpdir(), 'mesh-status-home-'));
  const { root, outer, restore } = await freshNestedRoot('mesh-status-root-');
  const envFor = (port: number): Record<string, string> => ({
    HOME: home,
    OPENCODE_MESH_ROOT: root,
    OPENCODE_MESH_DB_PATH: join(root, 'empty.db'),
    OPENCODE_PORT: String(port),
  });
  return { home, root, outer, restore, envFor };
}

function livePath(home: string): string {
  return resolve(home, '.config', 'opencode', 'opencode.json');
}

function skillPath(home: string): string {
  return resolve(
    home,
    '.config',
    'opencode',
    'skills',
    'opencode-mesh',
    'SKILL.md',
  );
}

async function writeLive(home: string, text: string): Promise<void> {
  await mkdir(resolve(home, '.config', 'opencode'), { recursive: true });
  await writeFile(livePath(home), text, 'utf8');
}

describe('status six-state: each cell reads its own value', () => {
  it('legacy-only entry reads present with its state', async () => {
    const { home, outer, restore, envFor } = await sandbox();
    try {
      await writeLive(home, '{"plugin": ["opencode-mesh"]}');
      const r = runCli(['status', '--json'], envFor(await closedPort()));
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout) as {
        plugin: string;
        pluginSources: { state: string };
      };
      expect(j.plugin).toBe('present');
      expect(j.pluginSources.state).toBe('legacy-only');
    } finally {
      await safeRm(home);
      await safeRm(outer);
      restore();
    }
  });

  it('native-only entry reads present with its state', async () => {
    const { home, outer, restore, envFor } = await sandbox();
    try {
      await writeLive(home, '{"plugins": ["opencode-mesh"]}');
      const r = runCli(['status', '--json'], envFor(await closedPort()));
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout) as {
        plugin: string;
        pluginSources: { state: string };
      };
      expect(j.plugin).toBe('present');
      expect(j.pluginSources.state).toBe('native-only');
    } finally {
      await safeRm(home);
      await safeRm(outer);
      restore();
    }
  });

  it('dual-server entries read present with mismatch detail', async () => {
    const { home, outer, restore, envFor } = await sandbox();
    try {
      await writeLive(
        home,
        '{"plugin": ["opencode-mesh"], "plugins": ["./x/opencode-mesh.ts"]}',
      );
      const r = runCli(['status', '--json'], envFor(await closedPort()));
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout) as {
        plugin: string;
        pluginSources: { state: string; specMismatch: boolean };
      };
      expect(j.plugin).toBe('present');
      expect(j.pluginSources.state).toBe('dual-server');
      expect(j.pluginSources.specMismatch).toBe(true);
    } finally {
      await safeRm(home);
      await safeRm(outer);
      restore();
    }
  });

  it('missing config file reads absent', async () => {
    const { home, outer, restore, envFor } = await sandbox();
    try {
      const r = runCli(['status', '--json'], envFor(await closedPort()));
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).plugin).toBe('absent');
    } finally {
      await safeRm(home);
      await safeRm(outer);
      restore();
    }
  });

  it('unrelated entry reads absent', async () => {
    const { home, outer, restore, envFor } = await sandbox();
    try {
      await writeLive(home, '{"plugin": ["other"]}');
      const r = runCli(['status', '--json'], envFor(await closedPort()));
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).plugin).toBe('absent');
    } finally {
      await safeRm(home);
      await safeRm(outer);
      restore();
    }
  });

  it('disabled entry rolls up to absent with the disabled state', async () => {
    const { home, outer, restore, envFor } = await sandbox();
    try {
      await writeLive(home, '{"plugin": ["-opencode-mesh"]}');
      const r = runCli(['status', '--json'], envFor(await closedPort()));
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout) as {
        plugin: string;
        pluginSources: {
          state: string;
          opencodeJsonPlugin: string;
        };
      };
      expect(j.plugin).toBe('absent');
      expect(j.pluginSources.state).toBe('disabled');
      expect(j.pluginSources.opencodeJsonPlugin).toBe('disabled');
    } finally {
      await safeRm(home);
      await safeRm(outer);
      restore();
    }
  });

  it('skill file present versus missing discriminates', async () => {
    const { home, outer, restore, envFor } = await sandbox();
    try {
      await writeLive(home, '{"plugin": ["opencode-mesh"]}');
      const port = await closedPort();
      const missing = runCli(['status', '--json'], envFor(port));
      expect(missing.status).toBe(0);
      expect(JSON.parse(missing.stdout).skill).toBe('not_shipped');
      await mkdir(resolve(skillPath(home), '..'), { recursive: true });
      await writeFile(skillPath(home), '# mesh skill', 'utf8');
      const present = runCli(['status', '--json'], envFor(port));
      expect(present.status).toBe(0);
      expect(JSON.parse(present.stdout).skill).toBe('present');
    } finally {
      await safeRm(home);
      await safeRm(outer);
      restore();
    }
  });

  it('outbox file present versus missing discriminates', async () => {
    const { home, root, outer, restore, envFor } = await sandbox();
    try {
      const port = await closedPort();
      const missing = runCli(['status', '--json'], envFor(port));
      expect(missing.status).toBe(0);
      expect(JSON.parse(missing.stdout).outbox).toBe('absent');
      await writeFile(join(root, 'outbox.db'), '', 'utf8');
      const present = runCli(['status', '--json'], envFor(port));
      expect(present.status).toBe(0);
      expect(JSON.parse(present.stdout).outbox).toBe('reachable');
    } finally {
      await safeRm(home);
      await safeRm(outer);
      restore();
    }
  });

  it('port reachable versus unreachable discriminates', async () => {
    const { home, outer, restore, envFor } = await sandbox();
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolveListen) => {
      srv.listen(0, '127.0.0.1', () => resolveListen());
    });
    const livePort = (srv.address() as { port: number }).port;
    try {
      const up = await runCliAsync(['status', '--json'], envFor(livePort));
      expect(up.status).toBe(0);
      const upJson = JSON.parse(up.stdout) as {
        port: { reachable: boolean; liveCount: number; latencyMs: number };
      };
      expect(upJson.port.reachable).toBe(true);
      expect(upJson.port.liveCount).toBe(0);
      expect(typeof upJson.port.latencyMs).toBe('number');
      const down = runCli(['status', '--json'], envFor(await closedPort()));
      expect(down.status).toBe(0);
      expect(
        (JSON.parse(down.stdout) as { port: { reachable: boolean } }).port
          .reachable,
      ).toBe(false);
    } finally {
      await new Promise<void>((resolveClose) => {
        srv.close(() => resolveClose());
      });
      await safeRm(home);
      await safeRm(outer);
      restore();
    }
  });

  it('mesh root provenance resolves from the sandbox override', async () => {
    const { home, root, outer, restore, envFor } = await sandbox();
    try {
      const r = runCli(['status', '--json'], envFor(await closedPort()));
      expect(r.status).toBe(0);
      const j = JSON.parse(r.stdout) as {
        meshRoot: { resolved: string; provenance: string };
        elapsedMs: number;
      };
      expect(j.meshRoot.provenance).toBe('OPENCODE_MESH_ROOT');
      expect(j.meshRoot.resolved).toBe(resolve(root));
      expect(typeof j.elapsedMs).toBe('number');
      expect(await readFile(livePath(home), 'utf8').then(
        () => true,
        () => false,
      )).toBe(false);
    } finally {
      await safeRm(home);
      await safeRm(outer);
      restore();
    }
  });
});
