import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  bstrPayload,
  canonicalizeRefScript,
  innerFromLibForm,
  isWholeBstr,
  readBstrHeader,
  refScriptType,
  scriptHashOf,
  verifyRefScript,
} from "../../../src/chain/refScript.js";
import { fixturePath, fxStr } from "../../helpers/fixtures.js";
import { inProcessLib } from "../../helpers/inProcessLib.js";

/** The artificial S1 sample DebuggerContext. */
const SAMPLE = fixturePath(fxStr("s01.contextFile"));

interface Sample {
  utxos: Array<{ txHash: string; outputIndex: number; referenceScript?: { type: string; script: string } }>;
}

function sample(): Sample {
  return JSON.parse(readFileSync(SAMPLE, "utf8")) as Sample;
}

/** The reference script of the first UTxO (the S1 spend script, PlutusV2) and its ledger hash. */
const INNER = sample().utxos[0]!.referenceScript!.script;
const HASH = fxStr("s01.spendScript.hash");
/** The native script the S1 script input carries as its reference script. */
const NATIVE = sample().utxos[2]!.referenceScript!.script;
const NATIVE_HASH = fxStr("s01.nativeScript.hash");

describe("refScriptType", () => {
  it("reads every provider spelling", () => {
    expect(refScriptType("plutusv2")).toEqual({ kind: "plutus", plutus_version: "V2", tag: 2 });
    expect(refScriptType("PlutusV3")).toEqual({ kind: "plutus", plutus_version: "V3", tag: 3 });
    expect(refScriptType("plutusV1")).toEqual({ kind: "plutus", plutus_version: "V1", tag: 1 });
    expect(refScriptType("V2")).toEqual({ kind: "plutus", plutus_version: "V2", tag: 2 });
    expect(refScriptType("NativeScript")).toEqual({ kind: "native", tag: 0 });
    expect(refScriptType("timelock")).toEqual({ kind: "native", tag: 0 });
    expect(refScriptType("multisig")).toEqual({ kind: "native", tag: 0 });
    expect(refScriptType("plutusv4")).toBeUndefined();
    expect(refScriptType(undefined)).toBeUndefined();
  });
});

describe("CBOR byte-string helpers", () => {
  it("parses definite headers", () => {
    expect(readBstrHeader("4101")).toEqual({ headerBytes: 1, payloadBytes: 1 });
    expect(readBstrHeader("5818" + "00".repeat(24))).toEqual({ headerBytes: 2, payloadBytes: 24 });
    expect(readBstrHeader("590100")).toEqual({ headerBytes: 3, payloadBytes: 256 });
    expect(readBstrHeader("5f")).toBeUndefined(); // indefinite
    expect(readBstrHeader("82")).toBeUndefined(); // array
    expect(isWholeBstr("4101")).toBe(true);
    expect(isWholeBstr("410102")).toBe(false);
    expect(bstrPayload("4201ff")).toBe("01ff");
  });
});

describe("canonicalizeRefScript", () => {
  const v2 = refScriptType("plutusv2")!;

  it("keeps inner (bstr(flat)) as-is", () => {
    const c = canonicalizeRefScript(INNER, v2);
    expect(c.inner).toBe(INNER);
    expect(c.layers_removed).toBe(0);
    expect(c.engine_form).toBe(INNER);
    expect(c.lib_form.startsWith("8202")).toBe(true);
    expect(innerFromLibForm(c.lib_form)).toEqual({ type: { kind: "plutus", plutus_version: "V2", tag: 2 }, inner: INNER });
  });

  it("strips one layer from bstr(inner) (what get_ref_script_bytes answers)", () => {
    const wrapped = "59" + (INNER.length / 2).toString(16).padStart(4, "0") + INNER;
    const c = canonicalizeRefScript(wrapped, v2);
    expect(c.inner).toBe(INNER);
    expect(c.layers_removed).toBe(1);
  });

  it("wraps a raw flat program once", () => {
    const flat = INNER.slice(6); // drop the 59xxxx header
    const c = canonicalizeRefScript(flat, v2);
    expect(c.inner).toBe(INNER);
    expect(c.layers_removed).toBe(-1);
  });

  it("takes native scripts as-is with tag 0", () => {
    const c = canonicalizeRefScript(NATIVE, refScriptType("native")!);
    expect(c.inner).toBe(NATIVE);
    expect(c.lib_form).toBe("8200" + NATIVE);
    expect(innerFromLibForm(c.lib_form)).toEqual({ type: { kind: "native", tag: 0 }, inner: NATIVE });
  });
});

describe("verifyRefScript (real library)", () => {
  const lib = inProcessLib();

  it("computes blake2b-224(tag ‖ inner) for Plutus and native scripts", async () => {
    expect(await scriptHashOf(lib, INNER, refScriptType("plutusv2")!)).toBe(HASH);
    expect(await scriptHashOf(lib, NATIVE, refScriptType("native")!)).toBe(NATIVE_HASH);
  });

  it("verifies the provider hash and detects a wrong version", async () => {
    const ok = await verifyRefScript(lib, canonicalizeRefScript(INNER, refScriptType("plutusv2")!), HASH.toUpperCase());
    expect(ok.verified).toBe(true);
    expect(ok.computed_hash).toBe(HASH);
    const wrongVersion = await verifyRefScript(lib, canonicalizeRefScript(INNER, refScriptType("plutusv3")!), HASH);
    expect(wrongVersion.verified).toBe(false);
    expect(wrongVersion.alternative?.matched).toBe(false);
    const noHash = await verifyRefScript(lib, canonicalizeRefScript(INNER, refScriptType("plutusv2")!), null);
    expect(noHash.verified).toBe(false);
    expect(noHash.error).toMatch(/no reference_script.hash/);
  });
});
