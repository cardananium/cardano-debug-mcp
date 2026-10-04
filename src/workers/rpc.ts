// Wire format between the main thread (WorkerHost) and a worker (serveWorker). No imports from either side;
// the host-side error classes extend the library's refusal classes so a `LibClient` (the server's
// `LibBackend`) refuses the way the library documents (`isLibRefusal`, `LibTimeoutError`, ...).

import { LibAbortedError, LibInputTooLargeError, LibTimeoutError, LibUnavailableError } from "@cardananium/cquisitor-lib";
import { formatByteSize, overBudgetMessage } from "@cardananium/cquisitor-lib/worker";

// The input budget is the library's: the same count (every string, nested ones and object entries
// included) and the same wording (no size that rounds like the limit, "at least" for a lower bound).
export { argumentByteLength, formatByteSize, utf8ByteLength } from "@cardananium/cquisitor-lib/worker";

/** Index into the shared stop-flag `Int32Array`. Non-zero = the host asks the worker to stop its current job. */
export const STOP_FLAG_INDEX = 0;

/** Key under which the host passes the stop-flag SharedArrayBuffer inside `workerData`. */
export const STOP_FLAG_KEY = "__cardanoDebugStopFlag";

export interface RpcCallMessage {
  type: "call";
  id: number;
  method: string;
  args: unknown[];
}

export interface RpcErrorPayload {
  name: string;
  message: string;
  /** True for a wasm trap / stack overflow: the wasm instance is poisoned and the worker must be discarded. */
  fatal: boolean;
  /** Extra classification. `result_not_transferable`: the handler answered but structured clone failed. */
  kind?: "result_not_transferable" | "unknown_method" | "cancelled" | "handler_error";
  stack?: string;
  data?: unknown;
}

export type RpcResultMessage =
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; error: RpcErrorPayload };

/** Posted once by the worker when its handlers (and any module they need) are in place. */
export interface RpcReadyMessage {
  type: "ready";
  info?: Record<string, unknown>;
}

export type WorkerToHostMessage = RpcResultMessage | RpcReadyMessage;
export type HostToWorkerMessage = RpcCallMessage;

export function isRpcResult(value: unknown): value is RpcResultMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Partial<RpcResultMessage>;
  return m.type === "result" && typeof m.id === "number" && typeof m.ok === "boolean";
}

export function isRpcReady(value: unknown): value is RpcReadyMessage {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "ready";
}

export function isRpcCall(value: unknown): value is RpcCallMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Partial<RpcCallMessage>;
  return m.type === "call" && typeof m.id === "number" && typeof m.method === "string" && Array.isArray(m.args);
}

/** Wasm trap: the instance is poisoned and must not be reused. */
export function isWasmTrap(error: unknown): boolean {
  const wasm = (globalThis as { WebAssembly?: { RuntimeError?: unknown } }).WebAssembly;
  const RuntimeError = wasm?.RuntimeError;
  if (typeof RuntimeError === "function" && error instanceof (RuntimeError as new () => Error)) return true;
  if (error instanceof Error && (error.name === "RuntimeError" || error.message.startsWith("unreachable"))) return true;
  // Stack overflow inside wasm leaves the shadow stack pointer unrestored, so later calls trap.
  return error instanceof RangeError;
}

/** Thrown inside a worker handler to report cooperative cancellation. */
export class WorkerCancelledError extends Error {
  constructor(message = "The operation was cancelled by the host.") {
    super(message);
    this.name = "WorkerCancelledError";
  }
}

export function toErrorPayload(error: unknown, kind?: RpcErrorPayload["kind"]): RpcErrorPayload {
  if (error instanceof WorkerCancelledError) {
    return { name: error.name, message: error.message, fatal: false, kind: "cancelled" };
  }
  if (error instanceof Error) {
    const payload: RpcErrorPayload = { name: error.name || "Error", message: error.message, fatal: isWasmTrap(error) };
    if (kind) payload.kind = kind;
    if (error.stack) payload.stack = error.stack;
    const data = (error as { data?: unknown }).data;
    if (data !== undefined) payload.data = data;
    return payload;
  }
  // wasm-bindgen throws plain strings for `Err(JsValue::from_str(..))`.
  return { name: "Error", message: typeof error === "string" ? error : safeString(error), fatal: false, kind };
}

function safeString(value: unknown): string {
  try {
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}

// ---------- host-side error classes (what `WorkerHost.call` rejects with) ----------

/** The worker's handler threw (or the wasm trapped). `fatal` mirrors the payload. */
export class WorkerCallError extends Error {
  readonly fatal: boolean;
  readonly kind: RpcErrorPayload["kind"] | undefined;
  readonly remoteName: string;
  readonly data: unknown;
  constructor(payload: RpcErrorPayload) {
    super(payload.message);
    this.name = payload.name === "Error" ? "WorkerCallError" : payload.name;
    this.remoteName = payload.name;
    this.fatal = payload.fatal;
    this.kind = payload.kind;
    this.data = payload.data;
  }
}

/** The call ran past its budget; the worker was (or is being) terminated. A `LibTimeoutError` to the library. */
export class WorkerTimeoutError extends LibTimeoutError {
  readonly timeoutMs: number;
  /** The worker method that was running, when the host knows it. */
  readonly method: string | undefined;
  constructor(message: string, timeoutMs: number, method?: string) {
    super(message);
    this.name = "WorkerTimeoutError";
    this.timeoutMs = timeoutMs;
    this.method = method;
  }
}

/** The worker died or could not be started, so the call never produced an answer. A `LibUnavailableError` to the library. */
export class WorkerUnavailableError extends LibUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "WorkerUnavailableError";
  }
}

/** Refused before reaching the worker: the input exceeds the size budget. A `LibInputTooLargeError` to the library. */
export class WorkerInputTooLargeError extends LibInputTooLargeError {
  readonly bytes: number;
  readonly limit: number;
  /** `bytes` is a lower bound (`argumentByteLength` stops reading text once past the limit), not the size. */
  readonly atLeast: boolean;
  constructor(bytes: number, limit: number, subject = "This input", options: { atLeast?: boolean } = {}) {
    super(overBudgetMessage(bytes, limit, subject, options) ?? `${subject} is over the ${formatByteSize(limit)} limit.`);
    this.name = "WorkerInputTooLargeError";
    this.bytes = bytes;
    this.limit = limit;
    this.atLeast = options.atLeast === true;
  }
}

/** The caller's AbortSignal fired (before dispatch, or while the call was in flight). A `LibAbortedError` to the library. */
export class WorkerAbortedError extends LibAbortedError {
  constructor(message = "The call was aborted by the caller.") {
    super(message);
    this.name = "WorkerAbortedError";
  }
}
