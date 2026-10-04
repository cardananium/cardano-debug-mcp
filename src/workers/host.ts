// WorkerHost: generic request/response RPC over `node:worker_threads` with the discipline the
// wasm engines need — request ids, per-call budgets with a cooperative stop flag followed by a
// hard `terminate()`, classification of wasm traps as fatal (instance poisoned -> respawn), input
// size caps, and both worker stdio streams mirrored to the main thread's stderr (stdout is the
// JSON-RPC channel and must stay clean).
//
// Lifecycle: a host is created cold; the first `call()` (or `warm()`) spawns the worker. When the
// worker dies (trap, uncaught error, exit, hard timeout) in-flight calls are rejected, queued calls
// survive, and — with `autoRespawn` (default) — a fresh worker is spawned at once. With
// `autoRespawn: false` (one-worker-per-debug-session) the host stays dead — every call rejects with
// `WorkerUnavailableError` — until `respawn()` (or `terminate()`, which allows a lazy respawn).

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, type ResourceLimits, type TransferListItem } from "node:worker_threads";

import {
  argumentByteLength,
  isRpcReady,
  isRpcResult,
  STOP_FLAG_INDEX,
  STOP_FLAG_KEY,
  WorkerAbortedError,
  WorkerCallError,
  WorkerInputTooLargeError,
  WorkerTimeoutError,
  WorkerUnavailableError,
  type RpcCallMessage,
} from "./rpc.js";

export type RespawnReason =
  | "fatal_error"
  | "timeout"
  | "abort"
  | "worker_error"
  | "worker_exit"
  | "ready_timeout"
  | "manual";

export interface RespawnInfo {
  reason: RespawnReason;
  /** Generation of the worker that was lost. */
  lostGeneration: number;
  /** Generation of the replacement, or -1 when the host is not respawning (autoRespawn off / disposed). */
  newGeneration: number;
  detail?: string;
}

export interface WorkerHostOptions {
  /** Worker script (.js in dist, .ts under tsx). See `resolveWorkerEntry`. */
  entry: URL | string;
  /** Short name for log prefixes and error messages. */
  name: string;
  /** Extra `workerData` (structured-cloned once per spawn; a `WebAssembly.Module` is allowed). */
  workerData?: Record<string, unknown>;
  /** Budget of a call that does not pass its own `timeoutMs`. Default 10 000. */
  defaultTimeoutMs?: number;
  /** After the soft budget elapses the stop flag is raised; this many ms later the worker is terminated. Default 5 000. 0 = terminate at once. */
  hardKillGraceMs?: number;
  /** Cap on the summed size of string/byte arguments of one call. Default 2 MiB. */
  maxInputBytes?: number;
  /** How long a fresh worker may take to post `ready` (module load) before it is discarded. Default 60 000. */
  readyTimeoutMs?: number;
  /** One call in flight at a time (FIFO). Default true. Required for stop-flag semantics to be per-call. */
  serial?: boolean;
  /** Spawn a replacement automatically when the worker is lost. Default true. */
  autoRespawn?: boolean;
  /** `resourceLimits` of the worker (e.g. `{ maxOldGenerationSizeMb: 1024 }`). */
  resourceLimits?: ResourceLimits;
  /** Called after a worker was lost (whether or not a replacement is spawned). */
  onRespawn?: (info: RespawnInfo) => void;
  /** Where worker stdout/stderr lines go. Default: `process.stderr`. */
  mirror?: (line: string) => void;
  /** Node flags for the worker (default: inherit `process.execArgv`). Tests use `['--import', 'tsx']` to spawn .ts workers. */
  execArgv?: string[];
  /** Last sentence of the hard-timeout message. Default: the input is too large or too complex (right for one-shot calls, wrong for a stepping loop). */
  timeoutHint?: string;
}

export interface CallOptions {
  /** Soft budget of this call. Default: host `defaultTimeoutMs`. */
  timeoutMs?: number;
  /** Aborts a queued call outright; raises the stop flag for an in-flight one, then terminates after `hardKillGraceMs`. */
  signal?: AbortSignal;
  /** Transfer list for `postMessage` (ArrayBuffers / MessagePorts). */
  transfer?: TransferListItem[];
  /** Override the host's input cap for this call (e.g. 16 MiB for validate). */
  maxInputBytes?: number;
  /** Name for the input in size-refusal messages. */
  inputSubject?: string;
}

export interface WorkerHostStats {
  name: string;
  generation: number;
  alive: boolean;
  ready: boolean;
  inFlight: number;
  queued: number;
  totalCalls: number;
  totalRespawns: number;
  lastLoss?: RespawnInfo;
  workerInfo?: Record<string, unknown>;
}

interface PendingCall {
  id: number;
  method: string;
  args: unknown[];
  transfer: TransferListItem[] | undefined;
  timeoutMs: number;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  detachAbort: (() => void) | undefined;
  dispatched: boolean;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_HINT = "The input is too large or too complex for this operation to finish in its budget.";
/** Worker stderr lines kept to explain a loss (a stack trace is many lines; the cause is its first). */
const STDERR_KEEP = 12;
const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_MAX_INPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
/** After a ready timeout or repeated start-up crashes, refuse to respawn for this long so a broken module does not spin. */
const SPAWN_BACKOFF_MS = 30_000;
/** Consecutive workers that died before reporting `ready` before the host backs off. */
const MAX_STARTUP_FAILURES = 3;

export class WorkerHost {
  readonly name: string;
  /** Shared with the worker: `stopFlag[STOP_FLAG_INDEX] !== 0` asks it to stop its current job. */
  readonly stopFlag: Int32Array;

  private readonly entry: URL | string;
  private readonly workerData: Record<string, unknown>;
  private readonly defaultTimeoutMs: number;
  private readonly hardKillGraceMs: number;
  private readonly maxInputBytes: number;
  private readonly readyTimeoutMs: number;
  private readonly serial: boolean;
  private readonly autoRespawn: boolean;
  private readonly resourceLimits: ResourceLimits | undefined;
  private readonly onRespawn: ((info: RespawnInfo) => void) | undefined;
  private readonly mirror: (line: string) => void;
  private readonly execArgv: string[] | undefined;
  private readonly timeoutHint: string;

  private worker: Worker | null = null;
  private generation = 0;
  private ready = false;
  private readyWaiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private workerInfo: Record<string, unknown> | undefined;
  private spawnBlockedUntil = 0;
  /** Set when the worker was lost involuntarily and `autoRespawn` is off: calls reject until `respawn()`. */
  private lostInfo: RespawnInfo | null = null;
  /** Workers lost before they ever became ready, in a row (reset on `ready`). */
  private startupFailures = 0;

  private nextId = 1;
  private readonly inFlight = new Map<number, PendingCall>();
  private readonly queue: PendingCall[] = [];
  private disposed = false;
  private totalCalls = 0;
  private totalRespawns = 0;
  private lastLoss: RespawnInfo | undefined;
  private partialLines: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  /** Recent stderr lines of the current worker, for the explanation of its loss. */
  private stderrLines: string[] = [];

  constructor(options: WorkerHostOptions) {
    this.name = options.name;
    this.entry = options.entry;
    this.workerData = options.workerData ?? {};
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.hardKillGraceMs = options.hardKillGraceMs ?? DEFAULT_GRACE_MS;
    this.maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.serial = options.serial ?? true;
    this.autoRespawn = options.autoRespawn ?? true;
    this.resourceLimits = options.resourceLimits;
    this.onRespawn = options.onRespawn;
    this.mirror = options.mirror ?? ((line) => process.stderr.write(line + "\n"));
    this.execArgv = options.execArgv;
    this.timeoutHint = options.timeoutHint ?? DEFAULT_TIMEOUT_HINT;
    this.stopFlag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  }

  // ---------- public surface ----------

  /** Generation counter; bumps every time a worker is discarded. */
  get currentGeneration(): number {
    return this.generation;
  }

  /** True while a worker thread exists (it may still be loading). */
  get alive(): boolean {
    return this.worker !== null;
  }

  /** True once the current worker posted `ready`. */
  get isReady(): boolean {
    return this.ready;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** In-flight + queued calls. */
  get pendingCount(): number {
    return this.inFlight.size + this.queue.length;
  }

  stats(): WorkerHostStats {
    return {
      name: this.name,
      generation: this.generation,
      alive: this.alive,
      ready: this.ready,
      inFlight: this.inFlight.size,
      queued: this.queue.length,
      totalCalls: this.totalCalls,
      totalRespawns: this.totalRespawns,
      lastLoss: this.lastLoss,
      workerInfo: this.workerInfo,
    };
  }

  /** Raise the cooperative stop flag (the worker polls it between steps / batches). */
  requestStop(): void {
    Atomics.store(this.stopFlag, STOP_FLAG_INDEX, 1);
    Atomics.notify(this.stopFlag, STOP_FLAG_INDEX);
  }

  clearStop(): void {
    Atomics.store(this.stopFlag, STOP_FLAG_INDEX, 0);
  }

  get stopRequested(): boolean {
    return Atomics.load(this.stopFlag, STOP_FLAG_INDEX) !== 0;
  }

  /** Spawn (if needed) and wait until the worker reports ready. */
  async warm(): Promise<void> {
    if (this.disposed) throw new WorkerUnavailableError(`${this.name}: host is disposed`);
    this.ensureWorker();
    await this.whenReady();
  }

  /** Round trip through the worker's built-in `__ping` handler. */
  ping(timeoutMs = 5_000): Promise<string> {
    return this.call<string>("__ping", [], { timeoutMs });
  }

  /**
   * Invoke `method` in the worker. Rejects with `WorkerInputTooLargeError` (before dispatch),
   * `WorkerAbortedError`, `WorkerTimeoutError`, `WorkerUnavailableError`, or `WorkerCallError`
   * (the handler threw; `.fatal` when the wasm instance was poisoned and the worker replaced).
   */
  call<T = unknown>(method: string, args: unknown[] = [], options: CallOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.disposed) {
        reject(new WorkerUnavailableError(`${this.name}: host is disposed`));
        return;
      }
      const limit = options.maxInputBytes ?? this.maxInputBytes;
      // Exact up to the limit; past it a lower bound (the text of the rest is not scanned).
      const bytes = argumentByteLength(args, limit);
      if (bytes > limit) {
        reject(new WorkerInputTooLargeError(bytes, limit, options.inputSubject, { atLeast: true }));
        return;
      }
      if (options.signal?.aborted) {
        reject(new WorkerAbortedError());
        return;
      }
      const call: PendingCall = {
        id: this.nextId++,
        method,
        args,
        transfer: options.transfer,
        timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
        resolve: resolve as (value: unknown) => void,
        reject,
        signal: options.signal,
        detachAbort: undefined,
        dispatched: false,
        settled: false,
        timer: null,
        graceTimer: null,
      };
      if (options.signal) {
        const signal = options.signal;
        const onAbort = () => this.abortCall(call);
        signal.addEventListener("abort", onAbort, { once: true });
        call.detachAbort = () => signal.removeEventListener("abort", onAbort);
      }
      this.totalCalls++;
      this.queue.push(call);
      this.pump();
    });
  }

  /** True when the worker was lost (trap / timeout / crash) and `autoRespawn` is off; `respawn()` clears it. */
  get isLost(): boolean {
    return this.lostInfo !== null;
  }

  /** Kill the current worker: in-flight calls reject (`WorkerUnavailableError`), queued calls are dropped too. The host stays usable (next call spawns lazily). */
  async terminate(): Promise<void> {
    const queued = this.queue.splice(0, this.queue.length);
    for (const call of queued) this.settle(call, new WorkerUnavailableError(`${this.name}: worker terminated before this call ran`));
    this.loseWorker("manual", "terminate() called", false);
    this.lostInfo = null;
  }

  /** Terminate and spawn a fresh worker, resolving when it is ready. */
  async respawn(): Promise<void> {
    if (this.disposed) throw new WorkerUnavailableError(`${this.name}: host is disposed`);
    const queued = this.queue.splice(0, this.queue.length);
    for (const call of queued) this.settle(call, new WorkerUnavailableError(`${this.name}: worker respawned before this call ran`));
    this.spawnBlockedUntil = 0;
    this.startupFailures = 0;
    this.loseWorker("manual", "respawn() called", true);
    this.lostInfo = null;
    if (!this.worker) this.ensureWorker();
    await this.whenReady();
  }

  /** Terminate and refuse every later call. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.terminate();
  }

  // ---------- scheduling ----------

  private pump(): void {
    if (this.disposed) return;
    if (this.queue.length === 0) return;
    let worker: Worker | null;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      const failed = this.queue.splice(0, this.queue.length);
      for (const call of failed) this.settle(call, error);
      return;
    }
    if (!worker || !this.ready) return; // dispatched when `ready` arrives
    while (this.queue.length > 0 && (!this.serial || this.inFlight.size === 0)) {
      const call = this.queue.shift()!;
      if (call.settled) continue;
      this.dispatch(worker, call);
    }
  }

  private dispatch(worker: Worker, call: PendingCall): void {
    if (this.inFlight.size === 0) this.clearStop();
    call.dispatched = true;
    this.inFlight.set(call.id, call);
    const message: RpcCallMessage = { type: "call", id: call.id, method: call.method, args: call.args };
    try {
      worker.postMessage(message, call.transfer);
    } catch (error) {
      this.inFlight.delete(call.id);
      this.settle(
        call,
        new WorkerCallError({
          name: error instanceof Error ? error.name : "DataCloneError",
          message: `${this.name}: the arguments of ${call.method} could not be handed to the worker: ${error instanceof Error ? error.message : String(error)}`,
          fatal: false,
          kind: "result_not_transferable",
        }),
      );
      return;
    }
    call.timer = setTimeout(() => this.onSoftTimeout(call), call.timeoutMs);
  }

  private onSoftTimeout(call: PendingCall): void {
    call.timer = null;
    if (call.settled) return;
    this.requestStop();
    if (this.hardKillGraceMs <= 0) {
      this.onHardTimeout(call);
      return;
    }
    call.graceTimer = setTimeout(() => this.onHardTimeout(call), this.hardKillGraceMs);
  }

  private onHardTimeout(call: PendingCall): void {
    call.graceTimer = null;
    if (call.settled) return;
    const total = call.timeoutMs + Math.max(0, this.hardKillGraceMs);
    this.inFlight.delete(call.id);
    this.settle(
      call,
      new WorkerTimeoutError(
        `${this.name}: ${call.method} did not answer within ${formatDuration(total)}; the worker was terminated. ${this.timeoutHint}`,
        total,
        call.method,
      ),
    );
    this.loseWorker("timeout", `${call.method} exceeded ${formatDuration(total)}`, this.autoRespawn);
  }

  private abortCall(call: PendingCall): void {
    if (call.settled) return;
    if (!call.dispatched) {
      const index = this.queue.indexOf(call);
      if (index >= 0) this.queue.splice(index, 1);
      this.settle(call, new WorkerAbortedError());
      return;
    }
    // In flight: ask nicely, then terminate.
    this.requestStop();
    if (call.graceTimer) return;
    const kill = () => {
      if (call.settled) return;
      this.inFlight.delete(call.id);
      this.settle(call, new WorkerAbortedError(`${this.name}: ${call.method} was aborted; the worker was terminated.`));
      this.loseWorker("abort", `${call.method} aborted by caller`, this.autoRespawn);
    };
    if (this.hardKillGraceMs <= 0) kill();
    else call.graceTimer = setTimeout(kill, this.hardKillGraceMs);
  }

  // ---------- worker lifecycle ----------

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (this.lostInfo) {
      throw new WorkerUnavailableError(
        `${this.name}: the worker was lost (${this.lostInfo.reason}: ${this.lostInfo.detail ?? ""}) and this host does not respawn automatically; call respawn().`,
      );
    }
    if (Date.now() < this.spawnBlockedUntil) {
      throw new WorkerUnavailableError(
        `${this.name}: the worker module failed to load recently; not retrying for another ${formatDuration(this.spawnBlockedUntil - Date.now())}.`,
      );
    }
    const generation = this.generation;
    this.clearStop();
    const worker = new Worker(this.entry, {
      name: this.name,
      workerData: { ...this.workerData, [STOP_FLAG_KEY]: this.stopFlag.buffer },
      stdout: true,
      stderr: true,
      resourceLimits: this.resourceLimits,
      execArgv: this.execArgv,
    });
    this.worker = worker;
    this.ready = false;
    this.workerInfo = undefined;
    this.stderrLines = [];
    worker.stdout.on("data", (chunk: Buffer | string) => this.mirrorChunk("stdout", chunk));
    worker.stderr.on("data", (chunk: Buffer | string) => this.mirrorChunk("stderr", chunk));
    worker.on("message", (message: unknown) => this.onMessage(generation, message));
    worker.on("error", (error: Error) => {
      if (generation !== this.generation) return;
      this.loseWorker("worker_error", `${error.name}: ${error.message}`, this.autoRespawn);
    });
    worker.on("exit", (code: number) => {
      if (generation !== this.generation) return;
      this.loseWorker("worker_exit", `exit code ${code}`, this.autoRespawn);
    });
    this.readyTimer = setTimeout(() => this.onReadyTimeout(generation), this.readyTimeoutMs);
    return worker;
  }

  private onMessage(generation: number, message: unknown): void {
    if (generation !== this.generation || this.disposed) return;
    if (isRpcReady(message)) {
      this.markReady(message.info);
      return;
    }
    if (!isRpcResult(message)) return;
    if (!this.ready) this.markReady(undefined); // an answer proves the module is loaded
    const call = this.inFlight.get(message.id);
    if (!call) return;
    this.inFlight.delete(message.id);
    if (message.ok) {
      this.settle(call, null, message.value);
    } else {
      const error = new WorkerCallError(message.error);
      this.settle(call, error);
      if (message.error.fatal) {
        this.loseWorker("fatal_error", `${message.error.name}: ${message.error.message}`, this.autoRespawn);
        return;
      }
    }
    this.pump();
  }

  private markReady(info: Record<string, unknown> | undefined): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    this.ready = true;
    this.startupFailures = 0;
    if (info) this.workerInfo = info;
    const waiters = this.readyWaiters.splice(0, this.readyWaiters.length);
    for (const w of waiters) w.resolve();
    this.pump();
  }

  private onReadyTimeout(generation: number): void {
    this.readyTimer = null;
    if (generation !== this.generation || this.ready) return;
    this.spawnBlockedUntil = Date.now() + SPAWN_BACKOFF_MS;
    const error = new WorkerUnavailableError(
      `${this.name}: the worker module did not load within ${formatDuration(this.readyTimeoutMs)}, so nothing ran.`,
    );
    const queued = this.queue.splice(0, this.queue.length);
    for (const call of queued) this.settle(call, error);
    this.loseWorker("ready_timeout", error.message, false);
  }

  private whenReady(): Promise<void> {
    if (this.ready && this.worker) return Promise.resolve();
    if (!this.worker) return Promise.reject(new WorkerUnavailableError(`${this.name}: no worker`));
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  /**
   * Discard the current worker. In-flight calls reject with `WorkerUnavailableError`; queued calls
   * stay queued. Spawns a replacement when `respawn` is true (and the host is not disposed).
   */
  private loseWorker(reason: RespawnReason, detailInput: string, respawn: boolean): void {
    const lost = this.worker;
    // What the worker said on stderr last is usually the cause (an init failure, a panic) and is
    // otherwise invisible to the model: append it to the detail every message below carries.
    this.flushPartialLines();
    const tail = reason === "manual" ? undefined : this.lastStderrCause();
    const detail = tail ? `${detailInput}; last worker stderr: ${tail}` : detailInput;
    const lostGeneration = this.generation;
    const wasReady = this.ready;
    this.generation++;
    this.worker = null;
    this.ready = false;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    const waiters = this.readyWaiters.splice(0, this.readyWaiters.length);
    for (const w of waiters) w.reject(new WorkerUnavailableError(`${this.name}: worker lost while starting (${reason}: ${detail})`));

    const pending = Array.from(this.inFlight.values());
    this.inFlight.clear();
    for (const call of pending) {
      this.settle(call, new WorkerUnavailableError(`${this.name}: the worker was lost while running ${call.method} (${reason}: ${detail}).`));
    }
    if (lost) {
      lost.removeAllListeners();
      lost.stdout.removeAllListeners();
      lost.stderr.removeAllListeners();
      void lost.terminate().catch(() => undefined);
    }
    this.clearStop();

    // A worker that dies before `ready` (module load crash) must not be respawned in a hot loop.
    let startupCrash = false;
    if (lost && !wasReady && reason !== "manual") {
      this.startupFailures++;
      if (this.startupFailures >= MAX_STARTUP_FAILURES) {
        startupCrash = true;
        this.spawnBlockedUntil = Date.now() + SPAWN_BACKOFF_MS;
        const error = new WorkerUnavailableError(
          `${this.name}: the worker crashed ${this.startupFailures} times while starting (${detail}); not retrying for ${formatDuration(SPAWN_BACKOFF_MS)}.`,
        );
        const queued = this.queue.splice(0, this.queue.length);
        for (const call of queued) this.settle(call, error);
      }
    }
    const willRespawn = respawn && !this.disposed && lost !== null && !startupCrash;
    const info: RespawnInfo = { reason, lostGeneration, newGeneration: willRespawn ? this.generation : -1, detail };
    if (lost && !willRespawn && !this.autoRespawn && reason !== "manual") this.lostInfo = info;
    if (lost) {
      this.lastLoss = info;
      if (reason !== "manual") console.error(`[cardano-debug] worker ${this.name}#${lostGeneration} lost (${reason}): ${detail}`);
      if (willRespawn) this.totalRespawns++;
      try {
        this.onRespawn?.(info);
      } catch (error) {
        console.error(`[cardano-debug] onRespawn handler of ${this.name} threw:`, error);
      }
    }
    if (willRespawn) {
      try {
        this.ensureWorker();
      } catch (error) {
        const queued = this.queue.splice(0, this.queue.length);
        for (const call of queued) this.settle(call, error);
      }
    }
  }

  // ---------- bookkeeping ----------

  private settle(call: PendingCall, error: unknown, value?: unknown): void {
    if (call.settled) return;
    call.settled = true;
    if (call.timer) {
      clearTimeout(call.timer);
      call.timer = null;
    }
    if (call.graceTimer) {
      clearTimeout(call.graceTimer);
      call.graceTimer = null;
    }
    call.detachAbort?.();
    if (error === null) call.resolve(value);
    else call.reject(error);
  }

  private mirrorChunk(stream: "stdout" | "stderr", chunk: Buffer | string): void {
    const text = this.partialLines[stream] + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    const lines = text.split("\n");
    this.partialLines[stream] = lines.pop() ?? "";
    for (const line of lines) {
      this.mirror(`[worker:${this.name}${stream === "stdout" ? " stdout" : ""}] ${line}`);
      if (stream === "stderr") this.noteStderr(line);
    }
  }

  private noteStderr(line: string): void {
    if (line.trim() === "") return;
    this.stderrLines.push(line);
    if (this.stderrLines.length > STDERR_KEEP) this.stderrLines.shift();
  }

  /** The most recent stderr line that is not a stack frame (the cause line of a trace), capped. */
  private lastStderrCause(): string | undefined {
    for (let i = this.stderrLines.length - 1; i >= 0; i--) {
      const line = this.stderrLines[i]!.trim();
      if (line !== "" && !/^at\s/.test(line)) return line.length > 300 ? `${line.slice(0, 300)}…` : line;
    }
    return undefined;
  }

  private flushPartialLines(): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const rest = this.partialLines[stream];
      if (rest) {
        this.mirror(`[worker:${this.name}${stream === "stdout" ? " stdout" : ""}] ${rest}`);
        if (stream === "stderr") this.noteStderr(rest);
        this.partialLines[stream] = "";
      }
    }
  }
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

/**
 * Locate a worker entry in both run modes. `name` is the bare file name without extension
 * (`lib.worker`). Under tsup the caller's `import.meta.url` is `dist/server.js`, so
 * `dist/workers/<name>.js` is tried first; under tsx it is the source file, so `src/workers/<name>.ts`.
 */
export function resolveWorkerEntry(name: string, base: string | URL = import.meta.url): URL {
  const baseDir = path.dirname(fileURLToPath(base));
  const candidates = [
    path.join(baseDir, "workers", `${name}.js`),
    path.join(baseDir, `${name}.ts`),
    path.join(baseDir, `${name}.js`),
    path.join(baseDir, "workers", `${name}.ts`),
    path.join(baseDir, "..", "workers", `${name}.js`),
    path.join(baseDir, "..", "workers", `${name}.ts`),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return pathToFileURL(candidate);
  }
  throw new Error(`worker entry ${name} not found near ${baseDir} (tried ${candidates.join(", ")})`);
}
