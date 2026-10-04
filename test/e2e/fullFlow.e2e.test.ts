// Integration walk-through over stdio, one server process, offline (bundle-backed context):
//   cbor_decode -> tx_inspect -> tx_load(bundle) -> tx_validate -> tx_redeemer -> debug_open(tx_id, redeemer)
//   -> debug_profile -> debug_run(until error) -> debug_inspect(env/value) -> debug_source -> script_decompile
//   (dbg_id, paging; tx_id + script_hash) -> bundle_export -> tx_load(bundle path) -> debug_close,
// plus tx_load(tx_hash) + tx_validate against a local Koios stub (test/helpers/koiosStub.ts, rows of scenario s08: no network).
// Every tool response is measured: it must stay under RESPONSE_CHARS (~8k tokens), and stdout must
// carry only JSON-RPC. A second server with CARDANO_DEBUG_TEST_HOOKS=1 proves that a wasm trap in
// the lib worker is an ordinary tool error, not a dead server.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixturePath, fxArr, fxInt, fxStr, readTx } from "../helpers/fixtures.js";
import { loadProviderRows, startKoiosStub, type KoiosStub } from "../helpers/koiosStub.js";
import { hasNode20, McpTestClient, NODE20_BIN, PROJECT_ROOT, type ToolCallResult } from "../mcpClient.js";

type Json = Record<string, any>;

/** ~8k tokens. */
const RESPONSE_CHARS = 32_000;
const EXPECTED_TOOLS = [
  "bundle_export",
  "cbor_decode",
  "cbor_validate",
  "cddl_check",
  "debug_close",
  "debug_inspect",
  "debug_open",
  "debug_profile",
  "debug_run",
  "debug_source",
  "docs",
  "script_decompile",
  "script_locate",
  "tx_add_witnesses",
  "tx_inspect",
  "tx_load",
  "tx_redeemer",
  "tx_validate",
  "ui_link",
];
/** The artificial S1 sample: a DebuggerContext of the hub transaction (spend:2 on a V2 script, mint:1 on a V2 burn policy). */
const SAMPLE_BUNDLE = fixturePath(fxStr("s01.contextFile"));
const SAMPLE_TX_ID = fxStr("s01.txId");
const SAMPLE_SCRIPT_HASH = fxStr("s01.spendScript.hash");
const SPEND_CALCULATED = { steps: fxStr("s01.spend.exUnits.calculated.steps"), mem: fxStr("s01.spend.exUnits.calculated.mem") };
const LOCK_TX_ID = fxStr("s08.txId"); // scenario s08: a V2 reference-script spend (also the on-chain transaction the Koios stub serves)
const LOCK_TX_HASH = fxStr("s08.txHash");
const TRAP_MAGIC_HEX = "5f5f747261705f5f"; // "__trap__" — lib worker test hook

/** Records the text size of every tool response so the suite can assert the budget at the end. */
class MeasuredClient {
  readonly sizes: Array<{ call: string; chars: number; isError: boolean }> = [];
  constructor(readonly client: McpTestClient) {}

  async call(name: string, args: Json = {}, timeoutMs?: number): Promise<ToolCallResult<Json>> {
    const result = await this.client.callTool<Json>(name, args, timeoutMs);
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text, `${name}: text content missing`).not.toBe("");
    expect(JSON.parse(text)).toEqual(result.structuredContent);
    this.sizes.push({ call: `${name}(${Object.keys(args).join(",")})`, chars: text.length, isError: Boolean(result.isError) });
    return result;
  }

  async ok(name: string, args: Json = {}, timeoutMs?: number): Promise<Json> {
    const result = await this.call(name, args, timeoutMs);
    expect(result.isError, `${name} failed: ${JSON.stringify(result.structuredContent)}`).toBeFalsy();
    return result.structuredContent!;
  }
}

const variants: Array<{ label: string; nodeBin: string }> = [{ label: `node ${process.version}`, nodeBin: process.execPath }];
if (hasNode20()) variants.push({ label: "node v20.14.0", nodeBin: NODE20_BIN });

describe.each(variants)("full flow over stdio (offline bundle) — $label", ({ nodeBin }) => {
  let raw: McpTestClient;
  let m: MeasuredClient;
  let cacheDir: string;
  let txId: string;
  let dbgId: string;
  let bundlePath: string;

  beforeAll(async () => {
    expect(existsSync(path.join(PROJECT_ROOT, "dist", "server.js")), "run `npm run build` before the e2e tests").toBe(true);
    cacheDir = mkdtempSync(path.join(os.tmpdir(), "cdm-e2e-flow-"));
    raw = await McpTestClient.start({ nodeBin, env: { CARDANO_DEBUG_OFFLINE: "1", CARDANO_DEBUG_CACHE_DIR: cacheDir } });
    m = new MeasuredClient(raw);
  });

  afterAll(async () => {
    const code = await raw.close();
    expect(raw.nonJsonStdout, "stdout must carry only JSON-RPC").toEqual([]);
    expect(code).toBe(0);
  });

  it("lists exactly the 19 tools with flat object schemas", async () => {
    const { tools } = await raw.listTools();
    expect(tools).toHaveLength(19);
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    expect(JSON.stringify(tools).length, "tools/list catalogue under 45k characters (19 tools)").toBeLessThan(45_000);
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.anyOf, tool.name).toBeUndefined();
      expect(tool.inputSchema.oneOf, tool.name).toBeUndefined();
      expect(tool.description, tool.name).toBeTruthy();
    }
    const info = await raw.readResourceJson<Json>("cardano-debug://server/info");
    expect(info.tools ?? info.tool_count ?? EXPECTED_TOOLS.length).toBeTruthy();
  });

  it("cbor_decode decodes PlutusData and a whole transaction", async () => {
    const data = await m.ok("cbor_decode", { hex: "d8799f41aa02ff" });
    expect(data.as).toBe("PlutusData");
    expect(data.value.plutus_data).toMatchObject({ constructor: "0", fields: [{ bytes: "aa" }, { int: "2" }] });
    expect(data.value.data_hash).toMatch(/^[0-9a-f]{64}$/);
    const tx = await m.ok("cbor_decode", { hex: readTx("pool-mint.tx"), depth: 8 }); // scenario s07: two V3 witness scripts, inline datums
    expect(tx.as).toBe("Transaction");
    expect(tx.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tx_inspect on raw bytes creates a store record and pages sections", async () => {
    const pool = readTx("pool-mint.tx");
    const body = await m.ok("tx_inspect", { tx_cbor: pool, section: "body" });
    expect(body.tx_id).toMatch(/^tx_mainnet_[0-9a-f]{12}$/);
    const redeemers = await m.ok("tx_inspect", { tx_id: body.tx_id, section: "redeemers" });
    expect(redeemers.rows.length).toBeGreaterThan(0);
    const scripts = await m.ok("tx_inspect", { tx_id: body.tx_id, section: "scripts" });
    expect(scripts.rows.map((s: Json) => s.script_hash)).toEqual(expect.arrayContaining(fxArr<{ hash: string }>("s07.scripts").map((x) => x.hash)));
    const rawJson = await m.ok("tx_inspect", { tx_id: body.tx_id, section: "raw_json", depth: 6 });
    expect(rawJson.tx_id).toBe(body.tx_id);
  });

  it("tx_load(bundle) -> tx_validate -> tx_redeemer", async () => {
    const loaded = await m.ok("tx_load", { bundle: readFileSync(SAMPLE_BUNDLE, "utf8"), network: "mainnet" });
    txId = loaded.tx_id;
    expect(txId).toBe(SAMPLE_TX_ID);
    expect(loaded.source).toBe("bundle");
    expect(loaded.redeemers.map((r: Json) => r.ref)).toEqual(expect.arrayContaining(["spend:2", "mint:1"]));
    expect(loaded.missing_utxos).toEqual([]);

    const validated = await m.ok("tx_validate", { tx_id: txId });
    expect(validated.verdict).toBe(fxStr("s01.diagnostics.verdict")); // phase1_failed: the sample snapshot's fee, script data hash and a reference input that is also an input fail phase 1
    const spend = validated.phase2.redeemers.find((r: Json) => r.ref === "spend:2");
    expect(spend).toMatchObject({ success: true, script_hash: SAMPLE_SCRIPT_HASH, plutus_version: "V2" });
    expect(spend.ex_units.calculated).toEqual(SPEND_CALCULATED);
    const cached = await m.ok("tx_validate", { tx_id: txId });
    expect(cached.cached).toBe(true);

    const summary = await m.ok("tx_redeemer", { tx_id: txId, redeemer: "spend:2" });
    expect(summary).toMatchObject({ ref: "spend:2", success: true, purpose: "spend", index: 2 });
    const traces = await m.ok("tx_redeemer", { tx_id: txId, redeemer: "spend:2", part: "traces" });
    expect(typeof traces.total).toBe("number");
    const context = await m.ok("tx_redeemer", { tx_id: txId, redeemer: "spend:2", part: "context", path: "tx_info.inputs", depth: 3 });
    expect(context.path).toMatch(/inputs$/);
    const error = await m.ok("tx_redeemer", { tx_id: txId, redeemer: "Minting #1", part: "error" });
    expect(error.category).toBe("none");
    const validation = await raw.readResourceJson<Json>(`cardano-debug://tx/${txId}/validation.json`);
    expect(validation).toBeTruthy();
  });

  it("debug_open(tx_id, redeemer) -> debug_profile -> debug_run -> debug_inspect -> debug_source", async () => {
    const opened = await m.ok("debug_open", { tx_id: txId, redeemer: "spend:2" });
    dbgId = opened.dbg_id;
    expect(opened).toMatchObject({ mode: "tx", tx_id: txId, redeemer: "spend:2", script_hash: SAMPLE_SCRIPT_HASH, plutus_version: "V2", purpose: "spend" });
    expect(opened.applied).toEqual(["datum", "redeemer", "context"]);
    expect(opened.cost_model_source).toBe("protocol_params");
    expect(opened.docs_hint).toBe("docs(topic='debug-playbook') and docs(topic='uplc-cek') explain the workflow and the machine states; script_decompile(dbg_id) gives the validator's logic as readable pseudocode");

    const profile = await m.ok("debug_profile", { dbg_id: dbgId, top: 10 });
    expect(profile.outcome).toBe("done");
    expect(profile.totals.cpu).toBe(SPEND_CALCULATED.steps);
    expect(profile.hot_terms.length).toBeGreaterThan(0);
    expect(profile.hot_terms.length).toBeLessThanOrEqual(10);

    const run = await m.ok("debug_run", { dbg_id: dbgId, until: "error", restart: true });
    expect(run.status).toBe("done");
    expect(run.stopped.kind).toBe("done");
    expect(run.parity).toMatchObject({ match: true, stepper_spent: { cpu: SPEND_CALCULATED.steps, mem: SPEND_CALCULATED.mem } });

    const partial = await m.ok("debug_run", { dbg_id: dbgId, until: "steps", steps: 300, restart: true });
    expect(partial.status).toBe("ready");
    expect(partial.steps_total).toBe(300);
    // the environment of the artificial script is still empty after 300 transitions; it is read where the manifest measured it (UPLC line 12)
    const atLine = await m.ok("debug_run", { dbg_id: dbgId, until: "uplc_line", line: fxInt("s01.debug.spend.envAtLine12.line"), restart: true });
    expect(atLine.stopped.kind).toBe("uplc_line");
    const env = await m.ok("debug_inspect", { dbg_id: dbgId, what: "env", limit: 20 });
    expect(env.total).toBe(fxInt("s01.debug.spend.envAtLine12.total"));
    expect(env.items[0]).toHaveProperty("ref");
    const value = await m.ok("debug_inspect", { dbg_id: dbgId, what: "value", path: env.items[0].ref, depth: 2 });
    expect(value.ref).toBe(env.items[0].ref);
    const frames = await m.ok("debug_inspect", { dbg_id: dbgId, what: "frames" });
    expect(frames.total).toBeGreaterThanOrEqual(0);
    const ctx = await m.ok("debug_inspect", { dbg_id: dbgId, what: "context", path: "tx_info", depth: 1 });
    expect(ctx.path).toContain("tx_info");

    const source = await m.ok("debug_source", { dbg_id: dbgId });
    expect(source).not.toHaveProperty("view");
    expect(source.text).toMatch(/^\s*\d+>/m);
    const wide = await m.ok("debug_source", { dbg_id: dbgId, with_ids: true, radius: 200, max_chars: 24_000 });
    expect(Array.isArray(wide.lines)).toBe(true);
    const located = await m.ok("script_locate", { dbg_id: dbgId, uplc_line: source.current.line });
    expect(located.uplc.line).toBe(source.current.line);
    expect(located.candidates.map((c: { term_id: number }) => c.term_id)).toContain(source.current.term_id);
    expect(located).not.toHaveProperty("mapping");
    const uplc = await raw.readResource(`cardano-debug://session/${dbgId}/uplc.txt?offset=0&limit=5`);
    expect(uplc.contents[0]!.text!.split("\n").length).toBeLessThanOrEqual(5);
  });

  it("script_decompile by dbg_id (paged) and by tx_id + script_hash", async () => {
    const page1 = await m.ok("script_decompile", { dbg_id: dbgId });
    expect(page1).toMatchObject({ script_hash: SAMPLE_SCRIPT_HASH, plutus_version: "V2", from_line: 1, view: "pseudocode" });
    expect(page1.total_lines).toBeGreaterThan(120);
    expect(page1.next_from_line).toBe(page1.to_line + 1);
    expect(page1.code).toMatch(/^\s*1\s/);
    const page2 = await m.ok("script_decompile", { dbg_id: dbgId, from_line: page1.next_from_line });
    expect(page2.from_line).toBe(page1.next_from_line);
    expect(page2.cached).toBe(true);
    const uplc = await m.ok("script_decompile", { dbg_id: dbgId, view: "uplc", lines: 600 });
    expect(uplc.view).toBe("uplc");
    expect(uplc.page_cut).toBe(true); // 600 UPLC lines do not fit the page budget
    expect(uplc.to_line).toBeLessThan(600);
    expect(uplc.next_from_line).toBe(uplc.to_line + 1);
    const byTx = await m.ok("script_decompile", { tx_id: txId, script_hash: SAMPLE_SCRIPT_HASH, lines: 30 });
    expect(byTx.source).toMatch(/^tx: /);
    expect(byTx.to_line).toBe(30);
    const pseudo = await raw.readResourceText(`cardano-debug://script/${SAMPLE_SCRIPT_HASH}/pseudocode.txt?offset=0&limit=3`);
    expect(pseudo.split("\n").length).toBeLessThanOrEqual(3);
  });

  it("resources answer from the stores: tx-scoped script bytes, redeemer artefacts, session state, epoch params offline", async () => {
    const bytes = await raw.readResourceText(`cardano-debug://tx/${txId}/script/${SAMPLE_SCRIPT_HASH}/bytes.hex`);
    expect(bytes.startsWith(fxStr("s01.spendScript.prefix"))).toBe(true); // the reference script, resolved through the validation / chain state
    const parts = await raw.readResourceJson<Json>(`cardano-debug://tx/${txId}/redeemer/spend:2/parts.json`);
    expect(parts.language).toBe("v2");
    const state = await raw.readResourceJson<Json>(`cardano-debug://session/${dbgId}/state.json`);
    expect(state).toMatchObject({ dbg_id: dbgId, mode: "tx", tx_id: txId });
    const epoch = await raw.readResourceJson<Json>("cardano-debug://chain/mainnet/epoch_params");
    expect(epoch.protocol_major).toBe(10);
    expect(epoch.source).toContain(txId);
    const bundle = await raw.readResource(`cardano-debug://tx/${txId}/bundle.json`);
    expect(bundle.contents[0]!.text!.length).toBeGreaterThan(10_000);
    const window = await raw.readResource(`cardano-debug://tx/${txId}/redeemer/spend:2/context.json?offset=0&limit=4`);
    expect(window.contents[0]!.text!.split("\n").length).toBeLessThanOrEqual(4);
    expect(window.contents[0]!._meta).toMatchObject({ offset: 0, limit: 4 });
  });

  it("listing and report resources page: uplc.txt in compacted 400-line windows, profile.json by lines", async () => {
    const listing = await raw.readResource(`cardano-debug://session/${dbgId}/uplc.txt`);
    const first = listing.contents[0]!;
    const meta = first._meta as Json;
    expect(meta.total_lines).toBeGreaterThan(400);
    expect(meta).toMatchObject({ offset: 0, limit: 400, lines_returned: 400, next_offset: 400 });
    expect(first.text!.split("\n")).toHaveLength(400);
    const indents = first.text!.split("\n").map((l) => l.length - l.trimStart().length);
    expect(Math.max(...indents)).toBeLessThanOrEqual(64);
    expect(first.text!.length).toBeLessThan(40_000); // was hundreds of kB of leading spaces
    const deep = await raw.readResource(`cardano-debug://session/${dbgId}/uplc.txt?offset=${meta.total_lines - 50}&limit=50`);
    expect(deep.contents[0]!.text!.split("\n")).toHaveLength(50);
    expect(typeof (deep.contents[0]!._meta as Json).dedent).toBe("number");

    await m.ok("debug_profile", { dbg_id: dbgId, top: 5 });
    const profile = await raw.readResource(`cardano-debug://session/${dbgId}/profile.json?offset=0&limit=10`);
    expect((profile.contents[0]!._meta as Json).total_lines).toBeGreaterThan(10);
    expect(profile.contents[0]!.text!.split("\n")).toHaveLength(10);
    expect(profile.contents[0]!.text!.length).toBeLessThan(2_000);
    const wholeText = (await raw.readResource(`cardano-debug://session/${dbgId}/profile.json`)).contents[0]!.text!;
    const whole = JSON.parse(wholeText) as Json;
    expect(whole).toBeTruthy();
    // One row per line: about the compact size (a key-per-line pretty print was ~40% larger), one line per term row.
    expect(wholeText.length).toBeLessThan(JSON.stringify(whole).length * 1.1);
    const rows = ["terms", "builtins", "steps", "timeline", "traces"].reduce((n, k) => n + (Array.isArray(whole[k]) ? whole[k].length : 0), 0);
    expect(wholeText.split("\n").length).toBeLessThanOrEqual(rows + 20);
    const termLine = wholeText.split("\n").find((l) => l.includes('"termId"'))!;
    expect(JSON.parse(termLine.trim().replace(/,$/, ""))).toHaveProperty("termId");
    const state = await raw.readResource(`cardano-debug://session/${dbgId}/state.json`);
    expect(state.contents[0]!.text!.split("\n").length).toBeGreaterThan(5);
  });

  it("bundle_export writes a replayable bundle; debug_close frees the session", async () => {
    const exported = await m.ok("bundle_export", { tx_id: txId });
    bundlePath = exported.path;
    expect(existsSync(bundlePath)).toBe(true);
    expect(exported.includes_validation).toBe(true);
    const replay = await m.ok("tx_load", { bundle: bundlePath });
    expect(replay).toMatchObject({ tx_id: txId, source: "bundle", validated: true });

    const closed = await m.ok("debug_close", { dbg_id: dbgId });
    expect(closed.closed).toEqual([dbgId]);
    const gone = await m.call("debug_run", { dbg_id: dbgId, until: "done" });
    expect(gone.isError).toBe(true);
    expect(gone.structuredContent).toMatchObject({ code: "expired_handle", recreate_with: "debug_open" });
  });

  it("every tool response stayed under the ~8k-token budget", () => {
    expect(m.sizes.length).toBeGreaterThan(25);
    const over = m.sizes.filter((s) => s.chars >= RESPONSE_CHARS);
    expect(over, JSON.stringify(over)).toEqual([]);
  });
});

describe("full flow over stdio — tx_hash against a local Koios stub (scenario s08 rows, no network)", () => {
  let raw: McpTestClient;
  let m: MeasuredClient;
  let stub: KoiosStub;

  beforeAll(async () => {
    stub = await startKoiosStub(loadProviderRows(fxStr("s08.providerRows")));
    raw = await McpTestClient.start({ env: { ...stub.env, CARDANO_DEBUG_CACHE_DIR: mkdtempSync(path.join(os.tmpdir(), "cdm-e2e-flow-stub-")) } });
    m = new MeasuredClient(raw);
  });

  afterAll(async () => {
    if (raw) {
      const code = await raw.close();
      expect(raw.nonJsonStdout).toEqual([]);
      expect(code).toBe(0);
    }
    await stub?.close();
  });

  it("tx_load(tx_hash, mainnet) -> tx_validate -> tx_inspect(inputs) within budget", async () => {
    const loaded = await m.call("tx_load", { tx_hash: LOCK_TX_HASH, network: "mainnet" }, 120_000);
    expect(loaded.isError, JSON.stringify(loaded.structuredContent)).toBeFalsy();
    const s = loaded.structuredContent!;
    expect(s).toMatchObject({ tx_id: LOCK_TX_ID, source: "provider", network: "mainnet" });
    expect(s.context).toMatchObject({ status: "fetched", provider: "koios", utxos_resolved: fxInt("s08.utxoCount") });
    const validated = await m.ok("tx_validate", { tx_id: s.tx_id }, 120_000);
    expect(validated.verdict).toBeTruthy();
    expect(validated.phase2.redeemers[0]).toMatchObject({ ref: "spend:1", success: true });
    const inputs = await m.ok("tx_inspect", { tx_id: s.tx_id, section: "inputs" });
    expect(inputs.rows[0]).toHaveProperty("resolved");
    const redeemer = await m.ok("tx_redeemer", { tx_id: s.tx_id, redeemer: "spend:1" });
    expect(redeemer.success).toBe(true);
    expect(stub.count("/utxo_info")).toBeGreaterThan(0);
    const over = m.sizes.filter((x) => x.chars >= RESPONSE_CHARS);
    expect(over, JSON.stringify(over)).toEqual([]);
  });
});

describe("resilience: a wasm trap in the lib worker is a tool error, not a dead server", () => {
  let raw: McpTestClient;
  let m: MeasuredClient;

  beforeAll(async () => {
    raw = await McpTestClient.start({ env: { CARDANO_DEBUG_OFFLINE: "1", CARDANO_DEBUG_TEST_HOOKS: "1", CARDANO_DEBUG_CACHE_DIR: mkdtempSync(path.join(os.tmpdir(), "cdm-e2e-trap-")) } });
    m = new MeasuredClient(raw);
  });

  afterAll(async () => {
    const code = await raw.close();
    expect(raw.nonJsonStdout).toEqual([]);
    expect(code).toBe(0);
  });

  it("cbor_decode on the trapping input answers wasm_trap and the next call succeeds", async () => {
    const trapped = await m.call("cbor_decode", { hex: TRAP_MAGIC_HEX, as: "raw" });
    expect(trapped.isError).toBe(true);
    expect(trapped.structuredContent).toMatchObject({ code: "wasm_trap" });
    expect(trapped.structuredContent!.message).toMatch(/unreachable/);

    const fine = await m.ok("cbor_decode", { hex: "d8799f41aa02ff" });
    expect(fine.as).toBe("PlutusData");
    const again = await m.call("cbor_decode", { hex: TRAP_MAGIC_HEX, as: "raw" });
    expect(again.structuredContent).toMatchObject({ code: "wasm_trap" });
    const tx = await m.ok("tx_inspect", { tx_cbor: readTx("lock-spend.tx"), section: "body" });
    expect(tx.tx_id).toBe(LOCK_TX_ID);

    const info = await raw.readResourceJson<Json>("cardano-debug://server/info");
    expect(info.lib_worker.total_respawns).toBeGreaterThanOrEqual(2);
    expect(raw.stderrText()).toMatch(/worker lib#\d+ lost \(fatal_error\): RuntimeError: unreachable/);
    expect(await raw.ping()).toEqual({});
  });
});
