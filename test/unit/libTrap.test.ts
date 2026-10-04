// A wasm trap (or a stack overflow) inside the cquisitor-lib worker must not take the server down:
// the host classifies it fatal, replaces the worker and the next call succeeds. The trap is
// triggered on purpose through the lib worker's test hook (CARDANO_DEBUG_TEST_HOOKS=1), because the
// library itself refuses hostile input gracefully.
import { existsSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createLibClient, type LibClient } from "../../src/lib.js";
import { WorkerCallError } from "../../src/workers/rpc.js";
import { PROJECT_ROOT } from "../mcpClient.js";

const LIB_WORKER = path.join(PROJECT_ROOT, "dist", "workers", "lib.worker.js");
const TRAP_MAGIC_HEX = "5f5f747261705f5f"; // "__trap__"

describe.skipIf(!existsSync(LIB_WORKER))("lib worker survives traps", () => {
  let lib: LibClient;
  const respawns: string[] = [];

  beforeAll(async () => {
    process.env.CARDANO_DEBUG_TEST_HOOKS = "1"; // inherited by the worker thread
    lib = createLibClient(loadConfig({}), { entry: new URL(`file://${LIB_WORKER}`), onRespawn: (info) => respawns.push(info.reason) });
    await lib.warm();
  });

  afterAll(async () => {
    delete process.env.CARDANO_DEBUG_TEST_HOOKS;
    await lib.dispose();
  });

  it("a genuine WebAssembly.RuntimeError is fatal, the worker is replaced and keeps answering", async () => {
    const before = lib.host.stats().generation;
    const error = await lib.cborToJson(TRAP_MAGIC_HEX).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkerCallError);
    expect((error as WorkerCallError).fatal).toBe(true);
    expect((error as WorkerCallError).remoteName).toBe("RuntimeError");
    expect((error as WorkerCallError).message).toMatch(/unreachable/);

    const decoded = await lib.cborToJson<{ ok: boolean }>("d8799f41aa02ff");
    expect(decoded.ok).toBe(true);
    expect(lib.host.stats().generation).toBe(before + 1);
    expect(respawns).toContain("fatal_error");
  });

  it("a RangeError (stack overflow) is fatal too and the worker is replaced again", async () => {
    const before = lib.host.stats().generation;
    const error = await lib.host.call("simulateTrap", ["stack_overflow"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkerCallError);
    expect((error as WorkerCallError).fatal).toBe(true);
    expect((error as WorkerCallError).remoteName).toBe("RangeError");

    const types = await lib.possibleTypes("d8799f41aa02ff");
    expect(types).toContain("PlutusData");
    expect(lib.host.stats().generation).toBe(before + 1);
    expect(lib.host.stats().totalRespawns).toBeGreaterThanOrEqual(2);
  });
});
