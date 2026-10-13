// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// CST preserve-whole-file splicer.
/** Canonicalize plugin entry to package name; variants compare as one install. */
export function normalizePluginEntry(e: string): string {
  const t = e.trim();
  // Why: disable directives are significant (cli/plugins doc): a leading `-`
  // (or bare `*`) never folds to an installed package.
  if (t.startsWith("-") || t === "*") return t;
  if (t === "opencode-mesh") return "opencode-mesh";
  if (t.endsWith("opencode-mesh.ts") || t.endsWith("opencode-mesh.js")) return "opencode-mesh";
  return t.includes("opencode-mesh") ? "opencode-mesh" : t;
}

/**
 * Locate an exact object key (quote-terminated match with colon proof).
 * The bare prefix form would hit the `plugins` key when asking for `plugin`.
 */
function findKeyPos(text: string, key: string): number {
  const needle = `"${key}"`;
  let from = 0;
  while (true) {
    const k = text.indexOf(needle, from);
    if (k === -1) return -1;
    let j = k + needle.length;
    while (j < text.length && /\s/.test(text[j] as string)) j++;
    if (text[j] === ":") return k;
    from = k + needle.length;
  }
}
/**
 * Splice mesh entry into plugin array; malformed input returns unchanged, never throws.
 */
export function editPluginArrayText(text: string, desiredEntry: string, op: "add" | "remove"): { text: string; changed: boolean } {
  const want = normalizePluginEntry(desiredEntry);
  const k = findKeyPos(text, "plugin");
  if (k === -1) {
    // Why: empty objects take no leading comma, or the written config is invalid JSON.
    if (op === "add") {
      const open = text.indexOf("{");
      const p = text.lastIndexOf("}");
      if (open !== -1 && p > open && text.slice(open + 1, p).trim() === "") {
        return { text: text.slice(0, open + 1) + `\n  "plugin": ["${want}"]` + text.slice(p), changed: true };
      }
      return p === -1 ? { text, changed: false } : { text: text.slice(0, p) + `,\n  "plugin": ["${want}"]` + text.slice(p), changed: true };
    }
    return { text, changed: false };
  }
  let lb = text.indexOf("[", k); if (lb === -1) return { text, changed: false };
  let rb = -1, d = 0, s: string | null = null, esc = false;
  for (let i = lb; i < text.length; i++) { const c = text[i]; if (s) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === s) s = null; continue; } if (c === '"' || c === "'") { s = c; continue; } if (c === "[") d++; if (c === "]") { d--; if (d === 0) { rb = i; break; } } }
  if (rb === -1) return { text, changed: false };
  const inner = text.slice(lb + 1, rb);
  const vals: string[] = []; const re = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g; let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) vals.push(m[0].slice(1, -1));
  const has = vals.some(v => normalizePluginEntry(v) === want);
  if (op === "add") {
    if (has) return { text, changed: false };
    const indent = inner.match(/\n(\s*)/)?.[1] || "    ";
    const ws = inner.match(/(\s*)$/)?.[1] || "";
    const base = inner.slice(0, inner.length - ws.length).trimEnd();
    const needsComma = base !== "" && !base.endsWith(",");
    const newInner = base + (needsComma ? "," : "") + `\n${indent}"${want}"` + ws;
    return { text: text.slice(0, lb + 1) + newInner + text.slice(rb), changed: true };
  } else {
    if (!has) return { text, changed: false };
    // Why: comma surgery preserves the JSONC the parse would drop (trailing
    // commas, comments); removal keeps separators valid either side of the cut.
    let out = inner;
    const qre = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g;
    let res = ""; let last = 0; let qm: RegExpExecArray | null;
    const parts: string[] = [];
    while ((qm = qre.exec(inner))) {
      const raw = qm[0]; const v = raw.slice(1, -1);
      const idx = qm.index;
      const before = inner.slice(last, idx);
      last = idx + raw.length;
      if (normalizePluginEntry(v) === want) {
        parts.push(before); // placeholder filtered later
        let f = last; while (f < inner.length && /\s/.test(inner[f])) f++;
        if (f < inner.length && inner[f] === ",") last = f + 1;
        else {
          const lastPart = parts[parts.length - 1] || "";
          if (lastPart.trimEnd().endsWith(",")) parts[parts.length - 1] = lastPart.replace(/,\s*$/, "");
        }
        continue;
      } else {
        parts.push(before + raw);
      }
    }
    parts.push(inner.slice(last));
    out = parts.join("");
    out = out.replace(/,\s*,/g, ",").replace(/^\s*,\s*/, "").replace(/,\s*$/, "").trim();
    let finalInner = "";
    if (out !== "") {
      const cleaned = out.split(",").map(s => s.trim()).filter(Boolean);
      finalInner = `\n    ${cleaned.join(',\n    ')}\n  `;
    }
    return { text: text.slice(0, lb + 1) + finalInner + text.slice(rb), changed: true };
  }
}

/**
 * Split an array inner range into top-level elements, respecting string
 * quotes plus `{...}`/`[...]` nesting so object-form entries (which carry
 * commas) survive comma surgery.
 */
function splitTopLevelElements(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let s: string | null = null;
  let esc = false;
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i] as string;
    if (s) {
      cur += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === s) s = null;
      continue;
    }
    if (c === '"' || c === "'") {
      s = c;
      cur += c;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    if (c === "}" || c === "]") depth--;
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** First string literal inside an element (tuple element 0 included). */
function firstStringLiteral(el: string): string | null {
  const m = el.match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/);
  return m ? (m[0] as string).slice(1, -1) : null;
}

/** Value of the "package" field inside an object-form entry, if any. */
function packageFieldOf(el: string): string | null {
  const m = el.match(/"package"\s*:\s*("([^"\\]|\\.)*"|'([^'\\]|\\.)*')/);
  return m ? (m[1] as string).slice(1, -1) : null;
}

/**
 * True when an array element denotes the wanted canonical package: bare
 * string form, `{package}` object form, or `[spec, options]` tuple form
 * (tuple compares by element 0). Disable directives never match (guard lives
 * in normalizePluginEntry).
 */
function elementDenotes(el: string, want: string): boolean {
  const trimmed = el.trim();
  if (trimmed === "") return false;
  const pkg = packageFieldOf(trimmed);
  if (pkg !== null) return normalizePluginEntry(pkg) === want;
  const first = firstStringLiteral(trimmed);
  if (first === null) return false;
  return normalizePluginEntry(first) === want;
}

/**
 * List the raw specs of one array key (strings verbatim, objects by package
 * value, tuples by element 0). Empty when the key is absent or malformed.
 */
export function listPluginSpecs(text: string, key: "plugin" | "plugins"): string[] {
  const k = findKeyPos(text, key);
  if (k === -1) return [];
  const lb = text.indexOf("[", k);
  if (lb === -1) return [];
  let rb = -1;
  let d = 0;
  let s: string | null = null;
  let esc = false;
  for (let i = lb; i < text.length; i++) {
    const c = text[i] as string;
    if (s) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === s) s = null;
      continue;
    }
    if (c === '"' || c === "'") {
      s = c;
      continue;
    }
    if (c === "[") d++;
    if (c === "]") {
      d--;
      if (d === 0) {
        rb = i;
        break;
      }
    }
  }
  if (rb === -1) return [];
  const inner = text.slice(lb + 1, rb);
  const specs: string[] = [];
  for (const el of splitTopLevelElements(inner)) {
    const t = el.trim();
    if (t === "") continue;
    const pkg = packageFieldOf(t);
    if (pkg !== null) {
      specs.push(pkg);
      continue;
    }
    const first = firstStringLiteral(t);
    if (first !== null) specs.push(first);
  }
  return specs;
}

/**
 * Splice the mesh entry into the V2 `plugins` array; malformed input returns
 * unchanged, never throws. String form is written (mesh takes no plugin
 * options); object-form `{package}` entries compare by package field.
 */
export function editPluginsArrayText(text: string, desiredEntry: string, op: "add" | "remove"): { text: string; changed: boolean } {
  const want = normalizePluginEntry(desiredEntry);
  const k = findKeyPos(text, "plugins");
  if (k === -1) {
    // Why: empty objects take no leading comma, or the written config is invalid JSON.
    if (op === "add") {
      const open = text.indexOf("{");
      const p = text.lastIndexOf("}");
      if (open !== -1 && p > open && text.slice(open + 1, p).trim() === "") {
        return { text: text.slice(0, open + 1) + `\n  "plugins": ["${want}"]` + text.slice(p), changed: true };
      }
      return p === -1 ? { text, changed: false } : { text: text.slice(0, p) + `,\n  "plugins": ["${want}"]` + text.slice(p), changed: true };
    }
    return { text, changed: false };
  }
  const lb = text.indexOf("[", k);
  if (lb === -1) return { text, changed: false };
  let rb = -1;
  let d = 0;
  let s: string | null = null;
  let esc = false;
  for (let i = lb; i < text.length; i++) {
    const c = text[i] as string;
    if (s) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === s) s = null;
      continue;
    }
    if (c === '"' || c === "'") {
      s = c;
      continue;
    }
    if (c === "[") d++;
    if (c === "]") {
      d--;
      if (d === 0) {
        rb = i;
        break;
      }
    }
  }
  if (rb === -1) return { text, changed: false };
  const inner = text.slice(lb + 1, rb);
  const elements = splitTopLevelElements(inner).filter((el) => el.trim() !== "");
  const has = elements.some((el) => elementDenotes(el, want));
  if (op === "add") {
    if (has) return { text, changed: false };
    const indent = inner.match(/\n(\s*)/)?.[1] || "    ";
    const ws = inner.match(/(\s*)$/)?.[1] || "";
    const base = inner.slice(0, inner.length - ws.length).trimEnd();
    const needsComma = base !== "" && !base.endsWith(",");
    const newInner = base + (needsComma ? "," : "") + `\n${indent}"${want}"` + ws;
    return { text: text.slice(0, lb + 1) + newInner + text.slice(rb), changed: true };
  } else {
    if (!has) return { text, changed: false };
    const kept = elements.filter((el) => !elementDenotes(el, want));
    let finalInner = "";
    if (kept.length > 0) {
      const cleaned = kept.map((el) => el.trim());
      finalInner = `\n    ${cleaned.join(",\n    ")}\n  `;
    }
    return { text: text.slice(0, lb + 1) + finalInner + text.slice(rb), changed: true };
  }
}
