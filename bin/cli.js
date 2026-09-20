#!/usr/bin/env node
// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Facade for peers/send/register + install/uninstall/status/gc.
import { readFileSync, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
function printHelp() {
  console.log(`opencode-mesh ${PKG.version}`);
  console.log("Usage: opencode-mesh peers [--include-self] [--json]");
  console.log("       opencode-mesh send <target|all> <text...> [--no-reply] [--broadcast] [--json]");
  console.log("       opencode-mesh register <summary>");
  console.log("       opencode-mesh install [--dry-run]");
  console.log("       opencode-mesh uninstall [--purge] [--yes]");
  console.log("       opencode-mesh status [--json]");
  console.log("       opencode-mesh gc [--json]");
  console.log('State root: OPENCODE_MESH_ROOT→XDG_STATE_HOME→~/.local/state/opencode/mesh');
}
if (args.includes("--help") || args.includes("-h")) {
  const verbs = {
    peers: "Usage: opencode-mesh peers [--include-self] [--json]",
    send: "Usage: opencode-mesh send <target|all> <text...> [--no-reply] [--broadcast] [--json]",
    register: "Usage: opencode-mesh register <summary>",
    install: "Usage: opencode-mesh install [--dry-run]",
    uninstall: "Usage: opencode-mesh uninstall [--purge] [--yes]",
    status: "Usage: opencode-mesh status [--json]",
    gc: "Usage: opencode-mesh gc [--json]",
  };
  if (args[0] && verbs[args[0]]) { console.log(`opencode-mesh ${PKG.version}`); console.log(verbs[args[0]]); process.exit(0); }
  printHelp(); process.exit(0);
}
if (args.length === 0) { printHelp(); process.exit(2); }
const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const cmd = args[0];
// Single owner for no-dist guard; every dispatch requires built output.
function requireDist() {
  if (!existsSync(DIST)) { console.error("run npm install && npm run build"); process.exit(1); }
}
requireDist();
if (cmd === "install") {
  const dryRun = args.includes("--dry-run");
  const { resolveMeshRoot } = await import("../dist/xdg.js");
  const { SNAPSHOT_SUBPATH, PLUGIN_ENTRY, SKILL_SUBPATH } = await import("../dist/install/paths.js");
  const { validateMeshRoot, detectStowRoot, stowedWrite } = await import("../dist/install/stow.js");
  const { editPluginArrayText } = await import("../dist/install/opencodeConfig.js");
  const { ensureDir0700, writeAtomic, fsyncDir } = await import("../dist/fsAtomic.js");
  const root = resolveMeshRoot(); validateMeshRoot(root);
  const live = resolve(homedir(), ".config/opencode/opencode.json");
  const det = detectStowRoot(live);
  const src = det.sourcePath;
  let raw = ""; try { raw = await readFile(src, "utf8"); } catch { try { raw = await readFile(live, "utf8"); } catch { raw = "{}"; } }
  const res = editPluginArrayText(raw, PLUGIN_ENTRY, "add");
  if (dryRun) {
    console.log("dry-run diff:");
    const a = raw.split("\n"), b = res.text.split("\n");
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) console.log(`- ${a[i] || ""}\n+ ${b[i] || ""}`);
    console.log(`isStowed=${det.isStowed} source=${src}`);
    process.exit(0);
  }
  // Skill delivery: byte-compare first; failure throws loud before config snapshot.
  const skillSrc = new URL("../skills/opencode-mesh/SKILL.md", import.meta.url);
  const skillTarget = resolve(homedir(), ".config", SKILL_SUBPATH);
  let skillBytes = "";
  try { skillBytes = readFileSync(skillSrc, "utf8"); }
  catch (e) { throw new Error(`skill source missing ${skillSrc}: ${e.message ?? String(e)}`); }
  let skillCurrent = null;
  try { skillCurrent = await readFile(skillTarget, "utf8"); } catch { skillCurrent = null; }
  if (skillCurrent !== skillBytes) {
    await ensureDir0700(dirname(skillTarget));
    await writeAtomic(skillTarget, skillBytes, { mode: 0o644 });
    console.log(`skill written ${skillTarget}`);
  }
  if (!res.changed) { console.log("already installed"); process.exit(0); }
  const snapDir = resolve(homedir(), SNAPSHOT_SUBPATH, String(Date.now()));
  await ensureDir0700(snapDir);
  const snapPath = resolve(snapDir, "opencode.json.raw");
  await writeAtomic(snapPath, raw, { mode: 0o600 }); await fsyncDir(snapDir);
  await stowedWrite(src, res.text, { mode: 0o644 });
  console.log(`installed ${det.isStowed ? src + " (stowed)" : live}`);
  console.log("Restart opencode to pick up plugin; then: opencode-mesh status");
  process.exit(0);
} else if (cmd === "uninstall") {
  const purge = args.includes("--purge");
  const yes = args.includes("--yes");
  const { resolveMeshRoot } = await import("../dist/xdg.js");
  const { PLUGIN_ENTRY } = await import("../dist/install/paths.js");
  const { validateMeshRoot, detectStowRoot, stowedWrite } = await import("../dist/install/stow.js");
  const { editPluginArrayText } = await import("../dist/install/opencodeConfig.js");
  const root = resolveMeshRoot(); validateMeshRoot(root);
  const live = resolve(homedir(), ".config/opencode/opencode.json");
  const det = detectStowRoot(live);
  const src = det.sourcePath;
  let raw = ""; try { raw = await readFile(src, "utf8"); } catch { try { raw = await readFile(live, "utf8"); } catch { raw = "{}"; } }
  const res = editPluginArrayText(raw, PLUGIN_ENTRY, "remove");
  if (!res.changed) { console.log("already uninstalled"); }
  else { await stowedWrite(src, res.text, { mode: 0o644 }); console.log(`uninstalled ${src}`); }
  if (purge) {
    console.log(`Purge provenance ${process.env.OPENCODE_MESH_ROOT ? "OPENCODE_MESH_ROOT" : process.env.XDG_STATE_HOME ? "XDG_STATE_HOME" : "default"}`);
    if (!yes) { console.log("add --yes to confirm purge"); process.exit(0); }
    const { purgeMeshRoot } = await import("../dist/install/stow.js");
    await purgeMeshRoot(root);
    console.log(`purged (audit flush 5s)`);
  }
  process.exit(0);
} else if (cmd === "status") {
  const json = args.includes("--json");
  const { resolveMeshRoot, resolveOutboxPath } = await import("../dist/xdg.js");
  const { OPENCODE_PORT, ROUTE_PROBE_TIMEOUT_MS } = await import("../dist/constants.js");
  const { unwrapStatusMap } = await import("../dist/registry.js");
  const { getServerAuthHeaderSync } = await import("../dist/serverAuth.js");
  const { SKILL_SUBPATH } = await import("../dist/install/paths.js");
  const start = Date.now();
  const live = resolve(homedir(), ".config/opencode/opencode.json");
  const portConstant = OPENCODE_PORT;
  const portSource = process.env.OPENCODE_PORT ? "env" : "default";
  const checks = await Promise.all([
    (async () => { try { const t = await readFile(live, "utf8"); return t.includes("opencode-mesh") ? "present" : "absent"; } catch { try { const s = await import("../dist/install/stow.js"); const d = s.detectStowRoot(live); const tt = await readFile(d.sourcePath, "utf8"); return tt.includes("opencode-mesh") ? "present" : "absent"; } catch { return "absent"; } } })(),
    (async () => { try { await stat(resolve(homedir(), ".config", SKILL_SUBPATH)); return "present"; } catch { return "not_shipped"; } })(),
    (async () => { const r = resolveMeshRoot(); const prov = process.env.OPENCODE_MESH_ROOT ? "OPENCODE_MESH_ROOT" : process.env.XDG_STATE_HOME ? "XDG_STATE_HOME" : "default"; return { resolved: r, provenance: prov }; })(),
    (async () => { try { const s = await stat(resolveMeshRoot()); return (s.mode & 0o777).toString(8); } catch { return "absent"; } })(),
    (async () => {
      const auth = getServerAuthHeaderSync();
      const authKind = auth ? (process.env.OPENCODE_SERVER_PASSWORD ? "env" : "keychain-optin") : "none";
      const headers = {};
      if (auth) headers.Authorization = auth;
      const t0 = Date.now();
      try {
        const res = await fetch(`http://127.0.0.1:${portConstant}/session/status`, { headers, signal: AbortSignal.timeout(ROUTE_PROBE_TIMEOUT_MS) });
        const latencyMs = Date.now() - t0;
        if (res.ok) {
          // Why: payloads arrive {data}-wrapped or raw — unwrap first so the
          // count reads sessions, never wrapper keys.
          const liveMap = unwrapStatusMap(await res.json());
          return { reachable: true, latencyMs, liveCount: liveMap ? Object.keys(liveMap).length : 0, auth: authKind };
        }
        return { reachable: false, latencyMs, liveCount: 0, auth: authKind };
      } catch {
        return { reachable: false, latencyMs: Date.now() - t0, liveCount: 0, auth: authKind };
      }
    })(),
    (async () => { try { await stat(resolveOutboxPath()); return "reachable"; } catch { return "absent"; } })(),
  ]);
  const [plugin, skill, meshRoot, regPerm, portInfo, outbox] = checks;
  const elapsed = Date.now() - start;
  const out = { plugin, skill, meshRoot, registryPerm: regPerm, outbox, port: { constant: portConstant, source: portSource, ...portInfo }, elapsedMs: elapsed };
  if (json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`plugin: ${plugin}`);
    console.log(`skill: ${skill}`);
    console.log(`meshRoot: ${JSON.stringify(meshRoot)}`);
    console.log(`registryPerm: ${regPerm}`);
    console.log(`outbox: ${outbox}`);
    console.log(`port: ${JSON.stringify(out.port)}`);
    console.log(`elapsed: ${elapsed}ms`);
    console.log("Restart opencode to pick up plugin; then: opencode-mesh status");
  }
  process.exit(0);
} else if (cmd === "peers") {
  const { mesh_peers } = await import("../dist/tools/mesh_peers.js");
  const includeSelf = args.includes("--include-self");
  // Thin facade: display delegates to the discovery join owner (DB read-only +
  // registry + status where reachable). Output carries live/liveSource per peer.
  const out = await mesh_peers.execute({ includeSelf }, { sessionID: process.env.SESSION_ID ?? "cli" });
  console.log(out.output);
} else if (cmd === "send") {
  const { mesh_send } = await import("../dist/tools/mesh_send.js");
  const target = args[1];
  const text = args.slice(2).filter((a) => !a.startsWith("--")).join(" ");
  if (!target || !text) { console.error("send <target> <text> required"); process.exit(1); }
  const noReply = args.includes("--no-reply"); const broadcast = args.includes("--broadcast");
  // Thin facade: routing delegates to the mesh_send owner (direct prompt_async
  // 204 where reachable, outbox claim otherwise). Guards live in the owner.
  const cliSession = process.env.SESSION_ID ?? "cli";
  try {
    const out = await mesh_send.execute(
      { target: broadcast || target === "all" ? "all" : target, text, noReply, broadcast: broadcast || target === "all" },
      { sessionID: cliSession, directory: process.cwd(), agent: "cli" }
    );
    console.log(out.output);
  } catch (e) {
    console.error(e.message ?? String(e));
    process.exit(1);
  }
} else if (cmd === "register") {
  const { atomicUpdateRegistry, normalizeEntry } = await import("../dist/registry.js");
  const { readRegistry } = await import("../dist/registry.js");
  const summary = args.slice(1).join(" ") || "cli register";
  const id = `cli-${Date.now()}`;
  const entry = { sessionId: id, agent: "cli", summary, description: summary, title: summary, directory: process.cwd(), updatedAt: Date.now() };
  await atomicUpdateRegistry((reg) => { reg[id] = normalizeEntry(entry); });
  const reg = await readRegistry().catch(() => ({}));
  console.log(JSON.stringify({ registered: id, peers: Object.keys(reg).length }, null, 2));
} else if (cmd === "gc") {
  const json = args.includes("--json");
  const { runGc } = await import("../dist/gc.js");
  try {
    const res = await runGc();
    if (json) console.log(JSON.stringify(res, null, 2));
    else console.log(`pruned registry=${res.prunedRegistry} inbox=${res.prunedInbox} outbox=${res.prunedOutbox} live=${res.prunedLive}`);
  } catch (e) {
    console.error(e.message ?? String(e));
    process.exit(1);
  }
  process.exit(0);
} else { console.error(`unknown command ${cmd}`); process.exit(1); }
