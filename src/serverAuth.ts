// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Universal ServerAuth Basic identical to opencode (env-only).
// Keychain provider lives beside it, called only behind the exact opt-in flag.
import { KEYCHAIN_USERNAME, getKeychainPassword, getKeychainPasswordAsync } from "./serverAuthKeychainProvider.js";

/** Loopback Basic header from env, Keychain behind opt-in flag; undefined when unconfigured. */
export function getServerAuthHeaderSync(): string | undefined {
  const envPassword = process.env.OPENCODE_SERVER_PASSWORD;
  if (envPassword) {
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    return `Basic ${Buffer.from(`${username}:${envPassword}`).toString("base64")}`;
  }
  if (process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER === "1") {
    const kcPassword = getKeychainPassword();
    if (kcPassword) {
      const username = process.env.OPENCODE_SERVER_USERNAME ?? KEYCHAIN_USERNAME;
      return `Basic ${Buffer.from(`${username}:${kcPassword}`).toString("base64")}`;
    }
  }
  return undefined;
}

/** Async mirror with the non-blocking provider plus Linux fallback. */
export async function getServerAuthHeader(): Promise<string | undefined> {
  const envPassword = process.env.OPENCODE_SERVER_PASSWORD;
  if (envPassword) {
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    return `Basic ${Buffer.from(`${username}:${envPassword}`).toString("base64")}`;
  }
  if (process.env.OPENCODE_MESH_KEYCHAIN_PROVIDER === "1") {
    const kcPassword = await getKeychainPasswordAsync();
    if (kcPassword) {
      const username = process.env.OPENCODE_SERVER_USERNAME ?? KEYCHAIN_USERNAME;
      return `Basic ${Buffer.from(`${username}:${kcPassword}`).toString("base64")}`;
    }
  }
  return undefined;
}
