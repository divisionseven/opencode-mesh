// Copyright (c) 2026 DIVISION 7 | MI-7 (@divisionseven)
// SPDX-License-Identifier: MIT
// V1 tool shell: thin host-SDK wrapper over the host-free executor core.
// All behavior lives in ./mesh_register.core.js; this file owns only the V1 shape.
import { tool } from "@opencode-ai/plugin";
import {
  MESH_REGISTER_DESCRIPTION,
  executeMeshRegister,
  type MeshRegisterArgs,
  type MeshRegisterContext,
} from "./mesh_register.core.js";

export { MESH_REGISTER_DESCRIPTION };
export type { MeshRegisterArgs, MeshRegisterContext };

/** mesh_register — upserts caller into registry and returns peers. */
export const mesh_register = tool({
  description: MESH_REGISTER_DESCRIPTION,
  args: {
    summary: tool.schema.string().optional().describe("One-line summary of this session's purpose"),
    description: tool.schema.string().optional().describe("Canonical description (alias for summary)"),
  },
  async execute(args, ctx) {
    return executeMeshRegister(
      args as unknown as MeshRegisterArgs,
      ctx as unknown as MeshRegisterContext
    );
  },
});
