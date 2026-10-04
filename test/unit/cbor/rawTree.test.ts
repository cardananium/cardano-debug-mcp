// Walkers over real `cbor_to_json` trees (in-process wasm).
import { describe, expect, it } from "vitest";

import { byteStringValues, collectOddities, compactRaw, describeRawNode, diagnosticNotation, findMapEntry, hasIndefiniteContainer, keySegment, rawRootKind, rawTagNumber, resolveRawNode, type Oddity } from "../../../src/cbor/rawTree.js";
import { fx, fxBig, fxInt, readTx } from "../../helpers/fixtures.js";
import { rawLib } from "../../helpers/inProcessLib.js";

const decode = (hex: string) => JSON.parse(rawLib().cbor_to_json!(hex) as string) as { ok: boolean; value?: unknown; partial?: unknown; error?: unknown };

describe("collectOddities", () => {
  it("paths follow the validator grammar: integer map keys index, text keys dot, tags are transparent", () => {
    // { 0: 1800 (non-shortest), 2: #6.2(bignum small), "k": [ 9f ff (indefinite) ] } (keys in canonical order)
    const tree = decode("a3 00 1800 02 c2420101 616b 9fff".replace(/ /g, "")).value;
    const { rows, total } = collectOddities(tree);
    expect(total).toBe(3);
    expect(rows.map((r) => [r.kind, r.path, r.byte_offset])).toEqual([
      ["IntNotShortest", "$[0]", 2],
      ["BignumForSmallInt", "$[2]", 5],
      ["IndefiniteLength", "$.k", 11],
    ]);
    expect(rows[0]!.note).toMatch(/shortest/);
    // byte_length: the item for a scalar (`1800` is 2 bytes), the header for a tag (`c2`) or a container (`9f`)
    expect(rows.map((r) => r.byte_length)).toEqual([2, 1, 1]);
  });
  it("nested arrays and unsorted map keys", () => {
    // [ { 1: 0, 0: 0 } ]  -> unsorted keys on the map at $[0]
    const { rows } = collectOddities(decode("81a201000000").value);
    expect(rows).toEqual([expect.objectContaining({ kind: "MapKeysNotSorted", path: "$[0]", byte_offset: 1 })]);
    const { rows: none, total } = collectOddities(decode("8101").value);
    expect(none).toEqual([]);
    expect(total).toBe(0);
  });
  it("caps rows but counts everything, sorted by offset", () => {
    const hex = "9f" + "1800".repeat(5) + "ff"; // indefinite array of 5 non-shortest zeros
    const { rows, total } = collectOddities(decode(hex).value, 3);
    expect(total).toBe(6);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.byte_offset).toBeLessThanOrEqual(rows[1]!.byte_offset);
  });
  it("works on a partial tree", () => {
    const raw = decode("82d9010280ff"); // unexpected break inside
    expect(raw.ok).toBe(false);
    expect(collectOddities(raw.partial).total).toBe(0);
    expect(describeRawNode(raw.partial)).toMatch(/array\(2 items, incomplete\)/);
  });
});

describe("keySegment", () => {
  it("renders every key type in the validator's grammar", () => {
    expect(keySegment("$", { type: "U8", value: 2 })).toBe("$[2]");
    expect(keySegment("$", { type: "U64", value: "18446744073709551615" })).toBe("$[18446744073709551615]"); // big integers arrive as decimal strings
    expect(keySegment("$", { type: "String", value: "name" })).toBe("$.name");
    expect(keySegment("$", { type: "String", value: "with space" })).toBe('$["with space"]');
    expect(keySegment("$", { type: "String", value: "12" })).toBe('$["12"]'); // a text key spelling digits is not an integer key
    expect(keySegment("$", { type: "Bytes", value: "0102" })).toBe("$.h'0102'");
    expect(keySegment("$", { type: "Bool", value: true })).toBe("$.true");
    expect(keySegment("$", { type: "Null", value: null })).toBe("$.null");
    expect(keySegment("$", { type: "I8", value: -1 })).toBe("$[-1]");
    expect(keySegment("$", { type: "F64", value: 1.5 })).toBe("$.1.5");
    expect(keySegment("$", { type: "Array", values: [] })).toBe("$[[]]");
    expect(keySegment("$", null)).toBe("$[\"?\"]");
  });
  it("matches the paths the validator emits for non-integer keys", () => {
    const validate = (hex: string, cddl: string) => JSON.parse(rawLib().validate_cbor_against_cddl!(hex, cddl, "root") as string) as { error?: { path?: string } };
    expect(validate("a143f0ff4801", "root = { * bstr => tstr }").error!.path).toBe("$.h'f0ff48'");
    expect(keySegment("$", (decode("a143f0ff4801").value as { values: Array<{ key: unknown }> }).values[0]!.key)).toBe("$.h'f0ff48'");
    expect(validate("a1f501", "root = { * bool => tstr }").error!.path).toBe("$.true");
    expect(validate("a12001", "root = { * nint => tstr }").error!.path).toBe("$[-1]");
    expect(keySegment("$", (decode("a12001").value as { values: Array<{ key: unknown }> }).values[0]!.key)).toBe("$[-1]");
  });
  it("renders composite keys in the validator's diagnostic notation, in bracket form", () => {
    const validate = (hex: string, cddl: string) => JSON.parse(rawLib().validate_cbor_against_cddl!(hex, cddl, "root") as string) as { error?: { path?: string; message?: string } };
    const key = (hex: string) => (decode(hex).value as { values: Array<{ key: unknown }> }).values[0]!.key;
    // {[2, h'0102']: 1}
    expect(validate("a1820242010201", "root = { 1: uint }").error!.path).toBe("$[[2, h'0102']]");
    expect(keySegment("$", key("a1820242010201"))).toBe("$[[2, h'0102']]");
    expect(diagnosticNotation(key("a1820242010201"))).toBe("[2, h'0102']");
    // {{1: 2}: 1}
    expect(validate("a1a1010201", "root = { 1: uint }").error!.path).toBe("$[{1: 2}]");
    expect(keySegment("$", key("a1a1010201"))).toBe("$[{1: 2}]");
    // {24(0): 1} and {simple(32): 1}
    expect(validate("a1d8180001", "root = { 1: uint }").error!.path).toBe("$[24(0)]");
    expect(keySegment("$", key("a1d8180001"))).toBe("$[24(0)]");
    expect(validate("a1f82001", "root = { 1: uint }").error!.path).toBe("$[simple(32)]");
    expect(keySegment("$", key("a1f82001"))).toBe("$[simple(32)]");
    // text and booleans inside a composite key, and the `unexpected key` message uses the same notation
    expect(diagnosticNotation(key("a1826161f500"))).toBe('["a", true]');
    expect(validate("a1820242010201", "root = { 1: uint }").error!.message).toBe("unexpected key [2, h'0102']");
    // a value under a composite key resolves through the same segment
    expect(validate("a1a10102a10102", "root = { * {1: uint} => {1: tstr} }").error!.path).toBe("$[{1: 2}][1]");
    expect(resolveRawNode(decode("a1a10102a10102").value, "$[{1: 2}][1]")!.value).toBe(2);
  });
});

describe("resolveRawNode / findMapEntry", () => {
  const TX = readTx("vote-tx.tx");
  const span = (name: string) => fx<{ offset: number; length: number }>(`s12.spans.${name}`);
  const tree = decode(TX).value;
  it("walks array indices, integer map keys and transparent tags", () => {
    expect(resolveRawNode(tree, "$")!.type).toBe("Array");
    expect(resolveRawNode(tree, "$[0]")!.type).toBe("Map");
    const fee = resolveRawNode(tree, "$[0][2]")!;
    expect(fee.value).toBe(Number(fxBig("s12.fee")));
    expect(fee.position_info).toEqual(span("fee"));
    // key 0 is a tag-258 set: the tag is transparent, [0][0][0] is the first input's transaction id
    const txId = resolveRawNode(tree, "$[0][0][0][0]")!;
    expect(txId.type).toBe("Bytes");
    expect(resolveRawNode(tree, "$[0][0][0][1]")!.value).toBe(fxInt("s12.inputIndex")); // the input index
    expect(resolveRawNode(tree, "$[0][7]")).toBeUndefined();
    expect(resolveRawNode(tree, "$[0][0][5]")).toBeUndefined();
    expect(resolveRawNode(tree, "$[9]")).toBeUndefined();
    expect(resolveRawNode(tree, "nope")).toBeUndefined();
  });
  it("resolves text, bytes and quoted keys", () => {
    const named = decode("a2646e616d6501" + "43f0ff4802").value; // {"name": 1, h'f0ff48': 2}
    expect(resolveRawNode(named, "$.name")!.value).toBe(1);
    expect(resolveRawNode(named, '$["name"]')!.value).toBe(1);
    expect(resolveRawNode(named, "$.h'f0ff48'")!.value).toBe(2);
  });
  it("resolves composite keys written in diagnostic notation", () => {
    // key 19 of the body is a map whose keys are [voter_kind, credential] arrays
    const voter = resolveRawNode(tree, "$[0][19]")!;
    expect(voter.type).toBe("Map");
    const firstKey = (voter.values as Array<{ key: unknown }>)[0]!.key;
    const segment = keySegment("$[0][19]", firstKey);
    expect(segment).toMatch(/^\$\[0\]\[19\]\[\[2, h'[0-9a-f]{56}'\]\]$/);
    expect(resolveRawNode(tree, segment)!.type).toBe("Map");
  });
  it("finds the entry an `unexpected key` error's path names", () => {
    const entry = findMapEntry(tree, "$[0][19]")!;
    expect(entry.map.type).toBe("Map");
    expect(entry.key.position_info).toEqual(span("votesKey")); // the body map starts at byte 1
    expect((entry.value as { struct_position_info: { offset: number } }).struct_position_info.offset).toBe(span("votes").offset);
    expect(findMapEntry(tree, "$[0][20]")).toBeUndefined();
    expect(findMapEntry(tree, "$[1][0]")).toBeUndefined(); // an empty map
    expect(findMapEntry(tree, "$[2][0]")).toBeUndefined(); // not a map
    expect(findMapEntry(tree, "$")).toBeUndefined(); // no key segment
  });
});

describe("describeRawNode / rawRootKind / rawTagNumber", () => {
  it("uses the validator's vocabulary", () => {
    expect(describeRawNode(decode("84a0a0f5f6").value)).toBe("array(4 items)");
    expect(describeRawNode(decode("a10001").value)).toBe("map(1 entries)");
    expect(describeRawNode(decode("d9010280").value)).toBe("#6.258(array(0 items))");
    expect(describeRawNode(decode("d8799f41aa02ff").value)).toBe("#6.121(indefinite array(2 items))");
    expect(describeRawNode(decode("c2420101").value)).toBe("#6.2(bytes (2 bytes 0x0101))");
    expect(describeRawNode(decode("5f4101ff").value)).toBe("indefinite bytes(1 chunks)");
    expect(describeRawNode(decode("6568656c6c6f").value)).toBe('text "hello"');
    expect(describeRawNode(decode("1800").value)).toBe("uint 0");
    expect(describeRawNode(decode("20").value)).toBe("int -1");
    expect(describeRawNode(decode("f5").value)).toBe("bool true");
    expect(describeRawNode(decode("f6").value)).toBe("null");
    expect(describeRawNode(decode("f8ff").value)).toBe("simple(255)");
    expect(describeRawNode(decode("f93c00").value)).toBe("float 1");
    expect(describeRawNode(null)).toBe("?");
  });
  it("root kinds and tag numbers", () => {
    expect(rawRootKind(decode("84a0a0f5f6").value)).toBe("array");
    expect(rawRootKind(decode("a0").value)).toBe("map");
    expect(rawRootKind(decode("d9010280").value)).toBe("tag:258");
    expect(rawRootKind(decode("d8799f41aa02ff").value)).toBe("tag:121");
    expect(rawRootKind(decode("c2420101").value)).toBe("tag:2");
    expect(rawRootKind(decode("d81843010203").value)).toBe("tag:24");
    expect(rawRootKind(decode("4100").value)).toBe("bytes");
    expect(rawRootKind(decode("01").value)).toBe("uint");
    expect(rawRootKind(null)).toBeNull();
    expect(rawTagNumber({ tag: "Unassigned(258)" })).toBe(258);
    expect(rawTagNumber({ tag: "PosBignum" })).toBe(2);
    expect(rawTagNumber({ tag: 7 })).toBe(7);
    expect(rawTagNumber({})).toBeNull();
  });
});

describe("byteStringValues / hasIndefiniteContainer / compactRaw", () => {
  it("collects byte strings root-first through maps, arrays and tags", () => {
    const tree = decode("a1 00 82 4101 d818 4202ff".replace(/ /g, "")).value;
    expect(byteStringValues(tree)).toEqual(["01", "02ff"]);
    expect(byteStringValues(tree, 1)).toEqual(["01"]);
    expect(byteStringValues(null)).toEqual([]);
  });
  it("finds indefinite containers anywhere", () => {
    expect(hasIndefiniteContainer(decode("81 a1 00 9fff".replace(/ /g, "")).value)).toBe(true);
    expect(hasIndefiniteContainer(decode("5f4101ff").value)).toBe(true);
    expect(hasIndefiniteContainer(decode("81a10000").value)).toBe(false);
  });
  it("compactRaw keeps the shape cbor_decode(as='raw') shows and still collects flat oddities", () => {
    const oddities: Oddity[] = [];
    const compact = compactRaw(decode("a1 1800 9f 01 ff".replace(/ /g, "")).value, oddities) as { type: string; at: string; items: number; values: Array<{ k: { type: string; value: string }; v: { type: string; items: string; values: unknown[] } }> };
    expect(compact.type).toBe("Map");
    expect(compact.at).toBe("0+6"); // the whole container, as one scalar string
    expect(compact.values[0]!.v).toMatchObject({ at: "3+3" }); // the indefinite array: header, one item, break
    expect(compact.values[0]!.k).toMatchObject({ type: "U8", value: "0" });
    expect(compact.values[0]!.v).toMatchObject({ type: "Array", items: "indefinite" });
    expect(compact.values[0]!.v.values).toHaveLength(1); // the Break marker is dropped
    expect(oddities.map((o) => o.kind).sort()).toEqual(["IndefiniteLength", "IntNotShortest"]);
  });
});
