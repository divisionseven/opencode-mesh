// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// V1 tool shell: thin host-SDK wrapper over the host-free executor core.
// All behavior lives in ./mesh_send.core.js; this file owns only the V1 shape.
import { tool } from "@opencode-ai/plugin";
import {
  MESH_SEND_DESCRIPTION,
  executeMeshSend,
  fetchDirectRow,
  type DirectRowOutcome,
  type MeshSendArgs,
  type MeshToolContext,
} from "./mesh_send.core.js";

export { fetchDirectRow, MESH_SEND_DESCRIPTION };
export type { DirectRowOutcome, MeshSendArgs, MeshToolContext };

export const mesh_send = tool({
  description: MESH_SEND_DESCRIPTION,
  args: {
    target: tool.schema.string().describe("Target sessionId or registry name"),
    text: tool.schema.string().describe("Message text to deliver"),
    noReply: tool.schema.boolean().optional().describe("Legacy compat; maps to silent deposit, reply by reverse send"),
    silent: tool.schema.boolean().optional().describe("Canonical per-message silent flag; true deposits history-only, omit follows MESH_WAKE"),
    broadcast: tool.schema.boolean().optional().describe("If true, N sequential POSTs (opt-in MESH_BROADCAST=1, default-off)"),
  },
  async execute(args, ctx) {
    return executeMeshSend(
      args as unknown as MeshSendArgs,
      ctx as unknown as MeshToolContext
    );
  },
});
