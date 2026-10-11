// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// V1 tool shell: thin host-SDK wrapper over the host-free executor core.
// All behavior lives in ./mesh_peers.core.js; this file owns only the V1 shape.
import { tool } from "@opencode-ai/plugin";
import {
  MESH_PEERS_DESCRIPTION,
  executeMeshPeers,
  scoreAgent,
  scoreDirectory,
  scoreTitle,
  type MeshPeersArgs,
  type MeshPeersContext,
} from "./mesh_peers.core.js";

export { MESH_PEERS_DESCRIPTION, scoreAgent, scoreDirectory, scoreTitle };
export type { MeshPeersArgs, MeshPeersContext };

export const mesh_peers = tool({
  description: MESH_PEERS_DESCRIPTION,
  args: {
    includeSelf: tool.schema.boolean().optional().describe("Include caller in results"),
    agent: tool.schema.string().optional().describe("Filter by agent substring case-insensitive"),
    description: tool.schema.string().optional().describe("Filter by description substring case-insensitive"),
    cwd: tool.schema.string().optional().describe("Filter by cwd/repo substring case-insensitive"),
    repo: tool.schema.string().optional().describe("Filter by repo substring case-insensitive"),
    receipt: tool.schema.string().optional().describe("Outbox receipt id (msg_…) — returns delivery state instead of peers"),
  },
  async execute(args, ctx) {
    return executeMeshPeers(
      args as unknown as MeshPeersArgs,
      ctx as unknown as MeshPeersContext
    );
  },
});
