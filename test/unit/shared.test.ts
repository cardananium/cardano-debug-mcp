import { describe, expect, it } from "vitest";

import {
  capJson,
  capString,
  fail,
  failFromError,
  isNestingRefusal,
  libDecodeReason,
  nestingRefusalBound,
  nestingRefusalExemptsNativeScripts,
  nestingRefusalLimit,
  lookupPath,
  normalizeBytesInput,
  normalizeContextPath,
  ok,
  pageOf,
  parsePath,
  pruneDepth,
  resourceLink,
  truncateArray,
  TX_DECODE_NEXT_STEPS,
  TxDecodeError,
} from "../../src/tools/_shared.js";
import { WorkerCallError } from "../../src/workers/rpc.js";
import { fxStr } from "../helpers/fixtures.js";

describe("_shared", () => {
  it("normalizeContextPath: the tx_info language key is optional; root keys and explicit paths pass through", () => {
    const context = { script_context_version: "V1V2", tx_info: { V2: { inputs: [1], fee: 2 } }, purpose: { purpose_type: "Spending" } };
    expect(normalizeContextPath(context, ["tx_info", "inputs", "0"])).toEqual(["tx_info", "V2", "inputs", "0"]);
    expect(normalizeContextPath(context, ["inputs", "0"])).toEqual(["tx_info", "V2", "inputs", "0"]);
    expect(normalizeContextPath(context, ["tx_info", "V2", "fee"])).toEqual(["tx_info", "V2", "fee"]);
    expect(normalizeContextPath(context, ["tx_info"])).toEqual(["tx_info"]);
    expect(normalizeContextPath(context, ["purpose", "purpose_type"])).toEqual(["purpose", "purpose_type"]);
    expect(normalizeContextPath(context, [])).toEqual([]);
    expect(normalizeContextPath(context, ["nope"])).toEqual(["nope"]); // unknown: left for lookupPath to report
    const v3 = { script_context_version: "V3", tx_info: { V3: { votes: [] } }, redeemer: {}, purpose: {} };
    expect(normalizeContextPath(v3, ["votes"])).toEqual(["tx_info", "V3", "votes"]);
    expect(normalizeContextPath(v3, ["redeemer"])).toEqual(["redeemer"]);
    expect(normalizeContextPath({ no_tx_info: true }, ["a", "b"])).toEqual(["a", "b"]);
  });
  it("ok/fail keep text == structuredContent; links are listed once, in `resources` (no resource_link blocks)", () => {
    const result = ok({ a: 1n, b: "x" }, { links: [resourceLink("cardano-debug://x", "x", "text/plain")] });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }]);
    expect(result.structuredContent).toEqual({ a: 1, b: "x", resources: [{ uri: "cardano-debug://x", name: "x", mimeType: "text/plain" }] });
    const failure = fail({ code: "nope", message: "m" });
    expect(failure.isError).toBe(true);
    expect(JSON.parse((failure.content[0] as { text: string }).text)).toEqual({ code: "nope", message: "m" });
  });
  it("truncateArray / capString / pageOf", () => {
    expect(truncateArray([1, 2, 3], 2)).toEqual({ items: [1, 2], truncated_count: 1 });
    expect(capString("hello world", 8).endsWith("[truncated]")).toBe(true);
    expect(capString("short", 8)).toBe("short");
    const page = pageOf([1, 2, 3, 4, 5], 1, 2);
    expect(page).toEqual({ rows: [2, 3], total: 5, offset: 1, limit: 2, next_offset: 3, truncated: true });
    expect(pageOf([1], 0, 5).next_offset).toBeUndefined();
  });
  it("pruneDepth summarises deep nodes", () => {
    const value = { a: { b: { c: { d: 1 } }, list: [1, 2, 3] }, big: 2n ** 70n };
    expect(pruneDepth(value, 2)).toEqual({ a: { b: "{… 1 key: c}", list: "[… 3 items]" }, big: (2n ** 70n).toString() });
    expect(pruneDepth(value, 1)).toEqual({ a: "{… 2 keys: b, list}", big: (2n ** 70n).toString() });
  });
  it("capJson shrinks depth then text", () => {
    const wide = { items: Array.from({ length: 200 }, (_, i) => ({ i, nested: { deep: { deeper: "x".repeat(20) } } })) };
    const capped = capJson(wide, 2_000, 6);
    expect(JSON.stringify(capped.value).length).toBeLessThanOrEqual(2_000);
    expect(capped.truncated).toBe(true);
  });
  it("parsePath / lookupPath", () => {
    expect(parsePath("/a/b/0")).toEqual(["a", "b", "0"]);
    expect(parsePath("a.b.0")).toEqual(["a", "b", "0"]);
    expect(parsePath(undefined)).toEqual([]);
    const root = { a: { b: [10, 20] } };
    expect(lookupPath(root, ["a", "b", "1"])).toEqual({ found: true, value: 20, resolved: ["a", "b", "1"] });
    const miss = lookupPath(root, ["a", "x"]);
    expect(miss.found).toBe(false);
    expect(miss.available).toEqual(["b"]);
  });
  it("normalizeBytesInput", () => {
    expect(normalizeBytesInput(" 0xD879 9F41 aa02ff ")).toEqual({ value: "d8799f41aa02ff", kind: "hex" });
    expect(normalizeBytesInput(Buffer.from("d8799f41aa02ff", "hex").toString("base64"))).toEqual({ value: "d8799f41aa02ff", kind: "base64" });
    expect(normalizeBytesInput('{"type":"Tx","cborHex":"84a0"}')).toEqual({ value: "84a0", kind: "cli_envelope" });
    expect(normalizeBytesInput(fxStr("s11.scriptAddress")).kind).toBe("bech32");
    expect(normalizeBytesInput("hello world!").kind).toBe("text");
    expect(normalizeBytesInput("d8799f41aa02f").kind).toBe("text"); // odd-length hex is a broken hex string, not base64
    expect(normalizeBytesInput("abc").kind).toBe("text");
  });

  it("libDecodeReason strips the library's `Failed to decode …: JsValue(\"…\")` wrapper and keeps the reason", () => {
    const wrapped = 'Failed to decode Transaction: JsValue("Deserialization failed in Transaction because: Invalid cbor: not the right type, expected `Array\' byte received `Tag\'.")';
    expect(libDecodeReason(wrapped)).toBe("at Transaction because: Invalid cbor: not the right type, expected `Array' byte received `Tag'");
    expect(libDecodeReason('Failed to decode Transaction: JsValue("Deserialization failed in Transaction.body.TransactionBody.fee because: Invalid cbor: I/O error")')).toBe(
      "at Transaction.body.TransactionBody.fee because: Invalid cbor: I/O error",
    );
    expect(libDecodeReason("plain reason")).toBe("plain reason");
    expect(libDecodeReason("Failed to decode Address: JsValue(SomeError)")).toBe("SomeError");
    expect(libDecodeReason("x".repeat(1000)).length).toBeLessThanOrEqual(400);
  });

  it("TxDecodeError -> decode_failed with the reason, the library message and the cbor_validate suggestion first", () => {
    const error = new TxDecodeError('Failed to decode Transaction: JsValue("Deserialization failed in Transaction because: Invalid cbor: not the right type, expected `Array\' byte received `Map\'.")', 4);
    const result = failFromError(error);
    expect(result.isError).toBe(true);
    const body = result.structuredContent as { code: string; message: string; argument: string; lib_message: string; input_bytes: number; next: string[] };
    expect(body.code).toBe("decode_failed");
    expect(body.argument).toBe("tx_cbor");
    expect(body.input_bytes).toBe(4);
    expect(body.message).toMatch(/^The bytes did not decode as a Cardano transaction \(at Transaction because: Invalid cbor: not the right type, expected `Array' byte received `Map'\)\. Run cbor_validate\(hex=<the same bytes>, rule='transaction'\)/);
    expect(body.message).toContain("cbor_decode(hex, as='auto')");
    expect(body.lib_message).toMatch(/^Failed to decode Transaction/);
    expect(body.next).toEqual([...TX_DECODE_NEXT_STEPS]);
    expect(body.next[0]).toMatch(/^cbor_validate\(hex=<the same bytes>, rule='transaction'\)/);
    expect(JSON.parse(result.content[0]!.type === "text" ? result.content[0]!.text : "")).toEqual(body);
    // the argument follows the input the bytes came from
    expect((failFromError(new TxDecodeError("nope", 9, "tx_hash")).structuredContent as { argument: string }).argument).toBe("tx_hash");
  });

  it("the library's nesting refusal is unexamined (refused, not invalid), a trap or another library error is not", () => {
    // [message, the bound the answer names, how the answer names it]
    const messages: Array<[string, number, string]> = [
      ["CBOR nesting is deeper than the supported limit of 64 levels for typed decoding", 64, "the typed-decoding bound"],
      ["Invalid plutus data found: Unsupported CBOR content: CBOR nesting is deeper than the supported limit of 64 levels for typed decoding (kind: nesting_too_deep)", 64, "the typed-decoding bound"],
      ["Failed to get necessary data: CBOR nesting is deeper than the supported limit of 128 levels for decoding by the serialization library", 128, "the serialization-library bound"],
      // a validation-context UTxO's inline datum is read only by pallas and the script evaluator
      ["Invalid plutus data found: Unsupported CBOR content: CBOR nesting is deeper than the supported limit of 128 levels for decoding by pallas and the Plutus evaluator (kind: nesting_too_deep)", 128, "the pallas / Plutus evaluator bound"],
      ["CBOR nesting is deeper than the supported limit of 32768 levels", 32768, "the CBOR / CDDL walkers' bound"],
      ["Failed to parse transaction: Unsupported CBOR content: … (kind: nesting_too_deep)", 64, "the typed-decoding bound"],
    ];
    // the three decoder bounds as the library states them now: native scripts exempt
    const EXEMPT = "; native scripts do not count toward it and may nest up to 32768 levels";
    for (const [message, limit, named] of messages.slice(0, 4)) messages.push([message.replace(/ \(kind: nesting_too_deep\)$/, "") + EXEMPT, limit, named]);
    for (const [message, limit, named] of messages) {
      expect(isNestingRefusal(message), message).toBe(true);
      expect(nestingRefusalLimit(message), message).toBe(limit);
      const body = failFromError(new WorkerCallError({ name: "Error", message, fatal: false })).structuredContent as { code: string; message: string; refusal: string; limit: number };
      expect(body.code, message).toBe("unexamined");
      expect(body.limit, message).toBe(limit);
      expect(body.message).toContain("at most 64 levels for typed decoding");
      expect(body.message).toContain("128 for decoding by the serialization library");
      expect(body.message).toContain("128 for decoding by pallas and the Plutus evaluator");
      expect(body.message).toContain("follow 32768");
      expect(body.message).toContain("levels inside native scripts count toward none of these, so native scripts may nest up to 32768 levels");
      // the server's own words name the bound the refusal states, in the library's terms
      expect(body.message).toContain(`This refusal is ${named}.`);
      expect(body.message).not.toMatch(/\b(256|512|16384)\b/);
      expect(body.refusal).toBe(message);
      expect(body.message).toMatch(/^Refused, not invalid: /);
      expect(body.message).toMatch(/inline datum or script_ref \(tag 24\) counts at the depth it is embedded at/);
      expect(body.message).toContain("cbor_validate(hex)");
    }
    expect(isNestingRefusal("Deserialization failed in Transaction because: Invalid cbor")).toBe(false);
    // the native-script clause names 32768 but the refusal is still the decoder's own bound
    expect(nestingRefusalBound("CBOR nesting is deeper than the supported limit of 128 levels for decoding by the serialization library" + EXEMPT)).toBe("serialization_library");
    expect(nestingRefusalExemptsNativeScripts(messages[0]![0] + EXEMPT)).toBe(true);
    expect(nestingRefusalExemptsNativeScripts("CBOR nesting is deeper than the supported limit of 32768 levels")).toBe(false);
    expect((failFromError(new WorkerCallError({ name: "Error", message: "Deserialization failed", fatal: false })).structuredContent as { code: string }).code).toBe("lib_error");
    // a poisoned instance stays a trap whatever its text
    expect((failFromError(new WorkerCallError({ name: "RuntimeError", message: messages[0]![0], fatal: true })).structuredContent as { code: string }).code).toBe("wasm_trap");
  });
});

describe("pageWithinChars", () => {
  it("stops a page before the character budget, keeps at least one row and continues at next_offset", async () => {
    const { pageWithinChars } = await import("../../src/tools/_shared.js");
    const rows = Array.from({ length: 50 }, (_, i) => ({ i, blob: "x".repeat(1_000) }));
    const page = pageWithinChars(rows, 0, 50, 10_000);
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.length).toBeLessThan(10);
    expect(page.page_cut).toBe(true);
    expect(page.next_offset).toBe(page.rows.length);
    expect(JSON.stringify(page.rows).length).toBeLessThanOrEqual(10_000);
    const next = pageWithinChars(rows, page.next_offset!, 50, 10_000);
    expect(next.rows[0]).toEqual(rows[page.rows.length]);
    const huge = pageWithinChars([{ blob: "y".repeat(50_000) }, { a: 1 }], 0, 20, 10_000);
    expect(huge.rows).toHaveLength(1);
    expect(huge.next_offset).toBe(1);
    const small = pageWithinChars(rows.slice(0, 3), 0, 20, 10_000);
    expect(small.page_cut).toBeUndefined();
    expect(small.rows).toHaveLength(3);
  });
});
