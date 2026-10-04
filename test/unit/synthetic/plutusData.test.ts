import { describe, expect, it } from "vitest";

import { bytesToHex } from "../../fixtures/synthetic/lib/bytes.js";
import { decodeType } from "../../fixtures/synthetic/lib/validator.js";
import {
  constr,
  datumHash,
  decodePlutusData,
  encodePlutusDataHex,
  pBytes,
  pInt,
  pList,
  pMap,
  plutusDataToKoiosJson,
  UNIT,
  pBool,
  pSome,
  pNone,
  type PlutusData,
} from "../../fixtures/synthetic/lib/plutusData.js";

describe("plutus data encoding", () => {
  it("Constr tags: 121..127, 1280.., 102 [index, fields]", () => {
    expect(encodePlutusDataHex(constr(0, []))).toBe("d87980");
    expect(encodePlutusDataHex(constr(1, []))).toBe("d87a80");
    expect(encodePlutusDataHex(constr(6, []))).toBe("d87f80");
    expect(encodePlutusDataHex(constr(7, []))).toBe("d9050080");
    expect(encodePlutusDataHex(constr(127, []))).toBe("d9057880");
    expect(encodePlutusDataHex(constr(128, []))).toBe("d8668218" + "80" + "80");
    expect(encodePlutusDataHex(constr(500, [pInt(1)]))).toBe("d8668219" + "01f4" + "9f01ff");
  });

  it("fields and lists: `80` when empty, indefinite otherwise (as the node's Plutus serialiser writes them)", () => {
    expect(encodePlutusDataHex(pList([]))).toBe("80");
    expect(encodePlutusDataHex(pList([pInt(1), pInt(2)]))).toBe("9f0102ff");
    expect(encodePlutusDataHex(constr(0, [pInt(1)]))).toBe("d8799f01ff");
    expect(encodePlutusDataHex(constr(0, [pBytes("abcd"), pList([])]))).toBe("d8799f42abcd80ff");
  });

  it("maps are definite, entries in the order given", () => {
    expect(encodePlutusDataHex(pMap([]))).toBe("a0");
    expect(encodePlutusDataHex(pMap([[pInt(2), pInt(1)], [pInt(1), pInt(2)]]))).toBe("a2" + "0201" + "0102");
  });

  it("integers: native up to 64 bits, bignum tags beyond (bytes chunked at 64)", () => {
    expect(encodePlutusDataHex(pInt(0))).toBe("00");
    expect(encodePlutusDataHex(pInt(-1))).toBe("20");
    expect(encodePlutusDataHex(pInt(18446744073709551615n))).toBe("1bffffffffffffffff");
    expect(encodePlutusDataHex(pInt(-18446744073709551616n))).toBe("3bffffffffffffffff");
    expect(encodePlutusDataHex(pInt(18446744073709551616n))).toBe("c249010000000000000000");
    expect(encodePlutusDataHex(pInt(-18446744073709551617n))).toBe("c349010000000000000000");
    const huge = 1n << 600n; // 76 bytes
    const hex = encodePlutusDataHex(pInt(huge));
    expect(hex.startsWith("c25f5840")).toBe(true);
    expect(decodePlutusData(hex)).toEqual(pInt(huge));
  });

  it("byte strings: definite up to 64 bytes, 64-byte chunks beyond", () => {
    expect(encodePlutusDataHex(pBytes(new Uint8Array(64)))).toBe("5840" + "00".repeat(64));
    expect(encodePlutusDataHex(pBytes(new Uint8Array(65)))).toBe("5f5840" + "00".repeat(64) + "4100" + "ff");
    expect(encodePlutusDataHex(pBytes(new Uint8Array(130)))).toBe("5f5840" + "00".repeat(64) + "5840" + "00".repeat(64) + "4200" + "00" + "ff");
    expect(encodePlutusDataHex(pBytes(""))).toBe("40");
  });

  it("helpers: unit, booleans, Maybe", () => {
    expect(encodePlutusDataHex(UNIT)).toBe("d87980");
    expect(encodePlutusDataHex(pBool(false))).toBe("d87980");
    expect(encodePlutusDataHex(pBool(true))).toBe("d87a80");
    expect(encodePlutusDataHex(pSome(pInt(5)))).toBe("d8799f05ff");
    expect(encodePlutusDataHex(pNone)).toBe("d87a80");
  });

  const SAMPLES: PlutusData[] = [
    constr(0, [pInt(-5), pBytes("00ff"), pList([constr(1, []), pMap([[pBytes("aa"), pInt(1)]])])]),
    constr(300, [pBytes(new Uint8Array(200).fill(9)), pInt(1n << 90n)]),
    pList([pInt(0), pInt(70000), pInt(-70000)]),
  ];

  it.each(SAMPLES.map((d, i) => [i, d] as const))("sample %i: decode(encode(d)) = d and the library reads the same value and hash", (_, d) => {
    const hex = encodePlutusDataHex(d);
    expect(decodePlutusData(hex)).toEqual(d);
    const lib = decodeType<{ data_hash: string; plutus_data: unknown }>(hex, "PlutusData");
    expect(lib.data_hash).toBe(datumHash(d));
  });

  it("the Koios JSON form mirrors the library's JSON form", () => {
    const d = constr(0, [pInt(5), pBytes("abcd"), pList([pInt(-1)]), pMap([[pInt(1), pBytes("")]])]);
    const hex = encodePlutusDataHex(d);
    const lib = decodeType<{ plutus_data: unknown }>(hex, "PlutusData").plutus_data;
    expect(plutusDataToKoiosJson(d)).toMatchObject({ constructor: 0, fields: [{ int: 5 }, { bytes: "abcd" }, { list: [{ int: -1 }] }, { map: [{ k: { int: 1 }, v: { bytes: "" } }] }] });
    expect(lib).toMatchObject({ constructor: 0 });
  });

  it("datumHash accepts data, bytes or hex", () => {
    const d = constr(0, [pInt(1)]);
    const hex = encodePlutusDataHex(d);
    expect(datumHash(hex)).toBe(datumHash(d));
    expect(datumHash(Uint8Array.from(Buffer.from(hex, "hex")))).toBe(datumHash(d));
    expect(bytesToHex(Buffer.from(hex, "hex"))).toBe(hex);
  });
});
