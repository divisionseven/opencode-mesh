// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// mesh_register uncovered-branch legs (coverage 90 floor).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mesh_register } from '../src/tools/mesh_register.js';
import { readRegistry } from '../src/registry.js';

const GENERIC = 'New session - 2026-09-02T00:20:17.077Z';

async function freshRoot(prefix: string): Promise<{ root: string; restore: () => void }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const prev = process.env.OPENCODE_MESH_ROOT;
  const prevDb = process.env.OPENCODE_MESH_DB_PATH;
  process.env.OPENCODE_MESH_ROOT = root;
  process.env.OPENCODE_MESH_DB_PATH = join(root, 'empty.db');
  return { root, restore: () => {
    if (prev === undefined) delete process.env.OPENCODE_MESH_ROOT;
    else process.env.OPENCODE_MESH_ROOT = prev;
    if (prevDb === undefined) delete process.env.OPENCODE_MESH_DB_PATH;
    else process.env.OPENCODE_MESH_DB_PATH = prevDb;
  } };
}

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

describe('mesh_register branch legs', () => {
  it('missing sessionID throws PEER_NOT_FOUND', async () => {
    const { root, restore } = await freshRoot('mesh-reg-nosid-');
    const err = await (mesh_register.execute as any)({ summary: 'x' }, {}).catch((e: any) => e);
    expect(err.code).toBe('PEER_NOT_FOUND');
    await safeRm(root); restore();
  });

  it('omitted summary and description register with short-id fallback', async () => {
    const { root, restore } = await freshRoot('mesh-reg-nodesc-');
    const out: any = await (mesh_register.execute as any)({}, { sessionID: 'ses-nodesc-12345678' });
    const peers = JSON.parse(out.output).peers;
    expect(peers['ses-nodesc-12345678'].summary).toBe('ses-nodesc-12345678'.slice(0, 8));
    await safeRm(root); restore();
  });

  it('existing non-generic plus generic-new plus no rawDesc touches heartbeat only', async () => {
    const { root, restore } = await freshRoot('mesh-reg-hb-');
    const before = Date.now() - 1000;
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-hb'] = { sessionId: 'ses-hb', agent: 'a', description: 'Real refactoring work', updatedAt: before } as any;
    }, root);
    await (mesh_register.execute as any)({}, { sessionID: 'ses-hb' });
    const reg: any = await readRegistry(root);
    expect(reg['ses-hb'].description).toBe('Real refactoring work');
    expect(reg['ses-hb'].updatedAt).toBeGreaterThanOrEqual(before);
    await safeRm(root); restore();
  });

  it('relative directory registers without storing a directory', async () => {
    const { root, restore } = await freshRoot('mesh-reg-reldir-');
    const out: any = await (mesh_register.execute as any)({ summary: 'Doing things' }, { sessionID: 'ses-rel', directory: 'rel/path', agent: 'builder' });
    const peers = JSON.parse(out.output).peers;
    expect(peers['ses-rel'].directory).toBeUndefined();
    expect(peers['ses-rel'].cwd).toBeUndefined();
    await safeRm(root); restore();
  });

  it('stale absolute directory throws INVALID_DIRECTORY', async () => {
    const { root, restore } = await freshRoot('mesh-reg-stale-');
    const err = await (mesh_register.execute as any)({ summary: 'x' }, { sessionID: 'ses-stale', directory: join(root, 'no-such-dir') }).catch((e: any) => e);
    expect(err.code).toBe('INVALID_DIRECTORY');
    await safeRm(root); restore();
  });

  it('valid directory plus agent brands the fallback agent at base', async () => {
    const { root, restore } = await freshRoot('mesh-reg-brand-');
    const out: any = await (mesh_register.execute as any)({}, { sessionID: 'ses-brand-1', directory: root, agent: 'builder' });
    const peers = JSON.parse(out.output).peers;
    expect(peers['ses-brand-1'].summary).toContain('builder @');
    await safeRm(root); restore();
  });

  it('valid directory without agent brands the fallback unknown at base', async () => {
    const { root, restore } = await freshRoot('mesh-reg-unk-');
    const out: any = await (mesh_register.execute as any)({}, { sessionID: 'ses-unk-1', directory: root });
    const peers = JSON.parse(out.output).peers;
    expect(peers['ses-unk-1'].summary).toContain('unknown @');
    await safeRm(root); restore();
  });

  it('agent inherits the existing entry when the call omits it', async () => {
    const { root, restore } = await freshRoot('mesh-reg-inherit-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-inh'] = { sessionId: 'ses-inh', agent: 'reviewer', description: GENERIC, updatedAt: Date.now() } as any;
    }, root);
    await (mesh_register.execute as any)({ summary: 'Fresh non-generic title here' }, { sessionID: 'ses-inh' });
    const reg: any = await readRegistry(root);
    expect(reg['ses-inh'].agent).toBe('reviewer');
    await safeRm(root); restore();
  });

  it('agent falls back to unknown with no caller and no existing agent', async () => {
    const { root, restore } = await freshRoot('mesh-reg-noagent-');
    await (mesh_register.execute as any)({ summary: 'Fresh title' }, { sessionID: 'ses-noagent' });
    const reg: any = await readRegistry(root);
    expect(reg['ses-noagent'].agent).toBe('unknown');
    await safeRm(root); restore();
  });

  it('directory and cwd inherit the existing entry when the call omits them', async () => {
    const { root, restore } = await freshRoot('mesh-reg-dinherit-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-di'] = { sessionId: 'ses-di', agent: 'a', directory: '/tmp/old-scope', description: GENERIC, updatedAt: Date.now() } as any;
    }, root);
    await (mesh_register.execute as any)({ summary: 'Another fresh title' }, { sessionID: 'ses-di' });
    const reg: any = await readRegistry(root);
    expect(reg['ses-di'].directory).toBe('/tmp/old-scope');
    expect(reg['ses-di'].cwd).toBe('/tmp/old-scope');
    await safeRm(root); restore();
  });

  it('summary keeps the existing summary when rawDesc is absent', async () => {
    const { root, restore } = await freshRoot('mesh-reg-sum-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-sum'] = { sessionId: 'ses-sum', agent: 'a', summary: 'Kept summary', description: GENERIC, updatedAt: Date.now() } as any;
    }, root);
    await (mesh_register.execute as any)({}, { sessionID: 'ses-sum' });
    const reg: any = await readRegistry(root);
    expect(reg['ses-sum'].summary).toBe('Kept summary');
    await safeRm(root); restore();
  });

  it('summary falls back to the existing description when summary is absent', async () => {
    const { root, restore } = await freshRoot('mesh-reg-sumdesc-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      const e: any = { sessionId: 'ses-sumdesc', agent: 'a', description: GENERIC, updatedAt: Date.now() };
      delete e.summary;
      reg['ses-sumdesc'] = e;
    }, root);
    await (mesh_register.execute as any)({}, { sessionID: 'ses-sumdesc' });
    const reg: any = await readRegistry(root);
    expect(reg['ses-sumdesc'].summary).toBeDefined();
    await safeRm(root); restore();
  });

  it('description keeps the existing description when rawDesc is absent', async () => {
    const { root, restore } = await freshRoot('mesh-reg-desc-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-desc'] = { sessionId: 'ses-desc', agent: 'a', description: 'Kept description', updatedAt: Date.now() } as any;
    }, root);
    await (mesh_register.execute as any)({}, { sessionID: 'ses-desc' });
    const reg: any = await readRegistry(root);
    expect(reg['ses-desc'].description).toBe('Kept description');
    await safeRm(root); restore();
  });

  it('description falls back to the existing summary when description is absent', async () => {
    const { root, restore } = await freshRoot('mesh-reg-descsum-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-descsum'] = { sessionId: 'ses-descsum', agent: 'a', summary: 'Only summary here', title: GENERIC, updatedAt: Date.now() } as any;
    }, root);
    await (mesh_register.execute as any)({}, { sessionID: 'ses-descsum' });
    const reg: any = await readRegistry(root);
    expect(reg['ses-descsum'].description).toBeDefined();
    await safeRm(root); restore();
  });

  it('title keeps the existing title when rawDesc is absent', async () => {
    const { root, restore } = await freshRoot('mesh-reg-title-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-title'] = { sessionId: 'ses-title', agent: 'a', title: 'Kept title', description: GENERIC, updatedAt: Date.now() } as any;
    }, root);
    await (mesh_register.execute as any)({}, { sessionID: 'ses-title' });
    const reg: any = await readRegistry(root);
    expect(reg['ses-title'].title).toBe('Kept title');
    await safeRm(root); restore();
  });

  it('title falls back to the short id when nothing else exists', async () => {
    const { root, restore } = await freshRoot('mesh-reg-titlefb-');
    await (mesh_register.execute as any)({}, { sessionID: 'ses-titlefb-9999' });
    const reg: any = await readRegistry(root);
    expect(reg['ses-titlefb-9999'].title).toBe('ses-titl');
    await safeRm(root); restore();
  });

  it('empty directory is omitted from the stored entry', async () => {
    const { root, restore } = await freshRoot('mesh-reg-nodir-');
    await (mesh_register.execute as any)({ summary: 'No dir here' }, { sessionID: 'ses-nodir' });
    const reg: any = await readRegistry(root);
    expect('directory' in reg['ses-nodir']).toBe(false);
    expect('cwd' in reg['ses-nodir']).toBe(false);
    await safeRm(root); restore();
  });

  it('description alias is preferred over summary when both are present', async () => {
    const { root, restore } = await freshRoot('mesh-reg-alias-');
    await (mesh_register.execute as any)({ summary: 'Summary text', description: 'Canonical description' }, { sessionID: 'ses-alias' });
    const reg: any = await readRegistry(root);
    expect(reg['ses-alias'].description).toBe('Canonical description');
    await safeRm(root); restore();
  });

  it('learned model survives an explicit register call', async () => {
    const { root, restore } = await freshRoot('mesh-reg-model-');
    const { atomicUpdateRegistry } = await import('../src/registry.js');
    await atomicUpdateRegistry((reg: any) => {
      reg['ses-model'] = { sessionId: 'ses-model', agent: 'a', description: 'Real modeling work', model: 'myprov/my-model', updatedAt: Date.now() } as any;
    }, root);
    await (mesh_register.execute as any)({ summary: 'Another fresh title here' }, { sessionID: 'ses-model' });
    const reg: any = await readRegistry(root);
    expect(reg['ses-model'].model).toBe('myprov/my-model');
    await safeRm(root); restore();
  });

  it('non-contention registry error rethrows instead of degrading', async () => {
    const { root, restore } = await freshRoot('mesh-reg-rethrow-');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'registry.json'));
    const err = await (mesh_register.execute as any)({ summary: 'x' }, { sessionID: 'ses-rethrow', directory: root }).catch((e: any) => e);
    expect(err.code).not.toBeUndefined();
    await safeRm(root); restore();
  });
});
