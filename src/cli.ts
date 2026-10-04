// Command line of dist/server.js: `--version`, `--help` and `--check` (prints to stdout, never starts MCP
// mode); anything else starts the stdio server. Kept free of the server module so it can be tested alone.

import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildInfo, describeBuild } from "./buildInfo.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { createLibClient } from "./lib.js";
import { checkBuildFiles, checkTextAssets, type FileCheck } from "./preflight.js";
import { packageVersion, readWasm, type WasmAssetName } from "./wasm-assets.js";

export const MIN_NODE_MAJOR = 20;

export type CliCommand = { kind: "serve" } | { kind: "version" } | { kind: "help" } | { kind: "check" } | { kind: "error"; message: string };

/** `argv` without node and the script. No argument (or the conventional `--stdio` / `stdio`) serves MCP over stdio. */
export function parseCliArgs(argv: readonly string[]): CliCommand {
  const wanted = new Set<CliCommand["kind"]>();
  for (const arg of argv) {
    if (arg === "--stdio" || arg === "stdio") continue;
    if (arg === "--help" || arg === "-h") wanted.add("help");
    else if (arg === "--version" || arg === "-v" || arg === "-V") wanted.add("version");
    else if (arg === "--check") wanted.add("check");
    else return { kind: "error", message: `unknown ${arg.startsWith("-") ? "option" : "argument"} '${arg}'` };
  }
  for (const kind of ["help", "version", "check"] as const) if (wanted.has(kind)) return { kind };
  return { kind: "serve" };
}

export function helpText(): string {
  return [
    "cardano-debug-mcp: MCP server (stdio) to inspect, validate and step-debug Cardano transactions and Plutus scripts.",
    "",
    "Usage: node dist/server.js [option]",
    "  (no option)  serve MCP over stdio: what an MCP client launches",
    "  --check      verify the install (Node, build files, wasm, cache dir, configuration) and exit 0 or 1",
    "  --version    print the version and what the build was made from",
    "  --help       print this text",
    "",
    "Logs go to stderr; stdout carries only JSON-RPC in server mode. Settings are environment variables (see README).",
    "",
  ].join("\n");
}

export function versionText(): string {
  return `cardano-debug-mcp ${packageVersion()} (${describeBuild()})\n`;
}

// ---------- --check ----------

export type CheckStatus = "ok" | "warn" | "fail";
export interface CheckRow {
  status: CheckStatus;
  name: string;
  detail: string;
}

export interface CheckOptions {
  env?: NodeJS.ProcessEnv;
  /** Start the cquisitor-lib worker and report its version (default true; a unit test turns it off). */
  probeLib?: boolean;
  /** How long the lib worker may take to start. */
  libTimeoutMs?: number;
}

const fromFile = (check: FileCheck): CheckRow => ({ status: check.ok ? "ok" : "fail", name: check.name, detail: check.detail });
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Cache directory: created when missing, then a probe file is written and removed. */
export function checkCacheDir(dir: string): CheckRow {
  const probe = path.join(dir, `.check-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    return { status: "ok", name: "cache dir", detail: `${dir} is writable` };
  } catch (error) {
    return { status: "fail", name: "cache dir", detail: `${dir} is not writable (${error instanceof Error ? error.message : String(error)}); set CARDANO_DEBUG_CACHE_DIR to a writable directory` };
  }
}

/** Provider / offline configuration, as the server would read it (keys only as present / absent). */
export function checkProviderConfig(config: ServerConfig): CheckRow {
  const { offline } = config;
  const blockfrost = Object.entries(config.blockfrostProjectIds)
    .filter(([, id]) => Boolean(id))
    .map(([network]) => network);
  const parts = [
    `provider ${config.defaultProvider}`,
    `Koios key ${config.koiosApiKey ? "set" : "not set (anonymous, lower rate limits)"}`,
    `Blockfrost ids ${blockfrost.length ? blockfrost.join(", ") : "none"}`,
    offline ? "OFFLINE (no provider is called)" : "online",
  ];
  const misconfigured = config.defaultProvider === "blockfrost" && blockfrost.length === 0 && !offline;
  if (misconfigured) parts.push("CARDANO_DEBUG_PROVIDER=blockfrost but no BLOCKFROST_PROJECT_ID_<NETWORK> is set");
  return { status: misconfigured ? "warn" : "ok", name: "configuration", detail: parts.join("; ") };
}

function checkWasmModule(name: WasmAssetName, label: string, revision: string | undefined): CheckRow {
  try {
    const bytes = readWasm(name);
    const wasm = (globalThis as unknown as { WebAssembly: { validate(source: Uint8Array): boolean } }).WebAssembly;
    const valid = wasm.validate(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const detail = `${mb(bytes.byteLength)}${revision ? `, built from ${revision}` : ""}${valid ? "" : ", NOT a valid wasm module"}`;
    return { status: valid ? "ok" : "fail", name: label, detail };
  } catch (error) {
    return { status: "fail", name: label, detail: error instanceof Error ? error.message : String(error) };
  }
}

function libraryVersion(): string | undefined {
  try {
    return (createRequire(import.meta.url)("@cardananium/cquisitor-lib/package.json") as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** Start the lib worker the way the server does and read the version it reports. */
async function probeLibWorker(config: ServerConfig, timeoutMs: number): Promise<CheckRow> {
  let lib: ReturnType<typeof createLibClient> | undefined;
  const started = Date.now();
  try {
    lib = createLibClient(config);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the lib worker did not start within ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      await Promise.race([lib.warm(), timeout]);
    } finally {
      clearTimeout(timer);
    }
    const version = (lib.info as { version?: string } | undefined)?.version ?? libraryVersion() ?? "unknown";
    return { status: "ok", name: "cquisitor-lib", detail: `${version} (worker started in ${Date.now() - started} ms)` };
  } catch (error) {
    return { status: "fail", name: "cquisitor-lib", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await lib?.dispose().catch(() => undefined);
  }
}

export async function collectChecks(options: CheckOptions = {}): Promise<CheckRow[]> {
  const env = options.env ?? process.env;
  const rows: CheckRow[] = [];
  const build = buildInfo();

  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  rows.push({
    status: major >= MIN_NODE_MAJOR ? "ok" : "fail",
    name: "node",
    detail: major >= MIN_NODE_MAJOR ? `${process.version}` : `${process.version}; Node ${MIN_NODE_MAJOR} or newer is required`,
  });
  rows.push({ status: "ok", name: "build", detail: `${packageVersion()}, ${describeBuild(build)}` });
  rows.push(...checkBuildFiles().map(fromFile));
  rows.push(...checkTextAssets().map(fromFile));

  // loadConfig also warns on stderr about values it ignores.
  const config = loadConfig(env);
  rows.push(checkCacheDir(config.cacheDir));
  rows.push(checkProviderConfig(config));

  rows.push(checkWasmModule("de_uplc_bg.wasm", "de-uplc engine", build.uplc_rev ? `aiken/uplc ${build.uplc_rev.slice(0, 7)}` : undefined));
  rows.push(checkWasmModule("de_uplc_decompiler_wasm_bg.wasm", "dehosk decompiler", build.dehosk_rev ? `dehosk ${build.dehosk_rev.slice(0, 7)}` : undefined));
  if (build.deps_commit) rows.push({ status: "ok", name: "de-uplc-web", detail: `deps/de-uplc-web at ${build.deps_commit}` });

  if (options.probeLib ?? true) rows.push(await probeLibWorker(config, options.libTimeoutMs ?? 30_000));
  else rows.push({ status: "ok", name: "cquisitor-lib", detail: `${libraryVersion() ?? "unknown"} (worker not started)` });
  return rows;
}

/** The text `--check` prints, one row per line and a verdict. */
export function formatChecks(rows: readonly CheckRow[]): string {
  const tag: Record<CheckStatus, string> = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]" };
  const lines = [`cardano-debug-mcp ${packageVersion()} install check`, ...rows.map((row) => `${tag[row.status]} ${row.name}: ${row.detail}`)];
  const failed = rows.filter((row) => row.status === "fail");
  const warned = rows.filter((row) => row.status === "warn");
  if (failed.length) {
    lines.push("", `${failed.length} check${failed.length > 1 ? "s" : ""} failed: ${failed.map((row) => row.name).join(", ")}.`);
    if (failed.some((row) => /worker|wasm|docs|prompts|cddl/.test(row.name))) lines.push('Build files are missing or stale: in the repository run "npm run build:deps && npm run build", then restart the server.');
  } else {
    lines.push("", warned.length ? `All checks passed with ${warned.length} warning${warned.length > 1 ? "s" : ""}.` : "All checks passed.");
  }
  return `${lines.join("\n")}\n`;
}

/** Run `--check`: the report and the exit code (0 = no failed row). */
export async function runCheck(options: CheckOptions = {}): Promise<{ text: string; code: number }> {
  const rows = await collectChecks(options);
  return { text: formatChecks(rows), code: rows.some((row) => row.status === "fail") ? 1 : 0 };
}
