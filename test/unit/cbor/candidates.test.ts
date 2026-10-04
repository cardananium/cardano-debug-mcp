import { describe, expect, it } from "vitest";

import { blamedSpans, CANDIDATE_CAP, candidateScore, isRootKindRefusal, orderCandidates, outcomeOf, pathDepth, pickBestCandidate, PERMISSIVE_RULES, PREFERRED_ROOTS, SCORE_TIER, unmatchedBytes } from "../../../src/cbor/candidates.js";
import { reportOf } from "../../../src/cbor/validate.js";

describe("orderCandidates", () => {
  it("puts the preferred roots first in preference order, then the rest in declaration order, capped", () => {
    const declared = ["block_number", "plutus_data", "certificate", "transaction", "vrf_cert", "transaction_body"];
    expect(orderCandidates(declared)).toEqual(["transaction", "transaction_body", "plutus_data", "certificate", "block_number", "vrf_cert"]);
    expect(orderCandidates(declared, 3)).toEqual(["transaction", "transaction_body", "plutus_data"]);
    expect(orderCandidates(["x", "x", "y"], 5, [])).toEqual(["x", "y"]);
    expect(orderCandidates([], 5)).toEqual([]);
    expect(orderCandidates(["a"], 0)).toEqual([]);
  });
  it("PREFERRED_ROOTS leads with the whole-object rules and has no duplicates", () => {
    expect(PREFERRED_ROOTS.slice(0, 5)).toEqual(["transaction", "transaction_body", "transaction_witness_set", "transaction_output", "plutus_data"]);
    expect(new Set(PREFERRED_ROOTS).size).toBe(PREFERRED_ROOTS.length);
    expect(CANDIDATE_CAP).toBe(12);
  });
});

describe("pathDepth", () => {
  it("counts segments of a validator path", () => {
    expect(pathDepth("$")).toBe(0);
    expect(pathDepth("$[0]")).toBe(1);
    expect(pathDepth("$[0][2]")).toBe(2);
    expect(pathDepth("$.a[1].b")).toBe(3);
    expect(pathDepth(null)).toBe(-1);
    expect(pathDepth("")).toBe(-1);
  });
});

describe("unmatchedBytes", () => {
  it("unions anchor spans of mismatches and key spans of key problems", () => {
    const error = {
      kind: "mismatch",
      message: "expected array, got #6.258(array(1 items))",
      byte_spans: [{ offset: 44, length: 3 }],
      anchor_spans: [{ offset: 44, length: 73 }],
      additional: [
        // an unexpected key: the validator's spans are the key and the value (header / whole) — the entry is blamed
        { kind: "mismatch", path: "$[0][19]", message: "unexpected key 19", byte_spans: [{ offset: 120, length: 1 }, { offset: 121, length: 1 }], anchor_spans: [{ offset: 120, length: 1 }, { offset: 121, length: 73 }] },
        { kind: "mismatch", message: "expected uint, got text", byte_spans: [{ offset: 50, length: 1 }], anchor_spans: [{ offset: 50, length: 10 }] }, // inside the first anchor
      ],
    };
    expect(unmatchedBytes(error)).toBe(73 + 74);
    expect(unmatchedBytes({ kind: "generic", message: "map missing key: 2", byte_spans: [{ offset: 1, length: 1 }] })).toBe(1);
    // a wrong slot count blames the header, not the whole array the rule otherwise accepted
    expect(unmatchedBytes({ kind: "mismatch", message: "expected array with length 4, got 3", byte_spans: [{ offset: 0, length: 1 }], anchor_spans: [{ offset: 0, length: 196 }] })).toBe(1);
    expect(unmatchedBytes({ kind: "mismatch", message: "x" })).toBe(0);
  });
  it("an unexpected key blames its whole entry (key + value); the positional tree fills in a missing value span", () => {
    // a body map at byte 1 whose key 19 (`13`) sits at byte 120 with a 73-byte map value at 121
    const tree = { type: "Array", values: [{ type: "Map", struct_position_info: { offset: 1, length: 193 }, values: [{ key: { type: "U8", value: 19, position_info: { offset: 120, length: 1 } }, value: { type: "Map", position_info: { offset: 121, length: 1 }, struct_position_info: { offset: 121, length: 73 } } }] }] };
    const full = { kind: "mismatch", path: "$[0][19]", message: "unexpected key 19", byte_spans: [{ offset: 120, length: 1 }, { offset: 121, length: 1 }], anchor_spans: [{ offset: 120, length: 1 }, { offset: 121, length: 73 }] };
    expect(blamedSpans(full)).toEqual([{ offset: 120, length: 74 }]);
    const keyOnly = { kind: "mismatch", path: "$[0][19]", message: "unexpected key 19", byte_spans: [{ offset: 120, length: 1 }] };
    expect(blamedSpans(keyOnly)).toEqual([{ offset: 120, length: 1 }]);
    expect(blamedSpans(keyOnly, tree)).toEqual([{ offset: 120, length: 74 }]);
    expect(unmatchedBytes(keyOnly, tree)).toBe(74);
    expect(unmatchedBytes({ ...keyOnly, path: "$[0][20]", message: "unexpected key 20" }, tree)).toBe(1); // not in the tree: the key stays
    const outcome = outcomeOf("transaction", { valid: false, error: full });
    expect(outcome).toMatchObject({ unmatched_bytes: 74, head_bytes: 74, head: { path: "$[0][19]" } });
  });
});

describe("outcomeOf / pickBestCandidate", () => {
  const valid = outcomeOf("transaction", { valid: true });
  const rootRefusal = outcomeOf("block", { valid: false, error: { kind: "mismatch", path: "$", message: "expected array [ header, … ], got map(3 entries)", anchor_spans: [{ offset: 0, length: 500 }] } });
  const shallow = outcomeOf("transaction_body", {
    valid: false,
    error: { kind: "mismatch", path: "$[2]", message: "expected type uint, got text", anchor_spans: [{ offset: 20, length: 5 }], additional: [{ kind: "generic", path: "$", message: "map missing key: 0", byte_spans: [{ offset: 0, length: 1 }] }] },
  });
  const permissive = outcomeOf("plutus_data", {
    valid: false,
    error: { kind: "mismatch", path: "$[1][0][2][1]", message: "expected tagged data #6.121, got #6.24(bytes)", anchor_spans: [{ offset: 0, length: 500 }], additional: Array.from({ length: 16 }, (_, i) => ({ kind: "mismatch", path: `$[1][${i}]`, message: "x", anchor_spans: [{ offset: 30 + i, length: 40 }] })), additional_truncated: 3 },
  });
  const unexamined = outcomeOf("deep", { valid: false, error: { kind: "nesting_too_deep", path: "$[0]", message: "limit" } });
  const schemaFault = outcomeOf("odd", { valid: false, error: { kind: "invalid_schema", message: "operand" } });

  it("shapes outcomes with problem counts and unmatched bytes", () => {
    expect(valid).toEqual({ rule: "transaction", valid: true });
    expect(shallow).toMatchObject({ rule: "transaction_body", valid: false, head: { kind: "mismatch", path: "$[2]" }, problems: 2, unmatched_bytes: 6 });
    expect(permissive.problems).toBe(1 + 16 + 3);
    expect(permissive.unmatched_bytes).toBe(500);
    expect(unexamined.unexamined).toBe(true);
    expect(outcomeOf("r", undefined).head).toEqual({ kind: "generic", path: null, message: "" });
  });
  it("a valid outcome wins outright", () => {
    expect(pickBestCandidate([rootRefusal, shallow, valid, permissive])).toBe(valid);
  });
  it("root refusals and schema faults rank below any run that got inside", () => {
    expect(pickBestCandidate([rootRefusal, shallow])).toBe(shallow);
    expect(pickBestCandidate([schemaFault, rootRefusal])).toBe(rootRefusal);
    expect(candidateScore(unexamined)[0]).toBeLessThan(candidateScore(schemaFault)[0]);
  });
  it("with nothing valid, a run stopped at an implementation limit is the one reported: no failed run rules it out", () => {
    // a deep script_ref: `transaction` stops at the nesting limit, `block` fails at its head — the answer is "not examined", not "not a block"
    expect(pickBestCandidate([unexamined, schemaFault, rootRefusal, shallow, permissive])).toBe(unexamined);
    expect(pickBestCandidate([rootRefusal, unexamined])).toBe(unexamined);
    // a valid run still wins outright
    expect(pickBestCandidate([unexamined, valid])).toBe(valid);
  });
  it("among runs that got inside, the fewest unmatched bytes win over the deepest head", () => {
    expect(pickBestCandidate([permissive, shallow])).toBe(shallow);
    const deeper = outcomeOf("redeemer", { valid: false, error: { kind: "mismatch", path: "$[2][0]", message: "x", anchor_spans: [{ offset: 20, length: 6 }] } });
    // same unmatched bytes (6): the deeper head wins
    expect(pickBestCandidate([shallow, deeper])).toBe(deeper);
    // ties keep trial order
    expect(pickBestCandidate([deeper, { ...deeper, rule: "later" }])).toBe(deeper);
  });
  it("answers undefined for no outcomes and the only outcome otherwise", () => {
    expect(pickBestCandidate([])).toBeUndefined();
    expect(pickBestCandidate([rootRefusal])).toBe(rootRefusal);
  });
  it("keeps a composite key's diagnostic notation in the head path and counts its depth", () => {
    const composite = outcomeOf("metadata", { valid: false, error: { kind: "mismatch", path: "$[19][[2, h'2cc1']][[h'd52a', 0]][1]", message: "expected map, got null" } });
    expect(composite.head!.path).toBe("$[19][[2, h'2cc1']][[h'd52a', 0]][1]");
    expect(pathDepth(composite.head!.path)).toBe(4);
    expect(pathDepth("$[{1: 2}].a")).toBe(2);
  });
});

describe("root content faults rank as runs that got inside", () => {
  // transaction_body against a body without its fee (key 2): the rule accepted the map, one key is missing
  const bodyNoFee = outcomeOf("transaction_body", { valid: false, error: { kind: "generic", path: "$", message: "map missing key: 2", byte_spans: [{ offset: 0, length: 1 }], anchor_spans: [{ offset: 0, length: 187 }] } });
  // metadata got one level deeper but accounts for far fewer bytes
  const metadata = outcomeOf("metadata", { valid: false, error: { kind: "mismatch", path: "$[0]", message: "expected map { * metadatum => metadatum }, got #6.258(array(1 items))", byte_spans: [{ offset: 2, length: 3 }], anchor_spans: [{ offset: 2, length: 40 }] } });
  // transaction against a 3-element array: right kind, wrong slot count
  const threeSlots = outcomeOf("transaction", { valid: false, error: { kind: "mismatch", path: "$", message: "expected array with length 4, got 3", byte_spans: [{ offset: 0, length: 1 }], anchor_spans: [{ offset: 0, length: 196 }] } });
  const plutusData = outcomeOf("plutus_data", {
    valid: false,
    error: { kind: "mismatch", path: "$[0][19][1]", message: "expected tagged data #6.121([ * a0 ]), got null", additional: Array.from({ length: 7 }, (_, i) => ({ kind: "mismatch", path: `$[0][${i}]`, message: "x", anchor_spans: [{ offset: 2 + 20 * i, length: 18 }] })) },
  });
  const wrongKind = outcomeOf("block", { valid: false, error: { kind: "mismatch", path: "$", message: "expected array [ header, … ], got map(3 entries)", anchor_spans: [{ offset: 0, length: 187 }] } });

  it("distinguishes a kind refusal at the root from a content fault at the root, and tiers the outcomes", () => {
    expect(isRootKindRefusal(wrongKind)).toBe(true);
    expect(isRootKindRefusal(bodyNoFee)).toBe(false);
    expect(isRootKindRefusal(threeSlots)).toBe(false);
    expect(isRootKindRefusal(metadata)).toBe(false);
    expect(isRootKindRefusal(outcomeOf("x", { valid: true }))).toBe(false);
    expect(candidateScore(wrongKind)[0]).toBe(SCORE_TIER.rootKind);
    expect(candidateScore(bodyNoFee)).toEqual([SCORE_TIER.inside, -1, 0, -1]); // a missing key: the present keys were examined
    expect(candidateScore(threeSlots)).toEqual([SCORE_TIER.rootSlotCount, -1, 0, -1]); // the slots were not examined
    expect(candidateScore(metadata)[0]).toBe(SCORE_TIER.permissive);
    expect(candidateScore(plutusData)[0]).toBe(SCORE_TIER.permissive);
    expect(PERMISSIVE_RULES.has("plutus_data")).toBe(true);
    expect(PERMISSIVE_RULES.has("transaction_body")).toBe(false);
  });
  it("a body without its fee is diagnosed as transaction_body, not metadata", () => {
    expect(pickBestCandidate([bodyNoFee, metadata, wrongKind])).toBe(bodyNoFee);
    expect(pickBestCandidate([metadata, bodyNoFee])).toBe(bodyNoFee);
  });
  it("a 3-element transaction array is diagnosed as transaction, not plutus_data nor a shallow certificate fit", () => {
    expect(pickBestCandidate([threeSlots, plutusData])).toBe(threeSlots);
    expect(pickBestCandidate([plutusData, threeSlots, wrongKind])).toBe(threeSlots);
    // certificate = [0, credential]: it gets inside at $[0] but blames the whole body (193 of 196 bytes)
    const certificate = outcomeOf("certificate", { valid: false, error: { kind: "mismatch", path: "$[0]", message: "expected value 0, got map(4 entries)", byte_spans: [{ offset: 1, length: 1 }], anchor_spans: [{ offset: 1, length: 193 }] } });
    expect(candidateScore(certificate, 196)[0]).toBe(SCORE_TIER.insideWeak);
    expect(candidateScore(certificate)[0]).toBe(SCORE_TIER.inside); // unknown input size: no share to judge
    expect(pickBestCandidate([certificate, threeSlots, plutusData], 196)).toBe(threeSlots);
    expect(pickBestCandidate([certificate, plutusData], 196)).toBe(certificate);
    // a scalar mismatch stays a strong fit however large the item: [text(64 hex digits), 0] as a transaction_input
    const hexAsText = outcomeOf("transaction_input", { valid: false, error: { kind: "mismatch", path: "$[0]", message: 'expected type bstr, got text "f952ce8c…"', byte_spans: [{ offset: 1, length: 66 }], anchor_spans: [{ offset: 1, length: 66 }] } });
    const twoSlots = outcomeOf("transaction", { valid: false, error: { kind: "mismatch", path: "$", message: "expected array with length 4, got 2", byte_spans: [{ offset: 0, length: 1 }], anchor_spans: [{ offset: 0, length: 68 }] } });
    expect(candidateScore(hexAsText, 68)[0]).toBe(SCORE_TIER.inside);
    expect(pickBestCandidate([twoSlots, hexAsText], 68)).toBe(hexAsText);
  });
  it("a rule that got inside beats a wrong slot count at the root (tag-258-wrapped outputs: transaction, not block)", () => {
    const transaction = outcomeOf("transaction", { valid: false, error: { kind: "mismatch", path: "$[0][1]", message: "expected array [ * transaction_output ], got #6.258(array(1 items))", byte_spans: [{ offset: 44, length: 3 }], anchor_spans: [{ offset: 44, length: 73 }] } });
    const block = outcomeOf("block", { valid: false, error: { kind: "mismatch", path: "$", message: "expected array with length 5, got 4", byte_spans: [{ offset: 0, length: 1 }], anchor_spans: [{ offset: 0, length: 200 }] } });
    expect(pickBestCandidate([transaction, block, plutusData], 200)).toBe(transaction);
    expect(candidateScore(transaction, 200)[0]).toBe(SCORE_TIER.inside); // 73 of 200 bytes unmatched: a strong fit
    expect(pickBestCandidate([block, plutusData], 200)).toBe(block);
  });
  it("a kind refusal at the root still loses to any other data failure", () => {
    expect(pickBestCandidate([wrongKind, metadata])).toBe(metadata);
    expect(pickBestCandidate([wrongKind, plutusData])).toBe(plutusData);
    expect(pickBestCandidate([wrongKind, threeSlots])).toBe(threeSlots);
  });
});

describe("reportOf", () => {
  it("abbreviates the head path: a path through a deep document runs to tens of thousands of segments", () => {
    const path = "$" + "[0][1]".repeat(10_000);
    const report = reportOf(outcomeOf("transaction", { valid: false, error: { kind: "nesting_too_deep", path, message: "limit" } }));
    expect(report.unexamined).toBe(true);
    expect(report.head_path!.length).toBeLessThan(200);
    expect(report.head_path).toMatch(/… \(20,00[01] segments\) …/);
    expect(reportOf(outcomeOf("x", { valid: false, error: { kind: "mismatch", path: "$[0][1]", message: "m" } })).head_path).toBe("$[0][1]");
  });
});
