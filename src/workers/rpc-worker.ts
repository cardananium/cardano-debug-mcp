// Worker-side half of the RPC: `serveWorker(handlers)` answers `WorkerHost.call(method, args)`.
// Handlers are plain functions (sync or async). Built-ins: `__ping`, `__stats`.
//
// Cooperative cancellation: the host raises a flag in a SharedArrayBuffer; long loops call
// `stopRequested()` (or `throwIfStopRequested()`) every batch. The host terminates the thread if
// the flag is ignored past the grace period, so ignoring it only costs the worker its life.

import { isMainThread, parentPort, workerData } from "node:worker_threads";

import {
  isRpcCall,
  STOP_FLAG_INDEX,
  STOP_FLAG_KEY,
  toErrorPayload,
  WorkerCancelledError,
  type RpcErrorPayload,
  type RpcReadyMessage,
  type RpcResultMessage,
} from "./rpc.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WorkerHandler = (...args: any[]) => unknown;
export type WorkerHandlers = Record<string, WorkerHandler>;

export interface ServeWorkerOptions {
  /** Attached to the `ready` message (e.g. engine version). */
  info?: Record<string, unknown> | (() => Record<string, unknown>);
  /** Runs before `ready` is posted (e.g. wasm instantiation). A rejection is reported once and the worker exits. */
  init?: () => void | Promise<void>;
}

let stopFlagCache: Int32Array | null = null;

/** The stop flag shared with the host (all zeros when running outside a WorkerHost, e.g. in tests). */
export function getStopFlag(): Int32Array {
  if (stopFlagCache) return stopFlagCache;
  const data = (workerData ?? {}) as Record<string, unknown>;
  const buffer = data[STOP_FLAG_KEY];
  stopFlagCache =
    buffer instanceof SharedArrayBuffer ? new Int32Array(buffer) : new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  return stopFlagCache;
}

export function stopRequested(): boolean {
  return Atomics.load(getStopFlag(), STOP_FLAG_INDEX) !== 0;
}

export function throwIfStopRequested(message?: string): void {
  if (stopRequested()) throw new WorkerCancelledError(message);
}

/** `workerData` without the host's private keys. */
export function getWorkerData<T extends Record<string, unknown> = Record<string, unknown>>(): T {
  const data = { ...((workerData ?? {}) as Record<string, unknown>) };
  delete data[STOP_FLAG_KEY];
  return data as T;
}

function post(message: RpcResultMessage | RpcReadyMessage): void {
  parentPort?.postMessage(message);
}

function postResult(id: number, value: unknown): void {
  try {
    post({ type: "result", id, ok: true, value });
  } catch (error) {
    const payload: RpcErrorPayload = {
      name: error instanceof Error ? error.name : "DataCloneError",
      message:
        "The handler answered, but the answer could not be handed to the host: " +
        (error instanceof Error ? error.message : String(error)),
      fatal: false,
      kind: "result_not_transferable",
    };
    post({ type: "result", id, ok: false, error: payload });
  }
}

/**
 * Start serving. Returns immediately; the worker stays alive while `parentPort` is listened to.
 * When not running as a worker thread (imported in a test) it does nothing and returns the handlers.
 */
export function serveWorker(handlers: WorkerHandlers, options: ServeWorkerOptions = {}): WorkerHandlers {
  const all: WorkerHandlers = {
    __ping: () => "pong",
    __stats: () => ({ memory: process.memoryUsage(), uptimeMs: Math.round(process.uptime() * 1000) }),
    ...handlers,
  };
  if (isMainThread || !parentPort) return all;

  const port = parentPort;
  port.on("message", (message: unknown) => {
    if (!isRpcCall(message)) return;
    const { id, method, args } = message;
    const handler = Object.prototype.hasOwnProperty.call(all, method) ? all[method] : undefined;
    if (typeof handler !== "function") {
      post({
        type: "result",
        id,
        ok: false,
        error: { name: "Error", message: `${method} is not a method of this worker`, fatal: false, kind: "unknown_method" },
      });
      return;
    }
    let outcome: unknown;
    try {
      outcome = handler(...args);
    } catch (error) {
      post({ type: "result", id, ok: false, error: toErrorPayload(error, "handler_error") });
      return;
    }
    if (outcome instanceof Promise) {
      outcome.then(
        (value) => postResult(id, value),
        (error) => post({ type: "result", id, ok: false, error: toErrorPayload(error, "handler_error") }),
      );
    } else {
      postResult(id, outcome);
    }
  });

  const announce = () => {
    const info = typeof options.info === "function" ? options.info() : options.info;
    post({ type: "ready", info });
  };
  if (options.init) {
    Promise.resolve()
      .then(options.init)
      .then(announce, (error) => {
        console.error(`[worker] init failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        // Let the host see a clean exit reason instead of a hung "loading" state.
        process.exit(1);
      });
  } else {
    announce();
  }
  return all;
}
