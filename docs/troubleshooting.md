# Troubleshooting

> Error codes, common failures, and FAQ. Every error is typed `MeshError` (`src/errors.ts`) with a stable `code`, HTTP-style `status`, and optional `didYouMean` suggestions. Match with `e instanceof MeshError` on `code`, never substring matching on message text.

**Exception:** `sanitizeSessionId` (`src/xdg.ts`) throws a plain `Error` with `status: 400`, not a `MeshError`. Match it by `status`, not by class. Non-204 5xx responses arrive typed as `SERVER_UNAVAILABLE` with the raw status in the message; 429 arrives as `PEER_BUSY_RETRY`.

## Error codes

All ten codes from `MeshErrorCode` (`src/errors.ts`), priority-ordered by HTTP status.

| Code                  | Status | Meaning                                                                                    | Fix                                                                                                                                           |
| --------------------- | ------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_DIRECTORY`   | 400    | Stale directory refused at register time                                                   | Re-register from the live working directory                                                                                                   |
| `UNAUTHORIZED`        | 401    | `Basic` mismatch on the loopback port                                                      | Match `OPENCODE_SERVER_PASSWORD` to the serving instance                                                                                      |
| `BROADCAST_DISABLED`  | 403    | Broadcast without `MESH_BROADCAST=1`                                                       | Set `MESH_BROADCAST=1` or use peer-to-peer send                                                                                               |
| `PEER_NOT_FOUND`      | 404    | Exact-only resolution missed; carries display-only `didYouMean` (up to 5)                  | Re-run `mesh_peers`, send to the exact id                                                                                                     |
| `PAYLOAD_TOO_LARGE`   | 413    | Prefixed body over the 1MB guard (1048576 bytes, runtime-measured)                         | Shrink `text` and retry; send body text only, not the header                                                                                  |
| `STORAGE_CORRUPT`     | 500    | Outbox failed integrity checks                                                             | Point `OPENCODE_MESH_ROOT` at a fresh root, restart                                                                                           |
| `SERVER_UNAVAILABLE`  | 503    | POST failed with a 5xx (raw status in message); probe-fail queues instead, never this code | On this code nothing was queued (exit `1`): check server is up, then re-send; queued rows (probe-fail path) deliver on return without re-send |
| `STORAGE_UNAVAILABLE` | 503    | Outbox driver failed to load                                                               | Restart opencode to reload the driver                                                                                                         |
| `PEER_BUSY_RETRY`     | 429    | Server answered 429 on the direct POST                                                     | Back off once; one retry, then escalate                                                                                                       |
| `STORAGE_FULL`        | 507    | Per-target depth cap 100; newest write rejected, never silent                              | Wait for claimer to drain; confirm target session exists                                                                                      |

**Exit codes (CLI):** `0` ok, `1` runtime or missing `dist/`, `2` usage error.

## Common failures

Each entry: problem, symptom, fix, verification.

Full healthy-spec and per-failure table: [CLI status reference](cli.md#status).

### Plugin not discovered

**Symptom:** `status` shows plugin as `absent`; mesh tools are absent.

**Cause:** Plugin entry missing from `~/.config/opencode/opencode.json`, or opencode was not restarted after install.

**Fix:**

```bash
# 1. Install the plugin
npx opencode-mesh install

# 2. Restart opencode (plugins do not hot reload)
# 3. Check status
npx opencode-mesh status
```

If status shows skill as `not_shipped`, re-run `npx opencode-mesh install` (rewrites the skill copy) and restart opencode.

**Verify:** `status` reports plugin as `present`; `mesh_peers({})` returns results.

### Messages not delivering

**Symptom:** Send returns `admitted` but the target never acts on the message.

**Cause:** `via: "admitted"` is a server 204 only, not proof the agent saw it. The target may be busy, the session may have closed, wake is suppressed, or the sender has no local serve host on the loopback (those sends take the claim path and read `queued`, never `admitted`): unresolvable receivers never POST, the send degrades to claim and the row defers for the claimer poller instead of admitting server-side, so a well-formed but unrecognized agent never reaches the wire.

**Fix:**

```bash
# 1. Confirm the target is live
npx opencode-mesh peers --json

# 2. Check wake setting (default is wake; MESH_WAKE=0 silences)
echo $MESH_WAKE

# 2b. Confirm the receiver agent is live-recognized before re-sending
npx opencode-mesh peers --json

# 2c. If the receipt reads `queued`, the row exists and the poller owns it:
# claim-path delivery (no local serve host on the loopback), not loss.
# Confirm terminal states via receipt-by-id, never by re-sending blind.
# Confirm terminal states via mesh_peers({ receipt: "msg_..." }), CLI peers carries no receipt flag

# 3. Re-send to a fresh id if the session closed
npx opencode-mesh send <fresh-session-id> "your message"
```

**Verify:** Target conversation shows the message, or receipt via `mesh_peers({ receipt: "msg_..." })` shows delivery state.

### Outbox stuck

**Symptom:** `mesh_peers` shows queued messages never delivering; receipt stays `via: "queued"`.

**Cause:** Target session closed (claimer has nothing to inject), outbox driver failed (`STORAGE_UNAVAILABLE`), or disk full (`STORAGE_FULL`).

Note: `outbox: absent` in status alone is normal on a fresh install (no `outbox.db` yet); only treat the outbox as stuck when receipts stay `queued` or `STORAGE_*` errors appear.

**Fix:**

```bash
# 1. Check target exists and is live
npx opencode-mesh peers --json

# 2. Check outbox health
npx opencode-mesh status --json | python3 -m json.tool

# 3. Wait for TTL expiry (10 minutes, up to 25 attempts)
# 4. If target is dead, re-send after dead-letter
```

**Verify:** Receipt transitions to `injected-progressing` or `dead-lettered` (audited in `<meshRoot>/audit.log`).

### Auth failures

**Symptom:** `UNAUTHORIZED 401` on every send or status check.

**Cause:** `OPENCODE_SERVER_PASSWORD` does not match the serving instance, or the port is wrong.

**Fix:**

```bash
# 1. Match the password
export OPENCODE_SERVER_PASSWORD='<server password>'

# 2. Match the port (default 4096)
export OPENCODE_PORT=4096

# 3. For Keychain-backed servers, opt in once
export OPENCODE_MESH_KEYCHAIN_PROVIDER=1

# 4. Verify
npx opencode-mesh status --json | python3 -m json.tool
# port.auth should report env or keychain-optin

# 5. For Keychain misses, mirror the provider lookup
security find-generic-password -a "$USER" -s "opencode-server-password" -w
# stdout must read the stored password

# 6. Fall back to the bare item when the account misses
security find-generic-password -s "opencode-server-password" -w
# stdout must read the stored password
```

A miss on both variants sends no header and reads `port.auth: "none"`; see [CLI status reference](cli.md#status).

**Verify:** `status --json` shows `port.auth` matching your setup; sends succeed. `401` with `reachable: true` means the stored password mismatches. `reachable: false` also covers non-OK answers including `401`; use `port.auth` plus the send error text (`UNAUTHORIZED` vs `SERVER_UNAVAILABLE`) to tell a down server from an auth mismatch. A rotated password applies within 5 minutes or after a restart.

### Port conflicts

**Symptom:** `SERVER_UNAVAILABLE 503` or status shows `port.reachable: false`.

**Cause:** Another process occupies `OPENCODE_PORT` (default 4096), or the opencode server is not running.

Note: status also reports `port.reachable: false` when the server answers non-OK including 401; use `port.auth` plus the send error text (`UNAUTHORIZED` vs `SERVER_UNAVAILABLE`) to tell a down server from an auth mismatch.

**Fix:**

```bash
# 1. Check what is on the port
lsof -i :${OPENCODE_PORT:-4096}

# 2. For multi-instance setups, set MESH_ENUM_PORTS to probe siblings
export MESH_ENUM_PORTS=4097,4098

# 3. Restart opencode if the server is down
```

**Verify:** `status --json` shows `port.reachable: true`; `mesh_peers` returns live sessions.

### State directory issues

**Symptom:** `STORAGE_UNAVAILABLE`, `STORAGE_CORRUPT`, or status shows wrong `meshRoot`.

**Cause:** State root points to a stale, missing, or cross-filesystem path.

**Fix:**

```bash
# 1. Check the resolved root
npx opencode-mesh status --json | python3 -m json.tool
# meshRoot.resolved is the truth

# 2. Override for isolation
export OPENCODE_MESH_ROOT=/tmp/mesh-fresh/nested

# 3. For corrupt storage, point at a fresh root and restart
export OPENCODE_MESH_ROOT=/tmp/mesh-fresh/nested
# restart opencode

# 4. To recover, check trash for the old root
```

**Verify:** `status --json` shows the correct `meshRoot.resolved`; `mesh_peers` returns results.

### OpenCode 2 beta: Plugin absent

**Symptom:** On an `opencode2` beta host, `status` shows plugin as `absent` and mesh tools never appear for my agent. No error is raised.

**Cause:** The beta loader expects a dual `{id, setup}` export shape while the mesh currently ships the stable bare-function plugin (`plugin/opencode-mesh.ts`). The result is a silent skip, not a failure.

**Fix:**

```bash
# 1. Confirm you are on the beta (any 2.x host version)
opencode --version
# 2. Switch back to opencode 1.x for 1.0.0
npm install -g opencode@1
# 3. Restart opencode (plugins do not hot reload)
# 4. Check status
npx opencode-mesh status
```

**Verify:** `status` reports plugin as `present` on the 1.x host; `mesh_peers({})` returns results. V2 support is in scope and is planned for a future release on a post-1.0 feature branch; thank you for your patience. Please submit an issue if you are an `opencode2` user so we can gauge demand.

## FAQ

### Do I need to call mesh_register?

No. Every open session is already listed. Call it only to set a custom description.

```bash
opencode-mesh register "reviewer for dotfiles"
```

### Is there a daemon to run?

No. The opencode server carries all delivery. Nothing extra to run.

```bash
npx opencode-mesh status
```

Restart opencode after install. Plugins do not hot reload.

### Does Windows work?

Use Linux or macOS. Every leg is loopback `127.0.0.1`. Windows is untested. No remote transport exists.

### Where is mesh state stored?

The resolved root wins in this order (first hit):

```bash
npx opencode-mesh status --json | python3 -m json.tool
# meshRoot.resolved shows the truth
```

`OPENCODE_MESH_ROOT` first, then `XDG_STATE_HOME/opencode/mesh`, then `~/.local/state/opencode/mesh`. Use `OPENCODE_MESH_ROOT=/tmp/mesh-test/nested` to isolate a test.

### How do multiple servers work?

Stay on one machine. Set `MESH_ENUM_PORTS` to probe sibling ports. Keep `OPENCODE_PORT` at `4096` unless you run a second server. Status probes the single `OPENCODE_PORT`; siblings surface in peers.

### What does install change on my machine?

Three writes: the plugin entry in `~/.config/opencode/opencode.json`, the skill file at `~/.config/opencode/skills/opencode-mesh/SKILL.md` (mode 0644), and a snapshot at `~/.cache/opencode-mesh/snapshots/<epoch>/opencode.json.raw` (mode 0600). Nothing else.

```bash
npx opencode-mesh install --dry-run
npx opencode-mesh install
```

### How do I install on stow-managed dotfiles?

Let the installer write the stow source. It restows for you.

```bash
npx opencode-mesh install
ls -l ~/.config/opencode/opencode.json
```

### What does uninstall leave behind?

Plugin entry removed, skill file left in place, `~/.cache` snapshot left as a manual copy, mesh state root untouched. No daemon residue.

```bash
npx opencode-mesh uninstall
npx opencode-mesh status
```

### Is purge safe?

Use purge only when you mean to trash state. It needs explicit confirmation.

```bash
npx opencode-mesh uninstall --purge --yes
```

Recover the trashed root from trash. Keep the `~/.cache` snapshot.

### How big can my text be?

Keep text under 1MB (1048576 bytes for body plus prefix). Send body text only; the system prepends the sender header.

Shrink `text` and retry on `PAYLOAD_TOO_LARGE` 413. Never hand-write the `[OC-MESH | SENDER: ...]` header.

### Why must targets be exact ids?

Fuzzy names misrouted when registry data went stale. Run `mesh_peers` first, then send to one exact id. Session ID match is case-sensitive, `agent@repo` match is case-insensitive on both fields and resolves only at exactly one row. Bare names, prefixes, and multi-match rows miss with `PEER_NOT_FOUND` 404 plus up to 5 display-only `didYouMean` hints. Quarantine tags lookalike body text past position zero when `MESH_QUARANTINE=1`; it never changes target resolution.

```ts
await mesh_peers({ includeSelf: false })
await mesh_send({ target: "ses_abc123...", text: "Review pending/123.json" })
```

### How do I broadcast, and what does it cost?

Broadcast is off by default. Opt in with `MESH_BROADCAST=1`.

```bash
MESH_BROADCAST=1 opencode-mesh send all "broadcast hello" --broadcast
```

Sequential sends with per-peer ok or failed. Cost grows with peer count. Without opt-in, expect `BROADCAST_DISABLED` 403.

### What is the difference between wake and silent?

Wake is the default: each message starts a Runner turn. Silent deposits history only with a `(SILENT)` marker and no turn.

```ts
await mesh_send({ target: "ses_abc123...", text: "quiet ping", silent: true })
```

Use `--no-reply` on the CLI, or `MESH_WAKE=0` for every send. Only the exact string `"0"` silences.

## Log locations

- **Audit log:** `<meshRoot>/audit.log`. One JSONL line per delete, mode 0600, no rotation, never read by any wire path. Find your root with `npx opencode-mesh status --json` (`meshRoot.resolved`). Bound deferred — AUDIT_LOG_DEFER: no rotation yet (`runGc` returns `prunedAudit: 0` by design, never as silent completion); rotation lands with a cap plus arithmetic plus a freshness gate where the file loads.
- Nothing else logs. `status --json` plus receipts are the instruments.

## Getting help

Still stuck: file a bug with the [bug form](https://github.com/divisionseven/opencode-mesh/issues/new/choose). Attach the error text, the receipt id, and the `status --json` output. Never file private credential material; security-sensitive reports ride the [private advisory](https://github.com/divisionseven/opencode-mesh/security/advisories/new) route only.

Checklist before filing:

```bash
npx opencode-mesh status --json
# Confirm plugin, skill, port, and meshRoot are healthy
# Match code plus status in [Error Codes](#error-codes)
```

[Back to README](../README.md)
