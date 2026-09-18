# Configuration

All mesh behavior is driven by environment variables. No config files, no YAML, no dotfiles. Every variable is optional with sensible defaults; zero configuration is the common path.

## Environment Variables

### State & Identity

| Variable             | Default                        | Description                                                                                                                                                                                                     |
| -------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCODE_MESH_ROOT` | `~/.local/state/opencode/mesh` | Mesh state root. First hit in the resolution chain wins; overrides everything below.                                                                                                                            |
| `XDG_STATE_HOME`     | `~/.local/state`               | XDG base directory. Mesh appends `opencode/mesh` when `OPENCODE_MESH_ROOT` is unset.                                                                                                                            |
| `SESSION_ID`         | `"cli"`                        | Caller identity for CLI `peers`/`send` commands. Every plugin session uses its own session ID automatically.                                                                                                    |
| `OPENCODE_STOW_ROOT` | `~/dotfiles`                   | Stow package root for install detection plus restow cwd. Relative values resolve against home. The `dotfiles/opencode` substring heuristic stays hardcoded, so exotic layouts still depend on the fallback leg. |

### Transport

| Variable        | Default | Description                                                                                                                                                                                                                    |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENCODE_PORT` | `4096`  | OpenCode server loopback port. Status probes and `prompt_async` delivery both target this port. Single constant `4096`; `status` reports `source: env` when set, `default` otherwise. The port dials only; the server owns it. |

### Delivery Behavior

| Variable          | Default          | Description                                                                                                                                                                                                                                                                               |
| ----------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MESH_WAKE`       | unset (wake on)  | Global wake toggle. Set to `"0"` to deposit all messages as silent history-only. Global `"0"` wins over per-message flags per `resolveNoReply` truth table.                                                                                                                               |
| `MESH_BROADCAST`  | unset (off)      | Broadcast opt-in. Set to `"1"` to enable fan-out to all registered peers. Any other value blocks broadcast with a 403 before any send.                                                                                                                                                    |
| `MESH_QUARANTINE` | unset (verbatim) | Quarantine non-leading lookalikes. Set to `"1"` to tag message bodies containing an inline `[OC-MESH \| SENDER:` pattern past position zero. Leading matches (the real prefix) pass through. Target resolution is separate; see [First message](getting-started.md#section-3-manual-use). |

### Expiry

The table below lists the idle TTL knobs and their defaults. Registry deletes run via 24h prune plus status-evict; outbox GC runs explicitly via `runGc` only. Per-type auto-delete is not wired in this release (planned for future release).

| Variable                  | Default           | Description                                                                                                                                                       |
| ------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MESH_PRIMARY_TTL_MS`     | `172800000` (48h) | Idle TTL for primary sessions (parent_id NULL). Millisecond integer; invalid or absent falls back to the built-in constant.                                       |
| `MESH_SUBAGENT_TTL_MS`    | `1800000` (30m)   | Idle TTL for subagent sessions (parent_id present). Millisecond integer; invalid or absent falls back to the built-in constant.                                   |
| `MESH_TTL_OVERRIDES_JSON` | unset             | Per-agent TTL override map. JSON object mapping agent keys to millisecond integers (e.g. `{"reviewer":3600000}`). Overrides the type default for the named agent. |

### Discovery & Enumeration

| Variable                | Default                               | Description                                                                                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MESH_ENUM_PORTS`       | unset                                 | Comma-separated list of extra loopback ports to probe for sibling OpenCode instances. Each probe gets a 1-second timeout. Max 8 ports. Today the extra-port union adds nothing to peers; peers merge shared DB plus registry only. Extra-port union probes only, not merged (planned for future release). |
| `OPENCODE_MESH_DB_PATH` | `~/.local/share/opencode/opencode.db` | Explicit path to the OpenCode discovery database. Used by `mesh_peers` for DB-grounded session existence.                                                                                                                                                                                                 |

### Authentication

| Variable                          | Default      | Description                                                                                                                                                                                                                                             |
| --------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCODE_SERVER_PASSWORD`        | unset (none) | Server password. When set, all loopback requests include a `Basic` header: `base64(username:password)`.                                                                                                                                                 |
| `OPENCODE_SERVER_USERNAME`        | `"opencode"` | Username paired with `OPENCODE_SERVER_PASSWORD`.                                                                                                                                                                                                        |
| `OPENCODE_MESH_KEYCHAIN_PROVIDER` | unset (off)  | Keychain password provider opt-in. Set to `"1"` to read the password from the macOS Keychain (service: `opencode-server-password`). Only reached when `OPENCODE_SERVER_PASSWORD` is unset. Keychain setup lives in `docs/getting-started.md` Section 8. |

No password means no header (header omitted, `port.auth: "none"`). A set password means `Basic base64(user:password)` with default user `opencode` (`OPENCODE_SERVER_USERNAME` overrides the username only).

> [!NOTE]
> `USER` names the host login for the first Keychain lookup only. It is not a mesh config key. A miss sends no header and reads `port.auth: "none"`. Keychain steps live in `docs/getting-started.md` Section 8.

## State Root & Data Isolation

The state root is the single directory where all mesh data lives. The resolution chain is:

1. `OPENCODE_MESH_ROOT` (explicit override, highest priority)
2. `XDG_STATE_HOME/opencode/mesh` (XDG base)
3. `~/.local/state/opencode/mesh` (hardcoded fallback)

Everything the mesh writes lives under this root:

```
<state root>/
  registry.json        # Peer registry (heartbeat file, one row per session)
  outbox.db            # Durable message queue (SQLite WAL mode)
  audit.log            # Delete audit trail (one JSON line per eviction)
```

All directories are created with `0700` permissions. All files are created with `0600` permissions. The registry lock is PID-stamped with `O_EXCL` for cross-process safety.

### Test Isolation

Set `OPENCODE_MESH_ROOT` to a temporary path to isolate test runs:

```bash
OPENCODE_MESH_ROOT=/tmp/mesh-test/nested opencode-mesh peers
```

## Platform Defaults

| Platform | State Root                                |
| -------- | ----------------------------------------- |
| macOS    | `~/.local/state/opencode/mesh`            |
| Linux    | `~/.local/state/opencode/mesh`            |
| Windows  | `~/.local/state/opencode/mesh` (untested) |

The default path is identical across platforms. `XDG_STATE_HOME` provides the standard override mechanism on Linux and macOS. Windows is untested; the path resolves via Node.js `os.homedir()` plus the hardcoded `.local/state` suffix.

[Back to README →](../README.md)
