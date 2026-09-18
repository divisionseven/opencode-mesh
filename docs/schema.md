# Schema Reference

Exact stored shapes for `registry.json` and `outbox.db`. Code owners are `src/registry.ts` and `src/outbox.ts`. Receipt states live in [Delivery Receipts](transport.md#delivery-receipts).

## Registry Schema

The registry is a JSON address book stored at the path resolved by `resolveRegistryPath` under the mesh state root. It maps session IDs to peer metadata. Only one writer exists: `atomicUpdateRegistry`, which holds an in-process chain lock plus a cross-process `flock` guard.

### Top-level document

```
{ "version": 1, "entries": {}, "migratedAt": 0 }
```

| Key          | Type                               | Meaning                                         |
| ------------ | ---------------------------------- | ----------------------------------------------- |
| `version`    | const `1`                          | Schema tag; parsed as integer equality check    |
| `entries`    | map `sessionId` to `RegistryEntry` | The full peer set                               |
| `migratedAt` | epoch ms                           | Set once on first write; heartbeats never reset |

### RegistryEntry columns

Interface defined in `src/registry.ts`. Aliases normalized by `normalizeEntry` on every read and write.

| Column           | Type     | Required | Derived?                                                                                 |
| ---------------- | -------- | -------- | ---------------------------------------------------------------------------------------- |
| `sessionId`      | string   | yes      | no, map key                                                                              |
| `agent`          | string   | yes      | no, `unknown` sentinel, never null                                                       |
| `title`          | string   | no       | no                                                                                       |
| `description`    | string   | no       | alias of `summary`, synced on read                                                       |
| `directory`      | string   | no       | alias of `cwd`, absolute or absent                                                       |
| `cwd`            | string   | no       | alias of `directory`, read only                                                          |
| `summary`        | string   | no       | alias of `description`, synced on read                                                   |
| `model`          | string   | no       | no, `provider/model` string when known; absent when unknown (omitted, never synthesized) |
| `updatedAt`      | epoch ms | yes      | no                                                                                       |
| `migratedAt`     | epoch ms | no       | no, per-row import stamp                                                                 |
| `attached`       | boolean  | no       | yes, oracle tier, old rows omit                                                          |
| `attachedAt`     | epoch ms | no       | yes, last attach observation                                                             |
| `focus`          | string   | no       | yes, always unknown marker                                                               |
| `lastActionAt`   | epoch ms | no       | yes, clamped max stamp                                                                   |
| `sessionType`    | string   | no       | yes, absent reads `primary`                                                              |
| `ttlOverrideTag` | string   | no       | yes, audit taxonomy tag                                                                  |
| `repo`           | string   | no       | yes, `basename(directory)`, compat only                                                  |

No default model is synthesized. `resolveMeshModel` takes only a verified-present token (slash-less takes the `opencode` provider prefix); a missing model resolves to null in `resolveReceiverWireDetailed` (reasons `registry-no-model`, `db-parse-fail`, `live-miss-parse`, and kin) and delivery defers honestly (`queued` on the direct leg, `release` for redelivery on the claim leg).

### Normalized aliases

`normalizeEntry` syncs bidirectional aliases on every pass:

- `description` and `summary` are kept identical. If one is present and the other is not, the missing one is synthesized from the present one.
- `directory` and `cwd` are kept identical. If one is present and the other is not, the missing one is synthesized from the present one.
- `repo` is derived from `basename(directory)` when absent.
- `title` falls back to `description` when absent.
- Empty or non-absolute `directory` values are deleted on sight.

### Dropped fields

These fields are stripped on sight, never persisted for new rows:

- `daemon` (legacy key)
- `serveUrl`, `servePort` (route state owned by loopback pin)
- Display-only rank keys: `attachedRank`, `dirRank`, `agentRank`, `recencyRank`, `titleRank`, `rank`

### Lifecycle

- **Heartbeat**: every 5 minutes, each process updates `updatedAt` for its own session IDs via `atomicUpdateRegistry`.
- **Pruning**: `pruneStale` drops entries where `now - updatedAt` exceeds 24 hours.
- **Eviction**: `pruneDeadByStatus` deletes entries confirmed absent from a live status snapshot, subject to a 60-second grace window for freshly registered IDs.
- **Legacy migration**: on first read of an empty version-1 document, the registry imports non-stale entries from the legacy `registry.json` path, gated by the live status probe.

Registry deletes run via `pruneStale` (24h) and `pruneDeadByStatus` (status-evict, 60s grace); outbox deletes run via `runGc`/`collectOutbox` explicitly. Per-type auto-delete is not wired in this release (planned for future release).

## Outbox Schema

The outbox is a SQLite database stored at the path resolved by `resolveOutboxPath`. It holds one row per message delivery. Concurrency is managed by SQLite transactions, not file locks.

### SQLite configuration

```
PRAGMA journal_mode = WAL
PRAGMA busy_timeout = 5000
PRAGMA synchronous = FULL
```

### Table definition

```sql
CREATE TABLE IF NOT EXISTS outbox(
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT UNIQUE NOT NULL,
  target_session TEXT NOT NULL,
  from_session   TEXT NOT NULL,
  from_agent     TEXT NOT NULL,
  text           TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  broadcast_id   TEXT,
  claimed_by     TEXT,
  claimed_at     INTEGER,
  delivered_at   INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  silent         INTEGER NOT NULL DEFAULT 0,
  fail_reason    TEXT,
  sender_build   TEXT,
  miss_layer     TEXT,
  miss_reason    TEXT,
  build          TEXT
)
```

`fail_reason` ships in the `CREATE TABLE`. `sender_build`, `miss_layer`,
`miss_reason`, and `build` arrive through the self-healing `ALTER TABLE`
path on first open (same `PRAGMA table_info` check plus duplicate-column
catch as `silent` and `fail_reason`), so the DDL above is the
post-migration shape: fresh databases carry every column, migrated ones
converge on first access with zero row rewrites.

### Column reference

| Column           | Type                     | Meaning                                                                    |
| ---------------- | ------------------------ | -------------------------------------------------------------------------- |
| `seq`            | integer PK autoincrement | FIFO order per target                                                      |
| `id`             | text unique not null     | Envelope id, `msg_` brand, idempotent key                                  |
| `target_session` | text not null            | Receiver session id                                                        |
| `from_session`   | text not null            | Sender session id                                                          |
| `from_agent`     | text not null            | Sender agent name                                                          |
| `text`           | text not null            | Body under the 1 MB guard                                                  |
| `created_at`     | integer not null         | Epoch ms enqueue time                                                      |
| `broadcast_id`   | text nullable            | Shared fan-out id, null for direct                                         |
| `claimed_by`     | text nullable            | Claim owner, null means free                                               |
| `claimed_at`     | integer nullable         | Epoch ms claim time                                                        |
| `delivered_at`   | integer nullable         | Set on inject, reader still unconfirmed                                    |
| `attempts`       | integer default `0`      | Inject tries, cap 25                                                       |
| `silent`         | integer default `0`      | `1` pins `noReply` on the claim inject                                     |
| `fail_reason`    | text nullable            | Terminal reason, closed `OutboxFailReason` vocabulary; NULL while routable |
| `sender_build`   | text nullable            | Generation that enqueued the row; NULL on pre-migration rows               |
| `miss_layer`     | text nullable            | Terminal miss layer from the resolver trail; NULL until `failRow` commits  |
| `miss_reason`    | text nullable            | Terminal miss reason from the resolver trail; NULL until `failRow` commits |
| `build`          | text nullable            | Generation that terminalized the row; NULL until `failRow` commits         |

### Indexes

| Name                    | Columns                      | Purpose                     |
| ----------------------- | ---------------------------- | --------------------------- |
| `idx_outbox_target_seq` | `(target_session, seq)`      | FIFO claim order per target |
| `idx_outbox_claim`      | `(claimed_by, delivered_at)` | Crash-recovery claim scans  |

### Row lifecycle

1. **Enqueue**: `enqueue` inserts a row with `claimed_by = NULL`, `delivered_at = NULL`. The 1 MB guard runs before any transaction. Depth is capped at 100 per target; overflow rejects with `STORAGE_FULL`.
2. **Claim**: the claimer polls every 2 seconds. `claim` runs `BEGIN IMMEDIATE`, selects the oldest unclaimed undelivered row per target, and atomically sets `claimed_by` and `claimed_at`. Lost races return empty (fail-closed).
3. **Ack**: `ack` sets `delivered_at` on the row matching both `id` and `claimed_by`. Foreign owners affect zero rows.
4. **Release**: `release` clears `claimed_by` and `claimed_at`, increments `attempts`, and makes the row available for redelivery. Only the owning claimer can release.
5. **Crash recovery**: `requeueStale` releases claims older than 30 seconds where `attempts` is below the cap.
6. **Dead letter**: rows that reach 25 attempts and age past the 10-minute TTL are counted as dead-lettered by `collectOutbox`.
7. **GC**: `collectOutbox` deletes delivered rows past TTL plus dead-letter rows. VACUUM runs only when the freelist exceeds 16 pages.

### Receipt states

`receiptById` maps row state to one of four labels without mutating the row.
The terminal check runs first: any row carrying `fail_reason` reads
`failed-permanent` even if it was previously claimed or delivered, so
terminal rows never masquerade as in-flight ones.

| State                  | Condition                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`               | row exists, no `fail_reason`, not claimed, not delivered                                                                                                              |
| `injected-progressing` | no `fail_reason`; claimed or delivered (204 seen, reader unconfirmed)                                                                                                 |
| `dead-lettered`        | no `fail_reason`; attempts past max and created past TTL                                                                                                              |
| `failed-permanent`     | `fail_reason` set (terminal: `clientless-no-route`, `receiver-unresolvable`, `max-attempts`, `direct-terminal-<status>`), or no such row, or the store is unavailable |

Full receipt schema at [Delivery Receipts](transport.md#delivery-receipts).

## Schema Evolution

### Registry versioning

The registry document carries a `version` field. The current and only version is `1`. The version check is a strict integer equality (`raw.version === 1`), not a range. A future version bump would change the write path in `writeUnderLock` and the read path in `readRegistry`.

### Registry migration

The `migratedAt` timestamp is set once, on the first write to a fresh registry. It is never overwritten by heartbeats. Legacy migration runs when the registry reads as an empty version-1 document: non-stage entries from the legacy `registry.json` path are imported if they pass the stale check and confirm presence through the live status probe.

### Outbox migration

The `silent` column was added after the initial schema. On every database open, `openOutbox` checks `PRAGMA table_info(outbox)` for the column. If absent, it runs `ALTER TABLE outbox ADD COLUMN silent INTEGER NOT NULL DEFAULT 0`. Existing rows read back as `0` (wake default). The check is idempotent: duplicate-column errors from concurrent first-opens are caught and ignored.

`fail_reason` arrived through the same path (nullable text, pre-migration
rows read back NULL, the routable default). `sender_build`, `miss_layer`,
`miss_reason`, and `build` arrived beside it under one `PRAGMA` read plus a
per-column duplicate-column catch: zero row rewrites, pre-migration rows
read back NULL (absent). The claim pick, the claim-take guard, and the
pending count all exclude `fail_reason`-set rows, so terminal rows are never
re-claimed by fixed claimers.

Rollback caveat: a pre-fix claimer whose claim pick lacks the `fail_reason`
guard re-claims terminal rows and attempts redelivery against a post-fix
database. Rolling the code back requires draining or deleting terminal rows
first; the fixed claim pick is the only version that honors them.

### General rules

- Additive changes (new nullable columns, new indexes) are self-healing: the open path applies them on first access.
- Breaking changes (renames, type changes, column drops) require a version bump in the document header and a migration path in the read code.
- The outbox has no document-level version field. Schema evolution is column-level and additive only.
