// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// ServerAuth Keychain flag legs behind a provider mock (never touches Keychain).
// Covers the provider-present branches that need a live entry on real hosts.
import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('../src/serverAuthKeychainProvider.js', () => ({
  KEYCHAIN_USERNAME: 'opencode',
  getKeychainPassword: vi.fn(() => 'kc-pw'),
}));

const ENV_KEYS = ['OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_MESH_KEYCHAIN_PROVIDER'] as const;
const saved = new Map<string, string | undefined>();

function pinEnv(): void {
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);
  delete process.env.OPENCODE_SERVER_PASSWORD;
  delete process.env.OPENCODE_SERVER_USERNAME;
  delete process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER;
}

afterEach(() => {
  vi.resetModules();
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('serverAuth Keychain opt-in legs', () => {
  it('flag set plus mocked entry yields Basic with default user', async () => {
    pinEnv();
    process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER = '1';
    const { getServerAuthHeaderSync } = await import('../src/serverAuth.js');
    expect(getServerAuthHeaderSync()).toBe(
      `Basic ${Buffer.from('opencode:kc-pw').toString('base64')}`
    );
  });

  it('flag set plus custom username yields Basic with that user', async () => {
    pinEnv();
    process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER = '1';
    process.env.OPENCODE_SERVER_USERNAME = 'custom-user';
    const { getServerAuthHeaderSync } = await import('../src/serverAuth.js');
    expect(getServerAuthHeaderSync()).toBe(
      `Basic ${Buffer.from('custom-user:kc-pw').toString('base64')}`
    );
  });

  it('flag set plus empty provider yields undefined (dormant)', async () => {
    pinEnv();
    process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER = '1';
    const provider = await import('../src/serverAuthKeychainProvider.js');
    (provider.getKeychainPassword as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const { getServerAuthHeaderSync } = await import('../src/serverAuth.js');
    expect(getServerAuthHeaderSync()).toBeUndefined();
  });
});
