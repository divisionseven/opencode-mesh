// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Plugin `config` hook pushes the in-package
// skills root onto `skills.paths` once (auto-load, no manual copy).
// Plugin config hook pushes the in-package skills root once.
import { describe, expect, it, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

async function loadHooks(): Promise<Record<string, unknown>> {
  const pluginMod = await import('../plugin/opencode-mesh.js');
  const fakeClient = { session: { status: async () => ({}), promptAsync: async () => ({}) } };
  const hooks = await (pluginMod.default as (input: unknown) => Promise<Record<string, unknown>>)({ client: fakeClient });
  return hooks;
}

describe('skill config hook: in-package auto-load', () => {
  it('hooks carry a config function beside event/tool/dispose', async () => {
    const hooks = await loadHooks();
    expect(typeof hooks['config']).toBe('function');
    expect(typeof hooks['event']).toBe('function');
    expect(typeof hooks['dispose']).toBe('function');
    expect(typeof hooks['tool']).toBe('object');
  });

  it('config pushes exactly one skills root ending in skills; repeat adds no duplicate', async () => {
    const hooks = await loadHooks();
    const config = hooks['config'] as (cfg: unknown) => Promise<void>;
    const cfg: { skills?: { paths?: string[] } } = {};
    await config(cfg);
    expect(cfg.skills?.paths?.length).toBe(1);
    expect(cfg.skills?.paths?.[0].endsWith('skills')).toBe(true);
    await config(cfg);
    expect(cfg.skills?.paths?.length).toBe(1);
  });

  it('config preserves pre-existing skills.paths entries', async () => {
    const hooks = await loadHooks();
    const config = hooks['config'] as (cfg: unknown) => Promise<void>;
    const cfg: { skills?: { paths?: string[] } } = { skills: { paths: ['/keep'] } };
    await config(cfg);
    expect(cfg.skills?.paths?.[0]).toBe('/keep');
    expect(cfg.skills?.paths?.length).toBe(2);
  });

  it('config never throws on a frozen/absent-skills shape (fail-closed)', async () => {
    const hooks = await loadHooks();
    const config = hooks['config'] as (cfg: unknown) => Promise<void>;
    await expect(config({})).resolves.toBeUndefined();
    await expect(config(Object.freeze({}))).resolves.toBeUndefined();
  });
});
