// DecompilerService: the process-wide dehosk front — one WorkerHost (serial FIFO, auto-respawn on
// trap / timeout), the option catalogue parsed once per worker generation, the text cache and the
// per-script failure markers. Attached to `ctx.services.decompiler` lazily by `getDecompilerService`.

import type { AppContext } from "../context.js";
import type { ServerConfig } from "../config.js";
import { providersOf, type ScriptArtifactPart } from "../providers.js";
import type { Purpose } from "../vocab/purpose.js";
import { resolveWorkerEntry, WorkerHost, type RespawnInfo } from "../workers/host.js";
import { WorkerAbortedError, WorkerCallError, WorkerTimeoutError, WorkerUnavailableError } from "../workers/rpc.js";
import { DecompileCache, type CacheEntry, type FailureMarker } from "./cache.js";
import { CatalogueIndex, parseCatalogue } from "./catalogue.js";
import { extractNotes } from "./notes.js";
import { buildDecompileOptions, layerOfView, OptionsError, type BuiltOptions, type DecompileView, type UserDecompileOptions } from "./options.js";
import type { PlutusVersion } from "./scriptBytes.js";

declare module "../context.js" {
  interface AppServices {
    decompiler?: DecompilerService;
    /** Info block for `cardano-debug://server/info` (kept in sync by the service). */
    decompilerInfo?: Record<string, unknown>;
  }
}

export interface DecompileRequest {
  /** Single-wrapped script hex (CBOR bytes(flat)); see scriptBytes.ts. */
  scriptHex: string;
  /** On-chain script hash (28-byte hex) — the cache key. */
  scriptHash: string;
  view: DecompileView;
  /** Certain version only; undefined = dehosk auto-detects (and says so in a `// Info:` note). */
  scriptVersion?: PlutusVersion;
  purpose?: Purpose;
  user?: UserDecompileOptions;
  /** Bypass the cache and any failure marker. */
  refresh?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type DecompileOutcome =
  | { ok: true; entry: CacheEntry; cached: boolean; options: BuiltOptions }
  | { ok: false; code: "decompile_failed"; marker: FailureMarker; options: BuiltOptions }
  | { ok: false; code: "decompile_error"; message: string; options: BuiltOptions };

export interface DecompilerServiceOptions {
  entry?: URL | string;
  onRespawn?: (info: RespawnInfo) => void;
  cache?: DecompileCache;
}

/** Errors classified as "the decompiler, not the input, gave up" — these get a failure marker. */
function isStructuralFailure(error: unknown): boolean {
  if (error instanceof WorkerTimeoutError) return true;
  if (error instanceof WorkerCallError && error.fatal) return true;
  return error instanceof WorkerUnavailableError;
}

/** One decompilation under way; concurrent identical requests wait on it instead of queueing a second run. */
interface InFlightRun {
  key: string;
  promise: Promise<DecompileOutcome>;
  /** Aborts the worker call once every waiter has given up. */
  abort: AbortController;
  waiters: number;
}

export class DecompilerService {
  readonly host: WorkerHost;
  readonly cache: DecompileCache;
  private readonly config: ServerConfig;
  private readonly inFlight = new Map<string, InFlightRun>();
  private index: CatalogueIndex | null = null;
  private indexGeneration = -1;
  private indexPromise: Promise<CatalogueIndex> | null = null;

  constructor(config: ServerConfig, options: DecompilerServiceOptions = {}) {
    this.config = config;
    this.cache = options.cache ?? new DecompileCache();
    this.host = new WorkerHost({
      entry: options.entry ?? resolveWorkerEntry("decompiler.worker"),
      name: "decompiler",
      defaultTimeoutMs: config.decompileTimeoutMs,
      // dehosk cannot be interrupted from inside: the stop flag only delays the kill.
      hardKillGraceMs: 250,
      // The hex is capped separately (4 MB); this covers hex + options JSON.
      maxInputBytes: config.maxDecompileInputBytes + 64 * 1024,
      readyTimeoutMs: config.workerReadyTimeoutMs,
      serial: true,
      autoRespawn: true,
      resourceLimits: { maxOldGenerationSizeMb: config.workerMaxOldGenerationMb },
      onRespawn: options.onRespawn,
    });
  }

  /** Spawn the worker, load the wasm and parse the catalogue. */
  async warm(): Promise<CatalogueIndex> {
    return this.catalogueIndex();
  }

  dispose(): Promise<void> {
    return this.host.dispose();
  }

  /** Provenance + live counters for `cardano-debug://server/info`. */
  get info(): Record<string, unknown> {
    const stats = this.host.stats();
    return {
      status: stats.ready ? "ready" : stats.alive ? "loading" : "cold",
      ...(stats.workerInfo ?? {}),
      generation: stats.generation,
      total_calls: stats.totalCalls,
      total_respawns: stats.totalRespawns,
      ...(stats.lastLoss ? { last_loss: { reason: stats.lastLoss.reason, detail: stats.lastLoss.detail } } : {}),
      cached_texts: this.cache.size,
      cached_chars: this.cache.chars,
    };
  }

  /** The catalogue index for the current worker generation (re-read after a respawn). */
  async catalogueIndex(): Promise<CatalogueIndex> {
    if (this.index && this.indexGeneration === this.host.currentGeneration && this.host.alive) return this.index;
    if (this.indexPromise) return this.indexPromise;
    this.indexPromise = (async () => {
      try {
        await this.host.warm();
        const generation = this.host.currentGeneration;
        const text = await this.host.call<string>("catalogue", [], { timeoutMs: this.config.libCallTimeoutMs });
        const index = new CatalogueIndex(parseCatalogue(text));
        this.index = index;
        this.indexGeneration = generation;
        return index;
      } finally {
        this.indexPromise = null;
      }
    })();
    return this.indexPromise;
  }

  /** Build the wire options for a request (validates names/tokens against the catalogue). Throws `OptionsError`. */
  async buildOptions(request: Pick<DecompileRequest, "view" | "scriptVersion" | "purpose" | "user">): Promise<BuiltOptions> {
    const index = await this.catalogueIndex();
    return buildDecompileOptions(index, { view: request.view, scriptVersion: request.scriptVersion, purpose: request.purpose, user: request.user });
  }

  /**
   * Decompile with cache + failure markers. Option errors throw `OptionsError`; input errors from
   * the decompiler ("Failed to decode UPLC…") come back as `decompile_error`; timeouts / traps /
   * worker loss set a marker and come back as `decompile_failed` (and so do later identical calls
   * until the marker expires or `refresh` is passed).
   *
   * The host queue is serial and the cache is only read before a call is queued, so two parallel
   * requests for the same (script, options) would each run dehosk (and a script that times out would
   * burn its budget twice). Identical requests therefore share one in-flight run; a joiner's outcome
   * says `cached: true` (the text was produced by the call it waited for).
   */
  async decompile(request: DecompileRequest): Promise<DecompileOutcome> {
    const options = await this.buildOptions(request);
    const scriptHash = request.scriptHash.toLowerCase();
    if (!request.refresh) {
      const hit = this.cache.get(scriptHash, options.hash);
      if (hit) return { ok: true, entry: hit, cached: true, options };
      const marker = this.cache.failure(scriptHash, options.layer);
      if (marker && marker.optionsHash === options.hash) return { ok: false, code: "decompile_failed", marker, options };
    } else {
      this.cache.clearFailure(scriptHash, options.layer);
    }
    if (request.scriptHex.length > this.config.maxDecompileInputBytes) {
      return {
        ok: false,
        code: "decompile_error",
        message: `The script hex is ${request.scriptHex.length} characters, over the decompiler's ${this.config.maxDecompileInputBytes} limit.`,
        options,
      };
    }
    if (request.signal?.aborted) throw new WorkerAbortedError();
    // No await between the cache read above and the registration below: a second caller either
    // sees the cache entry / marker or this run.
    const key = `${scriptHash}:${options.hash}`;
    const running = this.inFlight.get(key);
    if (running) {
      const outcome = await this.join(running, request.signal);
      return outcome.ok ? { ...outcome, cached: true } : outcome;
    }
    const run: InFlightRun = { key, abort: new AbortController(), waiters: 0, promise: undefined as unknown as Promise<DecompileOutcome> };
    run.promise = this.runDecompile(request, scriptHash, options, run.abort.signal).finally(() => {
      if (this.inFlight.get(key) === run) this.inFlight.delete(key);
    });
    // Waiters handle the rejection; this keeps a run nobody waits on any more from being unhandled.
    run.promise.catch(() => undefined);
    this.inFlight.set(key, run);
    return this.join(run, request.signal);
  }

  /** Wait for a run; the caller's own abort detaches it, and the last one to leave aborts the worker call. */
  private join(run: InFlightRun, signal: AbortSignal | undefined): Promise<DecompileOutcome> {
    run.waiters++;
    return new Promise<DecompileOutcome>((resolve, reject) => {
      let done = false;
      const finish = (): void => {
        done = true;
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (done) return;
        finish();
        if (--run.waiters === 0) {
          if (this.inFlight.get(run.key) === run) this.inFlight.delete(run.key);
          run.abort.abort();
        }
        reject(new WorkerAbortedError());
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      run.promise.then(
        (outcome) => {
          if (done) return;
          finish();
          resolve(outcome);
        },
        (error) => {
          if (done) return;
          finish();
          reject(error);
        },
      );
    });
  }

  private async runDecompile(request: DecompileRequest, scriptHash: string, options: BuiltOptions, signal: AbortSignal): Promise<DecompileOutcome> {
    try {
      const answer = await this.host.call<{ text: string; elapsed_ms: number }>("decompile", [request.scriptHex, options.json], {
        timeoutMs: request.timeoutMs ?? this.config.decompileTimeoutMs,
        signal,
        inputSubject: "The script",
      });
      const { notes, headerLines } = extractNotes(answer.text);
      const entry = this.cache.put({
        scriptHash,
        optionsHash: options.hash,
        layer: options.layer,
        optionsJson: options.json,
        text: answer.text,
        notes,
        headerLines,
        elapsedMs: answer.elapsed_ms,
        versionToken: options.versionToken,
        purposeToken: options.purposeToken,
      });
      return { ok: true, entry, cached: false, options };
    } catch (error) {
      if (error instanceof OptionsError) throw error;
      if (isStructuralFailure(error)) {
        const code = error instanceof WorkerTimeoutError ? "timeout" : error instanceof WorkerCallError ? "wasm_trap" : "worker_unavailable";
        const marker = this.cache.markFailure({
          scriptHash,
          layer: options.layer,
          optionsHash: options.hash,
          code,
          message: error instanceof Error ? error.message : String(error),
        });
        return { ok: false, code: "decompile_failed", marker, options };
      }
      if (error instanceof WorkerCallError) {
        return { ok: false, code: "decompile_error", message: error.message, options };
      }
      throw error;
    }
  }
}

/** Resource part -> cached output layer. */
const LAYER_OF_PART: Partial<Record<ScriptArtifactPart, string>> = {
  "pseudocode.txt": layerOfView("pseudocode"),
  "uplc.txt": layerOfView("uplc"),
  "uplc_canonical.txt": layerOfView("uplc_canonical"),
};

/** The process-wide service, created on first use and disposed at shutdown. */
export function getDecompilerService(ctx: AppContext): DecompilerService {
  const existing = ctx.services.decompiler;
  if (existing) return existing;
  const service = new DecompilerService(ctx.config, {
    onRespawn: (info) => {
      if (info.reason !== "manual") console.error(`[cardano-debug] decompiler worker lost (${info.reason}): ${info.detail ?? ""}${info.newGeneration >= 0 ? "; respawning" : ""}`);
    },
  });
  ctx.services.decompiler = service;
  // Serve script/{hash}/{pseudocode,uplc,uplc_canonical}.txt through the base resource routes
  // (which add ?offset=&limit= windows) from the text cache; unknown parts fall back to the defaults.
  providersOf(ctx).register({
    scriptArtifact: (scriptHash, part) => {
      const layer = LAYER_OF_PART[part];
      if (!layer) return undefined;
      const entry = service.cache.latestFor(scriptHash.toLowerCase(), layer);
      return entry ? { text: entry.text, mimeType: "text/plain", ...(part === "pseudocode.txt" ? {} : { listing: true }) } : undefined;
    },
  });
  Object.defineProperty(ctx.services, "decompilerInfo", {
    configurable: true,
    enumerable: true,
    get: () => service.info,
  });
  ctx.onShutdown(() => service.dispose());
  return service;
}
