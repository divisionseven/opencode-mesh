# Contributing to OpenCode-Mesh

Thank you for contributing! This guide is the funnel from clone to merged PR.

- [Setup](#setup)
- [Structure map](#structure-map)
- [Workflow and branching](#workflow-and-branching)
- [Standards and commands](#standards-and-commands)
- [Test gates](#test-gates)
- [Commit format](#commit-format)
- [PR gates](#pr-gates)
- [Release outline](#release-outline)

## Setup

Prerequisites: Node `>=22`, opencode `>=1.3.13`, `zsh`, `python3`.

```bash
git clone https://github.com/divisionseven/opencode-mesh.git
cd opencode-mesh
npm ci
npm run build  # mandatory: dist/ is gitignored; the CLI exits 1 without it
```

Verify the toolchain once (see [Test gates](#test-gates) for what green means):

```bash
npm run typecheck
npm test
zsh scripts/verify-mesh-harness.sh
```

## Structure map

Key areas of `src/` and what they own. See [ARCHITECTURE.md](ARCHITECTURE.md) for deep internals.

| Area        | Files                     | Responsibility                                   |
| ----------- | ------------------------- | ------------------------------------------------ |
| Constants   | `constants.ts`            | Thresholds, TTL values, env var keys             |
| Errors      | `errors.ts`               | Typed `MeshError` codes and failure shapes       |
| Registry    | `registry.ts`             | Address book persistence (read never writes)     |
| XDG paths   | `xdg.ts`                  | State root resolution and platform paths         |
| Atomic FS   | `fsAtomic.ts`             | `tmp+rename+fsync+fsyncDir` durability           |
| Discovery   | `discovery.ts`            | Peer union from DB, registry, and live status    |
| Attach      | `attach.ts`               | Live session ownership via `ps` and status       |
| Outbox      | `outbox.ts`               | Durable SQLite queue (WAL, one row per delivery) |
| Claimer     | `claimer.ts`              | Per-process poller for queued message injection  |
| Wake        | `wake.ts`                 | Silent vs wake-default delivery policy           |
| Frontmatter | `frontmatter.ts`          | Wire prefix formatting (the `OC-MESH` header)    |
| Identity    | `identity.ts`             | Session agent/title resolution and enrichment    |
| Expiry      | `expiry.ts`               | TTL precedence and idle-based session pruning    |
| GC          | `gc.ts`                   | Registry pruning and legacy drain                |
| Auth        | `serverAuth.ts`           | Server password and Keychain provider            |
| Enumerate   | `enumerate.ts`            | Sibling port discovery for multi-instance        |
| Last action | `lastAction.ts`           | Freshness tracking for tool use and events       |
| Version     | `version.ts`              | Version stamp                                    |
| Install     | `install/`                | Config splicer, stow ACL, path constants         |
| Tools       | `tools/`                  | CLI verb implementations (peers, send, register) |
| Plugin      | `plugin/opencode-mesh.ts` | Single entry point for the OpenCode host         |

Comment-only edits welcome anywhere; behavior edits need a gate (see below).

## Workflow and branching

1. Fork the repo and clone your fork.
2. Create a feature branch:
   ```bash
   git checkout -b feat/amazing
   ```
   Branch names: `feat/*`, `fix/*`, `docs/*`, `chore/*` matching the commit type.
3. Make changes with Conventional Commits (see [Commit format](#commit-format)).
4. Run checks locally before pushing:
   ```bash
   npm run typecheck && npm test && zsh scripts/verify-mesh-harness.sh
   ```
    Questions? See [Support](README.md#support--community).
5. Push `git push origin feat/amazing` and open a Pull Request against `main`.
6. One concern per PR, with verification output pasted.
7. `src/` wording-only rule for prose PRs: comments/strings/logs only, zero behavior change.

See `docs/getting-started.md` and `ARCHITECTURE.md` for internals. Keep edits focused
per doc file and verify every `rg` gate you quote.

## Standards and commands

- TypeScript strict: `npm run typecheck` → 0 errors (triple `tsc`: root plus plugin plus tests).
- Comment house style: one-line WHY plus constraint plus honest failure on
  non-obvious logic; public functions carry Summary, Args, Returns, Raises,
  Example; every file carries the MIT SPDX banner in the first two lines.
- Comment voice rules (quotable, audited per sentence):
  - Describe present behavior, not history or intent.
  - No plan labels, ticket codes, or interim markers.
  - Cite symbols, never line pins.
  - Ship for the reader, no other audience.
  - One owner, one sentence per comment.
  - Third-person present tense.
- Banned tokens: bare ticket codes, line pins, plan labels, essay scaffolding,
  em dashes; audit with quoted sentences, not impressions.
- `_private` prefix means private; the re-export surface
  (`dist/plugin/opencode-mesh.js`) never widens without a plan.
- Shell: `zsh -n scripts/*.sh` clean; Python helpers: `python3 -m py_compile scripts/*.py` clean.
- Exit codes stay `{0, 1, 2}` (`bin/cli.js` dispatch); new failure modes ride
  typed `MeshError` codes in `src/errors.ts`, never ad-hoc strings.
- Line length: 100 characters max.
- No em dashes or other "AI-tells" in prose. Use a comma or parentheses instead.

## Test gates

Record host plus load average with every gate result. Gate stamping rule: never
green-over-red (never show green over a recorded red), restamp to the isolated
rerun or strike the claim.

- Suite green is `npm test` (config owns the isolated single-fork pool) with all
  files passing (rerun isolated when wall-clock flakes under load).
- Harness green is `zsh scripts/verify-mesh-harness.sh` ending `HARNESS_DONE`
  with `FAIL=0` (probe count owned by the script).
- Pack green is `npm pack --dry-run` with `dist/plugin/opencode-mesh.js` exactly
  once and `dist/index.js`, `dist/src`, `docs/`, `plugin/*.ts` zero times.
- Typecheck green is all three `tsc` projects at 0 errors.
- Coverage measured is `npm run coverage` reporting lines, branches,
  functions, and statements (90% is the target, thresholds in `vitest.config.ts`).

Tests live in `tests/` and run under vitest.

- Every behavior change needs a test. Comment-only changes do not.
- Rerun parallel-only failures in isolation before marking the build red. If
  isolated green passes, file it as infrastructure, not regression.

## Commit format

Conventional Commits, lowercase scope optional:

- `feat: add mesh_peers includeSelf nuance`
- `fix: correct PEER_NOT_FOUND didYouMean ranking`
- `docs: update getting-started 5-step funnel`
- `chore: bump deps`
- `test:`, `refactor:`, `perf:`, `ci:`, `build:`, `revert:`, `security:` complete
  the 11 accepted types.

## PR gates

The PR template checklist enforces: typecheck 0 errors, suite green (isolated),
coverage measured (`npm run coverage` percentages pasted),
`zsh -n` plus `py_compile` clean, pack gates (`dist/plugin/opencode-mesh.js` →1,
leaks →0), `TODO(PUBLISH` →0, quickstart proof `<30s`. Docs PRs update the
changelog; behavior PRs update the affected reference table.

## Release outline

Maintainer-only: tag `v*` → TODO gate → `gen-version` → build → pack gates →
typecheck → test → `npm pack` → `npm publish --provenance` →
`gh release create`.
