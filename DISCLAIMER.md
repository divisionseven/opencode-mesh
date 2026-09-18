# Disclaimer

## Authorized Use

Use OpenCode-Mesh on machines and sessions you own or administer.
Do not point it at sessions, servers, or state roots outside your
authority, and do not share the login that owns the mesh state.

## Limitation of Liability

Provided as-is under the MIT license without warranty of any kind.
The maintainers make no guarantees about completeness, correctness,
or fitness for a particular purpose. You carry the risk of relying
on delivered, queued, or expired messages.

## No Guaranteed Protection

This tool is a local convenience layer, not a security boundary. It
does not replace code review, access control, or network isolation.
Delivery is loopback-only on a single host: `admitted` never proves the
reader saw the message, and queued rows expire past the outbox TTL with
a dead-letter audit. There is no message archive.

## Signature

Use it as one part of a broader workflow, not as a sole dependency
for critical work. See `SECURITY.md` for reporting and
`ARCHITECTURE.md` for technical details.

— Division 7
