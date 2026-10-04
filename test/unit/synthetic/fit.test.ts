import { describe, expect, it } from "vitest";

import { drepIdBech32, keyCred, poolIdBech32, scriptCred } from "../../fixtures/synthetic/lib/address.js";
import { bytesToHex, utf8Hex } from "../../fixtures/synthetic/lib/bytes.js";
import { encode, uint } from "../../fixtures/synthetic/lib/cbor.js";
import {
  accountContext,
  drepContext,
  govActionContext,
  poolContext,
  utxo,
  produced,
  type ChainContext,
} from "../../fixtures/synthetic/lib/context.js";
import { fit, formulaMinFee, minUtxoCoin, neededKeyHashes, referenceScriptFee, referenceScriptBytes, resolveMinCoins, slack } from "../../fixtures/synthetic/lib/fit.js";
import { byteString, app, flatProgram, lam, lams, unit, error as uplcError } from "../../fixtures/synthetic/lib/flat.js";
import { drepKey, paymentKey, poolKey } from "../../fixtures/synthetic/lib/keys.js";
import { constr, datumHash, pInt, pMap, UNIT } from "../../fixtures/synthetic/lib/plutusData.js";
import { native, plutusFromFlat, scriptHash } from "../../fixtures/synthetic/lib/script.js";
import { outputCbor, txin, type TxSpec } from "../../fixtures/synthetic/lib/tx.js";
import { errorKinds, validate } from "../../fixtures/synthetic/lib/validator.js";
import { alice, aliceAddr, aliceStakeAddr, bobAddr, fundsUtxo, h, looping, scriptAddress, scriptStakeAddress, succeeds, worldCtx } from "./world.js";

const change = { address: aliceAddr, value: { coin: "min" as const }, change: true };
const REDEEMER_PLACEHOLDER = { mem: 1n, steps: 1n };

describe("fit: payments", () => {
  const funds = fundsUtxo();
  const ctx = worldCtx([funds]);
  const base: TxSpec = { inputs: [funds.ref], outputs: [{ address: bobAddr, value: { coin: 10_000_000n } }, change], ttl: ctx.slot + 1000n };

  it("builds a valid transaction: exact minimum fee, balanced, signed", () => {
    const f = fit(base, { ctx, keys: [alice.pay] });
    expect(f.validation.errors).toEqual([]);
    expect(f.validation.warnings).toEqual([]);
    expect(f.tx.size).toBe(f.tx.bytes.length);
    expect(f.spec.outputs[1]!.value.coin).toBe(funds.value.coin - 10_000_000n - f.spec.fee!);
    expect(f.spec.signers).toEqual([alice.pay]);
    expect(f.rounds).toBeLessThanOrEqual(4);
  });

  it("is deterministic", () => {
    expect(fit(base, { ctx, keys: [alice.pay] }).tx.hex).toBe(fit(base, { ctx, keys: [alice.pay] }).tx.hex);
  });

  it("also under protocol version 11", () => {
    const f = fit(base, { ctx: worldCtx([funds], "pv11"), keys: [alice.pay] });
    expect(f.validation.errors).toEqual([]);
  });

  it("coin 'min' is the minimum UTxO value, settled on the output's own size (and the validator accepts it)", () => {
    const policy = h("p").slice(0, 56);
    const rich = utxo({ ref: `${h("rich")}#0`, address: aliceAddr, coin: 90_000_000n, assets: { [policy]: { [utf8Hex("T")]: 1n } } });
    const richCtx = worldCtx([rich]);
    const f = fit({ inputs: [rich.ref], outputs: [{ address: bobAddr, value: { coin: "min", assets: { [policy]: { [utf8Hex("T")]: 1n } } } }, change] }, { ctx: richCtx, keys: [alice.pay] });
    const out = f.spec.outputs[0]!;
    const size = BigInt(encode(outputCbor(out)).length);
    expect(out.value.coin).toBe((160n + size) * BigInt(richCtx.params.adaPerUtxoByte));
    expect(f.validation.errors).toEqual([]);
  });

  it("feeAdjust: one lovelace under the minimum is exactly FeeTooSmallUTxO, over it a FeeIsBiggerThanMinFee warning", () => {
    const low = fit(base, { ctx, keys: [alice.pay], feeAdjust: -1n, expect: { errors: ["FeeTooSmallUTxO"] } });
    const exact = fit(base, { ctx, keys: [alice.pay] });
    expect(low.spec.fee).toBe(exact.spec.fee! - 1n);
    // the validator warns only when the fee is more than 10 % over the minimum
    const near = fit(base, { ctx, keys: [alice.pay], feeAdjust: 1234n, expect: { errors: [], warnings: [] } });
    expect(near.spec.fee).toBe(exact.spec.fee! + 1234n);
    const high = fit(base, { ctx, keys: [alice.pay], feeAdjust: exact.spec.fee! / 10n + 2n, expect: { errors: [], warnings: ["FeeIsBiggerThanMinFee"] } });
    expect(high.spec.fee).toBe(exact.spec.fee! + exact.spec.fee! / 10n + 2n);
    expect(formulaMinFee(exact.tx, ctx)).toBe(exact.spec.fee);
  });

  it("a fixed fee is not searched for", () => {
    const f = fit(base, { ctx, keys: [alice.pay], fee: 300_000n, expect: "any" }); // more than 10 % over the minimum
    expect(f.spec.fee).toBe(300_000n);
    expect(f.validation.warnings.map((w) => Object.keys(w.warning as object)[0])).toEqual(["FeeIsBiggerThanMinFee"]);
  });

  it("assets in the inputs come back in the change output; a burn is taken out of the balance", () => {
    const policy = scriptHash(native({ type: "sig", keyHash: alice.pay.keyHashHex }));
    const name = utf8Hex("COIN");
    const withAssets = utxo({ ref: `${h("assets")}#0`, address: aliceAddr, coin: 50_000_000n, assets: { [policy]: { [name]: 10n } } });
    const c = worldCtx([withAssets]);
    const kept = fit({ inputs: [withAssets.ref], outputs: [change] }, { ctx: c, keys: [alice.pay] });
    expect(kept.spec.outputs[0]!.value.assets).toEqual({ [policy]: { [name]: 10n } });
    const nat = native({ type: "sig", keyHash: alice.pay.keyHashHex });
    const burned = fit(
      { inputs: [withAssets.ref], outputs: [change], mint: [{ policy, assets: { [name]: -4n } }], nativeScripts: [nat.script] },
      { ctx: c, keys: [alice.pay] },
    );
    expect(burned.spec.outputs[0]!.value.assets).toEqual({ [policy]: { [name]: 6n } });
    expect(burned.validation.errors).toEqual([]);
  });

  it("clear errors: no key, not enough money, a mismatched expectation, an unknown input", () => {
    expect(() => fit(base, { ctx, keys: [] })).toThrow(/no key given for key hash/);
    expect(() => fit({ ...base, outputs: [{ address: bobAddr, value: { coin: 900_000_000n } }, change] }, { ctx, keys: [alice.pay] })).toThrow(/do not cover/);
    expect(() => fit(base, { ctx, keys: [alice.pay], feeAdjust: -1n })).toThrow(/expected a valid transaction, got errors \[FeeTooSmallUTxO\]/);
    expect(() => fit(base, { ctx, keys: [alice.pay], expect: { errors: ["Nope"] } })).toThrow(/expected errors \[Nope\]/);
    expect(() => fit({ ...base, inputs: [txin(h("unknown"), 0)] }, { ctx, keys: [alice.pay] })).toThrow(/not in the chain context/);
    expect(() => fit({ ...base, outputs: [{ address: bobAddr, value: { coin: 1_000_000n } }, change, change] }, { ctx, keys: [alice.pay] })).toThrow(/more than one change/);
  });

  it("keys come from the key book by the hashes the transaction needs; explicit signers win; required signers count", () => {
    const extra = paymentKey("test-extra");
    const f = fit({ ...base, requiredSigners: [extra.keyHashHex] }, { ctx, keys: [extra, alice.pay] });
    expect(f.spec.signers!.map((k) => k.keyHashHex).sort()).toEqual([alice.pay.keyHashHex, extra.keyHashHex].sort());
    expect(neededKeyHashes({ ...base, requiredSigners: [extra.keyHashHex] }, ctx).sort()).toEqual([alice.pay.keyHashHex, extra.keyHashHex].sort());
    const explicit = fit({ ...base, signers: [alice.pay] }, { ctx });
    expect(explicit.spec.signers).toEqual([alice.pay]);
    expect(explicit.validation.errors).toEqual([]);
  });

  it("an extraneous signature is a validator error (the vkey count must match what is needed)", () => {
    fit({ ...base, signers: [alice.pay, paymentKey("test-stranger")] }, { ctx, expect: { errors: ["ExtraneousSignature"] } });
  });
});

describe("fit: scripts", () => {
  const collateral = fundsUtxo("collateral", 30_000_000n, 1);
  const fees = fundsUtxo("fees", 200_000_000n, 0);

  function spendCase(version: 1 | 2 | 3, lock: "hash" | "inline") {
    const script = succeeds(version);
    const hash = scriptHash(script);
    const datum = constr(0, [pInt(42)]);
    const locked = utxo({
      ref: `${h(`locked ${version} ${lock}`)}#0`,
      address: scriptAddress(hash),
      coin: 20_000_000n,
      ...(lock === "hash" ? { datumHash: datumHash(datum) } : { inlineDatum: datum }),
    });
    const ctx = worldCtx([locked, collateral, fees]);
    const spec: TxSpec = {
      inputs: [locked.ref, fees.ref],
      outputs: [change],
      collateral: [collateral.ref],
      plutusScripts: [script],
      ...(lock === "hash" ? { datums: [datum] } : {}),
      redeemers: [{ target: { tag: "spend", input: locked.ref }, data: UNIT, exUnits: REDEEMER_PLACEHOLDER }],
    };
    return { ctx, spec };
  }

  it.each([
    [1, "hash"],
    [2, "hash"],
    [2, "inline"],
    [3, "inline"],
  ] as const)("a Plutus V%i spend locked with a datum %s is fully valid (script data hash, ex-units, fee, collateral)", (version, lock) => {
    const { ctx, spec } = spendCase(version, lock);
    const f = fit(spec, { ctx, keys: [alice.pay] });
    expect(f.validation.errors).toEqual([]);
    expect(f.validation.phase2_errors).toEqual([]);
    expect(f.validation.phase2_warnings).toEqual([]);
    const r = f.validation.eval_redeemer_results[0]!;
    expect(r.success).toBe(true);
    expect(r.plutus_version).toBe(`V${version}`);
    expect(BigInt(r.provided_ex_units.mem)).toBe(BigInt(r.calculated_ex_units!.mem));
    expect(BigInt(r.provided_ex_units.steps)).toBe(BigInt(r.calculated_ex_units!.steps));
    expect(f.tx.scriptDataHash).toHaveLength(64);
    // collateral: 150 % of the fee, return output for the surplus
    expect(f.spec.totalCollateral).toBe((f.spec.fee! * 150n + 99n) / 100n);
    expect(f.spec.collateralReturn!.value.coin).toBe(collateral.value.coin - f.spec.totalCollateral!);
    expect(f.tx.redeemers[0]).toMatchObject({ tagNumber: 0, index: f.tx.inputs.findIndex((i) => i.txHash === spec.inputs[0]!.txHash) });
  });

  it("works under protocol version 11 as well", () => {
    const { ctx, spec } = spendCase(2, "hash");
    const f = fit(spec, { ctx: { ...ctx, params: worldCtx([], "pv11").params }, keys: [alice.pay] });
    expect(f.validation.errors).toEqual([]);
    expect(f.validation.phase2_errors).toEqual([]);
  });

  it("ex-units: exact by default, a slack makes declared > calculated (BudgetIsBiggerThanExpected), 'declared' keeps the spec's numbers", () => {
    const { ctx, spec } = spendCase(2, "hash");
    const exact = fit(spec, { ctx, keys: [alice.pay] });
    const calc = exact.validation.eval_redeemer_results[0]!.calculated_ex_units!;
    const slackened = fit(spec, { ctx, keys: [alice.pay], exUnits: slack(0.25, 0.5), expect: { errors: [], phase2Warnings: ["BudgetIsBiggerThanExpected"] } });
    const declared = slackened.validation.eval_redeemer_results[0]!.provided_ex_units;
    expect(BigInt(declared.mem)).toBeGreaterThan(BigInt(calc.mem));
    expect(BigInt(declared.steps)).toBe(BigInt(calc.steps) + BigInt(Math.ceil(Number(calc.steps) * 0.5)));
    expect(slackened.spec.fee).toBeGreaterThan(exact.spec.fee!);
    expect(formulaMinFee(exact.tx, ctx)).toBe(exact.spec.fee);
    expect(formulaMinFee(slackened.tx, ctx)).toBe(slackened.spec.fee);
    const kept = fit(
      { ...spec, redeemers: [{ ...spec.redeemers![0]!, exUnits: { mem: 9_999n, steps: 99_999n } }] },
      { ctx, keys: [alice.pay], exUnits: "declared", expect: "any" },
    );
    expect(BigInt(kept.validation.eval_redeemer_results[0]!.provided_ex_units.steps)).toBe(99_999n);
    const fn = fit(spec, { ctx, keys: [alice.pay], exUnits: (c) => ({ mem: c.mem + 7n, steps: c.steps + 11n }), expect: { phase2Warnings: ["BudgetIsBiggerThanExpected"] } });
    expect(BigInt(fn.validation.eval_redeemer_results[0]!.provided_ex_units.mem)).toBe(BigInt(calc.mem) + 7n);
  });

  it("a wrong script data hash is exactly ScriptDataHashMismatch", () => {
    const { ctx, spec } = spendCase(2, "hash");
    const f = fit({ ...spec, scriptDataHash: "00".repeat(32) }, { ctx, keys: [alice.pay], expect: { errors: ["ScriptDataHashMismatch"] } });
    expect(f.tx.scriptDataHash).toBe("00".repeat(32));
    // a hash taken with the wrong language views is wrong the same way
    fit({ ...spec, languages: [1] }, { ctx, keys: [alice.pay], expect: { errors: ["ScriptDataHashMismatch"] } });
  });

  it("a script that fails is a phase-2 error, with the ex-units left as declared", () => {
    const bad = plutusFromFlat(2, flatProgram(lams(3, uplcError())));
    const datum = constr(0, []);
    const locked = utxo({ ref: `${h("failing")}#0`, address: scriptAddress(scriptHash(bad)), coin: 5_000_000n, datumHash: datumHash(datum) });
    const ctx = worldCtx([locked, collateral, fees]);
    const f = fit(
      { inputs: [locked.ref, fees.ref], outputs: [change], collateral: [collateral.ref], plutusScripts: [bad], datums: [datum], redeemers: [{ target: { tag: "spend", input: locked.ref }, data: UNIT, exUnits: { mem: 500_000n, steps: 200_000_000n } }] },
      { ctx, keys: [alice.pay], exUnits: "declared", expect: { phase2Errors: 1 } },
    );
    expect(f.validation.eval_redeemer_results[0]!.success).toBe(false);
  });

  it("an omega loop is the one script the validator never finishes: build it with validate: false (fee by formula, declared ex-units, no evaluation)", () => {
    const loop = looping(2);
    const datum = constr(0, []);
    const locked = utxo({ ref: `${h("looping")}#0`, address: scriptAddress(scriptHash(loop)), coin: 5_000_000n, datumHash: datumHash(datum) });
    const ctx = worldCtx([locked, collateral, fees]);
    const spec: TxSpec = {
      inputs: [locked.ref, fees.ref],
      outputs: [change],
      collateral: [collateral.ref],
      plutusScripts: [loop],
      datums: [datum],
      redeemers: [{ target: { tag: "spend", input: locked.ref }, data: UNIT, exUnits: { mem: 14_000_000n, steps: 10_000_000_000n } }],
    };
    const f = fit(spec, { ctx, keys: [alice.pay], validate: false });
    expect(f.validated).toBe(false);
    expect(f.validation.eval_redeemer_results).toEqual([]);
    expect(f.spec.fee).toBe(formulaMinFee(f.tx, ctx));
    expect(BigInt(f.tx.redeemers[0]!.exUnits.steps)).toBe(10_000_000_000n);
    expect(f.spec.totalCollateral).toBe((f.spec.fee! * 150n + 99n) / 100n);
  });

  it("validate: false agrees with the validator's fee on an ordinary transaction", () => {
    const { ctx, spec } = spendCase(2, "hash");
    const exact = fit(spec, { ctx, keys: [alice.pay] });
    const declaredUnits = exact.spec.redeemers!;
    const quick = fit({ ...spec, redeemers: declaredUnits }, { ctx, keys: [alice.pay], validate: false, exUnits: "declared" });
    expect(quick.spec.fee).toBe(exact.spec.fee);
    expect(quick.tx.hex).toBe(exact.tx.hex);
  });

  it("minting: a V2 policy and a native policy in one transaction, a burn as well", () => {
    const v2 = succeeds(2);
    const nat = native({ type: "sig", keyHash: alice.pay.keyHashHex });
    const p2 = scriptHash(v2);
    const pn = scriptHash(nat);
    const ctx = worldCtx([collateral, fees]);
    const f = fit(
      {
        inputs: [fees.ref],
        outputs: [change],
        collateral: [collateral.ref],
        mint: [
          { policy: p2, assets: { [utf8Hex("ONE")]: 5n } },
          { policy: pn, assets: { [utf8Hex("TWO")]: 7n } },
        ],
        plutusScripts: [v2],
        nativeScripts: [nat.script],
        redeemers: [{ target: { tag: "mint", policy: p2 }, data: UNIT, exUnits: REDEEMER_PLACEHOLDER }],
      },
      { ctx, keys: [alice.pay] },
    );
    expect(f.validation.errors).toEqual([]);
    expect(f.spec.outputs[0]!.value.assets).toEqual({ [p2]: { [utf8Hex("ONE")]: 5n }, [pn]: { [utf8Hex("TWO")]: 7n } });
    expect(f.tx.redeemers[0]).toMatchObject({ tagNumber: 1, index: f.tx.mintPolicies.indexOf(p2) });
  });

  it("zero withdrawal from a script stake address and a script certificate, plus a key withdrawal that sorts after it", () => {
    const sc = succeeds(2);
    const hash = scriptHash(sc);
    const scriptStake = scriptStakeAddress(hash);
    const ctx = worldCtx([collateral, fees], "pv10", {
      accounts: [
        accountContext({ cred: scriptCred(hash), balance: 0 }),
        accountContext({ cred: keyCred(alice.stake), balance: 7_000_000, drep: drepIdBech32(keyCred(drepKey("test-drep"))) }),
      ],
      dreps: [drepContext(keyCred(drepKey("test-drep")))],
    });
    const f = fit(
      {
        inputs: [fees.ref],
        outputs: [change],
        collateral: [collateral.ref],
        withdrawals: [
          { account: aliceStakeAddr, amount: 7_000_000n },
          { account: scriptStake, amount: 0n },
        ],
        certs: [{ kind: "stakeDereg", cred: scriptCred(hash) }],
        plutusScripts: [sc],
        redeemers: [
          { target: { tag: "reward", account: scriptStake }, data: UNIT, exUnits: REDEEMER_PLACEHOLDER },
          { target: { tag: "cert", index: 0 }, data: UNIT, exUnits: REDEEMER_PLACEHOLDER },
        ],
      },
      { ctx, keys: [alice.pay, alice.stake] },
    );
    expect(f.validation.errors).toEqual([]);
    expect(f.validation.eval_redeemer_results.map((r) => [r.tag, r.index, r.success])).toEqual([["Cert", 0, true], ["Reward", 0, true]]);
    // refund of the key deposit and the withdrawal are in the balance
    expect(f.spec.outputs[0]!.value.coin).toBe(fees.value.coin + 7_000_000n + 2_000_000n - f.spec.fee!);
  });

  it("reference inputs: a reference script is used without a witness script, and the reference-script fee matches the validator's tiers", () => {
    const script = succeeds(2);
    const hash = scriptHash(script);
    // a V2 program carrying a big constant, so the reference-script size crosses the 25 KiB fee tier
    const big = plutusFromFlat(2, flatProgram(lams(3, app(lam(unit()), byteString(new Uint8Array(13_000).fill(1))))));
    const ref1 = utxo({ ref: `${h("ref1")}#0`, address: bobAddr, coin: 30_000_000n, scriptRef: script });
    const ref2 = utxo({ ref: `${h("ref2")}#0`, address: bobAddr, coin: 30_000_000n, scriptRef: big });
    const ref3 = utxo({ ref: `${h("ref3")}#0`, address: bobAddr, coin: 30_000_000n, scriptRef: big });
    const datum = constr(0, []);
    const locked = utxo({ ref: `${h("refspend")}#0`, address: scriptAddress(hash), coin: 5_000_000n, datumHash: datumHash(datum) });
    const ctx = worldCtx([ref1, ref2, ref3, locked, collateral, fees]);
    const spec: TxSpec = {
      inputs: [locked.ref, fees.ref],
      referenceInputs: [ref1.ref],
      outputs: [change],
      collateral: [collateral.ref],
      datums: [datum],
      redeemers: [{ target: { tag: "spend", input: locked.ref }, data: UNIT, exUnits: REDEEMER_PLACEHOLDER }],
    };
    const one = fit(spec, { ctx, keys: [alice.pay] });
    expect(one.validation.errors).toEqual([]);
    expect(one.tx.witnessScriptHashes).toEqual([]);
    expect(one.tx.languages).toEqual([2]);
    // the reference-script fee, checked against the validator's own decomposition at several sizes
    for (const refs of [[ref1], [ref1, ref2], [ref1, ref2, ref3]]) {
      const s: TxSpec = { ...spec, referenceInputs: refs.map((r) => r.ref) };
      const f = fit(s, { ctx, keys: [alice.pay], feeAdjust: -1n, expect: { errors: ["FeeTooSmallUTxO"] } });
      const diag = f.validation.errors[0]!.error as { FeeTooSmallUTxO: { fee_decomposition: { referenceScriptsFee: number | string } } };
      const bytes = referenceScriptBytes(s, ctx);
      expect(BigInt(diag.FeeTooSmallUTxO.fee_decomposition.referenceScriptsFee)).toBe(referenceScriptFee(bytes, ctx.params.referenceScriptCostPerByte));
      // the whole formula (size - 1, execution units, reference scripts) is the validator's number
      const reported = BigInt((f.validation.errors[0]!.error as { FeeTooSmallUTxO: { min_fee: number | string } }).FeeTooSmallUTxO.min_fee);
      expect(formulaMinFee(f.tx, ctx)).toBe(reported);
    }
    expect(referenceScriptBytes({ ...spec, referenceInputs: [ref1.ref, ref2.ref, ref3.ref] }, ctx)).toBeGreaterThan(25_600);
  });

  it("a reference input that is also an input is exactly ReferenceInputOverlapsWithInput", () => {
    const f = fundsUtxo("overlap", 50_000_000n, 2);
    const ctx = worldCtx([f]);
    fit({ inputs: [f.ref], referenceInputs: [f.ref], outputs: [change] }, { ctx, keys: [alice.pay], expect: { errors: ["ReferenceInputOverlapsWithInput"] } });
  });

  it("several defects at once, in the validator's order: underpaid fee, wrong script data hash, overlapping reference input, two oversized budgets", () => {
    const spendScript = succeeds(2);
    const mintScript = succeeds(2);
    const datum = constr(0, [pInt(1)]);
    const locked = utxo({ ref: `${h("defects locked")}#0`, address: scriptAddress(scriptHash(spendScript)), coin: 10_000_000n, datumHash: datumHash(datum) });
    const refHolder = utxo({ ref: `${h("defects ref")}#0`, address: aliceAddr, coin: 10_000_000n, scriptRef: mintScript });
    const ctx = worldCtx([locked, collateral, fees, refHolder]);
    const policy = scriptHash(mintScript);
    const f = fit(
      {
        inputs: [locked.ref, fees.ref],
        referenceInputs: [refHolder.ref, fees.ref],
        outputs: [change],
        collateral: [collateral.ref],
        plutusScripts: [spendScript],
        datums: [datum],
        mint: [{ policy, assets: { "41": 1n } }],
        scriptDataHash: "11".repeat(32),
        redeemers: [
          { target: { tag: "spend", input: locked.ref }, data: UNIT, exUnits: REDEEMER_PLACEHOLDER },
          { target: { tag: "mint", policy }, data: UNIT, exUnits: REDEEMER_PLACEHOLDER },
        ],
      },
      {
        ctx,
        keys: [alice.pay],
        feeAdjust: -1n,
        exUnits: slack(0.2, 0.3),
        expect: { errors: ["FeeTooSmallUTxO", "ScriptDataHashMismatch", "ReferenceInputOverlapsWithInput"], phase2Warnings: ["BudgetIsBiggerThanExpected", "BudgetIsBiggerThanExpected"] },
      },
    );
    expect(f.validation.eval_redeemer_results.map((r) => r.success)).toEqual([true, true]);
  });

  it("transactions chain: produced() turns the outputs of one fitted transaction into the UTxOs of the next", () => {
    const first = fit({ inputs: [fees.ref], outputs: [{ address: bobAddr, value: { coin: 30_000_000n } }, change] }, { ctx: worldCtx([fees]), keys: [alice.pay] });
    const made = produced(first.tx);
    expect(made.map((u) => `${u.ref.txHash}#${u.ref.index}`)).toEqual([`${first.tx.txHash}#0`, `${first.tx.txHash}#1`]);
    expect(made[0]!.value.coin).toBe(30_000_000n);
    const second = fit({ inputs: [made[1]!.ref], outputs: [change] }, { ctx: worldCtx(made), keys: [alice.pay] });
    expect(second.validation.errors).toEqual([]);
    expect(second.spec.inputs[0]).toEqual(made[1]!.ref);
  });

  it("manual collateral: the spec's return output and total are kept", () => {
    const { ctx, spec } = spendCase(2, "hash");
    const ret = { address: aliceAddr, value: { coin: 20_000_000n } };
    const f = fit({ ...spec, collateralReturn: ret, totalCollateral: collateral.value.coin - 20_000_000n }, { ctx, keys: [alice.pay], collateral: { manual: true } });
    expect(f.spec.collateralReturn).toEqual(ret);
    expect(f.spec.totalCollateral).toBe(10_000_000n);
    expect(f.validation.errors).toEqual([]);
  });

  it("minUtxoCoin / resolveMinCoins / referenceScriptFee on their own", () => {
    const out = { address: bobAddr, value: { coin: "min" as const } };
    const min = minUtxoCoin(out, worldCtx([]).params);
    expect(min).toBe((160n + BigInt(encode(outputCbor({ ...out, value: { coin: min } })).length)) * 4310n);
    const spec = resolveMinCoins({ inputs: [], outputs: [out] }, worldCtx([]).params);
    expect(spec.outputs[0]!.value.coin).toBe(min);
    expect(referenceScriptFee(0, { numerator: 15, denominator: 1 })).toBe(0n);
    expect(referenceScriptFee(1000, { numerator: 15, denominator: 1 })).toBe(15_000n);
    expect(referenceScriptFee(25_600, { numerator: 15, denominator: 1 })).toBe(384_000n);
    expect(referenceScriptFee(25_601, { numerator: 15, denominator: 1 })).toBe(384_000n + 18n);
    expect(referenceScriptFee(51_200, { numerator: 15, denominator: 1 })).toBe(384_000n + 460_800n);
  });
});

describe("fit: governance and certificates", () => {
  const funds = fundsUtxo("gov", 2_000_000_000_000n);
  const collateral = fundsUtxo("govcol", 30_000_000n, 1);
  const dk = drepKey("test-drep");
  const pk = poolKey("test-pool");
  const gaTx = h("gov action");
  const guard = succeeds(3);
  const ctx: ChainContext = worldCtx([funds, collateral], "pv10", {
    dreps: [drepContext(keyCred(dk))],
    pools: [poolContext(pk.keyHashHex)],
    accounts: [accountContext({ cred: keyCred(alice.stake), drep: drepIdBech32(keyCred(dk)), pool: poolIdBech32(pk.keyHash) })],
    govActions: [
      govActionContext(gaTx, 0, "infoAction"),
      govActionContext(gaTx, 1, "parameterChangeAction", { changedParameters: ["maxBlockExMem"] }),
      govActionContext(gaTx, 2, "parameterChangeAction", { changedParameters: ["minPoolCost"] }),
    ],
    constitution: { guardrailScriptHash: scriptHash(guard) },
    treasury: 1_000_000_000_000n,
  });

  it("a DRep vote", () => {
    const f = fit({ inputs: [funds.ref], outputs: [change], votes: [{ voter: { kind: "drep", cred: keyCred(dk) }, actions: [{ id: { txHash: gaTx, index: 0 }, vote: 1 }] }] }, { ctx, keys: [alice.pay, dk] });
    expect(f.validation.errors).toEqual([]);
    expect(f.spec.signers!.map((k) => k.keyHashHex).sort()).toEqual([alice.pay.keyHashHex, dk.keyHashHex].sort());
  });

  it("a stake-pool vote: fine on an info action and on a security-group parameter change, DisallowedVoters on an economic one (the context carries the names)", () => {
    const vote = (index: number) => ({ voter: { kind: "spo" as const, hash: pk.keyHashHex }, actions: [{ id: { txHash: gaTx, index }, vote: 1 as const }] });
    for (const index of [0, 1]) expect(fit({ inputs: [funds.ref], outputs: [change], votes: [vote(index)] }, { ctx, keys: [alice.pay, pk] }).validation.errors).toEqual([]);
    fit({ inputs: [funds.ref], outputs: [change], votes: [vote(2)] }, { ctx, keys: [alice.pay, pk], expect: { errors: ["DisallowedVoters"] } });
  });

  it("stake registration, delegation and vote delegation certificates; a DRep registration", () => {
    const newDrep = drepKey("test-new-drep");
    const f = fit(
      {
        inputs: [funds.ref],
        outputs: [change],
        certs: [
          { kind: "stakeDereg", cred: keyCred(alice.stake) },
          { kind: "stakeReg", cred: keyCred(alice.stake) },
          { kind: "stakeDelegate", cred: keyCred(alice.stake), pool: pk.keyHashHex },
          { kind: "voteDelegate", cred: keyCred(alice.stake), drep: { kind: "abstain" } },
          { kind: "drepReg", cred: keyCred(newDrep), deposit: 500_000_000n },
        ],
      },
      { ctx, keys: [alice.pay, alice.stake, newDrep] },
    );
    expect(f.validation.errors).toEqual([]);
    // deposits and the refund are in the balance: -2 ADA refund + 2 ADA deposit + 500 ADA drep deposit
    expect(f.spec.outputs[0]!.value.coin).toBe(funds.value.coin - 500_000_000n - f.spec.fee!);
  });

  it("a ParameterChange proposal whose policy hash is the constitution's guardrails script, with a V3 propose redeemer", () => {
    const f = fit(
      {
        inputs: [funds.ref],
        outputs: [change],
        collateral: [collateral.ref],
        proposals: [
          {
            deposit: 100_000_000_000n,
            rewardAccount: aliceStakeAddr,
            anchor: { url: "https://example.invalid/proposal.json", hash: h("proposal anchor") },
            action: { type: "parameterChange", update: [[16, uint(170_000_000)]], policyHash: scriptHash(guard) },
          },
        ],
        plutusScripts: [guard],
        redeemers: [{ target: { tag: "propose", index: 0 }, data: pMap([]), exUnits: REDEEMER_PLACEHOLDER }],
      },
      { ctx, keys: [alice.pay] },
    );
    expect(f.validation.errors).toEqual([]);
    expect(f.validation.eval_redeemer_results[0]).toMatchObject({ tag: "Propose", index: 0, success: true, plutus_version: "V3" });
    expect(f.spec.outputs[0]!.value.coin).toBe(funds.value.coin - 100_000_000_000n - f.spec.fee!);
  });

  it("a proposal whose policy hash is not the guardrails script is an error", () => {
    const f = fit(
      {
        inputs: [funds.ref],
        outputs: [change],
        proposals: [
          {
            deposit: 100_000_000_000n,
            rewardAccount: aliceStakeAddr,
            anchor: { url: "https://example.invalid/proposal.json", hash: h("proposal anchor") },
            action: { type: "parameterChange", update: [[16, uint(170_000_000)]], policyHash: "ab".repeat(28) },
          },
        ],
      },
      { ctx, keys: [alice.pay], expect: "any" },
    );
    expect(errorKinds(f.validation).length).toBeGreaterThan(0);
  });

  it("validate() reports a missing UTxO as a thrown error, a context as text or object is the same", () => {
    const f = fit({ inputs: [funds.ref], outputs: [change] }, { ctx, keys: [alice.pay] });
    expect(() => validate(f.tx.hex, { ...ctx, utxos: [] })).toThrow();
    expect(validate(f.tx.hex, ctx).errors).toEqual(validate(f.tx.hex, ctx).errors);
    expect(bytesToHex(f.tx.bytes)).toBe(f.tx.hex);
  });
});
