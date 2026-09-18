#!/usr/bin/env bash
# Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
# SPDX-License-Identifier: MIT
# Owns SPDX banner gate: ports the banner loops from ci.yml verbatim.
# Extended executable list per the Script Wiring Standard (shebang-first form, lines 2-3).
set -euo pipefail
ROOT="${1:-${CHECK_ROOT:-.}}"
cd "$ROOT"
missing=0
for f in src/*.ts src/tools/*.ts src/install/*.ts plugin/*.ts scripts/gen-version.js scripts/fix-plugin-imports.js scripts/add_spdx_headers.js; do
  [ -f "$f" ] || continue
  head -2 "$f" | rg -q "Copyright \(c\) 2026 DIVISION 7 \| MI-7" || { echo "missing banner: $f" >&2; missing=1; }
  head -2 "$f" | rg -q "SPDX-License-Identifier: MIT" || { echo "missing banner: $f" >&2; missing=1; }
done
for f in bin/cli.js scripts/check-todo-publish.sh scripts/verify-mesh-harness.sh scripts/check-*.sh scripts/check-version.py scripts/extract-changelog.py scripts/build-release-notes.py; do
  [ -f "$f" ] || continue
  head -3 "$f" | rg -q "SPDX-License-Identifier: MIT" || { echo "missing banner: $f" >&2; missing=1; }
done
head -2 src/version.ts | rg -q "SPDX-License-Identifier: MIT" || { echo "missing banner: src/version.ts (regen via node scripts/gen-version.js)" >&2; missing=1; }
if [ "$missing" -eq 0 ]; then echo "SPDX_OK"; else exit 1; fi
