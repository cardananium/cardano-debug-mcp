// What the model is told when a worker is lost: the worker's own last stderr line (the cause is
// there, and stderr is invisible to the model), and a hard-timeout message that fits the host.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { WorkerHost, type RespawnInfo } from "../../src/workers/host.js";
import { WorkerTimeoutError, WorkerUnavailableError } from "../../src/workers/rpc.js";

const outDir = mkdtempSync(path.join(os.tmpdir(), "cardano-debug-hostloss-test-"));
let ENTRY: URL;
let INIT_FAILURE: URL;

beforeAll(async () => {
  const outfile = path.join(outDir, "test.worker.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./workers/test.worker.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile,
    logLevel: "silent",
  });
  ENTRY = pathToFileURL(outfile);
  const failing = path.join(outDir, "init-failure.worker.mjs");
  // what rpc-worker prints when a worker's init throws, then the exit it forces
  writeFileSync(failing, "console.error('[worker] init failed: Error: the engine module is not a WebAssembly.Module\\n    at initEngine (session.worker.js:12:11)\\n    at async run (rpc-worker.js:3:1)');\nprocess.exit(1);\n");
  INIT_FAILURE = pathToFileURL(failing);
});

const hosts: WorkerHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.dispose()));
});

function makeHost(overrides: Partial<ConstructorParameters<typeof WorkerHost>[0]> = {}) {
  const losses: RespawnInfo[] = [];
  const host = new WorkerHost({
    entry: ENTRY,
    name: "test",
    defaultTimeoutMs: 2_000,
    hardKillGraceMs: 200,
    autoRespawn: false,
    mirror: () => undefined,
    onRespawn: (info) => losses.push(info),
    ...overrides,
  });
  hosts.push(host);
  return { host, losses };
}

describe("a lost worker explains itself", () => {
  it("a worker that dies while starting: the cause line of its stderr is in the message, not its stack frames", async () => {
    const { host, losses } = makeHost({ entry: INIT_FAILURE });
    const error = await host.warm().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(WorkerUnavailableError);
    const message = (error as Error).message;
    expect(message).toMatch(/worker lost while starting \(worker_exit: exit code 1; last worker stderr: \[worker\] init failed: Error: the engine module is not a WebAssembly\.Module\)/);
    expect(message).not.toContain("initEngine");
    expect(losses[0]?.detail).toContain("last worker stderr: [worker] init failed");
    // a later call is refused with the same story
    await expect(host.call("add", [1, 2])).rejects.toThrow(/last worker stderr: \[worker\] init failed/);
  });

  it("a worker that dies inside a call: the in-flight call's error names the panic line", async () => {
    const { host } = makeHost();
    await host.warm();
    const error = await host.call("dieLoudly", []).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(WorkerUnavailableError);
    expect((error as Error).message).toMatch(/lost while running dieLoudly \(worker_exit: exit code 7; last worker stderr: thread 'main' panicked at src\/lib\.rs:1: out of cheese\)/);
  });

  it("a deliberate terminate adds nothing", async () => {
    const { host, losses } = makeHost();
    await host.warm();
    await host.call("log", ["hello"]);
    await host.terminate();
    expect(losses.every((l) => !String(l.detail ?? "").includes("last worker stderr"))).toBe(true);
  });
});

describe("hard timeout wording", () => {
  it("names the method that never answered; the hint is the host's own", async () => {
    const { host } = makeHost({ defaultTimeoutMs: 100, hardKillGraceMs: 50, timeoutHint: "It was inside one long engine call, not stepping." });
    const error = await host.call("hang", [5_000]).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(WorkerTimeoutError);
    const timeout = error as WorkerTimeoutError;
    expect(timeout.method).toBe("hang");
    expect(timeout.message).toMatch(/test: hang did not answer within 150 ms; the worker was terminated\. It was inside one long engine call, not stepping\.$/);
    expect(timeout.message).not.toMatch(/too large/);
  });

  it("without a hint it keeps the one-shot wording", async () => {
    const { host } = makeHost({ defaultTimeoutMs: 100, hardKillGraceMs: 50 });
    const error = (await host.call("hang", [5_000]).then(
      () => undefined,
      (e: unknown) => e,
    )) as WorkerTimeoutError;
    expect(error.message).toMatch(/The input is too large or too complex for this operation to finish in its budget\.$/);
  });
});
