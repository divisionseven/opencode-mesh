// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Narrow mesh constants (pure TUI-identical).
export const ONE_MB = 1 << 20;
export const STALE_TTL_MS = 24 * 60 * 60 * 1000;
/** Degraded-peers window: 2x ensureHeartbeat tick, covers one missed tick. */
export const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
/** Eviction grace: keeps fresh ids inside one seenSessions debounce window. */
export const EVICT_GRACE_MS = 60 * 1000;
/** Heartbeat cadence: plugin tick re-attests own ids; one miss never flaps. */
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
/** Default loopback port when OPENCODE_PORT is unset; single source. */
export const DEFAULT_OPENCODE_PORT = 4096;
export const OPENCODE_PORT = Number(process.env.OPENCODE_PORT ?? String(DEFAULT_OPENCODE_PORT));
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;
/** Crash-safe lock reap age: stale locks reap on the next writer. */
export const LOCK_STALE_MS = 30_000;
/** Outer EEXIST rounds: burst absorber; see atomicUpdateRegistry contention. */
export const LOCK_OUTER_ROUNDS = 8;
/** Claimer poll cadence per process; crash-recovery claim timeout. */
export const OUTBOX_POLL_MS = 2000;
export const OUTBOX_CLAIM_TIMEOUT_MS = 30000;
/** Bounded hold: rows live minutes; single source for the GC drain leg. */
export const OUTBOX_TTL_MS = 10 * 60 * 1000;
export const OUTBOX_MAX_ATTEMPTS = 25;
/** Per-target depth cap: overflow rejects newest with STORAGE_FULL, never silent drop. 5x the N≤20 fan-out bound. */
export const OUTBOX_DEPTH_CAP = 100;
/** VACUUM only when the GC freed at least this many pages (freelist threshold). */
export const OUTBOX_VACUUM_MIN_PAGES = 16;
/** Wire brand for mesh message IDs (live opencode msg_ alphabet: 12 hex plus 14 base62). */
export const MSG_ID_PREFIX = "msg_";
export const MSG_ID_HEX_LEN = 12;
export const MSG_ID_B62_LEN = 14;
/** Subagent TTL: idle subagents past this meet the expired predicate. */
export const SUBAGENT_TTL_MS = 30 * 60 * 1000;
/** Primary TTL: idle primaries inside this read sleeper and stay. */
export const PRIMARY_TTL_MS = 48 * 60 * 60 * 1000;
/** Attach poller cadence: one EVICT_GRACE_MS window, one seenSessions debounce window. */
export const ATTACH_POLL_MS = 60 * 1000;
/** Sleep dampening bound: one heartbeat tick; forward jumps beyond one tick suspend time deletes for one poller cycle. */
export const LAST_ACTION_DAMPEN_MS = 5 * 60 * 1000;
/** Ps-gone grace: value-equal to EVICT_GRACE_MS under a dedicated name so expiry reads intent. */
export const ATTACH_GONE_GRACE_MS = 60 * 1000;
/** Loopback route-probe budget: single GET /session/status must answer inside this or the leg claims. */
export const ROUTE_PROBE_TIMEOUT_MS = 1000;
/** Direct POST budget: prompt_async must answer inside this or the caller sees SERVER_UNAVAILABLE. */
export const POST_TIMEOUT_MS = 5000;
/** Claimer busy-queue wait: 550-650ms band for Runner busy|retry (single owner: src/claimer.ts). */
export const CLAIMER_BUSY_BASE_MS = 550;
export const CLAIMER_BUSY_JITTER_MS = 100;
/** Env key owning the per-agent TTL override map (single reader lives in src/expiry.ts). */
export const TTL_OVERRIDES_ENV_KEY = "MESH_TTL_OVERRIDES_JSON";
/** Owner-file age for the pre-0.2.0 inbox drain (closes 0.3.0; single owner: src/gc.ts). */
export const LEGACY_OWNER_TTL_MS = 5 * 60 * 1000;
/** Millisecond-integer override for the subagent TTL; falls back to the constant on absent or invalid. */
export function resolveSubagentTtlMs(): number {
  const raw = Number(process.env.MESH_SUBAGENT_TTL_MS);
  return Number.isInteger(raw) && raw > 0 ? raw : SUBAGENT_TTL_MS;
}
/** Millisecond-integer override for the primary TTL; falls back to the constant on absent or invalid. */
export function resolvePrimaryTtlMs(): number {
  const raw = Number(process.env.MESH_PRIMARY_TTL_MS);
  return Number.isInteger(raw) && raw > 0 ? raw : PRIMARY_TTL_MS;
}
