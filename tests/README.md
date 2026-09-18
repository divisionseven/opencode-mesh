# Tests

Suite layout: one file per area (`registry`, `outbox-claimer`, `discovery-join`,
`mesh-delivery`, `lock-crash-failclosed`, `install-lifecycle`, `mesh-wake`,
`mesh-quarantine`, `broadcast-gate`, `directory-fence`, plus edge files).
Shared helpers live in `tests/fixtures/`.

36 test files, 555 tests.

## Gates

```bash
npx vitest run --pool=forks --poolOptions.forks.singleFork  # isolated, one fork
npm run coverage  # enforcing 90% floor (lines/branches/functions/statements)
bash scripts/verify-mesh-harness.sh  # 6 probed PASS
npx tsc --noEmit && npx tsc -p tsconfig.plugin.json --noEmit && npx tsc -p tsconfig.tests.json --noEmit  # triple tsc, 0 errors
```

Record host plus load average with every result. Timing walls
(broadcast dedup, persist-skip) flake under heavy load — re-run quiet
before calling a failure red. Never edit expectations to make green;
a failure after a docs-only change means the change touched code.

## Where to add tests

- Discovery/ranking → `discovery-join.test.ts`, `db-grounded-discovery.test.ts`
- Send/broadcast/wake → `mesh-delivery.test.ts`, `mesh-wake.test.ts`, `broadcast-gate.test.ts`
- Registry/locking → `registry.test.ts`, `lock-crash-failclosed.test.ts`
- Install/uninstall → `install-lifecycle.test.ts`, `install-lifecycle-boundaries.test.ts`

Keep new tests hermetic: `OPENCODE_MESH_ROOT` under `/tmp`, zero secrets,
zero network beyond loopback.
