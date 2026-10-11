// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Dist-only rewrite of emitted plugin imports.
// Rewrites ../src/ to ../ in dist plugin output only; never touches sources.
import { readFileSync, writeFileSync } from "node:fs";

const files = [
  "dist/plugin/opencode-mesh.js",
  "dist/plugin/opencode-mesh.d.ts",
  "dist/plugin/opencode-mesh-v2.js",
  "dist/plugin/opencode-mesh-v2.d.ts",
];
// Per-file minimum rewrites: .js outputs always carry ../src/ literals (they
// delegate to src/); .d.ts outputs may be clean when an entry exposes no
// src/ value types, so a clean .d.ts neither masks a dirty sibling nor fails
// the build. Zero total replacements still fails closed.
const minRewrites = { ".js": 1, ".d.ts": 0 };
let total = 0;
let failed = false;
for (const file of files) {
  const raw = readFileSync(file, "utf8");
  const count = raw.split("../src/").length - 1;
  console.log(`${file}: ${count} rewrites`);
  total += count;
  if (count > 0) writeFileSync(file, raw.split("../src/").join("../"));
  const ext = file.endsWith(".js") ? ".js" : ".d.ts";
  if (count < minRewrites[ext]) {
    console.error(`fix-plugin-imports: ${file} has ${count} rewrites, need >=${minRewrites[ext]}`);
    failed = true;
  }
}
if (total === 0) {
  console.error("fix-plugin-imports: zero replacements, expected ../src/ literals");
  process.exit(1);
}
if (failed) process.exit(1);
