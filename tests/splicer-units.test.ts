// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Config splicer units: direct in-process coverage for the pure string
// functions the CLI exercises in a child process (invisible to coverage).
// Given raw config text, when adding or removing the mesh entry, then the
// text edits exactly one array and reports whether it changed.
import { describe, expect, it } from 'vitest';
import {
  editPluginArrayText,
  editPluginsArrayText,
  listPluginSpecs,
  normalizePluginEntry,
} from '../src/install/opencodeConfig.js';

describe('normalizePluginEntry folds variants to one package', () => {
  it('keeps the bare id and file paths as the canonical package', async () => {
    expect(normalizePluginEntry('opencode-mesh')).toBe('opencode-mesh');
    expect(normalizePluginEntry('/x/plugin/opencode-mesh.ts')).toBe('opencode-mesh');
    expect(normalizePluginEntry('/x/dist/opencode-mesh.js')).toBe('opencode-mesh');
    expect(normalizePluginEntry('prefix-opencode-mesh-suffix')).toBe('opencode-mesh');
  });

  it('never folds disable directives or unrelated packages', async () => {
    expect(normalizePluginEntry('-opencode-mesh')).toBe('-opencode-mesh');
    expect(normalizePluginEntry('*')).toBe('*');
    expect(normalizePluginEntry('other-plugin')).toBe('other-plugin');
  });
});

describe('editPluginArrayText key lookup', () => {
  it('matches the key with whitespace before the colon', async () => {
    const out = editPluginArrayText('{\n  "plugin" : ["a"]\n}', 'opencode-mesh', 'add');
    expect(out.changed).toBe(true);
    expect(out.text).toContain('"opencode-mesh"');
  });

  it('skips a key mention inside a string value', async () => {
    const out = editPluginArrayText('{"note": "plugin", "plugin": ["a"]}', 'opencode-mesh', 'add');
    expect(out.changed).toBe(true);
    expect(out.text.match(/"opencode-mesh"/g)).toHaveLength(1);
  });
});

describe('editPluginArrayText without an existing key', () => {
  it('adds the array to an empty object', async () => {
    const out = editPluginArrayText('{}', 'opencode-mesh', 'add');
    expect(out).toEqual({ text: '{\n  "plugin": ["opencode-mesh"]}', changed: true });
  });

  it('appends the array before the closing brace', async () => {
    const out = editPluginArrayText('{"a": 1}', 'opencode-mesh', 'add');
    expect(out.changed).toBe(true);
    expect(out.text).toBe('{"a": 1,\n  "plugin": ["opencode-mesh"]}');
  });

  it('leaves text without braces unchanged', async () => {
    expect(editPluginArrayText('[broken', 'opencode-mesh', 'add')).toEqual({ text: '[broken', changed: false });
    expect(editPluginArrayText('[broken', 'opencode-mesh', 'remove')).toEqual({
      text: '[broken',
      changed: false,
    });
  });
});

describe('editPluginArrayText add and remove with entries present', () => {
  it('add is a no-op when the entry exists', async () => {
    const text = '{"plugin": ["opencode-mesh"]}';
    expect(editPluginArrayText(text, 'opencode-mesh', 'add')).toEqual({ text, changed: false });
  });

  it('add appends to a non-empty array', async () => {
    const out = editPluginArrayText('{"plugin": ["a"]}', 'opencode-mesh', 'add');
    expect(out.changed).toBe(true);
    expect(out.text).toContain('"a"');
    expect(out.text).toContain('"opencode-mesh"');
  });

  it('add fills an empty array without a leading comma', async () => {
    const out = editPluginArrayText('{"plugin": []}', 'opencode-mesh', 'add');
    expect(out.changed).toBe(true);
    expect(out.text).toBe('{"plugin": [\n    "opencode-mesh"]}');
  });

  it('remove drops only the mesh entry and keeps separators valid', async () => {
    const out = editPluginArrayText('{"plugin": ["a", "opencode-mesh", "b"]}', 'opencode-mesh', 'remove');
    expect(out.changed).toBe(true);
    expect(out.text).not.toContain('opencode-mesh');
    expect(out.text).toContain('"a"');
    expect(out.text).toContain('"b"');
  });

  it('remove of a missing entry changes nothing', async () => {
    const text = '{"plugin": ["a"]}';
    expect(editPluginArrayText(text, 'opencode-mesh', 'remove')).toEqual({ text, changed: false });
  });

  it('remove of the only entry empties the array', async () => {
    const out = editPluginArrayText('{"plugin": ["opencode-mesh"]}', 'opencode-mesh', 'remove');
    expect(out.changed).toBe(true);
    expect(out.text).not.toContain('opencode-mesh');
  });
});

describe('listPluginSpecs reads raw specs', () => {
  it('returns string specs verbatim', async () => {
    expect(listPluginSpecs('{"plugin": ["a", "opencode-mesh"]}', 'plugin')).toEqual(['a', 'opencode-mesh']);
  });

  it('returns the package value for object entries', async () => {
    expect(
      listPluginSpecs('{"plugins": [{"package": "opencode-mesh", "options": {}}]}', 'plugins'),
    ).toEqual(['opencode-mesh']);
  });

  it('returns element zero for tuple entries', async () => {
    expect(listPluginSpecs('{"plugins": [["opencode-mesh", {}]]}', 'plugins')).toEqual([
      'opencode-mesh',
    ]);
  });

  it('skips empty elements and reads through escapes', async () => {
    expect(listPluginSpecs('{"plugin": ["a", , "b"]}', 'plugin')).toEqual(['a', 'b']);
    expect(listPluginSpecs('{"plugin": ["a\\\\b", "opencode-mesh"]}', 'plugin')).toEqual([
      'a\\\\b',
      'opencode-mesh',
    ]);
  });

  it('returns empty when the key or array is missing', async () => {
    expect(listPluginSpecs('{"a": 1}', 'plugins')).toEqual([]);
    expect(listPluginSpecs('{"plugins": "x"}', 'plugins')).toEqual([]);
    expect(listPluginSpecs('{"plugins": ["a"', 'plugins')).toEqual([]);
    expect(listPluginSpecs('{"plugins": [[123]]}', 'plugins')).toEqual([]);
  });
});

describe('editPluginsArrayText add and remove', () => {
  it('adds the array to an empty object', async () => {
    const out = editPluginsArrayText('{}', 'opencode-mesh', 'add');
    expect(out).toEqual({ text: '{\n  "plugins": ["opencode-mesh"]}', changed: true });
  });

  it('appends the array when the key is missing', async () => {
    const out = editPluginsArrayText('{"a": 1}', 'opencode-mesh', 'add');
    expect(out.changed).toBe(true);
    expect(out.text).toBe('{"a": 1,\n  "plugins": ["opencode-mesh"]}');
  });

  it('add to text without braces changes nothing', async () => {
    expect(editPluginsArrayText('{"a": 1', 'opencode-mesh', 'add')).toEqual({
      text: '{"a": 1',
      changed: false,
    });
  });

  it('add after a trailing comma appends without doubling it', async () => {
    const out = editPluginsArrayText('{"plugins": ["a",]}', 'opencode-mesh', 'add');
    expect(out.changed).toBe(true);
    expect(out.text).not.toMatch(/,,/);
    expect(out.text).toContain('"opencode-mesh"');
  });

  it('add is a no-op for duplicate string, object, and tuple forms', async () => {
    for (const text of [
      '{"plugins": ["opencode-mesh"]}',
      '{"plugins": [{"package": "opencode-mesh"}]}',
      '{"plugins": [["opencode-mesh", {}]]}',
    ]) {
      expect(editPluginsArrayText(text, 'opencode-mesh', 'add')).toEqual({ text, changed: false });
    }
  });

  it('add appends to a populated array', async () => {
    const out = editPluginsArrayText('{"plugins": ["a"]}', 'opencode-mesh', 'add');
    expect(out.changed).toBe(true);
    expect(out.text).toContain('"opencode-mesh"');
  });

  it('remove drops the mesh form and keeps the rest', async () => {
    const out = editPluginsArrayText(
      '{"plugins": ["a", {"package": "opencode-mesh"}, ["opencode-mesh", {}]]}',
      'opencode-mesh',
      'remove',
    );
    expect(out.changed).toBe(true);
    expect(out.text).not.toContain('opencode-mesh');
    expect(out.text).toContain('"a"');
  });

  it('remove of a missing entry and missing structures changes nothing', async () => {
    expect(editPluginsArrayText('{"plugins": ["a"]}', 'opencode-mesh', 'remove')).toEqual({
      text: '{"plugins": ["a"]}',
      changed: false,
    });
    expect(editPluginsArrayText('{"a": 1}', 'opencode-mesh', 'remove')).toEqual({
      text: '{"a": 1}',
      changed: false,
    });
    expect(editPluginsArrayText('{"plugins": "x"}', 'opencode-mesh', 'remove')).toEqual({
      text: '{"plugins": "x"}',
      changed: false,
    });
    expect(editPluginsArrayText('{"plugins": ["a"', 'opencode-mesh', 'remove')).toEqual({
      text: '{"plugins": ["a"',
      changed: false,
    });
  });

  it('remove of the only entry empties the array', async () => {
    const out = editPluginsArrayText('{"plugins": ["opencode-mesh"]}', 'opencode-mesh', 'remove');
    expect(out.changed).toBe(true);
    expect(out.text).toBe('{"plugins": []}');
  });

  it('tuple with a non-string element zero never matches', async () => {
    const text = '{"plugins": [[123, {}]]}';
    expect(editPluginsArrayText(text, 'opencode-mesh', 'add').changed).toBe(true);
  });

  it('reads through escapes in the v2 array scan', async () => {
    const text = '{"plugins": ["a\\\\b", "opencode-mesh"]}';
    expect(editPluginsArrayText(text, 'opencode-mesh', 'add')).toEqual({ text, changed: false });
    expect(editPluginsArrayText(text, 'other', 'add').changed).toBe(true);
  });
});
