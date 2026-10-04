import { describe, expect, it } from "vitest";

import { importBundle, importContext } from "../../../src/chain/bundle.js";
import { stringifyForLib } from "../../../src/chain/contextCodec.js";
import { partsFromEval } from "../../../src/engine/parts.js";
import { assetFingerprint, baseAddress, byronAddress, govActionIdBech32, keyCred, rewardAddress, scriptCred } from "../../fixtures/synthetic/lib/address.js";
import { poolKey } from "../../fixtures/synthetic/lib/keys.js";
import { govActionContext, poolContext, utxo, type ChainContext } from "../../fixtures/synthetic/lib/context.js";
import { fit } from "../../fixtures/synthetic/lib/fit.js";
import { paramSet } from "../../fixtures/synthetic/lib/params.js";
import { constr, datumHash, pInt, UNIT } from "../../fixtures/synthetic/lib/plutusData.js";
import { native, scriptHash } from "../../fixtures/synthetic/lib/script.js";
import { bundleFile, bundleV1, debuggerContext, debuggerContextFile, evalFixture, fakeHash, jsonText, koiosCacheFiles, koiosCommitteeRow, koiosEpochParamsRow, koiosProposalRow, koiosTotalsRow, koiosUtxoRow, refScriptRecord, txText } from "../../fixtures/synthetic/lib/writers.js";
import { utf8Hex } from "../../fixtures/synthetic/lib/bytes.js";
import { inProcessLib } from "../../helpers/inProcessLib.js";
import { alice, aliceAddr, bobAddr, h, scriptAddress, succeeds, worldCtx } from "./world.js";

const lib = inProcessLib();

/** A context with everything a DebuggerContext can carry: a script input (hash + inline datum), a V2 and a native reference script, assets. */
function richWorld() {
  const sc = succeeds(2);
  const nat = native({ type: "sig", keyHash: alice.pay.keyHashHex });
  const policy = scriptHash(nat);
  const datum = constr(0, [pInt(1)]);
  const locked = utxo({
    ref: `${h("rich locked")}#0`,
    address: scriptAddress(scriptHash(sc)),
    coin: 15_000_000n,
    assets: { [policy]: { "": 1n, [utf8Hex("TOK")]: 9n } },
    datumHash: datumHash(datum),
    inlineDatum: datum,
    scriptRef: nat,
  });
  const ref = utxo({ ref: `${h("rich ref")}#3`, address: bobAddr, coin: 20_000_000n, scriptRef: sc });
  const funds = utxo({ ref: `${h("rich funds")}#2`, address: aliceAddr, coin: 120_000_000n });
  const ctx = worldCtx([ref, locked, funds]);
  const fitted = fit(
    {
      inputs: [locked.ref, funds.ref],
      referenceInputs: [ref.ref],
      outputs: [{ address: aliceAddr, value: { coin: "min" }, change: true }],
      collateral: [funds.ref],
      // the input carries an inline datum (next to a datum hash, like real DebuggerContext dumps): no witness datum
      redeemers: [{ target: { tag: "spend", input: locked.ref }, data: UNIT, exUnits: { mem: 1n, steps: 1n } }],
    },
    { ctx, keys: [alice.pay] },
  );
  return { ctx, fitted, locked, ref, funds, policy, sc, nat };
}

describe("DebuggerContext writer", () => {
  const { ctx, fitted, locked, ref, funds, policy, sc, nat } = richWorld();

  it("writes the de-uplc shape: utxos in the order given, amounts as strings, `policy.name` asset keys, reference scripts as {type, script}", () => {
    const dc = debuggerContext({ tx: fitted.tx, ctx }) as { utxos: Array<Record<string, any>>; protocolParams: Record<string, any>; network: string; transaction: string };
    expect(Object.keys(dc)).toEqual(["utxos", "protocolParams", "network", "transaction"]);
    expect(dc.transaction).toBe(fitted.tx.hex);
    expect(dc.network).toBe("mainnet");
    expect(dc.utxos.map((u) => `${u.txHash}#${u.outputIndex}`)).toEqual([ref, locked, funds].map((u) => `${u.ref.txHash}#${u.ref.index}`));
    expect(dc.utxos[0]!.referenceScript).toEqual({ type: "PlutusV2", script: Buffer.from(sc.bytes).toString("hex") });
    expect(dc.utxos[0]!.value).toEqual({ lovelace: "20000000" });
    expect(dc.utxos[1]!.value.assets).toEqual({ [`${policy}.`]: "1", [`${policy}.${utf8Hex("TOK")}`]: "9" });
    expect(dc.utxos[1]!.datumHash).toBe(datumHash(constr(0, [pInt(1)])));
    expect(dc.utxos[1]!.inlineDatum).toBe("d8799f01ff");
    expect(dc.utxos[1]!.referenceScript.type).toBe("NativeScript");
    expect(dc.utxos[2]!.datumHash).toBeNull();
    expect(dc.utxos[2]!.referenceScript).toBeNull();
    expect(debuggerContext({ tx: fitted.tx, ctx, order: "transaction-first" })).toHaveProperty("transaction");
    expect(Object.keys(debuggerContext({ tx: fitted.tx, ctx, order: "transaction-first" }))[0]).toBe("transaction");
    expect(nat.kind).toBe("native");
  });

  it("with the real-world quirks (default): minFeeA / minFeeB swapped, utxoCostPerWord 0, no prices, {major, minor} version", () => {
    const pp = (debuggerContext({ tx: fitted.tx, ctx }) as { protocolParams: Record<string, any> }).protocolParams;
    expect(pp.minFeeA).toBe(155381);
    expect(pp.minFeeB).toBe(44);
    expect(pp.utxoCostPerWord).toBe(0);
    expect(pp.priceMem).toBeUndefined();
    expect(pp.protocolVersion).toEqual({ major: 10, minor: 0 });
    expect(pp.maxValSize).toBe("5000");
    expect(pp.costModels.PlutusV2).toHaveLength(175);
  });

  it("without the quirks: coefficients in place, per-byte cost and prices present", () => {
    const pp = (debuggerContext({ tx: fitted.tx, ctx, quirks: false }) as { protocolParams: Record<string, any> }).protocolParams;
    expect(pp.minFeeA).toBe(44);
    expect(pp.minFeeB).toBe(155381);
    expect(pp.utxoCostPerWord).toBe(4310);
    expect(pp.priceMem).toBeCloseTo(0.0577);
    expect(pp.priceStep).toBeCloseTo(0.0000721);
  });

  it.each([true, false])("loads through tx_load's importer and validates clean (quirks %s)", async (quirks) => {
    const text = debuggerContextFile({ tx: fitted.tx, ctx, quirks });
    const imported = await importContext(lib, text, { validity: { start: undefined, end: undefined } });
    expect(imported.kind).toBe("de_uplc_context");
    expect(imported.txHex).toBe(fitted.tx.hex);
    expect(imported.context.utxoSet.map((u) => u.utxo.input.txHash)).toEqual([ref, locked, funds].map((u) => u.ref.txHash));
    expect(imported.context.protocolParameters.minFeeCoefficientA).toBe(44n);
    expect(imported.context.protocolParameters.minFeeConstantB).toBe(155381n);
    expect(imported.context.protocolParameters.adaPerUtxoByte).toBe(4310n);
    expect(imported.defaultsApplied.join("\n").includes("swapped")).toBe(quirks);
    // reference scripts keep their identity: hash derived from the bytes
    expect(Object.keys(imported.refScripts).sort()).toEqual([scriptHash(sc), policy].sort());
    expect(imported.refScripts[scriptHash(sc)]!.utxo).toBe(`${ref.ref.txHash}#3`);
    const result = await lib.validateTx(imported.txHex, stringifyForLib(imported.context));
    // slot = wall clock here (no validity interval in the tx): only the validity-free tx matters, so no interval error either
    expect(result.errors).toEqual([]);
    expect(result.phase2_errors).toEqual([]);
  });
});

describe("bundle v1 writer", () => {
  const { ctx, fitted, locked } = richWorld();

  it("a bundle round-trips through the importer with its provider rows, validation result and inclusion facts", () => {
    const validationResult = fitted.validation;
    const text = bundleFile({
      tx: fitted.tx,
      ctx,
      origin: "unit test",
      capturedAt: "2026-01-02T03:04:05.000Z",
      providerRows: { provider: "koios", network: "mainnet", utxo_info: [], account_info: [], pool_info: [], drep_info: [], proposals: [], tx_cbor: [], cache_hits: [] },
      validationResult,
      defaultsApplied: ["something chosen"],
      missingUtxos: [],
      refScripts: Object.fromEntries(ctx.utxos.filter((u) => u.scriptRef).map((u) => [scriptHash(u.scriptRef!), refScriptRecord(u)])),
      onChain: { slot: "120000000", epoch: 231, block_height: 6000000, is_valid: true, source: "unit test" },
    });
    const imported = importBundle(text);
    expect(imported.kind).toBe("bundle");
    expect(imported.txHash).toBe(fitted.tx.txHash);
    expect(imported.slot).toBe(120_000_000n);
    expect(imported.protocolMajor).toBe(10);
    expect(imported.capturedAt).toBe(Date.parse("2026-01-02T03:04:05.000Z"));
    expect(imported.onChain).toMatchObject({ slot: "120000000", epoch: 231, is_valid: true });
    expect(imported.validation?.eval_redeemer_results).toHaveLength(1);
    expect(imported.defaultsApplied).toContain("something chosen");
    expect(Object.keys(imported.refScripts)).toHaveLength(2);
    expect(imported.context.utxoSet.find((u) => u.utxo.input.txHash === locked.ref.txHash)?.utxo.output.plutusData).toBe("d8799f01ff");
  });

  it("is keys-sorted JSON with bare integers and a one-space indent, captured_at null by default", () => {
    const b = bundleV1({ tx: fitted.tx, ctx });
    expect(b.captured_at).toBeNull();
    expect(b.slot).toBe("120000000");
    const text = bundleFile({ tx: fitted.tx, ctx });
    expect(text.endsWith("\n")).toBe(true);
    expect(text.startsWith('{\n "captured_at": null,\n "cardano_debug_bundle": 1,')).toBe(true);
    expect(text).toMatch(/"slot": "120000000"/);
    expect(text).toMatch(/"minFeeConstantB": 155381/);
    expect(JSON.parse(text).validation_input_context.treasuryValue).toBe(0);
    // a raw tx hex works as well as a built tx
    expect(bundleV1({ tx: fitted.tx.hex, ctx }).tx_hash).toBe(fitted.tx.txHash);
  });
});

describe("raw validator result", () => {
  const { ctx, fitted } = richWorld();

  it("keeps the keys the engine layer reads and feeds partsFromEval", () => {
    const ev = evalFixture({ tx: fitted.tx, ctx, result: fitted.validation, source: "unit test" }) as { eval_redeemer_results: Array<Record<string, any>>; protocol_parameters: any; tx_hex: string; network: string; _source: string };
    expect(ev.tx_hex).toBe(fitted.tx.hex);
    expect(ev.network).toBe("mainnet");
    expect(ev._source).toBe("unit test");
    expect(Object.keys(ev.eval_redeemer_results[0]!).sort()).toEqual(
      ["calculated_ex_units", "datum_bytes", "error", "index", "logs", "plutus_version", "provided_ex_units", "redeemer_bytes", "script_bytes", "script_context_bytes", "success", "tag"].sort(),
    );
    expect(ev.protocol_parameters.protocolVersion).toEqual([10, 0]);
    expect(ev.protocol_parameters.costModels.plutusV2).toHaveLength(175);
    const { config, meta } = partsFromEval(ev.eval_redeemer_results[0] as never, ev.protocol_parameters);
    expect(config.language).toBe("v2");
    expect(config.cost_models).toHaveLength(175);
    expect(meta.applied).toEqual(["datum", "redeemer", "context"]);
    expect(meta.declared_ex_units).toEqual(meta.calculated_ex_units);
    const all = evalFixture({ tx: fitted.tx, ctx, result: fitted.validation, source: "x", keepScriptContext: true }) as { eval_redeemer_results: Array<Record<string, unknown>> };
    expect(typeof all.eval_redeemer_results[0]!.script_context).toBe("string");
  });
});

describe("Koios rows", () => {
  const { ctx, locked, ref, funds, policy } = richWorld();
  const facts = { network: "mainnet" as const, epoch: 400, blockHeight: 9_000_000, blockTime: 1_700_000_000 };

  it("a UTxO row: stake address, payment credential, inline datum bytes + JSON, reference script with hash / size / type / bytes, assets with CIP-14 fingerprints", () => {
    const row = koiosUtxoRow({ ...locked, isSpent: true }, facts) as Record<string, any>;
    expect(row).toMatchObject({ tx_hash: locked.ref.txHash, tx_index: 0, value: "15000000", stake_address: null, epoch_no: 400, block_height: 9_000_000, block_time: 1_700_000_000, is_spent: true });
    expect(row.payment_cred).toBe(scriptHash({ kind: "plutus", version: 2, bytes: succeeds(2).bytes }));
    expect(row.datum_hash).toBe(datumHash(constr(0, [pInt(1)])));
    expect(row.inline_datum).toEqual({ bytes: "d8799f01ff", value: { constructor: 0, fields: [{ int: 1 }] } });
    expect(row.reference_script).toMatchObject({ hash: policy, type: "native", value: null });
    expect(row.asset_list).toEqual([
      { decimals: 0, quantity: "1", policy_id: policy, asset_name: "", fingerprint: assetFingerprint(policy, "") },
      { decimals: 0, quantity: "9", policy_id: policy, asset_name: utf8Hex("TOK"), fingerprint: assetFingerprint(policy, utf8Hex("TOK")) },
    ]);
    const refRow = koiosUtxoRow(ref, facts) as Record<string, any>;
    expect(refRow.reference_script).toMatchObject({ type: "plutusV2", size: succeeds(2).bytes.length, hash: scriptHash(succeeds(2)) });
    expect(refRow.reference_script.bytes).toBe(Buffer.from(succeeds(2).bytes).toString("hex"));
    expect(refRow.is_spent).toBe(false);
    const keyRow = koiosUtxoRow(funds, facts) as Record<string, any>;
    expect(keyRow.stake_address).toBe(rewardAddress("mainnet", keyCred(alice.stake)).bech32);
    expect(keyRow.payment_cred).toBe(alice.pay.keyHashHex);
    expect(keyRow.address).toBe(baseAddress("mainnet", keyCred(alice.pay), keyCred(alice.stake)).bech32);
    expect(ctx.utxos).toHaveLength(3);
  });

  it("epoch parameter rows carry the parameter set with an artificial epoch, nonce and block hash", () => {
    const row = koiosEpochParamsRow(paramSet("pv10"), 400) as Record<string, any>;
    expect(row.epoch_no).toBe(400);
    expect(row.protocol_major).toBe(10);
    expect(row.cost_models.PlutusV3).toHaveLength(297);
    expect(row.nonce).toBe(fakeHash("epoch 400 nonce"));
    expect(row.block_hash).toBe(fakeHash("epoch 400 first block"));
    expect(row.nonce).not.toBe(koiosEpochParamsRow(paramSet("pv10"), 401).nonce);
    expect(koiosEpochParamsRow(paramSet("pv11"), 400).protocol_major).toBe(11);
  });

  it("the cache layout: one file per row at the path the cache reads", () => {
    const files = koiosCacheFiles({
      network: "mainnet",
      utxos: [koiosUtxoRow(funds, facts)],
      epochParams: [{ epoch: 400, row: koiosEpochParamsRow(paramSet("pv10"), 400) }],
      totals: [{ epoch: 400, row: koiosTotalsRow(400) }],
      committee: koiosCommitteeRow({ proposalTxHash: h("c"), proposalId: "gov_action1x", quorum: [2, 3], members: [] }),
      constitution: { anchorUrl: "ipfs://x", anchorDataHash: h("a"), guardrailScriptHash: null },
      accounts: [{ key: "stake1x", row: { stake_address: "stake1x" } }],
    });
    expect(Object.keys(files).sort()).toEqual(
      [
        `utxo/mainnet/koios/${funds.ref.txHash}_${funds.ref.index}.json`,
        "epoch_params/mainnet/koios/400.json",
        "rows/mainnet/koios/totals/400.json",
        "rows/mainnet/koios/committee_info/current.json",
        "rows/mainnet/koios/constitution/current.json",
        "rows/mainnet/koios/account_info/stake1x.json",
      ].sort(),
    );
    expect(JSON.parse(files["epoch_params/mainnet/koios/400.json"]!)).toHaveLength(1);
    expect(JSON.parse(files["rows/mainnet/koios/constitution/current.json"]!)).toEqual({ constitution: { anchorUrl: "ipfs://x", anchorDataHash: h("a"), guardrailScriptHash: null } });
    expect(files["rows/mainnet/koios/totals/400.json"]!.endsWith("\n")).toBe(true);
  });
});

describe("an SPO vote on a ParameterChange: the proposal row names the parameters the context lacks", () => {
  it("without names the stake-pool vote is DisallowedVoters; the bundle's proposal row (Koios names) completes the context on import", async () => {
    const pool = poolKey("writers-pool");
    const gaTx = h("writers param change");
    const funds = utxo({ ref: `${h("writers spo funds")}#0`, address: aliceAddr, coin: 90_000_000n });
    const ctx = worldCtx([funds], "pv11", {
      pools: [poolContext(pool.keyHashHex)],
      govActions: [govActionContext(gaTx, 0, "parameterChangeAction")],
    });
    const fitted = fit(
      { inputs: [funds.ref], outputs: [{ address: aliceAddr, value: { coin: "min" }, change: true }], votes: [{ voter: { kind: "spo", hash: pool.keyHashHex }, actions: [{ id: { txHash: gaTx, index: 0 }, vote: 1 }] }] },
      { ctx, keys: [alice.pay, pool], expect: { errors: ["DisallowedVoters"] } },
    );
    const row = koiosProposalRow({
      txHash: gaTx,
      index: 0,
      type: "ParameterChange",
      returnAddress: rewardAddress("mainnet", keyCred(alice.stake)).bech32,
      proposedEpoch: 600,
      paramProposal: { max_block_ex_mem: 72_000_000, max_block_ex_steps: 20_000_000_000, max_tx_ex_mem: 16_500_000, max_tx_ex_steps: 10_000_000_000 },
    });
    expect(row.proposal_id).toBe(govActionIdBech32(gaTx, 0));
    const text = bundleFile({
      tx: fitted.tx,
      ctx,
      providerRows: { provider: "koios", network: "mainnet", utxo_info: [], account_info: [], pool_info: [], drep_info: [], proposals: [row], tx_cbor: [], cache_hits: [] },
      validationResult: fitted.validation,
    });
    const imported = importBundle(text);
    expect(imported.defaultsApplied.join("\n")).toContain("changedParameters=[max_block_ex_mem, max_block_ex_steps, max_tx_ex_mem, max_tx_ex_steps]");
    expect(imported.validation, "the stored verdict was computed without the names and is dropped").toBeUndefined();
    const result = await lib.validateTx(imported.txHex, stringifyForLib(imported.context));
    expect(result.errors).toEqual([]);
  });
});

describe("text helpers", () => {
  it("sorted-key JSON with a trailing newline; tx text with or without the newline; fake ids are labelled and stable", () => {
    expect(jsonText({ b: 1n, a: [2] })).toBe('{\n  "a": [\n    2\n  ],\n  "b": 1\n}\n');
    expect(jsonText({ b: 1, a: 2 }, null)).toBe('{"a":2,"b":1}\n');
    expect(txText("84a0")).toBe("84a0");
    expect(txText("84a0", true)).toBe("84a0\n");
    expect(fakeHash("x")).toBe(fakeHash("x"));
    expect(fakeHash("x")).not.toBe(fakeHash("y"));
    expect(fakeHash("x")).toHaveLength(64);
    expect(fakeHash("x", 28)).toHaveLength(56);
    expect(fakeHash("x", 28)).not.toBe(fakeHash("x").slice(0, 56));
    const chain: ChainContext = worldCtx([]);
    expect(chain.network).toBe("mainnet");
    expect(scriptCred("00".repeat(28)).kind).toBe("script");
  });

  it("a Byron address (raw bytes) works as an output address, and as text in a context", () => {
    const byron = byronAddress("writers-sink");
    const funds = utxo({ ref: `${h("byron funds")}#0`, address: aliceAddr, coin: 90_000_000n });
    const byronUtxo = utxo({ ref: `${h("byron utxo")}#0`, address: byron.bytes, coin: 5_000_000n });
    const ctx = worldCtx([funds, byronUtxo]);
    const f = fit({ inputs: [funds.ref], outputs: [{ address: byron.bytes, value: { coin: "min" } }, { address: aliceAddr, value: { coin: "min" }, change: true }] }, { ctx, keys: [alice.pay] });
    expect(f.validation.errors).toEqual([]);
    const dc = debuggerContext({ tx: f.tx, ctx }) as { utxos: Array<{ address: string }> };
    expect(dc.utxos[1]!.address).toBe(byron.text);
  });
});
