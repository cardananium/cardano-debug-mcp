import { describe, expect, it } from "vitest";

import { bytesToHex, hexToBytes } from "../../fixtures/synthetic/lib/bytes.js";
import {
  array,
  bytes,
  decode,
  decodeAt,
  encode,
  encodeHex,
  encodeWithSpans,
  int,
  itemEnd,
  map,
  mark,
  NULL,
  raw,
  sortedMap,
  tag,
  text,
  TRUE,
  FALSE,
  toPlain,
  uint,
  wide,
  head,
} from "../../fixtures/synthetic/lib/cbor.js";
import { cborToJson } from "../../fixtures/synthetic/lib/validator.js";

describe("cbor encoder", () => {
  it("uses the shortest integer head by default (RFC 8949 section 3)", () => {
    expect(encodeHex(uint(0))).toBe("00");
    expect(encodeHex(uint(23))).toBe("17");
    expect(encodeHex(uint(24))).toBe("1818");
    expect(encodeHex(uint(255))).toBe("18ff");
    expect(encodeHex(uint(256))).toBe("190100");
    expect(encodeHex(uint(65535))).toBe("19ffff");
    expect(encodeHex(uint(65536))).toBe("1a00010000");
    expect(encodeHex(uint(4294967295n))).toBe("1affffffff");
    expect(encodeHex(uint(4294967296n))).toBe("1b0000000100000000");
    expect(encodeHex(uint(18446744073709551615n))).toBe("1bffffffffffffffff");
    expect(encodeHex(int(-1))).toBe("20");
    expect(encodeHex(int(-25))).toBe("3818");
    expect(encodeHex(int(-1000))).toBe("3903e7");
    expect(() => uint(-1)).toThrow();
    expect(() => uint(18446744073709551616n)).toThrow();
  });

  it("encodes strings, arrays, maps, tags and simple values", () => {
    expect(encodeHex(bytes("010203"))).toBe("43010203");
    expect(encodeHex(text("IETF"))).toBe("6449455446");
    expect(encodeHex(array([uint(1), array([uint(2), uint(3)])]))).toBe("8201820203");
    expect(encodeHex(map([[uint(1), uint(2)]]))).toBe("a10102");
    expect(encodeHex(tag(258, array([])))).toBe("d9010280");
    expect(encodeHex(tag(24, bytes("00")))).toBe("d818" + "4100");
    expect(encodeHex(NULL)).toBe("f6");
    expect(encodeHex(TRUE)).toBe("f5");
    expect(encodeHex(FALSE)).toBe("f4");
  });

  it("forces odd encodings on request: wide heads, indefinite containers, chunked strings", () => {
    expect(encodeHex(wide(uint(5), 8))).toBe("1b0000000000000005");
    expect(encodeHex(wide(uint(5), 1))).toBe("1805");
    expect(() => wide(uint(300), 1)).not.toThrow();
    expect(() => encode(wide(uint(300), 1))).toThrow(/does not fit/);
    expect(encodeHex(array([uint(1), uint(2)], { indefinite: true }))).toBe("9f0102ff");
    expect(encodeHex(map([[uint(1), uint(2)]], { indefinite: true }))).toBe("bf0102ff");
    expect(encodeHex(wide(array([]), 2))).toBe("990000");
    expect(encodeHex(bytes("00112233", { chunkSize: 3 }))).toBe("5f43001122" + "4133" + "ff");
    expect(encodeHex(bytes(new Uint8Array(0), { chunkSize: 64 }))).toBe("5fff");
    expect(encodeHex(tag(24, bytes("aa"), 2))).toBe("d90018" + "41aa");
  });

  it("sorts map keys canonically (shortest encoding first) or bytewise", () => {
    const entries: Array<[ReturnType<typeof uint>, ReturnType<typeof uint>]> = [
      [uint(256), uint(1)],
      [uint(2), uint(1)],
      [uint(24), uint(1)],
      [uint(1), uint(1)],
    ];
    expect(toPlain(sortedMap(entries))).toEqual({ map: [[1n, 1n], [2n, 1n], [24n, 1n], [256n, 1n]] });
    const textKeys: Array<[ReturnType<typeof text>, ReturnType<typeof uint>]> = [
      [text("bb"), uint(1)],
      [text("a"), uint(2)],
      [text("aa"), uint(3)],
    ];
    expect(toPlain(sortedMap(textKeys, "shortlex"))).toEqual({ map: [["a", 2n], ["aa", 3n], ["bb", 1n]] });
    expect(toPlain(sortedMap(textKeys, "bytewise"))).toEqual({ map: [["a", 2n], ["aa", 3n], ["bb", 1n]] });
  });

  it("records the byte span of marked items", () => {
    const item = array([uint(1), mark("pair", array([mark("first", bytes("aabb")), mark("second", uint(300))])), mark("tail", NULL)]);
    const { bytes: out, spans } = encodeWithSpans(item);
    expect(bytesToHex(out)).toBe("83" + "01" + "82" + "42aabb" + "19012c" + "f6");
    expect(spans.pair).toEqual({ offset: 2, length: 7 });
    expect(spans.first).toEqual({ offset: 3, length: 3 });
    expect(spans.second).toEqual({ offset: 6, length: 3 });
    expect(spans.tail).toEqual({ offset: 9, length: 1 });
    expect(() => encodeWithSpans(array([mark("x", NULL), mark("x", NULL)]))).toThrow(/duplicate span label/);
  });

  it("inserts raw bytes verbatim", () => {
    expect(encodeHex(array([raw("1903e8"), raw(hexToBytes("f6"))]))).toBe("821903e8f6");
  });

  it("builds heads directly", () => {
    expect(bytesToHex(head(4, 3n))).toBe("83");
    expect(bytesToHex(head(2, 24n))).toBe("5818");
    expect(bytesToHex(head(5, 1n, 4))).toBe("ba00000001");
  });
});

describe("cbor decoder", () => {
  const SAMPLES = [
    "00",
    "1b0000000000000005",
    "3903e7",
    "d9010281825820" + "11".repeat(32) + "02",
    "5f43001122" + "4133" + "ff",
    "9f0102ff",
    "bf0102ff",
    "a2" + "6161" + "01" + "6162" + "f6",
    "83f5f4f6",
    "fa3f800000",
    "fb3ff0000000000000",
    "f93c00",
    "7f6161" + "6162" + "ff",
    "c249010000000000000000",
    "f8ff",
  ];

  it.each(SAMPLES)("re-encodes %s to the very same bytes", (hex) => {
    expect(encodeHex(decode(hex))).toBe(hex);
  });

  it("reports item ends and rejects trailing / truncated input", () => {
    const hex = "820102";
    expect(itemEnd(hexToBytes(hex))).toBe(3);
    expect(decodeAt(hexToBytes("8201020304")).end).toBe(3);
    expect(() => decode("820102aa")).toThrow(/trailing/);
    expect(() => decode("8201")).toThrow(/ends at/);
    expect(() => decode("5820aa")).toThrow(/ends at/);
  });

  it("keeps the encoding choices visible in the tree", () => {
    const n = decode("1b0000000000000005");
    expect(n).toMatchObject({ t: "uint", v: 5n, width: 8 });
    const a = decode("9f0102ff");
    expect(a).toMatchObject({ t: "array", indefinite: true });
    const b = decode("5f4100ff");
    expect(b).toMatchObject({ t: "bytes", chunks: [Uint8Array.of(0)] });
  });

  it("gives a plain view for asserts", () => {
    expect(toPlain(decode("a1" + "01" + "d90102" + "81" + "4100"))).toEqual({ map: [[1n, { tag: 258n, value: ["00"] }]] });
  });
});

describe("cbor against the library's own decoder", () => {
  it("what the encoder writes, cbor_to_json reads at the same offsets, and flags the odd encodings", () => {
    const item = array([wide(uint(5), 2), bytes("00".repeat(70), { chunkSize: 64 }), array([uint(1)], { indefinite: true }), tag(258, array([])), NULL, TRUE]);
    const hex = encodeHex(item);
    const res = cborToJson(hex) as { ok: boolean; value: { struct_position_info: { offset: number; length: number }; values: Array<Record<string, unknown>> } };
    expect(res.ok).toBe(true);
    expect(res.value.struct_position_info).toEqual({ offset: 0, length: hex.length / 2 });
    const odd = (node: Record<string, unknown>) => ((node.oddities as Array<{ kind: string }> | undefined) ?? []).map((o) => o.kind);
    expect(odd(res.value.values[0]!)).toEqual(["IntNotShortest"]);
    expect(odd(res.value.values[1]!)).toEqual(["IndefiniteLength"]);
    expect(odd(res.value.values[2]!)).toEqual(["IndefiniteLength"]);
    expect(odd(res.value.values[3]!)).toEqual([]);
    expect(res.value.values[3]).toMatchObject({ position_info: { offset: 82, length: 3 }, tag: "Unassigned(258)" });
  });
});
