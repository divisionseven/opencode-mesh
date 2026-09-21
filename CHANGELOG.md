# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog][keep-a-changelog],
and this project adheres to
[Semantic Versioning][sem-ver].

## [Unreleased]

## [1.1.0] - 2026-09-21

### Added

- CLI grew a `gc` verb with `--json` output, per-verb `--help` on every verb, multiword send text, `--json` flags on peers and send, snapshot restore on uninstall, and a purge fallback that reports its method (gate: E2E suite spawning the real binary plus `codecov/patch` green)
- Keychain reads gained a non-blocking path with Linux `secret-tool` fallback sharing the existing TTL cache, wired into the enumerate probe (gate: fallback tests failing before, green after)
- Enumerate probes cap response bodies at 1MB, hashing over-cap bodies empty while small bodies fingerprint byte-identical (gate: over-cap and completion tests failing before, green after)
- Install docs lead with the platform path (plugin entry plus skill by name) with the custom installer kept as a documented alternate (gate: skills CLI discovery verified live against this repo)

### Fixed

- Fix fresh installs writing invalid JSON on empty plugin configs by taking a no-leading-comma branch on blank object bodies (gate: matrix test asserting `JSON.parse` over three empty shapes)
- Fix corrupt registry wipes by refusing writes on present-but-unparseable stores with `STORAGE_CORRUPT`, leaving entries intact (gate: garbage-seed test asserting survival plus the throw)
- Fix GC deleting concurrent joins by snapshotting candidates read-only and re-validating inside the single writer (gate: mid-sweep join repro asserting survival)
- Fix per-sweep trashing of live state by gating deletion behind legacy-directory detection, leaving live `outbox` and `token` paths alone (gate: live-plus-legacy seed test)
- Fix transient direct failures dropping by routing 429, 5xx, and network faults to the claim leg; 404 misses keep `PEER_NOT_FOUND` with `didYouMean`, 401 keeps `UNAUTHORIZED`, and direct 429 now queues instead of surfacing (gate: two-leg test with typo target plus stubbed 500 and 429)
- Fix broadcast dropping its tail by removing the mid-fanout 413 rethrow and reporting every peer in the failed list (gate: three-peer fan-out with middle failure)
- Fix sandboxed roots sharing the live lock by threading an optional root through `withRegistryLock` from every writer (gate: two-root test asserting per-root lock files)
- Fix forged direct senders by re-attesting the sender against the live registry on the direct leg, marking unknown senders quarantined (gate: unknown-agent send asserting the marker)
- Fix status-only sessions reading as attached by conferring attached from the `ps` oracle alone (gate: ps-plus-status feed asserting only `ps` ids attach)
- Fix empty status views clearing markers by treating null and empty maps as no-evidence past grace (gate: marker held across an empty view)
- Fix permission faults misclassified as contention by narrowing `isLockContention` and the lock loop to `EEXIST` only, so `EACCES` throws loud instead of degrading register to `busy: true` (gate: injected `EACCES` asserting the loud throw)
- Fix delivered rows re-claimable in the take window by adding the `delivered_at IS NULL` exclusion as defense-in-depth (gate: deliver-then-claim asserting zero rows)
- Fix leading lookalike markers passing quarantine by tagging at any position when enabled (gate: index-zero feed asserting the tag)
- Fix peers display mutating the registry by removing the persist from the read path, output byte-identical (gate: dead-id list asserting byte-identical registry)
- Fix full-disk misses on the Node driver by also mapping numeric `errcode` 13 to `STORAGE_FULL`, proven against real full disks on both drivers with no permission shape colliding (gate: exact Node error-shape replay)
- Fix unknown commands exiting 1 by printing usage and exiting 2 under the usage contract (gate: E2E spawn asserting code plus stderr)
- Replace the dependency-review deny list with the allow list for `MIT, Apache-2.0, ISC, BSD-3-Clause, MPL-2.0` (gate: CI green)

### Removed

- Drop the broadcast mutant probe and registry retention probe: both read repo source and asserted on text, banned under the vitest rules, with behavior already owned by gate and prune tests (gate: full suite green minus two plus a repo-wide source-read sweep)

## [1.0.1] - 2026-09-19

### Added

- Hardened timing-sensitive tests to deterministic outcomes (lock contention re-race, minute-boundary assertions, heartbeat stamp polling), so CI results are reliable run to run.
- Added regression tests pinning outbox failure vocabulary, claimer poll behavior, send resolution, peers display, plugin tool paths, store shapes, and garbage-collection edges.

### Fixed

- Fix purge logs to omit the resolved path and keep only the provenance label, so env-derived paths never reach clear-text output (gate: CodeQL clear-text logging check)
- Fix garbage collection to remove legacy outbox and token paths with filesystem removal when the trash binary is absent, so pruning still completes on minimal hosts (gate: trash policy script)
- Fix CI to run shell steps under bash, install ripgrep before gates, and build the plugin before typecheck and tests (gate: CI green on Node 22 and 24)
- Fix CI reliability with pinned actions, step timeouts, permission checks, and pack leak gates (gate: CI green with artifact upload)

## [1.0.0] - 2026-09-16

Initial release. Works with OpenCode 1.x (`>=1.3.13 <2.0.0`). Support for OpenCode v2 is in scope and planned for a future release (see README Current Limitations).

### Added

- Message any OpenCode session on the same machine, across repos and terminals. No daemon to run.
- See who is online with one command. Sessions show up on their own, ranked with a freshness label so you know who is live.
- Wake the other session by default, or stay quiet with per-message silent mode and a global quiet switch when you only want to leave a note.
- Get a receipt for every send. It tells you if the message was delivered live or queued for later.
- Reach busy sessions without losing work. Queued messages wait safely and deliver in order when the target is ready.
- Announce to everyone at once with opt-in broadcast. It stays off until you turn it on.
- Install in one step from OpenCode or with npx, preview with a dry run, and remove cleanly with uninstall. Your prior config is saved before anything changes.
- Teach your sessions the workflow with no extra setup. The bundled skill loads on its own when the plugin starts.
- Work from six small commands: `peers`, `send`, `register`, and `status` output JSON for scripts, while `install` and `uninstall` print plain text.
- Stay local and safe. Traffic never leaves your machine, and the server password reads from the environment when set.
- Rely on manual cleanup. You run garbage collection to prune stale entries and delivered messages, with idle limits for background and main sessions.
- Verify a release from its pipeline output. The release workflow generates checksums and a software bill of materials.

### Security

- Report sensitive issues through the private advisory channel in `SECURITY.md`.

[1.1.0]: https://github.com/divisionseven/opencode-mesh/releases/tag/v1.1.0
[1.0.1]: https://github.com/divisionseven/opencode-mesh/releases/tag/v1.0.1
[1.0.0]: https://github.com/divisionseven/opencode-mesh/releases/tag/v1.0.0
[keep-a-changelog]: https://keepachangelog.com/en/1.1.0/
[sem-ver]: https://semver.org/spec/v2.0.0.html
