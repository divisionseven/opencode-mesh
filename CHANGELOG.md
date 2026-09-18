# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog][keep-a-changelog],
and this project adheres to
[Semantic Versioning][sem-ver].

## [Unreleased]

### Fixed

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

[1.0.0]: https://github.com/divisionseven/opencode-mesh/releases/tag/v1.0.0
[keep-a-changelog]: https://keepachangelog.com/en/1.1.0/
[sem-ver]: https://semver.org/spec/v2.0.0.html
