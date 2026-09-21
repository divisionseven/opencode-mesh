# Transport

> How messaging works under the hood. Two delivery paths, one durable queue, zero daemons.

## Mesh Delivery

Every `mesh_send` resolves a target, then picks one of two paths: direct or claim. The choice is made by a single loopback probe against the `OPENCODE_PORT` (default `4096`). Direct requires a loopback-reachable serve host on that port; sessions without one deliver through the claim path with identical content and correlation. No registry address is ever dialed; the loopback pin is the only wire.

### Direct path

The sender probes `http://127.0.0.1:{OPENCODE_PORT}/session/status` with a 1-second timeout. If the server answers `200 OK`, the message POSTs straight to `/session/{id}/prompt_async` and the Runner starts immediately. The server returns `204 No Content` on success. Receipt: `via: "admitted"`.

The body carries a branded `messageID` (the `msg_` envelope id) plus the sender header prepended to the text:

```
[OC-MESH | SENDER: {agent} - {sessionId}]

{message text}
```

Both the text and the prefixed body are checked against the 1 MB guard at send time. The prefix length is measured at runtime via frontmatter prefix calculation, never estimated.

The direct path never touches storage. The outbox module stays lazy-loaded until the claim path is needed.

### Claim path

When the loopback probe fails (timeout, refused, non-OK) the message enqueues into the SQLite outbox. The receipt comes back with `via: "queued"` and a `msg_` id for tracking.

The target process's per-process claimer picks up the row on its next poll cycle. It claims the oldest unclaimed row for each owned session using a `BEGIN IMMEDIATE` transaction, then injects the message through `promptAsync` -- byte-identical to user-typed input. On success the row is acked; on failure it is released for redelivery.

### Busy session handling

Before injecting a claimed row, the claimer checks the target's status. If the session reports `busy` or `retry`, the claimer waits in a 550--650ms band (550ms base + random jitter up to 100ms) before retrying. This avoids hammering a Runner that is mid-turn.

The busy check happens inside the claimer poll, not on the direct path. Direct admits never wait on peer state.

### Silent delivery

Both paths respect the wake setting. By default the receiving agent starts a Runner turn. Set `silent: true` on the send call or `MESH_WAKE=0` in the environment to deposit a history-only marker without waking the agent. The `silent` bit travels with the outbox row so the claim leg matches the direct leg.

## Outbox

The outbox is a SQLite database in WAL mode with `synchronous = FULL`. One row per delivery. Concurrency is managed by SQLite transactions, not file locks.

| Setting      | Value  | Source                       |
| ------------ | ------ | ---------------------------- |
| Journal mode | WAL    | `src/outbox.ts` `openOutbox` |
| Busy timeout | 5000ms | `src/outbox.ts` `openOutbox` |
| Synchronous  | FULL   | `src/outbox.ts` `openOutbox` |

### FIFO per target

Rows are ordered by `seq` (autoincrement PK). The claimer selects the oldest unclaimed undelivered row per target session using `ORDER BY seq ASC LIMIT 1`. The index `idx_outbox_target_seq` on `(target_session, seq)` makes this fast.

### Depth cap

Each target session holds at most 100 undelivered rows. Overflow rejects the newest row with `STORAGE_FULL` (507), never a silent drop. The bound comment cites a 20 peer fan out, code enforces no N cap at send time.

### TTL and dead letter

Rows live for 10 minutes. After 25 failed attempts the row is dead-lettered by the garbage collector. Dead-letter rows carry an audit trail: the attempt count and creation timestamp stay on the row until GC deletes it.

The GC runs `collectOutbox`, which deletes delivered rows past TTL plus dead-letter rows. VACUUM runs only when the freelist exceeds 16 pages.

### Idempotency

Enqueue accepts an optional envelope id. If a row with that id already exists, the enqueue is a no-op returning the existing id. This prevents duplicate delivery on retry.

## Recovery and Retry

### Auto-recovery

The claimer polls every 2 seconds. Each poll cycle:

1. Call `requeueStale` to release claims older than 30 seconds where `attempts` is below the cap.
2. Claim one row per owned session.
3. Inject each claimed row via `promptAsync`.
4. Ack on success, release on failure.

The timer is unref'd so it never holds the event loop open.

### Manual recovery

`requeueStale` is also callable directly. It releases claims that are older than the timeout and below the attempt cap, incrementing `attempts` on each release. This is the crash recovery path: if a process dies mid-inject, its claims expire after 30 seconds and become available for redelivery.

The `releaseOwner` function releases every unacked claim held by one process. This runs on dispose so a clean shutdown does not leave orphaned claims.

### Failure modes

| Failure                                            | Behavior                                                                               | Recovery                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------ |
| Loopback probe timeout                             | Claim path queues the row                                                              | Claimer picks it up within 2s        |
| Loopback probe fails (timeout, refused, non-OK)    | Claim path queues the row (`via: "queued"`, exit `0`)                                  | Claimer picks it up within 2s        |
| POST returns 429, 5xx, or network failure on direct | Claim fallback queues the row (`via: "queued"`, exit `0`)                             | Claimer picks it up within 2s        |
| POST returns other non-204 (not 404/401/413) | Direct path throws `SERVER_UNAVAILABLE` with the raw status (`exit 1`, nothing queued) | Caller retries; no outbox row exists |
| Inject fails (any error)                           | Row released for redelivery                                                            | Auto-retry up to 25 attempts         |
| Claim timeout (process crash)                      | `requeueStale` releases after 30s                                                      | Next poll cycle claims it            |
| Depth cap hit                                      | New row rejected with `STORAGE_FULL`                                                   | Wait for claimer to drain, retry     |
| Outbox full disk                                   | `STORAGE_FULL` error thrown                                                            | Free disk space                      |
| Outbox corrupt                                     | `STORAGE_CORRUPT` error thrown                                                         | Delete outbox, let it recreate       |

## Delivery Receipts

Every `mesh_send` returns a receipt. Queue states are queryable via `mesh_peers({ receipt: id })`. The CLI exposes no receipt flag; receipt lookup is tool-only.

### Receipt schema

Send receipts:

```ts
{ ok: true, via: "admitted" | "queued", target: string, title: string, id: `msg_…` }
```

| Field    | Meaning                                                                |
| -------- | ---------------------------------------------------------------------- |
| `ok`     | `true` when the server took the message; throws `MeshError` on failure |
| `via`    | `"admitted"` = live 204; `"queued"` = one outbox row, track by `id`    |
| `target` | Resolved session id (never the raw input text)                         |
| `title`  | Receiver title snapshot for human logs                                 |
| `id`     | `msg_`-prefixed envelope id; the receipt key for queued tracking       |

### Queue states

Four states, read-only (never mutates the row). The terminal check runs
first: any row carrying `fail_reason` reads `failed-permanent` even if it
was previously claimed or delivered.

| State                  | Meaning                                        | Condition                                                                                                                                                |
| ---------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`               | Row exists, inject pending                     | No `fail_reason`; not claimed, not delivered                                                                                                             |
| `injected-progressing` | 204 seen, reader unconfirmed                   | No `fail_reason`; claimed or delivered                                                                                                                   |
| `dead-lettered`        | Max attempts exceeded and past TTL             | No `fail_reason`; `attempts >= 25` and `created_at < now - 10m`                                                                                          |
| `failed-permanent`     | Terminal, or no such row, or store unavailable | `fail_reason` set (`clientless-no-route`, `receiver-unresolvable`, `max-attempts`, `direct-terminal-<status>`), or row missing, or `STORAGE_UNAVAILABLE` |

A `204` on the direct path is never proof the reader saw it. Confirm through the receiver's conversation.

### Per-path behavior

| Path                     | Receipt at send time                                     | Receipt after claim                |
| ------------------------ | -------------------------------------------------------- | ---------------------------------- |
| Direct (204)             | `via: "admitted"`, `id` from wire                        | `injected-progressing`             |
| Claim (queued)           | `via: "queued"`, `id` from enqueue                       | `queued` -> `injected-progressing` |
| Claim (dead-lettered)    | N/A                                                      | `dead-lettered`                    |
| Claim (failed-permanent) | N/A (no row, or terminal `fail_reason` set at the bound) | `failed-permanent`                 |

### Example

```ts
// Send a message
const r = await mesh_send({ target: "ses_abc123", text: "Status?" });
// r: { ok: true, via: "queued", id: "msg_7kQx9mNp3rTz...", ... }

// Check the receipt later
const receipt = await mesh_peers({ receipt: "msg_7kQx9mNp3rTz..." });
// receipt: { id: "msg_7kQx9mNp3rTz...", state: "queued", attempts: 0 }
```

## Performance

Every number below names its source. No bound is a promise; re-measure on your host.

### Transport overhead

| Component      | Cost                | Source                                  |
| -------------- | ------------------- | --------------------------------------- |
| Route probe    | 1s timeout budget   | Compile-time constant; not user-tunable |
| Direct POST    | 5s timeout budget   | Compile-time constant; not user-tunable |
| Claimer poll   | 2s cadence          | Compile-time constant; not user-tunable |
| Claim recovery | 30s stale threshold | Compile-time constant; not user-tunable |
| Busy wait      | 550--650ms band     | Compile-time constant; not user-tunable |

### Benchmarks (measured 2026-09-07)

| Path                          | Observed                                                                                      | Reproduce                          |
| ----------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------- |
| 20 concurrent registry writes | wall 104--108ms, p50 ~92ms                                                                    | `node bench/fsAtomic-bench.mjs 20` |
| Status probe (server down)    | latencyMs: 20--26                                                                             | `npx opencode-mesh status --json`  |
| One queued send, cold process | wall ~3--4s (`via: queued`)                                                                   | `mesh_send` to scratch peer        |
| Broadcast N=5, warm process   | wall 146--201ms (`via: queued`, queued legs only, admitted legs vary with server POST budget) | `mesh_send` broadcast              |

Cold sends pay module load plus the 1s route probe before anything delivers. Steady-state claim legs cost tens of milliseconds each.

### Tuning

The transport is not knob-heavy by design. The knobs that exist:

| Knob              | Default      | Effect                             |
| ----------------- | ------------ | ---------------------------------- |
| `OPENCODE_PORT`   | 4096         | Loopback port for probe and POST   |
| `MESH_BROADCAST`  | unset (off)  | Exact `"1"` enables fan-out        |
| `MESH_WAKE`       | unset (wake) | `"0"` deposits silent history-only |
| `MESH_ENUM_PORTS` | unset        | Extra ports for sibling servers    |

Row lifetime (10m TTL, 25 attempts, 100 depth cap) and poll cadence (2s) are compile-time constants. They are not user-tunable because changing them changes delivery semantics.

[Back to README →](../README.md)
