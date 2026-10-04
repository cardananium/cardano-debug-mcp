// script_decompile over stdio against dist/server.js: pseudocode + uplc views of the artificial S1 spend script
// (order_fixed, Plutus V2), notes extraction, paging, caching, every script-identity path, and the
// cardano-debug://script/… resources.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { wrapCborBytes } from "../../src/decompiler/scriptBytes.js";
import { fixturePath, fx, fxInt, fxStr, readTx } from "../helpers/fixtures.js";
import { PROJECT_ROOT, StdioClient } from "../helpers/stdioClient.js";

// The S1 spend script (single-CBOR-wrapped PlutusV2, `s01.spendScriptFile`) and its debugger context bundle.
const SAMPLE_SCRIPT = fixturePath(fxStr("s01.spendScriptFile"));
const SAMPLE_BUNDLE = fixturePath(fxStr("s01.contextFile"));

interface DecompileResult {
  script_hash: string;
  plutus_version: string;
  version_decision: string;
  script_hash_if?: Record<string, string>;
  hash_verified?: boolean;
  purpose_used: { purpose: string; label: string; decision: string } | null;
  source: string;
  size_bytes: number;
  wrapping: string;
  view: string;
  options_used: Record<string, unknown>;
  total_lines: number;
  from_line: number;
  to_line: number;
  next_from_line?: number;
  notes: Array<{ kind: string; text: string }>;
  header_lines: number;
  code: string;
  elapsed_ms: number;
  cached: boolean;
  resources: Array<{ uri: string; name: string; mimeType?: string }>;
  code_?: never;
  [key: string]: unknown;
}

const NODE20 = path.join(process.env.HOME ?? "", ".nvm/versions/node/v20.14.0/bin/node");
const variants: Array<{ label: string; make: () => StdioClient }> = [{ label: `dist (node ${process.version})`, make: () => StdioClient.dist() }];
if (existsSync(NODE20)) variants.push({ label: "dist (node v20.14.0)", make: () => StdioClient.dist(NODE20) });
if (process.env.CARDANO_DEBUG_E2E_DEV === "1") variants.push({ label: "dev (tsx)", make: () => StdioClient.dev() });

const SAMPLE_HASH_V2 = fxStr("s01.spendScript.hash");
const SAMPLE_HASH_V1 = fxStr("s01.spendScript.hashV1"); // the same bytes read as Plutus V1

describe.each(variants)("script_decompile over stdio — $label", ({ make }) => {
  let client: StdioClient;
  let single: string;

  beforeAll(async () => {
    expect(existsSync(path.join(PROJECT_ROOT, "dist", "server.js")), "run `npm run build` before the e2e test").toBe(true);
    single = readFileSync(SAMPLE_SCRIPT, "utf8").trim();
    client = make();
    await client.initialize();
  });

  afterAll(async () => {
    const code = await client.close();
    expect(client.nonJsonStdout, "stdout must carry only JSON-RPC").toEqual([]);
    expect(code).toBe(0);
  });

  it("lists script_decompile with a flat input schema and the 200k result-size hint", async () => {
    const { tools } = await client.request<{ tools: Array<{ name: string; inputSchema: { type: string; properties: Record<string, unknown>; anyOf?: unknown }; _meta?: Record<string, unknown> }> }>("tools/list");
    const tool = tools.find((t) => t.name === "script_decompile");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.type).toBe("object");
    expect(tool!.inputSchema.anyOf).toBeUndefined();
    expect(Object.keys(tool!.inputSchema.properties).sort()).toEqual(
      ["dbg_id", "from_line", "lines", "network", "options", "plutus_version", "purpose", "refresh", "script", "script_hash", "tx_id", "view"].sort(),
    );
    expect(tool!._meta?.["anthropic/maxResultSizeChars"]).toBe(200_000);
  });

  it("decompiles the sample script (double-wrapped, V2 spend): notes, numbered page, paging, cache", async () => {
    const first = await client.callTool<DecompileResult>("script_decompile", { script: wrapCborBytes(single), plutus_version: "V2", purpose: "spend", lines: 50 }, 120_000);
    expect(first.isError, JSON.stringify(first.structuredContent)).toBeFalsy();
    const page1 = first.structuredContent!;
    expect(page1.script_hash).toBe(SAMPLE_HASH_V2);
    expect(page1.plutus_version).toBe("V2");
    expect(page1.version_decision).toBe("given");
    expect(page1.purpose_used).toEqual({ purpose: "spend", label: "Spending", decision: "given" });
    expect(page1.wrapping).toBe("double");
    expect(page1.size_bytes).toBe(single.length / 2);
    expect(page1.view).toBe("pseudocode");
    expect(page1.total_lines).toBe(fxInt("s01.spendScript.registry.pseudocodeLines"));
    expect(page1.from_line).toBe(1);
    expect(page1.to_line).toBe(50);
    expect(page1.next_from_line).toBe(51);
    expect(page1.cached).toBe(false);
    expect(page1.elapsed_ms).toBeGreaterThan(0);
    expect(page1.notes.length).toBeGreaterThan(0);
    expect(page1.notes[0]!.text).toMatch(/^Outer Apply chain/);
    expect(page1.header_lines).toBeGreaterThan(0);
    const codeLines = page1.code.split("\n");
    expect(codeLines).toHaveLength(50);
    expect(codeLines[0]).toMatch(/^\s*1  \/\/ Outer Apply chain/);
    expect(page1.code).toMatch(/spend\(datum, redeemer, script_context\)/);
    expect(page1.options_used).toMatchObject({ output_layer: "Decompiled", script_version: "PlutusV2", decode_church_to_native: true, expect_or_fail: true, synthesize_stub_adts: false });
    expect((page1.options_used.validator_shape as Record<string, unknown>).purpose).toBe("Spend");
    expect(page1.resources.map((r) => r.uri)).toEqual([`cardano-debug://script/${SAMPLE_HASH_V2}/pseudocode.txt`, `cardano-debug://script/${SAMPLE_HASH_V2}/uplc.txt`]);
    // the JSON `resources` list is the only link carrier (no resource_link content blocks)
    expect(first.content.filter((c) => c.type === "resource_link")).toHaveLength(0);
    expect(JSON.parse(first.content[0]!.text!)).toEqual(page1);

    const second = await client.callTool<DecompileResult>("script_decompile", { script: single, plutus_version: "V2", purpose: "spend", from_line: 51, lines: 600 });
    const page2 = second.structuredContent!;
    expect(page2.cached).toBe(true);
    expect(page2.from_line).toBe(51);
    expect(page2.to_line).toBe(page1.total_lines);
    expect(page2.next_from_line).toBeUndefined();
    expect(page2.code.split("\n")).toHaveLength(page1.total_lines - 50);
    expect(page2.notes).toEqual(page1.notes);

    const past = await client.callTool<{ code: string; total_lines: number }>("script_decompile", { script: single, plutus_version: "V2", purpose: "spend", from_line: 10_000 });
    expect(past.isError).toBe(true);
    expect(past.structuredContent?.code).toBe("invalid_argument");
    expect(past.structuredContent?.total_lines).toBe(page1.total_lines);
  });

  it("view='uplc' is the exact program; options are refused there", async () => {
    const uplc = await client.callTool<DecompileResult>("script_decompile", { script: single, view: "uplc", lines: 5 }, 60_000);
    expect(uplc.isError, JSON.stringify(uplc.structuredContent)).toBeFalsy();
    const body = uplc.structuredContent!;
    expect(body.view).toBe("uplc");
    expect(body.total_lines).toBe(fxInt("s01.spendScript.registry.uplcLines"));
    expect(body.code.split("\n")[0]).toMatch(/^\s*1  \(program 1\.0\.0/);
    expect(body.notes).toEqual([]);
    expect(body.options_used.output_layer).toBe("Uplc");

    const canonical = await client.callTool<DecompileResult>("script_decompile", { script: single, view: "uplc_canonical", lines: 3 }, 60_000);
    expect(canonical.structuredContent?.view).toBe("uplc_canonical");
    expect(canonical.structuredContent?.total_lines).toBeGreaterThan(body.total_lines);

    const refused = await client.callTool<{ code: string; argument: string }>("script_decompile", { script: single, view: "uplc", options: { safe_mode: true } });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ code: "invalid_argument", argument: "options" });
  });

  it("without hints: version assumed V2 with the alternative hash, dehosk's own Info note surfaces", async () => {
    const result = await client.callTool<DecompileResult>("script_decompile", { script: single.slice(6) /* flat */, lines: 3 }, 120_000);
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    const body = result.structuredContent!;
    expect(body.wrapping).toBe("flat");
    expect(body.plutus_version).toBe("V2");
    expect(body.version_decision).toMatch(/^assumed/);
    expect(body.script_hash).toBe(SAMPLE_HASH_V2);
    expect(body.script_hash_if).toEqual({ V1: SAMPLE_HASH_V1 });
    expect(body.purpose_used).toBeNull();
    expect(body.options_used.script_version).toBeNull();
    expect(body.notes.some((n) => n.kind === "info" && /Plutus version assumed V2/.test(n.text))).toBe(true);
    expect(body.code.split("\n")[0]).toMatch(/^\s*1  \/\/ Info: Plutus version assumed V2/);
  });

  it("takes the version from a cli envelope, a ScriptRef tag, and pins V1 when script_hash says so", async () => {
    const envelope = await client.callTool<DecompileResult>("script_decompile", { script: JSON.stringify({ type: "PlutusScriptV2", description: "", cborHex: wrapCborBytes(single) }), view: "uplc", lines: 1 });
    expect(envelope.structuredContent?.version_decision).toBe("from the cardano-cli envelope type");
    expect(envelope.structuredContent?.plutus_version).toBe("V2");

    const ref = await client.callTool<DecompileResult>("script_decompile", { script: "8201" + wrapCborBytes(single), view: "uplc", lines: 1 });
    expect(ref.structuredContent?.version_decision).toBe("from the ScriptRef tag");
    expect(ref.structuredContent?.plutus_version).toBe("V1");
    expect(ref.structuredContent?.script_hash).toBe(SAMPLE_HASH_V1);
    expect(ref.structuredContent?.wrapping).toBe("script_ref");

    const pinned = await client.callTool<DecompileResult>("script_decompile", { script: single, script_hash: SAMPLE_HASH_V1, view: "uplc", lines: 1 });
    expect(pinned.structuredContent?.plutus_version).toBe("V1");
    expect(pinned.structuredContent?.hash_verified).toBe(true);
    expect(pinned.structuredContent?.script_hash).toBe(SAMPLE_HASH_V1);

    const mismatch = await client.callTool<DecompileResult>("script_decompile", { script: single, plutus_version: "V3", script_hash: SAMPLE_HASH_V2, view: "uplc", lines: 1 });
    expect(mismatch.structuredContent?.hash_verified).toBe(false);
    expect(mismatch.structuredContent?.warning).toMatch(/not to the requested script_hash/);
  });

  it("tx_id + script_hash: takes bytes, version and purpose from a loaded transaction", async () => {
    const txHex = readTx("pool-mint.tx"); // scenario s07: two V3 minting scripts in the witness set
    const [firstScript, secondScript] = fx<Array<{ hash: string }>>("s07.scripts");
    const inspected = await client.callTool<{ tx_id: string; rows: Array<{ script_hash: string; plutus_version: string }> }>("tx_inspect", { tx_cbor: txHex, section: "scripts" });
    expect(inspected.isError, JSON.stringify(inspected.structuredContent)).toBeFalsy();
    const txId = inspected.structuredContent!.tx_id;
    expect(txId).toMatch(/^tx_mainnet_/);
    const scriptHash = firstScript!.hash;

    const result = await client.callTool<DecompileResult>("script_decompile", { tx_id: txId, script_hash: scriptHash, lines: 20 }, 120_000);
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    const body = result.structuredContent!;
    expect(body.script_hash).toBe(scriptHash);
    expect(body.hash_verified).toBe(true);
    expect(body.plutus_version).toBe("V3");
    expect(body.version_decision).toBe("from the transaction");
    expect(body.purpose_used).toEqual({ purpose: "mint", label: "Minting", decision: "from_tx" });
    expect(body.source).toMatch(new RegExp(`^tx: ${txId} witness script`));
    expect(body.options_used.script_version).toBe("PlutusV3");
    expect((body.options_used.validator_shape as Record<string, unknown>).purpose).toBe("Mint");
    expect(body.code).toMatch(/mint\(/);

    const missing = await client.callTool<{ code: string; available: unknown[] }>("script_decompile", { tx_id: txId, script_hash: "00".repeat(28) });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent?.code).toBe("script_not_found");
    expect(missing.structuredContent?.available).toHaveLength(fxInt("s07.scriptCount"));

    const byHashOnly = await client.callTool<DecompileResult>("script_decompile", { script_hash: secondScript!.hash, network: "mainnet", view: "uplc", lines: 1 }, 60_000);
    expect(byHashOnly.isError, JSON.stringify(byHashOnly.structuredContent)).toBeFalsy();
    expect(byHashOnly.structuredContent?.source).toMatch(/^tx: tx_mainnet_/);
  });

  it("a native script (inline output of the sample tx) answers not_plutus, not script_not_found", async () => {
    const load = await client.callTool<{ tx_id: string }>("tx_load", { bundle: SAMPLE_BUNDLE }, 120_000);
    expect(load.isError, JSON.stringify(load.structuredContent)).toBeFalsy();
    const txId = load.structuredContent!.tx_id;
    const scripts = await client.callTool<{ rows: Array<{ script_hash: string; plutus_version: string; source: string }> }>("tx_inspect", { tx_id: txId, section: "scripts" });
    const native = scripts.structuredContent!.rows.find((r) => r.plutus_version === "native");
    expect(native, JSON.stringify(scripts.structuredContent!.rows)).toBeDefined();
    const answer = await client.callTool<{ code: string; message: string }>("script_decompile", { tx_id: txId, script_hash: native!.script_hash });
    expect(answer.isError).toBe(true);
    expect(answer.structuredContent!.code).toBe("not_plutus");
    expect(answer.structuredContent!.message).toMatch(/native script/);
    expect(answer.structuredContent!.message).toMatch(/as='NativeScript'/);
    const byHash = await client.callTool<{ code: string }>("script_decompile", { script_hash: native!.script_hash, network: "mainnet" });
    expect(byHash.structuredContent!.code).toBe("not_plutus");
  });

  it("a program session opened from hex decompiles by dbg_id; one opened from UPLC text says so", async () => {
    const opened = await client.callTool<{ dbg_id: string; mode: string; docs_hint: string }>("debug_open", { script: single, plutus_version: "V2" });
    expect(opened.structuredContent!.mode).toBe("program");
    expect(opened.structuredContent!.docs_hint).toMatch(/script_decompile\(dbg_id\) gives/);
    const byDbg = await client.callTool<DecompileResult>("script_decompile", { dbg_id: opened.structuredContent!.dbg_id, lines: 5 }, 120_000);
    expect(byDbg.isError, JSON.stringify(byDbg.structuredContent)).toBeFalsy();
    expect(byDbg.structuredContent!.script_hash).toBe(SAMPLE_HASH_V2);
    const text = await client.callTool<{ dbg_id: string; docs_hint: string }>("debug_open", { script: "(program 1.0.0 (con integer 1))", plutus_version: "V2" });
    expect(text.structuredContent!.docs_hint).toMatch(/opened from UPLC text/);
    const refused = await client.callTool<{ code: string; message: string }>("script_decompile", { dbg_id: text.structuredContent!.dbg_id });
    expect(refused.structuredContent).toMatchObject({ code: "no_script_bytes" });
    expect(refused.structuredContent!.message).toMatch(/UPLC source text/);
    // A parts session (UPLC text + context) keeps the text in `script`: same answer, not "Only hex encoding is supported".
    const parts = await client.callTool<{ dbg_id: string; mode: string }>("debug_open", { script: "(program 1.1.0 (lam ctx (con unit ())))", plutus_version: "V3", context: "d87980" });
    expect(parts.isError, JSON.stringify(parts.structuredContent)).toBeFalsy();
    expect(parts.structuredContent!.mode).toBe("parts");
    const refusedParts = await client.callTool<{ code: string; message: string; argument: string; mode: string }>("script_decompile", { dbg_id: parts.structuredContent!.dbg_id });
    expect(refusedParts.isError).toBe(true);
    expect(refusedParts.structuredContent).toMatchObject({ code: "no_script_bytes", mode: "parts", argument: "script" });
    expect(refusedParts.structuredContent!.message).toMatch(/UPLC source text/);
    expect(refusedParts.structuredContent!.message).not.toMatch(/Only hex/);
    await client.callTool("debug_close", { dbg_id: "all" });
  });

  it("view='uplc' pages have compacted indentation (dedent, capped at 64 columns)", async () => {
    const page = await client.callTool<DecompileResult>("script_decompile", { script: single, view: "uplc", from_line: 400, lines: 200 }, 60_000);
    expect(page.isError, JSON.stringify(page.structuredContent)).toBeFalsy();
    const body = page.structuredContent!;
    expect(typeof body.dedent).toBe("number");
    const indents = body.code.split("\n").map((l) => l.replace(/^\s*\d+ {2}/, "")).map((l) => l.length - l.trimStart().length);
    expect(Math.max(...indents)).toBeLessThanOrEqual(64);
  });

  it("reports expired / unknown handles and unavailable chain lookups as recoverable errors", async () => {
    const dbg = await client.callTool<{ code: string; recreate_with: string }>("script_decompile", { dbg_id: "dbg_00000000-0000-4000-8000-000000000000" });
    expect(dbg.isError).toBe(true);
    expect(dbg.structuredContent).toMatchObject({ code: "expired_handle", recreate_with: "debug_open" });

    const tx = await client.callTool<{ code: string; recreate_with: string }>("script_decompile", { tx_id: "tx_mainnet_000000000000", script_hash: SAMPLE_HASH_V2 });
    expect(tx.structuredContent).toMatchObject({ code: "expired_handle", recreate_with: "tx_load" });

    const chain = await client.callTool<{ code: string }>("script_decompile", { script_hash: "11".repeat(28) });
    expect(chain.isError).toBe(true);
    expect(["script_unavailable", "invalid_argument", "script_not_found"]).toContain(chain.structuredContent?.code);

    const both = await client.callTool<{ code: string }>("script_decompile", { script: single, dbg_id: "dbg_x" });
    expect(both.structuredContent?.code).toBe("invalid_argument");
    const none = await client.callTool<{ code: string }>("script_decompile", {});
    expect(none.structuredContent?.code).toBe("invalid_argument");
    const badHash = await client.callTool<{ code: string; argument: string }>("script_decompile", { script_hash: "zz" });
    expect(badHash.structuredContent).toMatchObject({ code: "invalid_argument", argument: "script_hash" });
    const garbage = await client.callTool<{ code: string; message: string; argument: string }>("script_decompile", { script: "deadbeef" });
    expect(garbage.isError).toBe(true);
    expect(garbage.structuredContent).toMatchObject({ code: "invalid_argument", argument: "script" });
    expect(garbage.structuredContent?.message).toMatch(/do not decode as a Plutus script/);
    // A well-formed CBOR byte string whose content is not a flat program passes the hash step and is refused by the decompiler itself.
    const notFlat = await client.callTool<{ code: string; message: string }>("script_decompile", { script: "4401000023" });
    expect(notFlat.isError).toBe(true);
    expect(notFlat.structuredContent?.code).toBe("decompile_error");
    expect(notFlat.structuredContent?.message).toMatch(/Failed to decode/);
  });

  it("validates options against the catalogue and echoes overrides", async () => {
    const bad = await client.callTool<{ code: string; argument: string; message: string }>("script_decompile", { script: single, options: { raw: { bogus: 1 } } });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toMatchObject({ code: "invalid_argument", argument: "options.raw" });
    expect(bad.structuredContent?.message).toMatch(/unknown option 'bogus'/);

    const good = await client.callTool<DecompileResult>(
      "script_decompile",
      { script: single, plutus_version: "V2", purpose: "spend", lines: 5, options: { safe_mode: true, applied_kind: 1, raw: { readability_passes: { rename_variables: false } } } },
      120_000,
    );
    expect(good.isError, JSON.stringify(good.structuredContent)).toBeFalsy();
    expect(good.structuredContent?.options_used).toMatchObject({ safe_mode: true, passes_overridden: { readability_passes: { rename_variables: false } } });
    expect((good.structuredContent?.options_used.validator_shape as Record<string, unknown>).applied_kind).toEqual({ runtime_count: 1 });
    expect(good.structuredContent?.cached).toBe(false);
  });

  it("serves the cached texts as resources", async () => {
    const full = await client.readResource(`cardano-debug://script/${SAMPLE_HASH_V2}/pseudocode.txt`);
    const text = full.contents[0]!.text!;
    expect(full.contents[0]!.mimeType).toBe("text/plain");
    expect(text.split("\n").length).toBeGreaterThanOrEqual(fxInt("s01.spendScript.registry.pseudocodeLines"));
    expect(text).toMatch(/validator decompiled/);
    const uplc = await client.readResource(`cardano-debug://script/${SAMPLE_HASH_V2}/uplc.txt`);
    expect(uplc.contents[0]!.text!.startsWith("(program 1.0.0")).toBe(true);
    await expect(client.readResource(`cardano-debug://script/${"22".repeat(28)}/pseudocode.txt`)).rejects.toThrow();
    const { resourceTemplates } = await client.request<{ resourceTemplates: Array<{ uriTemplate: string }> }>("resources/templates/list");
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(expect.arrayContaining([`cardano-debug://script/{script_hash}/pseudocode.txt`, `cardano-debug://script/{script_hash}/uplc.txt`]));
  });
});

// A 1 ms decompile budget: the worker is terminated and respawned, the script gets a failure marker,
// identical retries are refused without running the decompiler again, and the server stays healthy.
// The decompiler worker's test hook blocks every decompile for 3 s, far past the 1 ms budget plus the
// 250 ms kill grace, so each attempt that reaches the worker times out whatever the machine's speed.
describe("script_decompile failure markers (CARDANO_DEBUG_DECOMPILE_TIMEOUT_MS=1)", () => {
  let client: StdioClient;
  let single: string;

  beforeAll(async () => {
    single = readFileSync(SAMPLE_SCRIPT, "utf8").trim();
    client = StdioClient.dist(process.execPath, { CARDANO_DEBUG_DECOMPILE_TIMEOUT_MS: "1", CARDANO_DEBUG_TEST_HOOKS: "1", CARDANO_DEBUG_TEST_DECOMPILE_DELAY_MS: "3000" });
    await client.initialize();
  });

  afterAll(async () => {
    const code = await client.close();
    expect(client.nonJsonStdout).toEqual([]);
    expect(code).toBe(0);
  });

  it("answers decompile_failed with a retry window, refuses identical retries, keeps serving", async () => {
    const first = await client.callTool<{ code: string; failure: string; retry_after_s: number; script_hash: string; message: string }>("script_decompile", { script: single, plutus_version: "V2", purpose: "spend" }, 60_000);
    expect(first.isError).toBe(true);
    expect(first.structuredContent).toMatchObject({ code: "decompile_failed", failure: "timeout", script_hash: SAMPLE_HASH_V2 });
    expect(first.structuredContent!.retry_after_s).toBeGreaterThan(0);
    expect(first.structuredContent!.message).toMatch(/view='uplc'|refresh=true/);

    const started = Date.now();
    const second = await client.callTool<{ code: string; failure: string }>("script_decompile", { script: single, plutus_version: "V2", purpose: "spend" }, 60_000);
    expect(second.structuredContent).toMatchObject({ code: "decompile_failed", failure: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000); // no second 250 ms kill cycle: served from the marker

    // Different options are allowed through (and fail on their own), a forced refresh too.
    const other = await client.callTool<{ code: string }>("script_decompile", { script: single, plutus_version: "V2", purpose: "spend", options: { safe_mode: true } }, 60_000);
    expect(other.structuredContent?.code).toBe("decompile_failed");
    const forced = await client.callTool<{ code: string }>("script_decompile", { script: single, plutus_version: "V2", purpose: "spend", refresh: true }, 60_000);
    expect(forced.structuredContent?.code).toBe("decompile_failed");
    expect(client.stderr.join("")).toMatch(/decompiler worker lost \(timeout\)/);

    const still = await client.callTool<{ as: string }>("cbor_decode", { hex: "d8799f41aa02ff" });
    expect(still.structuredContent?.as).toBe("PlutusData");
    const info = await client.readResource("cardano-debug://server/info");
    const parsed = JSON.parse(info.contents[0]!.text!) as { engines: { dehosk_decompiler: { total_respawns?: number; status?: string } } };
    expect(parsed.engines.dehosk_decompiler.total_respawns ?? 0).toBeGreaterThanOrEqual(1);
  });
});

// Two requests for the same script that arrive together share one dehosk run (the host queue is serial,
// so without sharing the second would wait for the first and then run the decompiler again). The test hook makes
// a run take 1.5 s, so the requests really overlap.
describe("script_decompile parallel requests (CARDANO_DEBUG_TEST_DECOMPILE_DELAY_MS=1500)", () => {
  let client: StdioClient;
  let single: string;

  beforeAll(async () => {
    single = readFileSync(SAMPLE_SCRIPT, "utf8").trim();
    client = StdioClient.dist(process.execPath, { CARDANO_DEBUG_TEST_HOOKS: "1", CARDANO_DEBUG_TEST_DECOMPILE_DELAY_MS: "1500" });
    await client.initialize();
  });

  afterAll(async () => {
    const code = await client.close();
    expect(client.nonJsonStdout).toEqual([]);
    expect(code).toBe(0);
  });

  it("two parallel page requests run the decompiler once: one fresh answer, one served from that run", async () => {
    const [a, b] = await Promise.all([
      client.callTool<DecompileResult>("script_decompile", { script: single, plutus_version: "V2", purpose: "spend", lines: 5 }, 120_000),
      client.callTool<DecompileResult>("script_decompile", { script: single, plutus_version: "V2", purpose: "spend", from_line: 6, lines: 5 }, 120_000),
    ]);
    expect(a.isError, JSON.stringify(a.structuredContent)).toBeFalsy();
    expect(b.isError, JSON.stringify(b.structuredContent)).toBeFalsy();
    expect([a.structuredContent!.cached, b.structuredContent!.cached].sort()).toEqual([false, true]);
    expect(a.structuredContent!.elapsed_ms).toBe(b.structuredContent!.elapsed_ms);
    expect(a.structuredContent!.total_lines).toBe(b.structuredContent!.total_lines);
  });
});

// A script that times out burns its budget once, however many requests arrive while it runs.
describe("script_decompile parallel timeouts (CARDANO_DEBUG_DECOMPILE_TIMEOUT_MS=1)", () => {
  let client: StdioClient;
  let single: string;

  beforeAll(async () => {
    single = readFileSync(SAMPLE_SCRIPT, "utf8").trim();
    client = StdioClient.dist(process.execPath, { CARDANO_DEBUG_DECOMPILE_TIMEOUT_MS: "1", CARDANO_DEBUG_TEST_HOOKS: "1", CARDANO_DEBUG_TEST_DECOMPILE_DELAY_MS: "3000" });
    await client.initialize();
  });

  afterAll(async () => {
    const code = await client.close();
    expect(client.nonJsonStdout).toEqual([]);
    expect(code).toBe(0);
  });

  it("two parallel requests share one timeout: one worker loss, both answer decompile_failed", async () => {
    const args = { script: single, plutus_version: "V2", purpose: "spend" };
    const [a, b] = await Promise.all([client.callTool<{ code: string; failure: string }>("script_decompile", args, 60_000), client.callTool<{ code: string; failure: string }>("script_decompile", { ...args, from_line: 2 }, 60_000)]);
    for (const answer of [a, b]) {
      expect(answer.isError).toBe(true);
      expect(answer.structuredContent).toMatchObject({ code: "decompile_failed", failure: "timeout" });
    }
    expect(client.stderr.join("").match(/decompiler worker lost \(timeout\)/g)?.length).toBe(1);
  });
});
