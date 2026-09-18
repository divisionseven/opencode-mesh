// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// CST preserve-whole-file splicer.
/** Canonicalize plugin entry to package name; variants compare as one install. */
export function normalizePluginEntry(e: string): string {
  const t = e.trim();
  if (t === "opencode-mesh") return "opencode-mesh";
  if (t.endsWith("opencode-mesh.ts") || t.endsWith("opencode-mesh.js")) return "opencode-mesh";
  return t.includes("opencode-mesh") ? "opencode-mesh" : t;
}
/**
 * Splice mesh entry into plugin array; malformed input returns unchanged, never throws.
 */
export function editPluginArrayText(text: string, desiredEntry: string, op: "add" | "remove"): { text: string; changed: boolean } {
  const want = normalizePluginEntry(desiredEntry);
  const k = text.indexOf('"plugin"');
  if (k === -1) {
    if (op === "add") { const p = text.lastIndexOf("}"); return p === -1 ? { text, changed: false } : { text: text.slice(0, p) + `,\n  "plugin": ["${want}"]` + text.slice(p), changed: true }; }
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
