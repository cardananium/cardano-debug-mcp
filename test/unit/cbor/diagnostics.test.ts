// Diagnostic shaping over real library answers (in-process wasm) for a small Conway transaction.
import { describe, expect, it } from "vitest";
import type { CborDecodeError, CborValidationErrorInfo, CddlErrorInfo } from "@cardananium/cquisitor-lib";

import { loadEraCddl } from "../../../src/cbor/presets.js";
import { PATH_ECHO_CHARS, shapeSchemaError, shapeStructuralError, shapeValidationErrors } from "../../../src/cbor/diagnostics.js";
import { toWireJson } from "../../../src/vocab/json.js";
import { fx, fxInt, readTx } from "../../helpers/fixtures.js";
import { rawLib } from "../../helpers/inProcessLib.js";

const TX = readTx("vote-tx.tx"); // scenario s12: one DRep vote, tag-258 inputs, 197 bytes
const span = (name: string) => fx<{ offset: number; length: number }>(`s12.spans.${name}`);
const CONWAY = loadEraCddl("conway");
const validate = (hex: string, rule: string) => JSON.parse(rawLib().validate_cbor_against_cddl!(hex, CONWAY, rule) as string) as { valid: boolean; error?: CborValidationErrorInfo };
const decode = (hex: string) => JSON.parse(rawLib().cbor_to_json!(hex) as string) as { ok: boolean; error?: CborDecodeError; partial?: unknown };

describe("shapeValidationErrors", () => {
  it("the outputs array wrapped in tag 258: one row with offsets, excerpt and schema fragment", () => {
    const at = span("outputs").offset;
    const wrapped = TX.slice(0, at * 2) + "d90102" + TX.slice(at * 2);
    const result = validate(wrapped, "transaction");
    expect(result.valid).toBe(false);
    const { errors, additional_count } = shapeValidationErrors(result.error, wrapped, CONWAY, 10);
    expect(additional_count).toBe(0);
    expect(errors).toHaveLength(1);
    const row = errors[0]!;
    expect(row).toMatchObject({ kind: "mismatch", path: "$[0][1]", path_short: "$[0][1]", expected: "array [ * transaction_output ]", byte_offset: at, byte_length: 3, anchor_offset: at, anchor_length: span("outputs").length + 3 });
    expect(row.message).toMatch(/got #6\.258\(array\(1 items\)\)/);
    expect(row.cddl_fragment).toBe("[* transaction_output]");
    expect(row.cddl_line).toBeGreaterThan(0);
    expect(CONWAY.split("\n")[row.cddl_line! - 1]).toMatch(/transaction_output/);
    expect(row.hex_excerpt!.length).toBeLessThanOrEqual(64);
    expect(row.excerpt_offset).toBeLessThanOrEqual(at);
    // the blamed bytes (the tag header d90102) sit inside the excerpt at the right place
    expect(row.hex_excerpt!.slice((at - row.excerpt_offset!) * 2, (at - row.excerpt_offset!) * 2 + 6)).toBe("d90102");
  });
  it("body key 1 -> 7: head first, then the missing-key row; max_errors caps and counts", () => {
    const key = span("outputsKey").offset;
    const flipped = TX.slice(0, key * 2) + "07" + TX.slice((key + 1) * 2);
    const result = validate(flipped, "transaction");
    const all = shapeValidationErrors(result.error, flipped, CONWAY, 10);
    expect(all.errors.map((e) => [e.kind, e.path])).toEqual([
      ["mismatch", "$[0][7]"],
      ["generic", "$[0]"],
    ]);
    expect(all.errors[0]!.expected).toBe("bstr");
    expect(all.errors[0]!.cddl_fragment).toBe("auxiliary_data_hash");
    expect(all.errors[1]!.message).toBe("map missing key: 1");
    expect(all.errors[1]!.expected).toBe("1"); // the missing key, as a CDDL literal
    const capped = shapeValidationErrors(result.error, flipped, CONWAY, 1);
    expect(capped.errors).toHaveLength(1);
    expect(capped.additional_count).toBe(1);
    // the character budget drops tail rows the same way (the head always stays)
    const budgeted = shapeValidationErrors(result.error, flipped, CONWAY, 10, 100);
    expect(budgeted.errors).toHaveLength(1);
    expect(budgeted.additional_count).toBe(1);
  });
  it("a folded type choice keeps its alternatives and occurrence count", () => {
    const result = validate("d9050080", "plutus_data"); // tag 1280
    const { errors } = shapeValidationErrors(result.error, "d9050080", CONWAY, 5);
    expect(errors[0]).toMatchObject({ kind: "mismatch", path: "$", byte_offset: 0 });
    expect(errors[0]!.alternatives!.length).toBeGreaterThanOrEqual(2);
    expect(errors[0]!.occurrences).toBeGreaterThan(1);
  });
  it("errors[0] is the library's head even when the containment order would put another row first", () => {
    const pool = readTx("pool-mint.tx"); // scenario s07: tag-258 sets in body 0 / 13 and witness 0, V3 scripts (witness key 7)
    const BABBAGE = loadEraCddl("babbage");
    const result = JSON.parse(rawLib().validate_cbor_against_cddl!(pool, BABBAGE, "transaction") as string) as { valid: boolean; error?: CborValidationErrorInfo };
    expect(result.valid).toBe(false);
    expect(result.error!.path).toBe("$[0][0]"); // the lib's head: the inputs set tag
    const { errors } = shapeValidationErrors(result.error, pool, BABBAGE, 10);
    expect(errors[0]).toMatchObject({ kind: "mismatch", path: "$[0][0]", byte_offset: fx<{ offset: number }>("s07.spans.inputs").offset });
    // the rest keep the innermost-first order (the witness-set rows $[1][0] / $[1][7] after the body rows)
    const rest = errors.slice(1).map((e) => e.path);
    expect(rest).toContain("$[1][0]");
    expect(rest).toContain("$[1][7]"); // `unexpected key 7`: the entry's path
    expect(rest.indexOf("$[0][13]")).toBeLessThan(rest.indexOf("$[1][0]"));
    expect(errors.length).toBe(new Set(errors.map((e) => `${e.path}|${e.message}`)).size); // no duplicate of the head
  });
  it("an `unexpected key N` row names the entry and points at the key; its value and the whole entry are given", () => {
    const BABBAGE = loadEraCddl("babbage");
    const result = JSON.parse(rawLib().validate_cbor_against_cddl!(TX, BABBAGE, "transaction") as string) as { valid: boolean; error?: CborValidationErrorInfo };
    const { errors } = shapeValidationErrors(result.error, TX, BABBAGE, 10);
    const row = errors.find((e) => e.message === "unexpected key 19")!;
    // the body map starts at byte 1; key 19 (`13`) sits right before its value (the voting procedures map)
    const k = span("votesKey").offset;
    const v = span("votes");
    expect(row).toMatchObject({ kind: "mismatch", path: "$[0][19]", byte_offset: k, byte_length: 1, value_offset: v.offset, value_length: v.length, anchor_offset: k, anchor_length: 1 + v.length });
    expect(row.expected).toBeNull();
    expect(row.hex_excerpt!.slice((k - row.excerpt_offset!) * 2, (k - row.excerpt_offset!) * 2 + 2)).toBe("13");
    // the positional tree, when given, changes nothing (the validator's spans are authoritative)
    const raw = decode(TX) as { value?: unknown };
    const withTree = shapeValidationErrors(result.error, TX, BABBAGE, 10, undefined, raw.value).errors.find((e) => e.message === "unexpected key 19")!;
    expect(withTree).toMatchObject({ byte_offset: k, value_offset: v.offset, value_length: v.length, anchor_offset: k, anchor_length: 1 + v.length });
    // a text key: the row names it in dot form, the message quotes it
    const person = JSON.parse(rawLib().validate_cbor_against_cddl!("a2646e616d6565416c69636563616765181e", "Person = { name: tstr }", "Person") as string) as { error?: CborValidationErrorInfo };
    const age = shapeValidationErrors(person.error, "a2646e616d6565416c69636563616765181e", "Person = { name: tstr }", 5).errors[0]!;
    expect(age).toMatchObject({ path: "$.age", message: 'unexpected key "age"', byte_offset: 12, byte_length: 4, value_offset: 16, value_length: 2, anchor_offset: 12, anchor_length: 6 });
  });
  it("a composite key in a path is the validator's diagnostic notation, passed through", () => {
    const result = validate(TX, "plutus_data"); // a transaction is not PlutusData: the head sits under the voting_procedures map, keyed by an array
    expect(result.error!.path).toMatch(/^\$\[0\]\[19\]\[\[2, h'[0-9a-f]{56}'\]\]\[\[h'[0-9a-f]{64}', 0\]\]\[1\]$/);
    const { errors } = shapeValidationErrors(result.error, TX, CONWAY, 3);
    expect(errors[0]!.path).toBe(result.error!.path);
    expect(errors[0]!.path_short!.length).toBeLessThanOrEqual(errors[0]!.path!.length);
  });
  it("a path past PATH_ECHO_CHARS is echoed abbreviated (a deep document's path runs to tens of thousands of segments)", () => {
    const hex = "81".repeat(3000) + "61" + "61";
    const result = validate(hex, "plutus_data");
    expect(result.error!.path!.length).toBeGreaterThan(PATH_ECHO_CHARS);
    const { errors } = shapeValidationErrors(result.error, hex, CONWAY, 3);
    expect(errors[0]!.path!.length).toBeLessThan(200);
    expect(errors[0]!.path).toMatch(/… \([\d,]+ segments\) …/);
    expect(JSON.stringify(errors).length).toBeLessThan(8_000);
  });
  it("input_parse rows carry the decoder offset", () => {
    const truncated = TX.slice(0, -20);
    const { errors } = shapeValidationErrors(validate(truncated, "transaction").error, truncated, CONWAY, 5);
    expect(errors[0]).toMatchObject({ kind: "input_parse", byte_offset: fxInt("s12.truncated.minus10.offset"), byte_length: 1 });
    expect(errors[0]!.hex_excerpt).toBeDefined();
    expect(shapeValidationErrors(undefined, "", CONWAY, 5)).toEqual({ errors: [], additional_count: 0 });
  });
});

describe("shapeStructuralError", () => {
  it("truncation: offset, decoder path, partial summary and excerpt", () => {
    const truncated = TX.slice(0, -20);
    const raw = decode(truncated);
    expect(raw.ok).toBe(false);
    const shaped = shapeStructuralError(raw.error!, raw.partial, truncated);
    expect(shaped).toMatchObject({ kind: "unexpected_eof", offset: fxInt("s12.truncated.minus10.offset"), byte_length: 1, partial_summary: "array(4 items, incomplete)", partial_root_kind: "array" });
    expect(shaped.path).toMatch(/^\$\[0\]\.entries\[3\]/);
    expect(shaped.hex_excerpt).toHaveLength(64);
  });
  it("trailing data spans the leftover bytes; invalid hex has no offset", () => {
    const trailing = decode(TX + "0000");
    const shaped = shapeStructuralError(trailing.error!, trailing.partial, TX + "0000");
    expect(shaped).toMatchObject({ kind: "trailing_data", offset: fxInt("s12.size"), byte_length: 2, partial_summary: "array(4 items)" });
    const odd = decode("abc");
    const oddShaped = shapeStructuralError(odd.error!, odd.partial, "abc");
    expect(oddShaped).toMatchObject({ kind: "invalid_hex", offset: null, byte_length: null, partial_summary: null, partial_root_kind: null });
    expect(oddShaped.hex_excerpt).toBeUndefined();
  });
});

describe("shapeSchemaError", () => {
  const check = (cddl: string) => toWireJson(rawLib().validate_cddl!(cddl)) as { valid: boolean; error?: CddlErrorInfo };
  it("unresolved references: every occurrence with line and column, snippet of the first", () => {
    const text = "a = [b, int]\nc = {1: d, 2: b}\n";
    const shaped = shapeSchemaError(check(text).error!, text);
    expect(shaped).toMatchObject({ kind: "unresolved_references", line: 1, col: 6, snippet: "a = [b, int]" });
    expect(shaped.message).toMatch(/missing definition for rule b/);
    expect(shaped.unresolved).toEqual([
      { name: "b", line: 1, col: 6 },
      { name: "d", line: 2, col: 9 },
      { name: "b", line: 2, col: 15 },
    ]);
    expect(shaped.unresolved_truncated).toBeUndefined();
  });
  it("a rule defined twice is a parse_error at the redefinition", () => {
    const text = "a = [int]\n\na = tstr\n";
    const shaped = shapeSchemaError(check(text).error!, text);
    expect(shaped).toMatchObject({ kind: "parse_error", line: 3, col: 1, snippet: "a = tstr", unresolved: [] });
    expect(shaped.message).toMatch(/already defined/);
  });
  it("an empty document has no location", () => {
    const shaped = shapeSchemaError(check("; only a comment\n").error!, "; only a comment\n");
    expect(shaped.kind).toBe("no_rules");
    expect(shaped.line).toBeNull();
    expect(shaped.snippet).toBeNull();
  });
});

describe("cddl_fragment of map rows", () => {
  const validateWith = (hex: string, cddl: string, rule: string) => JSON.parse(rawLib().validate_cbor_against_cddl!(hex, cddl, rule) as string) as { valid: boolean; error?: CborValidationErrorInfo };
  // {0: [[#32 zero bytes, 1]], 1: [], 2: 0, 99: 0}
  const BODY_99 = `a40081825820${"00".repeat(32)}0101800200186300`;

  it("an unexpected key in the Conway body shows the body's first and last keys (19-22), without comments", () => {
    const { error } = validateWith(BODY_99, CONWAY, "transaction_body");
    const row = shapeValidationErrors(error, BODY_99, CONWAY, 5).errors.find((e) => e.message === "unexpected key 99")!;
    expect(row.cddl_fragment).toMatch(/^\{ 0 : set<transaction_input> , .* … \? 19 : voting_procedures , \? 20 : proposal_procedures , \? 21 : coin , \? 22 : positive_coin \}$/);
    expect(row.cddl_fragment).not.toMatch(/;|fee|time to live/);
  });

  it("a missing key's member is kept in the fragment; a user schema's comments do not swallow members", () => {
    // {0: [[…, 1]], 1: []}: key 2 (fee) is missing
    const missing = `a20081825820${"00".repeat(32)}010180`;
    const { error } = validateWith(missing, CONWAY, "transaction_body");
    const row = shapeValidationErrors(error, missing, CONWAY, 5).errors.find((e) => e.message === "map missing key: 2")!;
    expect(row.cddl_fragment).toMatch(/ 2 : coin /);
    const user = "start = {\n  1: uint ; the one\n  ? 3: uint ; three\n}";
    const result = validateWith("a201010202", user, "start");
    const unexpected = shapeValidationErrors(result.error, "a201010202", user, 5).errors.find((e) => e.message === "unexpected key 2")!;
    expect(unexpected.cddl_fragment).toBe("{ 1: uint ? 3: uint }");
  });
});
