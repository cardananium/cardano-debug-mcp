#!/usr/bin/env node
// cardano-debug MCP server: factory + stdio entry.
//
// `buildServer(ctx)` registers every tool module in src/tools/index.ts, the resources and prompts
// on a fresh McpServer. `serveStdio` calls it once per connection (stdio = once per process); all
// state lives in the AppContext, which is process-wide.
//
// Logging: stderr only. stdout is the JSON-RPC channel (main() points console.log / info / debug at stderr).
// Command line: `--check`, `--version`, `--help` (src/cli.ts); no option serves MCP over stdio.

import { realpathSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { McpServer, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { buildInfo, describeBuild } from "./buildInfo.js";
import { helpText, parseCliArgs, runCheck, versionText } from "./cli.js";
import { loadConfig } from "./config.js";
import { createAppContext, type AppContext } from "./context.js";
import { checkBuildFiles, incompleteBuildMessage } from "./preflight.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources.js";
import { registerAllTools } from "./tools/index.js";
import { packageVersion } from "./wasm-assets.js";

export { createAppContext } from "./context.js";
export type { AppContext, ToolModule } from "./context.js";

export const SERVER_NAME = "cardano-debug";

/** After the host closes stdin: how long calls still running may take to answer before the process exits. */
export const STDIN_DRAIN_MS = 5_000;
/** Once shutdown started: after this long the process exits even if a worker did not stop. */
export const FORCE_EXIT_MS = 5_000;

// Routing primer for the model, most important first: which tool when, which doc to read. Hosts cut
// server instructions (Claude Code keeps the first 2048 characters); this one stays within 1,600
// (test/unit/modelTexts.test.ts). Facts live in the docs (src/docs, docs tool, cardano-debug://docs).
export const SERVER_INSTRUCTIONS = [
  "cardano-debug: inspect, validate and step-debug Cardano transactions and Plutus scripts.",
  "Why a tx fails: tx_load (tx_cbor | tx_hash | bundle; keep tx_id) -> tx_validate -> tx_redeemer (part='error', 'traces') -> script_decompile(tx_id, script_hash) FIRST to read the logic -> debug_open(tx_id, redeemer) -> debug_run(until='error', stop_before=true) -> debug_inspect / debug_source.",
  "tx_inspect = what a tx does; tx_add_witnesses = sign and revalidate; bundle_export = offline replay.",
  "Once you know why a tx, script or bytes fail, explain it, then offer to show the spot in cquisitor / de-uplc-web (the user may not know they exist; failing answers carry `show_it`). On yes: ui_link(open=true), then only where to look, not what the app shows. For someone else, give the URL. Read docs(topic='debug-playbook', section='show-it-in-a-ui') first.",
  "Bytes: cbor_decode(hex) = what they are; cbor_validate(hex, cddl=<era preset | schema>, rule?) = where they break a schema; cddl_check = is a schema usable.",
  "A script alone: script_decompile(script), debug_open(script, …), script_locate.",
  "Read docs before guessing: docs(error=<Name>) for an error name; debug-playbook (procedure, handles, {term_id, uplc_line}), tx-anatomy (fees, collateral, datums, redeemer refs <purpose>:<index>), script-context (script arguments, TxInfo), uplc-cek (machine, builtins), cbor-cddl (bytes, schemas), tools (a tool's details: docs(topic='tools', section=<tool name>)).",
  "expired_handle: re-run the tool in recreate_with. Integers are decimal strings.",
  "Page (offset/limit), zoom (path/depth), read cardano-debug:// resources.",
].join(" ");

/** Build a server bound to `ctx`. Cheap and side-effect free (serveStdio may call it twice). */
export function buildServer(ctx: AppContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: packageVersion(), title: "Cardano transaction & Plutus debugger" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerAllTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server, ctx);
  return server;
}

interface StdioStreams {
  stdin?: Readable;
  stdout?: Writable;
}

/**
 * The SDK's stdio transport with the lifecycle this server needs.
 *
 * - It reports when it closes. The transport closes itself on a fatal read error (a message over
 *   `maxBufferSize`, stdout gone) and then pauses stdin, so stdin's "end" never fires: without this hook the
 *   process would linger, answering nothing.
 * - It does NOT close itself when stdin ends (the SDK default aborts calls in flight, so a client that
 *   piped its requests and closed stdin got only the first answers). `onInputEnd` fires instead, and
 *   `whenIdle` resolves once every request received so far was answered.
 */
export class ReportingStdioTransport extends StdioServerTransport {
  private readonly inFlight = new Set<string | number>();
  private idleWaiters: Array<(idle: boolean) => void> = [];
  private inputEnded = false;

  constructor(
    private readonly onClosed: () => void,
    maxBufferSize: number,
    private readonly onInputEnd: () => void,
    streams: StdioStreams = {},
  ) {
    super(streams.stdin ?? process.stdin, streams.stdout ?? process.stdout, { maxBufferSize });
    // The base class registers this as the listener of stdin's "end" / "close" and closes there; ours waits instead.
    this._onstdinclose = () => {
      if (this.inputEnded) return;
      this.inputEnded = true;
      this.onInputEnd();
    };
    // Count requests as they arrive (the SDK assigns `onmessage` after construction).
    let handler: ((message: JSONRPCMessage, ...rest: unknown[]) => void) | undefined;
    Object.defineProperty(this, "onmessage", {
      configurable: true,
      enumerable: true,
      get: () => handler,
      set: (next: typeof handler) => {
        handler = next
          ? (message, ...rest) => {
              this.track(message);
              next(message, ...rest);
            }
          : undefined;
      },
    });
  }

  private track(message: JSONRPCMessage): void {
    const m = message as { id?: string | number | null; method?: string; params?: { requestId?: string | number } };
    if (typeof m.method === "string" && m.id !== undefined && m.id !== null) this.inFlight.add(m.id);
    else if (m.method === "notifications/cancelled" && m.params?.requestId !== undefined) this.settle(m.params.requestId);
  }

  private settle(id: string | number): void {
    this.inFlight.delete(id);
    if (this.inFlight.size > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const wake of waiters) wake(true);
  }

  /** Requests received and not yet answered. */
  get pendingRequests(): number {
    return this.inFlight.size;
  }

  /** Resolves true when no request is waiting for its answer, false when `timeoutMs` ran out first. */
  whenIdle(timeoutMs: number): Promise<boolean> {
    if (this.inFlight.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const wake = (idle: boolean) => {
        clearTimeout(timer);
        resolve(idle);
      };
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((waiter) => waiter !== wake);
        resolve(false);
      }, timeoutMs);
      this.idleWaiters.push(wake);
    });
  }

  override async send(message: JSONRPCMessage): Promise<void> {
    try {
      await super.send(message);
    } finally {
      const m = message as { id?: string | number | null; method?: string; result?: unknown; error?: unknown };
      if (m.method === undefined && m.id !== undefined && m.id !== null && ("result" in m || "error" in m)) this.settle(m.id);
    }
  }

  override async close(): Promise<void> {
    await super.close();
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const wake of waiters) wake(false);
    this.onClosed();
  }
}

/** stdout carries only JSON-RPC: a stray console.log / info / debug (ours or a dependency's) goes to stderr instead. */
export function guardStdout(target: Pick<Console, "log" | "info" | "debug" | "error"> = console): void {
  const toStderr = (...args: unknown[]) => target.error(...args);
  target.log = toStderr;
  target.info = toStderr;
  target.debug = toStderr;
}

/** Start serving stdio with a fresh process-wide context. Returns the handle and the context. */
export function main(): { ctx: AppContext; close: () => Promise<void> } {
  guardStdout();
  const config = loadConfig();
  const files = checkBuildFiles();
  const incomplete = incompleteBuildMessage(files);
  if (incomplete) {
    // One clear line instead of a cryptic failure later; without the lib worker no tool can work.
    if (files.some((file) => file.critical && !file.ok)) throw new StartupError(incomplete);
    console.error(`[cardano-debug] warn: ${incomplete}`);
  }
  const ctx = createAppContext({ config });
  let closing: Promise<void> | null = null;
  let requested = false;
  let exiting = false;
  let exitCode = 0;
  const flushStdout = () =>
    Promise.race([new Promise<void>((resolve) => process.stdout.write("", () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref())]);
  const exit = (code: number) => {
    exitCode = Math.max(exitCode, code);
    if (exiting) return;
    exiting = true;
    // A worker that does not stop must not keep the process (and the host's idea of a live server) around.
    setTimeout(() => {
      console.error("[cardano-debug] shutdown did not finish in time; forcing exit");
      process.exit(exitCode);
    }, FORCE_EXIT_MS).unref();
    void close()
      .then(flushStdout)
      .catch(() => undefined)
      .finally(() => process.exit(exitCode));
  };
  const transport: ReportingStdioTransport = new ReportingStdioTransport(
    () => {
      if (requested) return;
      // Not asked for: a fatal transport error (oversized message, broken stdout). Die loudly.
      console.error("[cardano-debug] the stdio transport closed after a fatal error; exiting so the host sees a dead server");
      exit(1);
    },
    config.maxMessageBytes,
    () => {
      // The host closed our stdin: the connection is over, but calls it already sent still get their answers.
      void transport.whenIdle(STDIN_DRAIN_MS).then((drained) => {
        if (!drained) console.error(`[cardano-debug] stdin closed while ${transport.pendingRequests} call(s) were still running; exiting after ${STDIN_DRAIN_MS} ms`);
        exit(0);
      });
    },
  );
  const handle = serveStdio(() => buildServer(ctx), {
    transport,
    onerror: (error) => console.error("[cardano-debug] transport error:", error),
  });
  // Warm the library worker in the background; tools are already registered.
  ctx.lib.warm().then(
    () => console.error(`[cardano-debug] v${packageVersion()} ready on stdio (node ${process.version}; ${describeBuild(buildInfo())}); cquisitor-lib ${String((ctx.lib.info as { version?: string } | undefined)?.version ?? "loaded")}`),
    (error) => {
      // A shutdown during warm-up disposes the worker under it: that is not a failure.
      if (requested) return;
      console.error("[cardano-debug] lib worker failed to warm:", error instanceof Error ? error.message : error);
    },
  );
  const close = () => {
    requested = true;
    if (!closing) {
      closing = (async () => {
        await handle.close().catch(() => undefined);
        await ctx.shutdown();
      })();
    }
    return closing;
  };
  const onSignal = (signal: NodeJS.Signals) => {
    console.error(`[cardano-debug] ${signal}: shutting down`);
    exit(0);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  // Nothing may leave the process through an unhandled error without the workers being stopped first.
  const fatal = (kind: string, error: unknown) => {
    console.error(`[cardano-debug] ${kind}:`, error instanceof Error ? (error.stack ?? error.message) : error);
    // Already shutting down on request (a signal, stdin closed): a stray rejection must not turn that into a failure.
    if (!requested) exit(1);
  };
  process.on("uncaughtException", (error) => fatal("uncaught exception", error));
  process.on("unhandledRejection", (reason) => fatal("unhandled rejection", reason));
  // Test hook (CARDANO_DEBUG_TEST_HOOKS=1 only): raise one of those errors shortly after start-up.
  const crash = process.env.CARDANO_DEBUG_TEST_HOOKS === "1" ? process.env.CARDANO_DEBUG_TEST_CRASH : undefined;
  if (crash === "rejection") setTimeout(() => void Promise.reject(new Error("test hook: unhandled rejection")), 300).unref();
  if (crash === "exception") {
    setTimeout(() => {
      throw new Error("test hook: uncaught exception");
    }, 300).unref();
  }
  return { ctx, close };
}

/** A start-up failure whose message already says what to do (no stack trace needed). */
export class StartupError extends Error {
  override name = "StartupError";
}

/** `main()` with a hint: a failure to start says why on stderr and exits non-zero instead of leaving a silent process. */
export function startServer(): void {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[cardano-debug] failed to start: ${message}`);
    if (!(error instanceof StartupError)) {
      if (/not found|ENOENT|Cannot find module|ERR_MODULE_NOT_FOUND/i.test(message)) console.error('[cardano-debug] a build file is missing: in the repository run "npm run build:deps && npm run build", then restart the server');
      else if (error instanceof Error && error.stack) console.error(error.stack);
    }
    process.exit(1);
  }
}

/** Is this module the process's entry? Tolerates a script path without its extension (`node dist/server`) and symlinks. */
export function isMainModule(entry: string | undefined = process.argv[1], selfUrl: string = import.meta.url): boolean {
  if (!entry) return false;
  let self: string;
  try {
    self = realpathSync(fileURLToPath(selfUrl));
  } catch {
    return false;
  }
  return entryCandidates(entry).some((candidate) => {
    try {
      return realpathSync(candidate) === self;
    } catch {
      return false;
    }
  });
}

const entryCandidates = (entry: string): string[] => [entry, `${entry}.js`, `${entry}.mjs`, `${entry}.cjs`];

function existsAsFile(candidate: string): boolean {
  try {
    realpathSync(candidate);
    return true;
  } catch {
    return false;
  }
}

/** `--version`, `--help`, `--check` print to stdout and exit; no option starts the server. */
export async function runCli(argv: readonly string[]): Promise<void> {
  const command = parseCliArgs(argv);
  const finish = (text: string, code: number) => process.stdout.write(text, () => process.exit(code));
  switch (command.kind) {
    case "serve":
      startServer();
      return;
    case "version":
      finish(versionText(), 0);
      return;
    case "help":
      finish(helpText(), 0);
      return;
    case "check": {
      const { text, code } = await runCheck();
      finish(text, code);
      return;
    }
    case "error":
      process.stderr.write(`cardano-debug-mcp: ${command.message}\n\n${helpText()}`, () => process.exit(2));
      return;
  }
}

if (isMainModule()) {
  void runCli(process.argv.slice(2));
} else if (process.argv[1] && !entryCandidates(process.argv[1]).some((candidate) => existsAsFile(candidate))) {
  // Started as the entry but the path does not resolve to a file: say so instead of exiting silently.
  console.error(`[cardano-debug] not started: process.argv[1] (${process.argv[1]}) does not resolve to this file; run "node dist/server.js"`);
}

