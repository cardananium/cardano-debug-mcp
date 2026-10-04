// Reusable e2e harness: spawns the server over stdio (dist/server.js or `tsx src/server.ts`),
// performs the legacy `initialize` handshake and offers typed helpers for tools, resources and
// prompts. Raw JSON-RPC (newline-delimited) on purpose: the tests then exercise exactly what a
// stdio host sees, including the "stdout carries only JSON-RPC" invariant.
//
//   const client = await McpTestClient.start();               // dist, current node
//   const client = await McpTestClient.start({ mode: "dev" }); // tsx src/server.ts
//   const { tools } = await client.listTools();
//   const result = await client.callTool("cbor_decode", { hex: "d8799f41aa02ff" });
//   const text = await client.readResourceText("cardano-debug://server/info");
//   await client.close();
//
// Every call has a 60 s default timeout (override per call). `client.stderr` collects the server's
// stderr; `client.nonJsonStdout` must stay empty.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DIST_SERVER = path.join(PROJECT_ROOT, "dist", "server.js");
export const SRC_SERVER = path.join(PROJECT_ROOT, "src", "server.ts");
export const TSX_BIN = path.join(PROJECT_ROOT, "node_modules", ".bin", "tsx");
export const FIXTURES_DIR = path.join(PROJECT_ROOT, "test", "fixtures");
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** Path of the Node 20 binary of the compatibility variant: `CARDANO_DEBUG_E2E_NODE20`, else the nvm install. */
export const NODE20_BIN = process.env.CARDANO_DEBUG_E2E_NODE20 || path.join(process.env.HOME ?? "", ".nvm/versions/node/v20.14.0/bin/node");
export const hasNode20 = (): boolean => existsSync(NODE20_BIN);

/**
 * The environment a spawned server gets: a whitelist of the host's (PATH, HOME, TMPDIR, NODE_*, LANG, LC_*) plus
 * `extra`. KOIOS_*, BLOCKFROST_* and CARDANO_DEBUG_* of the developer's shell never reach the server, so a test
 * does not depend on exported keys, an offline switch or a cache the shell points at.
 */
export function serverEnv(extra: NodeJS.ProcessEnv = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && /^(PATH|HOME|TMPDIR|LANG|NODE_.*|LC_.*)$/.test(key)) kept[key] = value;
  }
  return { ...kept, ...extra };
}

let defaultCacheDir: string | undefined;
/** One scratch cache per test process for servers that do not name their own (never the developer's real cache). */
function scratchCacheDir(): string {
  defaultCacheDir ??= mkdtempSync(path.join(os.tmpdir(), "cdm-e2e-default-"));
  return defaultCacheDir;
}

let staleChecked = false;
/** One stderr note when dist/server.js is older than a source file: e2e tests run whatever dist exists. */
function warnWhenDistIsStale(): void {
  if (staleChecked) return;
  staleChecked = true;
  try {
    const built = statSync(DIST_SERVER).mtimeMs;
    let newest = { file: "", mtime: 0 };
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|md|json|cddl)$/.test(entry.name)) {
          const mtime = statSync(full).mtimeMs;
          if (mtime > newest.mtime) newest = { file: full, mtime };
        }
      }
    };
    walk(path.join(PROJECT_ROOT, "src"));
    if (newest.mtime > built) console.warn(`[e2e] warning: dist/server.js is older than ${path.relative(PROJECT_ROOT, newest.file)}; run \`npm run build\` (\`npm run test:e2e\` does) or these tests exercise old code`);
  } catch {
    // best effort
  }
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcRemoteError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(error: JsonRpcError, method: string) {
    super(`${method} failed (${error.code}): ${error.message}`);
    this.name = "JsonRpcRemoteError";
    this.code = error.code;
    this.data = error.data;
  }
}

export interface InitializeResult {
  protocolVersion: string;
  serverInfo: { name: string; version: string; title?: string };
  instructions?: string;
  capabilities: Record<string, unknown>;
}

export interface ToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[]; anyOf?: unknown; oneOf?: unknown; [k: string]: unknown };
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface ContentBlock {
  type: string;
  text?: string;
  uri?: string;
  name?: string;
  mimeType?: string;
  [k: string]: unknown;
}

export interface ToolCallResult<T = Record<string, unknown>> {
  content: ContentBlock[];
  structuredContent?: T;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
}

export interface ReadResourceResult {
  contents: ResourceContent[];
}

export interface ResourceTemplateInfo {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface PromptInfo {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface GetPromptResult {
  description?: string;
  messages: Array<{ role: string; content: { type: string; text?: string } }>;
}

export interface McpTestClientOptions {
  /** `dist` runs dist/server.js (default); `dev` runs `tsx src/server.ts` (needs Node >= 22). */
  mode?: "dist" | "dev";
  /** Node binary for `dist` mode (default: the current process's). */
  nodeBin?: string;
  /** Server script of `dist` mode (default: dist/server.js of this checkout; a packaging test points at a copy). */
  serverPath?: string;
  /** Extra command line arguments after the script. */
  args?: string[];
  /** Working directory of the server process (default: the test process's). */
  cwd?: string;
  /** Extra environment for the server process (over the whitelist of `serverEnv`; the host's KOIOS_* / BLOCKFROST_* / CARDANO_DEBUG_* are dropped). */
  env?: NodeJS.ProcessEnv;
  /** Default per-call timeout. */
  callTimeoutMs?: number;
  /** Client identity sent in `initialize`. */
  clientInfo?: { name: string; version: string };
  /** Protocol version requested in `initialize` (legacy handshake). */
  protocolVersion?: string;
  /** Skip the handshake (call `initialize()` yourself). */
  skipInitialize?: boolean;
}

export class McpTestClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly options: Required<Pick<McpTestClientOptions, "callTimeoutMs" | "protocolVersion" | "clientInfo">> & McpTestClientOptions;
  /** Server stderr chunks (logs). */
  readonly stderr: string[] = [];
  /** Server notifications (`notifications/*`) in arrival order. */
  readonly notifications: Array<{ method: string; params?: unknown }> = [];
  /** Any stdout line that was not JSON — must stay empty. */
  readonly nonJsonStdout: string[] = [];
  /** `initialize` answer once the handshake ran. */
  initializeResult: InitializeResult | undefined;
  exitCode: number | null | undefined;

  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, { method: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private exited: Promise<number | null>;

  constructor(options: McpTestClientOptions = {}) {
    this.options = {
      ...options,
      callTimeoutMs: options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      protocolVersion: options.protocolVersion ?? "2025-06-18",
      clientInfo: options.clientInfo ?? { name: "cardano-debug-e2e", version: "0.0.0" },
    };
    const mode = options.mode ?? "dist";
    const serverPath = options.serverPath ?? DIST_SERVER;
    const extra = options.args ?? [];
    const [command, args] = mode === "dev" ? [TSX_BIN, [SRC_SERVER, ...extra]] : [options.nodeBin ?? process.execPath, [serverPath, ...extra]];
    // `node dist/server` (no extension) is a supported way to start the server; accept it here too.
    if (mode === "dist" && !existsSync(serverPath) && !existsSync(`${serverPath}.js`)) throw new Error(`${serverPath} is missing; run \`npm run build\` first`);
    if (mode === "dist" && serverPath === DIST_SERVER) warnWhenDistIsStale();
    const env = serverEnv({ CARDANO_DEBUG_CACHE_DIR: scratchCacheDir(), ...options.env });
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env, cwd: options.cwd });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk: Buffer) => this.stderr.push(chunk.toString("utf8")));
    // A server that exits mid-write (e.g. after an oversized message) makes stdin EPIPE; the exit is what tests observe.
    this.child.stdin.on("error", () => undefined);
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code) => {
        this.exitCode = code;
        for (const [id, entry] of this.pending) {
          this.pending.delete(id);
          entry.reject(new Error(`${entry.method}: server exited with code ${code} before answering; stderr:\n${this.stderrText()}`));
        }
        resolve(code);
      });
    });
  }

  /** Spawn and (unless `skipInitialize`) complete the handshake. */
  static async start(options: McpTestClientOptions = {}): Promise<McpTestClient> {
    const client = new McpTestClient(options);
    if (!options.skipInitialize) await client.initialize();
    return client;
  }

  stderrText(): string {
    return this.stderr.join("");
  }

  private onData(text: string): void {
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let message: { id?: number; result?: unknown; error?: JsonRpcError; method?: string; params?: unknown };
      try {
        message = JSON.parse(line);
      } catch {
        this.nonJsonStdout.push(line);
        continue;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new JsonRpcRemoteError(message.error, entry.method));
        else entry.resolve(message.result);
      } else if (message.method) {
        this.notifications.push({ method: message.method, params: message.params });
      }
    }
  }

  /** Raw JSON-RPC request. */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs: number = this.options.callTimeoutMs): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms; stderr:\n${this.stderrText()}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** Raw JSON-RPC notification. */
  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  /** Legacy handshake: `initialize` request + `notifications/initialized`. */
  async initialize(): Promise<InitializeResult> {
    const result = await this.request<InitializeResult>("initialize", {
      protocolVersion: this.options.protocolVersion,
      capabilities: {},
      clientInfo: this.options.clientInfo,
    });
    this.notify("notifications/initialized");
    this.initializeResult = result;
    return result;
  }

  ping(timeoutMs?: number): Promise<Record<string, never>> {
    return this.request("ping", {}, timeoutMs);
  }

  async listTools(): Promise<{ tools: ToolInfo[] }> {
    return this.request<{ tools: ToolInfo[] }>("tools/list");
  }

  /** `tools/call`; protocol errors reject, tool-level failures resolve with `isError: true`. */
  callTool<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<ToolCallResult<T>> {
    return this.request<ToolCallResult<T>>("tools/call", { name, arguments: args }, timeoutMs);
  }

  /** `tools/call` that must succeed; returns the structured content (and asserts text == structured). */
  async callToolOk<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const result = await this.callTool<T>(name, args, timeoutMs);
    if (result.isError) throw new Error(`${name} answered isError: ${result.content[0]?.text ?? JSON.stringify(result.structuredContent)}`);
    const text = result.content.find((c) => c.type === "text")?.text;
    if (text !== undefined && result.structuredContent !== undefined) {
      const parsed = JSON.parse(text) as unknown;
      if (JSON.stringify(parsed) !== JSON.stringify(result.structuredContent)) throw new Error(`${name}: text content differs from structuredContent`);
    }
    return result.structuredContent as T;
  }

  listResources(): Promise<{ resources: Array<{ uri: string; name: string; title?: string; description?: string; mimeType?: string }> }> {
    return this.request("resources/list");
  }

  listResourceTemplates(): Promise<{ resourceTemplates: ResourceTemplateInfo[] }> {
    return this.request("resources/templates/list");
  }

  /** `resources/read`; an unknown URI rejects with `JsonRpcRemoteError` (code -32602). */
  readResource(uri: string, timeoutMs?: number): Promise<ReadResourceResult> {
    return this.request<ReadResourceResult>("resources/read", { uri }, timeoutMs);
  }

  /** Text of the first content block of a resource. */
  async readResourceText(uri: string, timeoutMs?: number): Promise<string> {
    const result = await this.readResource(uri, timeoutMs);
    const first = result.contents[0];
    if (!first || typeof first.text !== "string") throw new Error(`${uri}: no text content`);
    return first.text;
  }

  /** JSON-parsed text of a resource. */
  async readResourceJson<T = unknown>(uri: string, timeoutMs?: number): Promise<T> {
    return JSON.parse(await this.readResourceText(uri, timeoutMs)) as T;
  }

  listPrompts(): Promise<{ prompts: PromptInfo[] }> {
    return this.request("prompts/list");
  }

  getPrompt(name: string, args: Record<string, string> = {}): Promise<GetPromptResult> {
    return this.request<GetPromptResult>("prompts/get", { name, arguments: args });
  }

  /** Wait for the server to exit on its own; undefined when it is still running after `timeoutMs`. */
  async waitForExit(timeoutMs: number): Promise<number | null | undefined> {
    if (this.exitCode !== undefined) return this.exitCode;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    });
    const code = await Promise.race([this.exited, timeout]);
    clearTimeout(timer);
    return code;
  }

  /** Write raw bytes to the server's stdin (oversized / malformed messages). */
  writeRaw(text: string): void {
    this.child.stdin.write(text);
  }

  /** Close stdin (the server exits on stdin end) and wait for the exit code; SIGKILL after 5 s. */
  async close(graceMs = 5_000): Promise<number | null> {
    if (this.exitCode !== undefined) return this.exitCode;
    this.child.stdin.end();
    const killer = setTimeout(() => this.child.kill("SIGKILL"), graceMs);
    const code = await this.exited;
    clearTimeout(killer);
    return code;
  }
}

/**
 * Server variants for `describe.each`: dist on the current node, dist on Node 20 when installed, dev (tsx)
 * when `CARDANO_DEBUG_E2E_DEV=1`. `env` is passed to every server (e.g. an isolated CARDANO_DEBUG_CACHE_DIR,
 * so expectations about "not yet fetched" resources do not depend on the user's disk cache).
 */
let node20Noted = false;
export function serverVariants(options: { env?: NodeJS.ProcessEnv } = {}): Array<{ label: string; start: () => Promise<McpTestClient> }> {
  const env = options.env;
  const variants: Array<{ label: string; start: () => Promise<McpTestClient> }> = [
    { label: `dist (node ${process.version})`, start: () => McpTestClient.start({ env }) },
  ];
  if (hasNode20()) variants.push({ label: "dist (node v20.14.0)", start: () => McpTestClient.start({ nodeBin: NODE20_BIN, env }) });
  else if (!node20Noted) {
    node20Noted = true;
    console.warn(`[e2e] the Node 20 variant is skipped: ${NODE20_BIN} does not exist (install Node 20.14.0 with nvm or point CARDANO_DEBUG_E2E_NODE20 at a Node 20 binary)`);
  }
  if (process.env.CARDANO_DEBUG_E2E_DEV === "1") variants.push({ label: "dev (tsx)", start: () => McpTestClient.start({ mode: "dev", env }) });
  return variants;
}
