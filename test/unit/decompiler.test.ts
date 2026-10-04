// Unit tests of the decompiler layer: script wrapping detection, note extraction, option building
// against the real dehosk catalogue (wasm loaded in-process, ~10 ms), and the text cache.
import * as decompilerWasm from "@cardananium/de-uplc-decompiler-wasm";
import { beforeAll, describe, expect, it } from "vitest";

import { cacheKey, DecompileCache } from "../../src/decompiler/cache.js";
import { CatalogueIndex, getAtPath, parseCatalogue, setAtPath } from "../../src/decompiler/catalogue.js";
import { extractNotes, numberLines } from "../../src/decompiler/notes.js";
import { buildDecompileOptions, OptionsError, stableStringify } from "../../src/decompiler/options.js";
import { normalizeScriptInput, parsePlutusVersion, unwrapScriptHex, wrapCborBytes } from "../../src/decompiler/scriptBytes.js";
import { readWasm } from "../../src/wasm-assets.js";
import { fxStr, readFixtureText } from "../helpers/fixtures.js";

// The artificial S1 spend script (order_fixed, single-CBOR-wrapped PlutusV2): CBOR header, then the flat program (01 00 00 …).
const SINGLE = readFixtureText(fxStr("s01.spendScriptFile")).trim();
const FLAT = SINGLE.slice(6);
const DOUBLE = wrapCborBytes(SINGLE);

describe("scriptBytes", () => {
  it("recognises flat / single / double wrappings and normalises to single", () => {
    expect(SINGLE.startsWith(`${fxStr("s01.spendScript.header")}010000`)).toBe(true);
    const flat = unwrapScriptHex(FLAT);
    expect(flat.wrapping).toBe("flat");
    expect(flat.singleHex).toBe(SINGLE);
    expect(flat.headerVersion).toBe("V1_or_V2");
    const single = unwrapScriptHex(SINGLE);
    expect(single.wrapping).toBe("single");
    expect(single.flatHex).toBe(FLAT);
    expect(single.sizeBytes).toBe(SINGLE.length / 2);
    const double = unwrapScriptHex(DOUBLE);
    expect(double.wrapping).toBe("double");
    expect(double.singleHex).toBe(SINGLE);
    expect(double.flatHex).toBe(FLAT);
  });

  it("reads the ScriptRef tag and the cli envelope type as the stated version", () => {
    const ref = unwrapScriptHex("8202" + DOUBLE);
    expect(ref.wrapping).toBe("script_ref");
    expect(ref.statedVersion).toBe("V2");
    expect(ref.singleHex).toBe(SINGLE);
    const envelope = normalizeScriptInput(JSON.stringify({ type: "PlutusScriptV1", description: "", cborHex: DOUBLE.toUpperCase() }));
    expect(envelope.inputKind).toBe("cli_envelope");
    expect(envelope.statedVersion).toBe("V1");
    expect(envelope.wrapping).toBe("double");
    expect(envelope.singleHex).toBe(SINGLE);
    const b64 = normalizeScriptInput(Buffer.from(SINGLE, "hex").toString("base64"));
    expect(b64.inputKind).toBe("base64");
    expect(b64.singleHex).toBe(SINGLE);
    const spaced = normalizeScriptInput("0x" + SINGLE.slice(0, 20) + "\n" + SINGLE.slice(20));
    expect(spaced.singleHex).toBe(SINGLE);
  });

  it("detects the V3 header and rejects non-bytes input", () => {
    const v3 = unwrapScriptHex("4501010033aa");
    expect(v3.headerVersion).toBe("V3");
    expect(v3.wrapping).toBe("single");
    expect(() => normalizeScriptInput(fxStr("s01.spendScript.address"))).toThrow(/hex/);
    expect(() => normalizeScriptInput('{"type":"PlutusScriptV2"}')).toThrow(/cborHex/);
    expect(parsePlutusVersion("v2")).toBe("V2");
    expect(parsePlutusVersion("PlutusV3")).toBe("V3");
    expect(parsePlutusVersion("plutus_v1")).toBe("V1");
    expect(parsePlutusVersion(2)).toBe("V2");
    expect(parsePlutusVersion("V9")).toBeUndefined();
  });
});

describe("notes", () => {
  it("extracts the leading comment block, joins wrapped sentences and keeps tagged lines separate", () => {
    const text = [
      "// Info: Plutus version assumed V2: the (1, 0) UPLC header is shared by V1 and V2. Pass --script-version.",
      "// Warning: V1/V2 non-spend purpose is ambiguous from bytecode",
      "// Outer Apply chain — no compile-time params: all 1 argument(s) are",
      "// compiled in, and an applied parameter is always `con data`: force force builtin.sndPair.",
      "// Applied compile-time params (from outer Apply chain) — applied first (innermost):",
      '// param_2 (Plutus Data, decoded): @"MEMX"',
      "// param_2 (Plutus Data, CBOR): 444d454d58",
      "",
      "// ↓ applied compile-time param_0",
      "validator decompiled {",
    ].join("\n");
    const { notes, headerLines } = extractNotes(text);
    expect(headerLines).toBe(7);
    expect(notes.map((n) => n.kind)).toEqual(["info", "warning", "comment", "comment", "comment", "comment"]);
    expect(notes[0]!.text).toMatch(/^Plutus version assumed V2/);
    expect(notes[1]!.text).toBe("V1/V2 non-spend purpose is ambiguous from bytecode");
    expect(notes[2]!.text).toBe("Outer Apply chain — no compile-time params: all 1 argument(s) are compiled in, and an applied parameter is always `con data`: force force builtin.sndPair.");
    expect(notes[3]!.text).toMatch(/^Applied compile-time params/);
    expect(notes[4]!.text).toBe('param_2 (Plutus Data, decoded): @"MEMX"');
  });

  it("returns no notes for output without a header and numbers lines right-aligned", () => {
    expect(extractNotes("validator decompiled {\n}\n")).toEqual({ notes: [], headerLines: 0 });
    expect(extractNotes("// Note: church-bool polarity detected as InverseCip — a HEURISTIC.\nconst k = 1").notes).toEqual([{ kind: "note", text: "church-bool polarity detected as InverseCip — a HEURISTIC." }]);
    expect(numberLines(["a", "b"], 9, 3)).toBe("  9  a\n 10  b");
    expect(numberLines(["a"], 1)).toBe("1  a");
  });
});

describe("options against the real catalogue", () => {
  let index: CatalogueIndex;

  beforeAll(() => {
    decompilerWasm.initSync({ module: readWasm("de_uplc_decompiler_wasm_bg.wasm") });
    index = new CatalogueIndex(parseCatalogue(decompilerWasm.options_catalogue()));
  });

  it("parses the catalogue and exposes the wasm-DTO preset", () => {
    expect(index.optionCount).toBeGreaterThanOrEqual(40);
    const defaults = index.defaults;
    expect(getAtPath(defaults, ["decode_church_to_native"])).toBe(true);
    expect(getAtPath(defaults, ["expect_or_fail"])).toBe(true);
    expect(getAtPath(defaults, ["synthesize_stub_adts"])).toBe(false);
    expect(getAtPath(defaults, ["validator_shape", "applied_kind"])).toBe("Compile");
    expect(index.tokens(["output_layer"])).toEqual(expect.arrayContaining(["Decompiled", "Uplc", "UplcCanonical"]));
    expect(index.matchToken(["script_version"], "plutusv2")).toBe("PlutusV2");
    expect(setAtPath({}, ["a", "b"], 1)).toEqual({ a: { b: 1 } });
  });

  it("builds the wire bag from the preset + view/version/purpose + user subset", () => {
    const built = buildDecompileOptions(index, { view: "pseudocode", scriptVersion: "V2", purpose: "publish", user: { safe_mode: true, split_purposes: "never", applied_kind: 2 } });
    expect(getAtPath(built.bag, ["output_layer"])).toBe("Decompiled");
    expect(getAtPath(built.bag, ["script_version"])).toBe("PlutusV2");
    expect(getAtPath(built.bag, ["validator_shape", "purpose"])).toBe("Certificate");
    expect(getAtPath(built.bag, ["validator_shape", "split_purposes"])).toBe("Never");
    expect(getAtPath(built.bag, ["validator_shape", "applied_kind"])).toEqual({ runtime_count: 2 });
    expect(getAtPath(built.bag, ["safe_mode"])).toBe(true);
    expect(built.layer).toBe("Decompiled");
    expect(built.versionToken).toBe("PlutusV2");
    expect(built.purposeToken).toBe("Certificate");
    expect(built.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(built.json).toBe(stableStringify(built.bag));
    expect(built.echo.passes_overridden).toBeUndefined();
    // The wire bag must be accepted by the wasm DTO itself.
    expect(() => decompilerWasm.decompile_uplc(SINGLE, built.json)).not.toThrow();

    const uplc = buildDecompileOptions(index, { view: "uplc" });
    expect(uplc.layer).toBe("Uplc");
    expect(uplc.hash).not.toBe(built.hash);
    const withRaw = buildDecompileOptions(index, { view: "pseudocode", user: { raw: { readability_passes: { rename_variables: false }, validator_shape: { purpose: "Mint" } } } });
    expect(withRaw.echo.passes_overridden).toEqual({ readability_passes: { rename_variables: false } });
    expect(withRaw.purposeToken).toBe("Mint");
  });

  it("rejects unknown names and tokens with invalid_argument-grade errors", () => {
    expect(() => buildDecompileOptions(index, { view: "pseudocode", user: { split_purposes: "sometimes" } })).toThrow(OptionsError);
    expect(() => buildDecompileOptions(index, { view: "pseudocode", user: { applied_kind: "explicit" } })).toThrow(/compile\|runtime\|auto|auto\|compile\|runtime/i);
    expect(() => buildDecompileOptions(index, { view: "pseudocode", user: { raw: { bogus: true } } })).toThrow(/unknown option 'bogus'/);
    expect(() => buildDecompileOptions(index, { view: "pseudocode", user: { raw: { validator_shape: { purpose: "Nope" } } } })).toThrow(/validator_shape\.purpose/);
    expect(() => buildDecompileOptions(index, { view: "pseudocode", user: { raw: { safe_mode: "yes" } } })).toThrow(/true\|false/);
    expect(() => buildDecompileOptions(index, { view: "pseudocode", user: { raw: { output_layer: "Uplc" } } })).toThrow(/conflicts with `view`/);
    expect(() => buildDecompileOptions(index, { view: "pseudocode", user: { safe_mode: "true" as unknown as boolean } })).toThrow(OptionsError);
  });
});

describe("DecompileCache", () => {
  const entry = (scriptHash: string, optionsHash: string, text = "line1\nline2", layer = "Decompiled") => ({
    scriptHash,
    optionsHash,
    layer,
    optionsJson: "{}",
    text,
    notes: [],
    headerLines: 0,
    elapsedMs: 1,
    versionToken: null,
    purposeToken: null,
  });

  it("caches full texts by (script, options), pages for free and evicts LRU by count and size", () => {
    let now = 1_000;
    const cache = new DecompileCache({ maxEntries: 2, maxTotalChars: 1_000, now: () => now });
    const a = cache.put(entry("aa", "o1"));
    expect(a.key).toBe(cacheKey("aa", "o1"));
    expect(a.lines).toEqual(["line1", "line2"]);
    cache.put(entry("bb", "o1"));
    expect(cache.get("aa", "o1")).toBeDefined(); // touch → bb is now the LRU
    cache.put(entry("cc", "o1"));
    expect(cache.size).toBe(2);
    expect(cache.get("bb", "o1")).toBeUndefined();
    expect(cache.get("aa", "o1")).toBeDefined();
    cache.put(entry("dd", "o1", "x".repeat(900)));
    cache.put(entry("ee", "o1", "y".repeat(900))); // over the char budget → oldest dropped
    expect(cache.get("dd", "o1")).toBeUndefined();
    expect(cache.get("ee", "o1")).toBeDefined();
    now += 25 * 60 * 60 * 1000;
    expect(cache.get("ee", "o1")).toBeUndefined(); // idle TTL 24 h
  });

  it("serves the latest entry per (script, layer) and keeps failure markers with a TTL", () => {
    let now = 0;
    const cache = new DecompileCache({ now: () => now, failureTtlMs: 1_000 });
    cache.put(entry("aa", "o1", "old", "Decompiled"));
    now = 10;
    cache.put(entry("aa", "o2", "new", "Decompiled"));
    cache.put(entry("aa", "o3", "uplc", "Uplc"));
    expect(cache.latestFor("aa", "Decompiled")?.text).toBe("new");
    expect(cache.latestFor("aa", "Uplc")?.text).toBe("uplc");
    expect(cache.latestFor("zz", "Uplc")).toBeUndefined();
    expect(cache.scriptHashes()).toEqual(["aa"]);

    const marker = cache.markFailure({ scriptHash: "bb", layer: "Decompiled", optionsHash: "o1", code: "timeout", message: "took too long" });
    expect(marker.until).toBe(1_010);
    expect(cache.failure("bb", "Decompiled")?.code).toBe("timeout");
    expect(cache.failure("bb", "Uplc")).toBeUndefined();
    now = 2_000;
    expect(cache.failure("bb", "Decompiled")).toBeUndefined();
    cache.markFailure({ scriptHash: "bb", layer: "Decompiled", optionsHash: "o1", code: "wasm_trap", message: "unreachable" });
    cache.put(entry("bb", "o1", "recovered")); // a success clears the marker
    expect(cache.failure("bb", "Decompiled")).toBeUndefined();
  });
});
