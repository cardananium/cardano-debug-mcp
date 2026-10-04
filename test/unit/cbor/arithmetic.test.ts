import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CDDL_FRAGMENT_CHARS,
  cddlFragment,
  collapseWhitespace,
  EXCERPT_HEX_CHARS,
  firstSpan,
  fitHeadTail,
  hexExcerpt,
  lineColOf,
  mapKeyEntryIndex,
  sliceHexBytes,
  sourceLine,
  stripCddlComments,
} from "../../../src/cbor/arithmetic.js";
import { PROJECT_ROOT } from "../../mcpClient.js";

const HEX = Array.from({ length: 100 }, (_, i) => i.toString(16).padStart(2, "0")).join(""); // bytes 00..63

describe("hexExcerpt", () => {
  it("centres a short span in a 32-byte window and reports the window's offset", () => {
    const excerpt = hexExcerpt(HEX, 50, 1);
    expect(excerpt.excerpt_bytes).toBe(32);
    expect(excerpt.hex_excerpt).toHaveLength(EXCERPT_HEX_CHARS);
    expect(excerpt.excerpt_offset).toBe(50 - 15);
    // the blamed byte sits inside the window at (50 - excerpt_offset) * 2
    expect(excerpt.hex_excerpt.slice((50 - excerpt.excerpt_offset) * 2, (50 - excerpt.excerpt_offset) * 2 + 2)).toBe("32");
    expect(excerpt.excerpt_truncated).toBeUndefined();
  });
  it("clamps at both ends of the input", () => {
    expect(hexExcerpt(HEX, 0, 1)).toEqual({ hex_excerpt: HEX.slice(0, 64), excerpt_offset: 0, excerpt_bytes: 32 });
    expect(hexExcerpt(HEX, 99, 1)).toEqual({ hex_excerpt: HEX.slice(-64), excerpt_offset: 68, excerpt_bytes: 32 });
    // a truncation error points one past the end: clamp to the last byte
    expect(hexExcerpt(HEX, 100, 1).excerpt_offset).toBe(68);
    expect(hexExcerpt("abcd", 0, 1)).toEqual({ hex_excerpt: "abcd", excerpt_offset: 0, excerpt_bytes: 2 });
    expect(hexExcerpt("", 0, 1)).toEqual({ hex_excerpt: "", excerpt_offset: 0, excerpt_bytes: 0 });
  });
  it("starts at the span when the span is longer than the window and flags the truncation", () => {
    const excerpt = hexExcerpt(HEX, 10, 60);
    expect(excerpt.excerpt_offset).toBe(10);
    expect(excerpt.excerpt_bytes).toBe(32);
    expect(excerpt.excerpt_truncated).toBe(true);
    expect(hexExcerpt(HEX, 10, 32).excerpt_truncated).toBeUndefined();
  });
  it("lowercases and honours a custom window", () => {
    expect(hexExcerpt("ABCDEF01", 1, 1, 4)).toEqual({ hex_excerpt: "cdef", excerpt_offset: 1, excerpt_bytes: 2 });
  });
});

describe("sliceHexBytes / firstSpan", () => {
  it("slices whole bytes and clamps", () => {
    expect(sliceHexBytes(HEX, 2, 3)).toBe("020304");
    expect(sliceHexBytes(HEX, 99, 5)).toBe("63");
    expect(sliceHexBytes(HEX, 200, 1)).toBe("");
  });
  it("takes the first usable span", () => {
    expect(firstSpan([{ offset: 3, length: 2 }, { offset: 9, length: 1 }])).toEqual({ offset: 3, length: 2 });
    expect(firstSpan([])).toBeNull();
    expect(firstSpan(undefined)).toBeNull();
    expect(firstSpan([{ offset: 3, length: -1 }])).toEqual({ offset: 3, length: 0 });
  });
});

const SOURCE = "a = [b]\nb = {\n  1: int,\n  2: tstr\n}\n; tail";

describe("lineColOf / sourceLine / cddlFragment", () => {
  it("is 1-based and clamps to the text", () => {
    expect(lineColOf(SOURCE, 0)).toEqual({ line: 1, col: 1 });
    expect(lineColOf(SOURCE, 4)).toEqual({ line: 1, col: 5 });
    expect(lineColOf(SOURCE, 8)).toEqual({ line: 2, col: 1 });
    expect(lineColOf(SOURCE, 16)).toEqual({ line: 3, col: 3 });
    expect(lineColOf(SOURCE, 10_000).line).toBe(6);
    expect(sourceLine(SOURCE, 3)).toBe("  1: int,");
    expect(sourceLine(SOURCE, 99)).toBe("");
  });
  it("slices a SourceSpan by its char offsets, collapses whitespace and caps", () => {
    const span = { offset: 8, length: 27, char_offset: 8, char_length: 27, line: 2 };
    expect(cddlFragment(SOURCE, span)).toEqual({ text: "b = { 1: int, 2: tstr }", line: 2, col: 1 });
    expect(cddlFragment(SOURCE, [4, 7])).toEqual({ text: "[b]", line: 1, col: 5 });
    expect(cddlFragment(SOURCE, span, 10)!.text).toBe("b = { 1: …");
    expect(cddlFragment(SOURCE, span, 10)!.text).toHaveLength(10);
  });
  it("answers null for missing, empty or out-of-range spans", () => {
    expect(cddlFragment(SOURCE, null)).toBeNull();
    expect(cddlFragment(SOURCE, undefined)).toBeNull();
    expect(cddlFragment(SOURCE, [5, 5])).toBeNull();
    expect(cddlFragment(SOURCE, [500, 600])).toBeNull();
    expect(cddlFragment(SOURCE, { offset: 0, length: 0, char_offset: 0, char_length: 0, line: 1 })).toBeNull();
  });
  it("collapseWhitespace joins indented lines", () => {
    expect(collapseWhitespace("  [ a\n  , b ]  ")).toBe("[ a , b ]");
  });
});

describe("cddl_fragment: comments and long maps", () => {
  const CONWAY = readFileSync(path.join(PROJECT_ROOT, "src", "assets", "cddl", "conway.cddl"), "utf8");
  const mapOf = (rule: string): [number, number] => {
    const start = CONWAY.indexOf("{", CONWAY.indexOf(`\n${rule} =`));
    return [start, CONWAY.indexOf("\n  }", start) + 4];
  };

  it("drops ; comments before the lines are joined, so a comment cannot swallow the next member", () => {
    const user = "start = {\n  1: uint ; the one\n  ? 3: uint ; three\n}";
    expect(cddlFragment(user, [8, user.length])!.text).toBe("{ 1: uint ? 3: uint }");
    expect(stripCddlComments("a ; c\nb")).toBe("a \nb");
    expect(stripCddlComments("x = 1 ; last line")).toBe("x = 1 ");
    // a ; inside a text or byte literal is content (escaped quotes included)
    expect(stripCddlComments('k = "a;b" ; c\n')).toBe('k = "a;b" \n');
    expect(stripCddlComments("k = h'00;' ; c")).toBe("k = h'00;' ");
    expect(stripCddlComments('k = "a\\";b" ; c')).toBe('k = "a\\";b" ');
  });

  it("a long map keeps its head and its tail: the Conway body shows keys 0-3 and 19-22, no comment text", () => {
    const body = cddlFragment(CONWAY, mapOf("transaction_body"))!;
    expect(body.text.length).toBeLessThanOrEqual(CDDL_FRAGMENT_CHARS);
    expect(body.text).toBe(
      "{ 0 : set<transaction_input> , 1 : [* transaction_output] , 2 : coin , ? 3 : slot , … ? 19 : voting_procedures , ? 20 : proposal_procedures , ? 21 : coin , ? 22 : positive_coin }",
    );
    expect(body.text).not.toMatch(/;|fee|time to live/);
    const witnesses = cddlFragment(CONWAY, mapOf("transaction_witness_set"))!;
    expect(witnesses.text).toMatch(/^\{ \? 0 : nonempty_set<vkeywitness> , .* … .*\? 7 : nonempty_set<plutus_v3_script> \}$/);
  });

  it("the member of a missing key stays visible between head and tail", () => {
    const at11 = cddlFragment(CONWAY, mapOf("transaction_body"), CDDL_FRAGMENT_CHARS, "11")!.text;
    expect(at11.length).toBeLessThanOrEqual(CDDL_FRAGMENT_CHARS);
    expect(at11).toMatch(/^\{ 0 : set<transaction_input> , .* … \? 11 : script_data_hash , .* … .*\? 22 : positive_coin \}$/);
    // a key the head or tail already shows needs no window
    expect(cddlFragment(CONWAY, mapOf("transaction_body"), CDDL_FRAGMENT_CHARS, "2")!.text).toBe(cddlFragment(CONWAY, mapOf("transaction_body"))!.text);
  });

  it("mapKeyEntryIndex finds a member by the key the library prints", () => {
    const text = "{ 0 : a , 2 : b , ? 22 : c , -3 : d , ? name: e , \"a b\" => f }";
    expect(text.slice(mapKeyEntryIndex(text, "2"))).toMatch(/^2 : b/);
    expect(text.slice(mapKeyEntryIndex(text, "22"))).toMatch(/^\? 22 : c/);
    expect(text.slice(mapKeyEntryIndex(text, "-3"))).toMatch(/^-3 : d/);
    expect(text.slice(mapKeyEntryIndex(text, '"name"'))).toMatch(/^\? name: e/);
    expect(text.slice(mapKeyEntryIndex(text, '"a b"'))).toMatch(/^"a b" => f/);
    expect(mapKeyEntryIndex(text, "5")).toBe(-1);
    expect(mapKeyEntryIndex(text, "h'00'")).toBe(-1);
  });

  it("fitHeadTail never exceeds its budget and leaves short text alone", () => {
    const body = collapseWhitespace(stripCddlComments(CONWAY.slice(...mapOf("transaction_body"))));
    for (let max = 1; max <= body.length + 5; max++) {
      expect(fitHeadTail(body, max).length, `max ${max}`).toBeLessThanOrEqual(max);
      expect(fitHeadTail(body, max, mapKeyEntryIndex(body, "13")).length, `max ${max} focus`).toBeLessThanOrEqual(max);
    }
    expect(fitHeadTail("{ 1: uint }", 200)).toBe("{ 1: uint }");
    expect(fitHeadTail(body, 20)).toBe(`${body.slice(0, 19)}…`);
  });
});
