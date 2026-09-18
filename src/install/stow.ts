// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Single stow Anti-Corruption Layer.
import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeAtomic, fsyncDir, ensureDir0700 } from "../fsAtomic.js";

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
  try {
    const st = lstatSync(live);
    if (st.isSymbolicLink()) {
      const real = realpathSync(live);
      const expected = resolve(stowRoot(), "opencode", ".config", "opencode", "opencode.json");
      if (real === expected || real.includes("dotfiles/opencode")) return { isStowed: true, sourcePath: real, livePath: live, packageName: pkg };
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
export async function purgeMeshRoot(root: string): Promise<void> {
  validateMeshRoot(root);
  try { await pExecFile("trash", [root]); } catch { try { await pExecFile("/usr/bin/trash", [root]); } catch {} }
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
