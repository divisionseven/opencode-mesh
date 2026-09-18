// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Keychain provider legs behind a fork mock (never touches /usr/bin/security).
import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

async function freshProvider() {
  vi.resetModules();
  const child = await import('node:child_process');
  const mock = child.execFileSync as unknown as ReturnType<typeof vi.fn>;
  mock.mockReset();
  const mod = await import('../src/serverAuthKeychainProvider.js');
  return { mock, mod };
}

function saveUser(): string | undefined {
  return process.env.USER;
}

function restoreUser(prev: string | undefined): void {
  if (prev === undefined) delete process.env.USER;
  else process.env.USER = prev;
}

describe('keychain provider branch legs', () => {
  it('cached value returns without reforking inside the TTL', async () => {
    const prev = saveUser();
    process.env.USER = 'alice';
    const { mock, mod } = await freshProvider();
    mock.mockReturnValue('pw\n');
    expect(mod.getKeychainPassword()).toBe('pw');
    expect(mod.getKeychainPassword()).toBe('pw');
    expect(mock).toHaveBeenCalledTimes(1);
    restoreUser(prev);
  });

  it('unset USER reads the bare variant only', async () => {
    const prev = saveUser();
    delete process.env.USER;
    const { mock, mod } = await freshProvider();
    mock.mockReturnValue('bare-pw');
    expect(mod.getKeychainPassword()).toBe('bare-pw');
    expect(mock).toHaveBeenCalledTimes(1);
    const argv = mock.mock.calls[0][1] as string[];
    expect(argv).not.toContain('-a');
    restoreUser(prev);
  });

  it('hostile USER sanitizes to the bare variant', async () => {
    const prev = saveUser();
    process.env.USER = '../../x';
    const { mock, mod } = await freshProvider();
    mock.mockReturnValue('bare-pw');
    expect(mod.getKeychainPassword()).toBe('bare-pw');
    const argv = mock.mock.calls[0][1] as string[];
    expect(argv).not.toContain('-a');
    restoreUser(prev);
  });

  it('valid USER tries the account variant first', async () => {
    const prev = saveUser();
    process.env.USER = 'alice';
    const { mock, mod } = await freshProvider();
    mock.mockReturnValue('user-pw');
    expect(mod.getKeychainPassword()).toBe('user-pw');
    const argv = mock.mock.calls[0][1] as string[];
    expect(argv.slice(0, 3)).toEqual(['find-generic-password', '-a', 'alice']);
    restoreUser(prev);
  });

  it('account variant carries the mesh service name', async () => {
    const prev = saveUser();
    process.env.USER = 'alice';
    const { mock, mod } = await freshProvider();
    mock.mockReturnValue('user-pw');
    expect(mod.getKeychainPassword()).toBe('user-pw');
    const argv = mock.mock.calls[0][1] as string[];
    expect(argv).toContain('-a');
    expect(argv).toContain('opencode-server-password');
    restoreUser(prev);
  });

  it('bare variant carries the mesh service name without an account', async () => {
    const prev = saveUser();
    delete process.env.USER;
    const { mock, mod } = await freshProvider();
    mock.mockReturnValue('bare-pw');
    expect(mod.getKeychainPassword()).toBe('bare-pw');
    const argv = mock.mock.calls[0][1] as string[];
    expect(argv).not.toContain('-a');
    expect(argv).toContain('opencode-server-password');
    restoreUser(prev);
  });

  it('all variants failing reads undefined and reforks past the TTL', async () => {
    const prev = saveUser();
    process.env.USER = 'alice';
    vi.useFakeTimers();
    try {
      const { mock, mod } = await freshProvider();
      mock.mockImplementation(() => { throw new Error('denied'); });
      expect(mod.getKeychainPassword()).toBeUndefined();
      expect(mod.getKeychainPassword()).toBeUndefined();
      expect(mock).toHaveBeenCalledTimes(2);
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      mock.mockReturnValue('late-pw');
      expect(mod.getKeychainPassword()).toBe('late-pw');
    } finally {
      vi.useRealTimers();
    }
    restoreUser(prev);
  });
});
