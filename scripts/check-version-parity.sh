#!/usr/bin/env bash
# Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
# SPDX-License-Identifier: MIT
# Owns version parity: src/version.ts VERSION equals package.json version.
# BUILD_STAMP shape plus build-script ownership via gen-version.js. Boot-line behavior stays in vitest.
set -euo pipefail
ROOT="${1:-${CHECK_ROOT:-.}}"
cd "$ROOT"
pkg_ver=$(node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)" 2>/dev/null || python3 -c "import json;print(json.load(open('package.json'))['version'])")
ver_src=$(cat src/version.ts 2>/dev/null || echo "")
printf '%s\n' "$ver_src" | grep -q "VERSION = \"$pkg_ver\"" || { echo "VERSION_PARITY_FAIL: src/version.ts lacks VERSION \"$pkg_ver\"" >&2; exit 1; }
if printf '%s\n' "$ver_src" | grep -q "0\.1\.1"; then echo "VERSION_PARITY_FAIL: stale 0.1.1 literal in src/version.ts" >&2; exit 1; fi
stamp_line=$(printf '%s\n' "$ver_src" | grep "BUILD_STAMP" | head -n 1 || true)
stamp=$(printf '%s\n' "$stamp_line" | sed -n 's/.*"\([^"]*\)".*/\1/p')
if ! printf '%s\n' "$stamp" | grep -qE "^[0-9]+\.[0-9]+\.[0-9]+\+([0-9a-f]{7}(-dirty)?|nogit)\.[0-9]{8}T[0-9]{6}Z$"; then
  echo "VERSION_PARITY_FAIL: BUILD_STAMP shape bad: $stamp" >&2
  exit 1
fi
case "$stamp" in "$pkg_ver"+*) ;; *) echo "VERSION_PARITY_FAIL: stamp lacks version prefix $pkg_ver" >&2; exit 1;; esac
node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8')); if(!/gen-version/.test(p.scripts.build||''))process.exit(1)" || { echo "VERSION_PARITY_FAIL: build script does not own generation" >&2; exit 1; }
echo "VERSION_PARITY_OK $pkg_ver $stamp"
