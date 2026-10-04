// The plain-transaction scenarios s07..s11: each fixture says what its manifest says, has the shape the consumer tests rely on, and is
// signed for real. (That each is also VALID under the real validator is checked at build time: the scenarios fit with `expect: valid`,
// and test/e2e/chain.e2e.test.ts replays s08 end to end through a Koios stub.)
import { describe, expect, it } from "vitest";

import { loadEraCddl } from "../../../src/cbor/presets.js";
import { parseAddress, base58Decode } from "../../fixtures/synthetic/lib/address.js";
import { bytesToHex, hexToBytes } from "../../fixtures/synthetic/lib/bytes.js";
import { blake2b256 } from "../../fixtures/synthetic/lib/blake2b.js";
import { hashScriptBytes } from "../../fixtures/synthetic/lib/script.js";
import { datumHash } from "../../fixtures/synthetic/lib/plutusData.js";
import { decodeType } from "../../fixtures/synthetic/lib/validator.js";
import { fx, fxArr, fxBig, fxInt, fxStr, readFixtureJson, readTx } from "../../helpers/fixtures.js";
import { inProcessLib, rawLib } from "../../helpers/inProcessLib.js";

type Json = Record<string, any>;

const decoded = (name: string) => decodeType<{ transaction_hash: string; transaction: { body: Json; witness_set: Json; is_valid: boolean; auxiliary_data: Json | null } }>(readTx(name), "Transaction");
const validateCddl = (hex: string, era: "conway" | "babbage") =>
  JSON.parse(rawLib().validate_cbor_against_cddl!(hex, loadEraCddl(era), "transaction") as string) as { valid: boolean; error?: { path?: string } };
const signaturesOk = async (name: string) => ((await inProcessLib().checkSignatures(readTx(name))) as { valid?: boolean }).valid;
const hexAt = (hex: string, span: { offset: number; length: number }) => hex.slice(span.offset * 2, (span.offset + span.length) * 2);

/** Every scenario: the transaction file is the one the manifest describes. */
describe.each([
  ["s07", "pool-mint.tx"],
  ["s08", "lock-spend.tx"],
  ["s09", "wide-mint.tx"],
  ["s10", "multi-redeemer.tx"],
  ["s11", "datum-lock.tx"],
])("scenario %s: %s says what the manifest says", (name, file) => {
  it("hash, id, size, fee, network, vkey count", async () => {
    const hex = readTx(file);
    const dec = decoded(file);
    expect(dec.transaction_hash).toBe(fxStr(`${name}.txHash`));
    expect(fxStr(`${name}.txId`)).toBe(`tx_mainnet_${fxStr(`${name}.txHash`).slice(0, 12)}`);
    expect(hex.length / 2).toBe(fxInt(`${name}.size`));
    expect(dec.transaction.body.fee).toBe(String(fxBig(`${name}.fee`)));
    expect(fxStr(`${name}.network`)).toBe("mainnet");
    expect(dec.transaction.witness_set.vkeys).toHaveLength(fxInt(`${name}.vkeyCount`));
    expect(dec.transaction.is_valid).toBe(true);
    expect(await signaturesOk(file), "every vkey witness signs the body").toBe(true);
    expect(validateCddl(hex, "conway").valid, JSON.stringify(validateCddl(hex, "conway").error)).toBe(true);
  });
});

describe("scenario s07: two V3 witness minting scripts", () => {
  const hex = readTx("pool-mint.tx");
  const dec = decoded("pool-mint.tx");
  const span = (n: string) => fx<{ offset: number; length: number }>(`s07.spans.${n}`);

  it("two inputs, three outputs that all carry an inline datum, one required signer, collateral with a return and a total", () => {
    const body = dec.transaction.body;
    expect(body.inputs).toHaveLength(2);
    expect(body.outputs).toHaveLength(fxInt("s07.outputCount"));
    for (const output of body.outputs) expect(Object.keys(output.plutus_data ?? {})).toEqual(["Data"]);
    expect(body.required_signers).toHaveLength(1);
    expect(body.collateral).toHaveLength(1);
    expect(body.collateral_return).toBeTruthy();
    expect(body.total_collateral).toBeTruthy();
    expect(body.mint.map(([policy]: [string]) => policy)).toEqual(fxArr("s07.mintPolicies"));
  });

  it("array-form redeemers Mint 0 / Mint 1 with the manifest's ex-units", () => {
    expect(dec.transaction.witness_set.redeemers.map((r: Json) => [r.tag, r.index, r.ex_units.mem, r.ex_units.steps])).toEqual(
      fxArr<Json>("s07.redeemers").map((r) => ["Mint", String(r.index), String(r.mem), String(r.steps)]),
    );
    expect(hexAt(hex, span("redeemers")).slice(0, 2)).toBe("82"); // a definite array of two (the map form would start with a2)
  });

  it("tag 258 on the input set, the collateral set and the vkey set; plain arrays elsewhere", () => {
    for (const set of ["inputs", "collateral", "vkeys"]) expect(hexAt(hex, span(set)).slice(0, 6), set).toBe("d90102");
    expect(hexAt(hex, span("v3Scripts")).slice(0, 6)).not.toBe("d90102");
  });

  it("both scripts are PlutusV3, at least 256 bytes (59xxxx header) with the flat 1.1.0 header, hashed as the manifest says", () => {
    const scripts = dec.transaction.witness_set.plutus_scripts as Array<{ bytes: string; language: string }>;
    expect(scripts).toHaveLength(fxInt("s07.scriptCount"));
    const expected = fxArr<{ hash: string; size: number; version: string }>("s07.scripts");
    scripts.forEach((script, i) => {
      expect(script.language).toBe("PlutusV3");
      expect(script.bytes.startsWith("59"), "single-wrapped, 2-byte length").toBe(true);
      expect(script.bytes.slice(6, 12)).toBe("010100"); // flat: version 1.1.0
      expect(script.bytes.length / 2).toBe(expected[i]!.size);
      expect(expected[i]!.size).toBeGreaterThanOrEqual(256);
      expect(hashScriptBytes(3, script.bytes)).toBe(expected[i]!.hash);
    });
  });

  it("valid Conway CDDL; the Babbage CDDL objects at $[0][0] first, then $[0][13], $[1][0] and the V3 script key $[1][7]", () => {
    expect(validateCddl(hex, "conway").valid).toBe(true);
    const babbage = validateCddl(hex, "babbage");
    expect(babbage.valid).toBe(false);
    expect(babbage.error!.path).toBe("$[0][0]");
  });
});

describe("scenario s08: a V2 reference-script spend with a witness datum", () => {
  const dec = decoded("lock-spend.tx");
  const body = dec.transaction.body;

  it("two inputs in ledger order, the listing second (Spend 1 `Constr 1 []`), one reference input that the transaction does not carry", () => {
    const inputs = fxArr<{ txHash: string; index: number }>("s08.inputs");
    expect(body.inputs.map((i: Json) => [i.transaction_id, i.index])).toEqual(inputs.map((i) => [i.txHash, i.index]));
    expect(`${inputs[1]!.txHash}#${inputs[1]!.index}`).toBe(fxStr("s08.spendInput"));
    expect([...inputs].sort((a, b) => a.txHash.localeCompare(b.txHash))).toEqual(inputs);
    expect(body.reference_inputs).toHaveLength(1);
    expect(`${body.reference_inputs[0].transaction_id}#${body.reference_inputs[0].index}`).toBe(fxStr("s08.referenceInput"));
    expect(body.inputs.some((i: Json) => i.transaction_id === body.reference_inputs[0].transaction_id)).toBe(false);
    const redeemers = dec.transaction.witness_set.redeemers as Json[];
    expect(redeemers).toHaveLength(1);
    expect(redeemers[0]).toMatchObject({ tag: "Spend", index: "1", data: JSON.stringify({ constructor: 1, fields: [] }) });
    expect(redeemers[0]!.ex_units).toEqual({ mem: String(fx("s08.redeemer.mem")), steps: String(fx("s08.redeemer.steps")) });
  });

  it("two outputs (output 1 carries the CIP-68 token and the manifest's coin), ttl + validity start, metadata, collateral, one signer, three vkeys, one datum", () => {
    expect(body.outputs).toHaveLength(fxInt("s08.outputCount"));
    expect(body.outputs[0].amount.coin).toBe(fxStr("s08.out0Coin"));
    expect(body.outputs[1].amount.coin).toBe(fxStr("s08.out1Coin"));
    const asset = fx<{ policy: string; nameHex: string; quantity: string }>("s08.out1Asset");
    expect(body.outputs[1].amount.multiasset[asset.policy][asset.nameHex]).toBe(asset.quantity);
    expect(asset.nameHex.startsWith("000de140")).toBe(true); // CIP-68 label 222
    expect(body.ttl).toBe(String(fxBig("s08.ttl")));
    expect(body.validity_start_interval).toBe(String(fxBig("s08.validityStart")));
    expect(Object.keys(dec.transaction.auxiliary_data!.metadata)).toEqual(fxArr<number>("s08.metadataLabels").map(String));
    expect(`${body.collateral[0].transaction_id}#${body.collateral[0].index}`).toBe(fxStr("s08.collateralInput"));
    expect(body.collateral_return && body.total_collateral).toBeTruthy();
    expect(body.required_signers).toEqual([fxStr("s08.requiredSigner")]);
    expect(dec.transaction.witness_set.vkeys).toHaveLength(3);
    expect(dec.transaction.witness_set.plutus_data.elems).toHaveLength(fxInt("s08.datumCount"));
    expect(dec.transaction.witness_set.plutus_scripts ?? []).toHaveLength(0); // the script arrives by reference
  });

  it("the provider rows are those of an on-chain transaction: its tx row, the four UTxOs it uses, the epoch's parameters and totals", () => {
    const rows = readFixtureJson<{ network: string; tx: Json; utxos: Json[]; epoch_params: Json; totals: Json }>(fxStr("s08.providerRows"));
    expect(rows.network).toBe("mainnet");
    expect(rows.tx).toMatchObject({ tx_hash: fxStr("s08.txHash"), cbor: readTx("lock-spend.tx"), epoch_no: fxInt("s08.epoch"), absolute_slot: Number(fxBig("s08.slot")), valid_contract: true });
    expect(rows.utxos).toHaveLength(fxInt("s08.utxoCount"));
    const refs = rows.utxos.map((u) => `${u.tx_hash}#${u.tx_index}`);
    for (const ref of [fxStr("s08.spendInput"), fxStr("s08.referenceInput"), fxStr("s08.collateralInput"), ...fxArr<{ txHash: string; index: number }>("s08.inputs").map((i) => `${i.txHash}#${i.index}`)]) expect(refs).toContain(ref);
    const holder = rows.utxos.find((u) => `${u.tx_hash}#${u.tx_index}` === fxStr("s08.referenceInput"))!;
    expect(holder.reference_script).toMatchObject({ hash: fxStr("s08.scriptHash"), type: "plutusV2" });
    expect(rows.epoch_params.epoch_no).toBe(fxInt("s08.epoch"));
    expect(rows.totals.epoch_no).toBe(fxInt("s08.epoch"));
  });
});

describe("scenario s09: 26 outputs, 25 minted assets under one native policy", () => {
  const dec = decoded("wide-mint.tx");
  const body = dec.transaction.body;

  it("the counts, the native policy, the 721 metadata and the size close to the 16 KB limit", () => {
    expect(body.outputs).toHaveLength(fxInt("s09.outputCount"));
    expect(body.outputs.filter((o: Json) => o.plutus_data?.Data !== undefined)).toHaveLength(fxInt("s09.datumOutputCount"));
    expect(body.mint).toHaveLength(1);
    expect(body.mint[0][0]).toBe(fxStr("s09.mintPolicy"));
    expect(Object.keys(body.mint[0][1])).toHaveLength(fxInt("s09.mintedAssetCount"));
    const native = dec.transaction.witness_set.native_scripts as unknown[];
    expect(native).toHaveLength(1);
    expect(body.reference_inputs).toHaveLength(2);
    expect(body.required_signers).toHaveLength(1);
    expect(Object.keys(dec.transaction.auxiliary_data!.metadata)).toEqual([String(fx("s09.metadataLabel"))]);
    expect(fxInt("s09.size")).toBeGreaterThan(12_000);
    expect(fxInt("s09.size")).toBeLessThanOrEqual(16_384);
  });

  it("the datums are big enough that the typed decode and the output rows overflow the tools' character budgets", () => {
    expect(fx<{ min: number }>("s09.datumBytes").min).toBeGreaterThan(200);
    expect(JSON.stringify(dec).length).toBeGreaterThan(40_000);
  });
});

describe("scenario s10: four map-form redeemers", () => {
  const hex = readTx("multi-redeemer.tx");
  const dec = decoded("multi-redeemer.tx");
  const body = dec.transaction.body;

  it("Spend 0, Spend 1, Mint 0, Reward 0 in a map (a4) with the manifest's ex-units", () => {
    expect(hexAt(hex, fx("s10.redeemersSpan")).slice(0, 2)).toBe("a4");
    expect(dec.transaction.witness_set.redeemers.map((r: Json) => [r.tag.toLowerCase(), Number(r.index), r.ex_units.mem, r.ex_units.steps])).toEqual(
      fxArr<Json>("s10.redeemers").map((r) => [r.tag, r.index, String(r.mem), String(r.steps)]),
    );
    expect(fxArr("s10.redeemers")).toHaveLength(fxInt("s10.redeemerCount"));
  });

  it("three inputs, four outputs (one with a datum hash, one inline), a zero withdrawal from a script stake address, a burn, four reference inputs, two definite witness datums", () => {
    expect(body.inputs).toHaveLength(3);
    expect(body.outputs).toHaveLength(fxInt("s10.outputCount"));
    expect(body.outputs.map((o: Json) => Object.keys(o.plutus_data ?? {})[0] ?? null)).toEqual(["DataHash", "Data", null, null]);
    expect(body.withdrawals).toEqual({ [fxStr("s10.rewardAccount")]: "0" });
    expect(parseAddress(fxStr("s10.rewardAccount")).stake?.kind).toBe("script");
    expect(body.mint).toEqual([[fxStr("s10.mintPolicy"), { [Object.keys(body.mint[0][1])[0]!]: fxStr("s10.mintQuantity") }]]);
    expect(body.reference_inputs).toHaveLength(4);
    expect(body.required_signers).toHaveLength(1);
    expect(body.collateral).toHaveLength(1);
    const datums = dec.transaction.witness_set.plutus_data as { elems: unknown[]; definite_encoding: boolean };
    expect(datums.elems).toHaveLength(fxInt("s10.datumCount"));
    expect(datums.definite_encoding).toBe(true);
  });
});

describe("scenario s11: a datum-hash lock", () => {
  const dec = decoded("datum-lock.tx");
  const body = dec.transaction.body;

  it("output 0 sits at the order script's address with the datum's hash, the change carries one asset, no redeemers, no collateral", () => {
    expect(body.inputs).toHaveLength(1);
    expect(body.outputs).toHaveLength(fxInt("s11.outputCount"));
    expect(body.outputs[0].address).toBe(fxStr("s11.scriptAddress"));
    expect(body.outputs[0].plutus_data).toEqual({ DataHash: fxStr("s11.datumHash") });
    expect(body.outputs[1].address).toBe(fxStr("s11.makerAddress"));
    const assets = body.outputs[1].amount.multiasset as Json;
    expect(Object.keys(assets)).toEqual([fxStr("s11.policyId")]);
    expect(assets[fxStr("s11.policyId")]).toEqual({ [fxStr("s11.assetNameHex")]: "100000" });
    expect(dec.transaction.witness_set.redeemers ?? []).toHaveLength(0);
    expect(body.collateral ?? []).toHaveLength(0);
    expect(dec.transaction.witness_set.plutus_data.elems).toHaveLength(fxInt("s11.datumCount"));
    expect(Object.keys(dec.transaction.auxiliary_data!.metadata)).toEqual([String(fx("s11.metadataLabel"))]);
  });

  it("the identifiers the data-view tests reuse are consistent with each other", () => {
    const script = parseAddress(fxStr("s11.scriptAddress"));
    expect(script.hex).toBe(fxStr("s11.scriptAddressHex"));
    expect(script.payment).toMatchObject({ kind: "script" });
    expect(bytesToHex(script.payment!.hash)).toBe(fxStr("s11.scriptHash"));
    expect(script.stake).toBeUndefined();
    const maker = parseAddress(fxStr("s11.makerAddress"));
    expect(bytesToHex(maker.payment!.hash)).toBe(fxStr("s11.makerPaymentKeyHash"));
    expect(bytesToHex(maker.stake!.hash)).toBe(fxStr("s11.makerStakeKeyHash"));
    expect(parseAddress(fxStr("s11.makerStakeAddress")).stake && bytesToHex(parseAddress(fxStr("s11.makerStakeAddress")).stake!.hash)).toBe(fxStr("s11.makerStakeKeyHash"));
    expect(datumHash(fxStr("s11.datumHex"))).toBe(fxStr("s11.datumHash"));
    expect(bytesToHex(blake2b256(hexToBytes(fxStr("s11.datumHex"))))).toBe(fxStr("s11.datumHash"));
    expect(fxStr("s11.unit")).toBe(fxStr("s11.policyId") + fxStr("s11.assetNameHex"));
    expect(Buffer.from(fxStr("s11.assetNameHex"), "hex").toString("utf8")).toBe(fxStr("s11.assetName"));
    expect(fxStr("s11.byronAddress")).not.toMatch(/^(addr|stake)/);
    expect(base58Decode(fxStr("s11.byronAddress")).length).toBeGreaterThan(30);
  });
});
