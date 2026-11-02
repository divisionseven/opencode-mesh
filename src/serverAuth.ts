// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Universal ServerAuth Basic identical to opencode (env-only).
// Keychain provider lives beside it, called only behind the exact opt-in flag.
import { KEYCHAIN_USERNAME, getKeychainPassword, getKeychainPasswordAsync } from "./serverAuthKeychainProvider.js";
import { getServiceAuthHeader, getServiceAuthHeaderSync } from "./serviceDiscovery.js";

function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/** Loopback Basic header from env, Keychain behind opt-in flag; undefined when unconfigured. */
export function getServerAuthHeaderSync(): string | undefined {
  const envPassword = process.env.OPENCODE_SERVER_PASSWORD;
  if (envPassword) {
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    return basicHeader(username, envPassword);
  }
  if (process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER === "1") {
    const kcPassword = getKeychainPassword();
    if (kcPassword) {
      const username = process.env.OPENCODE_SERVER_USERNAME ?? KEYCHAIN_USERNAME;
      return basicHeader(username, kcPassword);
    }
  }
  // Service-host leg: a `serve --service` host mints its own password and
  // records it beside its ephemeral port. Without this the probe gets 401 and
  // every send degrades to the outbox, so it outranks an unset env.
  return getServiceAuthHeaderSync();
}

/** Async mirror with the non-blocking provider plus Linux fallback. */
export async function getServerAuthHeader(): Promise<string | undefined> {
  const envPassword = process.env.OPENCODE_SERVER_PASSWORD;
  if (envPassword) {
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    return basicHeader(username, envPassword);
  }
  if (process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER === "1") {
    const kcPassword = await getKeychainPasswordAsync();
    if (kcPassword) {
      const username = process.env.OPENCODE_SERVER_USERNAME ?? KEYCHAIN_USERNAME;
      return basicHeader(username, kcPassword);
    }
  }
  return getServiceAuthHeader();
}
