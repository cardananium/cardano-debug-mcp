import { describe, expect, it } from "vitest";

import { constructorIndexOf, hintsFor, isPlutusConstructorTag, looksDoubleWrappedScript, MAX_HINTS, type HintError } from "../../../src/cbor/hints.js";

const mismatch = (expected: string | null, message: string, path: string | null = "$[0][1]", kind = "mismatch"): HintError => ({ kind, message, expected, path });

describe("hints: structural errors", () => {
  it.each([
    ["invalid_hex", /not a hex byte string/],
    ["unexpected_eof", /truncated|length prefix/],
    ["trailing_data", /Bytes remain after the top-level item/],
    ["unexpected_break", /break byte \(ff\)/],
    ["invalid_utf8", /not UTF-8/],
    ["invalid_chunk", /chunk/],
    ["invalid_syntax", /not a valid CBOR header/],
    ["int_not_representable", /64-bit/],
    ["non_finite_float", /NaN or infinite/],
    ["nesting_too_deep", /implementation limit/],
  ])("%s", (kind, pattern) => {
    const hints = hintsFor({ structural: { kind, message: "m", offset: 158 }, inputBytes: 187 });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(pattern);
    if (kind !== "invalid_hex" && kind !== "nesting_too_deep") expect(hints[0]).toMatch(/offset 158/);
  });
  it("unexpected_eof names the input size; unknown kinds add nothing", () => {
    expect(hintsFor({ structural: { kind: "unexpected_eof", message: "m", offset: 5 }, inputBytes: 9 })[0]).toMatch(/after 9 bytes/);
    expect(hintsFor({ structural: { kind: "io_error", message: "m" } })).toEqual([]);
  });
  it("input_parse validator errors are mapped onto the structural hints", () => {
    expect(hintsFor({ errors: [mismatch(null, "unexpected end of CBOR input at offset 158", "$[0]", "input_parse")] })[0]).toMatch(/offset 158.*truncated/);
    expect(hintsFor({ errors: [mismatch(null, "trailing CBOR data at offset 197 (1 byte(s) left)", "$", "input_parse")] })[0]).toMatch(/Bytes remain.*offset 197/);
    expect(hintsFor({ errors: [mismatch(null, "unexpected CBOR break at offset 5", "$", "input_parse")] })[0]).toMatch(/break byte/);
    expect(hintsFor({ errors: [mismatch(null, "something odd", "$", "input_parse")] })[0]).toMatch(/not well-formed CBOR: something odd/);
  });
});

describe("hints: era set tags", () => {
  it("schema wants #6.258 and found a plain array", () => {
    const [hint] = hintsFor({ errors: [mismatch("tagged data #6.258([ * a0 ])", "expected tagged data #6.258([ * a0 ]), got array(2 items)")] });
    expect(hint).toMatch(/Conway set/);
    expect(hint).toMatch(/pre-Conway eras use bare arrays/);
  });
  it("bytes carry 258 but a pre-Conway schema forbids it", () => {
    const [hint] = hintsFor({ errors: [mismatch("array [ * a0 ]", "expected array [ * a0 ], got #6.258(array(1 items))")], era: "babbage" });
    expect(hint).toMatch(/babbage schema does not allow it/);
    expect(hint).toMatch(/cddl='conway'/);
    const [conway] = hintsFor({ errors: [mismatch("array [ * transaction_output ]", "expected array [ * transaction_output ], got #6.258(array(1 items))")], era: "conway" });
    expect(conway).toMatch(/a set was written where the rule wants a plain array/);
  });
});

describe("hints: PlutusData constructor tags", () => {
  it("tag arithmetic helpers", () => {
    expect(isPlutusConstructorTag(121)).toBe(true);
    expect(isPlutusConstructorTag(127)).toBe(true);
    expect(isPlutusConstructorTag(128)).toBe(false);
    expect(isPlutusConstructorTag(1280)).toBe(true);
    expect(isPlutusConstructorTag(1400)).toBe(true);
    expect(isPlutusConstructorTag(1401)).toBe(false);
    expect(isPlutusConstructorTag(102)).toBe(true);
    expect(isPlutusConstructorTag(258)).toBe(false);
    expect(constructorIndexOf(121)).toBe(0);
    expect(constructorIndexOf(127)).toBe(6);
    expect(constructorIndexOf(1280)).toBe(7);
    expect(constructorIndexOf(1400)).toBe(127);
    expect(constructorIndexOf(102)).toBeNull();
  });
  it("1280-1400 is a schema over-approximation, other tags are not constructors", () => {
    const over = hintsFor({ errors: [mismatch("tagged data #6.121([ * a0 ])", "expected tagged data #6.121([ * a0 ]), got #6.1280(array(0 items))", "$")] });
    expect(over[0]).toMatch(/constructor 7/);
    expect(over[0]).toMatch(/over-approximation/);
    const bad = hintsFor({ errors: [mismatch("tagged data #6.121([ * a0 ])", "expected tagged data #6.121([ * a0 ]), got #6.255(array(2 items))", "$")] });
    expect(bad[0]).toMatch(/Tag 255 is not a PlutusData constructor/);
  });
  it("a constructor where a ledger structure belongs", () => {
    const [hint] = hintsFor({ errors: [mismatch("array [ transaction_body, transaction_witness_set, bool, auxiliary_data / nil ]", "expected array [ … ], got #6.121(array(2 items))", "$")] });
    expect(hint).toMatch(/PlutusData constructor \(tag 121 = constructor 0\)/);
  });
});

describe("hints: containers, text, sizes, integers, keys", () => {
  it("map vs array, at the root and inside", () => {
    expect(hintsFor({ errors: [mismatch("map { 0: set<transaction_input>, … }", "expected map { … }, got array(4 items)", "$")] })[0]).toMatch(/root item is an array but the rule wants a map/);
    expect(hintsFor({ errors: [mismatch("map { 0: … }", "expected map { … }, got array(2 items)", "$[0][1][0]")] })[0]).toMatch(/A map was expected but an array was found/);
    expect(hintsFor({ errors: [mismatch("array [ transaction_body, … ]", "expected array [ … ], got map(4 entries)", "$")] })[0]).toMatch(/root item is a map but the rule wants an array/);
    expect(hintsFor({ errors: [mismatch("array [ address, amount ]", "expected array [ … ], got map(2 entries)", "$[0][1][0]")] })[0]).toMatch(/An array was expected but a map was found/);
  });
  it("hex encoded as text, and text where bytes belong", () => {
    expect(hintsFor({ errors: [mismatch("bstr", 'expected type bstr, got text "deadbeef"')] })[0]).toMatch(/hex string was encoded as CBOR text.*"deadbeef…"/);
    expect(hintsFor({ errors: [mismatch("bstr", 'expected type bstr, got text "hello"')] })[0]).toMatch(/Bytes were expected but a text string was found/);
    expect(hintsFor({ errors: [mismatch("uint", 'expected type uint, got text "1234"')] })).toEqual([]); // too short to be hex bytes
  });
  it("a hex-spelling text string is flagged even when the picked rule wants a literal", () => {
    // ambiguous root: the trial order picked `script` (wants 0) over transaction_input (wants bstr)
    const [hint] = hintsFor({ errors: [mismatch("0", `expected 0, got text "${"f952ce8c".repeat(8)}"`, "$[0]")], rule: "script" });
    expect(hint).toMatch(/text string spelling hex \(32 bytes: a transaction id/);
    expect(hint).toMatch(/major type 3 instead of 2/);
    expect(hint).toMatch(/the rule picked here wants 0/);
    const truncated = hintsFor({ errors: [mismatch("0", 'expected 0, got text "f952ce8cf952ce8cf952ce8cf952ce8cf952ce8…"', "$[0]")] });
    expect(truncated[0]).toMatch(/text string spelling hex: almost certainly/);
    const key = hintsFor({ errors: [mismatch("0", `expected 0, got text "${"ab".repeat(28)}"`, "$[0]")] });
    expect(key[0]).toMatch(/28 bytes: a key \/ script hash/);
  });
  it("bounded_bytes: every bstr in plutus_data is bounded to 64 bytes, a definite one as a whole, a chunked one per chunk", () => {
    // inside plutus_data the head is the constr alternative: the message says what was found
    const [chunked] = hintsFor({ errors: [mismatch("tagged data #6.121([ * a0 ])", "expected tagged data #6.121([ * a0 ]), got indefinite bytes(2 chunks)", "$[0]")] });
    expect(chunked).toMatch(/chunk over 64 bytes/);
    expect(chunked).toMatch(/EACH chunk/);
    expect(chunked).toMatch(/re-chunk the value/);
    const [definite] = hintsFor({ errors: [mismatch("tagged data #6.121([ * a0 ])", `expected tagged data #6.121([ * a0 ]), got bytes 0x${"aa".repeat(16)}… (65 bytes)`, "$")] });
    expect(definite).toMatch(/longer than 64 bytes inside plutus_data: the node rejects it/);
    expect(definite).toMatch(/5f 5840/);
    // bounded_bytes itself (an era preset, or a rule naming it) names the length (definite) or the chunk (indefinite)
    const [length] = hintsFor({ era: "conway", rule: "bounded_bytes", errors: [mismatch("byte string length to be in the range 0 <= value <= 64", "expected byte string length to be in the range 0 <= value <= 64, got 65", "$")] });
    expect(length).toMatch(/longer than 64 bytes inside plutus_data/);
    const [chunk] = hintsFor({ era: "conway", errors: [mismatch("each chunk of the indefinite-length byte string to be at most 64 bytes", "expected each chunk of the indefinite-length byte string to be at most 64 bytes, got 70 bytes in chunk 0", "$")] });
    expect(chunk).toMatch(/chunk 0: 70 bytes/);
    // the same bound in a user schema is an ordinary size range (whole string); per chunk only under a rule named bounded_bytes
    const [userLength] = hintsFor({ era: null, errors: [mismatch("byte string length to be in the range 0 <= value <= 64", "expected byte string length to be in the range 0 <= value <= 64, got 65", "$")] });
    expect(userLength).toMatch(/65 bytes where 0\.\.64 are required/);
    const [userChunk] = hintsFor({ era: null, errors: [mismatch("each chunk of the indefinite-length byte string to be at most 32 bytes", "expected each chunk of the indefinite-length byte string to be at most 32 bytes, got 40 bytes in chunk 1", "$")] });
    expect(userChunk).toMatch(/Chunk 1 of an indefinite-length byte string is 40 bytes where at most 32 are allowed/);
    expect(userChunk).toMatch(/under a rule named `bounded_bytes`.*any other `\.size` measures the whole string/);
    expect(userChunk).not.toMatch(/applied to every chunk/);
    expect(hintsFor({ errors: [mismatch("bounded_bytes", "expected bounded_bytes, got bytes 0xaabb (2 bytes)", "$")] })).toEqual([]);
    expect(hintsFor({ errors: [mismatch("bstr", "expected type bstr, got indefinite bytes(2 chunks)", "$")] })).toEqual([]); // not a plutus_data rule
  });
  it("an empty array where a map or a tagged item belongs", () => {
    const [hint] = hintsFor({ errors: [mismatch("map { ? 0: nonempty_set<vkeywitness>, ? 1: nonempty_set<native_script>, … 4 more }", "expected map { ? 0: nonempty_set<vkeywitness>, … 4 more }, got array(0 items)", "$[1]")] });
    expect(hint).toMatch(/empty array \(80\) was found where the rule wants a map \(`\{\}` = a0\)/);
    expect(hint).toMatch(/compare the byte at the offset with a0/);
    const [tagged] = hintsFor({ errors: [mismatch("tagged data #6.24(bytes .cbor script)", "expected tagged data #6.24(bytes .cbor script), got array(0 items)", "$")] });
    expect(tagged).toMatch(/wants a tagged item/);
    // an empty array where an array with slots belongs is not the case
    expect(hintsFor({ errors: [mismatch("array [ int ]", "expected array with length 1, got 0", "$")] })).toEqual([]);
    // a non-empty array where a map belongs gets the container-kind hint instead
    expect(hintsFor({ errors: [mismatch("map { 0: … }", "expected map { … }, got array(2 items)", "$[1]")] })[0]).toMatch(/A map was expected but an array was found/);
  });
  it("broken embedded CBOR inside a .cbor wrapper", () => {
    const [hint] = hintsFor({ errors: [mismatch(null, "error decoding embedded CBOR: unexpected break", "$[2][1]")] });
    expect(hint).toMatch(/inside a `\.cbor` wrapper.*not well-formed CBOR: unexpected break/);
    expect(hint).toMatch(/cbor_decode\(as='raw'\)/);
  });
  it(".size, bignums, negatives, ranges", () => {
    expect(hintsFor({ errors: [mismatch("byte string of size 32 bytes", "expected byte string of size 32 bytes, got 28 bytes")] })[0]).toMatch(/28 bytes where 32 are required/);
    expect(hintsFor({ errors: [mismatch("byte string length to be in the range 28 <= value <= 32", "expected byte string length to be in the range 28 <= value <= 32, got 5")] })[0]).toMatch(/5 bytes where 28\.\.32 are required/);
    expect(hintsFor({ errors: [mismatch("text string of size 3 bytes", "expected text string of size 3 bytes, got 2 bytes")] })[0]).toMatch(/2 UTF-8 bytes where 3 are required/);
    expect(hintsFor({ errors: [mismatch("value .size 2", "expected value .size 2, got 65536")] })[0]).toMatch(/65536 does not fit 2 byte\(s\)/);
    expect(hintsFor({ errors: [mismatch("uint", "expected type uint, got #6.2(bytes 0x0002a515 (4 bytes))")] })[0]).toMatch(/bignum \(tag 2 \/ 3\)/);
    expect(hintsFor({ errors: [mismatch("uint", "expected type uint, got -1")] })[0]).toMatch(/negative integer/);
    expect(hintsFor({ errors: [mismatch("integer to be in range -9223372036854775808 <= value <= 9223372036854775807", "expected integer to be in range …, got 18446744073709551615")] })[0]).toMatch(/outside the range/);
  });
  it("unexpected / missing keys name the key and the era", () => {
    const [unexpected] = hintsFor({ errors: [mismatch(null, "unexpected key 19", "$[0]")], era: "babbage" });
    expect(unexpected).toMatch(/Key 19 is not allowed.*babbage schema/);
    const [missing] = hintsFor({ errors: [mismatch(null, "map missing key: 2", "$[0]", "generic")] });
    expect(missing).toMatch(/Required map key 2 is missing/);
  });
  it("an unexpected key gets the hint of its kind: era keys are integers, a redeemer key is [tag, index], anything else is misplaced", () => {
    // Conway map-form redeemers are checked entry by entry: only a bad [tag, index] lands on `unexpected key`
    const redeemer = { ...mismatch(null, "unexpected key [9, 0]", "$[1][5][[9, 0]]"), cddl_fragment: "redeemers" };
    const [bad] = hintsFor({ errors: [redeemer], era: "conway" });
    expect(bad).toMatch(/^Redeemer key \[9, 0\] is not a valid \[tag, index\]: tag 0 spend, .* 5 proposing/);
    expect(bad).toMatch(/the map form itself is fine/);
    expect(hintsFor({ errors: [{ ...redeemer, cddl_fragment: null }], era: "conway" })[0]).toMatch(/^Redeemer key/); // the witness-set path alone says so
    // a composite key elsewhere, or a text key: no era advice
    for (const message of ["unexpected key [1, 2]", 'unexpected key "a b"', "unexpected key h'0102'"]) {
      const [hint] = hintsFor({ errors: [mismatch(null, message, "$[0]")], era: "conway" });
      expect(hint, message).toMatch(/is not allowed in this map by the rule of the conway schema: no entry of the map's rule/);
      expect(hint, message).not.toMatch(/newer eras add keys/);
    }
    expect(hintsFor({ errors: [mismatch(null, "unexpected key -1", "$[0]")] })[0]).toMatch(/newer eras add keys/);
  });
  it("Conway map-form redeemers on an older preset are named as such; under Conway the array sibling adds no container hint", () => {
    const row = mismatch("array [ * redeemer ]", "expected array [ * redeemer ], got map(2 entries)", "$[5]");
    const [babbage] = hintsFor({ errors: [row], era: "babbage" });
    expect(babbage).toMatch(/Redeemers in the Conway map form .* validate with cddl='conway'/);
    expect(babbage).not.toMatch(/post-Alonzo output map/);
    const conwaySibling = mismatch("array [ + redeemer ]", "expected array [ + redeemer ], got map(2 entries)", "$[5]");
    expect(hintsFor({ errors: [mismatch(null, "unexpected key [9, 0]", "$[5][[9, 0]]"), conwaySibling], era: "conway" }).join("\n")).not.toMatch(/cddl='conway'|post-Alonzo output map/);
    // other array-vs-map mismatches keep the general hint
    expect(hintsFor({ errors: [mismatch("array [ address, amount: value ]", "expected array [ address, amount: value ], got map(3 entries)", "$[0][1][0]")], era: "alonzo" })[0]).toMatch(/post-Alonzo output map/);
  });
  it("a metadatum string over 64 bytes, chunked or not, is explained as the whole-string bound", () => {
    const expected = "map { * metadatum => metadatum }";
    for (const got of ["indefinite bytes(2 chunks)", `bytes 0x${"ab".repeat(16)}… (100 bytes)`, 'text "hello hello hello…"']) {
      const hints = hintsFor({ era: "conway", rule: "metadata", errors: [mismatch(expected, `expected ${expected}, got ${got}`, "$[1]")] });
      expect(hints.some((h) => /metadatum byte \/ text string holds at most 64 bytes in total/.test(h) && /counts all its chunks together/.test(h)), got).toBe(true);
      expect(hints.join("\n"), got).not.toMatch(/chunk over 64 bytes/); // not the per-chunk plutus_data rule
    }
    // a short byte string cannot fail a metadatum: no hint
    expect(hintsFor({ errors: [mismatch(expected, `expected ${expected}, got bytes 0xabcd (2 bytes)`, "$[1]")] })).toEqual([]);
  });
  it("rule-level kinds", () => {
    expect(hintsFor({ errors: [mismatch(null, "m", null, "missing_rule")] })[0]).toMatch(/not declared by the schema/);
    expect(hintsFor({ errors: [mismatch(null, "m", null, "group_rule_root")] })[0]).toMatch(/group/);
    expect(hintsFor({ errors: [mismatch(null, "m", null, "validation_too_complex")] })[0]).toMatch(/implementation limit/);
    expect(hintsFor({ errors: [mismatch(null, "m", null, "unresolved_references")] })[0]).toMatch(/cddl_check/);
  });
});

describe("hints: oddities, probes, candidate search", () => {
  it("one hint per oddity kind, whatever the verdict", () => {
    const hints = hintsFor({ oddities: [{ kind: "MapKeysNotSorted" }, { kind: "MapKeysNotSorted" }, { kind: "DuplicateMapKeys" }, { kind: "BignumForSmallInt" }, { kind: "BignumLeadingZeroes" }, { kind: "IntNotShortest" }, { kind: "IndefiniteLength" }] });
    expect(hints).toHaveLength(6);
    expect(hints[0]).toMatch(/canonical order/);
    expect(hints[1]).toMatch(/Duplicate map keys/);
    expect(hints[2]).toMatch(/bignum wraps a value that fits/);
    expect(hints[3]).toMatch(/leading zero bytes/);
    expect(hints[4]).toMatch(/shortest form/);
    expect(hints[5]).toMatch(/Indefinite-length items/);
  });
  it("double-wrapped scripts", () => {
    expect(looksDoubleWrappedScript("581e010000332233" + "00".repeat(24))).toBe(true);
    expect(looksDoubleWrappedScript("5901ab01000033")).toBe(true);
    expect(looksDoubleWrappedScript("010000332233")).toBe(false); // single wrap: fine
    expect(looksDoubleWrappedScript("d8799f")).toBe(false);
    const hints = hintsFor({ byteStrings: ["aa", "581e010000332233" + "00".repeat(24)] });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/double-wrapped/);
  });
  it("candidate search outcomes", () => {
    expect(hintsFor({ candidates: { tried: 0, anyValid: false }, rootKind: "float" })[0]).toMatch(/No root rule of the schema accepts a float/);
    expect(hintsFor({ candidates: { tried: 5, anyValid: false }, errors: [mismatch("map", "expected map, got array(4 items)", "$")] })).toEqual(expect.arrayContaining([expect.stringMatching(/None of the 5 candidate roots/)]));
    expect(hintsFor({ candidates: { tried: 3, anyValid: false }, errors: [mismatch("uint", "expected uint, got text", "$[2]")] }).some((h) => /candidate roots/.test(h))).toBe(false);
    expect(hintsFor({ candidates: { tried: 1, anyValid: true }, rootKind: "bytes" })[0]).toMatch(/bare byte string/);
    // a content fault at the root (right kind, missing slot) is not a refusal of the root item
    expect(hintsFor({ candidates: { tried: 4, anyValid: false }, errors: [mismatch("array [ transaction_body, … ]", "expected array with length 4, got 3", "$")] }).some((h) => /candidate roots/.test(h))).toBe(false);
  });
  it("from_type_choice siblings never speak about the root or the container kind", () => {
    // head: a 27-byte owner where 28 are required; sibling: what the other alternative (#6.122([])) wanted, at the root
    const head = mismatch("byte string of size 28 bytes", "expected byte string of size 28 bytes, got 27 bytes", "$[0]");
    const sibling: HintError = { ...mismatch("tagged data #6.122([])", "expected tagged data #6.122([]), got #6.121(array(2 items))", "$"), from_type_choice: true };
    const hints = hintsFor({ errors: [head, sibling], candidates: { tried: 1, anyValid: false } });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/27 bytes where 28 are required/);
    // a Babbage output map whose inline datum is broken: the alonzo (array) alternative at `$` is not a "root is a map" verdict
    const datumHead = mismatch("value 0", "expected value 0, got 1", "$[2][0]");
    const arrayAlternative: HintError = { ...mismatch("array [ address, amount: value, ? datum_hash: hash32 ]", "expected array [ address, amount: value, ? datum_hash: hash32 ], got map(3 entries)", "$"), from_type_choice: true };
    const embedded: HintError = { ...mismatch(null, "error decoding embedded CBOR: unexpected break", "$[2][1]"), from_type_choice: true };
    const output = hintsFor({ errors: [datumHead, arrayAlternative, embedded], rule: "transaction_output" });
    expect(output.some((h) => /root item is a map/.test(h))).toBe(false);
    expect(output.some((h) => /None of the/.test(h))).toBe(false);
    // the same sibling as the head row (a folded choice) keeps its hints: tag 1280 at the root
    const folded: HintError = { ...mismatch("tagged data #6.121([ * a0 ])", "expected tagged data #6.121([ * a0 ]), got #6.1280(array(0 items))", "$"), from_type_choice: true };
    expect(hintsFor({ errors: [folded] })[0]).toMatch(/over-approximation/);
    // a non-head row that is not a choice sibling still contributes (a second unexpected key)
    expect(hintsFor({ errors: [mismatch(null, "unexpected key 19", "$[0]"), mismatch("map { … }", "expected map { … }, got array(2 items)", "$[0][1][0]")] })).toHaveLength(2);
  });
  it("deduplicates and caps at MAX_HINTS", () => {
    const errors = Array.from({ length: 20 }, (_, i) => mismatch(null, `unexpected key ${i}`, "$[0]"));
    const hints = hintsFor({ errors, oddities: [{ kind: "IntNotShortest" }, { kind: "IndefiniteLength" }] });
    expect(hints.length).toBeLessThanOrEqual(MAX_HINTS);
    expect(new Set(hints).size).toBe(hints.length);
    const same = hintsFor({ errors: [mismatch(null, "unexpected key 1", "$[0]"), mismatch(null, "unexpected key 1", "$[1]")] });
    expect(same).toHaveLength(1);
  });
  it("nothing to say for a clean valid run", () => {
    expect(hintsFor({ errors: [], oddities: [], candidates: { tried: 1, anyValid: true }, rootKind: "array" })).toEqual([]);
    expect(hintsFor({})).toEqual([]);
  });
});
