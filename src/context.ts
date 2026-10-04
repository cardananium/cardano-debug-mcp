// AppContext: the process-wide services every tool, resource and prompt receives. One instance
// lives for the process (serveStdio pins one McpServer per connection; module scope == process).
//
// Extension seam for other layers (chain / engine / decompiler): attach a service under
// `ctx.services.<name>` and, for typing, augment `AppServices`:
//
//   declare module "../context.js" { interface AppServices { chain: ChainService } }
//
// so `ctx.services.chain` is typed without editing this file. Register shutdown work with
// `ctx.onShutdown(fn)`.

import { configure } from "@cardananium/cquisitor-lib";
import { nodeBrotliCompressor } from "@cardananium/cquisitor-lib/node";
import type { McpServer } from "@modelcontextprotocol/server";

import { loadConfig, log, type ServerConfig } from "./config.js";
import { createLibClient, type LibClient } from "./lib.js";
import { SessionRegistry } from "./store/sessionRegistry.js";
import { TxStore } from "./store/txStore.js";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AppServices {}

export interface AppContext {
  config: ServerConfig;
  lib: LibClient;
  txStore: TxStore;
  sessions: SessionRegistry;
  /** Process start (ms epoch). */
  startedAt: number;
  /** Services attached by other layers (see the module comment). */
  services: AppServices & Record<string, unknown>;
  /** Register a hook run by `shutdown()` (in reverse registration order). */
  onShutdown(hook: () => void | Promise<void>): void;
  /** Dispose every worker and stop timers. Idempotent. */
  shutdown(): Promise<void>;
}

/** A file under src/tools that registers one (or more) MCP tools. Listed in src/tools/index.ts. */
export interface ToolModule {
  /** Tool name(s) for logging; the real name is what `register` passes to `server.registerTool`. */
  name: string;
  register(server: McpServer, ctx: AppContext): void;
}

export interface CreateAppContextOptions {
  config?: ServerConfig;
  /** Replace the default lib client (tests). */
  lib?: LibClient;
}

export function createAppContext(options: CreateAppContextOptions = {}): AppContext {
  const config = options.config ?? loadConfig();
  const lib = options.lib ?? createLibClient(config);
  // The library's own services: its wasm calls (fetchValidationData's ref scripts, the Blockfrost
  // client's datum decoding, …) go through the lib worker like the server's own; share-link brotli
  // via node:zlib; its warnings to stderr (stdout is the JSON-RPC channel).
  configure({
    backend: lib,
    compressor: nodeBrotliCompressor,
    logger: { warn: (msg: string, err?: unknown) => (err === undefined ? log.warn(msg) : log.warn(msg, err instanceof Error ? err.message : err)) },
  });
  const txStore = new TxStore({ max: config.txStoreMax, ttlMs: config.txStoreTtlMs });
  const sessions = new SessionRegistry({
    max: config.sessionMax,
    idleTtlMs: config.sessionIdleTtlMs,
    absoluteTtlMs: config.sessionAbsoluteTtlMs,
    sweepIntervalMs: config.sweepIntervalMs,
    onEvict: (record, reason) => {
      if (reason !== "closed") console.error(`[cardano-debug] session ${record.dbgId} closed (${reason})`);
    },
  });
  sessions.startSweeper();
  const txSweeper = setInterval(() => txStore.sweep(), config.sweepIntervalMs);
  txSweeper.unref();

  const hooks: Array<() => void | Promise<void>> = [];
  let shutdownPromise: Promise<void> | null = null;

  const ctx: AppContext = {
    config,
    lib,
    txStore,
    sessions,
    startedAt: Date.now(),
    services: {} as AppServices & Record<string, unknown>,
    onShutdown(hook) {
      hooks.push(hook);
    },
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        clearInterval(txSweeper);
        sessions.closeAll("shutdown");
        for (const hook of hooks.reverse()) {
          try {
            await hook();
          } catch (error) {
            console.error("[cardano-debug] shutdown hook failed:", error);
          }
        }
        await lib.dispose();
      })();
      return shutdownPromise;
    },
  };
  return ctx;
}
