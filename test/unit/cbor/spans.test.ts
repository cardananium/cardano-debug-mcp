// `rawSpans` (the rows of cbor_decode(as='spans')) and `lookupRawPath` over real `cbor_to_json` trees.
import { describe, expect, it } from "vitest";

import { lookupRawPath, rawSpans, type SpanRow } from "../../../src/cbor/rawTree.js";
import { fx, fxBig, readTx } from "../../helpers/fixtures.js";
import { rawLib } from "../../helpers/inProcessLib.js";

const decode = (hex: string) => JSON.parse(rawLib().cbor_to_json!(hex) as string) as { ok: boolean; value?: unknown; partial?: unknown };
const rows = (hex: string, options: { path?: string; depth?: number; offset?: number; limit?: number } = {}): { rows: SpanRow[]; total: number } => {
  const result = rawSpans(decode(hex).value, { offset: 0, limit: 10_000, ...options });
  if ("miss" in result) throw new Error(`miss at ${result.miss.resolved}`);
  return result;
};

const TX = readTx("vote-tx.tx"); // [ body{0: #6.258([[txid, 2]]), 1: [...], 2: fee, 19: {...}}, {}, true, null ] (scenario s12)
const span = (name: string) => fx<{ offset: number; length: number }>(`s12.spans.${name}`);

describe("rawSpans", () => {
  it("rows in document order with the validator-grammar path, node type and byte span", () => {
    const { rows: all, total } = rows(TX, { depth: 1 });
    expect(total).toBe(all.length);
    expect(all[0]).toEqual({ path: "$", type: "Array", ...span("tx") });
    expect(all.slice(1).map((r) => [r.path, r.type, r.offset, r.length])).toEqual([
      ["$[0]", "Map", span("body").offset, span("body").length],
      ["$[1]", "Map", span("witnessSet").offset, span("witnessSet").length],
      ["$[2]", "Bool", span("isValid").offset, span("isValid").length],
      ["$[3]", "Null", span("aux").offset, span("aux").length],
    ]);
    const fee = rows(TX, { path: "$[0][2]" }).rows;
    expect(fee).toEqual([{ path: "$[0][2]", type: "U32", ...span("fee"), value: String(fxBig("s12.fee")) }]);
    expect(TX.slice(span("fee").offset * 2, (span("fee").offset + span("fee").length) * 2)).toBe("1a" + fxBig("s12.fee").toString(16).padStart(8, "0")); // the bytes the row points at
  });

  it("a map key is its own row (key: true) on its entry's path; tags are transparent (tag row + content row, one path)", () => {
    const { rows: body } = rows(TX, { path: "$[0]", depth: 1 });
    expect(body.map((r) => [r.path, r.type, r.key === true, r.tag ?? ""])).toEqual([
      ["$[0]", "Map", false, ""],
      ["$[0][0]", "U8", true, ""],
      ["$[0][0]", "Tag", false, "258"],
      ["$[0][0]", "Array", false, ""],
      ["$[0][1]", "U8", true, ""],
      ["$[0][1]", "Array", false, ""],
      ["$[0][2]", "U8", true, ""],
      ["$[0][2]", "U32", false, ""],
      ["$[0][19]", "U8", true, ""],
      ["$[0][19]", "Map", false, ""],
    ]);
    // the first input's transaction id and index live under the tag, at $[0][0][0][0] / [1]
    const input = rows(TX, { path: "$[0][0][0]" }).rows;
    expect(input.map((r) => [r.path, r.type])).toEqual([["$[0][0][0]", "Array"], ["$[0][0][0][0]", "Bytes"], ["$[0][0][0][1]", "U8"]]);
    expect(input[1]).toMatchObject({ offset: span("inputs").offset + 5, length: 34 }); // tag head (3) + array head (1) + the input's array head (1), then a 32-byte id and its head
  });

  it("zooming on a tag path lists the tag row first", () => {
    const { rows: under } = rows(TX, { path: "$[0][0]", depth: 1 });
    expect(under[0]).toMatchObject({ path: "$[0][0]", type: "Tag", tag: "258", ...span("inputs") });
    expect(under[1]).toMatchObject({ path: "$[0][0]", type: "Array", offset: span("inputs").offset + 3, length: span("inputs").length - 3 });
  });

  it("depth counts path segments below the start; the offset / limit window leaves total alone", () => {
    const all = rows(TX);
    const shallow = rows(TX, { depth: 2 });
    expect(shallow.total).toBeLessThan(all.total);
    expect(shallow.rows.every((r) => r.path.split("[").length - 1 <= 2)).toBe(true);
    const page = rows(TX, { offset: 5, limit: 3 });
    expect(page.total).toBe(all.total);
    expect(page.rows).toEqual(all.rows.slice(5, 8));
    expect(rows(TX, { offset: 10_000, limit: 3 })).toEqual({ rows: [], total: all.total });
  });

  it("every row's bytes are one well-formed item of the row's type (the spans are exact)", () => {
    for (const name of ["lock-spend.tx", "multi-redeemer.tx"]) {
      const hex = readTx(name);
      const { rows: all } = rows(hex);
      expect(all.length).toBeGreaterThan(100);
      for (const row of all) {
        const item = decode(hex.slice(row.offset * 2, (row.offset + row.length) * 2));
        expect(item.ok, `${name} ${row.path} ${row.type} @${row.offset}+${row.length}`).toBe(true);
        expect((item.value as { type: string }).type, `${name} ${row.path}`).toBe(row.type);
      }
    }
  });

  it("indefinite containers and their chunks; Break markers are not rows", () => {
    const { rows: all } = rows("5f 4101 420203 ff".replace(/ /g, ""));
    expect(all.map((r) => [r.path, r.type, r.offset, r.length])).toEqual([
      ["$", "IndefiniteLengthBytes", 0, 7],
      ["$[0]", "Bytes", 1, 2],
      ["$[1]", "Bytes", 3, 3],
    ]);
    const array = rows("9f 01 02 ff".replace(/ /g, "")).rows;
    expect(array.map((r) => r.path)).toEqual(["$", "$[0]", "$[1]"]);
  });

  it("text keys, composite keys and partial trees", () => {
    const named = rows("a2 646e616d6501 8201 02 03".replace(/ /g, "")).rows; // {"name": 1, [1, 2]: 3}
    expect(named.map((r) => [r.path, r.key === true, r.type])).toEqual([
      ["$", false, "Map"],
      ["$.name", true, "String"],
      ["$.name", false, "U8"],
      ["$[[1, 2]]", true, "Array"], // a composite key's own children are not listed
      ["$[[1, 2]]", false, "U8"],
    ]);
    const partial = decode("82 01 d9 0102".replace(/ /g, ""));
    expect(partial.ok).toBe(false);
    const result = rawSpans(partial.partial, { offset: 0, limit: 100 });
    expect("rows" in result && result.rows[0]).toMatchObject({ path: "$", type: "Array" });
  });

  it("a path that resolves nowhere is a miss that says where it stops and what is there", () => {
    const tree = decode(TX).value;
    const miss = rawSpans(tree, { path: "$[0][9]", offset: 0, limit: 10 });
    expect(miss).toEqual({ miss: { resolved: "$[0]", available: ["$[0][0]", "$[0][1]", "$[0][2]", "$[0][19]"] } });
    expect(lookupRawPath(tree, "$[7]")).toEqual({ miss: { resolved: "$", available: ["$[0..3]"] } });
    expect(lookupRawPath(tree, "/values/0")).toEqual({ miss: { resolved: "", available: [] } });
    expect("node" in lookupRawPath(tree, "$[0][2]")).toBe(true);
  });

  it("long paths in a very deep document are abbreviated, and 20,000 levels are walked without recursion", () => {
    const hex = "81".repeat(20_000) + "00";
    const result = rawSpans(decode(hex).value, { offset: 19_000, limit: 2 });
    expect("rows" in result).toBe(true);
    if ("rows" in result) {
      expect(result.total).toBe(20_001);
      expect(result.rows[0]!.path).toMatch(/segments\) …/);
      expect(result.rows[0]!.path.length).toBeLessThan(1_200);
      expect(result.rows[0]!.length).toBe(20_001 - 19_000);
    }
  });
});
