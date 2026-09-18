# CLI reference

> Complete reference for the `opencode-mesh` command-line interface. All verbs, flags, and exit codes sourced from `bin/cli.js`. For agent tool equivalents (`mesh_peers`, `mesh_send`), see [getting-started.md](getting-started.md#section-4-sending-and-replying).

## Usage

```
opencode-mesh <command> [options]
```

Run with no arguments to print help (exits `2`). Run any command with `--help` or `-h` to print its usage (exits `0`).

## Commands

### `peers`

List discovered mesh peers ranked by freshness.

```
opencode-mesh peers [--include-self] [--json]
```

| Flag             | Effect                                    |
| ---------------- | ----------------------------------------- |
| `--include-self` | Include the calling session in the output |
| `--json`         | Output raw JSON, same ranked list         |

Output is always JSON. The peer list merges three sources: SQLite database, registry heartbeat file, and live TCP probe. Each peer carries a freshness badge (`status`, `heartbeat-recent`, `db-truth`, or `stale`). Ranking puts attached sessions first, then matches by directory, agent name, busy flag, and recency. Pick live `status` for direct sends, `heartbeat-recent` for recent rows, `db-truth` for DB-only rows needing fresh heartbeat, `stale` means re-check before sending. Rank 1 is the top pick; ranking is display order only, never a filter. Copy `sessionId`, `agent`, `directory`, `liveSource` from [First message](getting-started.md#section-3-manual-use).

```bash
opencode-mesh peers
# JSON with ranked peers, status, agent, directory, freshness badge
```

### `send`

Send a message to a peer session or broadcast to all peers.

```
opencode-mesh send <target|all> <text> [--no-reply] [--broadcast]
```

| Flag          | Effect                                          |
| ------------- | ----------------------------------------------- |
| `--no-reply`  | Deposit message without waking the target agent |
| `--broadcast` | Send to all peers (requires `MESH_BROADCAST=1`) |

Both `<target>` and `<text>` are required. Use `all` or `--broadcast` for fan-out. The target accepts an exact session ID (case-sensitive, full ID only, no prefix), or an exact full-field `agent@repo` that denotes exactly one row (case-insensitive on both fields, agent from session record plus repo from directory basename). Bare `agent`, bare `repo`, prefix ID, and multi-match `agent@repo` all miss with `PEER_NOT_FOUND` 404 plus `didYouMean` display names (up to 5, deduped, not sendable); nothing is sent on a miss. Tool gate lowercases `all`; CLI passes `<target>` verbatim, so `ALL` fans out only through the tool gate.

`--broadcast` discards any named target and fans out to all peers. `send all` without the env flag and `send <id> --broadcast` without the env flag both fail with `BROADCAST_DISABLED` 403 before any send; nothing is queued. The flag must read the exact string `"1"`.

```bash
opencode-mesh send ses_abc123 "hello from the CLI"
# Receipt: { "ok": true, "via": "admitted", "target": "ses_abc123", ... }
# Singleton `agent@repo` resolves only at exactly one match; two matches miss with `PEER_NOT_FOUND` 404.
# CLI has no receipt lookup. Confirm `admitted` (204, server accepted, reader unconfirmed) through the receiver's conversation, or track `queued` rows by `id` via the tool interface `mesh_peers({ receipt: "msg_…" })`. See [Delivery Receipts](transport.md#delivery-receipts).

opencode-mesh send all "broadcast message"
# Requires MESH_BROADCAST=1; sends to every peer (zero sends without it, exit 1)

opencode-mesh send ses_abc123 "broadcast message" --broadcast
# Named id discarded, fans out to all peers (requires MESH_BROADCAST=1)

opencode-mesh send ses_abc123 "silent update" --no-reply
# Deposits history without waking the agent
```

### `register`

Register the calling shell session in the mesh registry.

```
opencode-mesh register [<summary>]
```

No flags. The summary defaults to `cli register` when omitted. Prints JSON with the assigned session ID and current peer count.

```bash
opencode-mesh register "reviewer for dotfiles"
# { "registered": "cli-<epoch>", "peers": 3 }
```

Contract: `register` writes one `cli-<epoch>` row (`agent: "cli"`, current directory, supplied summary or `cli register`) and prints `{ registered, peers }`. Blast radius: one registry row; no config, no skill, no network.

### `install`

Install the opencode-mesh plugin into your OpenCode configuration.

```
opencode-mesh install [--dry-run]
```

| Flag        | Effect                                                     |
| ----------- | ---------------------------------------------------------- |
| `--dry-run` | Prints a diff of config changes without writing; exits `0` |

The install performs two operations:

1. Adds the plugin entry to `~/.config/opencode/opencode.json` (stow-aware).
2. Writes the agent skill to `~/.config/opencode/skills/opencode-mesh/SKILL.md` (byte-compared; silent when present).

A snapshot of the prior config is saved before any write. Restart opencode after install to load the plugin.

```bash
opencode-mesh install --dry-run
# Shows diff of config changes, no writes

opencode-mesh install
# Installs plugin + skill; restart opencode to activate
```

Contract: `install` writes at most two paths (plugin entry in `opencode.json`, skill copy when bytes differ) after saving a snapshot of the prior config. `--dry-run` writes nothing. Blast radius: config + skill only; no sessions, no state root, no network fetches.

### `uninstall`

Remove the opencode-mesh plugin from your OpenCode configuration.

```
opencode-mesh uninstall [--purge] [--yes]
```

| Flag      | Effect                                                        |
| --------- | ------------------------------------------------------------- |
| `--purge` | Delete the mesh state directory (registry, outbox, snapshots) |
| `--yes`   | Confirm purge without interactive prompt                      |

Without `--purge`, only the plugin entry is removed from the config. With `--purge`, the entire state directory is trashed. Always pass `--yes` with `--purge` to skip the confirmation hint.

```bash
opencode-mesh uninstall
# Removes plugin entry from opencode.json

opencode-mesh uninstall --purge --yes
# Removes plugin entry and trashes mesh state directory
```

Contract: `uninstall` removes the plugin entry only (skill file, cache snapshot, and mesh state root untouched). `--purge` deletes the state directory and requires `--yes`; without `--yes` it prints the confirm hint and exits `0`. Blast radius without `--yes`: config entry only. With `--purge --yes`: entire state root trashed (recover from trash; keep the cache snapshot).

### `status`

Show mesh health diagnostics.

```
opencode-mesh status [--json]
```

| Flag     | Effect                                     |
| -------- | ------------------------------------------ |
| `--json` | Output raw JSON instead of formatted lines |

Status runs six checks in parallel: plugin presence, skill presence, mesh root path and provenance, registry directory permissions, outbox reachability, and port probe with latency. Elapsed time is computed separately.

| Field                         | Provenance                                                                                   | Healthy                                                                  | Unhealthy                                                                                                        | Notes                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `plugin`                      | `~/.config/opencode/opencode.json` contains `opencode-mesh` (stow source then live)          | `present`                                                                | `absent`                                                                                                         | Restart opencode after install; plugins do not hot-reload |
| `skill`                       | `~/.config/opencode/skills/opencode-mesh/SKILL.md` stat                                      | `present`                                                                | `not_shipped`                                                                                                    | Re-run `install`, restart opencode                        |
| `meshRoot.resolved`           | `OPENCODE_MESH_ROOT` else `XDG_STATE_HOME/opencode/mesh` else `~/.local/state/opencode/mesh` | resolved path                                                            | same (always resolves)                                                                                           | `meshRoot.provenance` names the winning leg               |
| `registryPerm`                | octal mode of mesh root (`stat`), `absent` when missing                                      | `"700"`                                                                  | `absent` or non-`700`                                                                                            | First touch is owner-only                                 |
| `outbox`                      | `stat` of outbox path                                                                        | `reachable` (`absent` is normal on fresh install with zero queued sends) | `absent` with stuck `queued` receipts, or `STORAGE_*` errors                                                     | Only treat as stuck when receipts stay `queued`           |
| `port.constant`               | single constant `4096` unless `OPENCODE_PORT` set                                            | `4096` or env value                                                      | —                                                                                                                | Single owner in constants; drives probe and POST          |
| `port.source`                 | `OPENCODE_PORT` set or not                                                                   | `env` or `default`                                                       | —                                                                                                                | Env wins                                                  |
| `port.reachable`              | loopback `GET /session/status` 1s probe                                                      | `true`                                                                   | `false` (also `false` on non-OK including 401; use `port.auth` + error text to separate down from auth mismatch) | —                                                         |
| `port.latencyMs`              | measured probe time                                                                          | small ms number                                                          | large / timeout                                                                                                  | Re-measure on host; no bound promised                     |
| `port.liveCount`              | unwrapped status map key count                                                               | `>=0`                                                                    | `0` with `reachable: false`                                                                                      | Counts sessions, never wrapper keys                       |
| `port.auth`                   | header built or not                                                                          | `none`, `env`, or `keychain-optin`                                       | `none` when password never reached process                                                                       | Absent-by-default; header omitted                         |
| `elapsedMs` (`elapsed` human) | wall time of the six checks                                                                  | same number in JSON and human                                            | —                                                                                                                | JSON prints `elapsedMs`, human prints `elapsed: <n>ms`    |

```bash
opencode-mesh status
# plugin: present
# skill: present
# meshRoot: { "resolved": "~/.local/state/opencode/mesh", "provenance": "default" }
# registryPerm: "700"
# outbox: reachable
# port: { "constant": 4096, "source": "default", "reachable": true, "latencyMs": 2, "liveCount": 3, "auth": "none" }
# elapsed: 45ms

opencode-mesh status --json
# { "plugin": "present", "skill": "present", ... }
```

## Flags

### Global

| Flag           | Effect          | Exit code |
| -------------- | --------------- | --------- |
| `--help`, `-h` | Print help text | `0`       |
| (no arguments) | Print help text | `2`       |

### Per-command

| Command     | Flag             | Effect                  |
| ----------- | ---------------- | ----------------------- |
| `peers`     | `--include-self` | Include calling session |
| `send`      | `--no-reply`     | Silent deposit, no wake |
| `send`      | `--broadcast`    | Fan-out to all peers    |
| `install`   | `--dry-run`      | Preview changes only    |
| `uninstall` | `--purge`        | Delete state directory  |
| `uninstall` | `--yes`          | Confirm purge           |
| `status`    | `--json`         | JSON output             |

## Exit codes

| Code | Meaning                                                                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success: command ran, `--help` printed, `--dry-run` previewed, already installed, already uninstalled, or purge without `--yes` printed the confirm hint |
| `1`  | Error: `dist/` missing (run `npm install && npm run build`), `send` missing required arguments, `send` delivery error, or unknown command                |
| `2`  | Usage: no arguments provided                                                                                                                             |

## Common patterns

### Power cycle

Reinstall the plugin after an update:

```bash
opencode-mesh uninstall
opencode-mesh install
# restart opencode
opencode-mesh status
```

### Check status

Verify the plugin is wired correctly:

```bash
opencode-mesh status --json | python3 -m json.tool
```

### Install plugin

Preview before writing:

```bash
opencode-mesh install --dry-run
opencode-mesh install
# restart opencode
```

### Send to all sessions

Fan-out requires the broadcast env var:

```bash
MESH_BROADCAST=1 opencode-mesh send all "deployment complete"
```

## Environment variables

These variables affect CLI behavior. All are read at runtime from the process environment.

| Variable             | Default        | Used by                                                                                               |
| -------------------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| `SESSION_ID`         | `"cli"`        | `peers`, `send` (caller identity)                                                                     |
| `OPENCODE_MESH_ROOT` | resolved chain | every verb (state root)                                                                               |
| `OPENCODE_PORT`      | `4096`         | `status` probe plus `send` probe and POST (single constant `4096`; `source` reads `env` or `default`) |
| `MESH_BROADCAST`     | `unset (off)`  | `send` fan out (exact `"1"` enables)                                                                  |
| `MESH_WAKE`          | `unset (wake)` | `send` silence (exact `"0"` silences, global wins)                                                    |
| `MESH_ENUM_PORTS`    | `unset`        | `peers` sibling probe ([Multi-instance](getting-started.md#section-7-multi-instance))                 |

The state root resolves in order: `OPENCODE_MESH_ROOT` then `XDG_STATE_HOME/opencode/mesh` then `~/.local/state/opencode/mesh`. `SESSION_ID` defaults to `"cli"` for `peers`/`send` caller identity (tool sessions use their own session ID automatically); `peers` excludes self unless `--include-self` is passed. `OPENCODE_PORT` dials only; status probes it alone while peers merge siblings.
