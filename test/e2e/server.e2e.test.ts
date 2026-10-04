// End-to-end over stdio through the reusable harness (test/mcpClient.ts): legacy initialize
// handshake, tools/list, cbor_decode, tx_inspect, resources, prompts — against dist/server.js on
// the current node, on Node 20 when installed, and on `tsx src/server.ts` with CARDANO_DEBUG_E2E_DEV=1.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fx, fxArr, fxBig, fxInt, fxStr, readTx } from "../helpers/fixtures.js";
import { JsonRpcRemoteError, serverVariants, type McpTestClient } from "../mcpClient.js";

const readFixture = readTx;
// Fresh disk cache per run: the "not yet available" resource expectations below must not see epoch
// parameters or UTxO rows a previous live session left in ~/.cache/cardano-debug-mcp.
const CACHE_DIR = mkdtempSync(path.join(os.tmpdir(), "cdm-e2e-server-"));

describe.each(serverVariants({ env: { CARDANO_DEBUG_CACHE_DIR: CACHE_DIR } }))("cardano-debug over stdio — $label", ({ start }) => {
  let client: McpTestClient;

  beforeAll(async () => {
    client = await start();
    const init = client.initializeResult!;
    expect(init.serverInfo.name).toBe("cardano-debug");
    expect(init.protocolVersion).toBe("2025-06-18");
    // the primer: routing only (which tool when, which doc to read), most important first. Hosts cut
    // server instructions (Claude Code keeps 2048 characters); the cap here is 1,600.
    const primer = init.instructions!;
    expect(primer.length, "primer size budget (src/server.ts: <= 1600)").toBeLessThanOrEqual(1_600);
    expect(primer).toContain("tx_load (tx_cbor | tx_hash | bundle");
    expect(primer).toMatch(/script_decompile\(tx_id, script_hash\) FIRST.*debug_open/);
    expect(primer).toContain("expired_handle");
    expect(primer).toMatch(/recreate_with/);
    expect(primer).toMatch(/<purpose>:<index>/);
    expect(primer).toMatch(/\{term_id, uplc_line\}/);
    expect(primer).toMatch(/decimal strings/);
    expect(primer).toContain("docs(error=<Name>)");
    expect(primer).toMatch(/cbor_validate\(hex, cddl=<era preset \| schema>, rule\?\)/);
    for (const topic of ["debug-playbook", "tx-anatomy", "script-context", "uplc-cek", "cbor-cddl", "tools"]) expect(primer).toContain(topic);
    // the order: the debugging flow before the doc routing
    expect(primer.indexOf("Why a tx fails:")).toBeLessThan(primer.indexOf("Read docs before guessing"));
  });

  afterAll(async () => {
    const code = await client.close();
    expect(client.nonJsonStdout, "stdout must carry only JSON-RPC").toEqual([]);
    expect(code).toBe(0);
  });

  it("lists the tools with flat object input schemas", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("cbor_decode");
    expect(names).toContain("tx_inspect");
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.anyOf).toBeUndefined();
      expect(tool.inputSchema.oneOf).toBeUndefined();
    }
    const cbor = tools.find((t) => t.name === "cbor_decode")!;
    expect(cbor._meta?.["anthropic/maxResultSizeChars"]).toBe(120_000);
    expect(cbor.annotations?.readOnlyHint).toBe(true);
    // Only the windowed text tools raise the host's result-size threshold; a value
    // below the host default on any other tool would make it spill to a file earlier.
    const sized = tools.filter((t) => t._meta?.["anthropic/maxResultSizeChars"] !== undefined).map((t) => [t.name, t._meta!["anthropic/maxResultSizeChars"]]);
    expect(Object.fromEntries(sized)).toEqual({ cbor_decode: 120_000, debug_source: 150_000, docs: 120_000, script_decompile: 200_000 });
    expect(names).toContain("cbor_validate");
    expect(names).toContain("cddl_check");
    expect(tools).toHaveLength(19);
    expect(JSON.stringify(tools).length, "tools/list catalogue must stay under 30k characters (19 tools)").toBeLessThanOrEqual(30_000);
  });

  it("reports the model-facing text budgets per item type (max, cap, headroom) and keeps each under its cap", async () => {
    const { tools } = await client.listTools();
    const index = await client.callTool<{ topics: Array<{ topic: string }> }>("docs", {});
    const sections: number[] = [];
    const indexes: number[] = [];
    for (const { topic } of index.structuredContent!.topics) {
      const t = await client.callTool<{ sections: Array<{ section: string; chars: number }> }>("docs", { topic });
      indexes.push((await client.readResource(`cardano-debug://docs/${topic}`)).contents[0]!.text!.length);
      for (const s of t.structuredContent!.sections) sections.push(s.chars);
    }
    const prompts: number[] = [];
    for (const [name, args] of [["debug_tx", { tx: "x" }], ["explain_script", { script: "x" }], ["diagnose_cbor", { hex: "x" }], ["replay_bundle", { bundle: "x" }]] as const) {
      prompts.push((await client.getPrompt(name, args)).messages[0]!.content.text!.length);
    }
    const descriptions = tools.map((t) => t.description!.length);
    const params = tools.flatMap((t) => Object.values((t.inputSchema.properties ?? {}) as Record<string, { description?: string }>).map((p) => p.description?.length ?? 0));
    const rows: Array<[string, number, number, number]> = [
      ["server instructions", 1, client.initializeResult!.instructions!.length, 1_600],
      ["tools/list catalogue", 1, JSON.stringify(tools).length, 30_000],
      ["tool description", descriptions.length, Math.max(...descriptions), 600],
      ["parameter description", params.length, Math.max(...params), 300],
      ["doc section (served)", sections.length, Math.max(...sections), 2_500],
      ["topic index (resource)", indexes.length, Math.max(...indexes), 5_000],
      ["rendered prompt", prompts.length, Math.max(...prompts), 3_500],
    ];
    const table = rows.map(([what, n, max, cap]) => `${what.padEnd(24)} n=${String(n).padStart(3)}  max ${String(max).padStart(6)} / ${String(cap).padStart(6)}  headroom ${String(cap - max).padStart(5)}`);
    console.info(`model-facing text budgets:\n${table.join("\n")}`);
    for (const [what, , max, cap] of rows) expect(max, what).toBeLessThanOrEqual(cap);
  });

  it("docs: index, a topic index, a section, an error entry, a query and the resources", async () => {
    const TOPICS = ["tx-anatomy", "script-context", "uplc-cek", "validation-errors", "debug-playbook", "cbor-cddl", "tools"];
    const { tools } = await client.listTools();
    const docs = tools.find((t) => t.name === "docs")!;
    expect(docs.description).toMatch(/validation-errors/);
    expect(docs.description).toMatch(/cbor-cddl/);
    expect(docs.description).toMatch(/BEFORE guessing/);
    expect((docs.inputSchema.properties!.topic as { enum: string[] }).enum).toEqual(TOPICS);
    expect(Object.keys(docs.inputSchema.properties!)).toEqual(["topic", "section", "error", "query"]);
    expect(docs.inputSchema.required ?? []).toEqual([]);

    const measured = async (args: Record<string, unknown>) => {
      const result = await client.callTool<Record<string, any>>("docs", args);
      const text = result.content.find((c) => c.type === "text")!.text!;
      expect(text.length, `docs(${JSON.stringify(args)})`).toBeLessThan(30_000);
      // a section answers its markdown once (text) and metadata in structuredContent; every other shape mirrors JSON
      if (args.section !== undefined && args.query === undefined && !result.isError) expect(text.startsWith("# ")).toBe(true);
      else expect(JSON.parse(text)).toEqual(result.structuredContent);
      return result;
    };

    const index = await measured({});
    expect(index.structuredContent!.topics.map((t: { topic: string }) => t.topic)).toEqual(TOPICS);
    expect(index.structuredContent!.error_names).toBe(127);

    for (const topic of TOPICS) {
      const t = await measured({ topic });
      expect(t.isError, topic).toBeFalsy();
      const sections = t.structuredContent!.sections as Array<{ section: string; title: string; gist: string; chars: number }>;
      expect(sections.length, topic).toBeGreaterThanOrEqual(7);
      for (const s of sections) {
        expect(s.gist.length, `${topic}/${s.section}`).toBeGreaterThan(30);
        expect(s.chars, `${topic}/${s.section}`).toBeLessThanOrEqual(2_500);
      }
      const resource = await client.readResource(`cardano-debug://docs/${topic}`);
      expect(resource.contents[0]!.mimeType).toBe("text/markdown");
      for (const s of sections) expect(resource.contents[0]!.text).toContain(`- ${s.section}: ${s.title}`);
    }

    const section = await measured({ topic: "uplc-cek", section: "the cek machine" });
    expect(section.structuredContent!.section).toBe("cek-machine");
    const markdown = section.content.find((c) => c.type === "text")!.text!;
    expect(markdown).toMatch(/^# The CEK machine/);
    expect(markdown).toMatch(/Compute/);
    const sectionResource = await client.readResource(section.structuredContent!.resource);
    expect(sectionResource.contents[0]!.text).toBe(markdown);
    expect((await client.readResource("cardano-debug://docs/uplc-cek/5")).contents[0]!.text).toBe(markdown);
    const windowed = await client.readResource("cardano-debug://docs/uplc-cek/cek-machine?offset=0&limit=1");
    expect(windowed.contents[0]!.text).toBe("# The CEK machine: states, environment, frames");

    const missing = await measured({ topic: "tx-anatomy", section: "no such thing" });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent!.code).toBe("invalid_argument");
    expect(missing.structuredContent!.available).toContain("collateral");

    const entry = await measured({ error: "NoEnoughBudget" });
    expect(entry.structuredContent).toMatchObject({ name: "NoEnoughBudget", phase: 2, kind: "error" });

    const query = await measured({ query: "NoEnoughBudget" });
    expect(query.structuredContent!.total_matches).toBeGreaterThan(0);
    expect(query.structuredContent!.blocks.some((b: { topic: string }) => b.topic === "validation-errors")).toBe(true);
    expect(query.structuredContent!.blocks[0].text).toMatch(/^(> |  )/m);
    expect(query.structuredContent!.errors.names).toContain("NoEnoughBudget");

    const indexResource = await client.readResource("cardano-debug://docs");
    expect(indexResource.contents[0]!.mimeType).toBe("text/markdown");
    expect(indexResource.contents[0]!.text).toMatch(/^# cardano-debug built-in docs/);
    for (const topic of TOPICS) expect(indexResource.contents[0]!.text).toContain(`- ${topic}: `);
    for (const uri of ["cardano-debug://docs/nope", "cardano-debug://docs/uplc-cek/no-such-section"]) {
      const unknown = await client.readResource(uri).catch((e: unknown) => e);
      expect(unknown, uri).toBeInstanceOf(JsonRpcRemoteError);
    }
  });

  it("cbor_decode: auto-detects PlutusData; integers are decimal strings; text == structuredContent", async () => {
    const result = await client.callTool<{ as: string; hash: string; value: { plutus_data: unknown }; candidates: string[]; input_kind: string; input_bytes: number }>("cbor_decode", {
      hex: "d8799f41aa02ff",
    });
    expect(result.isError).toBeFalsy();
    const s = result.structuredContent!;
    expect(s.as).toBe("PlutusData");
    expect(s.candidates).toEqual(["PlutusData"]);
    expect(s.input_kind).toBe("hex");
    expect(s.input_bytes).toBe(7);
    expect(s.hash).toBe("2edb6ba57bf6286ba7d49f00afc1e6636b83c31cce46effef2c0a6a478bbc398");
    expect(s.value.plutus_data).toEqual({ constructor: "0", fields: [{ bytes: "aa" }, { int: "2" }] });
    expect(JSON.parse(result.content[0]!.text!)).toEqual(s);

    // a u64-max and a bignum survive as exact decimal strings
    const big = await client.callToolOk<{ value: { plutus_data: { fields: Array<{ int: string }> } } }>("cbor_decode", {
      hex: "d8799f1bffffffffffffffffc24901ffffffffffffffffff",
      as: "plutusdata", // case-insensitive type name
    });
    expect(big.value.plutus_data.fields.map((f) => f.int)).toEqual(["18446744073709551615", "36893488147419103231"]);

    const basic = await client.callToolOk<{ value: { plutus_data: unknown } }>("cbor_decode", { hex: "d8799f41aa02ff", schema: "basic" });
    expect(basic.value.plutus_data).toEqual({ constructor: "0", fields: ["0xaa", "2"] });
  });

  it("cbor_decode: raw tree with oddities, untyped bytes -> structural + closest_schema, bech32 / base64 / envelope inputs, refusal, bad type, bad path", async () => {
    const raw = await client.callToolOk<{ as: string; oddities: Array<{ kind: string; offset: number }>; value: { type: string; value: string; at: { offset: number; length: number } } }>("cbor_decode", {
      hex: "1800",
      as: "raw",
    });
    expect(raw.as).toBe("raw");
    expect(raw.value.type).toBe("U8");
    expect(raw.value.value).toBe("0");
    expect(raw.value.at).toBe("0+2");
    expect(raw.oddities[0]?.kind).toBe("IntNotShortest");

    // the cddl:<rule> mode is gone: it points at cbor_validate
    const gone = await client.callTool<{ code: string; message: string }>("cbor_decode", { hex: "d8799f41aa02ff", as: "cddl:transaction" });
    expect(gone.isError).toBe(true);
    expect(gone.structuredContent!.code).toBe("invalid_argument");
    expect(gone.structuredContent!.message).toMatch(/cbor_validate/);

    // a map nobody types (key 99): the positional tree, the structural shape and the closest Conway root
    const untyped = await client.callToolOk<{ as: string; candidates: string[]; structural: { ok: boolean; root: string; root_kind: string }; closest_schema: { schema: string; rule: string; valid: boolean; head: { kind: string; path: string } }; hints: string[] }>("cbor_decode", {
      hex: "a1186300",
    });
    expect(untyped.as).toBe("PlutusData"); // PlutusData accepts any map: a typed decoder wins
    const nobody = await client.callToolOk<{ as: string; candidates: string[]; structural: { ok: boolean; root: string; root_kind: string }; closest_schema: { schema: string; rule: string; valid: boolean; candidates_tried: number; head?: { kind: string; path: string } }; hints: string[] }>("cbor_decode", {
      hex: "84a1186300a0f4f6", // [ {99: 0}, {}, false, null ]: a transaction with an unknown body key
    });
    expect(nobody.as).toBe("raw");
    expect(nobody.candidates).toEqual([]);
    expect(nobody.structural).toMatchObject({ ok: true, root: "array(4 items)", root_kind: "array" });
    expect(nobody.closest_schema.schema).toBe("preset:conway");
    expect(nobody.closest_schema.rule).toBe("transaction");
    expect(nobody.closest_schema.valid).toBe(false);
    expect(nobody.closest_schema.head).toMatchObject({ kind: "mismatch", path: "$[0][99]", message: "unexpected key 99" }); // the entry's path
    expect(nobody.hints.join(" ")).toMatch(/Key 99 is not allowed/);
    expect(nobody.hints.join(" ")).toMatch(/Required map key 0 is missing/);

    const addr = await client.callToolOk<{ input_kind: string; as: string; value: { address_type: string; details: { network_id: string; payment_cred: { type: string; credential: string } } } }>("cbor_decode", {
      hex: fxStr("s11.scriptAddress"),
    });
    expect(addr.input_kind).toBe("bech32");
    expect(addr.as).toBe("Address");
    expect(addr.value.address_type).toBe("Enterprise");
    expect(addr.value.details.network_id).toBe("1");
    expect(addr.value.details.payment_cred).toEqual({ type: "ScriptHash", credential: fxStr("s11.scriptHash") });

    const b64 = await client.callToolOk<{ input_kind: string; as: string }>("cbor_decode", { hex: Buffer.from("d8799f41aa02ff", "hex").toString("base64") });
    expect(b64.input_kind).toBe("base64");
    expect(b64.as).toBe("PlutusData");

    // cardano-cli envelope: the type carries the Plutus version -> exact script hash
    const pool = readFixture("pool-mint.tx"); // scenario s07: two V3 witness scripts
    const scripts = await client.callToolOk<{ tx_id: string; rows: Array<{ script_hash: string; plutus_version: string }> }>("tx_inspect", { tx_cbor: pool, section: "scripts" });
    const hex = await client.readResourceText(`cardano-debug://script/${scripts.rows[0]!.script_hash}/bytes.hex`);
    const envelope = JSON.stringify({ type: "PlutusScriptV3", description: "", cborHex: hex });
    const script = await client.callToolOk<{ input_kind: string; envelope_type: string; as: string; plutus_version: string; hash: string; notes: string[] }>("cbor_decode", { hex: envelope });
    expect(script.input_kind).toBe("cli_envelope");
    expect(script.envelope_type).toBe("PlutusScriptV3");
    expect(script.as).toBe("PlutusScript");
    expect(script.plutus_version).toBe("V3");
    expect(script.hash).toBe(scripts.rows[0]!.script_hash);
    expect(script.notes.join(" ")).toMatch(/taken from the cardano-cli envelope/);

    const deep = await client.callTool<{ code: string; refusal: string }>("cbor_decode", { hex: "81".repeat(300) + "00", as: "PlutusData" });
    expect(deep.isError).toBe(true);
    expect(deep.structuredContent!.code).toBe("unexamined");
    expect(deep.structuredContent!.refusal).toMatch(/supported limit of 64 levels for typed decoding/);

    const deepRaw = await client.callToolOk<{ as: string; truncated: boolean; depth: number }>("cbor_decode", { hex: "81".repeat(300) + "00", as: "raw", depth: 2 });
    expect(deepRaw.as).toBe("raw");
    expect(deepRaw.depth).toBeLessThanOrEqual(2);

    const bad = await client.callTool<{ code: string; similar: string[] }>("cbor_decode", { hex: "d8799f41aa02ff", as: "Plutus" });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent!.code).toBe("invalid_argument");
    expect(bad.structuredContent!.similar).toContain("PlutusData");

    const wrongPath = await client.callTool<{ code: string; available: string[] }>("cbor_decode", { hex: "d8799f41aa02ff", path: "/plutus_data/nope" });
    expect(wrongPath.structuredContent!.code).toBe("path_not_found");
    expect(wrongPath.structuredContent!.available).toContain("fields");

    const garbage = await client.callTool<{ code: string }>("cbor_decode", { hex: "hello world!" });
    expect(garbage.isError).toBe(true);
    expect(garbage.structuredContent!.code).toBe("invalid_argument");
  });

  it("tx_inspect: tx_cbor creates a tx_id; sections page, enrich and link resources", async () => {
    const tx = readFixture("lock-spend.tx"); // scenario s08: a V2 reference-script spend (Spend 1, three vkeys, metadata)
    const body = await client.callTool<{
      tx_id: string;
      tx_hash: string;
      network: string;
      created: boolean;
      rows: Array<Record<string, unknown>>;
      resources: Array<{ uri: string }>;
      defaults_applied: string[];
    }>("tx_inspect", { tx_cbor: tx, section: "body" });
    expect(body.isError).toBeFalsy();
    const s = body.structuredContent!;
    const txId = s.tx_id;
    expect(txId).toBe(fxStr("s08.txId"));
    expect(s.created).toBe(true);
    expect(s.tx_hash).toBe(fxStr("s08.txHash"));
    expect(s.defaults_applied[0]).toMatch(/network=mainnet/);
    const summary = s.rows[0]!;
    expect(summary.fee).toBe(String(fxBig("s08.fee")));
    expect(summary.chain_context).toBe("none");
    expect((summary.validity as { start: string | null; end: string | null }).end).toBeDefined();
    expect((summary.counts as Record<string, number>).redeemers).toBe(1);
    expect((summary.counts as Record<string, number>).reference_inputs).toBe(1);
    expect(s.resources.map((r) => r.uri)).toContain(`cardano-debug://tx/${txId}/decoded.json`);
    expect(s.resources.map((r) => r.uri)).not.toContain(`cardano-debug://tx/${txId}/validation.json`);
    // resource links have one carrier: the `resources` array of the JSON, no resource_link blocks
    expect(body.content.map((c) => c.type)).toEqual(["text"]);
    expect(JSON.parse(body.content[0]!.text!)).toEqual(s);

    const again = await client.callToolOk<{ created?: boolean }>("tx_inspect", { tx_cbor: tx, section: "body" });
    expect(again.created).toBeUndefined();
    // section is optional (default body); the other sections do not repeat the resource list
    const defaulted = await client.callToolOk<{ section: string; rows: unknown[]; resources?: unknown }>("tx_inspect", { tx_id: txId });
    expect(defaulted).toMatchObject({ section: "body" });
    expect(defaulted.rows).toHaveLength(1);

    const redeemers = await client.callToolOk<{ rows: Array<{ ref: string; target: string; witness_index: number; ex_units: { mem: string; steps: string }; data: unknown; script_hash?: string }>; note?: string }>("tx_inspect", {
      tx_id: txId,
      section: "redeemers",
    });
    expect(redeemers.rows).toHaveLength(1);
    const r = redeemers.rows[0]!;
    expect(r.ref).toBe("spend:1");
    expect(r.witness_index).toBe(0);
    expect(r.target).toMatch(/^input [0-9a-f]{64}#\d+$/);
    expect(r.ex_units).toEqual({ mem: String(fx("s08.redeemer.mem")), steps: String(fx("s08.redeemer.steps")) });
    expect(r.data).toEqual({ constructor: "1", fields: [] });
    expect(r.script_hash).toBeUndefined();
    expect(redeemers.note).toMatch(/spend redeemers show script_hash/);

    const inputs = await client.callToolOk<{ total: number; rows: Array<{ role: string; utxo: string; spend_index?: number; redeemer?: string; resolved?: unknown }>; note?: string; resources?: unknown }>("tx_inspect", { tx_id: txId, section: "inputs" });
    expect(inputs.resources).toBeUndefined(); // only body lists the handle's resources
    const spendRow = inputs.rows.find((row) => row.redeemer === "spend:1");
    expect(spendRow?.role).toBe("input");
    expect(spendRow?.spend_index).toBe(1);
    expect(spendRow?.resolved).toBeUndefined();
    expect(inputs.rows.some((row) => row.role === "reference")).toBe(true);
    expect(inputs.rows.some((row) => row.role === "collateral")).toBe(true);
    expect(inputs.note).toMatch(/not resolved/);

    const outputs = await client.callToolOk<{ total: number; rows: Array<{ address: string; lovelace: string; payment_credential?: { kind: string; hash: string } }>; next_offset?: number }>("tx_inspect", {
      tx_id: txId,
      section: "outputs",
      limit: 1,
    });
    expect(outputs.rows).toHaveLength(1);
    expect(outputs.rows[0]!.address).toMatch(/^addr1/);
    expect(outputs.rows[0]!.payment_credential?.kind).toMatch(/^(key|script)$/);
    expect(outputs.next_offset).toBe(1);

    const page2 = await client.callToolOk<{ offset: number; rows: unknown[] }>("tx_inspect", { tx_id: txId, section: "outputs", offset: 1, limit: 1 });
    expect(page2.offset).toBe(1);
    expect(page2.rows).toHaveLength(1);

    const witnesses = await client.callToolOk<{ signature_check: { valid: boolean; invalid_vkey_witnesses: string[] }; rows: unknown[] }>("tx_inspect", { tx_id: txId, section: "witnesses" });
    expect(witnesses.signature_check.valid).toBe(true);
    expect(witnesses.signature_check.invalid_vkey_witnesses).toEqual([]);
    expect(witnesses.rows.length).toBeGreaterThan(0);

    const raw = await client.callToolOk<{ path: string; value: { fee: string } }>("tx_inspect", { tx_id: txId, section: "raw_json", path: "/transaction/body" });
    expect(raw.path).toBe("/transaction/body");
    expect(raw.value.fee).toBe(String(fxBig("s08.fee")));

    const missing = await client.callTool<{ code: string; available: string[] }>("tx_inspect", { tx_id: txId, section: "raw_json", path: "/transaction/nope" });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent!.code).toBe("path_not_found");
    expect(missing.structuredContent!.available).toContain("body");

    for (const section of ["certs", "governance", "aux", "datums", "mint", "withdrawals"] as const) {
      const result = await client.callToolOk<{ section: string; total: number; rows: unknown[] }>("tx_inspect", { tx_id: txId, section });
      expect(result.section).toBe(section);
      expect(result.rows.length).toBeLessThanOrEqual(result.total);
    }
  });

  it("tx_inspect: mint/scripts/datums on a script-heavy tx; unknown tx_id -> expired_handle", async () => {
    const tx = readFixture("pool-mint.tx");
    const mint = await client.callToolOk<{ tx_id: string; rows: Array<{ policy: string; redeemer?: string; plutus_version?: string; assets_count: number }> }>("tx_inspect", { tx_cbor: tx, section: "mint" });
    expect(mint.rows.length).toBe(fxArr("s07.mintPolicies").length);
    expect(mint.rows.map((r) => r.redeemer).sort()).toEqual(["mint:0", "mint:1"]);
    expect(mint.rows.every((r) => r.plutus_version === "V3")).toBe(true);
    const txId = mint.tx_id;

    const scripts = await client.callToolOk<{ rows: Array<{ script_hash: string; plutus_version: string; source: string; used_by_redeemers: string[]; resources: string[] }> }>("tx_inspect", { tx_id: txId, section: "scripts" });
    expect(scripts.rows.length).toBe(fxInt("s07.scriptCount"));
    expect(scripts.rows.every((s) => s.plutus_version === "V3" && s.source === "witness")).toBe(true);
    expect(scripts.rows.flatMap((s) => s.used_by_redeemers).sort()).toEqual(["mint:0", "mint:1"]);
    expect(scripts.rows[0]!.resources).toContain(`cardano-debug://script/${scripts.rows[0]!.script_hash}/uplc.txt`);

    const redeemers = await client.callToolOk<{ rows: Array<{ ref: string; script_hash?: string; plutus_version?: string; target: string }> }>("tx_inspect", { tx_id: txId, section: "redeemers" });
    const mint0 = redeemers.rows.find((r) => r.ref === "mint:0")!;
    expect(mint0.script_hash).toMatch(/^[0-9a-f]{56}$/);
    expect(mint0.plutus_version).toBe("V3");
    expect(mint0.target).toBe(`policy ${mint0.script_hash}`);

    const hex = await client.readResourceText(`cardano-debug://tx/${txId}/script/${mint0.script_hash}/bytes.hex`);
    expect(hex).toMatch(/^59/);
    expect(await client.readResourceText(`cardano-debug://script/${mint0.script_hash}/bytes.hex`)).toBe(hex);
    const uplc = await client.readResourceText(`cardano-debug://script/${mint0.script_hash}/uplc.txt?limit=3`);
    expect(uplc.split("\n")).toHaveLength(3);
    expect(uplc).toMatch(/^\(program/);

    const outputs = await client.callToolOk<{ rows: Array<{ datum?: { kind: string; hash?: string; value?: unknown } }> }>("tx_inspect", { tx_id: txId, section: "outputs" });
    expect(outputs.rows.some((o) => o.datum?.kind === "inline" && o.datum.hash)).toBe(true);

    const expired = await client.callTool<{ code: string; recreate_with: string }>("tx_inspect", { tx_id: "tx_mainnet_000000000000", section: "body" });
    expect(expired.isError).toBe(true);
    expect(expired.structuredContent!.code).toBe("expired_handle");
    expect(expired.structuredContent!.recreate_with).toBe("tx_load");

    const invalid = await client.callTool<{ code: string }>("tx_inspect", { tx_cbor: "zz", section: "body" });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent!.code).toBe("invalid_argument");

    const neither = await client.callTool<{ code: string }>("tx_inspect", { section: "body" });
    expect(neither.isError).toBe(true);
    expect(neither.structuredContent!.code).toBe("invalid_argument");
  });

  it("resources: server/info, cddl (windowed), tx cbor/decoded; templates listed; unknown or not-yet-available -> -32602", async () => {
    const info = await client.readResourceJson<{ name: string; engines: { cquisitor_lib: { version: string } }; providers: { koios_api_key: boolean }; resource_providers: string[]; vocabulary: Record<string, string> }>(
      "cardano-debug://server/info",
    );
    expect(info.name).toBe("cardano-debug");
    expect(info.engines.cquisitor_lib.version).toMatch(/^0\.1\.0/);
    expect(typeof info.providers.koios_api_key).toBe("boolean");
    expect(Array.isArray(info.resource_providers)).toBe(true);
    expect(info.vocabulary.integers).toMatch(/decimal strings/);

    const cddlAll = await client.readResource("cardano-debug://cddl/conway");
    expect(cddlAll.contents[0]!.text).toMatch(/^; This file was auto-generated/);
    expect(cddlAll.contents[0]!._meta).toBeUndefined();
    const cddlWindow = await client.readResource("cardano-debug://cddl/conway?offset=15&limit=2");
    expect(cddlWindow.contents[0]!.text!.split("\n")).toHaveLength(2);
    expect(cddlWindow.contents[0]!.text).toMatch(/transaction/);
    expect(cddlWindow.contents[0]!._meta).toMatchObject({ offset: 15, limit: 2 });
    expect((cddlWindow.contents[0]!._meta as { total_lines: number }).total_lines).toBeGreaterThan(700);
    const cddlIndex = await client.readResourceJson<{ default: string; eras: Array<{ era: string; valid: boolean; rules: number; roots: number }>; ledger_revision: string }>("cardano-debug://cddl");
    expect(cddlIndex.default).toBe("conway");
    expect(cddlIndex.eras.map((e) => e.era)).toEqual(["conway", "babbage", "alonzo", "mary", "allegra", "shelley", "dijkstra"]);
    for (const era of cddlIndex.eras) {
      expect(era.valid, era.era).toBe(true);
      expect(era.rules, era.era).toBeGreaterThan(50);
      expect(era.roots, era.era).toBeGreaterThan(40);
    }
    expect(cddlIndex.ledger_revision).toMatch(/^[0-9a-f]{40}$/);
    const babbage = await client.readResource("cardano-debug://cddl/babbage?offset=0&limit=1");
    expect(babbage.contents[0]!.text).toMatch(/^; This file was auto-generated/);
    expect(babbage.contents[0]!.mimeType).toBe("text/plain");

    const tx = readFixture("vote-tx.tx");
    const body = await client.callToolOk<{ tx_id: string }>("tx_inspect", { tx_cbor: tx, section: "body", network: "preprod" });
    const txId = body.tx_id;
    expect(txId).toMatch(/^tx_preprod_[0-9a-f]{12}$/);
    expect(await client.readResourceText(`cardano-debug://tx/${txId}/cbor`)).toBe(tx.toLowerCase());
    const decoded = await client.readResourceJson<{ transaction_hash: string }>(`cardano-debug://tx/${txId}/decoded.json`);
    expect(decoded.transaction_hash).toMatch(/^[0-9a-f]{64}$/);
    const decodedWindow = await client.readResource(`cardano-debug://tx/${txId}/decoded.json?offset=0&limit=1`);
    expect(decodedWindow.contents[0]!.text).toBe("{");

    const { resourceTemplates } = await client.listResourceTemplates();
    const templates = resourceTemplates.map((t) => t.uriTemplate);
    for (const expected of [
      "cardano-debug://tx/{tx_id}/cbor",
      "cardano-debug://tx/{tx_id}/decoded.json",
      "cardano-debug://tx/{tx_id}/validation.json",
      "cardano-debug://tx/{tx_id}/bundle.json",
      "cardano-debug://tx/{tx_id}/necessary.json",
      "cardano-debug://tx/{tx_id}/redeemer/{ref}/context.json",
      "cardano-debug://tx/{tx_id}/redeemer/{ref}/context.cbor",
      "cardano-debug://tx/{tx_id}/redeemer/{ref}/traces.txt",
      "cardano-debug://tx/{tx_id}/redeemer/{ref}/script.hex",
      "cardano-debug://tx/{tx_id}/redeemer/{ref}/error.txt",
      "cardano-debug://tx/{tx_id}/redeemer/{ref}/parts.json",
      "cardano-debug://script/{script_hash}/pseudocode.txt",
      "cardano-debug://script/{script_hash}/uplc.txt",
      "cardano-debug://script/{script_hash}/bytes.hex",
      "cardano-debug://session/{dbg_id}/uplc.txt",
      "cardano-debug://session/{dbg_id}/state.json",
      "cardano-debug://session/{dbg_id}/traces.txt",
      "cardano-debug://session/{dbg_id}/profile.json",
      "cardano-debug://chain/{net}/epoch_params",
      "cardano-debug://docs/{topic}",
      "cardano-debug://docs/{topic}/{section}",
      "cardano-debug://cddl/{era}",
    ]) {
      expect(templates).toContain(expected);
    }
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(["cardano-debug://cddl", "cardano-debug://cddl/conway", "cardano-debug://docs", "cardano-debug://server/info"]);

    // no chain layer / validation / engine yet: these are not found, not errors in disguise
    const notFound = async (uri: string) => {
      const error = await client.readResource(uri).catch((e: unknown) => e);
      expect(error, uri).toBeInstanceOf(JsonRpcRemoteError);
      expect((error as JsonRpcRemoteError).code, uri).toBe(-32602);
    };
    await notFound("cardano-debug://tx/tx_mainnet_ffffffffffff/cbor");
    await notFound(`cardano-debug://tx/${txId}/validation.json`);
    await notFound(`cardano-debug://tx/${txId}/bundle.json`);
    await notFound(`cardano-debug://tx/${txId}/necessary.json`);
    await notFound(`cardano-debug://tx/${txId}/redeemer/spend:0/traces.txt`);
    await notFound(`cardano-debug://tx/${txId}/redeemer/nonsense/traces.txt`);
    await notFound("cardano-debug://script/00000000000000000000000000000000000000000000000000000000/bytes.hex");
    await notFound("cardano-debug://session/dbg_00000000-0000-0000-0000-000000000000/state.json");
    await notFound("cardano-debug://chain/mainnet/epoch_params");
    await notFound("cardano-debug://chain/nope/epoch_params");
    await notFound("cardano-debug://cddl/byron");
    await notFound("cardano-debug://nothing/here");
    await notFound("cardano-debug://nothing/here?offset=1");
  });

  it("prompts: listed and rendered with the exact tool names", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["debug_tx", "diagnose_cbor", "explain_script", "replay_bundle"]);
    const debug = prompts.find((p) => p.name === "debug_tx")!;
    expect(debug.arguments?.map((a) => a.name).sort()).toEqual(["network", "provider", "tx"]);
    expect(debug.arguments?.find((a) => a.name === "tx")?.required).toBe(true);

    const rendered = await client.getPrompt("debug_tx", { tx: "deadbeef", network: "preprod" });
    const text = rendered.messages[0]!.content.text!;
    for (const tool of ["tx_load", "tx_validate", "tx_redeemer", "debug_open", "debug_profile", "debug_run(until='error')", "debug_inspect(what='env')", "docs(topic='debug-playbook')", "docs(error=<Name>)", "section='phase-2-rewind'"]) {
      expect(text).toContain(tool);
    }
    expect(text).toContain("Network: preprod");
    expect(text).not.toMatch(/pseudo_line|view='pseudocode'/);
    // pseudocode is read before stepping: the script_decompile step comes before debug_open
    expect(text.indexOf("script_decompile(")).toBeLessThan(text.indexOf("debug_open("));
    expect(text).toMatch(/on chain \(on_chain\)/);
    expect(text).not.toMatch(/\{\{/);
    // replay_bundle shares the steps from step 2 on
    const replayText = (await client.getPrompt("replay_bundle", { bundle: "b" })).messages[0]!.content.text!;
    expect(replayText).toContain(text.slice(text.indexOf("2) tx_validate")));

    const explain = await client.getPrompt("explain_script", { script: "abcd" });
    expect(explain.messages[0]!.content.text).toContain("script_decompile");
    expect(explain.messages[0]!.content.text).toContain("docs(topic='uplc-cek')");
    const replay = await client.getPrompt("replay_bundle", { bundle: "/tmp/bundle.json" });
    expect(replay.messages[0]!.content.text).toContain("tx_load(bundle=…)");
    expect(replay.messages[0]!.content.text).toContain("captured_at");
    expect(replay.messages[0]!.content.text).toMatch(/captured_at null .* unknown/);
    expect(replay.messages[0]!.content.text).toContain("docs(topic='validation-errors', section='defaults_applied')");

    const diagnose = prompts.find((p) => p.name === "diagnose_cbor")!;
    expect(diagnose.arguments?.map((a) => a.name).sort()).toEqual(["cddl", "hex", "rule"]);
    expect(diagnose.arguments?.find((a) => a.name === "hex")?.required).toBe(true);
    const diagnosed = await client.getPrompt("diagnose_cbor", { hex: "d8799f41aa02ff", cddl: "babbage" });
    const diagnoseText = diagnosed.messages[0]!.content.text!;
    for (const step of ["cbor_decode(hex, as='auto')", "cbor_validate(hex, cddl=", "cddl_check(cddl=…)", "docs(topic='cbor-cddl')", "Schema: babbage", "Root rule: (auto-pick)", "byte offset"]) {
      expect(diagnoseText).toContain(step);
    }
  });
});
