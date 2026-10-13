// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// V2 adapter load check: the V2 host loads one
// default object carrying a stable id plus setup, never a bare function.
// Given the V2 entry module, when the host reads its default export, then
// the export is an object with a non-empty string id plus a setup function,
// and the module carries no other named function exports (every function
// export scans as a plugin entry, the same failure class as the V1 leg).
// The adapter lives at plugin/opencode-mesh-v2.ts; the import guard below
// fails loud with the missing-module cause if it is ever absent. The V1 leg
// stays owned by tests/export-shape.test.ts (rewrite, never delete). Live
// setup invocation stays owned by tests/v2-adapter-setup.test.ts.
import { describe, expect, it, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

async function loadV2Adapter(): Promise<Record<string, unknown>> {
  try {
    const mod = (await import(
      '../plugin/opencode-mesh-v2.js'
    )) as unknown as Record<string, unknown>;
    return mod;
  } catch (err) {
    throw new Error(
      'V2 adapter absent: plugin/opencode-mesh-v2.ts is missing. '
        + `Import failed with: ${String((err as Error)?.message ?? err)}`,
    );
  }
}

describe('v2 export shape: default object with stable id plus setup', () => {
  it('module keys equal ["default"] (a named function export scans as an entry)', async () => {
    const mod = await loadV2Adapter();
    expect(Object.keys(mod).sort()).toEqual(['default']);
  });

  it('default export is an object, never a bare function', async () => {
    const mod = await loadV2Adapter();
    expect(typeof mod.default).toBe('object');
    expect(mod.default).not.toBeNull();
    expect(typeof mod.default).not.toBe('function');
  });

  it('id is a stable non-empty string across fresh imports', async () => {
    const first = (
      await loadV2Adapter()
    ).default as unknown as Record<string, unknown>;
    expect(typeof first.id).toBe('string');
    expect((first.id as string).length).toBeGreaterThan(0);
    vi.resetModules();
    const second = (
      await loadV2Adapter()
    ).default as unknown as Record<string, unknown>;
    expect(second.id).toBe(first.id);
  });

  it('setup is a function on the default object', async () => {
    const mod = await loadV2Adapter();
    const entry = mod.default as unknown as Record<string, unknown>;
    expect(typeof entry.setup).toBe('function');
  });
});
