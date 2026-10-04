// cbor_decode / cbor_validate / cddl_check against the in-process library: byte spans in the raw tree,
// as='spans', the output budget, the per-view paths of cbor_validate, cddl_check paging and lookups.
import { describe, expect, it } from "vitest";

import type { AppContext } from "../../../src/context.js";
import { cborDecode, describeTextInput } from "../../../src/tools/cbor_decode.js";
import { cborValidate } from "../../../src/tools/cbor_validate.js";
import { cddlCheck } from "../../../src/tools/cddl_check.js";
import type { ToolResult } from "../../../src/tools/_shared.js";
import { fx, fxArr, fxBig, fxStr, readTx } from "../../helpers/fixtures.js";
import { inProcessLib } from "../../helpers/inProcessLib.js";

const ctx = { lib: inProcessLib() } as unknown as AppContext;
const TX = readTx("vote-tx.tx"); // [ body{0, 1, 2, 19}, {}, true, null ] (scenario s12)
const LOCK = readTx("lock-spend.tx"); // a V2 reference-script spend with metadata (scenario s08)
const span = (name: string) => fx<{ offset: number; length: number }>(`s12.spans.${name}`);
const at = (name: string) => `${span(name).offset}+${span(name).length}`;
const FEE = String(fxBig("s12.fee"));

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = (r: ToolResult): Json => JSON.parse((r.content[0] as { text: string }).text) as Json;
const size = (r: ToolResult) => (r.content[0] as { text: string }).text.length;
const decode = async (args: Record<string, unknown>) => cborDecode(ctx, args as never);
const validate = async (args: Record<string, unknown>) => body(await cborValidate(ctx, args as never));
const check = async (args: Record<string, unknown>) => cddlCheck(ctx, args as never);

describe("cbor_decode as='raw': byte spans survive pruning", () => {
  it("each node carries `at: \"offset+length\"` as a scalar string, even folded at depth 1", async () => {
    const full = body(await decode({ hex: TX, as: "raw" }));
    const root = full.value as { at: string; values: Array<{ at: string; values: Array<{ k: { at: string; value: string }; v: { at: string; value: string } }> }> };
    expect(root.at).toBe(at("tx"));
    expect(root.values[0]!.at).toBe(at("body"));
    const fee = root.values[0]!.values.find((e) => e.k.value === "2")!;
    expect(fee.v).toMatchObject({ type: "U32", at: at("fee"), value: FEE });
    const shallow = body(await decode({ hex: TX, as: "raw", depth: 1 }));
    const children = (shallow.value as { values: Array<{ type: string; at: string; collapsed?: boolean }> }).values;
    expect(children.map((c) => [c.type, c.at])).toEqual([["Map", at("body")], ["Map", at("witnessSet")], ["Bool", at("isValid")], ["Null", at("aux")]]);
    expect(children[0]!.collapsed).toBe(true);
  });

  it("oddity rows carry byte_length beside byte_offset", async () => {
    const answer = body(await decode({ hex: "a1 1800 9f 01 ff".replace(/ /g, ""), as: "raw" }));
    // { 1800: [_ 1] }: the 2-byte key at offset 1, the indefinite array's 1-byte header at offset 3
    expect(answer.oddities.map((o: Json) => [o.kind, o.path, o.byte_offset, o.byte_length])).toEqual([
      ["IntNotShortest", "$[0]", 1, 2],
      ["IndefiniteLength", "$[0]", 3, 1],
    ]);
  });

  it("a `$` path (the spans / validator grammar) zooms the tree, tags transparent; a miss names where it stops", async () => {
    const fee = body(await decode({ hex: TX, as: "raw", path: "$[0][2]" }));
    expect(fee).toMatchObject({ path: "$[0][2]", value: { type: "U32", at: at("fee") } });
    const set = body(await decode({ hex: TX, as: "raw", path: "$[0][0]" }));
    expect(set.value).toMatchObject({ type: "Array", at: `${span("inputs").offset + 3}+${span("inputs").length - 3}` }); // the tag's content
    const miss = await decode({ hex: TX, as: "raw", path: "$[0][9]" });
    expect(miss.isError).toBe(true);
    expect(body(miss)).toMatchObject({ code: "path_not_found", resolved: "$[0]", available: ["$[0][0]", "$[0][1]", "$[0][2]", "$[0][19]"] });
    // a JSON pointer into the compact tree keeps working
    expect(body(await decode({ hex: TX, as: "raw", path: "/values/2" })).value).toMatchObject({ type: "Bool", at: at("isValid") });
  });

  it("a `$` path on a typed answer is explained, not reported as a missing key", async () => {
    const typed = await decode({ hex: TX, as: "Transaction", path: "$[0]" });
    expect(typed.isError).toBe(true);
    expect(body(typed)).toMatchObject({ code: "invalid_argument", argument: "path" });
    expect(body(typed).message).toMatch(/as='raw' or as='spans'/);
  });
});

describe("cbor_decode output budget", () => {
  const floats = (n: number) => {
    let hex = "99" + n.toString(16).padStart(4, "0");
    for (let i = 0; i < n; i++) {
      const b = Buffer.alloc(8);
      b.writeDoubleBE(i + 0.5);
      hex += "fb" + b.toString("hex");
    }
    return hex;
  };

  it("an untyped 300-float array keeps its items instead of collapsing to `[… 300 items]`; depth >= 6 raises the budget to hold them all", async () => {
    const hex = floats(300);
    const dflt = body(await decode({ hex }));
    expect(dflt.as).toBe("raw");
    const cut = dflt.value as { items: number; values: Array<{ type: string; value: number }>; more: number };
    expect(cut.values.length).toBeGreaterThan(100);
    expect(cut.values.length + cut.more).toBe(300);
    expect(dflt.truncated).toBe(true);
    expect(dflt.notes.join("\n")).toMatch(/as='spans'/);
    expect(dflt.notes.join("\n")).toMatch(/depth >= 6/);
    expect(JSON.stringify(dflt.value).length).toBeLessThanOrEqual(10_000);
    const all = body(await decode({ hex, depth: 8 }));
    expect((all.value as { values: unknown[]; more?: number }).values).toHaveLength(300);
    expect(all.truncated).toBeUndefined();
    // as='raw' and the untyped answer share the budget
    const raw = body(await decode({ hex, as: "raw" }));
    expect((raw.value as { values: unknown[] }).values.length).toBe(cut.values.length);
  });

  it("the default typed decode of a full transaction shows inputs, outputs and fee instead of `{… 2 keys}` summaries", async () => {
    const answer = body(await decode({ hex: LOCK }));
    expect(answer.as).toBe("Transaction");
    const txBody = answer.value.transaction.body as Json;
    expect(txBody.inputs[0]).toMatchObject({ transaction_id: expect.stringMatching(/^[0-9a-f]{64}$/), index: String(fxArr<{ index: number }>("s08.inputs")[0]!.index) });
    expect(txBody.outputs[1].amount.coin).toBe(fxStr("s08.out1Coin"));
    expect(txBody.fee).toBe(String(fxBig("s08.fee")));
    expect(answer.truncated).toBeUndefined();
  });

  it("an explicit depth still caps the levels; the answer says so with a summary, not a truncation", async () => {
    const shallow = body(await decode({ hex: LOCK, depth: 2 }));
    expect(shallow.depth).toBe(2);
    expect(shallow.value.transaction.body).toMatch(/^\{… \d+ keys: inputs, outputs/);
  });

  it("a transaction too big for the budget is cut breadth-first: top-level sections stay, `truncated` and a note say how to see the rest", async () => {
    const big = readTx("wide-mint.tx"); // 26 outputs, 25 of them with ~270-byte inline datums: far over the 10,000-character budget
    const answer = body(await decode({ hex: big }));
    expect(answer.truncated).toBe(true);
    expect(JSON.stringify(answer.value).length).toBeLessThanOrEqual(10_000);
    expect(Object.keys(answer.value.transaction)).toEqual(expect.arrayContaining(["body", "witness_set", "is_valid"]));
    expect(answer.notes.join("\n")).toMatch(/breadth-first/);
    expect(answer.depth).toBeGreaterThanOrEqual(1);
  });
});

describe("cbor_decode as='spans'", () => {
  it("pages rows {path, type, offset, length} with next_offset; offset / length point at the item's bytes", async () => {
    const first = body(await decode({ hex: LOCK, as: "spans", limit: 7 }));
    expect(first).toMatchObject({ as: "spans", path: "$", offset: 0, limit: 7, next_offset: 7, truncated: true });
    expect(first.rows).toHaveLength(7);
    expect(first.rows[0]).toEqual({ path: "$", type: "Array", offset: 0, length: fx<number>("s08.size") });
    const second = body(await decode({ hex: LOCK, as: "spans", limit: 7, offset: 7 }));
    expect(second.rows[0]).not.toEqual(first.rows[0]);
    expect(second.total).toBe(first.total);
    // paging to the end collects every row exactly once
    let offset = 0;
    let count = 0;
    for (;;) {
      const page = body(await decode({ hex: LOCK, as: "spans", limit: 100, offset }));
      count += page.rows.length;
      if (page.next_offset === undefined) break;
      offset = page.next_offset;
    }
    expect(count).toBe(first.total);
  });

  it("path (`$` grammar) selects a subtree, depth the levels below it", async () => {
    const answer = body(await decode({ hex: TX, as: "spans", path: "$[0]", depth: 1 }));
    expect(answer.path).toBe("$[0]");
    expect(answer.depth).toBe(1);
    expect(answer.rows.map((r: Json) => r.path)).toEqual(["$[0]", "$[0][0]", "$[0][0]", "$[0][0]", "$[0][1]", "$[0][1]", "$[0][2]", "$[0][2]", "$[0][19]", "$[0][19]"]);
    const fee = answer.rows.find((r: Json) => r.path === "$[0][2]" && !r.key);
    expect(fee).toEqual({ path: "$[0][2]", type: "U32", ...span("fee"), value: FEE });
    expect(TX.slice(fee.offset * 2, (fee.offset + fee.length) * 2)).toBe("1a" + fxBig("s12.fee").toString(16).padStart(8, "0"));
  });

  it("a path in another grammar, a missing path and a non-bytes input are said plainly", async () => {
    const pointer = await decode({ hex: TX, as: "spans", path: "/values/0" });
    expect(pointer.isError).toBe(true);
    expect(body(pointer)).toMatchObject({ code: "invalid_argument", argument: "path" });
    const miss = await decode({ hex: TX, as: "spans", path: "$[0][9]" });
    expect(body(miss)).toMatchObject({ code: "path_not_found", resolved: "$[0]" });
    const bech32 = await decode({ hex: fxStr("s11.scriptAddress"), as: "spans" });
    expect(bech32.isError).toBe(true);
    expect(body(bech32).code).toBe("invalid_argument");
  });

  it("malformed bytes still list the spans of the decoded prefix, with the error", async () => {
    const answer = body(await decode({ hex: TX.slice(0, -20), as: "spans", limit: 5 }));
    expect(answer).toMatchObject({ as: "spans", partial: true });
    expect(answer.error.kind).toBe("unexpected_eof");
    expect(answer.rows[0]).toMatchObject({ path: "$", type: "Array" });
  });
});

describe("describeTextInput names the real fault", () => {
  it("whitespace is not the problem when the digit count is odd", () => {
    const message = describeTextInput("84 a4 0");
    expect(message).toMatch(/odd number of digits \(5\) once the whitespace is removed/);
    expect(message).not.toMatch(/remove the separators/);
    expect(describeTextInput("0x84a40")).toMatch(/odd number of digits \(5\)/);
    expect(describeTextInput("84a40")).not.toMatch(/whitespace/);
  });

  it("a stray character, a bech32 string, an empty input and other text each get their own reason", () => {
    expect(describeTextInput("84a4 0g12 5820")).toMatch(/stray character: "g" at position 7/);
    expect(describeTextInput(fxStr("s11.scriptAddress"))).toMatch(/bech32 string, not CBOR bytes/);
    expect(describeTextInput("0x  ")).toMatch(/empty/);
    expect(describeTextInput("hello world!")).toMatch(/"!" at position 12/);
    expect(describeTextInput("foo1qpzry9x8gf2tvdw0s3jn54khce6mua7l")).toMatch(/bech32 string with an unknown prefix/);
  });

  it("the tools put the reason into their invalid_argument message", async () => {
    const decoded = await decode({ hex: "84 a4 0" });
    expect(decoded.isError).toBe(true);
    expect(body(decoded).message).toMatch(/odd number of digits \(5\) once the whitespace is removed/);
    const validated = await cborValidate(ctx, { hex: "84 a4 0" } as never);
    expect(body(validated).message).toMatch(/odd number of digits \(5\) once the whitespace is removed/);
    expect(body(validated).message).not.toMatch(/remove the separators/);
  });
});

describe("cbor_validate: path and raw_path per view", () => {
  it("a JSON pointer zooms decoded; the raw view says it was skipped instead of reporting a missing path", async () => {
    const answer = await validate({ hex: TX, include_raw: true, path: "/transaction_body/2" });
    expect(answer.decoded).toMatchObject({ path: "/transaction_body/2", value: FEE });
    expect(answer.raw).toMatchObject({ view: "raw" });
    expect(answer.raw.path_not_found).toBeUndefined();
    expect(answer.raw.skipped).toMatch(/reads the decoded view; pass raw_path/);
  });

  it("a `$` path zooms raw and is skipped in decoded; raw_path wins for raw", async () => {
    const answer = await validate({ hex: TX, include_raw: true, path: "$[0][2]" });
    expect(answer.raw).toMatchObject({ path: "$[0][2]", value: { type: "U32", at: at("fee"), value: FEE } });
    expect(answer.decoded).toMatchObject({ view: "decoded" });
    expect(answer.decoded.skipped).toMatch(/CBOR path/);
    const both = await validate({ hex: TX, include_raw: true, path: "/transaction_body/2", raw_path: "$[0][2]" });
    expect(both.decoded).toMatchObject({ path: "/transaction_body/2", value: FEE });
    expect(both.raw).toMatchObject({ path: "$[0][2]", value: { at: at("fee") } });
  });

  it("a path neither view reads is path_not_found in each, labelled with its view; with decode off it is the raw view's alone", async () => {
    const answer = await validate({ hex: TX, include_raw: true, path: "/nope" });
    expect(answer.decoded).toMatchObject({ view: "decoded", path_not_found: "/nope" });
    expect(answer.raw).toMatchObject({ view: "raw", path_not_found: "/nope" });
    const only = await validate({ hex: TX, include_raw: true, decode: false, path: "/values/0/k" });
    expect(only.decoded).toBeUndefined();
    expect(only.raw).toMatchObject({ view: "raw", path_not_found: "/values/0/k", resolved: "/values/0" });
    const dollar = await validate({ hex: TX, include_raw: true, raw_path: "$[0][9]" });
    expect(dollar.raw).toMatchObject({ view: "raw", path_not_found: "$[0][9]", resolved: "$[0]" });
  });

  it("a window that does not fit its 6,000 characters is cut breadth-first, flagged, and says where the whole tree is", async () => {
    // a plutus_data list of 2,000 integers
    const hex = "99" + (2000).toString(16).padStart(4, "0") + Array.from({ length: 2000 }, (_, i) => "1a" + (100_000 + i).toString(16).padStart(8, "0")).join("");
    const answer = await validate({ hex, rule: "plutus_data", include_raw: true });
    expect(answer.valid).toBe(true);
    for (const view of ["decoded", "raw"] as const) {
      expect(answer[view].truncated, view).toBe(true);
      expect(JSON.stringify(answer[view].value).length, view).toBeLessThanOrEqual(6_000);
      expect(answer[view].note, view).toMatch(/cbor_decode\(as='raw' \| 'spans'\)/);
    }
    expect(answer.raw.value.values.length + answer.raw.value.more).toBe(2000);
  });

  it("without depth the decoded window shows as many levels as fit (a fixed shallow default would hide the outputs)", async () => {
    const answer = await validate({ hex: LOCK, rule: "transaction" });
    const outputs = answer.decoded.value.transaction_body["1"] ?? answer.decoded.value.transaction_body.outputs;
    expect(JSON.stringify(answer.decoded.value)).not.toMatch(/\{… \d+ keys/);
    expect(outputs).toBeDefined();
  });
});

describe("cddl_check", () => {
  it("formatted pages by whole lines: next_offset continues exactly where the text stops, every line comes back once", async () => {
    let offset = 0;
    let lines = 0;
    let cuts = 0;
    let total = 0;
    for (;;) {
      const answer = body(await check({ cddl: "conway", format: true, limit: 1_000, offset }));
      const f = answer.formatted as { text: string; lines_returned: number; total_lines: number; next_offset?: number; truncated?: boolean };
      expect(f.text.length).toBeLessThanOrEqual(16_000);
      expect(f.text.split("\n").length).toBe(f.lines_returned); // no half line at the end
      lines += f.lines_returned;
      total = f.total_lines;
      if (f.truncated) cuts++;
      if (f.next_offset === undefined) break;
      expect(f.next_offset).toBe(offset + f.lines_returned);
      offset = f.next_offset;
    }
    expect(lines).toBe(total);
    expect(cuts).toBeGreaterThanOrEqual(1);
  });

  it("an offset past the end says so instead of answering the last line", async () => {
    const answer = body(await check({ cddl: "conway", format: true, offset: 5_000, limit: 3 }));
    expect(answer.formatted).toMatchObject({ text: "", offset: 5_000, lines_returned: 0 });
    expect(answer.formatted.note).toMatch(/past the last line/);
  });

  it("a prelude name is not a typo: its lookup answers kind 'prelude', used or not", async () => {
    const used = body(await check({ cddl: "conway", rule: "uint" })).references;
    expect(used).toMatchObject({ rule: "uint", declared: false, kind: "prelude" });
    expect(used.uses_total).toBeGreaterThan(0);
    expect(used.note).toMatch(/prelude type/);
    const unused = body(await check({ cddl: "conway", rule: "tstr" }));
    expect(unused.references).toMatchObject({ rule: "tstr", kind: "prelude", uses_total: 0 });
    const typo = await check({ cddl: "conway", rule: "transaction_bod" });
    expect(typo.isError).toBe(true);
    expect(body(typo).suggestions).toContain("transaction_body");
  });

  it("an unknown name is invalid_argument with similar rules", async () => {
    const miss = await check({ cddl: "conway", rule: "zzz_no_such_rule" });
    expect(miss.isError).toBe(true);
    expect(body(miss)).toMatchObject({ code: "invalid_argument", argument: "rule" });
  });

  it("outline lists are capped at 100 names with the omitted count beside them", async () => {
    const text = Array.from({ length: 450 }, (_, i) => (i % 3 === 0 ? `r${i} = [uint, tstr]` : i % 3 === 1 ? `r${i} = {0: uint}` : `r${i} = bstr .size 32`)).join("\n");
    const answer = body(await check({ cddl: text }));
    expect(answer.valid).toBe(true);
    expect(answer.outline.roots).toBe(450);
    for (const kind of ["array", "map", "bytes"]) expect(answer.outline.roots_by_kind[kind]).toHaveLength(100);
    expect(answer.outline.roots_by_kind_omitted).toEqual({ array: 50, map: 50, bytes: 50 });
    // the bundled presets are far below the cap: nothing omitted
    const conway = body(await check({ cddl: "conway" }));
    expect(conway.outline.roots_by_kind_omitted).toBeUndefined();
    expect(conway.outline.roots_by_kind.array).toContain("transaction");
    expect(size(await check({ cddl: text }))).toBeLessThan(8_000);
  });
});
