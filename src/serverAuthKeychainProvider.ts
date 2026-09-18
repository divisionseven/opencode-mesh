// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Opt-in Keychain password provider.
// Exact flag match only; sole /usr/bin/security owner.
import { execFileSync } from "node:child_process";

export const KEYCHAIN_USERNAME = "opencode";

let cached: { value: string | undefined; at: number } | null = null;
const TTL_MS = 5 * 60 * 1000;

/**
 * Opt-in Keychain read; default installs never touch Keychain, failures read undefined.
 */
export function getKeychainPassword(): string | undefined {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value ?? undefined;
  const rawUser = process.env.USER ?? "";
  const sanitizedUser = /^[A-Za-z0-9._-]{1,64}$/.test(rawUser) ? rawUser : "";
  const variants: string[][] = [];
  if (sanitizedUser) variants.push(["find-generic-password", "-a", sanitizedUser, "-s", "opencode-server-password", "-w"]);
  variants.push(["find-generic-password", "-s", "opencode-server-password", "-w"]);
  for (const args of variants) {
    try {
      const out = execFileSync("/usr/bin/security", args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
      const pw = String(out).trim();
      if (pw) {
        cached = { value: pw, at: Date.now() };
        return pw;
      }
    // Why: best-effort — keychain access failure returns undefined, not a crash.
    } catch {}
  }
  cached = { value: undefined, at: Date.now() };
  return undefined;
}
