// debug_inspect: look at the machine without moving it — position, frames, environment, one value
// by ref, the current term's UPLC, the ScriptContext by path, traces, budget. Everything is read
// through the engine's lazy APIs; the full machine state is never serialised.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AppContext, ToolModule } from "../context.js";
import type { InspectOptions, InspectWhat, PositionReport } from "../engine/protocol.js";
import { breakpointsOf, DEFAULT_CONTEXT_LINES, leaseSession, MAX_CONTEXT_LINES, parityOf, sessionErrorResult, shapePosition } from "./_debug.js";
import { clampInt, DEFAULT_ROWS, MAX_ROWS, ok, type ToolResult } from "./_shared.js";
import { TOOL_TEXT } from "./descriptions.js";

const T = TOOL_TEXT.debug_inspect;

const WHAT = ["position", "frames", "env", "value", "term", "context", "traces", "budget"] as const;
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 5;
const MAX_CHARS = 8_000;

const inputSchema = z.object({
  dbg_id: z.string().describe(T.params["dbg_id"]),
  what: z.enum(WHAT).describe(T.params["what"]),
  path: z.string().optional().describe(T.params["path"]),
  term_id: z.number().int().min(0).optional().describe(T.params["term_id"]),
  depth: z.number().int().min(1).max(MAX_DEPTH).optional().describe(T.params["depth"]),
  offset: z.number().int().min(0).optional().describe(T.params["offset"]),
  limit: z.number().int().min(1).max(MAX_ROWS).optional().describe(T.params["limit"]),
  context_lines: z.number().int().min(0).max(MAX_CONTEXT_LINES).optional().describe(T.params["context_lines"]),
});

export type DebugInspectArgs = z.infer<typeof inputSchema>;
type Args = DebugInspectArgs;

export async function debugInspect(ctx: AppContext, args: Args): Promise<ToolResult> {
  const lease = leaseSession(ctx, args.dbg_id, { tool: "debug_inspect" });
  if (!lease.ok) return lease.result;
  const { record, release } = lease;
  try {
    const client = record.client!;
    const options: InspectOptions = {
      path: args.path,
      ...(args.term_id !== undefined ? { term_id: args.term_id } : {}),
      depth: clampInt(args.depth, DEFAULT_DEPTH, 1, MAX_DEPTH),
      offset: clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      limit: clampInt(args.limit, DEFAULT_ROWS, 1, MAX_ROWS),
      context_lines: clampInt(args.context_lines, DEFAULT_CONTEXT_LINES, 0, MAX_CONTEXT_LINES),
      max_chars: MAX_CHARS,
    };
    const what = args.what as InspectWhat;
    let body: Record<string, unknown>;
    if (what === "position") {
      const breakpoints = breakpointsOf(record);
      const report = (await client.position(options.context_lines, 6, breakpoints.uplc_lines, breakpoints.term_ids)) as PositionReport;
      record.lastPosition = report.position;
      record.lastStatus = report.status;
      body = {
        dbg_id: record.dbgId,
        what,
        status: report.status,
        position: shapePosition(report.position),
        uplc_window: report.uplc_window.text,
        ...(report.uplc_window.dedent > 0 ? { uplc_window_dedent: report.uplc_window.dedent } : {}),
        frames: report.frames.map((f) => ({ depth: f.index, kind: f.kind, term_id: f.term_id ?? null, uplc_line: f.uplc_line ?? null, ...(f.env_size !== undefined ? { env_size: f.env_size } : {}), ...(f.detail ? { detail: f.detail } : {}) })),
        frames_total: report.frames_total,
        ...(report.frames_note ? { frames_note: report.frames_note } : {}),
        budget: report.budget,
        steps_total: report.steps_total,
        version: report.version,
      };
      if (report.error_message !== undefined) body.error_message = report.error_message;
      const parity = parityOf(record, report.budget, report.status);
      if (parity) body.parity = parity;
    } else {
      const result = await client.inspect(what, options);
      body = { dbg_id: record.dbgId, what, ...result, version: record.version };
      if (what === "env" && Array.isArray(result.items)) {
        body.legend = "index = position in the CEK environment (0 = outermost binding); debruijn = index a Var uses to reach it (1 = innermost); ref = path for what='value'";
      }
      if (what === "frames") body.legend = "index (= depth in debug_run's frames) 0 = innermost continuation (what receives the next value); term_id / uplc_line = the term the frame will resume";
    }
    return ok(body);
  } catch (error) {
    return sessionErrorResult(ctx, record, error);
  } finally {
    release();
  }
}

export const debugInspectTool: ToolModule = {
  name: "debug_inspect",
  register(server: McpServer, ctx: AppContext) {
    server.registerTool(
      "debug_inspect",
      {
        title: T.title,
        description: T.description,
        inputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args) => debugInspect(ctx, args),
    );
  },
};
