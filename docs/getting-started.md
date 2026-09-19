# Getting Started

> From zero to first message between two sessions. Covers installation, first
> message, delivery modes, multi-instance setup, auth, and upgrades.

## Section 1: Prerequisites

Two dependencies. Nothing else.

### Node.js

Version 22 or higher.

```bash
# macOS (Homebrew)
brew install node

# Linux (nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 22

# Windows (winget)
winget install OpenJS.NodeJS.LTS
```

Verify:

```bash
node --version
# v22.x.x or higher
```

### OpenCode

Version 1.x (1.3.13 or higher, below 2.0.0). Tested against 1.18.x.

```bash
# npm
npm install -g opencode

# Homebrew
brew install opencode
```

Verify:

```bash
opencode --version
# 1.3.13 or higher, below 2.0.0 (1.x only)
```

### Platform notes

The mesh shells out to `/usr/bin/security`, `ps`, `trash`, `stow`, `rg`, and `ls`. Each call degrades silently when its binary is missing. A missing `/usr/bin/security` reads no Keychain password and sends no header. A failed `ps` cycle yields an empty attached snapshot and never stops the poller. A failed restow never fails the write. Scripts run under bash; examples are POSIX-compatible. Install and purge roots accept homedir at depth 3 or more or tmpdir at depth 2 or more; bare `/tmp` and depth 1 tmp paths never validate.

## Section 2: Install

Three paths. Pick one.

### Path 1: OpenCode Plugin (recommended)

```bash
# requires opencode 1.x (1.3.4+, below 2.0.0)
opencode plugin opencode-mesh --global
```

This registers the plugin in your global `~/.config/opencode/opencode.json` and
the bundled agent skill auto-loads on the next start. No file copy, no extra
step. Then restart OpenCode so the plugin loads. Plugins do not hot-reload.

Project-local instead of global: omit `--global` to register the plugin for the
current project directory only. Prefer global: the mesh is cross-repo by design
(a session in one repo messages a session in another), and a project-local entry
loads in one directory only.

### Path 2: npx (fallback for older opencode versions)

```bash
npx opencode-mesh install

# preview install before writing
npx opencode-mesh install --dry-run
```

- **What it does:** `npx` self-fetches the published package and then runs its
  `install` routine, this single command writes the plugin entry to
  `~/.config/opencode/opencode.json`, copies the agent skill to
  `~/.config/opencode/skills/opencode-mesh/SKILL.md`, and saves a snapshot of
  your prior config to `~/.cache/opencode-mesh/snapshots/`. Nothing else
  changes.
- **Verify:** `npx opencode-mesh status` shows `plugin: present`,
  `skill: present`.
- **Error Handling:** If (`absent` / `not_shipped`): re-run
  `npx opencode-mesh install`, restart opencode (plugins do not hot-reload),
  re-run status.

Use this path when the host predates `config`-hook skill support, when your
dotfiles are stow-managed, or when no registry is reachable. Dotfiles outside
`~/dotfiles` set `OPENCODE_STOW_ROOT` to the stow root. Relative values resolve
against home. Unstowed files read the live path; stowed files write the source then restow, with a `dotfiles/opencode` substring fallback for exotic layouts. The full key lives in `configuration.md`.

### Path 3: source clone (contributors)

```bash
git clone https://github.com/divisionseven/opencode-mesh.git
cd opencode-mesh
npm install
npm run build
npx opencode-mesh install
```

The build is mandatory. `dist/` is gitignored and the CLI exits 1 without it.

### Library use (not an install)

```bash
npm install opencode-mesh
npm ls @opencode-ai/plugin @opencode-ai/sdk
```

**Library Use:** `import` the plugin module in your own code or inspect deps
with `npm ls`, that is the only reason for this command. It writes zero config,
copies zero skills, and the mesh will NOT work after it alone. To verify it did
not install: `npx opencode-mesh status` still shows `plugin: absent` as
expected. For a working mesh installation `npx opencode-mesh install` (or
`opencode plugin opencode-mesh --global`), restart opencode to load it, then
`npx opencode-mesh status` until `plugin: present`
([status reference](cli.md#status)).

### Verify installation

```bash
npx opencode-mesh status
# plugin: present
# skill: present
# (JSON: identical fields, plus elapsedMs; human prints elapsed: <n>ms — same number, both JSON and human output print the same elapsed time value)
```

Healthy status also reads `registryPerm: "700"`, `outbox: "reachable"` (or
`absent` on a fresh install with zero queued sends), and
`port: { reachable: true, auth: none|env|keychain-optin }`. Meanings for every
non-healthy value: [CLI status reference](cli.md#status).

Then restart OpenCode so the plugin loads. Plugins do not hot-reload.

Confirm the skill auto-loaded (Path 1): the host skill listing names it, and any
session answers a mesh question peers-first with zero manual copy:

```bash
opencode debug skill
```

What install touches: plugin entry in `opencode.json`, skill file, config
snapshot. Nothing else. No network fetches, no daemon, no session changes.

### OpenCode version scope

`opencode-mesh` currently supports opencode 1.x only (`>=1.3.13 <2.0.0`). On the `opencode2` v2 beta the plugin is silently skipped: the beta host expects a dual `{id, setup}` export shape the mesh does not ship, so no mesh tools appear and no error is raised. Stay on the opencode 1.x binary for now; v2 support is in scope and planned for a future release. Detail: [Troubleshooting](troubleshooting.md#opencode-2-beta-plugin-absent).

## Section 3: Manual Use

### First Message

*The mesh system is designed for agent-to-agent use. However, if you want to
manually operate the mesh system for programmatic use or other testing purposes,
this is how it works. For normal agent-driven operation, simply tell your agent
to message another session.*

Three steps. Under 30 seconds on a cold start.

#### Step 1: Discover

Open two sessions in separate terminals. In session A, list who is online:

```bash
npx opencode-mesh peers --json
```

You see both sessions. Each carries a session ID, agent name, working directory,
and a status badge. Copy session B's full ID. Session ID match is case-sensitive and exact-only, prefix misses. Full-field `agent@repo` match is case-insensitive and resolves only at exactly one row. Bare names and prefixes miss with `PEER_NOT_FOUND` 404. Badges read `status`, `heartbeat-recent`, `db-truth`, `stale`. Send now to `status`, treat `stale` as re-check first. Rank 1 is the top pick. Copy `sessionId`, `agent`, `directory`, `liveSource` for the send.

#### Step 2: Send

From session A, send to session B:

```bash
npx opencode-mesh send <session-B-id> "hello from A"
```

You get a receipt: `ok: true`, `via: "admitted"` (live delivery) or
`via: "queued"` (waiting in the outbox), plus a receipt `id` starting with
`msg_`.

#### Step 3: Reply

Session B receives the message as a normal prompt. Reply by sending back to
session A's ID:

```bash
npx opencode-mesh send <session-A-id> "pong from B"
```

Session A receives the text as a normal assistant message. That is the entire
protocol.

#### Verify something went wrong (on purpose)

Send to a bad ID and watch the guard:

```bash
npx opencode-mesh send "fake-id" "hi"
# PEER_NOT_FOUND 404 with didYouMean suggestions
```

Nothing was sent. Exact-only resolution fails loud before any write. `didYouMean` names are display hints only, not sendable targets. Lookalike body text is a quarantine question, not a target question, see Body rules below.

## Section 4: Sending and Replying

### Sync vs async

A send is either admitted or queued. The receipt tells you which.

| `via`      | Meaning                        | What happens next                     |
| ---------- | ------------------------------ | ------------------------------------- |
| `admitted` | Server took it -- 204 returned | Receiver processes immediately        |
| `queued`   | Outbox row created             | Claimer delivers when target is ready |

`admitted` is not proof the reader saw it. It is proof the server accepted it.
Confirm through the receiver's conversation.

### Reply pattern

There is no separate reply primitive. Reply is a reverse send -- the target
session sends back to the sender's session ID. The ID appears on the first line
of every received message.

### Receipts

Either session can track a delivery by receipt ID. Receipt lookup is available
through the mesh tool interface (`mesh_peers` with the `receipt` parameter), not
through the CLI.

Receipt states: `queued` (waiting), `injected-progressing` (204 seen, reader
unconfirmed), `dead-lettered` (exceeded max attempts), `failed-permanent` (row
gone).

### Body rules

Send body text only. The system prepends the sender header automatically. Never
hand-write the `[OC-MESH | SENDER: ...]` header.

Bodies plus the runtime-measured prefix must fit 1048576 bytes. Text over 1MB
refuses, serialized bodies at or over 1MB refuse. Exceeding it returns
`PAYLOAD_TOO_LARGE` 413 before any write.

Lookalike text passes through verbatim by default. Exact `MESH_QUARANTINE=1`
tags bodies with an inline pattern past position zero as
`[QUARANTINED-LOOKALIKE]`. Leading matches pass through, default-off passes
verbatim.

### Progress events

When the claim path queues behind a busy target, the send succeeds as `queued`. The claimer polls every 2 seconds and delivers in order. The receipt tracks the state through the queue. Before injecting a claimed row the claimer waits 550-650ms on `busy` or `retry` status, then injects.

Direct sends to a busy target return `PEER_BUSY_RETRY` 429 immediately. Nothing is queued. Retry once, then escalate; the CLI exits 1.

## Section 5: Wake vs Silent

### Decision table

| Scenario                            | Use wake (default) | Use silent |
| ----------------------------------- | ------------------ | ---------- |
| Delegate work to another session    | Yes                |            |
| Check status without interrupting   |                    | Yes        |
| Log activity for audit trail        |                    | Yes        |
| Notify of a completed task          | Yes                |            |
| Ping to confirm a session is alive  |                    | Yes        |
| Send data without triggering a turn |                    | Yes        |

### Per-message silence

```bash
npx opencode-mesh send <target> "quiet ping" --no-reply
```

The message deposits as history with a `(SILENT)` marker. No agent turn starts
on the receiver. The receiver can read it later.

Tool calls take canonical `silent: true`. Legacy `noReply: true` is honored
when `silent` is omitted. The header reads `[OC-MESH | SENDER (SILENT): ...]`.

### Global silence

```bash
MESH_WAKE=0 npx opencode-mesh send <target> "quiet"
```

Any value other than the exact string `"0"` (including unset) keeps wake
enabled. Wake is the zero-configuration default. Global `"0"` wins over
per-message flags.

### Diagnose "admitted but no wake"

The receipt says `admitted` but the receiver never turned. Check, in order:

1. Was the send silent? Global `MESH_WAKE=0` wins over per-message flags, and
   per-message `silent: true` (or legacy `noReply: true` when `silent` is
   omitted) deposits history-only by design. CLI spells silent as `--no-reply`
   with no `--silent` flag. Re-send wake-default.
2. Is the target busy? The turn queues behind the running one. Confirm via the
   receiver's conversation. Do not re-send in a loop.

## Section 6: Broadcast

Broadcast sends one message to every peer. Off by default.

### Opt in

```bash
MESH_BROADCAST=1 npx opencode-mesh send all "hello everyone" --broadcast
```

Without `MESH_BROADCAST=1`, the send fails with `BROADCAST_DISABLED` 403 before
any message is sent. The flag must be the exact string `"1"`.

### Delivery mode

Broadcast fans out with N sequential legs -- one `prompt_async` POST per peer,
one at a time. Each peer gets its own receipt. `via` reads `admitted`,
`queued`, or `mixed` across legs. Registry-only fan out, caller excluded,
DB-only rows excluded. Tool lowercases `all`, CLI match is case sensitive per
facade normalize. At scale, prefer peer-to-peer sends over broadcast.

### When to use broadcast

- Announcing availability to all sessions
- Coordinated shutdown or status check
- Large-group notifications

For anything targeting fewer than five peers, send individually. Sequential legs
add latency proportional to peer count.

## Section 7: Multi-instance

One mesh root can span several OpenCode server processes on the same machine.

### Port configuration

`OPENCODE_PORT` dials only; it never serves. The OpenCode server owns the port and answers `127.0.0.1` loopback legs. The default loopback port is `4096`. Override with `OPENCODE_PORT`:

```bash
OPENCODE_PORT=4097 npx opencode-mesh status
```

Status probes the single `OPENCODE_PORT` only; see [CLI status reference](cli.md#status).

### Expose sibling ports

```bash
MESH_ENUM_PORTS=4097,4098 npx opencode-mesh peers --json
```

`MESH_ENUM_PORTS` lists extra loopback ports to probe, up to 8 with a 1-second timeout each. Today peers merge shared DB plus registry rows only; the extra-port union adds nothing to peers until wired. Status still probes the single `OPENCODE_PORT`; non-default servers surface in peers only through shared DB plus registry, with a `4096` fallback on the registry leg. Extra-port union probes only, not merged (planned for future release).

### State isolation

All instances share one mesh state root. The root resolves in order:

1. `OPENCODE_MESH_ROOT` (explicit override)
2. `XDG_STATE_HOME/opencode/mesh` (XDG base)
3. `~/.local/state/opencode/mesh` (default)

Set `OPENCODE_MESH_ROOT` to a temp directory to isolate tests:

```bash
OPENCODE_MESH_ROOT=/tmp/mesh-test/nested npx opencode-mesh peers
```

### Stale peers

Sessions register on start. A quiet sibling reads `stale` until the 24-hour prune. Unreachable status deletes nothing.

## Section 8: Authentication

### Auth modes

| Mode             | What happens                              |
| ---------------- | ----------------------------------------- |
| `none`           | No password set. No auth header sent.     |
| `env`            | Password from `OPENCODE_SERVER_PASSWORD`. |
| `keychain-optin` | Password from OS Keychain (opt-in).       |

### Env-based auth

Default installs send no header until a password is set; `port.auth` reads `none` then.

```bash
export OPENCODE_SERVER_PASSWORD='<server password>'
```

The mesh builds a `Basic base64(username:password)` header. The default username
is `opencode`. Override with `OPENCODE_SERVER_USERNAME`.

Non-default username:

```bash
export OPENCODE_SERVER_USERNAME='<name>'
export OPENCODE_SERVER_PASSWORD='<password>'
```

### Keychain auth (opt-in)

```bash
export OPENCODE_MESH_KEYCHAIN_PROVIDER=1
```

The mesh reads the OS Keychain through `/usr/bin/security` and caches for 5
minutes. Default installs never set this. Unset the variable to return to
env-only. Hosts without `/usr/bin/security` read no Keychain password and send
no header.

#### Step 1: Store the password

Store one item; either form suffices. The mesh tries the `$USER` account first, then the bare item.

```bash
security add-generic-password -a "$USER" -s "opencode-server-password"
# stdout must read empty; a prompt collects the password
security add-generic-password -s "opencode-server-password"
# stdout must read empty; a prompt collects the password
```

Never pass the password with `-w` on the command line. Omit `-w` so `security`
prompts without echo.

#### Step 2: Verify the lookup

Mirror the provider argv with `security` directly.

```bash
security find-generic-password -a "$USER" -s "opencode-server-password" -w
# stdout must read the stored password
security find-generic-password -s "opencode-server-password" -w
# stdout must read the stored password
```

The first command matches the `-a` account variant argv. The second
command matches the bare `-s` fallback argv. A missing
`find-generic-password` variant exits nonzero; the provider then tries the
next.

`OPENCODE_SERVER_USERNAME` changes the header username only. The stored
service name never varies. `OPENCODE_SERVER_PASSWORD`
bypasses the Keychain entirely when set. Default username reads `opencode`
on both paths. `$USER` names the host login for the first lookup only; outside `^[A-Za-z0-9._-]{1,64}$` the provider skips it and tries the bare item. A miss sends no header and reads `port.auth: "none"`; a miss also caches for 5 minutes like a hit.

**Symptom:** `status` still sends the old password after rotation.

**Cause:** The `getKeychainPassword` cache holds success and miss for 5
minutes.

**Fix:**

```bash
# 1. Overwrite the stored item in place
security add-generic-password -U -a "$USER" -s "opencode-server-password"
# stdout must read empty after the overwrite
security add-generic-password -U -s "opencode-server-password"
# stdout must read empty after the overwrite
# 2. Wait 5 minutes, or restart OpenCode for immediate pickup
sleep 300
# restart clears the module cache
# cache must read expired when the sleep ends
```

**Verify:** `status` sends with the new password after the wait.

No stored item means no header. The provider returns `undefined` and the
mesh sends no header.

Delete your stored items to reverse the setup.

```bash
security delete-generic-password -a "$USER" -s "opencode-server-password"
# output must read empty; the item is gone
security delete-generic-password -s "opencode-server-password"
# output must read empty; the item is gone
```

The mesh then behaves as before the setup.

### Verify auth

```bash
npx opencode-mesh status --json | python3 -m json.tool
# port.auth must read "env" or "keychain-optin"
# port.reachable must read true
```

If `port.auth` reads `none`, the password never reached the process. If
`reachable` reads false, the server is down, on another port, or answered non-OK including `401`; check `port.auth` plus the send error text per [Port conflicts](troubleshooting.md#port-conflicts).

### ACL behavior

The mesh authenticates as the configured username against the OpenCode server.
There is no separate ACL layer -- the server controls access. A `401` response
means the password mismatches the serving instance.

### Rules that never change

No password means no header. A set password means `Basic base64(user:password)`.
The mesh never hands the password to the model. Keep transcripts under `/tmp`
roots free of passwords, tokens, and registry dumps.

## Section 9: Upgrading

### Upgrade steps

```bash
# Update the package
npm install opencode-mesh@latest

# Restart OpenCode (plugins do not hot-reload)
# Verify
npx opencode-mesh status
```

Package update only; no config change (no postinstall hook). Re-run
`npx opencode-mesh install` only if status shows `absent`/`not_shipped`.

The plugin entry names the package, not a version, so no reinstall is needed on
upgrade. Stay current hands-free with the `autoupdate` key in `opencode.json`
(`true` to auto-update, `"notify"` for update notices only):

```json
{
  "autoupdate": "notify"
}
```

The fallback path (`npx opencode-mesh install`) still refreshes the plugin entry
and the skill copy when run. A config snapshot is saved before any write.

### Breaking changes

Check the [CHANGELOG](../CHANGELOG.md) before upgrading. Key history:

- 1.0.0 shipped one plugin entry with pack-gate enforcement.
- Pre-0.2.0 `inbox`/`.owner` file format drained within 24 hours. Legacy drain
  is sunset in 0.3.0.
- The file-mailbox transport was removed in favor of the TUI-identical wire
  format.

### Rollback

If something breaks after upgrade, the config snapshot at
`~/.cache/opencode-mesh/snapshots/` holds your pre-change config. Copy it back
to `~/.config/opencode/opencode.json` and restart OpenCode.

To remove the plugin entirely:

```bash
npx opencode-mesh uninstall
```

To also trash mesh state:

```bash
npx opencode-mesh uninstall --purge --yes
```

This requires the `trash` binary. Without it, purge reports done and deletes
nothing.

---

## What's next

- [Section 4: Sending and Replying](#section-4-sending-and-replying) → the full
  send/reply workflow
- [Section 5: Wake vs Silent](#section-5-wake-vs-silent) → control delivery
  behavior
- [Section 7: Multi-instance](#section-7-multi-instance) → multi-server setup
- [Section 8: Authentication](#section-8-authentication) → authentication setup
- [configuration.md](configuration.md) → all config keys
- [cli.md](cli.md) → CLI reference
- [troubleshooting.md](troubleshooting.md) → when things fail
