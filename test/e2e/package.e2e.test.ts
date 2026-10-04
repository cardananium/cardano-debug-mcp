// The packaged install: dist/ + package.json copied to a directory with a SPACE in its name, node_modules
// symlinked, the server started from an unrelated working directory. Covers what a user's MCP host does
// (initialize, docs, a debugger session, a decompile, SIGTERM), the command line (`--version`, `--help`,
// `--check`, a script path without `.js`) and a half-built install (one clear line, exit 1).
//
// Runs against dist/server.js (`npm run build`; `npm run test:e2e` builds first).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registryBytesHex } from "../fixtures/synthetic/lib/scripts.js";
import { DIST_SERVER, McpTestClient, PROJECT_ROOT, serverEnv } from "../mcpClient.js";

const PACKAGE_JSON = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")) as { version: string };
const SMALL_PROGRAM = "(program 1.0.0 [(lam x [(builtin addInteger) x (con integer 1)]) (con integer 41)])";
const TINY_SCRIPT = registryBytesHex("tiny"); // the artificial always-succeeds V2 script (test/fixtures/synthetic/uplc/tiny.uplc)

type Json = Record<string, any>;

describe("packaged install (path with a space, other working directory)", () => {
  let root: string;
  let installed: string;
  let broken: string;
  let otherCwd: string;
  let cacheDir: string;
  const env = () => ({ CARDANO_DEBUG_CACHE_DIR: cacheDir, CARDANO_DEBUG_OFFLINE: "1", CARDANO_DEBUG_NO_OPEN: "1" });

  /** package.json + node_modules symlink next to `dir`'s dist. */
  function finishInstall(dir: string): void {
    cpSync(path.join(PROJECT_ROOT, "package.json"), path.join(dir, "package.json"));
    symlinkSync(path.join(PROJECT_ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");
  }

  beforeAll(() => {
    expect(existsSync(DIST_SERVER), "run `npm run build` before the e2e tests").toBe(true);
    root = mkdtempSync(path.join(os.tmpdir(), "cdm pkg "));
    installed = path.join(root, "cardano debug mcp");
    broken = path.join(root, "half built");
    otherCwd = path.join(root, "elsewhere");
    cacheDir = path.join(root, "cache dir");
    for (const dir of [installed, broken, otherCwd, cacheDir]) mkdirSync(dir, { recursive: true });
    cpSync(path.join(PROJECT_ROOT, "dist"), path.join(installed, "dist"), { recursive: true });
    finishInstall(installed);
    // A build that stopped after server.js: no workers, no wasm.
    mkdirSync(path.join(broken, "dist"), { recursive: true });
    cpSync(DIST_SERVER, path.join(broken, "dist", "server.js"));
    finishInstall(broken);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const start = (serverPath = path.join(installed, "dist", "server.js"), extra: { skipInitialize?: boolean } = {}) =>
    McpTestClient.start({ serverPath, cwd: otherCwd, env: env(), ...extra });

  it("initialize reports the package version; docs, a debugger session and a decompile work", async () => {
    const client = await start();
    try {
      const init = client.initializeResult!;
      expect(init.serverInfo.name).toBe("cardano-debug");
      expect(init.serverInfo.version).toBe(PACKAGE_JSON.version);

      const docs = await client.callTool<Json>("docs", { topic: "debug-playbook" });
      expect(docs.isError).toBeFalsy();
      expect((docs.structuredContent!.sections as unknown[]).length).toBeGreaterThan(5);

      const opened = await client.callTool<Json>("debug_open", { script: SMALL_PROGRAM, plutus_version: "V2" });
      expect(opened.isError, JSON.stringify(opened.structuredContent).slice(0, 300)).toBeFalsy();
      const dbg = opened.structuredContent!.dbg_id as string;
      const run = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "done" });
      expect(run.structuredContent!.stopped.kind).toBe("done");
      await client.callTool<Json>("debug_close", { dbg_id: dbg });

      const decompiled = await client.callTool<Json>("script_decompile", { script: TINY_SCRIPT, plutus_version: "V2" }, 120_000);
      expect(decompiled.isError, JSON.stringify(decompiled.structuredContent).slice(0, 300)).toBeFalsy();
      expect(String(decompiled.structuredContent!.code).length).toBeGreaterThan(0);

      const info = await client.readResourceJson<Json>("cardano-debug://server/info");
      expect(info).toMatchObject({ name: "cardano-debug", version: PACKAGE_JSON.version, build: { source: "dist" } });
      expect(typeof info.build.built_at).toBe("string");
      expect(client.nonJsonStdout).toEqual([]);
    } finally {
      expect(await client.close()).toBe(0);
    }
  });

  it("starts as `node dist/server` (no .js extension)", async () => {
    const client = await start(path.join(installed, "dist", "server"));
    try {
      expect(client.initializeResult!.serverInfo.version).toBe(PACKAGE_JSON.version);
      expect((await client.callTool<Json>("cbor_decode", { hex: "d8799f41aa02ff" })).isError).toBeFalsy();
    } finally {
      expect(await client.close()).toBe(0);
    }
  });

  it("SIGTERM exits 0 quickly, with a session open", async () => {
    const client = await start();
    const opened = await client.callTool<Json>("debug_open", { script: SMALL_PROGRAM, plutus_version: "V2" });
    expect(opened.isError).toBeFalsy();
    const started = Date.now();
    client.child.kill("SIGTERM");
    expect(await client.waitForExit(8_000)).toBe(0);
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(client.stderrText()).toContain("SIGTERM: shutting down");
  });

  it("--version, --help and an unknown option", () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [path.join(installed, "dist", "server.js"), ...args], { cwd: otherCwd, env: serverEnv(env()), encoding: "utf8", timeout: 30_000 });
    const version = run("--version");
    expect(version.status).toBe(0);
    expect(version.stdout).toMatch(new RegExp(`^cardano-debug-mcp ${PACKAGE_JSON.version.replace(/\./g, "\\.")} \\(built `));
    const help = run("--help");
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--check");
    const unknown = run("--chekc");
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("unknown option '--chekc'");
    expect(unknown.stdout).toBe("");
  });

  it("--check passes on a complete install and prints what it checked", () => {
    const result = spawnSync(process.execPath, [path.join(installed, "dist", "server.js"), "--check"], { cwd: otherCwd, env: serverEnv(env()), encoding: "utf8", timeout: 60_000 });
    expect(result.stdout, result.stderr).toContain("All checks passed");
    expect(result.status).toBe(0);
    for (const row of ["[ok]   node:", "worker lib.worker:", "wasm de_uplc_bg.wasm:", "cache dir:", "configuration:", "cquisitor-lib:"]) expect(result.stdout).toContain(row);
    expect(result.stdout).toMatch(/configuration: .*OFFLINE/);
  });

  it("a half-built install says so in one line and exits 1; --check fails", async () => {
    const client = await start(path.join(broken, "dist", "server.js"), { skipInitialize: true });
    expect(await client.waitForExit(15_000)).toBe(1);
    const lines = client.stderrText().split("\n").filter((line) => line.includes("failed to start"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("this build is incomplete (missing: worker lib.worker");
    expect(lines[0]).toContain("npm run build:deps && npm run build");
    expect(client.nonJsonStdout).toEqual([]);

    const check = spawnSync(process.execPath, [path.join(broken, "dist", "server.js"), "--check"], { cwd: otherCwd, env: serverEnv(env()), encoding: "utf8", timeout: 60_000 });
    expect(check.status).toBe(1);
    expect(check.stdout).toContain("[FAIL] worker lib.worker");
    expect(check.stdout).toContain("npm run build:deps && npm run build");
  });
});
