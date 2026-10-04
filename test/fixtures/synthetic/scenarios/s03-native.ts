// S3: a Spend redeemer aimed at an input that a NATIVE script guards. The input sits at the address of `ScriptAll []`
// (valid in every transaction), the witness set carries that native script and a Plutus-style Spend 0 redeemer for it.
// A native script is not run by the Plutus machine: the validator answers phase 2 with MissingRequiredScript for the
// redeemer, and the server adds a hint that says the target is a NATIVE script. (The transaction is built by the toolkit, signed, and fitted by the validator.)

import type { Utxo } from "../lib/context.js";
import type { Scenario } from "../lib/toolkit.js";

export const scenario: Scenario = {
  name: "s03",
  description: "A Spend redeemer aimed at an input guarded by the native script ScriptAll [] (phase 2: MissingRequiredScript).",
  build(tk) {
    const { address, keys, fit, context, params, writers, scripts, script: scriptLib, plutusData, validator } = tk;
    const net = "mainnet" as const;
    const pp = params.protocolParameters("pv10");

    const owner = keys.paymentKey("s03-owner");
    const ownerAddr = address.enterpriseAddress(net, address.keyCred(owner));
    const allEmpty = scripts.registryNative("all_empty");
    const nativeHash = scriptLib.scriptHash(allEmpty);
    const guardedAddr = address.enterpriseAddress(net, address.scriptCred(nativeHash));

    const guarded = context.utxo({ ref: `${writers.fakeHash("s03 guarded input transaction")}#0`, address: guardedAddr, coin: 6_000_000n });
    const collateral = context.utxo({ ref: `${writers.fakeHash("s03 collateral transaction")}#0`, address: ownerAddr, coin: 5_000_000n });
    const spare = context.utxo({ ref: `${writers.fakeHash("s03 collateral transaction")}#1`, address: ownerAddr, coin: 6_000_000n });
    const ctx = { network: net, params: pp, slot: 150_000_000n, utxos: [guarded, collateral, spare] };

    const fitted = fit.fit(
      {
        inputs: [guarded.ref],
        outputs: [{ address: ownerAddr, value: { coin: "min" }, change: true }],
        collateral: [collateral.ref],
        nativeScripts: [allEmpty.script],
        redeemers: [{ target: { tag: "spend", input: guarded.ref }, data: plutusData.constr(0, []), exUnits: { mem: 1_000_000n, steps: 500_000_000n } }],
      },
      { ctx, keys: [owner], exUnits: "declared", expect: "any" },
    );
    const built = fitted.tx;
    const result = fitted.validation;
    const phase2 = result.phase2_errors.map((e) => Object.keys((e as { error?: object }).error ?? e as object)[0] ?? "?");
    if (!phase2.includes("MissingRequiredScript")) throw new Error(`s03: expected a MissingRequiredScript phase-2 error, got ${JSON.stringify(result.phase2_errors).slice(0, 500)}`);
    const refOf = (u: Utxo) => `${u.ref.txHash}#${u.ref.index}`;

    return {
      files: { "s03-native-target.debugger-context.json": writers.debuggerContextFile({ tx: built, ctx }) },
      manifest: {
        "s03.contextFile": "s03-native-target.debugger-context.json",
        "s03.txHash": built.txHash,
        "s03.txId": writers.txHandle(net, built.txHash),
        "s03.network": net,
        "s03.size": built.size,
        "s03.fee": fitted.spec.fee!,
        "s03.redeemerRef": "spend:0",
        "s03.nativeScriptHash": nativeHash,
        "s03.guardedInput": refOf(guarded),
        "s03.guardedAddress": guardedAddr.bech32,
        "s03.utxos": ctx.utxos.map(refOf),
        "s03.phase2Errors": phase2,
        "s03.phase1Errors": validator.errorKinds(result),
      },
    };
  },
};
