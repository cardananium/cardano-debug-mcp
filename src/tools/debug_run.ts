// debug_run: execute a session until a stop condition (error / done / N steps / term / UPLC line /
// trace / builtin / cpu budget), a persistent breakpoint, the step cap or the wall-clock budget.
// The loop lives in the worker; this side drives it in ~2 s chunks so progress notifications and
// client cancellation are honoured without touching the worker mid-batch.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AppContext, ToolModule } from "../context.js";
import { builtinKey, PLUTUS_BUILTINS } from "../engine/builtins.js";
import type { RunReport, RunSpec, UntilKind } from "../engine/protocol.js";
import type { SessionRecord } from "../store/sessionRegistry.js";
import {
  DEFAULT_CONTEXT_LINES,
  DEFAULT_MAX_STEPS,
  leaseSessionWait,
  MAX_CONTEXT_LINES,
  MAX_MAX_STEPS,
  MAX_RUN_TIMEOUT_MS,
  parityOf,
  RUN_CHUNK_MS,
  sessionErrorResult,
  shapePosition,
} from "./_debug.js";
import { clampInt, fail, ok, type ToolResult } from "./_shared.js";
import { TOOL_TEXT } from "./descriptions.js";

const T = TOOL_TEXT.debug_run;

const UNTIL = ["error", "done", "steps", "term", "uplc_line", "trace", "builtin", "budget"] as const;

const inputSchema = z.object({
  dbg_id: z.string().describe(T.params["dbg_id"]),
  until: z.enum(UNTIL).describe(T.params["until"]),
  steps: z.number().int().min(1).optional().describe(T.params["steps"]),
  term_id: z.number().int().min(0).optional().describe(T.params["term_id"]),
  line: z.number().int().min(1).optional().describe(T.params["line"]),
  contains: z.string().optional().describe(T.params["contains"]),
  builtin: z.string().optional().describe(T.params["builtin"]),
  cpu: z.union([z.string(), z.number()]).optional().describe(T.params["cpu"]),
  hit: z.number().int().min(1).optional().describe(T.params["hit"]),
  stop_before: z.boolean().optional().describe(T.params["stop_before"]),
  restart: z.boolean().optional().describe(T.params["restart"]),
  max_steps: z.number().int().min(1).max(MAX_MAX_STEPS).optional().describe(T.params["max_steps"]),
  timeout_ms: z.number().int().min(100).max(MAX_RUN_TIMEOUT_MS).optional().describe(T.params["timeout_ms"]),
  context_lines: z.number().int().min(0).max(MAX_CONTEXT_LINES).optional().describe(T.params["context_lines"]),
  breakpoints: z
    .object({
      term_ids: z.array(z.number().int().min(0)).optional().describe(T.params["breakpoints.term_ids"]),
      uplc_lines: z.array(z.number().int().min(1)).optional().describe(T.params["breakpoints.uplc_lines"]),
    })
    .optional()
    .describe(T.params["breakpoints"]),
  clear_breakpoints: z.boolean().optional().describe(T.params["clear_breakpoints"]),
});

export type DebugRunArgs = z.infer<typeof inputSchema>;
type Args = DebugRunArgs;

export interface Progress {
  token: string | number | undefined;
  notify: (notification: { method: string; params?: Record<string, unknown> }) => Promise<void>;
}

/**
 * CEK failures that are not a builtin's: applying a non-function, forcing a non-delay, a builtin
 * applied without its force, a case on a non-constr value, a free variable.
 */
const MACHINE_ERROR = /non-function|non-polymorphic|builtin received a term argument|non-constr|scrutini[sz]|case branch|free (unique|variable)|unbound variable|open term/i;

/** The machine error of a builtin applied to a term argument before all its forces (a missing `force`). */
const MISSING_FORCE = /builtin received a term argument/i;

/** The builtin a machine error names (the engine prints `fun: HeadList`), as the UPLC listing spells it. */
export function builtinOfMachineError(message: string): string | undefined {
  const named = /\bfun:\s*([A-Za-z][A-Za-z0-9_]*)/.exec(message)?.[1];
  if (!named) return undefined;
  return PLUTUS_BUILTINS.find((name) => builtinKey(name) === builtinKey(named));
}

/** What kind of failure a message is: an explicit `(error)` term, a machine error (no builtin failed) or a builtin's own. */
export function failureKind(message: string | undefined, termKnown: boolean): "explicit" | "machine_error" | "builtin" {
  if (termKnown) return "explicit";
  return MACHINE_ERROR.test((message ?? "").split("\n")[0]!.trim()) ? "machine_error" : "builtin";
}

/**
 * How to get from a finished-with-error machine (no env, no frames) to a readable state. An explicit
 * `(error)` term is computed once, so until='term' on it lands one transition before the failure in
 * Compute state. A failing builtin or a machine error has no term of its own (position.term_id is
 * null; last_term_id is the last computed term, often visited many times), so the reliable
 * coordinate is the step count: steps_total - 1 is the Return state that hands the offending value
 * on (to the partially applied builtin, or to the application / force that cannot take it).
 * `stop_before` is the same one-transition step back as a single run that also returns the value in
 * hand / the environment. Notes are short on purpose: this block rides on every error run.
 */
export function rewindAdvice(report: Pick<RunReport, "steps_total" | "position" | "error_message">): Record<string, unknown> {
  const before = report.steps_total - 1;
  const termId = report.position.term_id;
  const out: Record<string, unknown> = {};
  out.stop_before = { until: "error", stop_before: true, restart: true };
  if (before >= 1) out.one_step_before = { until: "steps", steps: before, restart: true };
  if (termId !== null) out.failing_term = { until: "term", term_id: termId, restart: true };
  const headline = (report.error_message ?? "").split("\n")[0]!.trim();
  if (termId !== null) {
    out.note = "an explicit (error) term: failing_term lands on it in Compute state with the environment readable (debug_inspect what='env').";
  } else if (before < 1) {
    out.note = "the first transition failed; the initial term has no bindings to inspect.";
  } else if (MISSING_FORCE.test(headline)) {
    // The builtin itself is fine; it was applied before its forces. until='builtin' stops on its node.
    const builtin = builtinOfMachineError(report.error_message ?? "");
    out.failure = "machine_error";
    if (builtin) {
      out.builtin = builtin;
      out.at_builtin = { until: "builtin", builtin, restart: true };
    }
    out.note =
      `a machine error, not a builtin failure (${headline}): ${builtin ?? "a builtin"} was applied to an argument before all its forces (a missing (force …) around the builtin node). ` +
      `one_step_before is the Return state (state.value = the argument, frames.0 = the builtin with the forces it got); ` +
      (builtin ? `at_builtin (until='builtin', builtin='${builtin}', restart=true) stops on the builtin node.` : "until='builtin', builtin=<name>, restart=true stops on the builtin node.");
  } else if (MACHINE_ERROR.test(headline)) {
    out.failure = "machine_error";
    out.note = `a machine error, not a builtin failure (${headline}): one_step_before is the Return state (state.value = the value in hand, frames.0 = what cannot take it: an application of a non-function, a force of a non-delay).`;
  } else {
    out.failure = "builtin";
    out.note =
      `a builtin failed (no term of its own; last_term_id is only the last computed term, and until='term' on it stops at its FIRST visit). ` +
      `one_step_before is the Return state (state.value = the argument in hand, frames.0 = the partial builtin); until='builtin', builtin=<name>, restart=true stops on the builtin node (hit=N for a later visit; the failing one ends at steps_total ${report.steps_total}).`;
  }
  return out;
}

/** A report's env / value rows as the tool shows them (no binder coordinates: debug_inspect has them). */
function shapeAtFailure(at: NonNullable<RunReport["at_failure"]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (at.value) out.value = at.value;
  if (at.env) {
    out.env = {
      total: at.env.total,
      items: at.env.items.map((i) => ({ index: i.index, ...(i.name !== undefined ? { name: i.name } : {}), debruijn: i.debruijn, type: i.type, summary: i.summary, ref: i.ref })),
      ...(at.env.note ? { note: at.env.note } : {}),
    };
  }
  return out;
}

const MAX_NEW_TRACES = 10;

async function runSession(ctx: AppContext, record: SessionRecord, args: Args, signal: AbortSignal | undefined, progress: Progress): Promise<ToolResult> {
  const client = record.client!;
  const started = Date.now();
  const contextLines = clampInt(args.context_lines, DEFAULT_CONTEXT_LINES, 0, MAX_CONTEXT_LINES);
  const maxSteps = clampInt(args.max_steps, DEFAULT_MAX_STEPS, 1, MAX_MAX_STEPS);
  const timeoutMs = clampInt(args.timeout_ms, ctx.config.runTimeoutMs, 100, MAX_RUN_TIMEOUT_MS);
  const deadline = started + timeoutMs;

  if (args.breakpoints) {
    // Same range check as until='term' / until='uplc_line': a breakpoint outside the script would
    // silently never fire.
    const badIds = record.termCount !== undefined ? (args.breakpoints.term_ids ?? []).filter((id) => id >= record.termCount!) : [];
    if (badIds.length > 0) return fail({ code: "invalid_argument", message: `breakpoints.term_ids ${badIds.join(", ")} are not nodes of this script (0..${record.termCount! - 1})`, argument: "breakpoints", dbg_id: record.dbgId });
    const badLines = record.uplcLines !== undefined ? (args.breakpoints.uplc_lines ?? []).filter((line) => line > record.uplcLines!) : [];
    if (badLines.length > 0) return fail({ code: "invalid_argument", message: `breakpoints.uplc_lines ${badLines.join(", ")} are outside the listing (1..${record.uplcLines})`, argument: "breakpoints", dbg_id: record.dbgId });
    // A line where no term starts (a closing bracket) would be armed ('*') but could never fire.
    const termless: Array<{ uplc_line: number; nearest_line: number | null; nearest_term_id: number | null }> = [];
    for (const line of new Set(args.breakpoints.uplc_lines ?? [])) {
      let located;
      try {
        located = await record.client!.locate({ uplc_line: line, context_lines: 0 });
      } catch (error) {
        return sessionErrorResult(ctx, record, error);
      }
      if (located.note !== undefined) {
        const nearest = located.candidates?.[0];
        const nearestLine = nearest ? await record.client!.locate({ term_id: nearest.term_id, context_lines: 0 }).then((r) => r.uplc?.line ?? null, () => null) : null;
        termless.push({ uplc_line: line, nearest_line: nearestLine, nearest_term_id: nearest?.term_id ?? null });
      }
    }
    if (termless.length > 0) {
      return fail({
        code: "invalid_argument",
        message: `breakpoints.uplc_lines ${termless.map((t) => t.uplc_line).join(", ")}: no term starts there (a closing bracket), so the breakpoint could never fire; use ${termless.map((t) => (t.nearest_line !== null ? `line ${t.nearest_line} (term ${t.nearest_term_id})` : "a line debug_source(with_ids=true) lists term_ids for")).join(", ")} instead.`,
        argument: "breakpoints",
        termless_lines: termless,
        dbg_id: record.dbgId,
      });
    }
  }
  // The new breakpoint set is built aside and stored once the worker accepted the call, so a call it
  // refuses (a bad term_id, cpu, builtin, hit) changes nothing: no breakpoints, no restart, no counters.
  const nextBreakpoints = { termIds: args.clear_breakpoints ? [] : record.breakpoints.termIds.slice(), uplcLines: args.clear_breakpoints ? [] : record.breakpoints.uplcLines.slice() };
  for (const id of args.breakpoints?.term_ids ?? []) if (!nextBreakpoints.termIds.includes(id)) nextBreakpoints.termIds.push(id);
  for (const line of args.breakpoints?.uplc_lines ?? []) if (!nextBreakpoints.uplcLines.includes(line)) nextBreakpoints.uplcLines.push(line);
  let committed = false;
  const commit = (): void => {
    if (committed) return;
    committed = true;
    record.breakpoints = nextBreakpoints;
  };

  // gdb semantics: when the session is paused ON a term that matched a stop condition (breakpoint,
  // term, line, builtin), the resume must step off it instead of re-triggering; after any other stop
  // (limit / cancelled / steps / trace / budget) the current term has not been checked yet.
  let skipFirst = !args.restart && record.lastStatus === "ready" && record.extra.pausedByStop === true;
  let restartPending = args.restart === true;
  let stepsDone = 0;
  let report: RunReport | undefined;
  let chunks = 0;
  // Traces of every chunk: a chunk only reports the lines past the previous report.
  const newTraces: string[] = [];
  let newTraceTotal = 0;
  while (true) {
    const now = Date.now();
    const remainingMs = deadline - now;
    if (remainingMs <= 0 && report) break;
    const chunkDeadline = Math.min(deadline, now + RUN_CHUNK_MS);
    const spec: RunSpec = {
      until: args.until as UntilKind,
      steps: args.steps !== undefined ? args.steps - stepsDone : undefined,
      term_id: args.term_id,
      line: args.line,
      contains: args.contains,
      builtin: args.builtin,
      cpu: args.cpu,
      hit: args.hit,
      stop_before: args.stop_before,
      restart: restartPending,
      max_steps: Math.max(1, maxSteps - stepsDone),
      deadline_at: chunkDeadline,
      breakpoints: { term_ids: nextBreakpoints.termIds.slice(), uplc_lines: nextBreakpoints.uplcLines.slice() },
      skip_first: skipFirst,
      context_lines: contextLines,
      frames: 6,
      max_new_traces: MAX_NEW_TRACES,
    };
    let chunk: RunReport;
    try {
      // Host-side soft budget: a little past the chunk deadline so the worker returns on its own.
      chunk = await client.run(spec, Math.max(1_000, chunkDeadline - Date.now() + 3_000), signal);
    } catch (error) {
      return sessionErrorResult(ctx, record, error);
    }
    commit();
    restartPending = false;
    chunks++;
    stepsDone += chunk.steps_this_call;
    skipFirst = false;
    for (const message of chunk.traces.new) if (newTraces.length < MAX_NEW_TRACES) newTraces.push(message);
    newTraceTotal += chunk.traces.new_total;
    report = chunk;
    const chunkHitOwnDeadline = chunk.stopped.kind === "limit" && chunk.stopped.reason === "deadline" && Date.now() < deadline;
    const stepsBudgetLeft = stepsDone < maxSteps && (args.until !== "steps" || stepsDone < (args.steps ?? 1));
    // An unfinished exact-position replay (trace / budget / before the failure) is not new work: keep
    // driving it to the whole-call deadline even when the step budget is spent, or the machine stays rewound.
    if (!(chunkHitOwnDeadline && (stepsBudgetLeft || chunk.pinning !== undefined))) break;
    if (signal?.aborted) break;
    if (progress.token !== undefined) {
      try {
        await progress.notify({ method: "notifications/progress", params: { progressToken: progress.token, progress: stepsDone, total: maxSteps, message: `${stepsDone.toLocaleString("en-US")} steps, cpu ${chunk.budget.cpu_spent}` } });
      } catch {
        // progress is best effort
      }
    }
  }
  if (!report) return fail({ code: "engine_error", message: "the run produced no report", dbg_id: record.dbgId });

  // A whole-call deadline that the last chunk reported as its own limit.
  if (report.stopped.kind === "limit" && report.stopped.reason === "deadline") {
    report.stopped.detail = report.pinning
      ? `wall-clock budget of ${timeoutMs} ms reached while replaying the machine to pin the exact ${args.stop_before ? "pre-failure" : args.until} position (replayed ${report.pinning.replayed_steps.toLocaleString("en-US")} of ${report.pinning.anchor_steps.toLocaleString("en-US")} steps); call debug_run again with the same until/contains/cpu${args.stop_before ? "/stop_before" : ""} to continue`
      : `wall-clock budget of ${timeoutMs} ms reached after ${stepsDone.toLocaleString("en-US")} steps in this call; call again to continue`;
  }
  if (report.stopped.kind === "limit" && report.stopped.reason === "max_steps") {
    report.stopped.detail = `max_steps (${maxSteps.toLocaleString("en-US")}) reached in this call; call again to continue`;
  }

  record.lastPosition = report.position;
  record.lastStatus = report.status === "cancelled" ? "ready" : report.status;
  record.version = report.version;
  record.totalSteps = report.steps_total;
  record.logsOffset = report.traces.total;
  record.lastTermId = report.position.term_id ?? report.position.last_term_id ?? -1;
  record.extra.pausedByStop = ["term", "uplc_line", "builtin", "breakpoint"].includes(report.stopped.kind);
  if (report.stopped.kind === "error") {
    // The failing term (an explicit `(error)`), kept for the UI hand-off; unknown for builtin / machine errors.
    const failedAt = report.error_at ?? report.position;
    if (failedAt.term_id !== null) record.errorTermId = failedAt.term_id;
    else if (record.errorTermId === undefined) record.errorTermId = null;
    // The term computed last before the failure: all there is to point at for a builtin / machine error.
    if (failedAt.last_term_id !== null && failedAt.last_term_id !== undefined) record.errorLastTermId = failedAt.last_term_id;
    else if (record.errorLastTermId === undefined) record.errorLastTermId = null;
  }

  const body: Record<string, unknown> = {
    dbg_id: record.dbgId,
    stopped: { kind: report.stopped.kind, detail: report.stopped.detail },
    steps_this_call: stepsDone,
    steps_total: report.steps_total,
    status: report.status,
    position: shapePosition(report.position),
    uplc_window: report.uplc_window.text,
    ...(report.uplc_window.dedent > 0 ? { uplc_window_dedent: report.uplc_window.dedent } : {}),
    frames: report.frames.map((f) => ({ depth: f.index, kind: f.kind, term_id: f.term_id ?? null, uplc_line: f.uplc_line ?? null, ...(f.env_size !== undefined ? { env_size: f.env_size } : {}), ...(f.detail ? { detail: f.detail } : {}) })),
    frames_total: report.frames_total,
    ...(report.frames_note ? { frames_note: report.frames_note } : {}),
    budget: report.budget,
    traces: { total: report.traces.total, new: newTraces, ...(newTraceTotal > newTraces.length ? { new_total: newTraceTotal, note: "more new traces than shown: read the traces resource or debug_inspect(what='traces')" } : {}) },
    version: report.version,
    elapsed_ms: Date.now() - started,
    chunks,
  };
  if (report.error_message !== undefined) body.error_message = report.error_message;
  if (report.stopped.kind === "error") {
    if (report.error_at) {
      // stop_before: the machine stands one transition before the failure, with its state in this reply.
      body.error_at = shapePosition(report.error_at);
      body.failure = failureKind(report.error_message, report.error_at.term_id !== null);
      if (report.at_failure) Object.assign(body, shapeAtFailure(report.at_failure));
    } else {
      body.rewind = rewindAdvice(report);
    }
  }
  if (report.rewound_from !== undefined) body.rewound_from = report.rewound_from;
  if (report.pinning) {
    body.pinning = { anchor_steps: report.pinning.anchor_steps, rewound_from: report.pinning.rewound_from, replayed_steps: report.pinning.replayed_steps };
    body.note = `the ${args.stop_before ? "pre-failure" : args.until} position holds between steps ${report.pinning.anchor_steps.toLocaleString("en-US")} and ${report.pinning.rewound_from.toLocaleString("en-US")}; to land on the exact step the machine was rewound to 0 and is being re-executed deterministically (steps_total is its current position, steps_this_call counts replayed transitions too). Call debug_run again with the same until/contains/cpu${args.stop_before ? "/stop_before" : ""} to finish; any other stop condition abandons the replay from the current position.`;
  } else if (report.replayed) {
    body.note = "the exact stop position was pinned by replaying the machine from the start (deterministic); steps_total is the machine's real position and steps_this_call counts the replayed transitions too";
  }
  const parity = parityOf(record, report.budget, report.status);
  if (parity) body.parity = parity;
  if (record.breakpoints.termIds.length + record.breakpoints.uplcLines.length > 0) {
    body.breakpoints = { term_ids: record.breakpoints.termIds, uplc_lines: record.breakpoints.uplcLines };
  }
  return ok(body);
}

const NO_PROGRESS: Progress = { token: undefined, notify: async () => undefined };

/** The tool body: lease the session (waiting for short commands in flight), run, release. */
export async function debugRun(ctx: AppContext, args: Args, signal: AbortSignal | undefined, progress: Progress = NO_PROGRESS): Promise<ToolResult> {
  const lease = await leaseSessionWait(ctx, args.dbg_id, { tool: "debug_run", long: true });
  if (!lease.ok) return lease.result;
  try {
    return await runSession(ctx, lease.record, args, signal, progress);
  } finally {
    lease.release();
  }
}

export const debugRunTool: ToolModule = {
  name: "debug_run",
  register(server: McpServer, ctx: AppContext) {
    server.registerTool(
      "debug_run",
      {
        title: T.title,
        description: T.description,
        inputSchema,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      async (args, extra) =>
        debugRun(ctx, args, extra.mcpReq.signal, {
          token: extra.mcpReq._meta?.progressToken as string | number | undefined,
          notify: (n) => extra.mcpReq.notify(n as never),
        }),
    );
  },
};
