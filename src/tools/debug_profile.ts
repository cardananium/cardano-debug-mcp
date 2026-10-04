// debug_profile: run the session's script to completion on the engine's second machine (the
// session position is untouched) and report where cpu / mem go: hot terms and lines, builtins,
// step kinds, traces with their emitting term, the failing term on error.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AppContext, ToolModule } from "../context.js";
import type { ProfileOptions } from "../engine/protocol.js";
import { leaseSessionWait, MAX_MAX_STEPS, MAX_RUN_TIMEOUT_MS, sessionErrorResult, sessionLinks } from "./_debug.js";
import { clampInt, ok, type ToolResult } from "./_shared.js";
import { TOOL_TEXT } from "./descriptions.js";

const T = TOOL_TEXT.debug_profile;

const DEFAULT_TOP = 15;
const MAX_TOP = 50;
const DEFAULT_MAX_STEPS = 5_000_000;
const DEFAULT_TRACES = 50;
const MAX_TRACES = 200;
/** Steps per `profile_run` chunk (deadline / stop-flag checks between chunks). */
const CHUNK_STEPS = 200_000;

const inputSchema = z.object({
  dbg_id: z.string().describe(T.params["dbg_id"]),
  top: z.number().int().min(1).max(MAX_TOP).optional().describe(T.params["top"]),
  by: z.enum(["self_cpu", "total_cpu", "self_mem", "hits"]).optional().describe(T.params["by"]),
  max_steps: z.number().int().min(1).max(MAX_MAX_STEPS).optional().describe(T.params["max_steps"]),
  timeout_ms: z.number().int().min(100).max(MAX_RUN_TIMEOUT_MS).optional().describe(T.params["timeout_ms"]),
  include_traces: z.number().int().min(0).max(MAX_TRACES).optional().describe(T.params["include_traces"]),
});

export type DebugProfileArgs = z.infer<typeof inputSchema>;
type Args = DebugProfileArgs;

export async function debugProfile(ctx: AppContext, args: Args, signal: AbortSignal | undefined): Promise<ToolResult> {
  const lease = await leaseSessionWait(ctx, args.dbg_id, { tool: "debug_profile", long: true });
  if (!lease.ok) return lease.result;
  const { record, release } = lease;
  try {
    const timeoutMs = clampInt(args.timeout_ms, ctx.config.runTimeoutMs, 100, MAX_RUN_TIMEOUT_MS);
    const options: ProfileOptions = {
      top: clampInt(args.top, DEFAULT_TOP, 1, MAX_TOP),
      by: args.by ?? "self_cpu",
      max_steps: clampInt(args.max_steps, DEFAULT_MAX_STEPS, 1, MAX_MAX_STEPS),
      deadline_at: Date.now() + timeoutMs,
      include_traces: clampInt(args.include_traces, DEFAULT_TRACES, 0, MAX_TRACES),
      chunk_steps: CHUNK_STEPS,
    };
    const report = await record.client!.profile(options, timeoutMs + 5_000, signal);
    record.extra.profileAvailable = true;
    const body: Record<string, unknown> = {
      dbg_id: record.dbgId,
      outcome: report.outcome,
      totals: report.totals,
      hot_terms: report.hot_terms,
      hot_lines: report.hot_lines,
      builtins: report.builtins,
      step_kinds: report.step_kinds,
      timeline: report.timeline,
      traces: report.traces,
      terms_executed: report.terms_executed,
      ranked_by: options.by,
      attribution: "apply_site (a Return step is charged to the apply site it returns into)",
      elapsed_ms: report.elapsed_ms,
      full_report_chars: report.report_chars,
      note: "The profile ran on a separate machine: the session's own position, traces and step counters are unchanged.",
    };
    if (report.error) body.error = report.error;
    if (record.calculatedExUnits && (report.outcome === "done" || report.outcome === "error")) {
      const match = record.calculatedExUnits.steps === report.totals.cpu && record.calculatedExUnits.mem === report.totals.mem;
      body.parity = { validator_calculated: record.calculatedExUnits, profiler_spent: { cpu: report.totals.cpu, mem: report.totals.mem }, match };
    }
    if (report.outcome === "limit") body.hint = `the run stopped at max_steps (${options.max_steps.toLocaleString("en-US")}); totals are partial — raise max_steps`;
    if (report.outcome === "timeout") body.hint = `the run stopped at the ${timeoutMs} ms budget; totals are partial — raise timeout_ms or max_steps`;
    // profile.json is announced once per session; a later profile overwrites the same resource.
    const first = record.extra.profileLinkSent !== true;
    record.extra.profileLinkSent = true;
    return ok(body, first ? { links: sessionLinks(record.dbgId, "profile") } : {});
  } catch (error) {
    return sessionErrorResult(ctx, record, error);
  } finally {
    release();
  }
}

export const debugProfileTool: ToolModule = {
  name: "debug_profile",
  register(server: McpServer, ctx: AppContext) {
    server.registerTool(
      "debug_profile",
      {
        title: T.title,
        description: T.description,
        inputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args, extra) => debugProfile(ctx, args, extra.mcpReq.signal),
    );
  },
};
