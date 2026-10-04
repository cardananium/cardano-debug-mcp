import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ValidationInputContext } from "@cardananium/cquisitor-lib";
import type { KoiosProposal } from "@cardananium/cquisitor-lib/chain/koiosTypes";
import { koiosProposalToGovActionContext } from "@cardananium/cquisitor-lib/chain/transactionValidation";
import { describe, expect, it } from "vitest";

import {
  chooseSlot,
  detectImportKind,
  encodeBundle,
  importBundle,
  importContext,
  importDeUplcContext,
  MAX_BUNDLE_BYTES,
  protocolParamsFromDeUplc,
  readBundleArgument,
  slotNow,
  type BundleV1,
} from "../../../src/chain/bundle.js";
import { completeChangedParameters, normalizeValidationInputContext, stringifyForLib } from "../../../src/chain/contextCodec.js";
import { bytesKey, isIncludedBytes } from "../../../src/chain/onChain.js";
import { parseJsonBigintSafe } from "../../../src/vocab/json.js";
import { fixturePath, fxArr, fxInt, fxStr } from "../../helpers/fixtures.js";
import { inProcessLib } from "../../helpers/inProcessLib.js";

/** The artificial S1 sample: a DebuggerContext of the hub transaction. */
const SAMPLE = fixturePath(fxStr("s01.contextFile"));
const sampleText = readFileSync(SAMPLE, "utf8");

describe("bundle argument handling", () => {
  it("reads a file path or takes the text itself", () => {
    expect(readBundleArgument(SAMPLE).path).toBe(SAMPLE);
    expect(readBundleArgument('{"a":1}')).toEqual({ text: '{"a":1}' });
    expect(readBundleArgument("#transaction-validator?cbor=84")).toEqual({ text: "#transaction-validator?cbor=84" });
    expect(() => readBundleArgument("/no/such/file.json")).toThrow(/neither JSON/);
    expect(() => readBundleArgument("   ")).toThrow(/empty/);
  });

  it("refuses a file or inline text over the bundle size cap before reading / parsing it", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cdm-bundle-cap-"));
    const big = path.join(dir, "huge.json");
    // A sparse file: the size is what is checked, nothing is read.
    const fd = openSync(big, "w");
    ftruncateSync(fd, MAX_BUNDLE_BYTES + 1);
    closeSync(fd);
    expect(() => readBundleArgument(big)).toThrow(/over the 64 MB bundle limit/);
    expect(() => readBundleArgument(`{"pad":"${"x".repeat(MAX_BUNDLE_BYTES)}"}`)).toThrow(/bundle text is .* over the 64 MB bundle limit/);
    const small = path.join(dir, "small.json");
    writeFileSync(small, '{"cardano_debug_bundle":1}');
    expect(readBundleArgument(small)).toEqual({ text: '{"cardano_debug_bundle":1}', path: small });
  });

  it("detects the source kind", () => {
    expect(detectImportKind(sampleText)).toBe("de_uplc_context");
    expect(detectImportKind('{"cardano_debug_bundle":1}')).toBe("bundle");
    expect(detectImportKind('{"ctx_v":1,"cbor":"84"}')).toBe("cquisitor_share");
    expect(detectImportKind("https://cardananium.github.io/cquisitor/#transaction-validator?v=1&e=j&d=x")).toBe("cquisitor_share");
    expect(detectImportKind("#transaction-validator?cbor=84a0")).toBe("cquisitor_share");
    expect(detectImportKind('{"foo":1}')).toBeUndefined();
    expect(detectImportKind("84a0")).toBeUndefined();
  });
});

describe("de-uplc DebuggerContext import", () => {
  const lib = inProcessLib();

  it("converts the sample with documented defaults and canonical reference scripts", async () => {
    const imported = await importDeUplcContext(lib, parseJsonBigintSafe(sampleText), { path: SAMPLE });
    expect(imported.kind).toBe("de_uplc_context");
    expect(imported.network).toBe("mainnet");
    expect(imported.protocolMajor).toBe(10);
    expect(imported.context.utxoSet).toHaveLength(5);
    // lovelace + assets as strings
    const withAssets = imported.context.utxoSet.find((u) => u.utxo.input.txHash.startsWith(fxStr("s01.utxo.scriptInput.prefix")))!;
    expect(withAssets.utxo.output.amount[0]).toEqual({ unit: "lovelace", quantity: fxStr("s01.utxo.scriptInput.coin") });
    expect(withAssets.utxo.output.amount.length).toBe(1 + fxInt("s01.utxo.scriptInput.assetUnits"));
    expect(withAssets.utxo.output.amount[1]!.unit).toHaveLength(56);
    expect(withAssets.utxo.output.plutusData).toBe(fxStr("s01.datum.inputHex"));
    // native reference script -> lib form 8200…, hash derived
    expect(withAssets.utxo.output.scriptRef!.startsWith("8200")).toBe(true);
    expect(withAssets.utxo.output.scriptHash).toBe(fxStr("s01.nativeScript.hash"));
    // plutus reference scripts -> 8202 bstr(inner), hashes derived through the library
    expect(imported.refScripts[fxStr("s01.spendScript.hash")]?.plutus_version).toBe("V2");
    expect(imported.refScripts[fxStr("s01.spendScript.hash")]?.hash_source).toBe("derived");
    expect(imported.refScripts[fxStr("s01.mint.policy")]?.lib_form.startsWith("8202")).toBe(true);
    // defaults are spelled out
    const defaults = imported.defaultsApplied.join("\n");
    expect(defaults).toContain("minFeeCoefficientA/minFeeConstantB swapped");
    expect(defaults).toContain("executionPrices.priceMem");
    expect(defaults).toContain("minFeeRefScriptCostPerByte=15");
    expect(defaults).toContain("isSpent=false");
    expect(defaults).toContain("slot=");
    expect(defaults).toContain("treasuryValue=0");
    // utxoCostPerWord: 0 in the sample means "unknown", not a per-byte price of 0.
    expect(imported.context.protocolParameters.adaPerUtxoByte).toBe(4310n);
    expect(defaults).toContain("protocolParameters.adaPerUtxoByte=4310 (not in DebuggerContext.protocolParams: coinsPerUtxoSize absent and utxoCostPerWord 0 / absent)");
    expect(imported.context.protocolParameters.minFeeCoefficientA).toBe(44n);
    expect(imported.context.protocolParameters.minFeeConstantB).toBe(155381n);
    expect(imported.context.protocolParameters.costModels.plutusV2).toHaveLength(175);
    // the context serialises for the library
    expect(() => JSON.parse(stringifyForLib(imported.context))).not.toThrow();
  });

  it("requires a protocol version and a network", async () => {
    const raw = parseJsonBigintSafe(sampleText) as Record<string, unknown>;
    await expect(importDeUplcContext(lib, { ...raw, network: "devnet" })).rejects.toThrow(/network/);
    const pp = { ...(raw.protocolParams as Record<string, unknown>) };
    delete pp.protocolVersion;
    await expect(importDeUplcContext(lib, { ...raw, protocolParams: pp })).rejects.toThrow(/protocolVersion/);
  });

  it("protocolParamsFromDeUplc keeps an unswapped pair and lists what it invents", () => {
    const defaults: string[] = [];
    const pp = protocolParamsFromDeUplc({ minFeeA: 44, minFeeB: 155381, maxTxSize: 16384, protocolVersion: { major: 9, minor: 0 }, costModels: { PlutusV3: [1, 2] } }, defaults);
    expect(pp.minFeeCoefficientA).toBe(44n);
    expect(pp.minFeeConstantB).toBe(155381n);
    expect(pp.costModels).toEqual({ plutusV3: [1, 2] });
    expect(defaults.some((d) => d.includes("swapped"))).toBe(false);
    expect(defaults.some((d) => d.startsWith("protocolParameters.keyDeposit="))).toBe(true);
  });

  it("adaPerUtxoByte: per-byte keys win, a positive utxoCostPerWord is read as per-byte with a note, 0 is absent", () => {
    const base = { protocolVersion: [9, 0] };
    const run = (pp: Record<string, unknown>) => {
      const defaults: string[] = [];
      const value = protocolParamsFromDeUplc({ ...base, ...pp }, defaults).adaPerUtxoByte;
      return { value, notes: defaults.filter((d) => d.includes("adaPerUtxoByte")) };
    };
    expect(run({ coinsPerUtxoSize: "4310", utxoCostPerWord: 34482 })).toEqual({ value: 4310n, notes: [] });
    expect(run({ coins_per_utxo_size: 4310 })).toEqual({ value: 4310n, notes: [] });
    expect(run({ utxoCostPerWord: 4310 })).toEqual({ value: 4310n, notes: ["protocolParameters.adaPerUtxoByte=4310 read from DebuggerContext.protocolParams.utxoCostPerWord as a per-byte value (no coinsPerUtxoSize)"] });
    expect(run({ utxoCostPerWord: 0 })).toEqual({ value: 4310n, notes: ["protocolParameters.adaPerUtxoByte=4310 (not in DebuggerContext.protocolParams: coinsPerUtxoSize absent and utxoCostPerWord 0 / absent)"] });
    expect(run({ coinsPerUtxoSize: 0, utxoCostPerWord: 0 }).value).toBe(4310n);
    expect(run({}).notes).toHaveLength(1);
  });

  it("picks a slot inside the validity interval when there is no tip", () => {
    const defaults: string[] = [];
    const now = slotNow("mainnet");
    expect(chooseSlot("mainnet", { start: 100n, end: 200n }, defaults)).toBe(150n);
    expect(chooseSlot("mainnet", { start: now - 10n, end: now + 10n }, defaults)).toBe(now);
    expect(chooseSlot("mainnet", { start: now + 1000n }, defaults)).toBe(now + 1000n);
    expect(chooseSlot("mainnet", { end: 5n }, defaults)).toBe(4n);
    expect(chooseSlot("preprod", undefined, defaults)).toBe(slotNow("preprod"));
    expect(defaults).toHaveLength(5);
  });
});

describe("bundle v1 codec", () => {
  const lib = inProcessLib();

  it("round-trips through encode / import with exact integers", async () => {
    const imported = await importDeUplcContext(lib, parseJsonBigintSafe(sampleText));
    const bundle: BundleV1 = {
      cardano_debug_bundle: 1,
      network: "mainnet",
      tx_hash: fxStr("s01.txHash"),
      tx_cbor: imported.txHex,
      captured_at: "2026-01-01T00:00:00.000Z",
      slot: imported.slot.toString(),
      protocol_major: 10,
      validation_input_context: { ...imported.context, treasuryValue: 18446744073709551615n },
      ref_scripts: imported.refScripts,
      defaults_applied: imported.defaultsApplied,
      provider_warnings: [],
      missing_utxos: [],
      origin: "test",
    };
    const text = encodeBundle(bundle);
    expect(text).toContain('"treasuryValue": 18446744073709551615');
    expect(text).not.toContain("$bi");
    const back = importBundle(text, { path: "x.json" });
    expect(back.kind).toBe("bundle");
    expect(back.network).toBe("mainnet");
    expect(back.txHex).toBe(imported.txHex);
    expect(back.context.treasuryValue).toBe(18446744073709551615n);
    expect(back.context.slot).toBe(imported.slot);
    expect(back.context.utxoSet).toHaveLength(5);
    expect(back.refScripts).toEqual(imported.refScripts);
    expect(back.capturedAt).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    expect(back.origin).toBe("bundle x.json");
    // the re-normalised context is byte-identical for the library
    expect(stringifyForLib(back.context)).toBe(stringifyForLib(normalizeValidationInputContext(bundle.validation_input_context, "mainnet")));
  });

  it("on_chain.tx_bytes names the bytes the ledger included; a bundle without it describes its own tx_cbor", async () => {
    const imported = await importDeUplcContext(lib, parseJsonBigintSafe(sampleText));
    const base: BundleV1 = {
      cardano_debug_bundle: 1,
      network: "mainnet",
      tx_hash: fxStr("s01.txHash"),
      tx_cbor: imported.txHex,
      captured_at: null,
      slot: imported.slot.toString(),
      protocol_major: 10,
      validation_input_context: imported.context,
      origin: "test",
    };
    const inclusion = { slot: "100", epoch: 5, block_height: 7, is_valid: true, source: "koios tx_cbor row" };
    const legacy = importBundle(encodeBundle({ ...base, on_chain: inclusion }));
    expect(legacy.onChain).toMatchObject({ slot: "100", tx_bytes: bytesKey(imported.txHex) });
    // exported from a record whose bytes were edited after the fetch: the included key is kept
    const edited = importBundle(encodeBundle({ ...base, on_chain: { ...inclusion, tx_bytes: "0123456789abcdef" } }));
    expect(edited.onChain?.tx_bytes).toBe("0123456789abcdef");
    expect(isIncludedBytes(edited.onChain!, edited.txHex)).toBe(false);
  });

  it("rejects other versions and malformed contexts", () => {
    expect(() => importBundle('{"cardano_debug_bundle":2}')).toThrow(/unsupported bundle version/);
    expect(() => importBundle('{"cardano_debug_bundle":1,"network":"mainnet","tx_cbor":"84","validation_input_context":{"utxoSet":"x"}}')).toThrow(/malformed/);
    expect(() => importBundle('{"cardano_debug_bundle":1,"tx_cbor":"84"}')).toThrow(/network/);
  });

  it("importContext dispatches on the file contents", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cdm-bundle-"));
    const file = path.join(dir, "ctx.json");
    writeFileSync(file, sampleText);
    const imported = await importContext(lib, file);
    expect(imported.kind).toBe("de_uplc_context");
    expect(imported.origin).toContain(file);
    await expect(importContext(lib, '{"hello":1}')).rejects.toThrow(/bundle must be/);
  });
});

describe("stake-pool votes on a ParameterChange: the action's changedParameters", () => {
  // Scenario S5: an SPO vote on a ParameterChange that changes the block and tx ex-unit limits (the ledger's
  // security group). The bundle is shaped like the server's own export from before gov-action contexts carried
  // changedParameters: the context has none, the Koios proposal row has `param_proposal`, and the stored
  // verdict says DisallowedVoters (the validator ran on that context when the fixture was built).
  const lib = inProcessLib();
  const FIXTURE = fixturePath(fxStr("s05.bundleFile"));
  const text = readFileSync(FIXTURE, "utf8");
  const SECURITY = fxArr<string>("s05.securityParameters");
  const OTHER = fxArr<string>("s05.otherParameters");
  const ACTION_PREFIX = fxStr("s05.govActionTxHash").slice(0, 8);

  const disallowed = async (context: ValidationInputContext, txHex: string): Promise<boolean> => {
    const result = await lib.validateTx(txHex, stringifyForLib(context));
    return JSON.stringify(result.errors).includes("DisallowedVoters");
  };

  it("the codec carries changedParameters through (a live context from the library's Koios row keeps them)", () => {
    const raw = JSON.parse(text) as { provider_rows: { proposals: KoiosProposal[] }; validation_input_context: Record<string, unknown> };
    const fromRow = koiosProposalToGovActionContext(raw.provider_rows.proposals[0]!);
    expect(fromRow.changedParameters).toEqual(SECURITY);
    const ctx = normalizeValidationInputContext({ ...raw.validation_input_context, govActionContexts: [fromRow] }, "mainnet");
    expect(ctx.govActionContexts[0]!.changedParameters).toEqual(SECURITY);
    // integer CDDL keys are read as their text; anything else is a shape error naming the path
    const keyed = normalizeValidationInputContext({ ...raw.validation_input_context, govActionContexts: [{ ...fromRow, changedParameters: [21, "max_tx_size"] }] }, "mainnet");
    expect(keyed.govActionContexts[0]!.changedParameters).toEqual(["21", "max_tx_size"]);
    expect(() => normalizeValidationInputContext({ ...raw.validation_input_context, govActionContexts: [{ ...fromRow, changedParameters: "max_tx_size" }] }, "mainnet")).toThrow(/govActionContexts\[0\]\.changedParameters/);
  });

  it("a bundle without them gets them from its proposal row, and its stale verdict is dropped", async () => {
    // the stored verdict is the validator's answer on the nameless context: it contains DisallowedVoters
    const stored = (JSON.parse(text) as { validation_result: { errors: Array<{ error: Record<string, unknown> }> } }).validation_result;
    expect(stored.errors.map((e) => Object.keys(e.error)[0])).toEqual(fxArr<string>("s05.storedErrors"));
    expect(stored.errors.some((e) => "DisallowedVoters" in e.error)).toBe(true);
    const imported = importBundle(text);
    expect(imported.context.govActionContexts[0]!.changedParameters).toEqual(SECURITY);
    expect(imported.validation).toBeUndefined();
    expect(imported.defaultsApplied.some((d) => d.startsWith("govActionContexts[0].changedParameters=[max_block_ex_mem"))).toBe(true);
    expect(imported.defaultsApplied.some((d) => d.startsWith("validation_result dropped"))).toBe(true);
    // re-exported, the context carries them itself: nothing is filled or dropped again
    const again = importBundle(encodeBundle({ ...(JSON.parse(text) as BundleV1), validation_input_context: imported.context, defaults_applied: imported.defaultsApplied }));
    expect(again.context.govActionContexts[0]!.changedParameters).toEqual(SECURITY);
    expect(again.defaultsApplied.filter((d) => d.startsWith("validation_result dropped"))).toHaveLength(1);
  });

  it("the SPO vote validates on the security-group change and is DisallowedVoters on any other", async () => {
    const imported = importBundle(text);
    expect(await disallowed(imported.context, imported.txHex)).toBe(false);
    const other = structuredClone(imported.context);
    other.govActionContexts[0]!.changedParameters = OTHER;
    expect(await disallowed(other, imported.txHex)).toBe(true);
    // no names and no row to read them from: disallowed, and the import says why
    const bare = JSON.parse(text) as BundleV1;
    delete bare.provider_rows;
    delete bare.validation_result;
    const unknown = importBundle(encodeBundle(bare));
    expect(unknown.context.govActionContexts[0]!.changedParameters).toBeUndefined();
    expect(unknown.defaultsApplied.some((d) => new RegExp(`govActionContexts\\[0\\] \\(ParameterChange ${ACTION_PREFIX}\\w+#0\\) has no changedParameters \\(no proposal row\\): a stake-pool vote on it is reported as DisallowedVoters`).test(d))).toBe(true);
    expect(await disallowed(unknown.context, unknown.txHex)).toBe(true);
  });

  it("completeChangedParameters keeps names already present and skips other action types", () => {
    const imported = importBundle(text);
    const ctx = structuredClone(imported.context);
    ctx.govActionContexts[0]!.changedParameters = ["min_fee_a"];
    const row = { ...(JSON.parse(text) as { provider_rows: { proposals: KoiosProposal[] } }).provider_rows.proposals[0]! };
    expect(completeChangedParameters(ctx, [row])).toEqual({ filled: [], unknown: [] });
    expect(ctx.govActionContexts[0]!.changedParameters).toEqual(["min_fee_a"]);
    ctx.govActionContexts[0] = { ...ctx.govActionContexts[0]!, actionType: "infoAction", changedParameters: undefined };
    expect(completeChangedParameters(ctx, [])).toEqual({ filled: [], unknown: [] });
  });
});
