import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { isLibAbortedError, isLibRefusal } from "@cardananium/cquisitor-lib";

import { failFromError } from "../../src/tools/_shared.js";
import { WorkerHost } from "../../src/workers/host.js";
import {
  WorkerAbortedError,
  WorkerCallError,
  WorkerInputTooLargeError,
  WorkerTimeoutError,
  WorkerUnavailableError,
} from "../../src/workers/rpc.js";

// The test worker is TypeScript; worker threads cannot load .ts on Node 20 (loaders from
// `--import` are not honoured in worker execArgv there), so it is bundled to JS once per run.
const outDir = mkdtempSync(path.join(os.tmpdir(), "cardano-debug-host-test-"));
let ENTRY: URL;
let CRASHING_ENTRY: URL;

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
  const crashing = path.join(outDir, "crashing.worker.mjs");
  writeFileSync(crashing, "throw new Error('boot failure');\n");
  CRASHING_ENTRY = pathToFileURL(crashing);
});

function makeHost(overrides: Partial<ConstructorParameters<typeof WorkerHost>[0]> = {}) {
  const lines: string[] = [];
  const respawns: string[] = [];
  const host = new WorkerHost({
    entry: ENTRY,
    name: "test",
    defaultTimeoutMs: 2_000,
    hardKillGraceMs: 300,
    maxInputBytes: 1024,
    mirror: (line) => lines.push(line),
    onRespawn: (info) => respawns.push(info.reason),
    ...overrides,
  });
  return { host, lines, respawns };
}

const hosts: WorkerHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.dispose()));
});

describe("WorkerHost", () => {
  it("calls handlers, reports ready info, transfers bigint and workerData", async () => {
    const { host } = makeHost({ workerData: { hello: "world" } });
    hosts.push(host);
    expect(await host.call("add", [2, 3])).toBe(5);
    expect(await host.call("echo", ["a", 1, { b: [true] }])).toEqual(["a", 1, { b: [true] }]);
    expect(await host.call("bigint", [])).toEqual({ big: 2n ** 70n, small: 5n });
    expect(await host.call("data", [])).toEqual({ hello: "world" });
    expect(await host.ping()).toBe("pong");
    expect(host.stats().workerInfo).toEqual({ role: "test-worker" });
    expect(host.stats().totalCalls).toBe(5);
  });

  it("serialises calls FIFO", async () => {
    const { host } = makeHost();
    hosts.push(host);
    const results = await Promise.all([host.call("slowAsync", [50]), host.call("add", [1, 1]), host.call("echo", ["x"])]);
    expect(results).toEqual(["done", 2, ["x"]]);
  });

  it("rejects oversized input before dispatch", async () => {
    const { host } = makeHost();
    hosts.push(host);
    await expect(host.call("echo", ["x".repeat(2048)])).rejects.toBeInstanceOf(WorkerInputTooLargeError);
    expect(await host.call("echo", ["x".repeat(2048)], { maxInputBytes: 4096 })).toEqual(["x".repeat(2048)]);
  });

  it("counts and words the input budget as the library does: nested strings and objects count, a lower bound says 'at least', no size that rounds like the limit", async () => {
    const MiB = 1024 * 1024;
    const { host } = makeHost();
    hosts.push(host);
    // 40 strings of 1 MB inside an array: 40 MB, not "2.9 MB" (the count does not stop at the first string past the limit)
    const many = await host.call("echo", ["84a4", Array.from({ length: 40 }, () => "ab".repeat(500_000))], { maxInputBytes: 2 * MiB }).catch((e: unknown) => e);
    expect(many).toBeInstanceOf(WorkerInputTooLargeError);
    expect((many as WorkerInputTooLargeError).bytes).toBeGreaterThanOrEqual(40_000_004);
    expect((many as WorkerInputTooLargeError).atLeast).toBe(true);
    expect((many as Error).message).toMatch(/^This input is at least 38 MB, over the 2\.0 MB limit\. /);
    // 17,000,000 bytes against 16 MiB: both read "16 MB", so the size is left out instead of "16 MB, over the 16 MB limit"
    const just = await host.call("echo", ["ab".repeat(8_500_000)], { maxInputBytes: 16 * MiB, inputSubject: "The input of validate_transaction_js" }).catch((e: unknown) => e);
    expect((just as Error).message).toMatch(/^The input of validate_transaction_js is over the 16 MB limit\. /);
    // strings inside an object count too (a parts object is not 0 bytes)
    await expect(host.call("echo", [{ script: "x".repeat(2048) }])).rejects.toBeInstanceOf(WorkerInputTooLargeError);
    // the tool answer marks a lower bound
    const answer = failFromError(many).structuredContent as { code: string; bytes: number; bytes_at_least?: boolean; limit: number };
    expect(answer).toMatchObject({ code: "input_too_large", bytes_at_least: true, limit: 2 * MiB });
    expect(new WorkerInputTooLargeError(3_000_004, 2 * MiB).message).toMatch(/^This input is 2\.9 MB, over the 2\.0 MB limit\. /);
  });

  it("refuses with the library's refusal classes, so isLibRefusal recognises them", () => {
    // The host's classes are what the tools branch on; the library's contract
    // for a LibBackend (`isLibRefusal`) has to hold for the same objects.
    expect(isLibRefusal(new WorkerInputTooLargeError(2048, 1024))).toBe(true);
    expect(isLibRefusal(new WorkerTimeoutError("too long", 100))).toBe(true);
    expect(isLibRefusal(new WorkerUnavailableError("gone"))).toBe(true);
    expect(isLibAbortedError(new WorkerAbortedError())).toBe(true);
    // A library answer that is an exception is not a refusal.
    expect(isLibRefusal(new WorkerCallError({ name: "Error", message: "bad hex", fatal: false }))).toBe(false);
    expect(new WorkerTimeoutError("too long", 100).name).toBe("WorkerTimeoutError");
  });

  it("maps thrown errors (Error and string) to WorkerCallError without respawning", async () => {
    const { host, respawns } = makeHost();
    hosts.push(host);
    await expect(host.call("throwError", ["boom"])).rejects.toMatchObject({ message: "boom", fatal: false });
    await expect(host.call("throwString", ["plain"])).rejects.toMatchObject({ message: "plain", fatal: false });
    await expect(host.call("nope", [])).rejects.toMatchObject({ kind: "unknown_method" });
    await expect(host.call("notCloneable", [])).rejects.toMatchObject({ kind: "result_not_transferable" });
    expect(host.currentGeneration).toBe(0);
    expect(respawns).toEqual([]);
  });

  it("treats a wasm trap and a stack overflow as fatal and respawns", async () => {
    const { host, respawns } = makeHost();
    hosts.push(host);
    const gen0 = host.currentGeneration;
    const error = await host.call("trap", []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkerCallError);
    expect((error as WorkerCallError).fatal).toBe(true);
    expect(host.currentGeneration).toBe(gen0 + 1);
    expect(await host.call("add", [1, 2])).toBe(3);
    const overflow = await host.call("overflow", []).catch((e: unknown) => e);
    expect((overflow as WorkerCallError).fatal).toBe(true);
    expect(host.currentGeneration).toBe(gen0 + 2);
    expect(respawns).toEqual(["fatal_error", "fatal_error"]);
    expect(host.stats().totalRespawns).toBe(2);
  });

  it("raises the stop flag on soft timeout and the worker can finish cooperatively", async () => {
    const { host } = makeHost({ defaultTimeoutMs: 150, hardKillGraceMs: 2_000 });
    hosts.push(host);
    const result = (await host.call("spin", [5_000])) as { cancelled: boolean };
    expect(result.cancelled).toBe(true);
    expect(host.currentGeneration).toBe(0);
    // Flag is cleared for the next call.
    expect(await host.call("spin", [20])).toEqual({ cancelled: false });
  });

  it("terminates a worker that ignores the stop flag and respawns", async () => {
    const { host, respawns } = makeHost({ defaultTimeoutMs: 100, hardKillGraceMs: 100 });
    hosts.push(host);
    const t0 = Date.now();
    await expect(host.call("hang", [10_000])).rejects.toBeInstanceOf(WorkerTimeoutError);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(respawns).toEqual(["timeout"]);
    expect(await host.call("add", [4, 4])).toBe(8);
  });

  it("per-call timeout overrides the default", async () => {
    const { host } = makeHost({ defaultTimeoutMs: 10_000, hardKillGraceMs: 50 });
    hosts.push(host);
    await expect(host.call("hang", [5_000], { timeoutMs: 100 })).rejects.toBeInstanceOf(WorkerTimeoutError);
  });

  it("aborts queued and in-flight calls via AbortSignal", async () => {
    const { host } = makeHost({ hardKillGraceMs: 2_000 });
    hosts.push(host);
    const controller = new AbortController();
    const inFlight = host.call("spin", [5_000], { signal: controller.signal });
    const queued = host.call("add", [1, 1], { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await expect(queued).rejects.toBeInstanceOf(WorkerAbortedError);
    // The spin loop honours the flag, so the in-flight call resolves with cancelled: true.
    expect(await inFlight).toEqual(expect.objectContaining({ cancelled: true }));
    expect(host.currentGeneration).toBe(0);
    const pre = new AbortController();
    pre.abort();
    await expect(host.call("add", [1, 1], { signal: pre.signal })).rejects.toBeInstanceOf(WorkerAbortedError);
  });

  it("hard-kills an in-flight call whose worker ignores an abort", async () => {
    const { host, respawns } = makeHost({ hardKillGraceMs: 100 });
    hosts.push(host);
    const controller = new AbortController();
    const promise = host.call("hang", [5_000], { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(WorkerAbortedError);
    expect(respawns).toEqual(["abort"]);
  });

  it("recovers when the worker exits, keeping queued calls", async () => {
    const { host, respawns } = makeHost();
    hosts.push(host);
    const exiting = host.call("exit", [3]);
    const after = host.call("add", [5, 5]);
    expect(await exiting).toBe("exiting");
    expect(await after).toBe(10);
    // The exit happens asynchronously after the answer; wait for it to be noticed.
    await new Promise((r) => setTimeout(r, 200));
    expect(respawns).toContain("worker_exit");
    expect(await host.call("add", [1, 1])).toBe(2);
  });

  it("mirrors worker stdout and stderr to the host mirror", async () => {
    const { host, lines } = makeHost();
    hosts.push(host);
    await host.call("log", ["hello"]);
    await new Promise((r) => setTimeout(r, 100));
    expect(lines).toContain("[worker:test stdout] hello");
    expect(lines).toContain("[worker:test] HELLO");
  });

  it("terminate/respawn/dispose", async () => {
    const { host } = makeHost();
    hosts.push(host);
    await host.warm();
    expect(host.alive).toBe(true);
    await host.terminate();
    expect(host.alive).toBe(false);
    expect(await host.call("add", [1, 2])).toBe(3); // lazily respawned
    await host.respawn();
    expect(host.isReady).toBe(true);
    await host.dispose();
    await expect(host.call("add", [1, 2])).rejects.toBeInstanceOf(WorkerUnavailableError);
  });

  it("backs off after repeated start-up crashes instead of respawning in a loop", async () => {
    const { host, respawns } = makeHost({ entry: CRASHING_ENTRY });
    hosts.push(host);
    const t0 = Date.now();
    await expect(host.call("add", [1, 1])).rejects.toBeInstanceOf(WorkerUnavailableError);
    // Later calls are refused immediately while the back-off lasts.
    await expect(host.call("add", [1, 1])).rejects.toThrow(/not retrying/);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(respawns.filter((r) => r === "worker_error").length).toBeLessThanOrEqual(3);
    expect(host.currentGeneration).toBeLessThanOrEqual(3);
  });

  it("autoRespawn: false leaves the host dead until respawn()", async () => {
    const { host, respawns } = makeHost({ autoRespawn: false, defaultTimeoutMs: 100, hardKillGraceMs: 50 });
    hosts.push(host);
    await expect(host.call("hang", [5_000])).rejects.toBeInstanceOf(WorkerTimeoutError);
    expect(respawns).toEqual(["timeout"]);
    expect(host.alive).toBe(false);
    expect(host.isLost).toBe(true);
    await expect(host.call("add", [2, 2])).rejects.toBeInstanceOf(WorkerUnavailableError);
    await host.respawn();
    expect(host.isLost).toBe(false);
    expect(await host.call("add", [2, 2])).toBe(4);
  });
});
