// debug_open in tx mode needs a finished validation. When the validation overruns its budget, the
// answer is validation_timeout with the way out, not "run tx_validate, then debug_open again".
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyChainState, setChainState } from "../../src/chain/state.js";
import { loadConfig } from "../../src/config.js";
import type { AppContext } from "../../src/context.js";
import { createLibClient, type LibClient } from "../../src/lib.js";
import { SessionRegistry } from "../../src/store/sessionRegistry.js";
import { TxStore, type TxRecord } from "../../src/store/txStore.js";
import { debugOpen } from "../../src/tools/debug_open.js";
import { buildTxRecord } from "../../src/tx/record.js";
import { WorkerTimeoutError } from "../../src/workers/rpc.js";
import { fixturePath, fxStr } from "../helpers/fixtures.js";
import { PROJECT_ROOT } from "../mcpClient.js";

const LIB_WORKER = path.join(PROJECT_ROOT, "dist", "workers", "lib.worker.js");
/** The artificial S1 sample DebuggerContext: only its transaction is needed here. */
const SAMPLE = JSON.parse(readFileSync(fixturePath(fxStr("s01.contextFile")), "utf8")) as { transaction: string };

describe.skipIf(!existsSync(LIB_WORKER))("debug_open(tx_id) after a validation timeout", () => {
  let lib: LibClient;
  let ctx: AppContext;
  let record: TxRecord;
  let validateCalls = 0;

  beforeAll(async () => {
    const config = loadConfig({});
    lib = createLibClient(config, { entry: new URL(`file://${LIB_WORKER}`) });
    ctx = {
      config,
      lib,
      txStore: new TxStore(),
      sessions: new SessionRegistry({ sweepIntervalMs: 60_000 }),
      startedAt: Date.now(),
      services: {
        chain: {
          validate: async () => {
            validateCalls++;
            throw new WorkerTimeoutError("lib: validate_transaction_js did not answer within 90 s", 90_000);
          },
        },
      } as unknown as AppContext["services"],
      onShutdown: () => undefined,
      shutdown: async () => undefined,
    };
    record = await buildTxRecord(lib, { tx: SAMPLE.transaction, network: "mainnet" });
    ctx.txStore.put(record);
  });

  afterAll(async () => {
    ctx.sessions.closeAll("shutdown");
    await lib.dispose();
  });

  it("a validation that times out now answers validation_timeout with the next steps", async () => {
    const result = await debugOpen(ctx, { tx_id: record.txId, redeemer: "spend:2" }, undefined);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "validation_timeout", tx_id: record.txId, redeemer: "spend:2", timeout_ms: 90_000 });
    expect(String(result.structuredContent.message)).toMatch(/cannot be opened in tx mode/);
    expect(String(result.structuredContent.message)).toMatch(/timeout_ms up to 300000/);
    expect(validateCalls).toBe(1);
  });

  it("a validation that already timed out at the default budget is not re-run", async () => {
    const state = emptyChainState("mainnet", "test");
    state.timedOut = { timeout_ms: ctx.config.evalTimeoutMs, at: Date.now() };
    setChainState(record, state);
    const result = await debugOpen(ctx, { tx_id: record.txId, redeemer: "spend:2" }, undefined);
    expect(result.structuredContent).toMatchObject({ code: "validation_timeout" });
    expect(validateCalls).toBe(1);
  });
});
