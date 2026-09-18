# CONTEXT: OpenCode-Mesh Glossary

Domain language for OpenCode-Mesh. Canonical definitions only. See ARCHITECTURE.md for mechanics.

| Term               | Definition                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| registry           | Address book with freshness overlay, see [Registry Schema](docs/schema.md#registry-schema)                     |
| prompt_async       | Direct delivery leg, see [Mesh Delivery](docs/transport.md#mesh-delivery)                                      |
| heartbeat          | Presence tick with fail-closed deletes, see [How Storage Persists](docs/architecture.md#how-storage-persists)  |
| peers              | Never-hides union display with freshness badge                                                                 |
| storage            | Keeps peers with fail-closed deletes, see [How Storage Persists](docs/architecture.md#how-storage-persists)    |
| dispose            | Removes own ids on shutdown, see [Bootstrap](docs/architecture.md#bootstrap)                                   |
| withRegistryLock   | Single writer for registry, see [Registry Schema](docs/schema.md#registry-schema)                              |
| fsync              | Durable writes, see [Lifecycle](docs/schema.md#lifecycle)                                                      |
| outbox             | Durable queue with per-target order, see [Outbox Schema](docs/schema.md#outbox-schema)                         |
| claimer            | Per-session worker injecting own rows, see [Recovery](docs/transport.md#recovery-and-retry)                    |
| route              | Loopback choice between direct and claim, see [Mesh Delivery](docs/transport.md#mesh-delivery)                 |
| discovery join     | Existence plus freshness plus live confirmation, never hides, empty view is unknown                            |
| wake               | Wake-default delivery, silent deposit per message via silent or legacy noReply, global opt-out via MESH_WAKE=0 |
| quarantine         | Verbatim passthrough by default, opt-in tagging of non-leading lookalikes via MESH_QUARANTINE=1                |
| attached           | Live session owned by running process with focus unknown                                                       |
| last action        | Freshest tool use, session event, or message activity; busy counts as active                                   |
| session type       | Primary top-level versus child subagent with per-type TTLs                                                     |
| per-agent override | Custom idle windows for member ids                                                                             |
| precedence         | Attached-exempt, busy-exempt, override, type-default, dampening-hold, in that order                            |
| dampening          | Forward clock leap suspends time deletes for one cycle                                                         |
| ranked peers       | Full union ordered attach-first then directory, agent, recency, title; misses rank last                        |
