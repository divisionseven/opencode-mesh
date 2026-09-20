// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Attached-session oracle plus per-process poller.
// Truth lives outside the registry; focus is always unknown, never probed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ATTACH_GONE_GRACE_MS, ATTACH_POLL_MS } from "./constants.js";

/** Focus marker: every oracle lacks a focus field, so attached records carry unknown. */
export const ATTACH_FOCUS_UNKNOWN = "unknown";

export interface PsAttach {
  /** Session ids parsed from opencode -s rows. */
  ids: string[];
  /** Bare-opencode rows carrying zero session id: counted, never synthesized into ids. */
  unmapped: number;
}

/**
 * Parse ps output into attached set plus bare-unmapped count; unmapped never creates ids.
 */
export function parsePsAttach(output: string): PsAttach {
  const ids: string[] = [];
  let unmapped = 0;
  for (const line of output.split("\n")) {
    if (!line.includes("opencode")) continue;
    if (line.includes(" grep ")) continue;
    if (line.includes("opencode serve")) continue;
    const m = line.match(/opencode\s+(?:.*\s)?-s\s+(\S+)/);
    if (m?.[1]) {
      if (!ids.includes(m[1])) ids.push(m[1]);
      continue;
    }
    // Bare row: the opencode token carries neither -s nor serve.
    const tail = line.slice(line.indexOf("opencode") + "opencode".length);
    if (!tail.includes("-s") && !tail.includes("serve")) unmapped++;
  }
  return { ids, unmapped };
}

export interface AttachSnapshot {
  attached: string[];
  unmapped: number;
  at: number;
}

let lastSnapshot: AttachSnapshot | null = null;
let attachTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Attached set from ps alone. Status ids never attach: an idle-but-listed
 * session would otherwise stay expiry-exempt forever.
 */
export function computeAttachedSet(psIds: string[]): string[] {
  return [...psIds];
}

/**
 * One poller cycle; failed cycles drop without stopping timer, never throws.
 */
export async function pollAttachOnce(opts?: {
  meshRoot?: string;
  psText?: string;
  statusMap?: Record<string, { type: string }> | null;
}): Promise<AttachSnapshot> {
  const now = Date.now();
  try {
    let text = opts?.psText;
    if (text === undefined) {
      try {
        const pExec = promisify(execFile);
        const { stdout } = await pExec("ps", ["aux"]);
        text = String(stdout ?? "");
      } catch {
        text = "";
      }
    }
    const ps = parsePsAttach(text ?? "");
    let status: Record<string, { type: string }> | null = null;
    let statusOk = false;
    try {
      if (opts && "statusMap" in opts) {
        status = opts.statusMap ?? null;
        statusOk = status !== null && Object.keys(status).length > 0;
      } else {
        const reg = await import("./registry.js");
        status = await reg.fetchSinglePortStatusMap();
        statusOk = status !== null && Object.keys(status).length > 0;
      }
    } catch {
      status = null;
    }
    const attached = computeAttachedSet(ps.ids);
    const snap: AttachSnapshot = { attached, unmapped: ps.unmapped, at: now };
    lastSnapshot = snap;
    try {
      const reg = await import("./registry.js");
      // No-op skip behind a lock-free read: when no observed id is known
      // and no marker needs transitioning, there is nothing to persist, so
      // the cycle takes zero locks and rewrites nothing.
      const current = (await reg.readRegistry(opts?.meshRoot).catch(() => ({}))) as Record<string, unknown>;
      const needsWrite =
        attached.some((id) => current[id] !== undefined) ||
        Object.values(current).some((e) => (e as { attached?: boolean }).attached === true);
      if (!needsWrite) return snap;
      await reg.atomicUpdateRegistry((r) => {
        for (const id of attached) {
          const e = r[id] as unknown as Record<string, unknown> | undefined;
          if (!e) continue;
          e.attached = true;
          e.attachedAt = now;
          e.focus = ATTACH_FOCUS_UNKNOWN;
        }
        // Gone-grace: ps-gone plus status-absent transitions out only past the
        // grace on a successful view; a null view keeps every attached marker.
        if (statusOk || (opts && "statusMap" in opts && status !== null)) {
          for (const [id, e] of Object.entries(r)) {
            const rec = e as unknown as Record<string, unknown>;
            if (rec.attached === true && !attached.includes(id)) {
              const at = typeof rec.attachedAt === "number" ? (rec.attachedAt as number) : 0;
              if (now - at > ATTACH_GONE_GRACE_MS) rec.attached = false;
            }
          }
        }
      }, opts?.meshRoot);
    // Why: best-effort — registry attach update failure must not block the poller cycle.
    } catch {}
    return snap;
  } catch {
    const snap: AttachSnapshot = { attached: [], unmapped: 0, at: now };
    lastSnapshot = snap;
    return snap;
  }
}

/** Start the per-process attach poller beside heartbeat plus claimer; unrefd so it never holds the process open. */
export function startAttachPoller(meshRoot?: string): void {
  if (attachTimer) return;
  attachTimer = setInterval(() => {
    void pollAttachOnce(meshRoot ? { meshRoot } : undefined);
  }, ATTACH_POLL_MS);
  if (attachTimer && typeof (attachTimer as unknown as { unref: () => void }).unref === "function") {
    (attachTimer as unknown as { unref: () => void }).unref();
  }
}

/** Stop the per-process attach poller (dispose path). */
export function stopAttachPoller(): void {
  if (attachTimer) {
    clearInterval(attachTimer);
    attachTimer = null;
  }
}

/**
 * Latest poller snapshot for the display join; copy, never the live row.
 * Null before the first cycle. Read-only: callers must not mutate the result.
 */
export function getAttachSnapshot(): AttachSnapshot | null {
  const s = lastSnapshot;
  if (!s) return null;
  return { attached: [...s.attached], unmapped: s.unmapped, at: s.at };
}
