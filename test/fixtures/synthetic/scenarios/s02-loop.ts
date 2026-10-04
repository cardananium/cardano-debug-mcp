// S2: the S1 transaction (byte for byte the same) in a chain context whose spend script never finishes: the
// registry's `loop_v2` (the omega combinator behind one lambda, 14 bytes) replaces order_fixed as the reference script
// at utxos[0], and the script input's address is re-pointed at the loop's hash, so spend:2 runs the loop. Validation
// overruns the evaluation timeout (the timeout tests set EVAL_TIMEOUT_MS=2000); the way out is to step the script
// outside the transaction, which needs the bytes (tx_redeemer part='script', the script.hex resource).
//
// Nothing here is evaluated at build time: the in-process validator cannot interrupt a loop. The transaction is S1's
// and its ex-units are S1's declared ones, which are as good as any other figure for a script that never ends.

import type { Utxo } from "../lib/context.js";
import type { Scenario } from "../lib/toolkit.js";
import { hub } from "./s01-hub.js";

export const scenario: Scenario = {
  name: "s02",
  description: "S1's transaction in a context where the spend script is an endless loop (validation times out).",
  build(tk) {
    const { address, scripts, writers, bytes: bytesLib } = tk;
    const h = hub(tk);
    const loop = scripts.registryScript("loop_v2");
    const loopHash = scripts.registryHash("loop_v2");
    const loopAddress = address.enterpriseAddress(h.net, address.scriptCred(loopHash));

    const holder: Utxo = { ...h.holderOrder, scriptRef: loop, value: { ...h.holderOrder.value } };
    const scriptInput: Utxo = { ...h.scriptInput, address: loopAddress };
    const utxos = [holder, h.holderBurn, scriptInput, h.walletInput, h.funding];
    const ctx = { ...h.ctx, utxos };
    const refOf = (u: Utxo) => `${u.ref.txHash}#${u.ref.index}`;

    return {
      files: { "s02-loop.debugger-context.json": writers.debuggerContextFile({ tx: h.tx, ctx }) },
      manifest: {
        "s02.contextFile": "s02-loop.debugger-context.json",
        // the transaction is S1's: same bytes, same hash, same handle
        "s02.txHash": h.tx.txHash,
        "s02.txId": writers.txHandle(h.net, h.tx.txHash),
        "s02.network": h.net,
        "s02.redeemers": ["spend:2", "mint:1"],
        "s02.loopHash": loopHash,
        "s02.loopHex": bytesLib.bytesToHex(loop.bytes),
        "s02.loopSize": loop.bytes.length,
        "s02.loopAddress": loopAddress.bech32,
        "s02.loopHolder": refOf(holder),
        "s02.utxos": utxos.map(refOf),
        "s02.spendIndex": 2,
        "s02.evalTimeoutMs": 2000,
      },
    };
  },
};
