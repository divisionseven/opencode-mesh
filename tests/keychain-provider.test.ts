// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Keychain provider legs behind a fork mock (never touches /usr/bin/security).
import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(), execFile: vi.fn() }));

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

describe('keychain provider async fallback', () => {
  async function freshAsync() {
    vi.resetModules();
    const child = await import('node:child_process');
    const syncMock = child.execFileSync as unknown as ReturnType<typeof vi.fn>;
    const asyncMock = child.execFile as unknown as ReturnType<typeof vi.fn>;
    syncMock.mockReset();
    asyncMock.mockReset();
    const mod = await import('../src/serverAuthKeychainProvider.js');
    return { syncMock, asyncMock, mod };
  }

  function denySecurity(asyncMock: ReturnType<typeof vi.fn>) {
    asyncMock.mockImplementation((cmd: string, _args: unknown, _opts: unknown, cb: (err: Error | null, out?: string) => void) => {
      if (String(cmd).endsWith('security')) {
        const err = new Error('not found: security') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        cb(err);
      } else {
        cb(null, 'linux-pw\n');
      }
      return undefined as never;
    });
  }

  it('absent security falls back to secret-tool without forking sync', async () => {
    const prev = saveUser();
    process.env.USER = 'alice';
    try {
      const { syncMock, asyncMock, mod } = await freshAsync();
      denySecurity(asyncMock);
      await expect(mod.getKeychainPasswordAsync()).resolves.toBe('linux-pw');
      expect(syncMock).not.toHaveBeenCalled();
      const stCall = asyncMock.mock.calls.find((c) => String(c[0]).endsWith('secret-tool'));
      expect(stCall).toBeDefined();
      const argv = (stCall as unknown[])[1] as string[];
      expect(argv[0]).toBe('lookup');
      expect(argv).toContain('opencode-server-password');
    } finally {
      restoreUser(prev);
    }
  });

  it('both backends failing reads undefined', async () => {
    const prev = saveUser();
    delete process.env.USER;
    try {
      const { mod, asyncMock } = await freshAsync();
      asyncMock.mockImplementation((_cmd: string, _args: unknown, _opts: unknown, cb: (err: Error | null) => void) => {
        cb(new Error('denied'));
        return undefined as never;
      });
      await expect(mod.getKeychainPasswordAsync()).resolves.toBeUndefined();
    } finally {
      restoreUser(prev);
    }
  });

  it('security success never reaches secret-tool', async () => {
    const prev = saveUser();
    process.env.USER = 'alice';
    try {
      const { asyncMock, mod } = await freshAsync();
      asyncMock.mockImplementation((cmd: string, _args: unknown, _opts: unknown, cb: (err: Error | null, out?: string) => void) => {
        if (String(cmd).endsWith('secret-tool')) {
          cb(new Error('must not reach secret-tool'));
        } else {
          cb(null, 'mac-pw\n');
        }
        return undefined as never;
      });
      await expect(mod.getKeychainPasswordAsync()).resolves.toBe('mac-pw');
    } finally {
      restoreUser(prev);
    }
  });

  it('unset USER falls back to the bare secret-tool variant', async () => {
    const prev = saveUser();
    delete process.env.USER;
    try {
      const { asyncMock, mod } = await freshAsync();
      denySecurity(asyncMock);
      await expect(mod.getKeychainPasswordAsync()).resolves.toBe('linux-pw');
      const stCall = asyncMock.mock.calls.find((c) => String(c[0]).endsWith('secret-tool'));
      const argv = (stCall as unknown[])[1] as string[];
      expect(argv).not.toContain('account');
    } finally {
      restoreUser(prev);
    }
  });

  it('async header resolves the keychain password behind the opt-in flag', async () => {
    const prevUser = saveUser();
    const prevFlag = process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER;
    const prevPw = process.env.OPENCODE_SERVER_PASSWORD;
    process.env.USER = 'alice';
    process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER = '1';
    delete process.env.OPENCODE_SERVER_PASSWORD;
    try {
      const { asyncMock } = await freshAsync();
      asyncMock.mockImplementation((cmd: string, _args: unknown, _opts: unknown, cb: (err: Error | null, out?: string) => void) => {
        if (String(cmd).endsWith('secret-tool')) cb(new Error('no store'));
        else cb(null, 'kc-pw\n');
        return undefined as never;
      });
      const auth = await import('../src/serverAuth.js');
      const header = await auth.getServerAuthHeader();
      expect(header).toBe(`Basic ${Buffer.from('opencode:kc-pw').toString('base64')}`);
    } finally {
      restoreUser(prevUser);
      if (prevFlag === undefined) delete process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER;
      else process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER = prevFlag;
      if (prevPw === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
      else process.env.OPENCODE_SERVER_PASSWORD = prevPw;
    }
  });
});
