// End-to-end: cbor_validate and cddl_check over stdio — a valid Conway transaction, deliberately
// corrupted copies (byte flip, truncation, trailing byte, a tag 258 where none is allowed), era
// presets, auto rule picking (PlutusData, transaction_body), bad schemas with line/column, and the
// size discipline (every answer < 32k characters).
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fx, fxBig, fxInt, fxStr, readTx } from "../helpers/fixtures.js";
import { serverVariants, type McpTestClient, type ToolCallResult } from "../mcpClient.js";

const TX = readTx("vote-tx.tx"); // [ body{0,1,2,19}, {}, true, null ]: scenario s12, laid out so the offsets below are in the manifest
const span = (name: string) => fx<{ offset: number; length: number }>(`s12.spans.${name}`);
const at = (name: string) => `${span(name).offset}+${span(name).length}`;
const SIZE = fxInt("s12.size");
const FEE = String(fxBig("s12.fee"));
const FEE_HEX = "1a" + fxBig("s12.fee").toString(16).padStart(8, "0"); // the fee's CBOR bytes (an unsigned 32-bit integer)
const BODY = fxStr("s12.bodyHex");
const CUT = fx<{ length: number; offset: number }>("s12.truncated.minus10"); // TX.slice(0, -20): ten bytes short, where the decoder gives up
const flipByte = (hex: string, offset: number, byte: string) => hex.slice(0, offset * 2) + byte + hex.slice(offset * 2 + 2);
const insertAt = (hex: string, offset: number, bytes: string) => hex.slice(0, offset * 2) + bytes + hex.slice(offset * 2);
/** A definite CBOR byte string around `hex` (header + payload). */
const bstr = (hex: string) => {
  const n = hex.length / 2;
  const head = n < 24 ? (0x40 + n).toString(16) : n < 256 ? "58" + n.toString(16).padStart(2, "0") : "59" + n.toString(16).padStart(4, "0");
  return head + hex;
};

interface ErrorRow {
  kind: string;
  message: string;
  expected: string | null;
  path: string | null;
  path_short: string | null;
  byte_offset: number | null;
  byte_length: number | null;
  anchor_offset?: number;
  anchor_length?: number;
  value_offset?: number;
  hex_excerpt?: string;
  excerpt_offset?: number;
  cddl_fragment: string | null;
  cddl_line: number | null;
  alternatives?: string[];
}

interface ValidateAnswer {
  input_kind: string;
  input_bytes: number;
  root?: string;
  root_kind?: string | null;
  schema: { source: string; era?: string; rules: number; roots: number; rule?: string | null; rule_picked?: boolean; admissible_roots?: number; candidates?: Array<{ rule: string; valid: boolean; head_kind?: string; head_path?: string; problems?: number; unmatched_bytes?: number }> };
  valid: boolean | null;
  verdict: string;
  errors: ErrorRow[];
  additional_count: number;
  structural_error?: { kind: string; message: string; offset: number | null; path: string; byte_length: number | null; partial_summary: string | null; hex_excerpt?: string };
  oddities?: Array<{ kind: string; path: string; byte_offset: number; note: string }>;
  hints: string[];
  decoded?: { value: unknown; depth: number; path?: string };
  raw?: { value: unknown };
  resources?: Array<{ uri: string }>;
  unexamined?: { kind: string };
}

interface CheckAnswer {
  valid: boolean;
  verdict: string;
  schema: { source: string; era?: string; lines: number };
  error?: { kind: string; message: string; line: number | null; col: number | null; snippet: string | null; unresolved: Array<{ name: string; line: number; col: number }> };
  outline: { rules: number; roots: number; roots_by_kind: Record<string, string[]>; groups: string[]; parameterised: string[] };
  references?: { rule: string; declared: boolean; kind: string; is_root: boolean; root_kinds?: string[]; definition: { line: number; col: number; text: string | null } | null; uses: Array<{ line: number; col: number }>; uses_total: number };
  formatted?: { text: string; offset: number; limit: number; lines_returned: number; total_lines: number; next_offset?: number };
}

describe.each(serverVariants())("cbor_validate / cddl_check over stdio — $label", ({ start }) => {
  let client: McpTestClient;
  const sizes: Array<[string, number]> = [];

  /** Call a tool, assert the text/structured discipline and the size cap, return the parsed answer. */
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<ToolCallResult<T>> => {
    const result = await client.callTool<T>(name, args);
    const text = result.content.find((c) => c.type === "text")!.text!;
    expect(JSON.parse(text), `${name}: text == structuredContent`).toEqual(result.structuredContent);
    expect(text.length, `${name}(${JSON.stringify(args).slice(0, 60)}) size`).toBeLessThan(32_000);
    sizes.push([name, text.length]);
    return result;
  };
  const validate = async (args: Record<string, unknown>): Promise<ValidateAnswer> => {
    const result = await call<ValidateAnswer>("cbor_validate", args);
    expect(result.isError, JSON.stringify(result.structuredContent).slice(0, 300)).toBeFalsy();
    return result.structuredContent!;
  };
  const check = async (args: Record<string, unknown>): Promise<CheckAnswer> => {
    const result = await call<CheckAnswer>("cddl_check", args);
    expect(result.isError, JSON.stringify(result.structuredContent).slice(0, 300)).toBeFalsy();
    return result.structuredContent!;
  };

  beforeAll(async () => {
    client = await start();
  });

  afterAll(async () => {
    const code = await client.close();
    expect(client.nonJsonStdout, "stdout must carry only JSON-RPC").toEqual([]);
    expect(code).toBe(0);
    expect(Math.max(...sizes.map(([, n]) => n)), "largest answer").toBeLessThan(32_000);
  });

  it("tools/list: both tools have flat schemas and point at each other", async () => {
    const { tools } = await client.listTools();
    const validateTool = tools.find((t) => t.name === "cbor_validate")!;
    const checkTool = tools.find((t) => t.name === "cddl_check")!;
    expect(validateTool.inputSchema.type).toBe("object");
    expect(Object.keys(validateTool.inputSchema.properties!).sort()).toEqual(["cddl", "decode", "depth", "hex", "include_raw", "max_errors", "path", "raw_path", "rule"]);
    expect(validateTool.inputSchema.required).toEqual(["hex"]);
    expect(validateTool.description).toMatch(/conway default, babbage, alonzo, mary, allegra, shelley, dijkstra/);
    expect(validateTool.description).toMatch(/cddl_check/);
    expect(validateTool.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys(checkTool.inputSchema.properties!).sort()).toEqual(["cddl", "format", "limit", "offset", "rule"]);
    expect(checkTool.inputSchema.required).toEqual(["cddl"]);
    expect(checkTool.description).toMatch(/cbor_validate/);
    const decodeTool = tools.find((t) => t.name === "cbor_decode")!;
    expect(Object.keys(decodeTool.inputSchema.properties!).sort()).toEqual(["as", "depth", "hex", "limit", "offset", "path", "plutus_version", "schema"]);
    expect(decodeTool.description).toMatch(/spans/);
    expect(decodeTool.description).not.toMatch(/cddl:<rule>/);
    expect(decodeTool.description).toMatch(/cbor_validate/);
  });

  it("a valid Conway transaction: auto rule pick, decoded tree, resource link", async () => {
    const answer = await validate({ hex: TX, depth: 2 });
    expect(answer).toMatchObject({ input_kind: "hex", input_bytes: SIZE, root: "array(4 items)", root_kind: "array", valid: true, errors: [], additional_count: 0 });
    expect(answer.schema).toMatchObject({ source: "preset:conway", era: "conway", rule: "transaction", rule_picked: true, candidates: [{ rule: "transaction", valid: true }] });
    expect(answer.schema.rules).toBeGreaterThan(140); // declared names (same count as cddl_check's outline.rules)
    expect(answer.schema.roots).toBeGreaterThan(100);
    expect(answer.schema.roots).toBeLessThan(answer.schema.rules);
    expect(answer.schema.admissible_roots).toBeGreaterThan(30);
    expect(answer.verdict).toMatch(/valid transaction under preset:conway/);
    expect(Object.keys(answer.decoded!.value as Record<string, unknown>)).toEqual(expect.arrayContaining(["transaction_body", "transaction_witness_set"]));
    expect(answer.decoded!.depth).toBe(2);
    expect(answer.resources!.map((r) => r.uri)).toContain("cardano-debug://cddl/conway");
    expect(answer.hints).toEqual([]);
    expect(answer.oddities).toBeUndefined();

    // zoom into the fee with path; explicit rule; decode off
    const fee = await validate({ hex: TX, rule: "transaction", path: "/transaction_body/2" });
    expect(fee.schema.rule_picked).toBe(false);
    expect(fee.decoded).toEqual({ value: FEE, depth: 8, path: "/transaction_body/2" }); // no depth given: as many levels as fit the window
    const quiet = await validate({ hex: TX, decode: false, include_raw: true, depth: 1 });
    expect(quiet.decoded).toBeUndefined();
    expect((quiet.raw!.value as { type: string }).type).toBe("Array");
  });

  it("include_raw reads path per view: a pointer zooms decoded, a `$` path or raw_path zooms raw, nothing is reported missing for the wrong view", async () => {
    const pointer = await validate({ hex: TX, include_raw: true, path: "/transaction_body/2" });
    expect(pointer.decoded).toMatchObject({ path: "/transaction_body/2", value: FEE });
    expect(pointer.raw).toMatchObject({ view: "raw" });
    expect((pointer.raw as { skipped?: string }).skipped).toMatch(/pass raw_path/);
    const dollar = await validate({ hex: TX, include_raw: true, path: "$[0][2]" });
    expect(dollar.raw).toMatchObject({ path: "$[0][2]", value: { type: "U32", at: at("fee"), value: FEE } });
    const both = await validate({ hex: TX, include_raw: true, path: "/transaction_body/2", raw_path: "$[0][2]" });
    expect(both.decoded).toMatchObject({ value: FEE });
    expect(both.raw).toMatchObject({ value: { at: at("fee") } });
  });

  it("cbor_decode as='spans' pages {path, type, offset, length} rows; as='raw' nodes carry `at` as an \"offset+length\" string", async () => {
    type Spans = { as: string; rows: Array<{ path: string; type: string; offset: number; length: number; key?: boolean }>; total: number; offset: number; next_offset?: number };
    const first = await call<Spans>("cbor_decode", { hex: TX, as: "spans", limit: 4 });
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toMatchObject({ as: "spans", offset: 0, next_offset: 4 });
    expect(first.structuredContent!.rows[0]).toEqual({ path: "$", type: "Array", offset: 0, length: SIZE });
    const fee = await call<Spans>("cbor_decode", { hex: TX, as: "spans", path: "$[0][2]" });
    expect(fee.structuredContent!.rows).toEqual([{ path: "$[0][2]", type: "U32", ...span("fee"), value: FEE }]);
    expect(TX.slice(span("fee").offset * 2, (span("fee").offset + span("fee").length) * 2)).toBe(FEE_HEX);
    const miss = await call<{ code: string; resolved: string }>("cbor_decode", { hex: TX, as: "spans", path: "$[0][9]" });
    expect(miss.isError).toBe(true);
    expect(miss.structuredContent).toMatchObject({ code: "path_not_found", resolved: "$[0]" });
    const raw = await call<{ value: { at: string; values: Array<{ at: string }> } }>("cbor_decode", { hex: TX, as: "raw", depth: 1 });
    expect(raw.structuredContent!.value.at).toBe(`0+${SIZE}`);
    expect(raw.structuredContent!.value.values[0]!.at).toBe(at("body"));
    const odd = await call<{ message: string }>("cbor_decode", { hex: "84 a4 0" });
    expect(odd.isError).toBe(true);
    expect(odd.structuredContent!.message).toMatch(/odd number of digits \(5\) once the whitespace is removed/);
  });

  it("byte flip (body key 1 -> 7): precise mismatch with offset, hex excerpt, schema fragment, second row and hints", async () => {
    const keyAt = span("outputsKey").offset; // body key 1 (the outputs); the array it names starts one byte later
    const outputsAt = span("outputs").offset;
    const flipped = flipByte(TX, keyAt, "07");
    const answer = await validate({ hex: flipped, rule: "transaction", decode: false });
    expect(answer.valid).toBe(false);
    expect(answer.verdict).toMatch(new RegExp(`do not match transaction: 2 problems; head mismatch at \\$\\[0\\]\\[7\\] \\(byte ${outputsAt}\\) — expected type bstr, got array\\(1 items\\)\\.$`)); // the expected type is not repeated
    expect(answer.errors).toHaveLength(2);
    const head = answer.errors[0]!;
    expect(head).toMatchObject({ kind: "mismatch", path: "$[0][7]", expected: "bstr", byte_offset: outputsAt, byte_length: 1, cddl_fragment: "auxiliary_data_hash" });
    expect(head.message).toMatch(/expected type bstr, got array\(1 items\)/);
    expect(head.cddl_line).toBeGreaterThan(0);
    expect(head.hex_excerpt!.length).toBeLessThanOrEqual(64);
    expect(head.hex_excerpt!.slice((outputsAt - head.excerpt_offset!) * 2, (outputsAt - head.excerpt_offset!) * 2 + 2)).toBe("81"); // the array header of the outputs
    expect(answer.errors[1]).toMatchObject({ kind: "generic", path: "$[0]", message: "map missing key: 1" });
    expect(answer.hints.join("\n")).toMatch(/Required map key 1 is missing/);
    expect(answer.oddities![0]).toMatchObject({ kind: "MapKeysNotSorted", path: "$[0]" }); // 7 now sorts after 2
    expect(answer.hints.join("\n")).toMatch(/canonical order/);
    // the schema fragment's line really holds the fragment
    const cddl = await client.readResourceText(`cardano-debug://cddl/conway?offset=${head.cddl_line! - 1}&limit=1`);
    expect(cddl).toMatch(/auxiliary_data_hash/);
  });

  it("truncated hex: structural error with offset, decoder path, partial summary and the truncation hint", async () => {
    const answer = await validate({ hex: TX.slice(0, -20), decode: false });
    expect(answer).toMatchObject({ input_bytes: CUT.length, valid: false, errors: [], additional_count: 0 });
    expect(answer.structural_error).toMatchObject({ kind: "unexpected_eof", offset: CUT.offset, byte_length: 1, partial_summary: "array(4 items, incomplete)" });
    expect(answer.structural_error!.path).toMatch(/^\$\[0\]\.entries\[3\]/);
    expect(answer.structural_error!.hex_excerpt).toHaveLength(64);
    expect(answer.verdict).toMatch(new RegExp(`not well-formed CBOR: unexpected_eof at byte ${CUT.offset}`));
    expect(answer.hints[0]).toMatch(new RegExp(`ends after ${CUT.length} bytes while an item at offset ${CUT.offset} still expects content: the hex was truncated`));
    expect(answer.schema.rule).toBeUndefined();
  });

  it("trailing byte: trailing_data at the end with its hint; odd hex length is explained", async () => {
    const answer = await validate({ hex: TX + "00", decode: false });
    expect(answer.structural_error).toMatchObject({ kind: "trailing_data", offset: SIZE, byte_length: 1, path: "$", partial_summary: "array(4 items)" });
    expect(answer.hints[0]).toMatch(new RegExp(`Bytes remain after the top-level item ends at offset ${SIZE}`));

    const odd = await call<{ code: string; message: string; input_kind: string }>("cbor_validate", { hex: TX + "0" });
    expect(odd.isError).toBe(true);
    expect(odd.structuredContent).toMatchObject({ code: "invalid_argument", input_kind: "text" });
    expect(odd.structuredContent!.message).toMatch(new RegExp(`odd number of digits \\(${SIZE * 2 + 1}\\)`));
  });

  it("tag 258 where the schema wants a plain array: the set-tag hint; the same bytes are fine as a set", async () => {
    const wrapped = insertAt(TX, span("outputs").offset, "d90102"); // outputs list wrapped in the set tag
    const answer = await validate({ hex: wrapped, rule: "transaction", decode: false });
    expect(answer.valid).toBe(false);
    expect(answer.errors).toHaveLength(1);
    expect(answer.errors[0]).toMatchObject({ kind: "mismatch", path: "$[0][1]", byte_offset: span("outputs").offset, byte_length: 3, expected: "array [ * transaction_output ]", cddl_fragment: "[* transaction_output]" });
    expect(answer.errors[0]!.message).toMatch(/got #6\.258\(array\(1 items\)\)/);
    expect(answer.hints.join("\n")).toMatch(/Conway set tag 258 but this rule does not allow it/);
    // auto mode reaches the same verdict through the candidate search (transaction is the closest root)
    const auto = await validate({ hex: wrapped, decode: false });
    expect(auto.schema.rule).toBe("transaction");
    expect(auto.schema.rule_picked).toBe(true);
    expect(auto.schema.candidates!.length).toBeGreaterThan(1);
    expect(auto.schema.candidates![0]).toMatchObject({ rule: "transaction", valid: false, head_path: "$[0][1]" });
    expect(auto.errors[0]!.path).toBe("$[0][1]");
  });

  it("era presets: a Conway transaction against babbage fails on the set tag and key 19 with era hints", async () => {
    const answer = await validate({ hex: TX, cddl: "babbage", rule: "transaction", decode: false });
    expect(answer.schema).toMatchObject({ source: "preset:babbage", era: "babbage" });
    expect(answer.valid).toBe(false);
    expect(answer.errors[0]).toMatchObject({ kind: "mismatch", path: "$[0][0]", byte_offset: span("inputs").offset, byte_length: 3, cddl_fragment: "set<transaction_input>" });
    expect(answer.errors.map((e) => e.message)).toEqual(expect.arrayContaining([expect.stringMatching(/got #6\.258/), "unexpected key 19"]));
    const key19 = answer.errors.find((e) => e.message === "unexpected key 19")!;
    // the row names the entry (`$[0][19]`) and points at the key; its value and the whole entry come along
    const votesKeyAt = span("votesKey").offset;
    expect(key19).toMatchObject({ kind: "mismatch", path: "$[0][19]", byte_offset: votesKeyAt, byte_length: 1, value_offset: span("votes").offset, value_length: span("votes").length, anchor_offset: votesKeyAt, anchor_length: 1 + span("votes").length });
    expect(key19.hex_excerpt!.slice((votesKeyAt - key19.excerpt_offset!) * 2, (votesKeyAt - key19.excerpt_offset!) * 2 + 2)).toBe("13"); // the key 19 itself
    expect(answer.hints.join("\n")).toMatch(/babbage schema does not allow it here: validate with cddl='conway'/);
    expect(answer.hints.join("\n")).toMatch(/Key 19 is not allowed/);
    expect(answer.resources!.map((r) => r.uri)).toContain("cardano-debug://cddl/babbage");
    // without a rule, the candidate search still lands on transaction (fewest unmatched bytes), not on the permissive plutus_data
    const auto = await validate({ hex: TX, cddl: "Babbage", decode: false });
    expect(auto.schema.rule).toBe("transaction");
    expect(auto.schema.candidates!.some((c) => c.rule === "plutus_data")).toBe(true);
    // every era preset is accepted and parses
    for (const era of ["shelley", "allegra", "mary", "alonzo", "dijkstra"]) {
      const result = await check({ cddl: era });
      expect(result.valid, era).toBe(true);
      expect(result.schema.era, era).toBe(era);
      expect(result.outline.roots_by_kind.array, era).toContain("transaction");
    }
  });

  it("auto rule pick: a PlutusData blob and a bare transaction_body", async () => {
    const datum = await validate({ hex: "d8799f41aa02ff" });
    expect(datum).toMatchObject({ root: "#6.121(indefinite array(2 items))", root_kind: "tag:121", valid: true });
    expect(datum.schema).toMatchObject({ rule: "plutus_data", rule_picked: true, candidates: [{ rule: "plutus_data", valid: true }] });
    expect(datum.oddities).toEqual([{ kind: "IndefiniteLength", path: "$", byte_offset: 2, byte_length: 1, note: "indefinite-length array" }]);
    expect(datum.hints[0]).toMatch(/Indefinite-length items/);
    expect(datum.decoded!.value).toEqual({ "@tag": "121", "@value": ["aa", "2"] });

    const body = BODY;
    const answer = await validate({ hex: body, decode: false });
    expect(answer).toMatchObject({ root: "map(4 entries)", root_kind: "map", valid: true });
    expect(answer.schema).toMatchObject({ rule: "transaction_body", rule_picked: true, candidates: [{ rule: "transaction_body", valid: true }] });
    expect(answer.verdict).toMatch(/valid transaction_body under preset:conway \(rule picked: 1 of \d+ admissible roots tried\)/);

    // constructor 7 (tag 1280): valid on chain, not in the ledger CDDL's constr rule -> the over-approximation hint
    const seven = await validate({ hex: "d9050080", rule: "plutus_data", decode: false });
    expect(seven.valid).toBe(false);
    expect(seven.errors[0]!.alternatives!.length).toBeGreaterThan(1);
    expect(seven.hints[0]).toMatch(/Tag 1280 is PlutusData constructor 7 .* over-approximation/);
  });

  it("auto rule pick: a body without its fee and a 3-element transaction are diagnosed as the right object", async () => {
    // body = the tx's second element (an a4 map); key 2 (fee) is `02 1a <4 bytes>`, right after the outputs
    const body = BODY;
    const feeFrom = span("feeKey").offset - span("body").offset;
    const feeTo = span("fee").offset + span("fee").length - span("body").offset;
    const bodyNoFee = "a3" + body.slice(2, feeFrom * 2) + body.slice(feeTo * 2);
    const answer = await validate({ hex: bodyNoFee, decode: false });
    expect(answer).toMatchObject({ root: "map(3 entries)", valid: false });
    expect(answer.schema.rule).toBe("transaction_body");
    expect(answer.schema.candidates!.some((c) => c.rule === "metadata" || c.rule === "plutus_data")).toBe(true);
    expect(answer.errors[0]).toMatchObject({ kind: "generic", message: "map missing key: 2", path: "$", byte_offset: 0 });
    expect(answer.verdict).toMatch(/do not match transaction_body: 1 problem; head generic at \$ \(byte 0\) — map missing key: 2/);
    expect(answer.hints.join("\n")).toMatch(/Required map key 2 is missing/);
    expect(answer.hints.some((h) => /None of the/.test(h))).toBe(false);

    const three = await validate({ hex: "83" + body + "a0f6", decode: false });
    expect(three.schema.rule).toBe("transaction");
    expect(three.errors[0]).toMatchObject({ kind: "mismatch", path: "$", message: "expected array with length 4, got 3", byte_offset: 0 });
    expect(three.hints.some((h) => /None of the/.test(h))).toBe(false);
    expect(three.schema.candidates!.find((c) => c.rule === "plutus_data")!.problems).toBeGreaterThan(1);
  });

  it("hints read the head only: choice siblings at the root do not contradict it", async () => {
    // a 27-byte owner where 28 are required; the other alternative (#6.122([])) fails at `$` as a from_type_choice sibling
    const order = await validate({ hex: "d87982581b" + "aa".repeat(27) + "1903e8", cddl: "order = [owner: bstr .size 28, price: uint]\ndatum = #6.121(order) / #6.122([])", decode: false });
    expect(order.valid).toBe(false);
    expect(order.errors[0]).toMatchObject({ path: "$[0]", message: "expected byte string of size 28 bytes, got 27 bytes", expected: "byte string of size 28 bytes" });
    expect(order.errors.some((e) => e.path === "$")).toBe(true);
    expect(order.hints).toHaveLength(1);
    expect(order.hints[0]).toMatch(/27 bytes where 28 are required/);
    // a Babbage output map whose datum_option index disagrees with its payload: the alonzo (array) alternative at `$` is not a verdict about the root
    const output = await validate({ hex: "a300581d60" + "00".repeat(28) + "0105028201" + "5820" + "aa".repeat(32), rule: "transaction_output", decode: false });
    expect(output.errors[0]).toMatchObject({ path: "$[2][0]", message: "expected value 0, got 1" });
    expect(output.hints.some((h) => /root item is a map/.test(h))).toBe(false);
    // a broken inline datum gets its own hint
    const embedded = await validate({ hex: "a300581d60" + "00".repeat(28) + "0105028201d81841ff", rule: "transaction_output", decode: false });
    expect(embedded.errors.some((e) => /error decoding embedded CBOR/.test(e.message))).toBe(true);
    expect(embedded.hints.some((h) => /root item is a map/.test(h))).toBe(false);
  });

  it("PlutusData byte strings: chunked over 64 bytes is valid (the ledger's per-chunk rule), a definite one or a chunk over 64 bytes is not", async () => {
    // 64 + 1 bytes in two chunks: what the reference encoders emit for long values
    const chunked = await validate({ hex: "d8799f5f5840" + "ab".repeat(64) + "41cd" + "ffff", rule: "plutus_data", decode: false });
    expect(chunked.valid).toBe(true);
    expect(chunked.errors).toEqual([]);
    // a definite 65-byte string: refused, with the fix
    const definite = await validate({ hex: "5841" + "aa".repeat(65), rule: "plutus_data", decode: false });
    expect(definite.valid).toBe(false);
    expect(definite.hints.some((h) => /longer than 64 bytes inside plutus_data: the node rejects it/.test(h))).toBe(true);
    // one 70-byte chunk: refused per chunk
    const bigChunk = await validate({ hex: "d8799f5f5846" + "ab".repeat(70) + "ffff", rule: "plutus_data", decode: false });
    expect(bigChunk.valid).toBe(false);
    expect(bigChunk.errors[0]).toMatchObject({ path: "$[0]", byte_offset: 3 });
    expect(bigChunk.errors[0]!.message).toMatch(/got indefinite bytes\(1 chunks\)/);
    expect(bigChunk.hints.some((h) => /chunk over 64 bytes/.test(h) && /re-chunk the value/.test(h))).toBe(true);
    expect(bigChunk.hints.some((h) => /None of the/.test(h))).toBe(false);
    // against bounded_bytes itself the message names the chunk
    const direct = await validate({ hex: "5f5846" + "ab".repeat(70) + "ff", rule: "bounded_bytes", decode: false });
    expect(direct.errors[0]).toMatchObject({ kind: "mismatch", path: "$", message: "expected each chunk of the indefinite-length byte string to be at most 64 bytes, got 70 bytes in chunk 0" });
    expect(direct.hints.some((h) => /chunk 0: 70 bytes/.test(h))).toBe(true);
    // two 32-byte chunks stay valid
    expect((await validate({ hex: "5f5820" + "aa".repeat(32) + "5820" + "bb".repeat(32) + "ff", rule: "plutus_data", decode: false })).valid).toBe(true);
    // ... but are not a 32-byte hash: an exact `.size` holds the whole string, and an indefinite string with no chunks is empty
    const twoHashes = await validate({ hex: "5f5820" + "aa".repeat(32) + "5820" + "bb".repeat(32) + "ff", rule: "hash32", decode: false });
    expect(twoHashes.valid).toBe(false);
    expect(twoHashes.errors[0]!.message).toBe("expected byte string of size 32 bytes, got 64 bytes");
    const noChunks = await validate({ hex: "5fff", rule: "hash32", decode: false });
    expect(noChunks.valid).toBe(false);
    expect(noChunks.errors[0]!.message).toBe("expected byte string of size 32 bytes, got 0 bytes");
    expect((await validate({ hex: "5fff", rule: "bounded_bytes", decode: false })).valid).toBe(true);
  });

  it("an empty witness set encoded as an array (80 for a0) is an ordinary mismatch with the expected map, and explained", async () => {
    const swapped = flipByte(TX, span("witnessSet").offset, "80");
    const answer = await validate({ hex: swapped, rule: "transaction", decode: false });
    expect(answer.valid).toBe(false);
    expect(answer.errors[0]).toMatchObject({ kind: "mismatch", path: "$[1]", byte_offset: span("witnessSet").offset, cddl_fragment: "transaction_witness_set" });
    expect(answer.errors[0]!.message).toMatch(/^expected map \{ \? 0: nonempty_set<vkeywitness>.*, got array\(0 items\)$/);
    expect(answer.errors[0]!.expected).toMatch(/^map \{ \? 0: nonempty_set<vkeywitness>/);
    expect(answer.hints.some((h) => /empty array \(80\) was found where the rule wants a map/.test(h))).toBe(true);
  });

  it("a hex string encoded as text is flagged even when the auto pick wants a literal", async () => {
    const hexAsText = "82" + "7840" + Buffer.from("f952ce8c".repeat(8), "utf8").toString("hex") + "00";
    const answer = await validate({ hex: hexAsText, decode: false });
    expect(answer.valid).toBe(false);
    expect(answer.errors[0]!.message).toMatch(/got text "f952ce8c/);
    expect(answer.hints.some((h) => /(hex string was encoded as CBOR text|text string spelling hex)/.test(h))).toBe(true);
  });

  it("deep nesting: thousands of levels validate (the library's limit is 32768), beyond it the answer is unexamined, never an internal error", async () => {
    const deep = await validate({ hex: "81".repeat(3000) + "00", rule: "plutus_data", decode: false });
    expect(deep.valid).toBe(true);
    const deeper = await validate({ hex: "81".repeat(8000) + "00", rule: "plutus_data", decode: false });
    expect(deeper.valid).toBe(true);
    const beyond = await validate({ hex: "81".repeat(33000) + "00", rule: "plutus_data", decode: false });
    expect(beyond.valid).toBeNull();
    expect(beyond.unexamined).toMatchObject({ kind: "nesting_too_deep" });
    // past the positional decoder's bound too: not examined, never "not well-formed"
    const autoBeyond = await call<{ unexamined?: unknown; notes?: string[]; structural: { ok: boolean } }>("cbor_decode", { hex: "81".repeat(33000) + "00" });
    expect(autoBeyond.isError).toBeFalsy();
    expect(autoBeyond.structuredContent!.unexamined).toEqual({ reason: "nesting", limit: 32768, decoder: "walker" });
    expect(autoBeyond.structuredContent!.notes!.join("\n")).toMatch(/^not examined: the bytes nest deeper than the 32768 levels/);
    expect(autoBeyond.structuredContent!.notes!.join("\n")).not.toMatch(/not well-formed/);
    expect(autoBeyond.content[0]!.type === "text" ? autoBeyond.content[0]!.text!.length : 0).toBeLessThan(32_000);
    const rawDeep = await call<{ as: string; value: unknown; depth: number }>("cbor_decode", { hex: "81".repeat(3000) + "00", as: "raw", depth: 2 });
    expect(rawDeep.isError).toBeFalsy();
    expect(rawDeep.structuredContent!.as).toBe("raw");
    const autoDeep = await call<{ as: string }>("cbor_decode", { hex: "81".repeat(3000) + "00" });
    expect(autoDeep.isError).toBeFalsy();
  });

  it("a 10,000-level native script in a transaction: every CBOR tool examines it and answers under 32k characters", async () => {
    const pubkey = "8200581c" + "11".repeat(28);
    const addr = "5839" + "01" + "22".repeat(28) + "33".repeat(28);
    const body = "a3" + "00" + "81" + "825820" + "44".repeat(32) + "00" + "01" + "81" + "82" + addr + "1a001e8480" + "02" + "1a00030d40";
    const tx = "84" + body + "a1" + "01" + "81" + "820181".repeat(9_999) + pubkey + "f5" + "f6";
    const size = (r: ToolCallResult<unknown>) => (r.content[0]!.type === "text" ? r.content[0]!.text!.length : 0);
    const auto = await validate({ hex: tx });
    expect(auto.valid).toBe(true);
    expect(auto.schema.rule).toBe("transaction");
    const explicit = await validate({ hex: tx, rule: "transaction" });
    expect(explicit.valid).toBe(true);
    // native scripts do not count toward the typed decoders' 64 levels: the transaction decodes, and
    // the types whose reading of the bytes would pass 64 are named as not tried
    type Decoded = { as: string; candidates: string[]; unexamined?: unknown; not_tried?: { reason: string; limit: number; decoder: string; depth?: number; count: number; types: string[] }; notes?: string[] };
    const decoded = await call<Decoded>("cbor_decode", { hex: tx });
    expect(decoded.isError).toBeFalsy();
    expect(decoded.structuredContent!.as).toBe("Transaction");
    expect(decoded.structuredContent!.candidates).toEqual(["Transaction"]);
    expect(decoded.structuredContent!.unexamined).toBeUndefined();
    expect(decoded.structuredContent!.not_tried).toMatchObject({ reason: "nesting", limit: 64, decoder: "typed", depth: 20_002 });
    expect(decoded.structuredContent!.not_tried!.count).toBeGreaterThan(decoded.structuredContent!.not_tried!.types.length);
    expect(decoded.structuredContent!.notes!.join("\n")).toMatch(/not tried .*native scripts do not count|levels inside native scripts do not count/);
    expect(size(decoded)).toBeLessThan(32_000);
    const loaded = await call<{ tx_id: string; counts: Record<string, number> }>("tx_load", { tx_cbor: tx, network: "mainnet" });
    expect(loaded.isError, JSON.stringify(loaded.structuredContent).slice(0, 400)).toBeFalsy();
    expect(size(loaded)).toBeLessThan(32_000);
    const inspected = await call<{ rows: Array<{ plutus_version?: string }> }>("tx_inspect", { tx_id: loaded.structuredContent!.tx_id, section: "scripts" });
    expect(inspected.isError, JSON.stringify(inspected.structuredContent).slice(0, 400)).toBeFalsy();
    expect(inspected.structuredContent!.rows.map((r) => r.plutus_version)).toContain("native");
    expect(size(inspected)).toBeLessThan(32_000);
    for (const section of ["body", "inputs", "outputs", "witnesses", "raw_json", "aux", "datums", "redeemers"]) {
      const view = await call<unknown>("tx_inspect", { tx_id: loaded.structuredContent!.tx_id, section });
      expect(view.isError, `${section}: ${JSON.stringify(view.structuredContent).slice(0, 300)}`).toBeFalsy();
      expect(size(view), section).toBeLessThan(32_000);
    }
    // past the walkers' 32,768 levels even a native script is not examined
    const tooDeep = "84" + body + "a1" + "01" + "81" + "820181".repeat(16_400) + pubkey + "f5" + "f6";
    const refused = await call<{ code?: string; unexamined?: { limit: number; decoder: string } }>("cbor_decode", { hex: tooDeep });
    expect(refused.structuredContent!.unexamined).toMatchObject({ limit: 32_768, decoder: "walker" });
    const refusedLoad = await call<{ code: string }>("tx_load", { tx_cbor: tooDeep, network: "mainnet" });
    expect(refusedLoad.structuredContent).toMatchObject({ code: "unexamined" });
  });

  it("auto mode with a script_ref nested past the CDDL walker: valid is null (not examined), not a false 'not a block'", async () => {
    const script = "8200" + "820181".repeat(16_499) + "8200581c" + "11".repeat(28); // [0, native_script], ≈33k levels
    const len = script.length / 2;
    const addr = "5839" + "01" + "22".repeat(28) + "33".repeat(28);
    const out = "a3" + "00" + addr + "01" + "1a001e8480" + "03" + "d818" + "59" + len.toString(16).padStart(4, "0") + script;
    const tx = "84" + "a3" + "00" + "81" + "825820" + "44".repeat(32) + "00" + "01" + "81" + out + "02" + "1a00030d40" + "a0" + "f5" + "f6";
    const answer = await call<ValidateAnswer & { unexamined: { kind: string; path: string }; verdict: string }>("cbor_validate", { hex: tx });
    expect(answer.isError).toBeFalsy();
    const body = answer.structuredContent!;
    expect(body.valid).toBeNull();
    expect(body.schema.rule).toBe("transaction");
    expect(body.unexamined.kind).toBe("nesting_too_deep");
    expect(body.unexamined.path).toMatch(/segments/);
    expect(body.verdict).toMatch(/^Not examined: .* other candidates? failed \(.*block.*\), but transaction may be the valid reading/);
    for (const c of body.schema.candidates as Array<{ head_path?: string }>) expect((c.head_path ?? "").length).toBeLessThan(200);
    expect(answer.content[0]!.type === "text" ? answer.content[0]!.text!.length : 0).toBeLessThan(32_000);
    const decoded = await call<{ closest_schema: { valid: unknown; rule: string } }>("cbor_decode", { hex: tx });
    expect(decoded.structuredContent!.closest_schema).toMatchObject({ rule: "transaction", valid: null });
  });

  it("as='auto' past the typed decoders' 64-level limit says they were not tried (unexamined), not that none accepted", async () => {
    // a metadata-shaped document (text leaf) 65 levels deep: no typed decoder examines it
    const metadata = "81".repeat(65) + "6161";
    const auto = await call<{ as: string; candidates: string[]; unexamined?: { reason: string; limit: number }; notes?: string[] }>("cbor_decode", { hex: metadata });
    expect(auto.isError).toBeFalsy();
    expect(auto.structuredContent!.unexamined).toEqual({ reason: "nesting", limit: 64, decoder: "typed", depth: 65 });
    expect(auto.structuredContent!.notes!.join("\n")).toMatch(/typed decoders were NOT tried/);
    expect(auto.structuredContent!.notes!.join("\n")).not.toMatch(/no typed decoder accepted/);
    const shallow = await call<{ unexamined?: unknown }>("cbor_decode", { hex: "81".repeat(10) + "6161" });
    expect(shallow.structuredContent!.unexamined).toBeUndefined();
  });

  it("an inline datum nested past 64 levels inside tag 24 of a shallow tx: typed decoders refuse (unexamined), the CDDL validator still reads it", async () => {
    // [ {0: #6.258([[h32, 0]]), 1: [{0: addr, 1: 2000000, 2: [1, #6.24(<datum>)]}], 2: 200000}, {}, true, null ]
    const tx = (datum: string) => "84a300d90102818258" + "20" + "11".repeat(32) + "00" + "0181a300" + bstr("61" + "ab".repeat(28)) + "011a001e8480" + "028201d818" + bstr(datum) + "021a00030d40" + "a0f5f6";
    const deep = tx("d87981".repeat(1100) + "00"); // ~3.4 KB, 1100 constructors: the outer document is 6 levels deep
    const auto = await call<{ candidates: string[]; unexamined?: { reason: string; limit: number }; notes?: string[] }>("cbor_decode", { hex: deep });
    expect(auto.isError).toBeFalsy();
    expect(auto.structuredContent!.candidates).toEqual([]);
    expect(auto.structuredContent!.unexamined).toMatchObject({ reason: "nesting", limit: 64, decoder: "typed" });
    expect(auto.structuredContent!.notes!.join("\n")).toMatch(/typed decoders were NOT tried.*tag-24 payload/);
    expect(auto.structuredContent!.notes!.join("\n")).not.toMatch(/no typed decoder accepted/);
    const loaded = await call<{ code: string; message: string; limit: number }>("tx_load", { tx_cbor: deep, network: "mainnet" });
    expect(loaded.isError).toBe(true);
    expect(loaded.structuredContent).toMatchObject({ code: "unexamined", limit: 64 });
    expect(loaded.structuredContent!.message).toMatch(/^Refused, not invalid: CBOR nesting is deeper than the supported limit of 64 levels/);
    const inspected = await call<{ code: string }>("tx_inspect", { tx_cbor: deep, section: "outputs" });
    expect(inspected.structuredContent).toMatchObject({ code: "unexamined" });
    expect((await validate({ hex: deep, rule: "transaction", decode: false })).valid).toBe(true);
    // within the bound the same shape is an ordinary transaction
    const shallow = tx("d87981".repeat(20) + "00");
    const typed = await call<{ candidates: string[]; unexamined?: unknown }>("cbor_decode", { hex: shallow });
    expect(typed.structuredContent!.candidates).toContain("Transaction");
    expect(typed.structuredContent!.unexamined).toBeUndefined();
    // the server is healthy afterwards (no trap, nothing poisoned)
    expect((await call<{ candidates: string[] }>("cbor_decode", { hex: TX })).structuredContent!.candidates).toContain("Transaction");
  });

  it("the Conway map form of redeemers validates entry by entry; a bad [tag, index] is named with the redeemers map as fragment", async () => {
    // an artificial transaction (scenario s10) whose witness set carries map-form redeemers with several entries
    const multi = readTx("multi-redeemer.tx");
    const redeemersAt = fx<{ offset: number }>("s10.redeemersSpan").offset;
    expect(multi.slice(redeemersAt * 2, redeemersAt * 2 + 2)).toBe("a" + fxInt("s10.redeemerCount").toString(16)); // a map with one entry per redeemer
    const multiRedeemer = await validate({ hex: multi, cddl: "conway", rule: "transaction", decode: false });
    expect(multiRedeemer.valid, JSON.stringify(multiRedeemer.errors[0])).toBe(true);
    const entry = "82d87980821a000f42401a05f5e100"; // [Constr 0 [], [1000000, 100000000]]
    const two = "a105a2" + "820000" + entry + "820001" + entry;
    expect((await validate({ hex: two, cddl: "conway", rule: "transaction_witness_set", decode: false })).valid).toBe(true);
    const babbage = await validate({ hex: two, cddl: "babbage", rule: "transaction_witness_set", decode: false });
    expect(babbage.valid).toBe(false);
    expect(babbage.errors[0]).toMatchObject({ path: "$[5]", message: "expected array [ * redeemer ], got map(2 entries)", cddl_fragment: "redeemers" });
    expect(babbage.hints.some((h) => /Redeemers in the Conway map form/.test(h) && /cddl='conway'/.test(h))).toBe(true);
    // tag 9 does not exist: the entry is blamed and the fragment is the map form of redeemers written out, not its array alternative
    const badTag = await validate({ hex: "a105a2" + "820000" + entry + "820900" + entry, cddl: "conway", rule: "transaction_witness_set", decode: false });
    expect(badTag.valid).toBe(false);
    expect(badTag.errors[0]).toMatchObject({
      path: "$[5][[9, 0]]",
      message: "unexpected key [9, 0]",
      cddl_fragment: "{ + [tag : redeemer_tag, index : uint .size 4] => [ data : plutus_data , ex_units : ex_units ] }",
    });
    expect(badTag.hints.some((h) => /^Redeemer key \[9, 0\] is not a valid \[tag, index\]/.test(h))).toBe(true);
    expect(badTag.hints.join("\n")).not.toMatch(/newer eras add keys|cddl='conway'/);
    // inline composite and tagged key types take every entry under an occurrence
    expect((await validate({ hex: "a28200010182000202", cddl: "start = {+ [uint, uint] => uint}", rule: "start", decode: false })).valid).toBe(true);
    expect((await validate({ hex: "a1d8180101", cddl: "start = {* #6.24(uint) => uint}", rule: "start", decode: false })).valid).toBe(true);
  });

  it("an unexpected key's schema fragment is the map written out: a choice's one map alternative, or the choice when several are maps", async () => {
    const choice = await validate({ hex: "a201010202", cddl: "start = [* uint] / {1: uint}", rule: "start", decode: false });
    expect(choice.errors.find((e) => e.message === "unexpected key 2")).toMatchObject({ path: "$[2]", cddl_fragment: "{1: uint}" });
    // the array alternative's own mismatch keeps the whole choice
    expect(choice.errors.find((e) => e.message.startsWith("expected array"))).toMatchObject({ path: "$", cddl_fragment: "[* uint] / {1: uint}" });
    const maps = await validate({ hex: "a201010202", cddl: "start = {1: uint} / {3: uint}", rule: "start", decode: false });
    expect(maps.errors.filter((e) => e.message.startsWith("unexpected key")).map((e) => e.cddl_fragment)).toEqual(["{1: uint} / {3: uint}", "{1: uint} / {3: uint}"]);
    // a map named by a rule: the map as the rule writes it out, not the reference
    const named = await validate({ hex: "81a201010202", cddl: "start = [x]\nx = {1: uint}", rule: "start", decode: false });
    expect(named.errors[0]).toMatchObject({ path: "$[0][2]", message: "unexpected key 2", cddl_fragment: "{1: uint}", cddl_line: 2 });
    // a text key that is not an identifier is bracketed; its hint is the general one, not the era one
    const text = await validate({ hex: "a201016361206202", cddl: "start = {1: uint}", rule: "start", decode: false });
    expect(text.errors[0]).toMatchObject({ path: '$["a b"]', message: 'unexpected key "a b"', cddl_fragment: "{1: uint}" });
    expect(text.hints.some((h) => /^Key "a b" is not allowed in this map/.test(h) && !/newer eras/.test(h))).toBe(true);
  });

  it("a metadatum string is bounded to 64 bytes as a whole, chunked or not; only bounded_bytes reads its bound per chunk", async () => {
    const chunked = "5f5840" + "ab".repeat(64) + "5824" + "cd".repeat(36) + "ff"; // 100 bytes as 64 + 36
    const metadata = await validate({ hex: "a101" + chunked, cddl: "conway", rule: "metadata", decode: false });
    expect(metadata.valid).toBe(false);
    expect(metadata.errors[0]).toMatchObject({ path: "$[1]", message: "expected map { * metadatum => metadatum }, got indefinite bytes(2 chunks)" });
    expect(metadata.hints.some((h) => /metadatum byte \/ text string holds at most 64 bytes in total/.test(h))).toBe(true);
    const text = await validate({ hex: "a101" + "7f7840" + "61".repeat(64) + "7824" + "62".repeat(36) + "ff", cddl: "conway", rule: "metadata", decode: false });
    expect(text.valid).toBe(false);
    expect(text.hints.some((h) => /at most 64 bytes in total/.test(h))).toBe(true);
    // the same chunks are Plutus bytes of any length
    expect((await validate({ hex: chunked, cddl: "conway", rule: "bounded_bytes", decode: false })).valid).toBe(true);
    expect((await validate({ hex: chunked, cddl: "conway", rule: "plutus_data", decode: false })).valid).toBe(true);
    // a user schema: the whole string counts, except under a rule named bounded_bytes
    const two20 = "5f5814" + "ab".repeat(20) + "5814" + "cd".repeat(20) + "ff";
    const whole = await validate({ hex: two20, cddl: "x = bytes .size (0..32)", rule: "x", decode: false });
    expect(whole.errors[0]!.message).toBe("expected byte string length to be in the range 0 <= value <= 32, got 40");
    expect((await validate({ hex: two20, cddl: "bounded_bytes = bytes .size (0..32)", rule: "bounded_bytes", decode: false })).valid).toBe(true);
  });

  it("inline schemas: valid, unresolved (invalid_schema), text where bytes belong, file path", async () => {
    const inline = await validate({ hex: "a10001", cddl: "root = {0: int}", decode: false });
    expect(inline).toMatchObject({ valid: true });
    expect(inline.schema).toMatchObject({ source: "inline", rule: "root", rule_picked: true });
    expect(inline.resources).toBeUndefined();

    const bad = await call<{ code: string; error: { kind: string; line: number; col: number; unresolved: Array<{ name: string }> }; message: string }>("cbor_validate", { hex: "a10001", cddl: "root = {0: nope}" });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent!.code).toBe("invalid_schema");
    expect(bad.structuredContent!.error).toMatchObject({ kind: "unresolved_references", line: 1, col: 12, unresolved: [{ name: "nope" }] });
    expect(bad.structuredContent!.message).toMatch(/cddl_check/);

    const hexAsText = await validate({ hex: "a10068" + Buffer.from("deadbeef", "utf8").toString("hex"), cddl: "root = {0: bstr}", decode: false }); // {0: "deadbeef"} as text
    expect(hexAsText.valid).toBe(false);
    expect(hexAsText.errors[0]).toMatchObject({ path: "$[0]", expected: "bstr" });
    expect(hexAsText.hints[0]).toMatch(/hex string was encoded as CBOR text/);

    const dir = mkdtempSync(path.join(os.tmpdir(), "cdm-cbor-e2e-"));
    const file = path.join(dir, "mine.cddl");
    writeFileSync(file, "root = [* int]\n");
    const fromFile = await validate({ hex: "820102", cddl: file, decode: false });
    expect(fromFile.schema.source).toBe(`file:${file}`);
    expect(fromFile.valid).toBe(true);
  });

  it("argument failures are ordinary isError results", async () => {
    const noRule = await call<{ code: string; argument: string; suggestions: string[] }>("cbor_validate", { hex: TX, rule: "transaction_bod" });
    expect(noRule.isError).toBe(true);
    expect(noRule.structuredContent).toMatchObject({ code: "invalid_argument", argument: "rule" });
    expect(noRule.structuredContent!.suggestions).toContain("transaction_body");
    const generic = await call<{ code: string; message: string }>("cbor_validate", { hex: TX, rule: "set" });
    expect(generic.structuredContent).toMatchObject({ code: "invalid_argument" });
    expect(generic.structuredContent!.message).toMatch(/generic rule/);
    const bech32 = await call<{ code: string; input_kind: string }>("cbor_validate", { hex: fxStr("s11.scriptAddress") });
    expect(bech32.structuredContent).toMatchObject({ code: "invalid_argument", input_kind: "bech32" });
    const preset = await call<{ code: string; argument: string }>("cbor_validate", { hex: TX, cddl: "byron" });
    expect(preset.structuredContent).toMatchObject({ code: "invalid_argument", argument: "cddl" });
  });

  it("cbor_decode: trailing bytes make the input untyped, malformed input never traps, and the ledger lookalike of a PlutusData pick is named", async () => {
    interface DecodeAnswer {
      as: string;
      candidates?: string[];
      hash?: string;
      structural?: { kind: string; offset: number | null; error?: { kind: string; offset?: number | null } };
      closest_schema?: { rule: string | null; valid: boolean; lookalike?: boolean; head?: { message: string; path: string | null } };
      notes?: string[];
      code?: string;
    }
    const decode = async (args: Record<string, unknown>) => {
      const result = await call<DecodeAnswer>("cbor_decode", args);
      expect(result.isError, JSON.stringify(result.structuredContent).slice(0, 300)).toBeFalsy();
      return result.structuredContent!;
    };
    // trailing bytes after a transaction: not one well-formed CBOR item, so no typed decoder accepts the bytes
    const trailing = await decode({ hex: TX + "deadbeef", depth: 1 });
    expect(trailing.as).toBe("raw");
    expect(trailing.candidates).toEqual([]);
    expect(trailing.structural!.error).toMatchObject({ kind: "trailing_data", offset: SIZE });
    expect(trailing.notes!.some((n) => /not well-formed CBOR; see structural.error/.test(n))).toBe(true);
    const datumTrailing = await decode({ hex: "d87980ff" });
    expect(datumTrailing.as).toBe("raw");
    expect(datumTrailing.structural!.error).toMatchObject({ kind: "trailing_data", offset: 3 });
    // an explicit type answers decode_failed with the library's reason
    const explicit = await call<DecodeAnswer & { message?: string }>("cbor_decode", { hex: TX + "00", as: "Transaction", depth: 1 });
    expect(explicit.isError).toBe(true);
    expect(explicit.structuredContent).toMatchObject({ code: "decode_failed", as: "Transaction" });
    expect(explicit.structuredContent!.message).toMatch(new RegExp(`Malformed CBOR: trailing CBOR data at offset ${SIZE} \\(1 byte\\(s\\) left\\)`));
    const clean = await decode({ hex: TX, depth: 1 });
    expect(clean.structural).toBeUndefined();
    expect(clean.closest_schema).toBeUndefined();
    // malformed bytes on which the typed probe traps: the positional decoder answers first
    for (const hex of ["85e9", "98d4f205bd", "85e965a3ec28ae577f"]) {
      const malformed = await call<DecodeAnswer>("cbor_decode", { hex });
      expect(malformed.isError, hex).toBeFalsy();
      expect(malformed.structuredContent!.as, hex).toBe("raw");
      expect(malformed.structuredContent!.structural!.error!.kind, hex).toMatch(/^(unexpected_eof|invalid_syntax|invalid_utf8)$/);
    }
    // a body missing its outputs: only PlutusData / metadata accept it; the answer names the ledger lookalike
    const bodyNoOutputs = "a2" + "00" + "81" + "82" + "5820" + "aa".repeat(32) + "00" + "02" + "1a0002a515";
    const lookalike = await decode({ hex: bodyNoOutputs });
    expect(lookalike.as).toBe("PlutusData");
    expect(lookalike.closest_schema).toMatchObject({ rule: "transaction_body", valid: false, lookalike: true, head: { message: "map missing key: 1", path: "$" } });
    expect(lookalike.notes!.some((n) => /look like a Conway 'transaction_body' that fails at \$: map missing key: 1/.test(n))).toBe(true);
    // a datum map that no ledger rule gets far into keeps the datum reading
    const datum = await decode({ hex: "a141aa" + "581c" + "bb".repeat(28) });
    expect(datum.as).toBe("PlutusData");
    if (datum.closest_schema) {
      expect(datum.closest_schema.lookalike).toBe(false);
      expect(datum.notes!.some((n) => /datum \/ metadata reading is the likelier one/.test(n))).toBe(true);
    }
    // a constructor datum never triggers the search
    const constr = await decode({ hex: "d8799f41aa02ff" });
    expect(constr.closest_schema).toBeUndefined();
  });

  it("bytes tx_load / tx_inspect cannot decode: decode_failed points at cbor_validate(rule='transaction'), which names the mismatch", async () => {
    // a PlutusData blob handed to the transaction tools (no network: the decode fails before any provider call)
    const loaded = await call<{ code: string; message: string; argument: string; lib_message: string; input_bytes: number; next: string[] }>("tx_load", { tx_cbor: "d8799f41aa02ff" });
    expect(loaded.isError).toBe(true);
    expect(loaded.structuredContent).toMatchObject({ code: "decode_failed", argument: "tx_cbor", input_bytes: 7 });
    expect(loaded.structuredContent!.message).toMatch(/did not decode as a Cardano transaction/);
    expect(loaded.structuredContent!.message).toContain("cbor_validate(hex=<the same bytes>, rule='transaction')");
    expect(loaded.structuredContent!.message).not.toMatch(/JsValue/); // the library wrapper is stripped, the reason kept
    expect(loaded.structuredContent!.message).toMatch(/expected `Array' byte received `Tag'/);
    expect(loaded.structuredContent!.lib_message).toMatch(/Deserialization failed in Transaction/);
    expect(loaded.structuredContent!.next[0]).toMatch(/^cbor_validate\(hex=<the same bytes>, rule='transaction'\)/);
    expect(loaded.structuredContent!.next.some((n) => n.startsWith("cbor_decode("))).toBe(true);
    expect(loaded.structuredContent!.next.some((n) => n.includes("docs(topic='cbor-cddl')"))).toBe(true);

    const inspected = await call<{ code: string; argument: string; next: string[] }>("tx_inspect", { tx_cbor: TX.slice(0, 300), section: "body" });
    expect(inspected.isError).toBe(true);
    expect(inspected.structuredContent).toMatchObject({ code: "decode_failed", argument: "tx_cbor" });
    expect(inspected.structuredContent!.next[0]).toContain("rule='transaction'");

    // following the suggestion on the same bytes gives the precise diagnosis
    const followed = await validate({ hex: "d8799f41aa02ff", rule: "transaction" });
    expect(followed.valid).toBe(false);
    expect(followed.errors[0]).toMatchObject({ kind: "mismatch", path: "$", byte_offset: 0 });
    expect(followed.errors[0]!.expected).toMatch(/^array/);
    expect(followed.errors[0]!.message).toMatch(/#6\.121/);
    const truncated = await validate({ hex: TX.slice(0, 300), rule: "transaction" });
    expect(truncated.valid).toBe(false);
    expect(truncated.structural_error).toMatchObject({ kind: "unexpected_eof" });
    expect(truncated.hints.some((h) => /truncat/i.test(h))).toBe(true);
  });

  it("cddl_check: unresolved references and a duplicate rule come back with line/col and snippet", async () => {
    const unresolved = await check({ cddl: "a = [b, int]\nc = {1: d}\n" });
    expect(unresolved.valid).toBe(false);
    expect(unresolved.error).toMatchObject({ kind: "unresolved_references", line: 1, col: 6, snippet: "a = [b, int]" });
    expect(unresolved.error!.unresolved).toEqual([
      { name: "b", line: 1, col: 6 },
      { name: "d", line: 2, col: 9 },
    ]);
    expect(unresolved.verdict).toMatch(/2 unresolved names/);
    expect(unresolved.outline.roots_by_kind).toEqual({ array: ["a"], map: ["c"] });

    const duplicate = await check({ cddl: "a = [int]\na = tstr\n" });
    expect(duplicate.valid).toBe(false);
    expect(duplicate.error).toMatchObject({ kind: "parse_error", line: 2, col: 1, snippet: "a = tstr", unresolved: [] });
    expect(duplicate.error!.message).toMatch(/already defined/);
    expect(duplicate.outline.rules).toBe(0);
  });

  it("cddl_check: the Conway outline, a rule's references, and the formatted window", async () => {
    const conway = await check({ cddl: "conway", rule: "transaction_body" });
    expect(conway.valid).toBe(true);
    expect(conway.verdict).toMatch(/parses and every reference resolves/);
    expect(conway.outline.rules).toBeGreaterThan(140);
    expect(conway.outline.roots).toBeGreaterThan(100);
    expect(conway.outline.roots_by_kind.array).toContain("transaction");
    expect(conway.outline.roots_by_kind.map).toContain("transaction_body");
    expect(conway.outline.roots_by_kind["tag:24"]).toContain("script_ref");
    expect(conway.outline.roots_by_kind.any).toContain("plutus_data");
    expect(conway.outline.parameterised).toEqual(expect.arrayContaining(["set", "nonempty_set"]));
    expect(conway.outline.groups.length).toBeGreaterThan(10);
    expect(conway.references).toMatchObject({ rule: "transaction_body", declared: true, kind: "type", is_root: true, root_kinds: ["map"] });
    expect(conway.references!.definition!.line).toBeGreaterThan(0);
    expect(conway.references!.definition!.text).toMatch(/^transaction_body = \{ 0 : set<transaction_input>/);
    expect(conway.references!.uses_total).toBeGreaterThan(0);
    expect(conway.references!.uses[0]).toMatchObject({ line: expect.any(Number), col: expect.any(Number) });

    const prelude = await check({ cddl: "conway", rule: "uint" });
    expect(prelude.references).toMatchObject({ rule: "uint", declared: false, is_root: false, definition: null });
    expect(prelude.references!.uses_total).toBeGreaterThan(10);

    const unknown = await call<{ code: string; suggestions: string[] }>("cddl_check", { cddl: "conway", rule: "no_such_rule_here" });
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent!.code).toBe("invalid_argument");

    const formatted = await check({ cddl: "a = [int, tstr]\nb = {1: a}\n", format: true });
    expect(formatted.formatted!.text).toMatch(/a = \[ int, tstr \]/);
    expect(formatted.formatted!.total_lines).toBeGreaterThanOrEqual(2);
    const window = await check({ cddl: "babbage", format: true, offset: 5, limit: 3 });
    expect(window.formatted).toMatchObject({ offset: 5, limit: 3, lines_returned: 3 });
    expect(window.formatted!.next_offset).toBe(8);
    expect(window.formatted!.text.split("\n")).toHaveLength(3);
  });
});
