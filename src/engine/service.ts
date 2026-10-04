// EngineService (main thread): compiles the de-uplc engine wasm once, spawns one session.worker per
// debug session and wraps it in a typed `SessionClient`. Attached to `ctx.services.engine` on
// first use (see `engineService(ctx)`), disposed with the context.

import { readFileSync } from "node:fs";

import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { readWasm, resolveWasm } from "../wasm-assets.js";
import { resolveWorkerEntry, WorkerHost, type RespawnInfo } from "../workers/host.js";
import type {
  EngineLanguage,
  InspectOptions,
  InspectWhat,
  LocateQuery,
  LocateResult,
  PartsConfig,
  PositionReport,
  ProfileOptions,
  ProfileReport,
  RunReport,
  RunSpec,
  SessionSummary,
  SourceWindow,
  SourceWindowOptions,
} from "./protocol.js";
import { SESSION_WORKER_MODULE_KEY } from "./protocol.js";
import { registerEngineProviders } from "./resources.js";

declare module "../context.js" {
  interface AppServices {
    engine?: EngineService;
  }
}

export interface SessionClientOptions {
  /** Called when the worker is lost (trap / hard timeout / crash). */
  onLost?: (info: RespawnInfo) => void;
  entry?: URL | string;
}

/** Typed facade over one session worker. All calls are serialised by the WorkerHost. */
export class SessionClient {
  readonly host: WorkerHost;
  private readonly defaultTimeoutMs: number;

  constructor(module: WebAssembly.Module, config: ServerConfig, options: SessionClientOptions = {}) {
    this.defaultTimeoutMs = config.libCallTimeoutMs;
    this.host = new WorkerHost({
      entry: options.entry ?? resolveWorkerEntry("session.worker"),
      name: "session",
      workerData: { [SESSION_WORKER_MODULE_KEY]: module },
      defaultTimeoutMs: config.libCallTimeoutMs,
      // Loops poll the stop flag every 512 steps; a worker that ignores it is stuck inside one builtin.
      hardKillGraceMs: 2_000,
      timeoutHint: "The worker never reached a cancellation check, so it was inside one long engine call (reading the frames of a very deep call stack, or one huge builtin), not stepping.",
      maxInputBytes: config.maxDecompileInputBytes,
      readyTimeoutMs: config.workerReadyTimeoutMs,
      serial: true,
      autoRespawn: false,
      resourceLimits: { maxOldGenerationSizeMb: config.workerMaxOldGenerationMb },
      onRespawn: options.onLost,
    });
  }

  get lost(): boolean {
    return this.host.isLost;
  }

  private call<T>(method: string, args: unknown[], timeoutMs?: number, signal?: AbortSignal): Promise<T> {
    return this.host.call<T>(method, args, { timeoutMs: timeoutMs ?? this.defaultTimeoutMs, signal });
  }

  openParts(parts: PartsConfig, contextLines: number, timeoutMs?: number): Promise<SessionSummary> {
    return this.call<SessionSummary>("open_parts", [parts, contextLines], timeoutMs ?? Math.max(this.defaultTimeoutMs, 30_000));
  }

  openProgram(source: string, language: EngineLanguage, contextLines: number, timeoutMs?: number): Promise<SessionSummary> {
    return this.call<SessionSummary>("open_program", [source, language, contextLines], timeoutMs ?? Math.max(this.defaultTimeoutMs, 30_000));
  }

  summary(contextLines: number): Promise<SessionSummary> {
    return this.call<SessionSummary>("summary", [contextLines]);
  }

  /** `timeoutMs` is the host-side soft budget; the spec's `deadline_at` should fall before it. */
  run(spec: RunSpec, timeoutMs: number, signal?: AbortSignal): Promise<RunReport> {
    return this.call<RunReport>("run", [spec], timeoutMs, signal);
  }

  position(contextLines: number, frames: number, breakpointLines: number[], breakpointTermIds: number[] = []): Promise<PositionReport> {
    return this.call<PositionReport>("position", [contextLines, frames, breakpointLines, breakpointTermIds]);
  }

  inspect(what: InspectWhat, options: InspectOptions): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("inspect", [what, options], Math.max(this.defaultTimeoutMs, 20_000));
  }

  sourceWindow(options: SourceWindowOptions): Promise<SourceWindow> {
    return this.call<SourceWindow>("source_window", [options]);
  }

  locate(query: LocateQuery): Promise<LocateResult> {
    return this.call<LocateResult>("locate", [query]);
  }

  profile(options: ProfileOptions, timeoutMs: number, signal?: AbortSignal): Promise<ProfileReport> {
    return this.call<ProfileReport>("profile", [options], timeoutMs, signal);
  }

  reset(contextLines: number): Promise<PositionReport> {
    return this.call<PositionReport>("reset", [contextLines]);
  }

  uplcText(): Promise<string> {
    return this.call<string>("uplc_text", [], 30_000);
  }

  stateJson(): Promise<string> {
    return this.call<string>("state_json", [], 30_000);
  }

  contextJson(maxChars: number): Promise<string> {
    return this.call<string>("context_json", [maxChars], 30_000);
  }

  tracesAll(): Promise<string[]> {
    return this.call<string[]>("traces_all", [], 30_000);
  }

  profileJson(maxChars: number): Promise<string | null> {
    return this.call<string | null>("profile_json", [maxChars], 30_000);
  }

  /** Free the engine session (when the worker is idle) and terminate the worker. */
  async close(): Promise<void> {
    try {
      // A call in flight (debug_run) would only delay the kill: terminate at once instead.
      if (this.host.alive && !this.host.isLost && this.host.pendingCount === 0) await this.call<boolean>("close", [], 2_000);
    } catch {
      // the worker is terminated below regardless
    }
    await this.host.dispose();
  }

  dispose(): Promise<void> {
    return this.host.dispose();
  }
}

export interface EngineInfo {
  engine: string;
  wasm_path: string;
  wasm_bytes: number;
  compiled: boolean;
  compile_ms?: number;
  sessions_opened: number;
}

/** `WebAssembly` as a value (the Node lib types expose it only as a namespace under lib ES2023). */
const WA = (globalThis as unknown as { WebAssembly: { Module: new (bytes: Uint8Array | ArrayBuffer) => WebAssembly.Module } }).WebAssembly;

export class EngineService {
  private module: WebAssembly.Module | null = null;
  private compileMs: number | undefined;
  private sessionsOpened = 0;
  readonly config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  /** The engine module, compiled on first use (~2.5 MB, tens of ms) and shared by every worker. */
  compiledModule(): WebAssembly.Module {
    if (this.module) return this.module;
    const started = Date.now();
    const bytes = readWasm("de_uplc_bg.wasm");
    const module = new WA.Module(bytes);
    this.module = module;
    this.compileMs = Date.now() - started;
    return module;
  }

  /** Spawn a fresh session worker (cold: the worker loads on the first call / `warm()`). */
  newClient(options: SessionClientOptions = {}): SessionClient {
    this.sessionsOpened++;
    return new SessionClient(this.compiledModule(), this.config, options);
  }

  info(): EngineInfo {
    const wasmPath = resolveWasm("de_uplc_bg.wasm");
    let bytes = 0;
    try {
      bytes = readFileSync(wasmPath).byteLength;
    } catch {
      // unreadable: report 0
    }
    const info: EngineInfo = { engine: "@cardananium/de-uplc-engine-wasm", wasm_path: wasmPath, wasm_bytes: bytes, compiled: this.module !== null, sessions_opened: this.sessionsOpened };
    if (this.compileMs !== undefined) info.compile_ms = this.compileMs;
    return info;
  }
}

/** The process-wide engine service, created on first use; plugs the engine into resources / server-info. */
export function engineService(ctx: AppContext): EngineService {
  const existing = ctx.services.engine;
  if (existing) return existing;
  const service = new EngineService(ctx.config);
  ctx.services.engine = service;
  if (!Object.getOwnPropertyDescriptor(ctx.services, "engineInfo")) {
    Object.defineProperty(ctx.services, "engineInfo", { enumerable: true, configurable: true, get: () => service.info() });
  }
  registerEngineProviders(ctx, service);
  return service;
}
