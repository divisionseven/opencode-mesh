// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Plugin-sources six-state matrix (unit half): the pure classifier maps the
// V1 `plugin` key, the V2 server `plugins` key, and the CLI `plugins` key to
// exactly one state, with disable winning over presence and mismatched specs
// flagged beside the state. Given config raws, when classified, then each
// row of the six-state table holds and the rollup keeps the present/absent
// contract. CLI end-to-end stays owned by tests/status-six-state.test.ts.
import { describe, expect, it } from 'vitest';
import {
  classifyPluginInstall,
  rollupPluginPresence,
} from '../src/install/statusMatrix.js';

describe('plugin sources matrix: six states plus mismatch flag', () => {
  it('triple absent reads absent', () => {
    const c = classifyPluginInstall(null, null);
    expect(c.state).toBe('absent');
    expect(rollupPluginPresence(c)).toBe('absent');
    expect(c.detail.specMismatch).toBe(false);
  });

  it('v1 key only reads legacy-only', () => {
    const c = classifyPluginInstall('{"plugin": ["opencode-mesh"]}', null);
    expect(c.state).toBe('legacy-only');
    expect(rollupPluginPresence(c)).toBe('present');
  });

  it('v2 key only reads native-only', () => {
    const c = classifyPluginInstall('{"plugins": ["opencode-mesh"]}', null);
    expect(c.state).toBe('native-only');
    expect(rollupPluginPresence(c)).toBe('present');
  });

  it('both server keys read dual-server', () => {
    const c = classifyPluginInstall(
      '{"plugin": ["opencode-mesh"], "plugins": ["opencode-mesh"]}',
      null,
    );
    expect(c.state).toBe('dual-server');
    expect(rollupPluginPresence(c)).toBe('present');
    expect(c.detail.specMismatch).toBe(false);
  });

  it('cli string entry reads cli-augmented', () => {
    const c = classifyPluginInstall(
      '{"plugin": ["opencode-mesh"], "plugins": ["opencode-mesh"]}',
      '{"plugins": ["opencode-mesh"]}',
    );
    expect(c.state).toBe('cli-augmented');
    expect(rollupPluginPresence(c)).toBe('present');
  });

  it('disable directive wins over presence on any key', () => {
    for (const raw of [
      '{"plugin": ["-opencode-mesh"]}',
      '{"plugins": ["-opencode-mesh"]}',
      '{"plugin": ["opencode-mesh"], "plugins": ["-opencode-mesh"]}',
    ]) {
      const c = classifyPluginInstall(raw, null);
      expect(c.state).toBe('disabled');
      expect(rollupPluginPresence(c)).toBe('absent');
    }
    const cli = classifyPluginInstall('{"plugin": ["opencode-mesh"]}', '{"plugins": ["-*"]}');
    expect(cli.state).toBe('disabled');
    expect(rollupPluginPresence(cli)).toBe('absent');
  });

  it('different raw specs across keys flag mismatch beside the state', () => {
    const c = classifyPluginInstall(
      '{"plugin": ["./plugin/opencode-mesh.ts"], "plugins": ["opencode-mesh"]}',
      null,
    );
    expect(c.state).toBe('dual-server');
    expect(c.detail.specMismatch).toBe(true);
  });

  it('object-form v2 entry counts as present', () => {
    const c = classifyPluginInstall('{"plugins": [{"package": "opencode-mesh"}]}', null);
    expect(c.state).toBe('native-only');
    expect(rollupPluginPresence(c)).toBe('present');
  });

  it('malformed input reads absent, never throws', () => {
    expect(classifyPluginInstall('{"plugin": ["a"', null).state).toBe('absent');
    expect(classifyPluginInstall('no braces here', null).state).toBe('absent');
  });
});
