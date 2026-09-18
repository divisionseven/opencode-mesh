#!/usr/bin/env bash
# Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
# SPDX-License-Identifier: MIT
# Owns cleanup policy: docs procedures name the recoverable delete tool, never bare removal.
# Corpus is docs procedures ONLY (scripts excluded by construction; script bodies legitimately invoke cleanup).
# Gate text describes the property without naming the banned token.
set -euo pipefail
ROOT="${1:-${CHECK_ROOT:-.}}"
cd "$ROOT"
# Docs procedures that discuss deletes must reference the recoverable tool.
# Fail only when a docs procedure line mentions a bare removal form without the recoverable form nearby.
violations=""
for f in docs/*.md README.md ARCHITECTURE.md CONTEXT.md skills/opencode-mesh/SKILL.md examples/quickstart.ts; do
  [ -f "$f" ] || continue
  # Lines carrying the bare two-letter removal verb as a command (with word bounds), excluding the recoverable-tool lines.
  if rg -n "(^|[^[:alnum:]_])rm([^[:alnum:]_])" "$f" 2>/dev/null | grep -qv "trash" ; then
    hits=$(rg -n "(^|[^[:alnum:]_])rm([^[:alnum:]_])" "$f" 2>/dev/null | grep -v "trash" || true)
    # Allow historical changelog-style mentions? No: docs procedures must use the recoverable form.
    # Filter to procedure-looking lines (imperative verbs) to avoid prose false positives.
    proc=$(printf '%s\n' "$hits" | grep -Ei "run|use|delete|remove|purge|clean|uninstall" || true)
    if [ -n "$proc" ]; then
      violations=$(printf '%s\n%s:%s' "$violations" "$f" "$proc")
    fi
  fi
done
if [ -n "$violations" ]; then
  echo "TRASH_FAIL: docs procedures must name the recoverable delete tool:" >&2
  printf '%s\n' "$violations" >&2
  exit 1
fi
# Shipped cleanup paths own the recoverable form too (gc drain owned here; stow adapter owned by src/install/stow.ts).
grep -q "trashPath" src/gc.ts || { echo "TRASH_FAIL: gc drain must own the recoverable form" >&2; exit 1; }
if sed 's/rmdir//g' src/gc.ts | rg -n "(^|[^[:alnum:]_])rm([^[:alnum:]_])" 2>/dev/null | grep -q .; then
  echo "TRASH_FAIL: gc user-data paths must name the recoverable delete tool" >&2
  exit 1
fi
echo "TRASH_OK docs procedures name the recoverable delete tool"
