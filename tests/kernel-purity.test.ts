// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Kernel purity, behavioral half: the guard and format core the
// V2 adapter delegates to is reachable with zero host involvement. Given the
// shared modules imported with no plugin init and no host client, when the
// guards run, then verbatim codes plus statuses hold and formatting matches
// the wire contract. No test in this file inits the plugin, builds a host
// client, or touches the network. The executor cores live beside the
// wrappers (src/tools/*.core.ts); this file pins the guard core both entries
// share. The import-edge ownership itself sits at the lint and CI layer per
// house S0 (one enforcement per layer, no source scraping inside vitest).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { ONE_MB } from '../src/constants.js';
import { MeshError } from '../src/errors.js';
import {
  formatMeshPrefix,
  meshPrefixLength,
  quarantineText,
} from '../src/frontmatter.js';
import { isGenericTitle } from '../src/identity.js';
import { assertBodySendable, assertSendable, isMsgId } from '../src/outbox.js';
import { resolveValidDir, sanitizeSessionId } from '../src/xdg.js';
import { isSilent, isWakeEnabled, resolveNoReply } from '../src/wake.js';

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

describe('kernel purity: guard core answers without the host', () => {
  it('typed errors carry verbatim codes plus statuses', async () => {
    const { root, restore } = await freshRoot('mesh-kp-errors-');
    try {
      const cases: Array<[string, number]> = [
        ['PEER_NOT_FOUND', 404],
        ['PAYLOAD_TOO_LARGE', 413],
        ['UNAUTHORIZED', 401],
        ['PEER_BUSY_RETRY', 429],
        ['SERVER_UNAVAILABLE', 503],
        ['BROADCAST_DISABLED', 403],
      ];
      for (const [code, status] of cases) {
        const err = new MeshError(
          code as 'PEER_NOT_FOUND',
          `${code} probe`,
          { didYouMean: ['alpha'] },
        );
        expect(err.code).toBe(code);
        expect(err.status).toBe(status);
        expect(err.didYouMean).toEqual(['alpha']);
      }
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('size guards refuse verbatim at the boundary, never clip', async () => {
    const { root, restore } = await freshRoot('mesh-kp-size-');
    try {
      expect(() => assertSendable('hello')).not.toThrow();
      expect(() => assertSendable('x'.repeat(ONE_MB - 2))).not.toThrow();
      expect(() => assertSendable('x'.repeat(ONE_MB))).toThrow(
        expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE', status: 413 }),
      );
      expect(() =>
        assertSendable('x'.repeat(1024), ONE_MB),
      ).toThrowError(/prefixed/);
      expect(() => assertBodySendable(ONE_MB - 1)).not.toThrow();
      expect(() => assertBodySendable(ONE_MB)).toThrow(
        expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE', status: 413 }),
      );
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('message ids carry the brand both legs match on', async () => {
    const { root, restore } = await freshRoot('mesh-kp-msgid-');
    try {
      const { newMessageId } = await import('../src/outbox.js');
      const first = newMessageId();
      const second = newMessageId();
      expect(isMsgId(first)).toBe(true);
      expect(isMsgId(second)).toBe(true);
      expect(second).not.toBe(first);
      expect(isMsgId('not-a-receipt')).toBe(false);
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('session id allowlist plus directory fence answer locally', async () => {
    const { root, restore } = await freshRoot('mesh-kp-fence-');
    try {
      expect(sanitizeSessionId('ses-abc_123')).toBe('ses-abc_123');
      expect(() => sanitizeSessionId('../evil')).toThrow(
        expect.objectContaining({ status: 400 }),
      );
      expect(() => sanitizeSessionId('')).toThrow(
        expect.objectContaining({ status: 400 }),
      );
      expect(resolveValidDir('/tmp/work')).toEqual({
        kind: 'valid',
        dir: '/tmp/work',
      });
      expect(resolveValidDir(undefined)).toEqual({ kind: 'absent' });
      expect(resolveValidDir('')).toEqual({ kind: 'absent' });
      expect(resolveValidDir('relative/path')).toEqual({ kind: 'invalid' });
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('wire prefix plus quarantine follow the single template', async () => {
    const { root, restore } = await freshRoot('mesh-kp-prefix-');
    try {
      const prev = process.env.MESH_QUARANTINE;
      delete process.env.MESH_QUARANTINE;
      try {
        const prefix = formatMeshPrefix('beta', 'ses-9', true, false);
        expect(prefix).toContain('beta');
        expect(prefix).toContain('ses-9');
        expect(prefix).not.toContain('SILENT');
        expect(
          formatMeshPrefix('beta', 'ses-9', true, true),
        ).toContain('SILENT');
        expect(
          formatMeshPrefix('beta', 'ses-9', false, false),
        ).toContain('QUARANTINED');
        expect(meshPrefixLength('beta', 'ses-9', true, false)).toBe(
          Buffer.byteLength(prefix, 'utf8'),
        );
        expect(quarantineText('plain hello')).toBe('plain hello');
      } finally {
        if (prev === undefined) delete process.env.MESH_QUARANTINE;
        else process.env.MESH_QUARANTINE = prev;
      }
    } finally {
      await safeRm(root);
      restore();
    }
  });

  it('wake table resolves silent before the wire, wake by default', async () => {
    const { root, restore } = await freshRoot('mesh-kp-wake-');
    const prev = process.env.MESH_WAKE;
    try {
      delete process.env.MESH_WAKE;
      expect(isWakeEnabled()).toBe(true);
      expect(isSilent(undefined)).toBe(false);
      expect(isSilent({ silent: true })).toBe(true);
      expect(isSilent({ noReply: true })).toBe(true);
      expect(isSilent({ silent: false, noReply: true })).toBe(false);
      expect(resolveNoReply(undefined)).toEqual({});
      expect(resolveNoReply({ silent: true })).toEqual({ noReply: true });
      process.env.MESH_WAKE = '0';
      expect(isWakeEnabled()).toBe(false);
      expect(isSilent(undefined)).toBe(true);
      expect(resolveNoReply(undefined)).toEqual({ noReply: true });
    } finally {
      if (prev === undefined) delete process.env.MESH_WAKE;
      else process.env.MESH_WAKE = prev;
      await safeRm(root);
      restore();
    }
  });

  it('generic titles sort from real ones with no host lookup', async () => {
    const { root, restore } = await freshRoot('mesh-kp-generic-');
    try {
      expect(isGenericTitle('New session - 2026-09-03T10:00:00.000Z')).toBe(
        true,
      );
      expect(isGenericTitle('Child session - 2026-09-03T10:00:00.000Z')).toBe(
        true,
      );
      expect(isGenericTitle('Real work')).toBe(false);
      expect(isGenericTitle(null)).toBe(true);
      expect(isGenericTitle(undefined)).toBe(true);
    } finally {
      await safeRm(root);
      restore();
    }
  });
});
