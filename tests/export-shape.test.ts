// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Prod plugin module carries ONLY the default export.
// Mutant: restore `export { pollClaimer }` in plugin/opencode-mesh.ts and the
// shape gates redden (host treats every function export as a plugin entry).
import { describe, expect, it, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('export shape: prod default-only plus seam entry', () => {
  it('prod module keys equal ["default"] (named seam would crash the host loader)', async () => {
    const pluginMod = await import('../plugin/opencode-mesh.js');
    expect(Object.keys(pluginMod).sort()).toEqual(['default']);
    expect(typeof pluginMod.default).toBe('function');
    expect('pollClaimer' in pluginMod).toBe(false);
    expect('ensureClaimer' in pluginMod).toBe(false);
  });

  it('legacy host scan shape: every module value resolves to a hooks object (no undefined slot)', async () => {
    const pluginMod = await import('../plugin/opencode-mesh.js');
    const fakeClient = { session: { status: async () => ({}), promptAsync: async () => ({}) } };
    const hooksList: unknown[] = [];
    for (const entry of Object.values(pluginMod)) {
      // Mirrors the host loader: each function export is invoked as a plugin
      // entry and its hooks join the array. A non-plugin export (e.g. the old
      // pollClaimer seam) resolves to undefined and poisons the array.
      const hooks = await (entry as (input: unknown) => Promise<unknown>)({ client: fakeClient });
      hooksList.push(hooks);
    }
    expect(hooksList.length).toBe(1);
    for (const h of hooksList) {
      expect(h).toBeDefined();
      expect(typeof (h as { event: unknown }).event).toBe('function');
      expect(typeof (h as { dispose: unknown }).dispose).toBe('function');
      expect(typeof (h as { tool: unknown }).tool).toBe('object');
    }
    const tools = (hooksList[0] as { tool: Record<string, { execute?: unknown }> }).tool;
    expect(Object.keys(tools).sort()).toEqual(['mesh_broadcast', 'mesh_peers', 'mesh_register', 'mesh_send']);
    for (const [name, t] of Object.entries(tools)) {
      expect(t, `${name} must be defined (no undefined slot)`).toBeDefined();
      expect(typeof t.execute).toBe('function');
    }
  });

  it('seam entry exposes the claimer while the prod module does not', async () => {
    const seam = await import('../plugin/test-seam.js');
    expect(typeof seam.pollClaimer).toBe('function');
    expect(typeof seam.ensureClaimer).toBe('function');
    const pluginMod = await import('../plugin/opencode-mesh.js');
    expect('pollClaimer' in pluginMod).toBe(false);
  });

  it('tools barrel re-exports all four verbs', async () => {
    const barrel = await import('../src/tools/index.js');
    expect(barrel.mesh_peers).toBeDefined();
    expect(barrel.mesh_register).toBeDefined();
    expect(barrel.mesh_send).toBeDefined();
    expect(barrel.mesh_broadcast).toBeDefined();
    expect(barrel.mesh_broadcast).toBe(barrel.mesh_send);
  });
});
