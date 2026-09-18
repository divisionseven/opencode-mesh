# Governance: OpenCode-Mesh

Sole-maintainer project. Division 7 (`@divisionseven`) holds final release authority and
merges every change; there is no committee and no vote.

## Decision venue

Proposals, bugs, and reviews live in GitHub Issues and pull requests. Security reports
use the private advisory route in `SECURITY.md`, never a public issue.

Small fixes (typos, broken links, gate restamps) merge on one maintainer
review. Behavior changes need the full gate set in `CONTRIBUTING.md` plus
a second passing harness run.

## Maintainers

- Cut releases and own the `1.0.x` line.
- Keep `ARCHITECTURE.md` truthful.
- Enforce the gate stamping rule in `CONTRIBUTING.md`.
- Triage CodeQL and dependency-review findings info-only first, blocking only with recorded sign-off.
- Honor the `SECURITY.md` 48h acknowledgement and 7d triage SLAs.

## Contributors

- Follow `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md`.
- Docs claims stay behavior-derived; gates restamped, never fudged.
- One concern per pull request, with verification output pasted.

## Closed-maintainer criteria

Published for transparency although the seat is currently closed: sustained
high-quality contributions across several releases, gate discipline without
reminders, and operator trust earned in issues and reviews. No application
process runs while the seat is closed.

## Appeal

Decisions may be appealed once with new evidence: open an issue referencing
the original decision, state what changed, and the maintainer re-reviews
within 7 days. The re-review outcome is final.
