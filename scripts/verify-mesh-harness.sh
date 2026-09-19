#!/usr/bin/env bash
# Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
# SPDX-License-Identifier: MIT
# Wire behavior checks plus outbox checks plus hyperfine plus bench
# Timing policy (advisory): spawn timing numbers print serially only, never parallel
# with the suite; hyperfine timing never fails the harness, only functional
# mismatch (wrong output, missing field, nonzero exit) fails it.
set -euo pipefail
command -v rg >/dev/null 2>&1 || { echo "harness: rg not found" >&2; exit 1; }
ROOT="${OPENCODE_MESH_ROOT:-$(mktemp -d "${TMPDIR:-/tmp}/mesh-harness.XXXXXX")}"
echo "ROOT=$ROOT"
PASS=0; FAIL=0
ok(){ echo "$1 PASS probed"; PASS=$((PASS+1)); }
fail(){ echo "FAIL: $1"; FAIL=$((FAIL+1)); }
out_tsc=$(npx tsc --noEmit 2>&1 || true) # || true: scan owns the verdict, not the producer exit
if rg -q "error" <<<"$out_tsc"; then fail 'TSC_OK'; else ok 'TSC_OK'; fi
out_tsc_plugin=$(npx tsc -p tsconfig.plugin.json --noEmit 2>&1 || true) # || true: scan owns the verdict, not the producer exit
if rg -q "error" <<<"$out_tsc_plugin"; then fail 'TSC_PLUGIN_OK'; else ok 'TSC_PLUGIN_OK'; fi
out_fsa=$(node bench/fsAtomic-bench.mjs 20 2>&1 || true) # || true: scan owns the verdict, not the producer exit
if rg -q "PASS" <<<"$out_fsa"; then ok 'BENCH_FSATOMIC_OK'; else fail 'BENCH_FSATOMIC_OK'; fi
out_bc=$(node bench/broadcast-bench.mjs 2>&1 || true) # || true: scan owns the verdict, not the producer exit
if rg -q "PASS" <<<"$out_bc"; then ok 'BENCH_BROADCAST_OK'; else fail 'BENCH_BROADCAST_OK'; fi
FIXRT="$ROOT/outbox-rt"
out_rt=$(OPENCODE_MESH_ROOT="$FIXRT" node --input-type=module -e "import('./dist/outbox.js').then(async (m) => { const id = await m.enqueue({ target_session: 'ses-h', from_session: 'ses-g', from_agent: 'a', text: 'rt' }, process.env.OPENCODE_MESH_ROOT); const rows = await m.claim(['ses-h'], 'o1', 1, process.env.OPENCODE_MESH_ROOT); if (rows.length !== 1 || rows[0].id !== id) throw new Error('claim mismatch'); if (!await m.ack(id, 'o1', process.env.OPENCODE_MESH_ROOT)) throw new Error('ack failed'); const n = await m.pendingCount(['ses-h'], process.env.OPENCODE_MESH_ROOT); if (n !== 0) throw new Error('pending not zero'); console.log('RT_OK'); })" 2>&1 || true) # || true: scan owns the verdict, not the producer exit
if rg -q "RT_OK" <<<"$out_rt"; then ok 'OUTBOX_ROUNDTRIP_OK'; else fail 'OUTBOX_ROUNDTRIP_OK'; fi
out_st=$(OPENCODE_MESH_ROOT="$ROOT" node bin/cli.js status --json 2>/dev/null || true) # || true: scan owns the verdict, not the producer exit
if rg -q '"outbox"' <<<"$out_st"; then ok 'STATUS_OUTBOX_OK'; else fail 'STATUS_OUTBOX_OK'; fi
echo "HARNESS_DONE PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0
