// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Dist-only rewrite of emitted plugin imports.
// Rewrites ../src/ to ../ in dist plugin output only; never touches sources.
import { readFileSync, writeFileSync } from "node:fs";

const files = ["dist/plugin/opencode-mesh.js", "dist/plugin/opencode-mesh.d.ts"];
let total = 0;
for (const file of files) {
  const raw = readFileSync(file, "utf8");
  const count = raw.split("../src/").length - 1;
  console.log(`${file}: ${count} rewrites`);
  total += count;
  if (count > 0) writeFileSync(file, raw.split("../src/").join("../"));
}
if (total === 0) {
  console.error("fix-plugin-imports: zero replacements, expected ../src/ literals");
  process.exit(1);
}
