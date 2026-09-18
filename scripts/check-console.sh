#!/usr/bin/env bash
# Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
# SPDX-License-Identifier: MIT
# Owns console-census: bans new console output in src/ and plugin/.
# Survivor allowlist: src/gc.ts keeps exactly 2 sites (audit CLI log + error path) with reasons.
# Corpus is shipped paths only (never scripts/), so the gate text cannot trip itself.
set -euo pipefail
ROOT="${1:-${CHECK_ROOT:-.}}"
fail() { echo "CONSOLE_FAIL: $1" >&2; exit 1; }
# Any shipped file outside the allowlist carrying a screen-line site fails.
hits=$(rg -n "console\.(log|warn|error|info|debug)" "$ROOT/src" "$ROOT/plugin" 2>/dev/null || true)
if [ -z "$hits" ]; then
  echo "CONSOLE_OK zero sites outside allowlist"
  exit 0
fi
# Allow exactly the gc.ts legacy pair; every other hit fails.
non_gc=$(printf '%s\n' "$hits" | grep -v "src/gc.ts" || true)
if [ -n "$non_gc" ]; then
  echo "CONSOLE_FAIL: unexpected screen-line sites outside gc.ts:" >&2
  printf '%s\n' "$non_gc" >&2
  exit 1
fi
gc_count=$(printf '%s\n' "$hits" | grep -c "src/gc.ts" || true)
if [ "$gc_count" -ne 2 ]; then
  echo "CONSOLE_FAIL: src/gc.ts census drift (want 2, got $gc_count)" >&2
  printf '%s\n' "$hits" >&2
  exit 1
fi
echo "CONSOLE_OK gc.ts pair only (audit CLI + error path)"
