// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Per-type expiry: TTL resolution plus precedence plus dampening plus audit.
// Attached ids never expire by time alone; quiet reads live until its TTL passes.
import { ATTACH_POLL_MS, LAST_ACTION_DAMPEN_MS, TTL_OVERRIDES_ENV_KEY, resolvePrimaryTtlMs, resolveSubagentTtlMs } from "./constants.js";

export const EXPIRY_PRECEDENCE = ["attached-exempt", "busy-exempt", "override", "type-default", "dampening-hold"] as const;

export type ExpiryStep = "attached-exempt" | "busy-exempt" | "override" | "type-default" | "dampening-hold";

/** Rank of one precedence step in ascending evaluation order. */
export function precedenceIndex(step: ExpiryStep): number {
  return EXPIRY_PRECEDENCE.indexOf(step);
}

export type SessionType = "primary" | "subagent";

/** Null parent reads primary, any parent reads subagent. */
export function deriveSessionType(parentId: unknown): SessionType {
  return parentId === null || parentId === undefined ? "primary" : "subagent";
}

/** Agent-to-ms map from JSON env; invalid or absent reads empty. */
export function readTtlOverrides(): Record<string, number> {
  try {
    const raw = process.env[TTL_OVERRIDES_ENV_KEY];
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isInteger(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export interface TtlResolution {
  ttlMs: number;
  override: boolean;
}

/** Override-first TTL: per-agent map wins, else the type default. */
export function resolveTtlMs(sessionType: SessionType, agent?: string | null): TtlResolution {
  const overrides = readTtlOverrides();
  if (agent && typeof overrides[agent] === "number") return { ttlMs: overrides[agent], override: true };
  const ttlMs = sessionType === "subagent" ? resolveSubagentTtlMs() : resolvePrimaryTtlMs();
  return { ttlMs, override: false };
}

/** Attached ids never delete by time alone; live processes outrank clocks. */
export function isAttachedExempt(entry: unknown): boolean {
  return (entry as Record<string, unknown> | null)?.attached === true;
}

/** Busy or retrying ids count as active; mid-turn sessions never prune. */
export function isBusyExempt(statusType?: string | null): boolean {
  return statusType === "busy" || statusType === "retry";
}

let dampenedUntil = 0;

/** Forward leap past one bound suspends time deletes for one poller cycle. */
export function noteForwardJump(now: number, deltaMs: number): void {
  if (deltaMs > LAST_ACTION_DAMPEN_MS) dampenedUntil = now + ATTACH_POLL_MS;
}

/** Hold probe; self-clears after one cycle so expiry resumes alone. */
export function isDampeningHold(now: number): boolean {
  if (now < dampenedUntil) return true;
  dampenedUntil = 0;
  return false;
}

export interface ExpiryInput {
  sessionType: SessionType;
  agent?: string | null;
  attached: boolean;
  statusType?: string | null;
  lastActionAt: number;
  now: number;
}

export interface ExpiryVerdict {
  state: "attached" | "live" | "expired";
  reason: string;
  ttlMs: number;
  override: boolean;
}

/** Precedence verdict: attached, busy, override/default, hold; else expired. */
export function evaluateExpiry(input: ExpiryInput): ExpiryVerdict {
  if (input.attached) {
    return { state: "attached", reason: "attached-exempt", ttlMs: 0, override: false };
  }
  if (isBusyExempt(input.statusType)) {
    return { state: "live", reason: "busy-exempt", ttlMs: 0, override: false };
  }
  const { ttlMs, override } = resolveTtlMs(input.sessionType, input.agent);
  if (input.now - input.lastActionAt <= ttlMs) {
    return { state: "live", reason: override ? "override" : "type-default", ttlMs, override };
  }
  if (isDampeningHold(input.now)) {
    return { state: "live", reason: "dampening-hold", ttlMs, override };
  }
  return { state: "expired", reason: override ? "ttl-past-override" : "ttl-past", ttlMs, override };
}

/** Collect expired ids without mutating; absent lookup reads idle. */
export function collectExpired(
  reg: Record<string, unknown>,
  opts?: { now?: number; statusTypeOf?: (id: string) => string | null }
): string[] {
  const now = opts?.now ?? Date.now();
  const out: string[] = [];
  for (const [id, v] of Object.entries(reg)) {
    const e = v as Record<string, unknown>;
    const attached = e.attached === true;
    const agent = typeof e.agent === "string" ? (e.agent as string) : null;
    const sessionType: SessionType = e.sessionType === "subagent" ? "subagent" : "primary";
    const lastActionAt =
      typeof e.lastActionAt === "number" ? (e.lastActionAt as number) : typeof e.updatedAt === "number" ? (e.updatedAt as number) : 0;
    const verdict = evaluateExpiry({ sessionType, agent, attached, statusType: opts?.statusTypeOf?.(id) ?? null, lastActionAt, now });
    if (verdict.state === "expired") out.push(id);
  }
  return out;
}

/** Delete ids via single writer plus one audit line each; never throws. */
export async function deleteExpiredWithAudit(
  ids: string[],
  detail: { reason: string; ttlClass: string; override: boolean },
  meshRoot?: string
): Promise<number> {
  if (ids.length === 0) return 0;
  try {
    const reg = await import("./registry.js");
    await reg.atomicUpdateRegistry((r) => {
      for (const id of ids) delete r[id];
    }, meshRoot);
    // Why: verify-before-audit — the audit line claims the delete landed, so
    // confirm absence first and audit only confirmed ids. Audit stays best-effort.
    const after = (await reg.readRegistry(meshRoot)) as Record<string, unknown>;
    const gone = ids.filter((id) => !(id in after));
    await reg.appendDeleteAudit(`expiry:${detail.reason}:${detail.ttlClass}:${detail.override ? "override" : "default"}`, gone, meshRoot);
    return gone.length;
  } catch {
    return 0;
  }
}
