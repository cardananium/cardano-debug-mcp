// S1: the hub scenario. A multi-script Plutus V2 transaction that burns tokens: one spend (the order-book validator
// `order_fixed`, redeemer Cancel) and two mints (mint:0 a 3-of-6 native script, mint:1 the V2 policy `burn_mint`,
// redeemer Burn), both scripts and the native one carried as reference scripts. The DebuggerContext it is written as is
// loaded by `tx_load(bundle=<path>)` in about twenty test files, so its shape is a contract (see the list below).
//
// Contract (what the consumer tests pin; every number comes from the manifest, none is hard-coded in a test):
//   - 5 UTxOs in the context, in this order: [V2 reference-script holder (order_fixed), V2 reference-script holder (burn_mint),
//     script input (datum hash AND string inline datum, 3 tokens with the empty asset name, native reference script),
//     wallet input (4 asset units), funding input (pure ADA, also the collateral)];
//   - transaction: 3 inputs, 3 reference inputs with one overlap (the script input), 2 mint policies, redeemers
//     spend:2 (Cancel, operator as required signer) and mint:1 (Burn), 4 vkey witnesses, collateral + return + total,
//     out0 = a 29-byte enterprise script address with an inline datum and a native script reference, plain arrays (no tag
//     258), array-form redeemers, no auxiliary data, no validity interval;
//   - the validator, run on the DebuggerContext import's own parameters, answers: spend:2 and mint:1 succeed (fidelity
//     full, ex-units verdict `slack`), phase 1 reports exactly FeeTooSmallUTxO, ScriptDataHashMismatch and
//     ReferenceInputOverlapsWithInput (errors, in this order, no warnings) and phase 2 warns BudgetIsBiggerThanExpected
//     twice: five diagnostics, verdict phase1_failed.
//
// All of it is artificial: keys, ids, datums, the burned token, the order. The scripts are the registry's `order_fixed`
// and `burn_mint` and the native `multisig_3_of_6`.

import type { ProtocolParameters } from "@cardananium/cquisitor-lib";

import type { ChainContext, Utxo } from "../lib/context.js";
import type { Toolkit } from "../lib/toolkit.js";
import type { Scenario } from "../lib/toolkit.js";
import type { BuiltTx, TxSpec } from "../lib/tx.js";
import type { ValidationResult } from "../lib/validator.js";
import { measureHub } from "./s01-measure.js";

export const HUB_NETWORK = "mainnet" as const;
/** An arbitrary mainnet slot (the transaction has no validity interval; the importer's wall-clock slot gives the same answers). */
export const HUB_SLOT = 150_000_000n;
/** How far below the validator's minimum fee the transaction pays (lovelace). */
const FEE_SHORTFALL = 25_000n;
const BURN_QUANTITY = 15_000_000_000_000n;
const BURN_HELD = 15_015_000_994_000n;

export interface HubModel {
  net: typeof HUB_NETWORK;
  ctx: ChainContext;
  /** `ctx.utxos` in the DebuggerContext order. */
  holderOrder: Utxo;
  holderBurn: Utxo;
  scriptInput: Utxo;
  walletInput: Utxo;
  funding: Utxo;
  tx: BuiltTx;
  spec: TxSpec;
  validation: ValidationResult;
  /** The script data hash a correct builder would have written (the transaction carries the stale one). */
  correctScriptDataHash: string;
  /** Every identity and hash the manifest and the sibling scenarios need. */
  ids: Record<string, string>;
  datum: { input: string; output: string; inputHash: string };
  tokens: { burnName: string; burnPolicy: string; burnHeld: bigint; burnQuantity: bigint; nativePolicy: string; policyA: string; policyB: string };
}

const cache = new WeakMap<object, HubModel>();

/** Build the S1 model once per toolkit (S2 reuses its transaction and chain context). */
export function hub(tk: Toolkit): HubModel {
  const hit = cache.get(tk);
  if (hit) return hit;
  const model = buildHub(tk);
  cache.set(tk, model);
  return model;
}

function buildHub(tk: Toolkit): HubModel {
  const { address, keys, fit, context, params, writers, scripts, plutusData, tx: txlib, bytes: bytesLib, validator } = tk;
  const { constr, pBytes, pInt } = plutusData;
  const net = HUB_NETWORK;
  const pp = params.protocolParameters("pv10");

  // ---- identities
  const operator = keys.paymentKey("script-operator"); // the key hard-coded into order_fixed; here also the wallet owner
  const walletStake = keys.stakeKey("s01-wallet");
  const maker = keys.paymentKey("s01-order-maker");
  const signers = [1, 2, 3].map((n) => keys.paymentKey(`native-signer-${n}`));
  const walletAddr = address.baseAddress(net, address.keyCred(operator), address.keyCred(walletStake));
  const enterprise = (hash: string) => address.enterpriseAddress(net, address.scriptCred(hash));

  // ---- scripts
  const spendScript = scripts.registryScript("order_fixed");
  const burnScript = scripts.registryScript("burn_mint");
  const multisig = scripts.registryNative("multisig_3_of_6");
  const spendHash = scripts.registryHash("order_fixed");
  const burnPolicy = scripts.registryHash("burn_mint");
  const nativePolicy = tk.script.scriptHash(multisig);
  const spendAddr = enterprise(spendHash);

  // ---- tokens
  const policyA = writers.fakeHash("s01 policy A (receipt)", 28);
  const policyB = writers.fakeHash("s01 policy B (the sold token)", 28);
  const policyC = writers.fakeHash("s01 policy C", 28);
  const policyD = writers.fakeHash("s01 policy D", 28);
  const policyE = writers.fakeHash("s01 policy E", 28);
  const burnName = bytesLib.utf8Hex("OBOL");

  // ---- the order (datum of the script input) and its relisting (datum of out0)
  const orderDatum = (price: number, memo: string) =>
    constr(0, [
      constr(0, [constr(0, [pBytes(maker.keyHashHex)]), constr(1, [])]), // maker: key address without a stake part
      pBytes(policyB),
      pBytes(""),
      pInt(price),
      pInt(1),
      pInt(1_900_000_000_000),
      pBytes(bytesLib.utf8Hex(memo)),
    ]);
  const datumIn = orderDatum(250_000_000, "synthetic order 0001");
  const datumOut = orderDatum(240_000_000, "synthetic order 0001, relisted");
  const datumInHex = plutusData.encodePlutusDataHex(datumIn);
  const datumOutHex = plutusData.encodePlutusDataHex(datumOut);

  // ---- chain: the UTxOs
  const holderTx = writers.fakeHash("s01 reference script holder transaction");
  const walletTx = writers.fakeHash("s01 wallet funding transaction");
  const orderTx = writers.fakeHash("s01 order transaction");
  if (!(walletTx < orderTx)) throw new Error("s01: relabel the transactions: the script input must sort last among the inputs (spend:2)");
  const holderAddr = enterprise(writers.fakeHash("s01 holder script (nobody can spend it)", 28));
  const minCoin = (u: { address: ReturnType<typeof enterprise>; assets?: Record<string, Record<string, bigint>>; inlineDatum?: ReturnType<typeof constr>; scriptRef?: ReturnType<typeof scripts.registryScript> | typeof multisig }) =>
    fit.minUtxoCoin({ address: u.address, value: { coin: "min", assets: u.assets }, inlineDatum: u.inlineDatum, scriptRef: u.scriptRef }, pp);

  const holderOrder = context.utxo({ ref: `${holderTx}#1`, address: holderAddr, coin: minCoin({ address: holderAddr, scriptRef: spendScript }) + 1_204_000n, scriptRef: spendScript });
  const holderBurn = context.utxo({ ref: `${holderTx}#3`, address: holderAddr, coin: minCoin({ address: holderAddr, scriptRef: burnScript }) + 902_000n, scriptRef: burnScript });
  const scriptInputAssets = { [nativePolicy]: { "": 1n }, [policyA]: { "": 1n }, [policyB]: { "": 1n } };
  const scriptInput = context.utxo({
    ref: `${orderTx}#0`,
    address: spendAddr,
    coin: minCoin({ address: spendAddr, assets: scriptInputAssets, inlineDatum: datumIn, scriptRef: multisig }) + 107_000n,
    assets: scriptInputAssets,
    datumHash: plutusData.datumHash(datumIn),
    inlineDatum: datumIn,
    scriptRef: multisig,
  });
  const walletAssets = {
    [burnPolicy]: { [burnName]: BURN_HELD },
    [policyC]: { [bytesLib.utf8Hex("SYNTH-A")]: 5_000_000n },
    [policyD]: { [bytesLib.utf8Hex("SYNTH-B")]: 20_250_010n },
    [policyE]: { [bytesLib.utf8Hex("Synthetic Manager NFT 0001")]: 1n },
  };
  const walletInput = context.utxo({ ref: `${walletTx}#1`, address: walletAddr, coin: 3_250_000n, assets: walletAssets });
  const funding = context.utxo({ ref: `${walletTx}#2`, address: walletAddr, coin: 312_500_000n });
  const ctx: ChainContext = { network: net, params: pp, slot: HUB_SLOT, utxos: [holderOrder, holderBurn, scriptInput, walletInput, funding] };

  // ---- the transaction
  const keptAssets = { ...walletAssets, [burnPolicy]: { [burnName]: BURN_HELD - BURN_QUANTITY } };
  const spec0: TxSpec = {
    inputs: [walletInput.ref, funding.ref, scriptInput.ref],
    referenceInputs: [holderOrder.ref, holderBurn.ref, scriptInput.ref], // scriptInput twice: ReferenceInputOverlapsWithInput
    outputs: [
      { address: spendAddr, value: { coin: "min", assets: { [policyA]: { "": 1n }, [policyB]: { "": 1n } } }, inlineDatum: datumOut, scriptRef: multisig, label: "relisted order" },
      { address: walletAddr, value: { coin: "min", assets: keptAssets }, label: "wallet tokens" },
      { address: walletAddr, value: { coin: "min" }, change: true, label: "change" },
    ],
    collateral: [funding.ref],
    mint: [
      { policy: nativePolicy, assets: { "": -1n } },
      { policy: burnPolicy, assets: { [burnName]: -BURN_QUANTITY } },
    ],
    requiredSigners: [operator.keyHashHex],
    signers: [operator, ...signers], // the wallet / operator key + the three signers of the 3-of-6 native script
    redeemers: [
      { target: { tag: "spend", input: scriptInput.ref }, data: constr(0, []), exUnits: { mem: 1n, steps: 1n } }, // Cancel
      { target: { tag: "mint", policy: burnPolicy }, data: constr(1, []), exUnits: { mem: 1n, steps: 1n } }, // Burn
    ],
    scriptDataHash: "00".repeat(32), // replaced below by the stale hash
    encoding: { redeemers: "array" },
  };

  // 1. fee, ex-units, change and collateral from the real validator (the script data hash is set in a later step)
  const fitted = fit.fit(spec0, { ctx, exUnits: fit.slack(0, 0.14), feeAdjust: -FEE_SHORTFALL, expect: "any" });

  // 2. the script data hash a builder working from the previous cost-model revision would have written: stale on purpose
  const stale: ProtocolParameters = params.protocolParameters("pv10");
  stale.costModels.plutusV2 = stale.costModels.plutusV2!.map((v, i) => (i === 0 ? v - 1 : v));
  const env = context.envOf(ctx);
  const staleTx = txlib.assemble({ ...fitted.spec, scriptDataHash: "auto" }, { ...env, params: stale });
  const goodTx = txlib.assemble({ ...fitted.spec, scriptDataHash: "auto" }, env);
  const finalSpec: TxSpec = { ...fitted.spec, scriptDataHash: staleTx.scriptDataHash! };
  const built = txlib.assemble(finalSpec, env);
  if (built.size !== staleTx.size) throw new Error("s01: the transaction size moved when the script data hash was replaced");

  // 3. the contract
  const validation = validator.validate(built.hex, ctx);
  const kinds = (list: Array<Record<string, unknown> | undefined>) => list.map((x) => Object.keys(x ?? {})[0] ?? "?");
  const errors = validator.errorKinds(validation);
  const warnings = kinds(validation.warnings.map((w) => w.warning as Record<string, unknown> | undefined));
  const phase2Warnings = kinds(validation.phase2_warnings.map((w) => (w as { warning?: Record<string, unknown> }).warning));
  const expected = { errors: ["FeeTooSmallUTxO", "ScriptDataHashMismatch", "ReferenceInputOverlapsWithInput"], warnings: [] as string[], phase2Warnings: ["BudgetIsBiggerThanExpected", "BudgetIsBiggerThanExpected"] };
  const got = { errors, warnings, phase2Warnings };
  if (JSON.stringify(got) !== JSON.stringify(expected)) throw new Error(`s01: the validator's diagnostics are ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  if (validation.phase2_errors.length !== 0) throw new Error(`s01: phase 2 reports errors: ${JSON.stringify(validation.phase2_errors).slice(0, 400)}`);
  if (!validation.eval_redeemer_results.every((r) => r.success)) throw new Error("s01: a redeemer failed");
  if (built.inputs.findIndex((i) => i.txHash === scriptInput.ref.txHash && i.index === 0) !== 2) throw new Error("s01: the script input is not input 2");
  if (built.mintPolicies.indexOf(burnPolicy) !== 1) throw new Error("s01: burn_mint is not mint policy 1 (the native policy must sort before it)");

  return {
    net,
    ctx,
    holderOrder,
    holderBurn,
    scriptInput,
    walletInput,
    funding,
    tx: built,
    spec: finalSpec,
    validation,
    correctScriptDataHash: goodTx.scriptDataHash!,
    ids: {
      operatorKeyHash: operator.keyHashHex,
      makerKeyHash: maker.keyHashHex,
      holderTx,
      walletTx,
      orderTx,
      walletAddress: walletAddr.bech32,
      scriptAddress: spendAddr.bech32,
      scriptAddressHex: spendAddr.hex,
      holderAddress: holderAddr.bech32,
      spendHash,
      burnPolicy,
      nativePolicy,
      spendHashV1: tk.script.hashScriptBytes(1, spendScript.bytes),
      spendHashV3: tk.script.hashScriptBytes(3, spendScript.bytes),
    },
    datum: { input: datumInHex, output: datumOutHex, inputHash: plutusData.datumHash(datumIn) },
    tokens: { burnName, burnPolicy, burnHeld: BURN_HELD, burnQuantity: BURN_QUANTITY, nativePolicy, policyA, policyB },
  };
}


/** The two scripts and the native script as the manifest describes them (sizes, hashes, the registry's own measurements). */
function scriptFacts(tk: Toolkit, name: string): Record<string, unknown> {
  const entry = tk.scripts.loadRegistry().scripts[name]!;
  const bytes = tk.scripts.registryScript(name).bytes;
  return {
    name,
    hash: entry.hash,
    version: entry.plutusVersion,
    size: bytes.length,
    prefix: tk.bytes.bytesToHex(bytes.subarray(0, 4)),
    header: tk.bytes.bytesToHex(bytes.subarray(0, 3)),
    registry: {
      termCount: entry.termCount,
      uplcLines: entry.uplcLines,
      pseudocodeLines: entry.pseudocodeLines,
      pseudocodeMaxIndent: entry.pseudocodeMaxIndent,
      debuggerListingLines: entry.debuggerListingLines,
      firstNote: entry.firstNote,
      handlerLine: entry.handlerLine,
    },
  };
}

export const scenario: Scenario = {
  name: "s01",
  description:
    "The hub: a V2 transaction with a spend (order_fixed, Cancel) and two mints (native 3-of-6, burn_mint Burn) from reference scripts, as the DebuggerContext the tests load, the raw validator result, and the spend script.",
  build(tk) {
    const { writers, bytes: bytesLib, script: scriptLib } = tk;
    const h = hub(tk);
    const { tx, ctx, validation } = h;
    const pp = ctx.params;

    const fee = h.spec.fee!;
    const feeError = validation.errors.find((e) => tk.validator.errorKind(e) === "FeeTooSmallUTxO")!;
    const feeData = (feeError.error as Record<string, { min_fee: number | string; fee_decomposition?: Record<string, unknown> }>).FeeTooSmallUTxO!;
    const sdhError = validation.errors.find((e) => tk.validator.errorKind(e) === "ScriptDataHashMismatch")!;
    const sdhMessage = sdhError.error_message;
    const expectedHash = /Expected: ([0-9a-f]{64})/.exec(sdhMessage)?.[1];
    if (expectedHash !== h.correctScriptDataHash) throw new Error(`s01: the hash the toolkit computes (${h.correctScriptDataHash}) is not the validator's expected one (${expectedHash})`);

    const results = validation.eval_redeemer_results;
    const evalOf = (tag: string) => results.find((r) => r.tag === tag)!;
    const units = (r: ReturnType<typeof evalOf>) => ({
      declared: { mem: String(r.provided_ex_units.mem), steps: String(r.provided_ex_units.steps) },
      calculated: { mem: String(r.calculated_ex_units!.mem), steps: String(r.calculated_ex_units!.steps) },
      deltaSteps: (BigInt(r.calculated_ex_units!.steps) - BigInt(r.provided_ex_units.steps)).toString(),
    });
    const measured = measureHub(results, { protocolVersion: pp.protocolVersion, costModels: pp.costModels });

    const refOf = (u: Utxo) => `${u.ref.txHash}#${u.ref.index}`;
    const utxoFacts = (u: Utxo) => ({
      ref: refOf(u),
      txHash: u.ref.txHash,
      prefix: u.ref.txHash.slice(0, 8),
      index: u.ref.index,
      address: u.address instanceof Object && "bech32" in u.address ? u.address.bech32 : String(u.address),
      coin: u.value.coin,
      assetUnits: Object.values(u.value.assets ?? {}).reduce((n, names) => n + Object.keys(names).length, 0),
    });
    const spendFacts = scriptFacts(tk, "order_fixed");
    const out0Hex = h.ids.scriptAddressHex;
    const spendScript = tk.scripts.registryScript("order_fixed");

    const files: Record<string, string> = {
      "s01-hub.debugger-context.json": writers.debuggerContextFile({ tx, ctx }),
      "s01-hub.eval.json": writers.jsonText(
        writers.evalFixture({ tx, ctx, result: validation, source: "synthetic scenario s01: the raw validate_transaction_js result for the S1 transaction, produced by running the validator at build time" }),
      ),
      "s01-hub.spend-script.v2.hex": `${bytesLib.bytesToHex(spendScript.bytes)}\n`,
    };

    return {
      files,
      manifest: {
        "s01.contextFile": "s01-hub.debugger-context.json",
        "s01.evalFile": "s01-hub.eval.json",
        "s01.spendScriptFile": "s01-hub.spend-script.v2.hex",
        "s01.txHash": tx.txHash,
        "s01.txId": writers.txHandle(h.net, tx.txHash),
        "s01.network": h.net,
        "s01.protocolMajor": Number(pp.protocolVersion[0]),
        "s01.size": tx.size,
        "s01.fee": fee,
        "s01.minFee": BigInt(feeData.min_fee),
        "s01.feeDecomposition": feeData.fee_decomposition ?? null,
        "s01.txSizeFee": BigInt(pp.minFeeCoefficientA) * BigInt(tx.size - 1) + BigInt(pp.minFeeConstantB),
        "s01.collateralTotal": h.spec.totalCollateral!,
        "s01.counts": {
          inputs: tx.inputs.length,
          referenceInputs: h.spec.referenceInputs!.length,
          outputs: h.spec.outputs.length,
          collateral: h.spec.collateral!.length,
          mintPolicies: tx.mintPolicies.length,
          redeemers: tx.redeemers.length,
          vkeyWitnesses: h.spec.signers!.length,
          utxos: ctx.utxos.length,
        },
        "s01.redeemers": ["spend:2", "mint:1"],
        "s01.spend": {
          ref: "spend:2",
          index: 2,
          scriptHash: h.ids.spendHash,
          target: `input ${h.scriptInput.ref.txHash}#0`,
          redeemerHex: "d87980", // Cancel = Constr 0 []
          datumHex: h.datum.input,
          exUnits: units(evalOf("Spend")),
        },
        "s01.mint": {
          ref: "mint:1",
          index: 1,
          scriptHash: h.ids.burnPolicy,
          policy: h.ids.burnPolicy,
          target: `policy ${h.ids.burnPolicy}`,
          redeemerHex: "d87a80", // Burn = Constr 1 []
          assetNameHex: h.tokens.burnName,
          burned: h.tokens.burnQuantity,
          exUnits: units(evalOf("Mint")),
        },
        "s01.nativeMint": { ref: "mint:0", index: 0, policy: h.ids.nativePolicy, quantity: -1 },
        "s01.spendScript": {
          ...spendFacts,
          hashV1: h.ids.spendHashV1,
          hashV3: h.ids.spendHashV3,
          file: "s01-hub.spend-script.v2.hex",
          address: h.ids.scriptAddress,
          addressHex: h.ids.scriptAddressHex,
          holder: utxoFacts(h.holderOrder),
        },
        "s01.mintScript": { ...scriptFacts(tk, "burn_mint"), holder: utxoFacts(h.holderBurn) },
        "s01.nativeScript": {
          name: "multisig_3_of_6",
          hash: h.ids.nativePolicy,
          size: scriptLib.scriptSize(h.scriptInput.scriptRef!),
          holder: utxoFacts(h.scriptInput),
          requiredSigners: 3,
        },
        "s01.utxos": ctx.utxos.map(refOf),
        "s01.utxo": {
          holderOrder: utxoFacts(h.holderOrder),
          holderBurn: utxoFacts(h.holderBurn),
          scriptInput: { ...utxoFacts(h.scriptInput), datumHash: h.datum.inputHash, inlineDatumHex: h.datum.input, tokens: 3 },
          walletInput: utxoFacts(h.walletInput),
          funding: utxoFacts(h.funding),
        },
        // the patch contract of chain.e2e: drop the funding UTxO, rewrite out0's address bytes, fund a 10,000-level native script from it
        "s01.fundingTxId": h.funding.ref.txHash,
        "s01.fundingTxPrefix": h.funding.ref.txHash.slice(0, 8),
        "s01.fundingIndex": h.funding.ref.index,
        "s01.fundingRef": refOf(h.funding),
        "s01.fundingCoin": h.funding.value.coin,
        "s01.out0": {
          address: h.ids.scriptAddress,
          addressHex: out0Hex,
          addressCborPrefix: "581d71",
          addressCborHex: `581d${out0Hex}`,
          datumHex: h.datum.output,
          scriptRefHash: h.ids.nativePolicy,
        },
        "s01.datum": { inputHex: h.datum.input, outputHex: h.datum.output, hash: h.datum.inputHash },
        "s01.tokens": { burnPolicy: h.ids.burnPolicy, burnAssetNameHex: h.tokens.burnName, burnHeld: h.tokens.burnHeld, burnQuantity: h.tokens.burnQuantity, nativePolicy: h.ids.nativePolicy, soldPolicy: h.tokens.policyB },
        "s01.diagnostics": {
          errors: tk.validator.errorKinds(validation),
          warnings: [],
          phase2Warnings: ["BudgetIsBiggerThanExpected", "BudgetIsBiggerThanExpected"],
          total: 5,
          /** ui_link from=validation: one diagnostic annotation and one tx_path annotation per diagnostic */
          uiAnnotations: 10,
          verdict: "phase1_failed",
        },
        "s01.scriptDataHash": { provided: tx.scriptDataHash!, expected: h.correctScriptDataHash, staleBecause: "computed with a PlutusV2 cost model whose first parameter is one lower (the previous revision of the model)" },
        "s01.keys": { operatorKeyHash: h.ids.operatorKeyHash, makerKeyHash: h.ids.makerKeyHash, walletAddress: h.ids.walletAddress, nativeSigners: 3 },
        "s01.debug": measured,
      },
    };
  },
};
