// Helpers shared by the debug_* tools and script_locate: session leasing (missing / busy / lost),
// engine error mapping, position / breakpoint shaping and the session resource links.

import type { EnginePosition, RunSpec, UplcWindow } from "../engine/protocol.js";
import type { AppContext } from "../context.js";
import { busySessionError, classifyLoss, expiredHandleError, lostSessionError, type AcquireOptions, type LossCause, type SessionLease, type SessionRecord } from "../store/sessionRegistry.js";
import type { RespawnInfo } from "../workers/host.js";
import { WorkerCallError, WorkerTimeoutError, WorkerUnavailableError } from "../workers/rpc.js";
import { fail, failFromError, resourceLink, type ResourceLink, type ToolResult } from "./_shared.js";

export const DEFAULT_CONTEXT_LINES = 6;
export const MAX_CONTEXT_LINES = 60;
export const DEFAULT_MAX_STEPS = 2_000_000;
export const MAX_MAX_STEPS = 50_000_000;
export const MAX_RUN_TIMEOUT_MS = 110_000;
/** Steps per host call in `debug_run`: progress + cancellation checks happen between chunks. */
export const RUN_CHUNK_MS = 2_000;

/**
 * The resource links of a session: `debug_open` announces the three below once, the first
 * `debug_profile` adds `profile.json`; every other debug reply carries none (the uris are fixed by
 * the dbg_id, so repeating them is pure noise).
 */
export function sessionLinks(dbgId: string, which: "open" | "profile"): ResourceLink[] {
  if (which === "profile") {
    return [resourceLink(`cardano-debug://session/${dbgId}/profile.json`, `${dbgId} profile`, "application/json", "Full engine profile report of the last debug_profile (one row per executed term)")];
  }
  return [
    resourceLink(`cardano-debug://session/${dbgId}/uplc.txt`, `${dbgId} uplc`, "text/plain", "Whole canonical UPLC of the session's program (one term per line = uplc_line)"),
    resourceLink(`cardano-debug://session/${dbgId}/state.json`, `${dbgId} state`, "application/json", "Session identity, position, breakpoints and the lazy machine state (placeholders carry _path for debug_inspect what=value)"),
    resourceLink(`cardano-debug://session/${dbgId}/traces.txt`, `${dbgId} traces`, "text/plain", "Every trace message emitted so far, one per line"),
  ];
}

/**
 * Position as the tools report it: `{term_id, uplc_line, kind, machine_state}` (+ `label`, and
 * `last_term_id` when the machine is between terms). UPLC coordinates are the only positional system.
 */
export function shapePosition(position: EnginePosition): Record<string, unknown> {
  const out: Record<string, unknown> = {
    term_id: position.term_id,
    kind: position.kind,
    uplc_line: position.uplc_line,
    machine_state: position.machine_state,
  };
  if (position.label !== undefined) out.label = position.label;
  if (position.term_id === null && position.last_term_id !== null) out.last_term_id = position.last_term_id;
  return out;
}

export function windowText(window: UplcWindow): string {
  return window.text;
}

export function breakpointsOf(record: SessionRecord): RunSpec["breakpoints"] {
  return { term_ids: record.breakpoints.termIds.slice(), uplc_lines: record.breakpoints.uplcLines.slice() };
}

export type Lease = { ok: true; record: SessionRecord; release: () => void } | { ok: false; result: ToolResult };

function leaseOutcome(ctx: AppContext, dbgId: string, lease: SessionLease): Lease {
  if (lease.ok) {
    if (!lease.record.client) {
      lease.release();
      return { ok: false, result: fail({ code: "session_lost", message: `Session ${dbgId} has no engine worker attached; reopen it with debug_open.`, handle: dbgId, recreate_with: "debug_open" }) };
    }
    return lease;
  }
  if (lease.reason === "missing") return { ok: false, result: expiredHandleError(dbgId, "debug_open") };
  if (lease.reason === "busy") return { ok: false, result: busySessionError(dbgId, lease.running) };
  const record = ctx.sessions.peek(dbgId);
  return { ok: false, result: record ? lostSessionError(record) : expiredHandleError(dbgId, "debug_open") };
}

/**
 * Take the session lease or produce the right `isError` result. Synchronous: it never waits, so a
 * short command that meets another short one just queues behind it in the worker, and anything
 * that meets a long command (debug_run / debug_profile) answers `busy`.
 */
export function leaseSession(ctx: AppContext, dbgId: string, options: AcquireOptions = {}): Lease {
  return leaseOutcome(ctx, dbgId, ctx.sessions.acquire(dbgId, options));
}

/**
 * `leaseSession` for a long command: waits (bounded) for short commands in flight on the session to
 * drain first, so `Promise.all([debug_inspect, debug_run])` does not fail on the order they arrive.
 */
export async function leaseSessionWait(ctx: AppContext, dbgId: string, options: AcquireOptions = {}, waitMs?: number): Promise<Lease> {
  return leaseOutcome(ctx, dbgId, await ctx.sessions.acquireWait(dbgId, options, waitMs));
}

/** The loss reason and cause of a worker the host reported lost. */
export function lossOf(info: RespawnInfo): { reason: string; cause: LossCause } {
  const reason = `${info.reason}${info.detail ? `: ${info.detail}` : ""}`;
  switch (info.reason) {
    case "fatal_error":
      return { reason, cause: "wasm_trap" };
    case "timeout":
      return { reason, cause: "hard_timeout" };
    case "abort":
      return { reason, cause: "aborted" };
    case "worker_error":
    case "worker_exit":
      return { reason, cause: classifyLoss(info.detail) === "out_of_memory" ? "out_of_memory" : "worker_crash" };
    default:
      return { reason, cause: classifyLoss(reason) };
  }
}

/**
 * Map an error from a session worker call to a tool result. A hard timeout or a dead worker means
 * the session is gone: the record is marked lost so the model gets `session_lost` with the reopen
 * hint (its `partsConfig` is still known).
 */
export function sessionErrorResult(ctx: AppContext, record: SessionRecord, error: unknown): ToolResult {
  if (error instanceof WorkerTimeoutError || error instanceof WorkerUnavailableError || (error instanceof WorkerCallError && error.fatal)) {
    let reason: string;
    let cause: LossCause;
    if (error instanceof WorkerTimeoutError) {
      // The run loops poll the stop flag every 512 steps: a hard kill means one engine call never returned.
      reason = `${error.method ?? "a call"} did not answer within ${Math.round(error.timeoutMs / 1000)} s and the worker was terminated`;
      cause = "hard_timeout";
    } else if (error instanceof WorkerCallError) {
      reason = `${error.remoteName}: ${error.message}`;
      cause = "wasm_trap";
    } else {
      reason = error.message;
      cause = classifyLoss(error.message) === "unknown" ? "worker_crash" : classifyLoss(error.message);
    }
    ctx.sessions.markLost(record.dbgId, reason, cause);
    return lostSessionError({ ...record, lostReason: reason, lostCause: cause });
  }
  if (error instanceof WorkerCallError) {
    const data = error.data as { code?: string; argument?: string; resolved?: string; available?: string[] } | undefined;
    if (data?.code === "path_not_found") {
      return fail({ code: "path_not_found", message: error.message, argument: "path", resolved: data.resolved ?? "", ...(data.available ? { available: data.available } : {}), dbg_id: record.dbgId });
    }
    if (data?.code === "invalid_argument") {
      return fail({ code: "invalid_argument", message: error.message, ...(data.argument ? { argument: data.argument } : {}), dbg_id: record.dbgId });
    }
    if (data?.code === "no_script_context") {
      return fail({ code: "no_script_context", message: error.message, dbg_id: record.dbgId, mode: record.mode });
    }
    return fail({ code: "engine_error", message: error.message, error_name: error.remoteName, dbg_id: record.dbgId });
  }
  return failFromError(error, "engine_error", { dbg_id: record.dbgId });
}

export function expiresAtIso(record: SessionRecord, idleTtlMs: number): string {
  return new Date(Math.min(record.expiresAt, record.lastUsedAt + idleTtlMs)).toISOString();
}

/** `parity` block for tx-mode sessions once the run finished. */
export function parityOf(record: SessionRecord, budget: { cpu_spent: string; mem_spent: string }, status: string): Record<string, unknown> | undefined {
  if (!record.calculatedExUnits) return undefined;
  if (status !== "done" && status !== "error") return undefined;
  const validator = record.calculatedExUnits;
  const match = validator.steps === budget.cpu_spent && validator.mem === budget.mem_spent;
  const out: Record<string, unknown> = {
    validator_calculated: { steps: validator.steps, mem: validator.mem },
    stepper_spent: { cpu: budget.cpu_spent, mem: budget.mem_spent },
    match,
  };
  if (!match) {
    out.note =
      "The stepper's spent units differ from the validator's calculated units. Both engines follow the same protocol version and cost models (see cardano-debug://server/info semantics), so the script took a different path (trace / error), or the session was opened with other parameters (cost_model_source).";
  }
  return out;
}
