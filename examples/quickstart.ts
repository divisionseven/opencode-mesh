// Runnable OPENCODE_MESH_ROOT=/tmp/mesh-test register→peers→send <30s gate
// Run: OPENCODE_MESH_ROOT=/tmp/mesh-test node --loader tsx examples/quickstart.ts
import { rm } from 'node:fs/promises';
import { mesh_peers } from '../src/tools/mesh_peers.js';
import { mesh_register } from '../src/tools/mesh_register.js';
import { mesh_send } from '../src/tools/mesh_send.js';

async function main(): Promise<void> {
  const meshRoot = process.env.OPENCODE_MESH_ROOT ?? '/tmp/mesh-test';
  process.env.OPENCODE_MESH_ROOT = meshRoot;
  // preamble: rm -rf /tmp/mesh-test for idempotence (file transport only, no opencode needed)
  // keep root but ensure clean state for quickstart peers
  try {
    await rm(meshRoot, { recursive: true, force: true });
  } catch {}
  const ctx = {
    sessionID: 'ses_quickstart',
    agent: 'quickstart',
    directory: process.cwd(),
  } as unknown as { sessionID: string; agent: string; directory: string };
  console.log(`OPENCODE_MESH_ROOT=${meshRoot} quickstart start`);
  const regOut = await mesh_register.execute(
    { summary: 'reviewer' },
    ctx as never
  );
  console.log('registered:', regOut.output.slice(0, 200));
  const peersOut = await mesh_peers.execute(
    { includeSelf: true },
    ctx as never
  );
  console.log('peers:', peersOut.output);
  // wake-default send (omit silent to start an agent turn; silent:true deposits history-only)
  // wire shape: `[OC-MESH | SENDER: {agent} - {sessionId}]\n\n<body>` (header line, blank line, verbatim body;
  // silent legs add ` (SILENT)`, unattested claim legs ` (QUARANTINED)`, both ` (SILENT) (QUARANTINED)` fixed order)
  // exact-id send (exact-only resolution: full session id, or full agent@repo naming exactly one row)
  const sendOut = await mesh_send.execute(
    { target: 'ses_quickstart', text: 'ping' },
    ctx as never
  );
  console.log('sent:', sendOut.output);
  // also verify didYouMean path is fast (<200ms) by probing unknown peer
  const start = Date.now();
  try {
    await mesh_send.execute({ target: 'reviewerX', text: 'hi' }, ctx as never);
  } catch (e) {
    const elapsed = Date.now() - start;
    console.log(
      `PEER_NOT_FOUND probe elapsed ${elapsed}ms`,
      (e as Error).message.slice(0, 120)
    );
    if (elapsed > 500)
      console.warn('WARN: PEER_NOT_FOUND slow, expected immediately');
  }
  console.log('quickstart done peers 1×');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
