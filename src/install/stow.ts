// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Single stow Anti-Corruption Layer.
import { lstatSync, realpathSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeAtomic, fsyncDir, ensureDir0700 } from "../fsAtomic.js";
import { SNAPSHOT_SUBPATH } from "./paths.js";

const pExecFile = promisify(execFile);

/**
 * Guard mesh root before writes; only deep homedir or tmpdir resolve.
 */
export function validateMeshRoot(resolved: string): void {
  const r = resolve(resolved);
  if (r === "/" || r === "/tmp" || r === "/private/tmp") throw Object.assign(new Error(`400 INSTALL_STOW_TRAVERSAL ${r}`), { status: 400 });
  const dir = dirname(r);
  if (dir === "/") throw Object.assign(new Error(`400 INSTALL_STOW_TRAVERSAL dirname / ${r}`), { status: 400 });
  if (r === resolve(homedir(), ".ssh") || r.startsWith(resolve(homedir(), ".ssh") + sep)) throw Object.assign(new Error(`400 INSTALL_STOW_TRAVERSAL ssh ${r}`), { status: 400 });
  const hd = homedir(); const td = tmpdir();
  const inHome = r === hd || r.startsWith(hd + sep);
  const tmpRoots = [td, "/tmp", "/private/tmp"];
  let inTmp = false; let matchedRoot = "";
  for (const tr of tmpRoots) if (r === tr || r.startsWith(tr + sep)) { inTmp = true; matchedRoot = tr; break; }
  if (inHome) { const depth = r.slice(hd.length).split(sep).filter(Boolean).length; if (depth < 3) throw Object.assign(new Error(`400 INSTALL_STOW_TRAVERSAL depth homedir ${r}`), { status: 400 }); }
  else if (inTmp) { const depth = r.slice(matchedRoot.length).split(sep).filter(Boolean).length; if (depth < 2) throw Object.assign(new Error(`400 INSTALL_STOW_TRAVERSAL depth tmpdir ${r}`), { status: 400 }); }
  else throw Object.assign(new Error(`400 INSTALL_STOW_TRAVERSAL allowlist ${r}`), { status: 400 });
  try { const rp = realpathSync(dir); void statSync(rp); } catch {}
}

/** Stow root for detection plus restow cwd; defaults to ~/dotfiles. */
export function stowRoot(): string {
  const o = process.env.OPENCODE_STOW_ROOT?.trim();
  if (o) return resolve(homedir(), o);
  return resolve(homedir(), "dotfiles");
}

/** Detect stowed opencode.json; unstowed reads source as live. */
export function detectStowRoot(livePath: string): { isStowed: boolean; sourcePath: string; livePath: string; packageName: string } {
  const pkg = "opencode"; const live = resolve(livePath);
  // Leaf-parameterized by filename: opencode.json and cli.json share the stow
  // package layout. Stowed when the real path equals the stow source for the
  // canonical opencode.json leaf (live files may be named arbitrarily) or for
  // the live basename leaf (the cli.json case).
  const leaf = live.split(sep).pop() ?? "opencode.json";
  const candidates = new Set([
    resolve(stowRoot(), "opencode", ".config", "opencode", "opencode.json"),
    resolve(stowRoot(), "opencode", ".config", "opencode", leaf),
  ]);
  try {
    const st = lstatSync(live);
    if (st.isSymbolicLink()) {
      const real = realpathSync(live);
      if (candidates.has(real) || real.includes("dotfiles/opencode")) return { isStowed: true, sourcePath: real, livePath: live, packageName: pkg };
    }
  } catch {}
  return { isStowed: false, sourcePath: live, livePath: live, packageName: pkg };
}

/** Post-write census of stow leaf; failures degrade to empty, never throw. */
export async function verifyLeaf(livePath: string, sourcePath: string): Promise<{ lsLive: string; lsSource: string; rgLHit: boolean }> {
  let lsLive = "", lsSource = "";
  try { const { stdout } = await pExecFile("ls", ["-l", livePath]); lsLive = stdout.trim(); } catch {}
  try { const { stdout } = await pExecFile("ls", ["-l", sourcePath]); lsSource = stdout.trim(); } catch {}
  let rgLHit = false;
  try { await pExecFile("rg", ["-L", "-n", "opencode-mesh", livePath]); rgLHit = true; } catch { rgLHit = false; }
  return { lsLive, lsSource, rgLHit };
}

/** Move mesh root to trash; allowlist-validated first, recoverable. */
export async function purgeMeshRoot(root: string): Promise<"trash" | "system-trash" | "filesystem"> {
  validateMeshRoot(root);
  try {
    await pExecFile("trash", [root]);
    return "trash";
  } catch {}
  try {
    await pExecFile("/usr/bin/trash", [root]);
    return "system-trash";
  } catch {}
  await rm(root, { recursive: true, force: true });
  return "filesystem";
}

/** Newest install snapshot, if any; null when nothing was ever snapshotted. */
export async function latestSnapshot(): Promise<{ dir: string; path: string } | null> {
  const { readdir } = await import("node:fs/promises");
  let entries: string[] = [];
  try {
    entries = await readdir(resolve(homedir(), SNAPSHOT_SUBPATH));
  } catch {
    return null;
  }
  const stamped = entries.filter((e) => /^\d+$/.test(e)).sort();
  if (stamped.length === 0) return null;
  const dir = resolve(homedir(), SNAPSHOT_SUBPATH, stamped[stamped.length - 1]);
  return { dir, path: resolve(dir, "opencode.json.raw") };
}

/** Durable write honoring stow; atomic to source, then restow. */
export async function stowedWrite(sourcePath: string, content: string, opts?: { mode?: number }): Promise<void> {
  let mode = opts?.mode;
  if (mode === undefined) { try { mode = statSync(sourcePath).mode & 0o777; } catch { mode = 0o644; } }
  const livePath = resolve(homedir(), ".config", "opencode", "opencode.json");
  const det = detectStowRoot(livePath);
  const target = det.isStowed ? det.sourcePath : livePath;
  // snapshot durability: writeAtomic already does fsyncDir
  await writeAtomic(target, content, { mode });
  await fsyncDir(dirname(target));
  if (det.isStowed) {
    try { await pExecFile("trash", [livePath]); } catch { try { await pExecFile("/usr/bin/trash", [livePath]); } catch {} }
    const cwd = stowRoot();
    try { await pExecFile("stow", ["opencode", "--restow", "--no-folding"], { cwd }); } catch {}
    await verifyLeaf(livePath, target);
  }
}

/** Marker file content recording that cli.json was absent at snapshot time. */
export const CLI_ABSENT_MARKER = "ABSENT\n";

/** Split snapshot unit: both config raws plus a manifest, or fail loud. */
export interface SplitSnapshot {
  dir: string;
  opencodePath: string;
  cliPath: string;
  manifestPath: string;
  cliExisted: boolean;
}

/**
 * Snapshot both config files before either write. cli.json is never written
 * by the mesh installer; its raw (or absent marker) is provenance so restore
 * can replay the unit or fail loud. Snapshot raws stay 0600.
 */
export async function writeSplitSnapshot(
  opencodeRaw: string,
  cliRaw: string | null,
  meta: { isStowed: boolean; sourcePath: string }
): Promise<SplitSnapshot> {
  const dir = resolve(homedir(), SNAPSHOT_SUBPATH, String(Date.now()));
  await ensureDir0700(dir);
  const opencodePath = resolve(dir, "opencode.json.raw");
  const cliPath = resolve(dir, "cli.json.raw");
  const manifestPath = resolve(dir, "manifest.json");
  await writeAtomic(opencodePath, opencodeRaw, { mode: 0o600 });
  await writeAtomic(cliPath, cliRaw === null ? CLI_ABSENT_MARKER : cliRaw, { mode: 0o600 });
  await writeAtomic(
    manifestPath,
    JSON.stringify({ epoch: dir.split(sep).pop(), ...meta, cliExisted: cliRaw !== null }, null, 2),
    { mode: 0o600 }
  );
  await fsyncDir(dir);
  return { dir, opencodePath, cliPath, manifestPath, cliExisted: cliRaw !== null };
}

/**
 * Read a split snapshot unit. Returns null when the dir holds no opencode
 * raw (not a snapshot). cliRaw is null when the absent marker was recorded.
 */
export async function readSplitSnapshot(
  dir: string
): Promise<{ opencodeRaw: string; cliRaw: string | null; manifest: Record<string, unknown> } | null> {
  const { readFile } = await import("node:fs/promises");
  let opencodeRaw: string;
  try {
    opencodeRaw = await readFile(resolve(dir, "opencode.json.raw"), "utf8");
  } catch {
    return null;
  }
  let cliRaw: string | null = null;
  try {
    const raw = await readFile(resolve(dir, "cli.json.raw"), "utf8");
    cliRaw = raw === CLI_ABSENT_MARKER ? null : raw;
  } catch {
    cliRaw = null;
  }
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(await readFile(resolve(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
  } catch {}
  return { opencodeRaw, cliRaw, manifest };
}
