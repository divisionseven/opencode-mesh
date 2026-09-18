// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Bounded local server enumeration.
// Env plus default port in, sightings with fingerprint out; bind-ownership arbitrates incarnations.
import { createHash } from "node:crypto";
import { OPENCODE_PORT } from "./constants.js";
import { getServerAuthHeaderSync } from "./serverAuth.js";

export const ENUM_MAX_PORTS = 8;
export const ENUM_TIMEOUT_MS = 1000;

export interface ServerSight {
  port: number;
  reachable: boolean;
  latencyMs: number;
  /** sha1 of the /session/status body ("" when unreachable); differs across incarnations with live state. */
  fingerprint: string;
  /** Local epoch ms of this sighting. */
  observedAt: number;
}

function enumPorts(explicit?: number[]): number[] {
  const fromEnv = (process.env.MESH_ENUM_PORTS ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
  const base = explicit && explicit.length > 0 ? explicit : fromEnv.length > 0 ? fromEnv : [OPENCODE_PORT];
  return [...new Set(base)].slice(0, ENUM_MAX_PORTS);
}

/** Probe one loopback port; per-port budget keeps hung servers from stalling. */
export async function probePort(port: number, timeoutMs: number = ENUM_TIMEOUT_MS): Promise<ServerSight> {
  const t0 = Date.now();
  try {
    const auth = getServerAuthHeaderSync();
    const headers: Record<string, string> = {};
    if (auth) headers.Authorization = auth;
    const res = await fetch(`http://127.0.0.1:${port}/session/status`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const body = res.ok ? await res.text() : "";
    return {
      port,
      reachable: res.ok,
      latencyMs: Date.now() - t0,
      fingerprint: body ? createHash("sha1").update(body).digest("hex") : "",
      observedAt: Date.now(),
    };
  } catch {
    return { port, reachable: false, latencyMs: Date.now() - t0, fingerprint: "", observedAt: Date.now() };
  }
}

/** Enumerate bounded set concurrently; order follows input, no port-scan sprawl. */
export async function enumerateServers(explicitPorts?: number[], timeoutMs: number = ENUM_TIMEOUT_MS): Promise<ServerSight[]> {
  const ports = enumPorts(explicitPorts);
  return Promise.all(ports.map((p) => probePort(p, timeoutMs)));
}
