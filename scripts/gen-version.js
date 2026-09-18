// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// Version source lock: semver plus sha plus dirty flag.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const ver = pkg.version;
// Build stamp: semver plus short sha plus dirty flag plus utc generation
// time. Git reads never throw: gitless builds fall back to the nogit shape.
function readShortSha() {
  try {
    const raw = execSync("git rev-parse --short=7 HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (/^[0-9a-f]{7}$/.test(raw)) return raw;
  } catch {}
  return "nogit";
}
function readDirtySuffix() {
  try {
    const raw = execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] }).toString();
    if (raw.trim().length > 0) return "-dirty";
  } catch {}
  return "";
}
function readUtcStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
const sha = readShortSha();
const dirtySuffix = sha === "nogit" ? "" : readDirtySuffix();
const buildId = `${sha}${dirtySuffix}`;
const buildTime = readUtcStamp();
const buildStamp = `${ver}+${buildId}.${buildTime}`;
try {
  writeFileSync(
    "src/version.ts",
    `// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)\n// SPDX-License-Identifier: MIT\nexport const VERSION = "${ver}";\nexport const BUILD_ID = "${buildId}";\nexport const BUILD_TIME = "${buildTime}";\nexport const BUILD_STAMP = "${buildStamp}";\n`
  );
} catch {
  try {
    writeFileSync(
      "src/version.ts",
      `// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)\n// SPDX-License-Identifier: MIT\nexport const VERSION = "${ver}";\nexport const BUILD_ID = "nogit";\nexport const BUILD_TIME = "${buildTime}";\nexport const BUILD_STAMP = "${ver}+nogit.${buildTime}";\n`
    );
  } catch {}
}
console.log(`gen-version ${ver} → src/version.ts`);
