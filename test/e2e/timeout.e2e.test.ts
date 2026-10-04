// A validator that never finishes: the validation overruns its budget, so tx mode cannot open a
// session, and the way out (step the script outside the tx) needs the script's bytes. Those do not
// depend on the evaluation: tx_redeemer(part='script') and the redeemer's script.hex resource give
// them after a timeout, and validation_timeout names where they are.
//
// Fixture: scenario S2, the artificial S1 sample DebuggerContext with the reference script of the spend:2
// input replaced by a PlutusV2 program that loops forever ((\x. x x)(\x. x x)) and the input's address
// re-pointed at that script's hash (manifest s02.loopHash), so spend:2 runs the loop.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixturePath, fxInt, fxStr } from "../helpers/fixtures.js";
import { McpTestClient } from "../mcpClient.js";

type Json = Record<string, any>;

const LOOP_BUNDLE = fixturePath(fxStr("s02.contextFile"));
const LOOP_HASH = fxStr("s02.loopHash");
const LOOP_HEX = fxStr("s02.loopHex");

describe("a validation that never finishes: the script bytes stay reachable", () => {
  let client: McpTestClient;
  let txId: string;

  beforeAll(async () => {
    client = await McpTestClient.start({
      env: { CARDANO_DEBUG_CACHE_DIR: mkdtempSync(path.join(os.tmpdir(), "cdm-timeout-")), CARDANO_DEBUG_EVAL_TIMEOUT_MS: String(fxInt("s02.evalTimeoutMs")), CARDANO_DEBUG_OFFLINE: "1" },
    });
    const load = await client.callTool<Json>("tx_load", { bundle: LOOP_BUNDLE });
    expect(load.isError, JSON.stringify(load.structuredContent)).toBeFalsy();
    expect(load.structuredContent!.tx_id).toBe(fxStr("s02.txId"));
    txId = load.structuredContent!.tx_id;
  });

  afterAll(async () => {
    if (client) {
      await client.close();
      expect(client.nonJsonStdout).toEqual([]);
    }
  });

  it("tx_redeemer(part='script') answers without an evaluation: hash, version and the bytes resource", async () => {
    const script = await client.callTool<Json>("tx_redeemer", { tx_id: txId, redeemer: "spend:2", part: "script" }, 60_000);
    expect(script.isError, JSON.stringify(script.structuredContent)).toBeFalsy();
    const s = script.structuredContent!;
    expect(s).toMatchObject({ script_hash: LOOP_HASH, plutus_version: "V2", evaluated: false });
    expect(String(s.note)).toMatch(/did not finish within \d+ ms/);
    expect(String(s.note)).toMatch(/debug_open\(script=/);
    const resource = `cardano-debug://tx/${txId}/redeemer/spend:2/script.hex`;
    expect(s.script_resource).toBe(resource);
    expect((s.resources as Json[]).map((r) => r.uri)).toEqual([resource, `cardano-debug://script/${LOOP_HASH}/pseudocode.txt`, `cardano-debug://script/${LOOP_HASH}/uplc.txt`]);
    expect(await client.readResourceText(resource)).toBe(LOOP_HEX);
  });

  it("other parts answer timeout at once (no second overrun) and name the bytes", async () => {
    const started = Date.now();
    const error = await client.callTool<Json>("tx_redeemer", { tx_id: txId, redeemer: "spend:2", part: "error" }, 60_000);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(error.isError).toBe(true);
    expect(error.structuredContent).toMatchObject({ code: "timeout", script_resource: `cardano-debug://tx/${txId}/redeemer/spend:2/script.hex` });
  });

  it("debug_open(tx_id) answers validation_timeout with the script's hash, version and bytes resource; the bytes open outside the tx", async () => {
    const opened = await client.callTool<Json>("debug_open", { tx_id: txId, redeemer: "spend:2" }, 60_000);
    expect(opened.isError).toBe(true);
    const e = opened.structuredContent!;
    expect(e).toMatchObject({ code: "validation_timeout", script_hash: LOOP_HASH, plutus_version: "V2", script_resource: `cardano-debug://tx/${txId}/redeemer/spend:2/script.hex` });
    expect(String(e.message)).toContain(e.script_resource);
    const bytes = await client.readResourceText(e.script_resource);
    // the artificial loop is a lambda around the omega combinator: it starts looping once it gets an argument (here the redeemer)
    const outside = await client.callTool<Json>("debug_open", { script: bytes, plutus_version: "V2", redeemer_data: "d87980" });
    expect(outside.isError, JSON.stringify(outside.structuredContent)).toBeFalsy();
    const run = await client.callTool<Json>("debug_run", { dbg_id: outside.structuredContent!.dbg_id, until: "error", max_steps: 10_000 });
    expect(run.structuredContent!.stopped.kind).toBe("limit");
    await client.callTool<Json>("debug_close", { dbg_id: "all" });
  });
});
