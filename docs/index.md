# OpenCode-Mesh Documentation

## Getting Started & Guides

Step-by-step start and task fixes for sending between sessions on your machine.

| Guide                                       | Description                                |
| ------------------------------------------- | ------------------------------------------ |
| [Getting Started](getting-started.md)       | Zero to first message between two sessions |
| [Troubleshooting Fixes](troubleshooting.md) | Typed `MeshError` codes with fixes         |

## References

Technical lookup for commands, variables, stored shapes, and delivery paths with exact defaults.

| Reference                          | Description                                                |
| ---------------------------------- | ---------------------------------------------------------- |
| [Architecture](architecture.md)    | Technical internals for contributors                       |
| [CLI Reference](cli.md)            | All verbs, flags, and exit codes sourced from `bin/cli.js` |
| [Configuration](configuration.md)  | Environment variables only with no config files            |
| [Schema Reference](schema.md)      | Stored shapes for `registry.json` and `outbox.db`          |
| [Transport Concepts](transport.md) | Loopback probe with direct or claim delivery choice        |

## Examples

Ready-to-use scripts that demonstrate discovery, sending, and multi-instance enumeration on loopback today.

| Example                                                            | Description                                |
| ------------------------------------------------------------------ | ------------------------------------------ |
| [First Message](getting-started.md#section-4-sending-and-replying) | Send plus reply between two sessions       |
| [Status Check](cli.md#status)                                      | Health plus `status --json` fields         |
| [Sibling Servers](getting-started.md#section-7-multi-instance)     | Peers across servers via `MESH_ENUM_PORTS` |
| [Delivery Paths](transport.md#mesh-delivery)                       | Direct or claim choice on loopback         |

## Project Documentation

Project governance, policies, and history for contributors and operators in one place.

| Document                                       | Description                              |
| ---------------------------------------------- | ---------------------------------------- |
| [Project Overview](../README.md)               | Project overview plus highlights         |
| [Architecture Orientation](../ARCHITECTURE.md) | Newcomer map into `docs/architecture.md` |
| [Glossary](../CONTEXT.md)                      | Domain terms for mesh concepts           |
| [Security Policy](../SECURITY.md)              | Private-advisory reporting path          |
| [Contributing Guide](../CONTRIBUTING.md)       | Contributor process                      |
| [Code of Conduct](../CODE_OF_CONDUCT.md)       | Community standards                      |
| [Disclaimer](../DISCLAIMER.md)                 | Project scope limits                     |
| [Authors](../AUTHORS.md)                       | Contributor credits                      |
| [Changelog](../CHANGELOG.md)                   | Shipped history                          |
| [Governance](../GOVERNANCE.md)                 | Triage and ownership                     |

## Agent Skill

Included agent skill file, installed automatically, to help your agents use the mesh system effectively.

| Document                                  | Description                                        |
| ----------------------------------------- | -------------------------------------------------- |
| [SKILL](../skills/opencode-mesh/SKILL.md) | Helpful agent instructions, guides, and references |

---

[← Back to README](../README.md)
