// Chain layer over stdio: tx_load from the artificial S1 sample DebuggerContext (offline), tx_validate,
// tx_redeemer parts, bundle_export -> tx_load(bundle) round trip, missing-UTxO detection,
// tx_add_witnesses, expired handles and the chain resources. A second block loads a transaction by hash
// from a local Koios stub (test/helpers/koiosStub.ts: the provider rows of scenario s08, no network).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withoutWitnessKey } from "../helpers/cborSplice.js";
import { fixturePath, fx, fxArr, fxBig, fxInt, fxStr, readTx } from "../helpers/fixtures.js";
import { loadProviderRows, startKoiosStub, type KoiosStub } from "../helpers/koiosStub.js";
import { PROJECT_ROOT, StdioClient } from "../helpers/stdioClient.js";

/** The artificial S1 sample: a DebuggerContext of the hub transaction (V2 spend + V2 burn + a native mint). */
const SAMPLE = fixturePath(fxStr("s01.contextFile"));
/** Scenario s08: a V2 reference-script spend (one spend redeemer, three vkey witnesses). */
const LOCK_TX = readTx("lock-spend.tx");
/** Scenario s11: a datum-hash lock signed by one key (the "other transaction" whose witnesses do not fit). */
const ORDER_TX = readTx("datum-lock.tx");
const LOCK_TX_HASH = fxStr("s08.txHash");
const LOCK_TX_ID = fxStr("s08.txId");

type Json = Record<string, any>;

describe("chain layer over stdio — offline (bundle / DebuggerContext)", () => {
  let client: StdioClient;
  let cacheDir: string;
  let txId: string;
  let ref: string;

  beforeAll(async () => {
    expect(existsSync(path.join(PROJECT_ROOT, "dist", "server.js")), "run `npm run build` before the e2e test").toBe(true);
    expect(existsSync(SAMPLE), "the S1 DebuggerContext fixture must exist (npm run fixtures:build)").toBe(true);
    cacheDir = mkdtempSync(path.join(os.tmpdir(), "cdm-e2e-"));
    client = StdioClient.dist(process.execPath, { CARDANO_DEBUG_OFFLINE: "1", CARDANO_DEBUG_CACHE_DIR: cacheDir });
    await client.initialize();
  });

  afterAll(async () => {
    const code = await client.close();
    expect(client.nonJsonStdout, "stdout must carry only JSON-RPC").toEqual([]);
    expect(code).toBe(0);
  });

  it("lists the chain tools", async () => {
    const { tools } = await client.request<{ tools: Array<{ name: string; inputSchema: { type: string } }> }>("tools/list");
    const names = tools.map((t) => t.name);
    for (const name of ["tx_load", "tx_validate", "tx_redeemer", "tx_add_witnesses", "bundle_export"]) expect(names).toContain(name);
  });

  it("tx_load(bundle=<DebuggerContext path>) converts the sample with documented defaults", async () => {
    const result = await client.callTool<Json>("tx_load", { bundle: SAMPLE });
    expect(result.isError).toBeFalsy();
    const s = result.structuredContent!;
    expect(s.tx_id).toBe(fxStr("s01.txId"));
    expect(s.network).toBe("mainnet");
    expect(s.source).toBe("bundle");
    expect(s.protocol_major).toBe(10);
    expect(s.counts).toMatchObject({ inputs: 3, reference_inputs: 3, redeemers: 2, mint_policies: 2 });
    expect(s.redeemers.map((r: Json) => r.ref)).toEqual(["spend:2", "mint:1"]);
    // spend script hash from the resolved input address, version from the reference script
    expect(s.redeemers[0]).toMatchObject({ script_hash: fxStr("s01.spendScript.hash"), plutus_version: "V2" });
    expect(s.redeemers[0].ex_units).toEqual({ steps: fxStr("s01.spend.exUnits.declared.steps"), mem: fxStr("s01.spend.exUnits.declared.mem") });
    expect(s.scripts.some((x: Json) => x.source.startsWith(`reference ${fxStr("s01.spendScript.holder.prefix")}`) && x.source.includes("hash derived"))).toBe(true);
    expect(s.context).toMatchObject({ status: "bundle", utxos_resolved: 5, utxos_needed: 5 });
    expect(s.missing_utxos).toEqual([]);
    const defaults = (s.defaults_applied as string[]).join("\n");
    expect(defaults).toContain("minFeeCoefficientA/minFeeConstantB swapped");
    expect(defaults).toContain("slot=");
    expect(defaults).toContain("treasuryValue=0");
    // a DebuggerContext carries no capture time: unknown, not the import time
    expect(s.context.captured_at).toBeNull();
    expect(defaults).toContain("captured_at=null");
    expect(JSON.parse(result.content[0]!.text!)).toEqual(s);
    expect(result.content[0]!.text!.length).toBeLessThan(8_000);
    txId = s.tx_id;
    ref = s.redeemers[0].ref;
  });

  it("tx_inspect(section='scripts') reports reference-script sizes like tx_load (inner bytes, no envelope / bstr header)", async () => {
    const load = await client.callTool<Json>("tx_load", { bundle: SAMPLE });
    const inspect = await client.callTool<Json>("tx_inspect", { tx_id: txId, section: "scripts" });
    const loadSizes = new Map((load.structuredContent!.scripts as Json[]).map((r) => [r.script_hash, r.size_bytes]));
    const referenced = (inspect.structuredContent!.rows as Json[]).filter((r) => String(r.source).startsWith("reference "));
    expect(referenced.length).toBeGreaterThan(0);
    for (const row of referenced) {
      if (row.plutus_version === "native" || !loadSizes.has(row.script_hash)) continue;
      expect(row.size_bytes, `size of ${row.script_hash}`).toBe(loadSizes.get(row.script_hash));
    }
    expect(referenced.find((r) => r.script_hash === fxStr("s01.spendScript.hash"))?.size_bytes).toBe(fxInt("s01.spendScript.size"));
  });

  it("tx_validate runs both phases offline and reports per-redeemer ex-units", async () => {
    const result = await client.callTool<Json>("tx_validate", { tx_id: txId }, 120_000);
    expect(result.isError).toBeFalsy();
    const s = result.structuredContent!;
    expect(["valid", "phase1_failed", "phase2_failed", "both_failed"]).toContain(s.verdict);
    expect(s.semantics).toBeUndefined(); // the engine semantics live in server/info, not in every answer
    expect(s.protocol_major).toBe(10);
    expect(s.defaults_applied_count).toBeGreaterThan(0); // the list itself is tx_load's
    expect(s.defaults_applied).toBeUndefined();
    expect(result.content).toHaveLength(1); // no resource_link blocks next to the JSON
    expect((s.resources as Json[]).map((r) => r.uri)).toEqual([`cardano-debug://tx/${txId}/validation.json`]);
    const redeemers = s.phase2.redeemers as Json[];
    expect(s.phase2).toMatchObject({ redeemers_total: 2, failed_count: 0 });
    expect(redeemers.map((r) => r.ref)).toEqual(["spend:2", "mint:1"]);
    for (const r of redeemers) {
      expect(r.success).toBe(true);
      expect(r.fidelity).toBe("full");
      expect(r.ex_units.verdict).toBe("slack");
      expect(typeof r.ex_units.declared.steps).toBe("string");
      expect(typeof r.ex_units.delta.steps).toBe("string");
    }
    expect(redeemers[0]!.script_hash).toBe(fxStr("s01.spendScript.hash"));
    expect(redeemers[1]!.script_hash).toBe(fxStr("s01.mint.policy"));
    // Phase-1 diagnostics carry rule names, locations and hints; on-chain quantities are strings.
    const fee = (s.phase1.errors as Json[]).find((e) => e.name === "FeeTooSmallUTxO");
    expect(fee, "the sample underpays its fee").toBeDefined();
    expect(fee!.locations).toContain("transaction.body.fee");
    expect(typeof fee!.data.actual_fee).toBe("string");
    expect(fee!.hint.length).toBeLessThanOrEqual(400);
    // the size fee is on the ledger size [body, witnesses, aux]: all bytes but the is_valid one, a=44, b=155381
    expect(fee!.data.fee_decomposition.txSizeFee).toBe(String(44 * (fxInt("s01.size") - 1) + 155381));
    expect(fee!.data.fee_decomposition.txSizeFee).toBe(fxStr("s01.txSizeFee"));
    expect(fee!.data.actual_fee).toBe(fxStr("s01.fee"));
    expect(fee!.data.min_fee).toBe(fxStr("s01.minFee"));
    // the playbook's worked example (generated from the manifest) quotes this run
    const playbook = readFileSync(path.join(PROJECT_ROOT, "src", "docs", "debug-playbook", "11-worked-example.md"), "utf8");
    expect(playbook).toContain(`data.actual_fee=${fxStr("s01.fee")},min_fee=${fxStr("s01.minFee")}`);
    expect(playbook).toContain(`fee ${fxStr("s01.fee")} < ${fxStr("s01.minFee")}`);
    expect(result.content[0]!.text!.length).toBeLessThan(16_000);
    // one pointer to the docs catalogue for every reported name, not a text per row
    const errorDocs = result.structuredContent!.error_docs as string;
    expect(errorDocs).toMatch(/^docs\(error=<Name>\) explains each name: .*FeeTooSmallUTxO/);
    expect(errorDocs.length).toBeLessThan(400);
    const cached = await client.callTool<Json>("tx_validate", { tx_id: txId });
    expect(cached.structuredContent!.cached).toBe(true);
  });

  it("tx_redeemer: summary / error / traces / context / script / links + aliases", async () => {
    const summary = await client.callTool<Json>("tx_redeemer", { tx_id: txId, redeemer: "Spending #2" });
    expect(summary.isError).toBeFalsy();
    expect(summary.structuredContent).toMatchObject({ ref: "spend:2", part: "summary", success: true, datum_present: true, context_available: true, fidelity: "full", plutus_version: "V2" });
    expect(summary.structuredContent!.datum).toBeDefined();

    const byWitness = await client.callTool<Json>("tx_redeemer", { tx_id: txId, redeemer: "r:1", part: "error" });
    expect(byWitness.structuredContent).toMatchObject({ ref: "mint:1", category: "none", success: true });

    const traces = await client.callTool<Json>("tx_redeemer", { tx_id: txId, redeemer: ref, part: "traces", limit: 10 });
    expect(traces.structuredContent).toMatchObject({ part: "traces", offset: 0 });
    expect(Array.isArray(traces.structuredContent!.items)).toBe(true);

    const context = await client.callTool<Json>("tx_redeemer", { tx_id: txId, redeemer: ref, part: "context", path: "tx_info.inputs.0", depth: 3 });
    expect(context.isError).toBeFalsy();
    expect(context.structuredContent!.path).toBe("tx_info.V2.inputs.0");
    expect(context.structuredContent!.value.out_ref.transaction_id).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof context.structuredContent!.value.resolved.value.coin).toBe("string");
    const explicit = await client.callTool<Json>("tx_redeemer", { tx_id: txId, redeemer: ref, part: "context", path: "tx_info.V2.inputs.0.out_ref" });
    expect(explicit.structuredContent!.value.transaction_id).toBe(context.structuredContent!.value.out_ref.transaction_id);
    const purpose = await client.callTool<Json>("tx_redeemer", { tx_id: txId, redeemer: ref, part: "context", path: "purpose" });
    expect(purpose.isError).toBeFalsy();
    const missing = await client.callTool<Json>("tx_redeemer", { tx_id: txId, redeemer: ref, part: "context", path: "tx_info.nope" });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent!.code).toBe("path_not_found");
    expect(missing.structuredContent!.available).toContain("inputs");

    const script = await client.callTool<Json>("tx_redeemer", { tx_id: txId, redeemer: ref, part: "script" });
    expect(script.structuredContent).toMatchObject({ script_hash: fxStr("s01.spendScript.hash"), plutus_version: "V2", size_bytes: fxInt("s01.spendScript.size") });
    expect(script.structuredContent!.source).toContain(`reference ${fxStr("s01.spendScript.holder.prefix")}`);

    const links = await client.callTool<Json>("tx_redeemer", { tx_id: txId, redeemer: ref, part: "links" });
    expect(links.isError).toBeFalsy();
    const de = links.structuredContent!.de_uplc_url;
    expect(typeof de === "string" ? de : de.preview).toContain("cardananium.github.io/de-uplc-web/#");
    expect(links.structuredContent!.decompiler_url).toBeDefined();

    const unknown = await client.callTool<Json>("tx_redeemer", { tx_id: txId, redeemer: "withdraw:0" });
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent!.message).toContain("spend:2, mint:1");
  });

  it("serves the chain resources", async () => {
    const parts = await client.readResource(`cardano-debug://tx/${txId}/redeemer/${ref}/parts.json`);
    const config = JSON.parse(parts.contents[0]!.text!) as Json;
    expect(config.language).toBe("v2");
    expect(config.script.startsWith(fxStr("s01.spendScript.prefix"))).toBe(true);
    expect(config.context).toMatch(/^[0-9a-f]+$/);
    expect(config.redeemer).toBeDefined();
    expect(config.datum).toBeDefined();
    expect(config.protocol_version).toBe(10);
    expect(config.cost_models).toHaveLength(175);
    expect(config.ex_units).toEqual([Number(fxBig("s01.spend.exUnits.declared.steps")), Number(fxBig("s01.spend.exUnits.declared.mem"))]);

    const links = await client.readResource(`cardano-debug://tx/${txId}/redeemer/${ref}/links.txt`);
    expect(links.contents[0]!.text).toContain("de_uplc_url: https://");
    expect(links.contents[0]!.text).toContain("cquisitor_url: https://cardananium.github.io/cquisitor/#transaction-validator?");

    const validation = await client.readResource(`cardano-debug://tx/${txId}/validation.json`);
    expect(validation.contents[0]!.text!.length).toBeLessThan(60_000);
    expect(validation.contents[0]!.text).not.toContain('"script_context_bytes":"d8');

    const necessary = await client.readResource(`cardano-debug://tx/${txId}/necessary.json`);
    expect(JSON.parse(necessary.contents[0]!.text!).necessary.utxos).toHaveLength(5);

    const bundle = await client.readResource(`cardano-debug://tx/${txId}/bundle.json`);
    expect(JSON.parse(bundle.contents[0]!.text!).cardano_debug_bundle).toBe(1);

    const traces = await client.readResource(`cardano-debug://tx/${txId}/redeemer/${ref}/traces.txt`);
    expect(traces.contents[0]!.mimeType ?? "text/plain").toBe("text/plain");

    const info = await client.readResource("cardano-debug://server/info");
    const parsed = JSON.parse(info.contents[0]!.text!) as Json;
    expect(parsed.chain.offline).toBe(true);
    expect(parsed.chain.cache_dir).toBe(cacheDir);
    expect(parsed.semantics.validator).toMatch(/^protocol-aware/);
  });

  it("bundle_export writes bundle v1 and tx_load(bundle) replays it with the validation", async () => {
    const exported = await client.callTool<Json>("bundle_export", { tx_id: txId, inline: true });
    expect(exported.isError).toBeFalsy();
    const s = exported.structuredContent!;
    expect(s.path).toBe(path.join(cacheDir, "bundles", "mainnet", `${fxStr("s01.txHash")}.json`));
    expect(s.includes_validation).toBe(true);
    expect(s.utxos).toBe(5);
    expect(s.bundle === undefined || typeof s.bundle === "string").toBe(true);
    const text = readFileSync(s.path as string, "utf8");
    const bundle = JSON.parse(text) as Json;
    expect(bundle).toMatchObject({ cardano_debug_bundle: 1, network: "mainnet", tx_hash: fxStr("s01.txHash"), protocol_major: 10 });
    expect(typeof bundle.slot).toBe("string");
    expect(bundle.captured_at).toBeNull(); // the DebuggerContext it came from has no capture time
    expect(bundle.validation_input_context.utxoSet).toHaveLength(5);
    expect(typeof bundle.validation_input_context.protocolParameters.minFeeConstantB).toBe("number");
    expect(bundle.validation_result.eval_redeemer_results).toHaveLength(2);

    // Replay: same handle, validation restored from the bundle, no evaluation needed.
    const replay = await client.callTool<Json>("tx_load", { bundle: s.path });
    expect(replay.isError).toBeFalsy();
    expect(replay.structuredContent).toMatchObject({ tx_id: txId, source: "bundle", validated: true });
    expect(replay.structuredContent!.context.origin).toContain("bundle ");
    const inline = await client.callTool<Json>("tx_load", { bundle: text });
    expect(inline.structuredContent!.tx_id).toBe(txId);
  });

  it("detects missing UTxOs before validation and reports incomplete_context", async () => {
    const sample = JSON.parse(readFileSync(SAMPLE, "utf8")) as Json;
    sample.utxos = sample.utxos.filter((u: Json) => !(u.txHash === fxStr("s01.fundingTxId") && u.outputIndex === fxInt("s01.fundingIndex")));
    const file = path.join(cacheDir, "incomplete.json");
    writeFileSync(file, JSON.stringify(sample));
    const load = await client.callTool<Json>("tx_load", { bundle: file });
    expect(load.isError).toBeFalsy();
    expect(load.structuredContent!.missing_utxos).toEqual([fxStr("s01.fundingRef")]);
    const validate = await client.callTool<Json>("tx_validate", { tx_id: txId });
    expect(validate.isError).toBeFalsy();
    expect(validate.structuredContent!.verdict).toBe("incomplete_context");
    expect(validate.structuredContent!.note).toContain("not returned by the provider");
    const redeemer = await client.callTool<Json>("tx_redeemer", { tx_id: txId, redeemer: ref });
    expect(redeemer.isError).toBe(true);
    expect(redeemer.structuredContent!.code).toBe("incomplete_context");
    // restore the complete context for the remaining tests
    const restored = await client.callTool<Json>("tx_load", { bundle: SAMPLE });
    expect(restored.structuredContent!.missing_utxos).toEqual([]);
  });

  it("tx_add_witnesses merges signatures and re-validates on the same context", async () => {
    const load = await client.callTool<Json>("tx_load", { tx_cbor: LOCK_TX });
    // offline: no chain state for this tx, the record is still usable from the bytes
    expect(load.isError).toBeFalsy();
    expect(load.structuredContent!.tx_id).toBe(LOCK_TX_ID);
    expect(load.structuredContent!.context.status).toBe("unavailable");
    expect(load.structuredContent!.defaults_applied[0]).toContain("network=mainnet");
    // merging the transaction with itself: every witness is a duplicate; the other transaction's witnesses do not sign this body
    const added = await client.callTool<Json>("tx_add_witnesses", { tx_id: LOCK_TX_ID, witnesses: [LOCK_TX, ORDER_TX] });
    expect(added.isError).toBeFalsy();
    expect(added.structuredContent).toMatchObject({ tx_id: LOCK_TX_ID, tx_id_unchanged: true, added: 0, duplicates: fxInt("s08.vkeyCount"), invalid: fxInt("s11.vkeyCount"), added_key_hashes: [] });
    expect(added.structuredContent!.validation.skipped).toBe(true);

    const bundled = await client.callTool<Json>("tx_add_witnesses", { tx_id: txId, witnesses: [LOCK_TX], revalidate: true });
    expect(bundled.isError).toBeFalsy();
    expect(bundled.structuredContent!.invalid).toBe(fxInt("s08.vkeyCount")); // none of the lock transaction's signatures covers the sample's body
    expect(bundled.structuredContent!.validation.verdict).toBeDefined();
    expect(bundled.structuredContent!.validation.redeemers.map((r: Json) => r.ref)).toEqual(["spend:2", "mint:1"]);
  });

  it("same body, other witness set: the new bytes get their own verdict (no stale cache hit)", async () => {
    const signed = (JSON.parse(readFileSync(SAMPLE, "utf8")) as Json).transaction as string;
    const unsigned = withoutWitnessKey(signed, 0); // drop the vkey witnesses; body (and tx_id) unchanged
    const names = (r: Json) => (r.structuredContent!.phase1.errors as Json[]).map((e) => e.name);

    const original = await client.callTool<Json>("tx_validate", { tx_id: txId }, 120_000);
    expect(names(original)).not.toContain("MissingVKeyWitnesses");

    // tx_cbor with the same body replaces the stored bytes instead of reusing their verdict.
    const stripped = await client.callTool<Json>("tx_validate", { tx_cbor: unsigned }, 120_000);
    expect(stripped.isError, JSON.stringify(stripped.structuredContent)).toBeFalsy();
    expect(stripped.structuredContent!.tx_id).toBe(txId);
    expect(stripped.structuredContent!.cached).toBe(false);
    expect(names(stripped)).toContain("MissingVKeyWitnesses");
    const witnesses = await client.callTool<Json>("tx_inspect", { tx_id: txId, section: "witnesses" });
    expect(JSON.stringify(witnesses.structuredContent)).not.toMatch(/"vkey"/);

    // tx_load of the signed bytes again: the offline bundle's verdict belongs to other bytes, so it is not reused blindly.
    const reload = await client.callTool<Json>("tx_load", { tx_cbor: signed });
    expect(reload.isError).toBeFalsy();
    const again = await client.callTool<Json>("tx_validate", { tx_id: txId }, 120_000);
    expect(names(again)).not.toContain("MissingVKeyWitnesses");
    const unsignedLoad = await client.callTool<Json>("tx_load", { tx_cbor: unsigned });
    expect(unsignedLoad.isError).toBeFalsy();
    const unsignedAgain = await client.callTool<Json>("tx_validate", { tx_id: txId }, 120_000);
    expect(names(unsignedAgain)).toContain("MissingVKeyWitnesses");
    // restore the sample for the remaining tests
    await client.callTool<Json>("tx_load", { bundle: SAMPLE });
  });

  it("a redeemer aimed at a native-script input: MissingRequiredScript, with a hint that says why", async () => {
    const load = await client.callTool<Json>("tx_load", { bundle: fixturePath(fxStr("s03.contextFile")) });
    expect(load.isError, JSON.stringify(load.structuredContent)).toBeFalsy();
    const target = (load.structuredContent!.redeemers as Json[])[0]!;
    expect(target.plutus_version).toBe("native");
    const error = await client.callTool<Json>("tx_redeemer", { tx_id: load.structuredContent!.tx_id, redeemer: target.ref, part: "error" }, 120_000);
    expect(error.isError, JSON.stringify(error.structuredContent)).toBeFalsy();
    expect((error.structuredContent!.phase2_errors as Json[]).map((e) => e.name)).toContain("MissingRequiredScript");
    expect(error.structuredContent!.hint).toMatch(/NATIVE script/);
  });

  it("an output the node cannot decode: phase 1 is kept, each redeemer answers UnreadableOutput and never runs (context_build, not_run)", async () => {
    // output 0's 29-byte script address gets header 0x37 (a base address, which needs 57 bytes): unreadable, same length
    const sample = JSON.parse(readFileSync(SAMPLE, "utf8")) as Json;
    const address = fxStr("s01.out0.addressCborHex");
    const original = (sample.transaction as string).toLowerCase();
    expect(original).toContain(address);
    sample.transaction = original.replace(address, "581d37" + "ab".repeat(28));
    const file = path.join(cacheDir, "unreadable-output.json");
    writeFileSync(file, JSON.stringify(sample));
    const load = await client.callTool<Json>("tx_load", { bundle: file });
    expect(load.isError, JSON.stringify(load.structuredContent)).toBeFalsy();
    const tx = load.structuredContent!.tx_id as string;
    expect(tx).not.toBe(txId);
    const validation = await client.callTool<Json>("tx_validate", { tx_id: tx }, 120_000);
    expect(validation.isError, JSON.stringify(validation.structuredContent).slice(0, 400)).toBeFalsy();
    const v = validation.structuredContent!;
    expect(v.verdict).toBe("both_failed");
    expect((v.phase1.errors as Json[]).length).toBeGreaterThan(0); // phase 1's report survives the phase-2 refusal
    expect((v.phase2.errors as Json[]).map((e) => [e.name, e.redeemer])).toEqual([
      ["UnreadableOutput", "spend:2"],
      ["UnreadableOutput", "mint:1"],
    ]);
    expect((v.phase2.errors as Json[])[0]!.data).toMatchObject({ output_index: "0" });
    expect((v.phase2.redeemers as Json[]).map((r) => r.ex_units.verdict)).toEqual(["not_run", "not_run"]);
    expect((v.phase2.warnings as Json[]).map((w) => w.name)).not.toContain("BudgetIsBiggerThanExpected");
    const error = await client.callTool<Json>("tx_redeemer", { tx_id: tx, redeemer: "spend:2", part: "error" }, 120_000);
    expect(error.structuredContent).toMatchObject({ success: false, category: "context_build", within_budget: null, ex_units: { verdict: "not_run" } });
    expect(error.structuredContent!.message).toMatch(/^Output 0 cannot be translated into a script context: its address cannot be read/);
    // the server keeps working (no trap)
    expect((await client.callTool<Json>("tx_validate", { tx_id: txId })).isError).toBeFalsy();
  });

  it("a context UTxO's inline datum (read only by the script evaluator) nests up to 128 levels; past that the redeemers are not run (not_examined), phase 1 still validates", async () => {
    const withDepth = (levels: number): string => {
      const sample = JSON.parse(readFileSync(SAMPLE, "utf8")) as Json;
      const withDatum = (sample.utxos as Json[]).find((u) => typeof u.inlineDatum === "string")!;
      withDatum.inlineDatum = "81".repeat(levels) + "00";
      const file = path.join(cacheDir, `deep-context-datum-${levels}.json`);
      writeFileSync(file, JSON.stringify(sample));
      return file;
    };
    // past the typed decoders' 64 but within 128: examined; the spend script gets a list where it expects a constructor
    const within = await client.callTool<Json>("tx_load", { bundle: withDepth(100) });
    expect(within.isError, JSON.stringify(within.structuredContent)).toBeFalsy();
    const examined = await client.callTool<Json>("tx_validate", { tx_id: within.structuredContent!.tx_id }, 120_000);
    expect(examined.isError, JSON.stringify(examined.structuredContent).slice(0, 400)).toBeFalsy();
    expect(examined.structuredContent!.verdict).toBe("both_failed");
    expect(((examined.structuredContent!.phase2 as Json).errors as Json[]).map((e) => [e.name, e.redeemer])).toEqual([["MachineError", "spend:2"]]);
    expect(examined.structuredContent!.not_examined).toBeUndefined();
    // past 128: the validation still answers; no script context was built, so the redeemers were not run — said so, not failed
    const load = await client.callTool<Json>("tx_load", { bundle: withDepth(129) });
    expect(load.isError, JSON.stringify(load.structuredContent)).toBeFalsy();
    const validation = await client.callTool<Json>("tx_validate", { tx_id: load.structuredContent!.tx_id }, 120_000);
    expect(validation.isError, JSON.stringify(validation.structuredContent).slice(0, 400)).toBeFalsy();
    const body = validation.structuredContent!;
    expect(validation.content[0]!.type === "text" ? validation.content[0]!.text!.length : 0).toBeLessThan(32_000);
    const notExamined = body.not_examined as Json;
    expect((notExamined.items as Json[]).map((w) => w.name)).toContain("ScriptContextNotExamined");
    expect(notExamined.note).toMatch(/^Implementation limit, not a finding/);
    const phase2 = body.phase2 as Json;
    expect(phase2.errors).toEqual([]);
    const notRun = (phase2.redeemers as Json[]).filter((r) => r.success === null);
    expect(notRun.length).toBeGreaterThan(0);
    for (const r of notRun) expect(r.error_headline).toMatch(/^not run: .*implementation limit, not a finding/);
    expect(body.verdict).not.toBe("valid");
    expect(body.verdict).not.toBe("phase2_failed");
    // restore the sample for the remaining tests
    const restored = await client.callTool<Json>("tx_load", { bundle: SAMPLE });
    expect(restored.isError).toBeFalsy();
    const again = await client.callTool<Json>("tx_validate", { tx_id: txId }, 120_000);
    expect(again.structuredContent!.verdict, JSON.stringify(again.structuredContent).slice(0, 600)).toBeDefined();
  });

  it("a 10,000-level native script minting policy: tx_load, tx_inspect and tx_validate examine it (native scripts are exempt from the 64 / 128-level bounds)", async () => {
    const sample = JSON.parse(readFileSync(SAMPLE, "utf8")) as Json;
    const funding = (sample.utxos as Json[]).find((u) => u.txHash === fxStr("s01.fundingTxId") && u.outputIndex === fxInt("s01.fundingIndex"))!;
    // ScriptAll × 10,000 around one signature: ~20,000 CBOR levels, far past 64 and 128
    const script = "820181".repeat(10_000) + "8200581c" + "11".repeat(28);
    const decodedScript = await client.callTool<Json>("cbor_decode", { hex: script, as: "NativeScript" });
    expect(decodedScript.isError, JSON.stringify(decodedScript.structuredContent).slice(0, 400)).toBeFalsy();
    const policy = decodedScript.structuredContent!.hash as string;
    expect(policy).toMatch(/^[0-9a-f]{56}$/);
    const lovelace = BigInt(funding.value.lovelace) - 5_000_000n;
    const coin = "1b" + lovelace.toString(16).padStart(16, "0");
    const asset = "a1581c" + policy + "a14001"; // {policy: {h'': 1}}
    const output = "a2" + "00" + "581d61" + "22".repeat(28) + "01" + "82" + coin + asset;
    const body = "a4" + "00" + "81" + "825820" + funding.txHash + funding.outputIndex.toString(16).padStart(2, "0") + "01" + "81" + output + "02" + "1a004c4b40" + "09" + asset;
    sample.transaction = "84" + body + "a1" + "01" + "81" + script + "f5" + "f6";
    const file = path.join(cacheDir, "deep-native-script.json");
    writeFileSync(file, JSON.stringify(sample));

    const load = await client.callTool<Json>("tx_load", { bundle: file });
    expect(load.isError, JSON.stringify(load.structuredContent).slice(0, 400)).toBeFalsy();
    const deepTx = load.structuredContent!.tx_id as string;
    expect(load.structuredContent!.counts).toMatchObject({ inputs: 1, mint_policies: 1 });
    expect((load.structuredContent!.scripts as Json[]).find((x) => x.script_hash === policy)).toMatchObject({ plutus_version: "native", source: "witness" });
    expect(load.content[0]!.text!.length).toBeLessThan(32_000);

    const inspected = await client.callTool<Json>("tx_inspect", { tx_id: deepTx, section: "scripts" });
    expect(inspected.isError, JSON.stringify(inspected.structuredContent).slice(0, 400)).toBeFalsy();
    expect((inspected.structuredContent!.rows as Json[]).map((r) => r.script_hash)).toContain(policy);
    expect(inspected.content[0]!.text!.length).toBeLessThan(32_000);

    const validation = await client.callTool<Json>("tx_validate", { tx_id: deepTx }, 120_000);
    expect(validation.isError, JSON.stringify(validation.structuredContent).slice(0, 400)).toBeFalsy();
    const v = validation.structuredContent!;
    expect(v.not_examined).toBeUndefined();
    const names = [...(v.phase1.errors as Json[]), ...((v.phase1.warnings as Json[] | undefined) ?? [])].map((e) => e.name);
    expect(names).not.toContain("NativeScriptNotExamined");
    // the script was evaluated: it needs a signature the transaction does not carry
    expect(names).toContain("NativeScriptIsUnsuccessful");
    expect(validation.content[0]!.text!.length).toBeLessThan(32_000);
    // restore the sample for the remaining tests
    expect((await client.callTool<Json>("tx_load", { bundle: SAMPLE })).isError).toBeFalsy();
  });

  it("a proposal's guardrails redeemer (decoded tag VotingProposal) is propose:0: inspected, validated and opened under that ref", async () => {
    const load = await client.callTool<Json>("tx_load", { bundle: fixturePath(fxStr("s04.bundleFile")) });
    expect(load.isError, JSON.stringify(load.structuredContent)).toBeFalsy();
    const proposeTx = load.structuredContent!.tx_id as string;
    expect(load.structuredContent!.redeemers).toEqual([
      { ref: "propose:0", witness_index: 0, script_hash: fxStr("s04.guardrailsHash"), plutus_version: "V3", ex_units: fx("s04.exUnits"), target: "proposal #0" },
    ]);
    const validate = await client.callTool<Json>("tx_validate", { tx_id: proposeTx }, 120_000);
    expect(validate.isError, JSON.stringify(validate.structuredContent).slice(0, 400)).toBeFalsy();
    const rows = (validate.structuredContent!.phase2 as Json).redeemers as Json[];
    expect(rows.map((r) => [r.ref, r.success, r.ex_units.verdict])).toEqual([["propose:0", true, "exact"]]);
    const summary = await client.callTool<Json>("tx_redeemer", { tx_id: proposeTx, redeemer: "propose:0" });
    expect(summary.isError, JSON.stringify(summary.structuredContent)).toBeFalsy();
    expect(summary.structuredContent).toMatchObject({ ref: "propose:0", target: "proposal #0", success: true });
    expect((await client.callTool<Json>("tx_redeemer", { tx_id: proposeTx, redeemer: "VotingProposal:0" })).structuredContent!.ref).toBe("propose:0");
    const spend = await client.callTool<Json>("tx_redeemer", { tx_id: proposeTx, redeemer: "spend:0" });
    expect(spend.structuredContent).toMatchObject({ code: "invalid_argument", message: "Redeemer spend:0 is not in this transaction. Available: propose:0." });
    const opened = await client.callTool<Json>("debug_open", { tx_id: proposeTx, redeemer: "propose:0" }, 120_000);
    expect(opened.isError, JSON.stringify(opened.structuredContent).slice(0, 400)).toBeFalsy();
    expect(opened.structuredContent).toMatchObject({ mode: "tx", purpose: "propose", plutus_version: "V3" });
    await client.callTool<Json>("debug_close", { dbg_id: opened.structuredContent!.dbg_id });
  });

  it("an SPO vote on a security-group ParameterChange validates from a bundle whose context predates changedParameters", async () => {
    const load = await client.callTool<Json>("tx_load", { bundle: fixturePath(fxStr("s05.bundleFile")) });
    expect(load.isError, JSON.stringify(load.structuredContent)).toBeFalsy();
    expect(load.structuredContent!.validated).toBeFalsy(); // the stored verdict (computed without the names) is not reused
    // the names come from the provider's proposal row: exactly the security-group parameters the action changes
    expect((load.structuredContent!.defaults_applied as string[]).some((d) => d.startsWith(`govActionContexts[0].changedParameters=[${fxArr<string>("s05.securityParameters").join(", ")}]`))).toBe(true);
    const validate = await client.callTool<Json>("tx_validate", { tx_id: load.structuredContent!.tx_id }, 120_000);
    expect(validate.isError, JSON.stringify(validate.structuredContent).slice(0, 400)).toBeFalsy();
    expect(((validate.structuredContent!.phase1 as Json).errors as Json[]).map((e) => e.name)).not.toContain("DisallowedVoters");
  });

  it("offline tx_hash and expired handles answer with recoverable errors", async () => {
    const offline = await client.callTool<Json>("tx_load", { tx_hash: LOCK_TX_HASH, network: "mainnet" });
    expect(offline.isError).toBe(true);
    expect(offline.structuredContent!.code).toBe("offline");
    const expired = await client.callTool<Json>("tx_validate", { tx_id: "tx_mainnet_000000000000" });
    expect(expired.isError).toBe(true);
    expect(expired.structuredContent).toMatchObject({ code: "expired_handle", recreate_with: "tx_load" });
    const both = await client.callTool<Json>("tx_load", { tx_cbor: LOCK_TX, tx_hash: LOCK_TX_HASH });
    expect(both.structuredContent!.code).toBe("invalid_argument");
    const noKey = await client.callTool<Json>("tx_load", { tx_cbor: ORDER_TX, provider: "blockfrost" });
    expect(noKey.isError).toBe(true);
    expect(noKey.structuredContent!.message).toContain("BLOCKFROST_PROJECT_ID_MAINNET");
  });
});

// A transaction loaded by hash: the rows come from a local Koios stub (the provider rows scenario s08 writes: the tx row, its four UTxOs,
// the inclusion epoch's parameters and totals), so the test runs by default and needs no network.
describe("chain layer over stdio — tx_hash against a local Koios stub (scenario s08 rows, no network)", () => {
  let client: StdioClient;
  let stub: KoiosStub;
  let cacheDir: string;

  beforeAll(async () => {
    expect(existsSync(path.join(PROJECT_ROOT, "dist", "server.js")), "run `npm run build` before the e2e test").toBe(true);
    stub = await startKoiosStub(loadProviderRows(fxStr("s08.providerRows")));
    cacheDir = mkdtempSync(path.join(os.tmpdir(), "cdm-e2e-stub-"));
    client = StdioClient.dist(process.execPath, { ...stub.env, CARDANO_DEBUG_CACHE_DIR: cacheDir });
    await client.initialize();
  });

  afterAll(async () => {
    if (client) {
      const code = await client.close();
      expect(client.nonJsonStdout).toEqual([]);
      expect(code).toBe(0);
    }
    await stub?.close();
  });

  it("tx_load(tx_hash) fetches, verifies the reference script and validates; a restart serves from the disk cache", async () => {
    const scriptHash = fxStr("s08.scriptHash");
    const utxoCount = fxInt("s08.utxoCount");
    const load = await client.callTool<Json>("tx_load", { tx_hash: LOCK_TX_HASH, network: "mainnet" }, 120_000);
    expect(load.isError, JSON.stringify(load.structuredContent)).toBeFalsy();
    const s = load.structuredContent!;
    expect(s).toMatchObject({ tx_id: LOCK_TX_ID, network: "mainnet", source: "provider" });
    expect(s.context).toMatchObject({ status: "fetched", provider: "koios", utxos_resolved: utxoCount, utxos_needed: utxoCount });
    expect(s.protocol_major).toBeGreaterThanOrEqual(9);
    expect(s.redeemers[0]).toMatchObject({ ref: fx<{ ref: string }>("s08.redeemer").ref, script_hash: scriptHash, plutus_version: fxStr("s08.scriptVersion") });
    const refScript = (s.scripts as Json[]).find((x) => x.script_hash === scriptHash);
    expect(refScript?.source).toMatch(new RegExp(`^reference ${fxStr("s08.referenceInputPrefix")}`));
    expect(refScript?.source).not.toContain("UNVERIFIED");
    expect(s.provider_warnings.some((w: string) => w.includes("anonymously"))).toBe(true);
    expect(s.missing_utxos).toEqual([]);
    expect(stub.count("/tx_cbor")).toBeGreaterThan(0);
    expect(stub.count("/utxo_info")).toBeGreaterThan(0);

    const validate = await client.callTool<Json>("tx_validate", { tx_id: s.tx_id }, 120_000);
    expect(validate.isError, JSON.stringify(validate.structuredContent).slice(0, 600)).toBeFalsy();
    const redeemer = (validate.structuredContent!.phase2.redeemers as Json[])[0]!;
    expect(redeemer).toMatchObject({ ref: "spend:1", success: true, fidelity: "full", script_hash: scriptHash });
    expect(["exact", "slack"]).toContain(redeemer.ex_units.verdict);
    // The tx is "on chain": replayed at its inclusion slot with that epoch's parameters and its own inputs unspent.
    expect(s.on_chain).toMatchObject({ is_valid: true, slot: String(fxStr("s08.slot")), epoch: fxInt("s08.epoch") });
    expect(validate.structuredContent!.on_chain.slot).toBe(s.on_chain.slot);
    expect(validate.structuredContent!.slot).toBe(s.on_chain.slot);
    expect((validate.structuredContent!.phase1.errors as Json[]).map((e) => e.name)).not.toContain("BadInputsUTxO");
    expect(validate.structuredContent!.verdict, JSON.stringify(validate.structuredContent).slice(0, 800)).toBe("valid");

    const epoch = await client.readResource("cardano-debug://chain/mainnet/epoch_params");
    expect(JSON.parse(epoch.contents[0]!.text!).protocol_major).toBeGreaterThanOrEqual(9);

    // Restart without the stub's address and offline: the same handle comes back from the disk cache without network.
    const served = stub.requests.length;
    await client.close();
    client = StdioClient.dist(process.execPath, { CARDANO_DEBUG_CACHE_DIR: cacheDir, CARDANO_DEBUG_OFFLINE: "1" });
    await client.initialize();
    const again = await client.callTool<Json>("tx_load", { tx_hash: LOCK_TX_HASH, network: "mainnet" });
    expect(again.isError, JSON.stringify(again.structuredContent)).toBeFalsy();
    expect(again.structuredContent).toMatchObject({ tx_id: LOCK_TX_ID, source: "cache", validated: true });
    expect(again.structuredContent!.context.status).toBe("cached");
    expect(stub.requests.length).toBe(served);
  });

  it("a hash the stub holds no row for is a recoverable tool error (the provider answered with no rows), not a crash", async () => {
    const fresh = StdioClient.dist(process.execPath, { ...stub.env, CARDANO_DEBUG_CACHE_DIR: mkdtempSync(path.join(os.tmpdir(), "cdm-e2e-stub-miss-")) });
    await fresh.initialize();
    try {
      const unknown = await fresh.callTool<Json>("tx_load", { tx_hash: "ab".repeat(32), network: "mainnet" }, 60_000);
      expect(unknown.isError).toBe(true);
      expect(typeof unknown.structuredContent!.code).toBe("string");
      expect(stub.count("/tx_cbor")).toBeGreaterThan(0);
      expect(await fresh.ping()).toEqual({});
    } finally {
      expect(await fresh.close()).toBe(0);
    }
  });
});
