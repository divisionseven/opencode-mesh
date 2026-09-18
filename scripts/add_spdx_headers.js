// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Idempotent MIT SPDX banner inserter.
// Generated src/version.ts skipped; gen-version.js emits its banner itself.
import { readFileSync, writeFileSync } from "node:fs";

const JS_BANNER = [
  "// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)",
  "// SPDX-License-Identifier: MIT",
];
const SH_BANNER = [
  "# Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)",
  "# SPDX-License-Identifier: MIT",
];

const JS_FILES = [
  "src/attach.ts",
  "src/claimer.ts",
  "src/constants.ts",
  "src/discovery.ts",
  "src/enumerate.ts",
  "src/errors.ts",
  "src/expiry.ts",
  "src/frontmatter.ts",
  "src/fsAtomic.ts",
  "src/gc.ts",
  "src/identity.ts",
  "src/install/opencodeConfig.ts",
  "src/install/paths.ts",
  "src/install/stow.ts",
  "src/lastAction.ts",
  "src/outbox.ts",
  "src/registry.ts",
  "src/serverAuth.ts",
  "src/serverAuthKeychainProvider.ts",
  "src/tools/index.ts",
  "src/tools/mesh_peers.ts",
  "src/tools/mesh_register.ts",
  "src/tools/mesh_send.ts",
  "src/wake.ts",
  "src/xdg.ts",
  "plugin/opencode-mesh.ts",
  "plugin/test-seam.ts",
  "bin/cli.js",
  "scripts/gen-version.js",
  "scripts/fix-plugin-imports.js",
];

const SH_FILES = [
  "scripts/check-todo-publish.sh",
  "scripts/verify-mesh-harness.sh",
];

function addBanner(path, banner) {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  // Already present at line 1, or at line 2 behind a shebang — idempotent exit.
  if (lines[0] === banner[0] && lines[1] === banner[1]) return "ok";
  if (lines[0].startsWith("#!") && lines[1] === banner[0] && lines[2] === banner[1]) return "ok";
  let next;
  if (lines[0].startsWith("#!")) {
    // Why: shebang must stay line 1 or the kernel cannot exec the file.
    next = [lines[0], ...banner, ...lines.slice(1)].join("\n");
  } else {
    next = [...banner, ...lines].join("\n");
  }
  writeFileSync(path, next);
  return "added";
}

let added = 0;
for (const f of JS_FILES) {
  const st = addBanner(f, JS_BANNER);
  if (st === "added") added++;
  console.log(`${st} ${f}`);
}
for (const f of SH_FILES) {
  const st = addBanner(f, SH_BANNER);
  if (st === "added") added++;
  console.log(`${st} ${f}`);
}
// NOTE: src/version.ts intentionally skipped — scripts/gen-version.js emits its banner.
console.log(`spdx-headers done, ${added} added`);
