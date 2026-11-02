// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Loopback port plus auth discovery from the host's own service record.
// Why: an OpenCode v2 background service binds an ephemeral port chosen at
// boot (never 4096), so a pinned default sends every probe to a dead port and
// every direct send degrades to the outbox with no error. The service writes
// its bound URL and Basic password to `<state>/opencode/service.json`; reading
// that file is the only way to find the live port without a scan.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ENUM_MAX_PORTS } from "./enumerate.js";
import { DEFAULT_OPENCODE_PORT } from "./constants.js";

/** Opt-out switch: exact "0" disables every file read (pinned-port hosts). */
export const SERVICE_DISCOVERY_ENV_KEY = "MESH_SERVICE_DISCOVERY";

/**
 * Service discovery gate. Enabled by default in live runs (`0` or `false`
 * opts out). In test harnesses (vitest/jest) kept dormant by default so
 * host-level `~/.local/state/opencode/service.json` files never pollute
 * isolated test cases unless `XDG_STATE_HOME` or explicit opt-in is provided.
 */
export function isServiceDiscoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env[SERVICE_DISCOVERY_ENV_KEY];
  if (explicit === "0" || explicit === "false") return false;
  if (explicit === "1" || explicit === "true") return true;
  if (env.VITEST !== undefined || env.NODE_ENV === "test") {
    return env.XDG_STATE_HOME !== undefined;
  }
  return true;
}

/** TTL for the cached record: one claimer tick, so a restart re-resolves fast. */
export const SERVICE_RECORD_TTL_MS = 2000;

export interface ServiceRecord {
  /** Loopback port the host is actually listening on. */
  port: number;
  /** Basic password the host requires; absent means an unauthenticated host. */
  password?: string;
  /** Basic username the host expects; absent means the opencode default. */
  username?: string;
  /** Record file mtime in epoch ms; 0 when the host omits it. */
  mtimeMs: number;
}

interface CacheSlot {
  value: ServiceRecord | null;
  at: number;
  key: string;
}

let cache: CacheSlot | null = null;

/** State root: XDG_STATE_HOME wins over the home fallback, matching the host. */
export function resolveServiceStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_STATE_HOME?.trim();
  if (xdg) return join(xdg, "opencode");
  return join(homedir(), ".local", "state", "opencode");
}

/** Absolute record path; single owner for the filename. */
export function resolveServiceRecordPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveServiceStateDir(env), "service.json");
}

/** One loopback port from any positive integer; everything else reads absent. */
function parsePort(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 65535) return raw;
  if (typeof raw === "string" && /^[0-9]{1,5}$/.test(raw)) {
    const n = Number(raw);
    if (n >= 1 && n <= 65535) return n;
  }
  return undefined;
}

function readString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * Parse one service record body into a port plus optional credentials.
 * Accepts the flat host shape (`{url, password}`) and a nested
 * `{server: {url, password}}` wrapping; a record without a resolvable
 * loopback port reads null so callers keep their pinned behavior.
 */
export function parseServiceRecord(body: string): ServiceRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const nested =
    root["server"] && typeof root["server"] === "object" && !Array.isArray(root["server"])
      ? (root["server"] as Record<string, unknown>)
      : undefined;
  const bag = nested ? { ...root, ...nested } : root;
  const url = readString(bag["url"]);
  if (!url) return null;
  let port: number | undefined;
  try {
    const u = new URL(url);
    // Loopback fence: a record pointing anywhere else is never dialed.
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost" && u.hostname !== "::1") return null;
    port = parsePort(u.port) ?? (u.protocol === "https:" ? 443 : 80);
  } catch {
    return null;
  }
  if (port === undefined) return null;
  const rawMtime = bag["mtimeMs"] ?? bag["updatedAt"];
  const mtimeMs = typeof rawMtime === "number" && Number.isFinite(rawMtime) && rawMtime > 0 ? rawMtime : 0;
  return {
    port,
    password: readString(bag["password"]),
    username: readString(bag["username"]),
    mtimeMs,
  };
}

/**
 * Read the host service record; null on every miss (absent file, bad JSON,
 * non-loopback URL, discovery disabled). Never throws: a missing record is
 * the normal state on v1 hosts and on every non-service CLI invocation.
 */
export async function readServiceRecord(
  opts?: { path?: string; now?: number; noCache?: boolean },
): Promise<ServiceRecord | null> {
  if (!isServiceDiscoveryEnabled()) return null;
  const path = opts?.path ?? resolveServiceRecordPath();
  const now = opts?.now ?? Date.now();
  if (!opts?.noCache && cache && cache.key === path && now - cache.at < SERVICE_RECORD_TTL_MS) {
    return cache.value;
  }
  let value: ServiceRecord | null = null;
  try {
    value = parseServiceRecord(await readFile(path, "utf8"));
  } catch {
    value = null;
  }
  cache = { value, at: now, key: path };
  return value;
}

/** Test hook: drop the memoized record so the next read hits the file. */
export function resetServiceRecordCache(): void {
  cache = null;
}

/**
 * Sync mirror for the sync auth path. Impure by design: the header path is
 * already sync, and a service record is a few hundred bytes read at most
 * once per SERVICE_RECORD_TTL_MS. Shares the async cache slot so a caller
 * that already waited on the async read pays no second syscall.
 */
export function readServiceRecordSync(opts?: { path?: string; now?: number }): ServiceRecord | null {
  if (!isServiceDiscoveryEnabled()) return null;
  const path = opts?.path ?? resolveServiceRecordPath();
  const now = opts?.now ?? Date.now();
  if (cache && cache.key === path && now - cache.at < SERVICE_RECORD_TTL_MS) return cache.value;
  let value: ServiceRecord | null = null;
  try {
    value = parseServiceRecord(readFileSync(path, "utf8"));
  } catch {
    value = null;
  }
  cache = { value, at: now, key: path };
  return value;
}

/**
 * Ports to probe with discovery folded in: the record port leads so the
 * first probe succeeds on a live service host, then the caller's own list.
 * With no record the input list is returned untouched (v1 contract), and the
 * ENUM_MAX_PORTS bound still holds so a record can never widen the scan.
 */
export async function withDiscoveredPorts(
  ports: number[],
  opts?: { record?: ServiceRecord | null; limit?: number },
): Promise<number[]> {
  const record = opts?.record === undefined ? await readServiceRecord() : opts.record;
  if (!record) return ports;
  if (ports.length > 0 && ports[0] === record.port) return ports;
  const limit = opts?.limit ?? ENUM_MAX_PORTS;
  return [record.port, ...ports.filter((p) => p !== record.port)].slice(0, limit);
}

/**
 * Basic header from the record when the environment supplies none. Callers
 * prefer env auth (explicit operator intent) and fall back here, so a service
 * host's generated password still authorizes loopback probes.
 */
export async function getServiceAuthHeader(
  record?: ServiceRecord | null,
): Promise<string | undefined> {
  const r = record === undefined ? await readServiceRecord() : record;
  if (!r?.password) return undefined;
  const username = r.username ?? process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
  return `Basic ${Buffer.from(`${username}:${r.password}`).toString("base64")}`;
}

/** Sync mirror for the sync auth path; reads through readServiceRecordSync. */
export function getServiceAuthHeaderSync(
  record?: ServiceRecord | null,
): string | undefined {
  const r = record === undefined ? readServiceRecordSync() : record;
  if (!r?.password) return undefined;
  const username = r.username ?? process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
  return `Basic ${Buffer.from(`${username}:${r.password}`).toString("base64")}`;
}
