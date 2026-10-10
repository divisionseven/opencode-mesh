// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// V2 single-flight guard matrix: first setup arms, later setups merge by
// union and arm zero timers, teardown is refcounted. Given guard slots, when
// two setups acquire, then the first is marked first and the second is not;
// when ids merge, then ownership is the union, never an overwrite; when each
// setup releases, then shared state clears only on the last release.
import { describe, expect, it, afterEach } from 'vitest';
import {
  acquireV2Setup,
  mergeV2Ids,
  releaseV2Setup,
  removeV2Ids,
  resetV2Singleflight,
  v2OwnedIds,
  v2SetupCount,
} from '../src/v2singleflight.js';

afterEach(() => {
  resetV2Singleflight();
});

describe('v2 single-flight guard: first arms, rest merge, last tears down', () => {
  it('first acquire wins, second acquire registers cheaply', () => {
    expect(acquireV2Setup()).toEqual({ first: true });
    expect(v2SetupCount()).toBe(1);
    expect(acquireV2Setup()).toEqual({ first: false });
    expect(v2SetupCount()).toBe(2);
  });

  it('ids merge by union, never overwrite', () => {
    acquireV2Setup();
    acquireV2Setup();
    mergeV2Ids(['ses-a', 'ses-b']);
    mergeV2Ids(['ses-b', 'ses-c']);
    expect(v2OwnedIds().sort()).toEqual(['ses-a', 'ses-b', 'ses-c']);
  });

  it('remove drops only the given setup ids', () => {
    acquireV2Setup();
    acquireV2Setup();
    mergeV2Ids(['ses-a', 'ses-b']);
    removeV2Ids(['ses-a']);
    expect(v2OwnedIds()).toEqual(['ses-b']);
  });

  it('release is refcounted, last release clears ownership', () => {
    acquireV2Setup();
    acquireV2Setup();
    mergeV2Ids(['ses-a']);
    expect(releaseV2Setup()).toEqual({ last: false });
    expect(v2SetupCount()).toBe(1);
    expect(v2OwnedIds()).toEqual(['ses-a']);
    removeV2Ids(['ses-a']);
    expect(releaseV2Setup()).toEqual({ last: true });
    expect(v2SetupCount()).toBe(0);
    expect(v2OwnedIds()).toEqual([]);
  });

  it('release below zero clamps instead of going negative', () => {
    expect(releaseV2Setup()).toEqual({ last: true });
    expect(v2SetupCount()).toBe(0);
  });
});
