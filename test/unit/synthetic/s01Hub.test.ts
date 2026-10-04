// S1 / S2 / S3 (the hub family): the DebuggerContext files, the raw validator result, the scripts and the manifest numbers
// the consumer tests read. Everything is checked against the real validator (cquisitor-lib, in this process), the real
// DebuggerContext importer (src/chain/bundle.ts) and the real tool code (tx_load / tx_validate, over the in-process library);
// the debugger-facing figures in `s01.debug.*` are re-measured with the engine from the committed eval JSON.

import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { configure } from "@cardananium/cquisitor-lib";
import { nodeBrotliCompressor } from "@cardananium/cquisitor-lib/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { importDeUplcContext } from "../../../src/chain/bundle.js";
import { stringifyForLib } from "../../../src/chain/contextCodec.js";
import { loadConfig } from "../../../src/config.js";
import { createAppContext, type AppContext } from "../../../src/context.js";
import type { LibClient } from "../../../src/lib.js";
import { txLoad } from "../../../src/tools/tx_load.js";
import { txRedeemer } from "../../../src/tools/tx_redeemer.js";
import { txValidate } from "../../../src/tools/tx_validate.js";
import { parseJsonBigintSafe } from "../../../src/vocab/json.js";
import { type Cbor, decode, mapGet } from "../../fixtures/synthetic/lib/cbor.js";
import { toolkit as tk } from "../../fixtures/synthetic/lib/toolkit.js";
import { errorKinds, validate, checkSignatures } from "../../fixtures/synthetic/lib/validator.js";
import { measureHub } from "../../fixtures/synthetic/scenarios/s01-measure.js";
import { fixturePath, fx, fxArr, fxBig, fxInt, fxStr, readFixtureJson, readFixtureText } from "../../helpers/fixtures.js";
import { inProcessLib } from "../../helpers/inProcessLib.js";
import { withoutWitnessKey } from "../../helpers/cborSplice.js";

type Json = Record<string, any>;

interface ContextFile {
  utxos: Array<{ txHash: string; outputIndex: number; address: string; value: { lovelace: string; assets?: Record<string, string> }; datumHash: string | null; inlineDatum?: string; referenceScript: { type: string; script: string } | null }>;
  protocolParams: Record<string, any>;
  network: string;
  transaction: string;
}

const readContext = (key: string): ContextFile => readFixtureJson<ContextFile>(fxStr(key));
const hasTag = (item: Cbor, tag: bigint): boolean => {
  switch (item.t) {
    case "tag":
      return item.tag === tag || hasTag(item.v, tag);
    case "array":
      return item.items.some((i) => hasTag(i, tag));
    case "map":
      return item.entries.some(([k, v]) => hasTag(k, tag) || hasTag(v, tag));
    case "mark":
      return hasTag(item.v, tag);
    default:
      return false;
  }
};

/** The DebuggerContext as the importer reads it: its validation context and transaction, exactly what tx_load validates. */
async function imported(file: ContextFile | string) {
  const text = typeof file === "string" ? file : JSON.stringify(file);
  return importDeUplcContext(inProcessLib(), parseJsonBigintSafe(text));
}
const validateImported = (i: Awaited<ReturnType<typeof imported>>, txHex = i.txHex) => validate(txHex, stringifyForLib(i.context));

describe("S1: the DebuggerContext", () => {
  const file = readContext("s01.contextFile");
  const tx = decode(file.transaction);
  const body = tx.t === "array" ? tx.items[0]! : (undefined as never);
  const witnesses = tx.t === "array" ? tx.items[1]! : (undefined as never);

  it("has five UTxOs in the pinned order: two V2 reference-script holders, the script input, a key input, the funding input", () => {
    expect(file.network).toBe("mainnet");
    expect(file.utxos).toHaveLength(5);
    expect(file.utxos.map((u) => `${u.txHash}#${u.outputIndex}`)).toEqual(fxArr<string>("s01.utxos"));
    const [holderOrder, holderBurn, scriptInput, walletInput, funding] = file.utxos;
    expect(holderOrder!.referenceScript).toMatchObject({ type: "PlutusV2" });
    expect(holderBurn!.referenceScript).toMatchObject({ type: "PlutusV2" });
    expect(holderOrder!.referenceScript!.script).toBe(readFixtureText(fxStr("s01.spendScriptFile")).trim());
    expect(holderOrder!.referenceScript!.script.startsWith(fxStr("s01.spendScript.prefix"))).toBe(true);
    expect(holderOrder!.referenceScript!.script.length / 2).toBe(fxInt("s01.spendScript.size"));
    expect(holderBurn!.referenceScript!.script.length / 2).toBe(fxInt("s01.mintScript.size"));
    // the script input: datum hash AND a string inline datum, three tokens with the empty asset name, a native reference script
    expect(typeof scriptInput!.inlineDatum).toBe("string");
    expect(scriptInput!.inlineDatum).toBe(fxStr("s01.datum.inputHex"));
    expect(scriptInput!.datumHash).toBe(fxStr("s01.datum.hash"));
    expect(tk.plutusData.datumHash(scriptInput!.inlineDatum!)).toBe(scriptInput!.datumHash);
    const units = Object.keys(scriptInput!.value.assets ?? {});
    expect(units).toHaveLength(3);
    for (const unit of units) expect(unit).toMatch(/^[0-9a-f]{56}\.$/);
    expect(scriptInput!.referenceScript).toMatchObject({ type: "NativeScript" });
    expect(scriptInput!.referenceScript!.script.length / 2).toBe(196);
    // the wallet input holds four asset units, the funding input is pure ADA at index 2 of its transaction
    expect(Object.keys(walletInput!.value.assets ?? {})).toHaveLength(4);
    expect(funding!.value.assets).toBeUndefined();
    expect(funding!.outputIndex).toBe(fxInt("s01.fundingIndex"));
    expect(funding!.outputIndex).toBe(2);
    expect(funding!.txHash).toBe(fxStr("s01.fundingTxId"));
    expect(`${funding!.txHash}#${funding!.outputIndex}`).toBe(fxStr("s01.fundingRef"));
    expect(walletInput!.txHash).toBe(funding!.txHash);
    expect(BigInt(funding!.value.lovelace)).toBe(fxBig("s01.fundingCoin"));
    // the script input's address is the enterprise address of the spend script (found "hash derived" from the input's address)
    expect(scriptInput!.address).toBe(fxStr("s01.spendScript.address"));
    expect(tk.address.parseAddress(scriptInput!.address).payment).toMatchObject({ kind: "script" });
    expect(tk.bytes.bytesToHex(tk.address.parseAddress(scriptInput!.address).payment!.hash)).toBe(fxStr("s01.spendScript.hash"));
    // the quirks of a real de-uplc dump: swapped fee coefficients, utxoCostPerWord 0, protocol version as {major, minor}
    expect(file.protocolParams).toMatchObject({ minFeeA: 155381, minFeeB: 44, utxoCostPerWord: 0, protocolVersion: { major: 10, minor: 0 } });
  });

  it("holds a transaction with the pinned shape: 3 inputs, 3 reference inputs (one overlap), 2 policies, 4 vkeys, plain arrays, array redeemers", () => {
    expect(file.transaction.length / 2).toBe(fxInt("s01.size"));
    expect(file.transaction).not.toMatch(/\s/);
    expect(tk.tx.txHashOfBytes(file.transaction)).toBe(fxStr("s01.txHash"));
    expect(fxStr("s01.txId")).toBe(`tx_mainnet_${fxStr("s01.txHash").slice(0, 12)}`);
    const arrayLen = (key: number): number => {
      const v = mapGet(body, key);
      if (!v || v.t !== "array") throw new Error(`body key ${key} is not a plain array`);
      return v.items.length;
    };
    expect(hasTag(tx, 258n), "no tag 258 anywhere (plain arrays)").toBe(false);
    expect(arrayLen(0)).toBe(3); // inputs
    expect(arrayLen(18)).toBe(3); // reference inputs
    expect(arrayLen(13)).toBe(1); // collateral
    expect(arrayLen(14)).toBe(1); // required signers
    const inputs = (mapGet(body, 0) as Extract<Cbor, { t: "array" }>).items.map((i) => (i as Extract<Cbor, { t: "array" }>).items.map((x) => (x.t === "bytes" ? tk.bytes.bytesToHex(x.v) : String((x as { v: bigint }).v))).join("#"));
    const refs = (mapGet(body, 18) as Extract<Cbor, { t: "array" }>).items.map((i) => (i as Extract<Cbor, { t: "array" }>).items.map((x) => (x.t === "bytes" ? tk.bytes.bytesToHex(x.v) : String((x as { v: bigint }).v))).join("#"));
    expect(inputs).toEqual([...inputs].sort());
    expect(inputs[2]).toBe(fxStr("s01.utxo.scriptInput.ref")); // spend:2
    expect(refs.filter((r) => inputs.includes(r))).toEqual([fxStr("s01.utxo.scriptInput.ref")]); // exactly one overlap
    const mint = mapGet(body, 9) as Extract<Cbor, { t: "map" }>;
    expect(mint.entries).toHaveLength(2);
    expect(mint.entries.map(([k]) => tk.bytes.bytesToHex((k as { v: Uint8Array }).v))).toEqual([fxStr("s01.nativeMint.policy"), fxStr("s01.mint.policy")]);
    for (const absent of [3, 7, 8, 19, 20]) expect(mapGet(body, absent), `body key ${absent} (ttl / aux hash / validity start / votes / proposals)`).toBeUndefined();
    expect(mapGet(body, 16)).toBeDefined(); // collateral return
    expect(mapGet(body, 17)).toBeDefined(); // total collateral
    expect(mapGet(body, 17)).toMatchObject({ v: fxBig("s01.collateralTotal") });
    expect(mapGet(body, 2)).toMatchObject({ v: fxBig("s01.fee") });
    // outputs: out0 is a 29-byte enterprise script address with an inline datum and a native script reference
    const outputs = (mapGet(body, 1) as Extract<Cbor, { t: "array" }>).items;
    expect(outputs).toHaveLength(3);
    const out0 = outputs[0]!;
    const address = mapGet(out0, 0) as Extract<Cbor, { t: "bytes" }>;
    expect(address.v).toHaveLength(29);
    expect(tk.bytes.bytesToHex(address.v)).toBe(fxStr("s01.out0.addressHex"));
    expect(tk.bytes.bytesToHex(address.v).startsWith("71")).toBe(true);
    expect(mapGet(out0, 2)).toBeDefined();
    expect(mapGet(out0, 3)).toBeDefined();
    // witnesses: a definite map with the vkeys at key 0 (4 of them) and array-form redeemers at key 5, no datums
    expect(witnesses.t).toBe("map");
    expect((witnesses as Extract<Cbor, { t: "map" }>).indefinite).toBeFalsy();
    const vkeys = mapGet(witnesses, 0) as Extract<Cbor, { t: "array" }>;
    expect(vkeys.items).toHaveLength(fxInt("s01.counts.vkeyWitnesses"));
    expect(vkeys.items).toHaveLength(4);
    const redeemers = mapGet(witnesses, 5)!;
    expect(redeemers.t).toBe("array");
    expect((redeemers as Extract<Cbor, { t: "array" }>).items).toHaveLength(2);
    for (const r of (redeemers as Extract<Cbor, { t: "array" }>).items) expect((r as Extract<Cbor, { t: "array" }>).items).toHaveLength(4);
    expect(mapGet(witnesses, 4)).toBeUndefined();
    expect(tx.t === "array" && tx.items).toHaveLength(4);
    expect((tx as Extract<Cbor, { t: "array" }>).items[3]).toMatchObject({ t: "simple", v: 22 }); // no auxiliary data
    // the transaction is signed for real: every vkey witness verifies against the body hash
    expect(checkSignatures(file.transaction)).toMatchObject({ valid: true, tx_hash: fxStr("s01.txHash") });
  });

  it("the size, counts and handle in the manifest are those of the file", () => {
    expect(fx("s01.counts")).toEqual({ collateral: 1, inputs: 3, mintPolicies: 2, outputs: 3, redeemers: 2, referenceInputs: 3, utxos: 5, vkeyWitnesses: 4 });
    expect(fxInt("s01.size")).toBeGreaterThan(1_300);
    expect(fxInt("s01.size")).toBeLessThan(2_500);
    expect(fxStr("s01.network")).toBe("mainnet");
    expect(fxInt("s01.protocolMajor")).toBe(10);
    expect(fx("s01.redeemers")).toEqual(["spend:2", "mint:1"]);
  });

  it("the out0 address bytes `581d71<hash>` occur once in the transaction (chain.e2e rewrites them to an unreadable address)", () => {
    const cbor = fxStr("s01.out0.addressCborHex");
    expect(cbor).toBe(`${fxStr("s01.out0.addressCborPrefix")}${fxStr("s01.spendScript.hash")}`);
    expect(cbor.startsWith("581d71")).toBe(true);
    expect(file.transaction.split(cbor)).toHaveLength(2);
  });
});

describe("S1: what the validator says on the importer's own parameters", () => {
  it("phase 1: exactly FeeTooSmallUTxO, ScriptDataHashMismatch, ReferenceInputOverlapsWithInput (no warnings); phase 2: success twice, BudgetIsBiggerThanExpected twice", async () => {
    const i = await imported(readFixtureText(fxStr("s01.contextFile")));
    expect(i.protocolMajor).toBe(10);
    expect(i.context.protocolParameters.adaPerUtxoByte).toBe(4310n); // utxoCostPerWord 0 -> the importer's default
    expect(i.context.treasuryValue).toBe(0n);
    expect(i.defaultsApplied.join("\n")).toContain("minFeeCoefficientA/minFeeConstantB swapped");
    const result = validateImported(i);
    expect(errorKinds(result)).toEqual(fx<string[]>("s01.diagnostics.errors"));
    expect(errorKinds(result)).toEqual(["FeeTooSmallUTxO", "ScriptDataHashMismatch", "ReferenceInputOverlapsWithInput"]);
    expect(result.warnings).toEqual([]);
    expect(result.phase2_errors).toEqual([]);
    expect(result.phase2_warnings.map((w) => Object.keys((w as { warning: object }).warning)[0])).toEqual(fx<string[]>("s01.diagnostics.phase2Warnings"));
    expect(result.eval_redeemer_results.map((r) => [r.tag, r.index, r.success])).toEqual([["Spend", 2, true], ["Mint", 1, true]]);
    // every diagnostic names a location (ui_link from=validation: one diagnostic + one tx_path annotation each = 10)
    const located = [...result.errors.map((e) => e.locations), ...result.phase2_warnings.map((w) => (w as { locations?: string[] }).locations)];
    expect(located).toHaveLength(5);
    for (const l of located) expect(l!.length).toBeGreaterThan(0);
    expect(fxInt("s01.diagnostics.total") * 2).toBe(fxInt("s01.diagnostics.uiAnnotations"));
    // the fee decomposition: the size fee is on the ledger size (the CBOR minus the is_valid byte), a = 44, b = 155381
    const fee = result.errors[0]!.error as Record<string, { min_fee: number | string; fee_decomposition: Record<string, number | string> }>;
    expect(BigInt(fee.FeeTooSmallUTxO!.min_fee)).toBe(fxBig("s01.minFee"));
    expect(BigInt(fee.FeeTooSmallUTxO!.fee_decomposition.txSizeFee!)).toBe(fxBig("s01.txSizeFee"));
    expect(fxBig("s01.txSizeFee")).toBe(44n * BigInt(fxInt("s01.size") - 1) + 155381n);
    expect(fxBig("s01.fee")).toBeLessThan(fxBig("s01.minFee"));
    // the script data hash is stale on purpose: the validator expects the one the toolkit computes from the real cost models
    expect(result.errors[1]!.error_message).toContain(`Expected: ${fxStr("s01.scriptDataHash.expected")}`);
    expect(result.errors[1]!.error_message).toContain(`Found: ${fxStr("s01.scriptDataHash.provided")}`);
    // collateral covers 150 % of the fee
    expect(fxBig("s01.collateralTotal")).toBe((fxBig("s01.fee") * 150n + 99n) / 100n);
  });

  it("the ex-units: declared above calculated (slack), memory equal; the manifest and the eval JSON agree with the validator", async () => {
    const i = await imported(readFixtureText(fxStr("s01.contextFile")));
    const result = validateImported(i);
    const evalJson = readFixtureJson<{ tx_hex: string; protocol_parameters: { protocolVersion: [number, number]; costModels: Record<string, number[]> }; eval_redeemer_results: Array<Record<string, any>> }>(fxStr("s01.evalFile"));
    expect(evalJson.tx_hex).toBe(readContext("s01.contextFile").transaction);
    expect(evalJson.protocol_parameters.protocolVersion).toEqual([10, 0]);
    expect(Object.keys(evalJson.protocol_parameters.costModels)).toEqual(["plutusV1", "plutusV2", "plutusV3"]);
    expect(evalJson.protocol_parameters.costModels.plutusV2).toHaveLength(175);
    expect(evalJson.eval_redeemer_results.map((r) => [r.tag, r.index])).toEqual([["Spend", 2], ["Mint", 1]]);
    for (const [name, key] of [["Spend", "s01.spend"], ["Mint", "s01.mint"]] as const) {
      const live = result.eval_redeemer_results.find((r) => r.tag === name)!;
      const stored = evalJson.eval_redeemer_results.find((r) => r.tag === name)!;
      const units = fx<{ declared: { mem: string; steps: string }; calculated: { mem: string; steps: string }; deltaSteps: string }>(`${key}.exUnits`);
      expect(units.declared).toEqual({ mem: String(live.provided_ex_units.mem), steps: String(live.provided_ex_units.steps) });
      expect(units.calculated).toEqual({ mem: String(live.calculated_ex_units!.mem), steps: String(live.calculated_ex_units!.steps) });
      expect(BigInt(units.declared.steps)).toBeGreaterThan(BigInt(units.calculated.steps));
      expect(units.declared.mem).toBe(units.calculated.mem);
      expect(BigInt(units.deltaSteps)).toBe(BigInt(units.calculated.steps) - BigInt(units.declared.steps));
      // the stored raw result is the validator's, field for field
      for (const field of ["script_bytes", "script_context_bytes", "redeemer_bytes", "datum_bytes", "plutus_version", "success"]) expect(stored[field], `${name}.${field}`).toEqual((live as Json)[field]);
      expect(String(stored.provided_ex_units.steps)).toBe(units.declared.steps);
      expect(String(stored.calculated_ex_units.steps)).toBe(units.calculated.steps);
      expect(stored.logs).toEqual([]);
      expect(stored.success).toBe(true);
    }
    const spend = evalJson.eval_redeemer_results[0]!;
    expect(spend.script_bytes).toBe(readFixtureText(fxStr("s01.spendScriptFile")).trim());
    expect(spend.redeemer_bytes).toBe(fxStr("s01.spend.redeemerHex"));
    expect(spend.datum_bytes).toBe(fxStr("s01.spend.datumHex"));
    expect(evalJson.eval_redeemer_results[1]!.redeemer_bytes).toBe(fxStr("s01.mint.redeemerHex"));
    expect(evalJson.eval_redeemer_results[1]!.datum_bytes ?? null).toBeNull(); // a minting policy gets no datum
  });

  it("removing the vkey witnesses (same body) gives MissingVKeyWitnesses; the signed bytes do not", async () => {
    const file = readContext("s01.contextFile");
    const signed = await imported(file);
    expect(errorKinds(validateImported(signed))).not.toContain("MissingVKeyWitnesses");
    const unsignedHex = withoutWitnessKey(file.transaction, 0);
    expect(tk.tx.txHashOfBytes(unsignedHex)).toBe(fxStr("s01.txHash"));
    expect(errorKinds(validateImported(signed, unsignedHex))).toContain("MissingVKeyWitnesses");
  });

  it("a list datum on the script input fails spend:2 only (builtin failure on unConstrData); the mint policy ignores the datum", async () => {
    const file = readContext("s01.contextFile");
    file.utxos.find((u) => typeof u.inlineDatum === "string")!.inlineDatum = "81".repeat(100) + "00";
    const result = validateImported(await imported(file));
    expect(result.eval_redeemer_results.map((r) => [r.tag, r.success])).toEqual([["Spend", false], ["Mint", true]]);
    expect(String(result.eval_redeemer_results[0]!.error)).toMatch(/UnConstrData/);
    expect(result.phase2_errors).toHaveLength(1);
  });
});

/** An AppContext over the in-process library (offline, a fresh cache directory). */
function appContext(): AppContext {
  configure({ compressor: nodeBrotliCompressor });
  const config = { ...loadConfig({ CARDANO_DEBUG_OFFLINE: "1", CARDANO_DEBUG_NO_OPEN: "1" }), cacheDir: mkdtempSync(path.join(os.tmpdir(), "cdm-s01-")) };
  const lib = Object.assign(inProcessLib(), { dispose: async () => undefined }) as unknown as LibClient;
  return createAppContext({ config, lib });
}

describe("S1 through the tool code (tx_load, tx_validate over the in-process library)", () => {
  let ctx: AppContext;
  let txId: string;

  beforeAll(async () => {
    ctx = appContext();
    const load = await txLoad(ctx, { bundle: fixturePath(fxStr("s01.contextFile")) });
    expect(load.isError).toBeFalsy();
    txId = (load.structuredContent as Json).tx_id;
  }, 60_000);

  afterAll(async () => {
    await ctx.shutdown();
  });

  it("tx_load: the handle, counts, redeemers, scripts and the documented defaults", async () => {
    const load = (await txLoad(ctx, { bundle: fixturePath(fxStr("s01.contextFile")) })).structuredContent as Json;
    expect(load.tx_id).toBe(fxStr("s01.txId"));
    expect(load.tx_hash).toBe(fxStr("s01.txHash"));
    expect(load).toMatchObject({ network: "mainnet", source: "bundle", protocol_major: 10, size_bytes: fxInt("s01.size"), fee: fxStr("s01.fee") });
    expect(load.counts).toMatchObject({ inputs: 3, reference_inputs: 3, redeemers: 2, mint_policies: 2, outputs: 3, collateral: 1, vkey_witnesses: 4, datums: 0 });
    expect(load.redeemers.map((r: Json) => r.ref)).toEqual(["spend:2", "mint:1"]);
    expect(load.redeemers[0]).toMatchObject({ script_hash: fxStr("s01.spendScript.hash"), plutus_version: "V2", ex_units: { steps: fxStr("s01.spend.exUnits.declared.steps"), mem: fxStr("s01.spend.exUnits.declared.mem") } });
    expect(load.redeemers[1]).toMatchObject({ script_hash: fxStr("s01.mint.policy"), plutus_version: "V2" });
    const holder = fxStr("s01.spendScript.holder.prefix");
    expect(load.scripts.some((x: Json) => x.source.startsWith(`reference ${holder}`) && x.source.includes("hash derived") && x.script_hash === fxStr("s01.spendScript.hash") && x.size_bytes === fxInt("s01.spendScript.size"))).toBe(true);
    expect(load.scripts.some((x: Json) => x.plutus_version === "native" && x.script_hash === fxStr("s01.nativeScript.hash"))).toBe(true);
    expect(load.context).toMatchObject({ status: "bundle", utxos_resolved: 5, utxos_needed: 5, captured_at: null });
    expect(load.missing_utxos).toEqual([]);
    const defaults = (load.defaults_applied as string[]).join("\n");
    for (const part of ["minFeeCoefficientA/minFeeConstantB swapped", "slot=", "treasuryValue=0", "captured_at=null", "adaPerUtxoByte=4310"]) expect(defaults).toContain(part);
  });

  it("tx_validate: phase1_failed with the five diagnostics, both redeemers successful at full fidelity with slack ex-units", async () => {
    const v = (await txValidate(ctx, { tx_id: txId })).structuredContent as Json;
    expect(v.verdict).toBe("phase1_failed");
    expect(v.protocol_major).toBe(10);
    expect((v.phase1.errors as Json[]).map((e) => e.name)).toEqual(fx<string[]>("s01.diagnostics.errors"));
    expect(v.phase1.warnings).toEqual([]);
    expect((v.phase2.warnings as Json[]).map((w) => w.name)).toEqual(fx<string[]>("s01.diagnostics.phase2Warnings"));
    expect(v.phase2).toMatchObject({ redeemers_total: 2, failed_count: 0, errors: [] });
    expect((v.phase2.redeemers as Json[]).map((r) => [r.ref, r.success, r.fidelity, r.ex_units.verdict])).toEqual([["spend:2", true, "full", "slack"], ["mint:1", true, "full", "slack"]]);
    const fee = (v.phase1.errors as Json[]).find((e) => e.name === "FeeTooSmallUTxO")!;
    expect(fee.locations).toContain("transaction.body.fee");
    expect(fee.data).toMatchObject({ actual_fee: fxStr("s01.fee"), min_fee: fxStr("s01.minFee") });
    expect(fee.data.fee_decomposition.txSizeFee).toBe(fxStr("s01.txSizeFee"));
  });

  it("tx_redeemer(part='context'): output 0 is the spend script's enterprise address; input 0 is the wallet input", async () => {
    const out0 = (await txRedeemer(ctx, { tx_id: txId, redeemer: "spend:2", part: "context", path: "tx_info.outputs.0.address", depth: 2 } as never)).structuredContent as Json;
    expect(out0.path).toBe("tx_info.V2.outputs.0.address");
    expect(out0.value).toBe(fxStr("s01.out0.address"));
    const summary = (await txRedeemer(ctx, { tx_id: txId, redeemer: "Spending #2" } as never)).structuredContent as Json;
    expect(summary).toMatchObject({ ref: "spend:2", part: "summary", success: true, datum_present: true, context_available: true, fidelity: "full", plutus_version: "V2", script_size_bytes: fxInt("s01.spendScript.size") });
    expect(summary.redeemer_data).toEqual({ constructor: "0", fields: [] });
    const mint = (await txRedeemer(ctx, { tx_id: txId, redeemer: "r:1", part: "error" } as never)).structuredContent as Json;
    expect(mint).toMatchObject({ ref: "mint:1", category: "none", success: true });
  });

  it("dropping the funding UTxO from the context: tx_load names exactly it as missing, tx_validate answers incomplete_context", async () => {
    const patched = readContext("s01.contextFile");
    patched.utxos = patched.utxos.filter((u) => !(u.txHash === fxStr("s01.fundingTxId") && u.outputIndex === fxInt("s01.fundingIndex")));
    const dir = mkdtempSync(path.join(os.tmpdir(), "cdm-s01-patch-"));
    const patchedFile = path.join(dir, "incomplete.json");
    writeFileSync(patchedFile, JSON.stringify(patched));
    const other = appContext();
    try {
      const load = (await txLoad(other, { bundle: patchedFile })).structuredContent as Json;
      expect(load.missing_utxos).toEqual([fxStr("s01.fundingRef")]);
      const v = (await txValidate(other, { tx_id: load.tx_id })).structuredContent as Json;
      expect(v.verdict).toBe("incomplete_context");
    } finally {
      await other.shutdown();
    }
  });
});

describe("the script facts the manifest carries", () => {
  it("the spend script: V2, > 1,000 terms, > 400 listing lines, the pinned decompiler shape; hashes of the V1 / V3 readings of the same bytes differ", () => {
    const hash = fxStr("s01.spendScript.hash");
    const bytes = tk.scripts.registryBytesHex("order_fixed");
    expect(bytes).toBe(readFixtureText(fxStr("s01.spendScriptFile")).trim());
    expect(tk.script.hashScriptBytes(2, tk.bytes.hexToBytes(bytes))).toBe(hash);
    expect(tk.script.hashScriptBytes(1, tk.bytes.hexToBytes(bytes))).toBe(fxStr("s01.spendScript.hashV1"));
    expect(tk.script.hashScriptBytes(3, tk.bytes.hexToBytes(bytes))).toBe(fxStr("s01.spendScript.hashV3"));
    expect(new Set([hash, fxStr("s01.spendScript.hashV1"), fxStr("s01.spendScript.hashV3")]).size).toBe(3);
    expect(fxStr("s01.spendScript.header")).toMatch(/^59[0-9a-f]{4}$/);
    expect(fxInt("s01.spendScript.registry.termCount")).toBeGreaterThan(1_000);
    expect(fxInt("s01.spendScript.registry.pseudocodeLines")).toBeGreaterThanOrEqual(200);
    expect(fxInt("s01.spendScript.registry.pseudocodeMaxIndent")).toBeGreaterThan(0);
    expect(fxStr("s01.spendScript.registry.firstNote")).toMatch(/^Outer Apply chain/);
    expect(fxStr("s01.spendScript.registry.handlerLine")).toBe("spend(datum, redeemer, script_context) {");
    expect(fxStr("s01.mintScript.registry.handlerLine")).toMatch(/^mint\(/);
    expect(fxInt("s01.nativeScript.size")).toBe(196);
  });

  it("the three scripts are hashed the way the ledger hashes them and sit where the manifest says", () => {
    expect(fxStr("s01.mint.policy")).toBe(tk.scripts.registryHash("burn_mint"));
    expect(fxStr("s01.nativeScript.hash")).toBe(tk.script.scriptHash(tk.scripts.registryNative("multisig_3_of_6")));
    const mint = fxStr("s01.mint.policy");
    const native = fxStr("s01.nativeScript.hash");
    expect(native < mint, "mint:0 is the native policy, mint:1 burn_mint").toBe(true);
  });
});

describe("S1 debugger-facing numbers (s01.debug.*, measured by the engine) are what the engine says about the committed eval JSON", () => {
  const evalJson = readFixtureJson<{ protocol_parameters: { protocolVersion: [number, number]; costModels: Record<string, number[]> }; eval_redeemer_results: Array<Record<string, any>> }>(fxStr("s01.evalFile"));

  it("re-measuring gives the manifest's figures", () => {
    const again = measureHub(evalJson.eval_redeemer_results as never, evalJson.protocol_parameters);
    expect(JSON.parse(JSON.stringify(again))).toEqual(fx("s01.debug"));
    expect(fx("s01.debug.measured")).toBe(true);
  });

  it("the figures satisfy what the debugger tests need of a script this size", () => {
    const spend = fx<Json>("s01.debug.spend");
    const mint = fx<Json>("s01.debug.mint");
    expect(spend.termCount).toBeGreaterThan(1_000);
    expect(spend.uplcLines).toBeGreaterThan(400); // resource windows of 400 lines; page_cut at 600
    expect(spend.windowDedent).toBeGreaterThan(50);
    expect(spend.stepsTotal).toBeGreaterThan(300); // debug_run(until='steps', steps=300) stops short of the end
    expect(spend.scriptContextVersion).toBe("V1V2");
    expect(spend.scriptHash).toBe(fxStr("s01.spendScript.hash"));
    expect(mint.scriptHash).toBe(fxStr("s01.mint.policy"));
    expect(spend.cpuSpent).toBe(fxStr("s01.spend.exUnits.calculated.steps"));
    expect(spend.memSpent).toBe(fxStr("s01.spend.exUnits.calculated.mem"));
    expect(spend.cpuDeclared).toBe(fxStr("s01.spend.exUnits.declared.steps"));
    expect(mint.cpuSpent).toBe(fxStr("s01.mint.exUnits.calculated.steps"));
    expect(BigInt(spend.budgetStopCpu)).toBeLessThan(BigInt(spend.cpuSpent));
    expect(BigInt(spend.budgetStopCpu)).toBeGreaterThan(0n);
    expect(spend.cpuPct).toBeGreaterThan(50);
    expect(spend.cpuPct).toBeLessThan(100);
    expect(spend.profile.hotTerms).toHaveLength(5);
    expect(spend.profile.hotTerms[0].excerpt.length).toBeGreaterThan(0);
    expect(spend.traceCount).toBe(0);
    // the environment at UPLC line 12: names aligned with the lambda chain, builtins bound first
    expect(spend.envAtLine12.line).toBe(12);
    expect(spend.envAtLine12.total).toBe(4);
    expect(spend.envAtLine12.items.map((i: Json) => i.debruijn)).toEqual([4, 3, 2, 1]);
    expect(spend.envAtLine12.items[0]).toMatchObject({ name: "i", type: "Builtin" });
    expect(spend.envAtLine12.items[0].summary).toMatch(/^builtin /);
    expect(mint.scriptContextVersion).toBe("V1V2");
  });
});

describe("S2: S1's transaction with a spend script that never finishes", () => {
  const file = readContext("s02.contextFile");
  const base = readContext("s01.contextFile");

  it("is the same transaction (bytes, hash, handle); only utxos[0]'s script and the script input's address changed", () => {
    expect(file.transaction).toBe(base.transaction);
    expect(fxStr("s02.txHash")).toBe(fxStr("s01.txHash"));
    expect(fxStr("s02.txId")).toBe(fxStr("s01.txId"));
    expect(file.utxos).toHaveLength(5);
    expect(file.utxos.map((u) => `${u.txHash}#${u.outputIndex}`)).toEqual(fxArr<string>("s02.utxos"));
    expect(fxArr<string>("s02.utxos")).toEqual(fxArr<string>("s01.utxos"));
    expect(file.utxos[0]!.referenceScript).toEqual({ type: "PlutusV2", script: fxStr("s02.loopHex") });
    expect(`${file.utxos[0]!.txHash}#${file.utxos[0]!.outputIndex}`).toBe(fxStr("s02.loopHolder"));
    expect(fxInt("s02.loopSize")).toBe(file.utxos[0]!.referenceScript!.script.length / 2);
    for (const i of [1, 3, 4]) expect(file.utxos[i]).toEqual(base.utxos[i]);
    const input = file.utxos[2]!;
    expect({ ...input, address: undefined }).toEqual({ ...base.utxos[2]!, address: undefined });
    // the spend:2 input's address is the loop's script address, so spend:2 runs the loop
    expect(input.address).toBe(fxStr("s02.loopAddress"));
    expect(tk.bytes.bytesToHex(tk.address.parseAddress(input.address).payment!.hash)).toBe(fxStr("s02.loopHash"));
    expect(tk.script.hashScriptBytes(2, tk.bytes.hexToBytes(fxStr("s02.loopHex")))).toBe(fxStr("s02.loopHash"));
    expect(fxStr("s02.loopHash")).toBe(tk.scripts.registryHash("loop_v2"));
    expect(file.protocolParams).toEqual(base.protocolParams);
    expect(fxInt("s02.spendIndex")).toBe(2);
    expect(fxInt("s02.evalTimeoutMs")).toBe(2000);
  });

  it("tx_load resolves the loop from the input's address, version V2, without evaluating anything", async () => {
    const ctx = appContext();
    try {
      const load = (await txLoad(ctx, { bundle: fixturePath(fxStr("s02.contextFile")) })).structuredContent as Json;
      expect(load.tx_id).toBe(fxStr("s02.txId"));
      expect(load.redeemers[0]).toMatchObject({ ref: "spend:2", script_hash: fxStr("s02.loopHash"), plutus_version: "V2" });
      expect(load.scripts.some((s: Json) => s.script_hash === fxStr("s02.loopHash") && s.size_bytes === fxInt("s02.loopSize"))).toBe(true);
      expect(load.missing_utxos).toEqual([]);
    } finally {
      await ctx.shutdown();
    }
  });
});

describe("S3: a Spend redeemer aimed at a native-script input", () => {
  const file = readContext("s03.contextFile");

  it("the input sits at the address of `ScriptAll []`, the witness set carries that native script and a Spend 0 redeemer", () => {
    expect(file.network).toBe("mainnet");
    expect(file.utxos.map((u) => `${u.txHash}#${u.outputIndex}`)).toEqual(fxArr<string>("s03.utxos"));
    const guarded = file.utxos[0]!;
    expect(`${guarded.txHash}#${guarded.outputIndex}`).toBe(fxStr("s03.guardedInput"));
    expect(guarded.address).toBe(fxStr("s03.guardedAddress"));
    expect(tk.bytes.bytesToHex(tk.address.parseAddress(guarded.address).payment!.hash)).toBe(fxStr("s03.nativeScriptHash"));
    expect(fxStr("s03.nativeScriptHash")).toBe(tk.script.scriptHash(tk.scripts.registryNative("all_empty")));
    expect(fxStr("s03.redeemerRef")).toBe("spend:0");
    expect(tk.tx.txHashOfBytes(file.transaction)).toBe(fxStr("s03.txHash"));
    expect(fxStr("s03.txId")).toBe(`tx_mainnet_${fxStr("s03.txHash").slice(0, 12)}`);
    expect(file.transaction.length / 2).toBe(fxInt("s03.size"));
    const tx = decode(file.transaction) as Extract<Cbor, { t: "array" }>;
    const witnesses = tx.items[1]!;
    expect(mapGet(witnesses, 1)).toBeDefined(); // the native script
    expect(mapGet(witnesses, 5)).toBeDefined(); // the redeemer
    expect(mapGet(witnesses, 3)).toBeUndefined();
    expect(mapGet(witnesses, 6)).toBeUndefined();
    expect(mapGet(witnesses, 7)).toBeUndefined();
  });

  it("phase 2 gives MissingRequiredScript for it (the server adds the NATIVE-script hint); phase 1 is clean", async () => {
    const result = validateImported(await imported(readFixtureText(fxStr("s03.contextFile"))));
    expect(errorKinds(result)).toEqual(fx<string[]>("s03.phase1Errors"));
    expect(errorKinds(result)).toEqual([]);
    expect(result.phase2_errors.map((e) => Object.keys((e as { error?: object }).error ?? (e as object))[0])).toEqual(["MissingRequiredScript"]);
    expect(fx<string[]>("s03.phase2Errors")).toEqual(["MissingRequiredScript"]);
  });

  it("tx_load marks the redeemer's script as native", async () => {
    const ctx = appContext();
    try {
      const load = (await txLoad(ctx, { bundle: fixturePath(fxStr("s03.contextFile")) })).structuredContent as Json;
      expect(load.tx_id).toBe(fxStr("s03.txId"));
      expect(load.redeemers).toHaveLength(1);
      expect(load.redeemers[0]).toMatchObject({ ref: "spend:0", plutus_version: "native", script_hash: fxStr("s03.nativeScriptHash") });
    } finally {
      await ctx.shutdown();
    }
  });
});

