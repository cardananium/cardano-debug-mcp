// debug_close: close one session (or every session) and free its worker's memory.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AppContext, ToolModule } from "../context.js";
import { ok, type ToolResult } from "./_shared.js";
import { TOOL_TEXT } from "./descriptions.js";

const T = TOOL_TEXT.debug_close;

const inputSchema = z.object({
  dbg_id: z.string().describe(T.params["dbg_id"]),
});

type Args = z.infer<typeof inputSchema>;

function debugClose(ctx: AppContext, args: Args): ToolResult {
  const closed: string[] = [];
  const unknown: string[] = [];
  if (args.dbg_id.trim().toLowerCase() === "all") {
    for (const record of ctx.sessions.list()) {
      if (ctx.sessions.close(record.dbgId, "closed")) closed.push(record.dbgId);
    }
  } else if (ctx.sessions.close(args.dbg_id, "closed")) {
    closed.push(args.dbg_id);
  } else {
    unknown.push(args.dbg_id);
  }
  const body: Record<string, unknown> = { closed, remaining: ctx.sessions.size };
  if (unknown.length > 0) {
    body.unknown = unknown;
    body.note = "an unknown handle is already closed or expired; nothing to do";
  }
  return ok(body);
}

export const debugCloseTool: ToolModule = {
  name: "debug_close",
  register(server: McpServer, ctx: AppContext) {
    server.registerTool(
      "debug_close",
      {
        title: T.title,
        description: T.description,
        inputSchema,
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      async (args) => debugClose(ctx, args),
    );
  },
};
