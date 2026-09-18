// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Single owner for the wake-vs-silent wire decision.

/**
 * Wake-by-default; MESH_WAKE=0 opts out globally, silent flag per message.
 * Both legs resolve here so direct plus claimer cannot diverge.
 */

/** Per-message silence options accepted by the resolver. */
export interface WakeOpts {
  /** Canonical per-message silent flag; wins over legacy `noReply`. */
  silent?: boolean;
  /** Legacy compat flag; honored when `silent` is omitted. */
  noReply?: boolean;
}

/** False only when kill-switch is set; unset keeps wake as default. */
export function isWakeEnabled(): boolean {
  return process.env.MESH_WAKE !== "0";
}

/**
 * Wire noReply key; kill-switch first, then per-message flags; wake omits key.
 */
export function resolveNoReply(opts?: WakeOpts): { noReply?: true } {
  if (!isWakeEnabled()) return { noReply: true };
  if ((opts?.silent ?? opts?.noReply ?? false) === true) return { noReply: true };
  return {};
}

/** Silent-bit predicate sharing resolveNoReply truth table; testing bit uses this. */
export function isSilent(opts?: WakeOpts): boolean {
  if (!isWakeEnabled()) return true;
  return (opts?.silent ?? opts?.noReply ?? false) === true;
}
