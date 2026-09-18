#!/usr/bin/env bash
# Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
# SPDX-License-Identifier: MIT
# Owns sqlite edges: zero static edges to node:sqlite; fail-closed on loader throw.
# Behavior half (loader-throw mapping) stays in vitest; the edge count lives here.
set -euo pipefail
ROOT="${1:-${CHECK_ROOT:-.}}"
cd "$ROOT"
bad=0
for f in src/outbox.ts src/discovery.ts src/tools/mesh_send.ts src/tools/mesh_peers.ts plugin/opencode-mesh.ts; do
  [ -f "$f" ] || continue
  edges=$(grep -n 'from "node:sqlite"' "$f" 2>/dev/null | grep -v "import type" || true)
  if [ -n "$edges" ]; then echo "SQLITE_EDGES_FAIL: static edge in $f:" >&2; printf '%s\n' "$edges" >&2; bad=1; fi
done
[ "$bad" -eq 0 ] || exit 1
grep -q 'await import("node:sqlite")' src/outbox.ts || { echo "SQLITE_EDGES_FAIL: lazy leg absent from outbox" >&2; exit 1; }
grep -q "loadSqlite" src/discovery.ts || { echo "SQLITE_EDGES_FAIL: loader path absent from discovery" >&2; exit 1; }
echo "SQLITE_EDGES_OK zero static edges plus lazy legs present"
