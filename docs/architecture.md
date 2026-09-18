# Architecture

> Technical internals for contributors. See README.md for newcomer basics.

## Background

Benchmarks live in `bench/`, usage snippets in `examples/`, the
integration harness in `scripts/verify-mesh-harness.sh`.

Newcomer flow lives in [getting-started.md](getting-started.md). Facts
below link their canonical homes instead of copying them.

| File                      | Role                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `plugin/opencode-mesh.ts` | Entry. Wires tools, heartbeat, claimer, and dispose.                                                    |
| `bin/cli.js`              | Facade. Dispatches verbs to `dist/` owners; full verbs in [cli.md](cli.md).                             |
| `src/registry.ts`         | `atomicUpdateRegistry` is the single writer; shapes in [schema.md](schema.md#registry-schema).          |
| `src/outbox.ts`           | Durable queue; shapes in [schema.md](schema.md#outbox-schema).                                          |
| `src/discovery.ts`        | Existence join behind `mesh_peers`.                                                                     |
| `src/tools/mesh_send.ts`  | Direct-vs-claim router; paths in [transport.md](transport.md#mesh-delivery).                            |
| `src/tools/mesh_peers.ts` | Ranked union display.                                                                                   |
| `src/constants.ts`        | Single source for numeric bounds; values in [configuration.md](configuration.md#environment-variables). |

<details><summary><strong>Full Module Map</strong></summary>

### Core Modules (`src/`)

| File                            | Role                                                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity.ts`                   | Single owner for identity resolution and title gating. `resolveIdentity` enriches agent+title+directory atomically. `isGenericTitle` mirrors the host's default-title predicate. |
| `frontmatter.ts`                | Canonical mesh prefix. One template owns all four header shapes (normal, silent, quarantined, combined). Also owns quarantine tagging.                                           |
| `errors.ts`                     | Typed `MeshError` with stable codes, censused from `src/errors.ts` at build time, HTTP-style status, and optional `didYouMean` suggestions.                                      |
| `fsAtomic.ts`                   | Atomic writes (`tmp+rename+fsync+fsyncDir`) and the registry-only `withRegistryLock` (PID-stamped `O_EXCL` marker, stale-lock reap, EEXIST burst absorber).                      |
| `xdg.ts`                        | State root resolution (`OPENCODE_MESH_ROOT` then `XDG_STATE_HOME` then `~/.local/state/opencode/mesh`). Owns registry, outbox, and legacy paths.                                 |
| `attach.ts`                     | Attached-session oracle. Parses `ps` output to find live opencode processes. Per-process poller at 60s cadence. Focus is always unknown.                                         |
| `claimer.ts`                    | Per-process outbox claimer. Polls every 2s, claims own session rows, injects through the local client, honors Runner busy retry.                                                 |
| `wake.ts`                       | Wake-vs-silent resolution. Global `MESH_WAKE=0` first, then per-message `silent` or legacy `noReply`. Both inject paths resolve through this module.                             |
| `expiry.ts`                     | Per-type TTL resolution with five-step precedence: attached-exempt, busy-exempt, override, type-default, dampening-hold.                                                         |
| `lastAction.ts`                 | Last-action tracker. Stamps tool use, session events, and message legs. Backward-jump clamp, forward-jump dampening.                                                             |
| `gc.ts`                         | Garbage collection. Registry stale pruning, outbox TTL drain, legacy inbox cleanup (sunset 0.3.0). Uses `trash` for user-data deletes.                                           |
| `enumerate.ts`                  | Bounded local server enumeration. Probes extra ports from `MESH_ENUM_PORTS` for multi-instance discovery.                                                                        |
| `serverAuth.ts`                 | Server auth header. Env-only `Basic` identical to the host; no password means no header.                                                                                         |
| `serverAuthKeychainProvider.ts` | Opt-in Keychain password provider. Sole `/usr/bin/security` owner. 5m cache. Only reached behind `OPENCODE_MESH_KEYCHAIN_PROVIDER=1`.                                            |
| `version.ts`                    | Package version constant.                                                                                                                                                        |

### Tool Definitions (`src/tools/`)

| File               | Role                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `index.ts`         | Barrel re-exports. Single import path for plugin and CLI.                                               |
| `mesh_register.ts` | Upsert-only registration. Generic-title guard. Returns registry claims snapshot, not the display union. |

### Installer (`src/install/`)

| File                | Role                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------- |
| `opencodeConfig.ts` | Concrete-syntax splice for `opencode.json`. Preserves trailing commas and comments.   |
| `paths.ts`          | Installer path constants: skill subpath, snapshot cache, plugin entry.                |
| `stow.ts`           | Stow Anti-Corruption Layer. Root validation, symlink detection, atomic config writes. |

</details>

## How Sends Work

`mesh_send` routes each target on loopback reachability. When the
target server answers, the message POSTs direct and the receipt reads
`via: "admitted"`. Otherwise it enqueues one canonical row for the
target claimer, and the receipt reads `via: "queued"` with a tracking
id. Registry-carried addresses are never dialed; only the loopback pin
is wired. The wire carries the receiver agent as observed with no
membership validation, so a 204 admits transport while the server
remains the final agent authority. The registry model is learned last-known
tertiary behind live and the DB row (lifecycle events carry it when the live
client is in hand; the heartbeat refreshes timestamps only). A missing model
stays absent, never synthesized. The send defers as `queued` on the direct
leg or `release` for redelivery on the claim leg. Paths and
receipts live in [Mesh Delivery](transport.md#mesh-delivery).

The claimer polls for rows owned by its own sessions and injects each
through `promptAsync`, byte-identical to typed input. Success acks the
row and failure releases it for redelivery, while `requeueStale` frees
crashed claims and `collectOutbox` prunes past TTL with a dead-letter
audit. Messages never touch disk as files. Row shapes live in
[Outbox Schema](schema.md#outbox-schema); the cycle lives in
[Recovery](transport.md#recovery-and-retry).

The sender header is built once by `formatMeshPrefix` (owner
`src/frontmatter.ts`), and bodies pass through verbatim unless
`MESH_QUARANTINE=1` opts into tagging lookalikes. Wake resolves per
message through `resolveNoReply` (owner `src/wake.ts`), with global
`MESH_WAKE=0` pinning silent deposit. Both knobs live in
[Delivery Behavior](configuration.md#delivery-behavior).

The 1 MB guard runs three times through `assertSendable`,
`assertBodySendable`, and `meshPrefixLength`, always on a
runtime-measured prefix, never an estimate. Probe budgets, poll
cadence, and busy waits are compile-time constants tabled in
[Mesh Delivery](transport.md#mesh-delivery) and
[Performance](transport.md#performance). Broadcast is opt-in: exact
`MESH_BROADCAST=1` fans out with one shared id, any other value stops
the send with `BROADCAST_DISABLED` before fan-out, and the top-level
`via` reads `"mixed"` when legs differ. The switch lives in
[Delivery Behavior](configuration.md#delivery-behavior).

## How Discovery Works

`resolveIdentity` enriches agent, title, and directory in one call, and
`isGenericTitle` stops generic titles from clobbering real ones (owner
`src/identity.ts`). Manual `mesh_register` is upsert-only: it writes
presence and returns the registry claims snapshot, never the display
union.

Discovery joins three legs: `opencode.db` read-only existence as ground
truth, the registry as freshness overlay, and live confirmation
([discovery join](../CONTEXT.md)). Every id carries exactly one
`liveSource` badge: status, heartbeat-recent, db-truth, or stale. An
empty view means unknown, and a null or ambiguous view deletes zero
rows ([peers](../CONTEXT.md)).

`mesh_peers` ranks the full union attach-first, then directory, agent,
recency plus busy, and title, with misses ranking last and zero
removals ([ranked peers](../CONTEXT.md)). Attached sessions come from
the `ps` oracle plus status union with focus always unknown
([attached](../CONTEXT.md)). Freshness also weighs the last-action
stamp of tool, session, and message activity
([last action](../CONTEXT.md)).

## How Storage Persists

Display never hides: `mesh_peers` shows every existing peer with a
freshness badge ([storage](../CONTEXT.md)). Storage keeps a 24h TTL
with confirmed-dead deletion through the 5-minute tick, `runGc`, and
peers persist. The rule is fail-closed: a good view plus an absent id
past grace deletes, while a null, ambiguous, or empty view deletes
zero. Every delete appends one JSON line to `audit.log`, and `dispose`
removes only own `seenSessions` ids ([dispose](../CONTEXT.md)).
Symbols `pruneStale` and `collectOutbox` live in `src/gc.ts`.

Expiry assigns per-type TTLs with per-agent overrides, resolved in
five-step precedence: attached-exempt, busy-exempt, override,
type-default, dampening-hold (owner `src/expiry.ts`). Knobs live in the
[Expiry](configuration.md#expiry) table; meanings live in
[CONTEXT.md](../CONTEXT.md) (`precedence`, `dampening`, `session
type`, `per-agent override`).

Durability is `tmp+rename+fsync+fsyncDir` with `0600` files and `0700`
dirs. `withRegistryLock` guards the registry only (owner
`src/fsAtomic.ts`), while SQLite transactions own outbox concurrency.
The write path lives in [Lifecycle](schema.md#lifecycle); the paths
live in [State Root](configuration.md#state-root-data-isolation).

## Bootstrap

When the host loads the plugin, the following happens in order:

1. **Host calls `plugin(input)`.** The `input` object carries the host `client` (session API, status API, promptAsync).

2. **Live client stored.** `plugin/opencode-mesh.ts` stores the client for heartbeat and claimer use. `discovery.ts:setLiveClient` also receives it for status queries.

3. **Heartbeat tick started.** `ensureHeartbeat()` starts a 5-minute interval. Each tick: reads the live status map, stamps busy sessions as active, evicts confirmed-dead own IDs (fail-closed: empty view deletes zero), re-creates evicted IDs that reappear, and heartbeats all own IDs.

4. **Claimer configured and started.** `configureClaimer` wires the session set, live client, and registry reader. `ensureClaimer()` starts a 2-second poll interval. The claimer claims own `seenSessions` rows from the outbox and injects them through the local client.

5. **Attach poller started.** `startAttachPoller()` runs at 60s cadence, parsing `ps` output to find live opencode processes. Attached IDs never expire by time alone.

6. **Tools registered.** `mesh_peers`, `mesh_send`, `mesh_register`, and `mesh_broadcast` are returned to the host. Each tool wraps `autoRegister` which: checks the debounce guard, ensures heartbeat and claimer are running, and upserts the caller's presence into the registry on first touch.

7. **Event handlers wired.** `session.created`, `session.updated`, and `session.deleted` events enrich identity, stamp last action, and manage registry presence. `tool.execute.before` stamps activity on every tool call.

8. **Dispose path.** On shutdown: clears heartbeat and claimer timers, stops the attach poller, releases owned unacked claims, and deletes own `seenSessions` IDs from the registry (past grace, attached-exempt).

The plugin never starts a file poll for delivery. Messages arrive either through the direct `prompt_async` POST or through the outbox claimer, both of which piggyback on the host's existing server.

## Reference

### Auth Modes

| Mode             | Trigger                             | Mechanism                                                                              |
| ---------------- | ----------------------------------- | -------------------------------------------------------------------------------------- |
| `none`           | `OPENCODE_SERVER_PASSWORD` unset    | No `Authorization` header sent                                                         |
| `env`            | `OPENCODE_SERVER_PASSWORD` set      | `Basic base64(opencode:password)`, username overridable via `OPENCODE_SERVER_USERNAME` |
| `keychain-optin` | `OPENCODE_MESH_KEYCHAIN_PROVIDER=1` | Reads Keychain via `/usr/bin/security`, 5m cache, only reached when `env` is unset     |

`status --json` reports `port.auth` as one of these three values.
Auth knobs live in [Authentication](configuration.md#authentication).

### Errors

`MeshError` carries a stable code plus an HTTP-style status (owner
`src/errors.ts`). Ten codes censused from source at build time:

- `PEER_NOT_FOUND` 404: no such peer; carries up to five `didYouMean` suggestions.
- `PAYLOAD_TOO_LARGE` 413: text over the 1 MB guard.
- `UNAUTHORIZED` 401: missing or wrong server password.
- `PEER_BUSY_RETRY` 429: target busy; the caller retries.
- `SERVER_UNAVAILABLE` 503: target server not answering.
- `STORAGE_FULL` 507: outbox depth cap hit; newest row rejected.
- `STORAGE_CORRUPT` 500: outbox unreadable; delete it and let it recreate.
- `STORAGE_UNAVAILABLE` 503: store missing or unreachable.
- `INVALID_DIRECTORY` 400: stale directory refused.
- `BROADCAST_DISABLED` 403: broadcast without the exact opt-in.

`didYouMean` lists up to five near misses on 404s, computed the same
way for direct and resolve misses. Full per-code recovery lives in
[Troubleshooting](troubleshooting.md#error-codes).

### Config

All knobs live in [configuration.md](configuration.md); no env table
is copied here.

### Gates

Gates live where they run: `tests/` (vitest),
`scripts/verify-mesh-harness.sh` (probe count owned by the script),
triple `tsc --noEmit`, and the `rg` censuses beside each invariant.
Version in `src/version.ts`; test files under `tests/`.

### Security Pointers

- Loopback only: every HTTP leg targets `127.0.0.1`. See [Mesh Delivery](transport.md#mesh-delivery).
- State root permissions (`0700` dirs, `0600` files) live in [State Root](configuration.md#state-root-data-isolation).
- The server password travels only in the loopback `Authorization` header, never in transcripts or the registry. See [Authentication](configuration.md#authentication).
- Registry writes go only through `atomicUpdateRegistry`; `readRegistry` never writes back. See [Registry Schema](schema.md#registry-schema).
- Each claimer claims only rows for sessions it owns. See [Outbox Schema](schema.md#outbox-schema).
