import { describe, expect, it } from "vitest";

import type { RedeemerTarget, TxRecord } from "../../src/store/txStore.js";
import {
  addressCredentials,
  integersAsStrings,
  paymentScriptHash,
  referenceScriptsOf,
  resolvedUtxosFromContext,
  scriptRefVersion,
  withSpendScriptHashes,
} from "../../src/tx/dataView.js";
import { fxStr } from "../helpers/fixtures.js";

// artificial identifiers of scenario s11 (an order script address with a datum-hash lock, its maker's key address, an asset unit)
const SCRIPT_ADDR = fxStr("s11.scriptAddress");
const SCRIPT_HASH = fxStr("s11.scriptHash");
const KEY_ADDR = fxStr("s11.makerAddress");
const KEY_HASH = fxStr("s11.makerPaymentKeyHash");
const STAKE_HASH = fxStr("s11.makerStakeKeyHash");
const STAKE_ADDR = fxStr("s11.makerStakeAddress");
const DATUM_HASH = fxStr("s11.datumHash");
const UNIT = fxStr("s11.unit");

describe("integersAsStrings", () => {
  it("turns every integer into a decimal string, keeps floats/bools/strings, unboxes serde numbers", () => {
    expect(integersAsStrings({ constructor: 0, fields: [{ int: 2 }, { bytes: "aa" }, { int: "18446744073709551615" }], f: 1.5, b: true, n: null })).toEqual({
      constructor: "0",
      fields: [{ int: "2" }, { bytes: "aa" }, { int: "18446744073709551615" }],
      f: 1.5,
      b: true,
      n: null,
    });
    expect(integersAsStrings({ x: { "$serde_json::private::Number": "36893488147419103231" } })).toEqual({ x: "36893488147419103231" });
    expect(integersAsStrings(7)).toBe("7");
    expect(integersAsStrings(BigInt("99999999999999999999"))).toBe("99999999999999999999");
    expect(integersAsStrings("keep")).toBe("keep");
  });

  it("does not recurse on the JS stack (deep arrays)", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 20_000; i++) deep = [deep];
    let out = integersAsStrings<unknown[]>(deep);
    for (let i = 0; i < 20_000; i++) out = out[0] as unknown[];
    expect(out).toBe("1");
  });
});

describe("addressCredentials", () => {
  it("reads a script enterprise address", () => {
    const creds = addressCredentials(SCRIPT_ADDR);
    expect(creds).toMatchObject({ header_type: 7, network_id: 1, prefix: "addr", payment: { kind: "script", hash: SCRIPT_HASH } });
    expect(creds?.stake).toBeUndefined();
    expect(paymentScriptHash(SCRIPT_ADDR)).toBe(SCRIPT_HASH);
  });

  it("reads a base key/key address and a reward account", () => {
    // header 0x01 -> type 0 (key/key), network id 1 (mainnet)
    const base = addressCredentials(KEY_ADDR);
    expect(base?.header_type).toBe(0);
    expect(base?.payment).toEqual({ kind: "key", hash: KEY_HASH });
    expect(base?.stake).toEqual({ kind: "key", hash: STAKE_HASH });
    expect(paymentScriptHash(KEY_ADDR)).toBeUndefined();

    const reward = addressCredentials(STAKE_ADDR);
    expect(reward?.header_type).toBe(14);
    expect(reward?.stake).toEqual({ kind: "key", hash: STAKE_HASH });
  });

  it("answers undefined for non-bech32 strings", () => {
    expect(addressCredentials(fxStr("s11.byronAddress"))).toBeUndefined();
    expect(addressCredentials("")).toBeUndefined();
  });
});

describe("scriptRefVersion", () => {
  it("reads the CSL ScriptRef tag", () => {
    expect(scriptRefVersion("820059ab00")).toBe("native");
    expect(scriptRefVersion("820159ab00")).toBe("V1");
    expect(scriptRefVersion("820259ab00")).toBe("V2");
    expect(scriptRefVersion("820359ab00")).toBe("V3");
    expect(scriptRefVersion("59ab00")).toBeUndefined();
    expect(scriptRefVersion(undefined)).toBeUndefined();
  });
});

function contextWith(utxoSet: unknown[]): Pick<TxRecord, "validationContext"> {
  return { validationContext: { utxoSet } };
}

describe("resolvedUtxosFromContext", () => {
  it("maps ValidationInputContext rows to tool rows", () => {
    const resolved = resolvedUtxosFromContext(
      contextWith([
        {
          utxo: {
            input: { txHash: "AA".repeat(32), outputIndex: 1 },
            output: {
              address: SCRIPT_ADDR,
              amount: [
                { unit: "lovelace", quantity: "2005000000" },
                { unit: UNIT, quantity: "785944" },
              ],
              dataHash: DATUM_HASH,
              plutusData: "d8799f41aa02ff",
              scriptRef: "820359ab00",
              scriptHash: "ABCDEF".padEnd(56, "0"),
            },
          },
          isSpent: true,
        },
        { utxo: { input: { txHash: "bb".repeat(32), outputIndex: 0 }, output: { address: "addr_test1vqnope", amount: [] } }, isSpent: false },
        { utxo: { input: { outputIndex: 0 }, output: {} } },
      ]),
    );
    expect(resolved.size).toBe(2);
    const row = resolved.get(`${"aa".repeat(32)}#1`)!;
    expect(row).toMatchObject({
      utxo: `${"aa".repeat(32)}#1`,
      address: SCRIPT_ADDR,
      lovelace: "2005000000",
      assets: [{ unit: UNIT, quantity: "785944" }],
      datum_hash: DATUM_HASH,
      inline_datum_hex: "d8799f41aa02ff",
      ref_script_hash: "abcdef".padEnd(56, "0"),
      script_ref_hex: "820359ab00",
      ref_script_version: "V3",
      spent: true,
      payment: { kind: "script", hash: SCRIPT_HASH },
    });
    const other = resolved.get(`${"bb".repeat(32)}#0`)!;
    expect(other.spent).toBeUndefined();
    expect(other.lovelace).toBeUndefined();
    expect(other.payment).toBeUndefined();
  });

  it("is empty without a context", () => {
    expect(resolvedUtxosFromContext({}).size).toBe(0);
    expect(resolvedUtxosFromContext({ validationContext: {} }).size).toBe(0);
  });
});

describe("referenceScriptsOf / withSpendScriptHashes", () => {
  const resolved = resolvedUtxosFromContext(
    contextWith([
      { utxo: { input: { txHash: "aa".repeat(32), outputIndex: 0 }, output: { address: SCRIPT_ADDR, amount: [] } }, isSpent: false },
      { utxo: { input: { txHash: "cc".repeat(32), outputIndex: 2 }, output: { address: "addr1vx", amount: [], scriptRef: "820259ab00", scriptHash: SCRIPT_HASH.toUpperCase() } }, isSpent: false },
    ]),
  );

  it("lists reference scripts of the given inputs only", () => {
    expect(referenceScriptsOf(resolved, [`${"cc".repeat(32)}#2`, `${"aa".repeat(32)}#0`, "missing#0"])).toEqual([
      { script_hash: SCRIPT_HASH, plutus_version: "V2", source: `reference ${"cc".repeat(32)}#2`, size_bytes: 3 },
    ]);
  });

  it("fills spend script hashes from the spent address, keeps known ones, picks the version from the inventory", () => {
    const targets: RedeemerTarget[] = [
      { ref: "spend:0", purpose: "spend", index: 0, witness_index: 0, target: "input …", ex_units: { mem: "1", steps: "2" } },
      { ref: "spend:1", purpose: "spend", index: 1, witness_index: 1, target: "input …", ex_units: { mem: "1", steps: "2" } },
      { ref: "mint:0", purpose: "mint", index: 0, witness_index: 2, target: "policy x", script_hash: "x", ex_units: { mem: "1", steps: "2" } },
    ];
    const out = withSpendScriptHashes(targets, [`${"aa".repeat(32)}#0`, `${"zz".repeat(32)}#9`], resolved, new Map([[SCRIPT_HASH, "V2"]]));
    expect(out[0]).toMatchObject({ ref: "spend:0", script_hash: SCRIPT_HASH, plutus_version: "V2" });
    expect(out[1]!.script_hash).toBeUndefined();
    expect(out[2]).toBe(targets[2]);
    expect(targets[0]!.script_hash).toBeUndefined(); // input untouched
  });
});

describe("refScriptSize", () => {
  it("is the inner script size: no 82 0X envelope, no bstr header of the library form", async () => {
    const { refScriptSize } = await import("../../src/tx/dataView.js");
    const inner = "5904b0" + "ab".repeat(0x4b0); // bstr(1200 bytes of flat) = 1203 bytes
    const libForm = "8202" + "5904b3" + inner; // [2, bstr(inner)]
    expect(refScriptSize(libForm)).toBe(1203);
    const small = "4a" + "01".repeat(10); // bstr(10)
    expect(refScriptSize("8203" + "4b" + small)).toBe(11);
    const native = "8200581c" + "cd".repeat(28);
    expect(refScriptSize("8200" + native)).toBe(native.length / 2);
  });
});
