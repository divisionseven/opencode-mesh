// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Six-state plugin truth: structural reads of the V1
// `plugin` key, the V2 server `plugins` key, and the CLI `plugins` key.
// Pure classifier; the CLI owns file reads, this module owns the table.
import { listPluginSpecs, normalizePluginEntry } from "./opencodeConfig.js";

/** The six install states (plus a spec-mismatch flag beside the state, never a seventh state). */
export type PluginInstallState =
  | "absent"
  | "legacy-only"
  | "native-only"
  | "dual-server"
  | "cli-augmented"
  | "disabled";

export type KeyPresence = "present" | "absent" | "disabled";

export interface PluginSourceDetail {
  opencodeJsonPlugin: KeyPresence;
  opencodeJsonPlugins: KeyPresence;
  cliJsonPlugins: KeyPresence;
  specMismatch: boolean;
}

export interface PluginClassification {
  state: PluginInstallState;
  detail: PluginSourceDetail;
}

/** Canonical mesh entry found among the raw specs of one array (disable directives excluded). */
function hasCanonicalEntry(raw: string | null, key: "plugin" | "plugins"): boolean {
  if (raw === null) return false;
  try {
    return listPluginSpecs(raw, key).some((s) => normalizePluginEntry(s) === "opencode-mesh");
  } catch {
    return false;
  }
}

/**
 * Explicit disable covering mesh: `-opencode-mesh` exact, bare `-*`, or a
 * `-prefix*` wildcard whose prefix the canonical id starts with.
 */
function hasDisableDirective(raw: string | null, key: "plugin" | "plugins"): boolean {
  if (raw === null) return false;
  let specs: string[];
  try {
    specs = listPluginSpecs(raw, key);
  } catch {
    return false;
  }
  for (const s of specs) {
    const t = s.trim();
    if (t === "-opencode-mesh") return true;
    if (t === "-*") return true;
    if (t.startsWith("-") && t.endsWith("*")) {
      const prefix = t.slice(1, -1);
      if (prefix !== "" && "opencode-mesh".startsWith(prefix)) return true;
    }
  }
  return false;
}

function presenceOf(raw: string | null, key: "plugin" | "plugins"): KeyPresence {
  if (hasDisableDirective(raw, key)) return "disabled";
  return hasCanonicalEntry(raw, key) ? "present" : "absent";
}

/**
 * Classify the install across both config files. Reads: A = opencode.json
 * `plugin`, B = opencode.json `plugins`, C = cli.json `plugins`. Null raw
 * means unreadable or absent file (same cell: absent).
 */
export function classifyPluginInstall(
  opencodeRaw: string | null,
  cliRaw: string | null
): PluginClassification {
  const a = presenceOf(opencodeRaw, "plugin");
  const b = presenceOf(opencodeRaw, "plugins");
  const c = presenceOf(cliRaw, "plugins");
  const detail: PluginSourceDetail = {
    opencodeJsonPlugin: a,
    opencodeJsonPlugins: b,
    cliJsonPlugins: c,
    specMismatch: false,
  };
  // Explicit disable wins over presence everywhere.
  if (a === "disabled" || b === "disabled" || c === "disabled") {
    return { state: "disabled", detail };
  }
  const aPresent = a === "present";
  const bPresent = b === "present";
  if (aPresent && bPresent) {
    // Conflict sub-rule: different raw specs for the same canonical package
    // load twice under two specs (normalization concatenates); flag beside
    // the state so the installer can converge both to PLUGIN_ENTRY.
    try {
      const aSpecs = listPluginSpecs(opencodeRaw as string, "plugin");
      const bSpecs = listPluginSpecs(opencodeRaw as string, "plugins");
      const aMesh = aSpecs.filter((s) => normalizePluginEntry(s) === "opencode-mesh");
      const bMesh = bSpecs.filter((s) => normalizePluginEntry(s) === "opencode-mesh");
      detail.specMismatch =
        aMesh.length > 0 && bMesh.length > 0 && aMesh.every((s) => !bMesh.includes(s));
    } catch {
      detail.specMismatch = false;
    }
  }
  if (c === "present") return { state: "cli-augmented", detail };
  if (aPresent && bPresent) return { state: "dual-server", detail };
  if (aPresent) return { state: "legacy-only", detail };
  if (bPresent) return { state: "native-only", detail };
  return { state: "absent", detail };
}

/**
 * Backward-compatible rollup for the status `plugin` cell (existing gates
 * assert exactly `present` or `absent`): present when any server key carries
 * the entry and no disable wins, else absent. The six-state truth rides in
 * `pluginSources`.
 */
export function rollupPluginPresence(c: PluginClassification): "present" | "absent" {
  if (c.state === "disabled" || c.state === "absent") return "absent";
  return "present";
}
