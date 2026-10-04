// Shared set-up of the chain-service unit tests: a real in-process library behind a call counter, an
// AppContext around it, a temp cache directory and a stub HTTP provider on 127.0.0.1 (port 0).
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LibApi, type LibClient, type LibFunction, type LibRawCallOptions } from "../../../src/lib.js";
import { loadConfig } from "../../../src/config.js";
import type { AppContext } from "../../../src/context.js";
import { TxStore } from "../../../src/store/txStore.js";
import { fixturePath, fxStr } from "../../helpers/fixtures.js";
import { inProcessLib } from "../../helpers/inProcessLib.js";

export const FIXTURES = fileURLToPath(new URL("../../fixtures", import.meta.url));
/** The artificial S1 sample: a DebuggerContext of the hub transaction (manifest keys `s01.*`). */
export const SAMPLE_CONTEXT = fixturePath(fxStr("s01.contextFile"));
export const SAMPLE_TX = (JSON.parse(readFileSync(SAMPLE_CONTEXT, "utf8")) as { transaction: string }).transaction;
export const SAMPLE_HASH = fxStr("s01.txHash");
export const SAMPLE_ID = fxStr("s01.txId");

export function tempDir(label = "cdm-chain-"): string {
  return mkdtempSync(path.join(os.tmpdir(), label));
}

/** The in-process library, counting calls per wasm function; `before` may delay or fail a call. */
export class CountingLib extends LibApi {
  readonly calls: Record<string, number> = {};
  before: ((fn: LibFunction, count: number, options: LibRawCallOptions) => Promise<void> | void) | undefined;
  override async callRaw<T = unknown>(fn: LibFunction, args: unknown[], options: LibRawCallOptions = {}): Promise<T> {
    this.calls[fn] = (this.calls[fn] ?? 0) + 1;
    await this.before?.(fn, this.calls[fn]!, options);
    return inProcessLib().callRaw<T>(fn, args, options);
  }
  count(fn: LibFunction): number {
    return this.calls[fn] ?? 0;
  }
}

export interface TestContext {
  ctx: AppContext;
  lib: CountingLib;
  cacheDir: string;
  shutdown(): Promise<void>;
}

/** An AppContext over the counting library; `env` goes to `loadConfig` (cache dir is a fresh temp dir unless given). */
export function makeContext(env: NodeJS.ProcessEnv = {}): TestContext {
  const cacheDir = env.CARDANO_DEBUG_CACHE_DIR ?? tempDir();
  const config = loadConfig({ CARDANO_DEBUG_NO_OPEN: "1", ...env, CARDANO_DEBUG_CACHE_DIR: cacheDir });
  const lib = new CountingLib();
  const hooks: Array<() => void | Promise<void>> = [];
  const ctx: AppContext = {
    config,
    lib: lib as unknown as LibClient,
    txStore: new TxStore(),
    sessions: {} as AppContext["sessions"],
    startedAt: Date.now(),
    services: {} as AppContext["services"],
    onShutdown: (hook) => void hooks.push(hook),
    shutdown: async () => {
      for (const hook of hooks.splice(0).reverse()) await hook();
    },
  };
  return { ctx, lib, cacheDir, shutdown: () => ctx.shutdown() };
}

export interface Stub {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

/** A provider stand-in: `handler` answers each request (body already read into `body`). */
export async function startStub(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<Stub> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      handler(req, res, Buffer.concat(chunks).toString("utf8"));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function json(res: ServerResponse, value: unknown, status = 200, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value));
}
