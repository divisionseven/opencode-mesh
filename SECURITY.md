# Security Policy

> Private advisories only, never a public issue for a sensitive report. [New Advisory](https://github.com/divisionseven/opencode-mesh/security/advisories/new).

## Reporting a Vulnerability

Open a private security advisory at the link above. Reports stay confidential from filing through fix release.

**Report Schema: Include all seven items:**

1. **Affected versions:** tag or commit (`npx opencode-mesh --help` prints the version).
2. **Environment:** OS, Node (`node --version`), opencode (`opencode --version`).
3. **Attack surface:** loopback wire, state root, install path, or dependency.
4. **Reproduction:** minimal commands with `OPENCODE_MESH_ROOT` pointed at a scratch root.
5. **Expected vs actual:** the invariant violated and the observed behavior.
6. **Logs:** redacted `status --json` output plus the receipt id when delivery is involved. Never attach passwords, tokens, or registry dumps.
7. **Impact:** who is affected and what an attacker gains.

## Response SLAs

We acknowledge reports within **48 hours** and ship a fix or mitigation within **7 days** for verified issues. You receive credit in the release notes unless you decline.

## Scope

**In:** mesh state-root permissions (`0700`/`0600`), the loopback-only wire, env-only server auth, quarantine handling of sender headers, dependency vulnerabilities in `package.json` ranges.

**Out:** the opencode server itself, the OS login boundary, physical access, social engineering, anything outside the reporter's authority.

## Hardening Notes

- Keep the default `umask` and do not share the login that owns the mesh state.
- There is no daemon: delivery is direct `POST /session/{id}/prompt_async` on loopback only, with env-only server auth (`none` unset, `env` password → `Basic`, Keychain only opt-in).
- Registry entries prune after `24h`; outbox rows expire after `10m` with dead-letter audit. Deletes append one best-effort `JSONL` line to `audit.log` (`0600`, no rotation, never read by any wire path).
- Review `DISCLAIMER.md` for warranty and scope.

## Attribution

No external security reports received yet; this section names the first reporter when one lands (if desired).
