// Process lifecycle pieces of src/server.ts, src/cli.ts, src/preflight.ts and src/buildInfo.ts that can be
// tested without spawning a server (the spawned-process cases live in test/e2e/lifecycle.e2e.test.ts and
// test/e2e/package.e2e.test.ts).
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { buildInfo, describeBuild } from "../../src/buildInfo.js";
import { checkCacheDir, checkProviderConfig, collectChecks, formatChecks, parseCliArgs, versionText } from "../../src/cli.js";
import { loadConfig } from "../../src/config.js";
import { findSection } from "../../src/docs/index.js";
import { incompleteBuildMessage, type FileCheck } from "../../src/preflight.js";
import { guardStdout, isMainModule, ReportingStdioTransport, SERVER_INSTRUCTIONS } from "../../src/server.js";

const scratch = () => mkdtempSync(path.join(os.tmpdir(), "cdm-lifecycle-"));

describe("command line", () => {
  it("no option (or the conventional stdio markers) serves; the three flags are recognised", () => {
    expect(parseCliArgs([])).toEqual({ kind: "serve" });
    expect(parseCliArgs(["--stdio"])).toEqual({ kind: "serve" });
    expect(parseCliArgs(["stdio"])).toEqual({ kind: "serve" });
    expect(parseCliArgs(["--check"])).toEqual({ kind: "check" });
    expect(parseCliArgs(["--version"])).toEqual({ kind: "version" });
    expect(parseCliArgs(["-v"])).toEqual({ kind: "version" });
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["-h", "--check"])).toEqual({ kind: "help" });
  });

  it("an unknown option or argument is an error that names it", () => {
    expect(parseCliArgs(["--chekc"])).toEqual({ kind: "error", message: "unknown option '--chekc'" });
    expect(parseCliArgs(["serve"])).toEqual({ kind: "error", message: "unknown argument 'serve'" });
  });

  it("--version says the package version and what the build is", () => {
    expect(versionText()).toMatch(/^cardano-debug-mcp \d+\.\d+\.\d+ \(.+\)\n$/);
  });
});

describe("isMainModule", () => {
  it("matches the script path with or without its extension, through a symlink, and not another file", () => {
    const dir = scratch();
    const script = path.join(dir, "server.js");
    writeFileSync(script, "// x\n");
    const self = pathToFileURL(script).href;
    expect(isMainModule(script, self)).toBe(true);
    expect(isMainModule(path.join(dir, "server"), self)).toBe(true);
    const link = path.join(dir, "bin-link");
    symlinkSync(script, link);
    expect(isMainModule(link, self)).toBe(true);
    const other = path.join(dir, "other.js");
    writeFileSync(other, "// y\n");
    expect(isMainModule(other, self)).toBe(false);
    expect(isMainModule(path.join(dir, "missing"), self)).toBe(false);
    expect(isMainModule(undefined, self)).toBe(false);
  });

  it("a space in the path does not matter", () => {
    const dir = path.join(scratch(), "a folder with spaces");
    mkdirSync(dir);
    const script = path.join(dir, "server.js");
    writeFileSync(script, "// x\n");
    expect(isMainModule(path.join(dir, "server"), pathToFileURL(script).href)).toBe(true);
  });
});

describe("guardStdout", () => {
  it("points console.log, info and debug at stderr's console.error", () => {
    const written: unknown[][] = [];
    const fake = { log: () => undefined, info: () => undefined, debug: () => undefined, error: (...args: unknown[]) => void written.push(args) } as unknown as Console;
    guardStdout(fake);
    fake.log("a", 1);
    fake.info("b");
    fake.debug("c");
    expect(written).toEqual([["a", 1], ["b"], ["c"]]);
  });
});

describe("ReportingStdioTransport: stdin end waits for the calls in flight", () => {
  const request = (id: number, method = "tools/call") => `${JSON.stringify({ jsonrpc: "2.0", id, method, params: {} })}\n`;
  const response = (id: number) => ({ jsonrpc: "2.0" as const, id, result: {} });

  function rig() {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out: string[] = [];
    stdout.on("data", (chunk: Buffer) => out.push(chunk.toString("utf8")));
    const events: string[] = [];
    const transport = new ReportingStdioTransport(() => events.push("closed"), 1024 * 1024, () => events.push("input-end"), { stdin, stdout });
    const received: unknown[] = [];
    transport.onmessage = (message) => void received.push(message);
    return { stdin, stdout, out, events, transport, received };
  }

  it("keeps the transport open at end of input and answers the pending request", async () => {
    const { stdin, out, events, transport, received } = rig();
    await transport.start();
    stdin.write(request(1));
    stdin.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toHaveLength(1);
    expect(events).toEqual(["input-end"]); // not "closed": the SDK's default would have closed here and dropped the call
    expect(transport.pendingRequests).toBe(1);
    expect(await transport.whenIdle(30)).toBe(false);

    const idle = transport.whenIdle(2_000);
    await transport.send(response(1));
    expect(await idle).toBe(true);
    expect(transport.pendingRequests).toBe(0);
    expect(out.join("")).toContain('"id":1');
    await transport.close();
    expect(events).toEqual(["input-end", "closed"]);
  });

  it("two requests: idle only after both are answered; a notification and a cancellation do not count", async () => {
    const { stdin, transport } = rig();
    await transport.start();
    stdin.write(request(1) + request(2) + `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(transport.pendingRequests).toBe(2);
    await transport.send(response(1));
    expect(await transport.whenIdle(20)).toBe(false);
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(transport.pendingRequests).toBe(0);
    expect(await transport.whenIdle(20)).toBe(true);
    await transport.close();
  });

  it("an error response settles too; no pending request means idle at once", async () => {
    const { stdin, transport } = rig();
    await transport.start();
    expect(await transport.whenIdle(10)).toBe(true);
    stdin.write(request(7));
    await new Promise((resolve) => setImmediate(resolve));
    await transport.send({ jsonrpc: "2.0", id: 7, error: { code: -32603, message: "boom" } });
    expect(transport.pendingRequests).toBe(0);
    await transport.close();
  });

  it("closing releases the waiters (false) and reports once", async () => {
    const { stdin, events, transport } = rig();
    await transport.start();
    stdin.write(request(3));
    await new Promise((resolve) => setImmediate(resolve));
    const waiting = transport.whenIdle(5_000);
    await transport.close();
    expect(await waiting).toBe(false);
    expect(events).toEqual(["closed"]);
  });
});

describe("preflight and --check", () => {
  const file = (name: string, ok: boolean, critical = false): FileCheck => ({ name, ok, detail: ok ? "/x" : "missing", critical });

  it("one message for the missing files, none when everything is there", () => {
    expect(incompleteBuildMessage([file("worker lib.worker", true), file("wasm de_uplc_bg.wasm", true)])).toBeUndefined();
    const message = incompleteBuildMessage([file("worker lib.worker", false, true), file("wasm de_uplc_bg.wasm", false), file("worker session.worker", true)])!;
    expect(message).toContain("missing: worker lib.worker, wasm de_uplc_bg.wasm");
    expect(message).toContain("npm run build:deps && npm run build");
    expect(message).not.toContain("\n");
  });

  it("collectChecks on this checkout: every build file, the cache dir and the configuration are reported", async () => {
    const cache = path.join(scratch(), "cache");
    const rows = await collectChecks({ env: { CARDANO_DEBUG_CACHE_DIR: cache, CARDANO_DEBUG_OFFLINE: "1" }, probeLib: false });
    const names = rows.map((row) => row.name);
    for (const name of ["node", "build", "worker lib.worker", "worker session.worker", "worker decompiler.worker", "wasm de_uplc_bg.wasm", "wasm de_uplc_decompiler_wasm_bg.wasm", "cache dir", "configuration", "de-uplc engine", "dehosk decompiler", "cquisitor-lib"]) {
      expect(names, name).toContain(name);
    }
    expect(rows.filter((row) => row.status === "fail"), JSON.stringify(rows.filter((row) => row.status === "fail"))).toEqual([]);
    expect(rows.find((row) => row.name === "configuration")!.detail).toContain("OFFLINE");
    expect(formatChecks(rows)).toContain("All checks passed");
  });

  it("an unwritable cache dir fails with the variable to set", () => {
    const dir = scratch();
    const blocker = path.join(dir, "a-file");
    writeFileSync(blocker, "x");
    const row = checkCacheDir(path.join(blocker, "cache"));
    expect(row.status).toBe("fail");
    expect(row.detail).toContain("CARDANO_DEBUG_CACHE_DIR");
    expect(checkCacheDir(path.join(dir, "fresh")).status).toBe("ok");
  });

  it("provider config: keys are only reported as set / not set; blockfrost without ids warns", () => {
    const base = { CARDANO_DEBUG_CACHE_DIR: "/x" };
    const plain = checkProviderConfig(loadConfig({ ...base, KOIOS_API_KEY: "secret-key" }));
    expect(plain.status).toBe("ok");
    expect(plain.detail).toContain("Koios key set");
    expect(plain.detail).not.toContain("secret-key");
    const warned = checkProviderConfig(loadConfig({ ...base, CARDANO_DEBUG_PROVIDER: "blockfrost" }));
    expect(warned.status).toBe("warn");
    expect(warned.detail).toContain("BLOCKFROST_PROJECT_ID_<NETWORK>");
    const withId = checkProviderConfig(loadConfig({ ...base, CARDANO_DEBUG_PROVIDER: "blockfrost", BLOCKFROST_PROJECT_ID_MAINNET: "id" }));
    expect(withId.status).toBe("ok");
    expect(withId.detail).toContain("Blockfrost ids mainnet");
  });

  it("formatChecks: a failed row gives the count, the names and the build hint", () => {
    const text = formatChecks([
      { status: "ok", name: "node", detail: "v24" },
      { status: "fail", name: "worker lib.worker", detail: "missing" },
    ]);
    expect(text).toContain("[FAIL] worker lib.worker: missing");
    expect(text).toContain("1 check failed: worker lib.worker.");
    expect(text).toContain("npm run build:deps && npm run build");
  });
});

describe("build info", () => {
  it("from source it says so; a dist build is described by time, commits and revisions", () => {
    expect(buildInfo()).toEqual({ source: "src" });
    expect(describeBuild({ source: "src" })).toBe("from source");
    expect(describeBuild({ source: "dist", built_at: "2026-10-04T10:00:00.000Z", commit: "abcdef123456+dirty", deps_commit: "57c58154b003b58780025a7b33ebf478930c5895", dehosk_rev: "eb42c2e9d7fa2b93ab858ff8b1354b4e856a148b" })).toBe(
      "built 2026-10-04T10:00:00.000Z, commit abcdef123456+dirty, de-uplc-web 57c5815, dehosk eb42c2e",
    );
    expect(describeBuild({ source: "dist" })).toBe("build info unavailable");
  });
});

describe("server instructions", () => {
  it("the ui_link clause sends the model to the show-it-in-a-ui playbook section, and that section exists", () => {
    const pointer = /docs\(topic='([a-z-]+)', section='([a-z0-9-]+)'\)/.exec(SERVER_INSTRUCTIONS.slice(SERVER_INSTRUCTIONS.indexOf("ui_link")));
    expect(pointer?.slice(1, 3)).toEqual(["debug-playbook", "show-it-in-a-ui"]);
    expect(findSection("show-it-in-a-ui", "debug-playbook")?.how).toBe("exact");
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(1_600);
  });
});
