import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { importContext } from "../../../src/chain/bundle.js";
import { stringifyForLib } from "../../../src/chain/contextCodec.js";
import { buildAll, diffAll, FIXTURES_ROOT } from "../../fixtures/synthetic/build.js";
import { lookup, manifestText, mergeManifest, toManifestValue } from "../../fixtures/synthetic/lib/manifest.js";
import { cborToJson, decodeType } from "../../fixtures/synthetic/lib/validator.js";
import { fixturePath, fx, fxArr, fxBig, fxHas, fxInt, fxKeys, fxNum, fxStr, readFixtureJson, readFixtureText, readTx } from "../../helpers/fixtures.js";
import { inProcessLib } from "../../helpers/inProcessLib.js";

describe("fixtures:build", () => {
  it("the transaction handle in the manifest is the server's: tx_<network>_<12 hex of the hash>", () => {
    expect(fxStr("s12.txId")).toBe(`tx_mainnet_${fxStr("s12.txHash").slice(0, 12)}`);
    expect(fxStr("payment.txId")).toBe(`tx_mainnet_${fxStr("payment.txHash").slice(0, 12)}`);
  });

  it("is deterministic: two builds give identical files and manifest", () => {
    const a = buildAll();
    const b = buildAll();
    expect([...a.files.keys()]).toEqual([...b.files.keys()]);
    for (const [file, content] of a.files) expect(Buffer.from(content as string).equals(Buffer.from(b.files.get(file) as string)), file).toBe(true);
    expect(a.manifest).toEqual(b.manifest);
  });

  it("fixtures:check: the committed files are what a rebuild produces", () => {
    expect(diffAll(buildAll())).toEqual([]);
  });

  it("every scenario's manifest keys are prefixed with its name; _files lists exactly the generated files", () => {
    const built = buildAll();
    for (const key of Object.keys(built.manifest)) {
      if (key === "_files") continue;
      expect(Object.keys(built.byScenario).some((name) => key.startsWith(`${name}.`)), key).toBe(true);
    }
    const listed = built.manifest._files as string[];
    expect(listed).toEqual(Object.values(built.byScenario).flat().sort());
    for (const file of listed) expect(existsSync(path.join(FIXTURES_ROOT, file)), file).toBe(true);
  });

  it("manifest merge rules: prefix, duplicates, JSON conversion", () => {
    const into = {};
    mergeManifest(into, "x", { "x.a": 1n, "x.b": new Uint8Array([1, 255]), "x.c": { d: [1n, "s"], dropped: undefined } });
    expect(into).toEqual({ "x.a": "1", "x.b": "01ff", "x.c": { d: ["1", "s"] } });
    expect(() => mergeManifest(into, "x", { "y.a": 1 })).toThrow(/must start with "x\."/);
    expect(() => mergeManifest(into, "x", { "x.a": 2 })).toThrow(/already set/);
    expect(() => toManifestValue(Number.NaN)).toThrow(/finite/);
    expect(() => toManifestValue(() => 1)).toThrow(/cannot record/);
    expect(manifestText({ b: 1, a: { z: 1, y: 2 } })).toBe('{\n  "a": {\n    "y": 2,\n    "z": 1\n  },\n  "b": 1\n}\n');
    expect(lookup({ "a.b": { c: { d: 5 } } }, "a.b.c.d")).toEqual({ found: true, value: 5 });
    expect(lookup({ "a.b": 1 }, "a.b.c").found).toBe(false);
  });
});

describe("the manifest accessor (test/helpers/fixtures.ts)", () => {
  it("reads values by key, typed, and paths into objects", () => {
    expect(fxStr("s12.txHash")).toHaveLength(64);
    expect(fxInt("s12.size")).toBe(197);
    expect(fxNum("s12.spans.body.offset")).toBe(1);
    expect(fxBig("s12.fee")).toBe(173_333n);
    expect(fxBig("payment.fee")).toBeGreaterThan(0n);
    expect(fxArr("payment.utxos")).toHaveLength(2);
    expect(fxHas("s12.txId")).toBe(true);
    expect(fxHas("s12.nope")).toBe(false);
    expect(fxKeys("s12.").length).toBeGreaterThan(5);
    expect(fxKeys("").some((k) => k.startsWith("_"))).toBe(false);
  });

  it("a missing key is a clear error naming what exists; a wrong type too", () => {
    expect(() => fx("s12.txid")).toThrow(/fixture manifest has no key "s12\.txid" \(scenario "s12" has: .*s12\.txHash/);
    expect(() => fx("nothing.here")).toThrow(/no scenario "nothing" in the manifest; run `npm run fixtures:build`/);
    expect(() => fxNum("s12.txHash")).toThrow(/is a string, not a number/);
    expect(() => fxStr("s12.size")).toThrow(/is a number, not a string/);
    expect(() => fxInt("s12.txHash")).toThrow(/not a number/);
    expect(() => fxBig("s12.txHash")).toThrow(/not an integer/);
    expect(() => fxArr("s12.txHash")).toThrow(/not an array/);
  });

  it("file helpers", () => {
    expect(readTx("vote-tx.tx")).toMatch(/^84[0-9a-f]+$/);
    expect(readFixtureText("vote-tx.tx").trim()).toBe(readTx("vote-tx.tx"));
    expect(fixturePath("vote-tx.tx")).toBe(path.join(FIXTURES_ROOT, "vote-tx.tx"));
    expect(readFixtureJson<{ cardano_debug_bundle: number }>("payment.bundle.json").cardano_debug_bundle).toBe(1);
  });
});

describe("scenario payment", () => {
  const lib = inProcessLib();

  it("the tx is signed and valid: the bundle imports and validates with no diagnostic", async () => {
    const imported = await importContext(lib, readFixtureText("payment.bundle.json"));
    expect(imported.kind).toBe("bundle");
    expect(imported.network).toBe("mainnet");
    expect(imported.txHex).toBe(readTx("payment.tx"));
    expect(imported.txHash).toBe(fxStr("payment.txHash"));
    expect(imported.slot).toBe(fxBig("payment.slot"));
    expect(imported.context.utxoSet).toHaveLength(2);
    const result = await lib.validateTx(imported.txHex, stringifyForLib(imported.context));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.phase2_errors).toEqual([]);
    const sig = (await lib.checkSignatures(imported.txHex)) as { valid?: boolean };
    expect(sig.valid).toBe(true);
  });

  it("the tx says what the manifest says", () => {
    const dec = decodeType<{ transaction_hash: string; transaction: { body: Record<string, any>; witness_set: { vkeys: unknown[] } } }>(readTx("payment.tx"), "Transaction");
    expect(dec.transaction_hash).toBe(fxStr("payment.txHash"));
    expect(dec.transaction.body.fee).toBe(String(fxBig("payment.fee")));
    expect(dec.transaction.body.ttl).toBe(String(fxBig("payment.ttl")));
    expect(dec.transaction.body.outputs[0].address).toBe(fxStr("payment.recipientAddress"));
    expect(dec.transaction.body.outputs[1].address).toBe(fxStr("payment.senderAddress"));
    expect(dec.transaction.body.outputs[0].amount.coin).toBe(fxStr("payment.recipientCoin"));
    expect(dec.transaction.body.outputs[0].amount.multiasset[fxStr("payment.policyId")][fxStr("payment.assetNameHex")]).toBe("10");
    expect(dec.transaction.witness_set.vkeys).toHaveLength(fxInt("payment.vkeyCount"));
    expect(readTx("payment.tx").length / 2).toBe(fxInt("payment.size"));
  });

  it("the DebuggerContext loads too (with the quirks real dumps have, listed in defaults_applied) and validates", async () => {
    // like tx_load: a DebuggerContext has no tip, so the slot is chosen from the transaction's validity interval
    const imported = await importContext(lib, readFixtureText("payment.debugger-context.json"), { validity: { end: fxBig("payment.ttl") } });
    expect(imported.kind).toBe("de_uplc_context");
    expect(imported.txHex).toBe(readTx("payment.tx"));
    expect(imported.context.utxoSet.map((u) => `${u.utxo.input.txHash}#${u.utxo.input.outputIndex}`)).toEqual(fxArr<string>("payment.utxos"));
    expect(imported.defaultsApplied.join("\n")).toMatch(/minFeeCoefficientA\/minFeeConstantB swapped/);
    expect(imported.defaultsApplied.join("\n")).toMatch(/adaPerUtxoByte=4310/);
    const result = await lib.validateTx(imported.txHex, stringifyForLib(imported.context));
    expect(result.errors).toEqual([]);
    expect(result.phase2_errors).toEqual([]);
  });
});

describe("scenario s12: the byte contract of the vote transaction", () => {
  const hex = readTx("vote-tx.tx");
  const span = (name: string) => fx<{ offset: number; length: number }>(`s12.spans.${name}`);

  it("197 bytes with every span where the CBOR tests look for it", () => {
    expect(hex.length / 2).toBe(197);
    expect(fxInt("s12.size")).toBe(197);
    expect(span("body")).toEqual({ offset: 1, length: 193 });
    expect(span("inputs")).toEqual({ offset: 3, length: 40 }); // tag 258 + array
    expect(span("outputsKey")).toEqual({ offset: 43, length: 1 });
    expect(span("outputs")).toEqual({ offset: 44, length: 70 });
    expect(span("fee")).toEqual({ offset: 115, length: 5 });
    expect(span("votesKey")).toEqual({ offset: 120, length: 1 });
    expect(span("votes")).toEqual({ offset: 121, length: 73 });
    expect(span("witnessSet")).toEqual({ offset: 194, length: 1 });
    expect(span("isValid")).toEqual({ offset: 195, length: 1 });
    expect(span("aux")).toEqual({ offset: 196, length: 1 });
    const bytes = Buffer.from(hex, "hex");
    expect(bytes.subarray(115, 120).toString("hex")).toBe("1a0002a515");
    expect(bytes[43]).toBe(0x01);
    expect(bytes[120]).toBe(0x13); // key 19
    expect([bytes[194], bytes[195], bytes[196]]).toEqual([0xa0, 0xf5, 0xf6]);
    expect(bytes.subarray(3, 6).toString("hex")).toBe("d90102"); // tag 258
    expect(fxBig("s12.fee")).toBe(173_333n);
  });

  it("the manifest carries the body bytes and where a truncated copy fails", () => {
    expect(fxStr("s12.bodyHex")).toBe(hex.slice(2, 2 + 193 * 2));
    for (const [key, cut] of [["minus10", 10], ["minus20", 20]] as const) {
      const t = fx<{ length: number; kind: string; offset: number; path: string }>(`s12.truncated.${key}`);
      expect(t.length).toBe(197 - cut);
      const res = cborToJson(hex.slice(0, t.length * 2)) as unknown as { ok: boolean; error: { kind: string; offset: number; path: string } };
      expect(res.ok).toBe(false);
      expect(res.error).toMatchObject({ kind: t.kind, offset: t.offset, path: t.path });
      expect(t.kind).toBe("unexpected_eof");
      expect(t.offset).toBeLessThan(t.length);
    }
  });

  it("the library's own positional tree agrees with the manifest", () => {
    const root = (cborToJson(hex) as unknown as { value: any }).value;
    expect(root.struct_position_info).toEqual({ offset: 0, length: 197 });
    const body = root.values[0];
    expect(body.struct_position_info).toEqual({ offset: 1, length: 193 });
    const entry = (k: number) => body.values.find((e: any) => e.key.value === k);
    expect(entry(0).value.struct_position_info).toEqual({ offset: 3, length: 40 });
    expect(entry(0).value.tag).toBe("Unassigned(258)");
    expect(entry(1).key.position_info.offset).toBe(43);
    expect(entry(1).value.struct_position_info).toEqual({ offset: 44, length: 70 });
    expect(entry(1).value.values[0].values[0].position_info.length).toBe(59); // a 57-byte base address plus its 2-byte head
    expect(entry(1).value.values[0].values[1].type).toBe("U64");
    expect(entry(2).value.position_info).toEqual({ offset: 115, length: 5 });
    expect(entry(19).key.position_info.offset).toBe(120);
    expect(entry(19).value.struct_position_info).toEqual({ offset: 121, length: 73 });
    expect(root.values[1].struct_position_info).toEqual({ offset: 194, length: 1 });
    expect(body.values.map((e: any) => e.key.value)).toEqual([0, 1, 2, 19]);
  });

  it("decodes as a Conway transaction: one DRep vote, no witnesses, input index 2", () => {
    const dec = decodeType<{ transaction_hash: string; transaction: { body: Record<string, any>; witness_set: Record<string, unknown>; is_valid: boolean; auxiliary_data: unknown } }>(hex, "Transaction");
    expect(dec.transaction_hash).toBe(fxStr("s12.txHash"));
    const b = dec.transaction.body;
    expect(b.inputs).toEqual([{ transaction_id: fxStr("s12.inputTxHash"), index: fxInt("s12.inputIndex") }]);
    expect(b.inputs[0].index).toBe(2);
    expect(b.outputs).toHaveLength(1);
    expect(b.outputs[0].address).toBe(fxStr("s12.outputAddress"));
    expect(b.outputs[0].amount.coin).toBe(String(fxBig("s12.outputCoin")));
    expect(b.fee).toBe("173333");
    expect(b.voting_procedures).toHaveLength(1);
    expect(b.voting_procedures[0].voter).toEqual({ DRep: { Key: fxStr("s12.voterKeyHash") } });
    expect(b.voting_procedures[0].votes[0].action_id).toEqual({ transaction_id: fxStr("s12.govActionTxId"), index: fxInt("s12.govActionIndex") });
    expect(b.voting_procedures[0].votes[0].voting_procedure).toEqual({ vote: "No", anchor: null });
    expect(dec.transaction.is_valid).toBe(true);
    expect(dec.transaction.auxiliary_data).toBeNull();
    expect(Object.values(dec.transaction.witness_set).every((v) => v === null)).toBe(true);
  });

  it("the library's CDDL view: valid Conway transaction", async () => {
    const cddl = readFileSync(path.join(FIXTURES_ROOT, "..", "..", "src", "assets", "cddl", "conway.cddl"), "utf8");
    const res = await inProcessLib().validateAgainstCddl(hex, cddl, "transaction");
    expect(res).toEqual({ valid: true });
  });
});
