# Examples — opencode-mesh

| File            | Purpose                          | Run                                                                | Verifies                                                                               |
| --------------- | -------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `quickstart.ts` | Runnable tutorial `<30s`         | `OPENCODE_MESH_ROOT=/tmp/mesh-test npx tsx examples/quickstart.ts` | `{ peers: {...} }` object plus `{ok:true, via:"admitted"/"queued", target, title, id}` |
| `status-jq.sh`  | One field out of `status --json` | `zsh examples/status-jq.sh port`                                   | `port` object prints, exit 0                                                           |
| `enum-ports.sh` | Peers across sibling servers     | `MESH_ENUM_PORTS=4097,4098 zsh examples/enum-ports.sh`             | peer union JSON prints, exit 0                                                         |

`quickstart.ts` is the Diátaxis Tutorial code proof for `docs/getting-started.md`.

- Preamble `rm -rf /tmp/mesh-test` is **dev-only** isolated via `OPENCODE_MESH_ROOT=/tmp/mesh-test` — not in `package.json` `files`
- Uses `tsx ^4` `devDependencies` (`package.json` `devDependencies` `tsx`) for `npx tsx` cold (run `npm ci` first)
- `mesh_register({summary:"reviewer"})→mesh_peers→mesh_send` prints the peers object (wake-default; `silent:true` deposits history-only) — tools in `src/tools/`, wire header `formatMeshPrefix` in `src/frontmatter.ts`, result shape `{ok, via, target, title, id}` built in `src/tools/mesh_send.ts`

Dev-only note: never `rm -rf` without `OPENCODE_MESH_ROOT=/tmp/mesh-test` override.

## Bench

Bench scripts live in `bench/`; run them locally. Their numbers are advisory-only,
never cited in docs.

Next: `docs/getting-started.md` 5 steps (covers installation), `ARCHITECTURE.md`.
`examples/` never ships in the tarball (`package.json` `files`).
