// tx_inspect enrichment and the store-backed resources against a minimal AppContext with the real
// lib worker (dist/workers/lib.worker.js): a ValidationInputContext attached to the record makes
// inputs resolved, spend redeemers get their script hash, reference scripts join the inventory;
// a stored validation makes validation.json and the redeemer artefacts readable.
import { existsSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import type { AppContext } from "../../src/context.js";
import { createLibClient, type LibClient } from "../../src/lib.js";
import { providersOf } from "../../src/providers.js";
import { readResourceUri } from "../../src/resources.js";
import { SessionRegistry } from "../../src/store/sessionRegistry.js";
import { TxStore, type TxRecord } from "../../src/store/txStore.js";
import { txInspect, txView } from "../../src/tools/tx_inspect.js";
import { TxDecodeError } from "../../src/tools/_shared.js";
import { buildTxRecord, formatInputRef, plutusScriptHex, sortedInputs } from "../../src/tx/record.js";
import { fx, fxInt, fxStr, readTx } from "../helpers/fixtures.js";
import { PROJECT_ROOT } from "../mcpClient.js";

const LIB_WORKER = path.join(PROJECT_ROOT, "dist", "workers", "lib.worker.js");
// artificial addresses of scenario s11 (a datum-hash lock at an order script, and its maker's key address)
const SCRIPT_ADDR = fxStr("s11.scriptAddress");
const SCRIPT_HASH = fxStr("s11.scriptHash");
const KEY_ADDR = fxStr("s11.makerAddress");
const SCRIPT_DATUM_HASH = fxStr("s11.datumHash");

const fixture = readTx;

describe.skipIf(!existsSync(LIB_WORKER))("tx_inspect enrichment + resources", () => {
  let lib: LibClient;
  let ctx: AppContext;
  let record: TxRecord;
  let pool: TxRecord;
  let spendInputRef: string;
  let referenceInputRef: string;

  beforeAll(async () => {
    const config = loadConfig({});
    lib = createLibClient(config, { entry: new URL(`file://${LIB_WORKER}`) });
    const txStore = new TxStore();
    const sessions = new SessionRegistry({ sweepIntervalMs: 60_000 });
    ctx = { config, lib, txStore, sessions, startedAt: Date.now(), services: {}, onShutdown: () => undefined, shutdown: async () => undefined };
    record = await buildTxRecord(lib, { tx: fixture("lock-spend.tx"), network: "mainnet" }); // s08: a V2 reference-script spend, Spend 1
    pool = await buildTxRecord(lib, { tx: fixture("pool-mint.tx"), network: "mainnet" }); // s07: two V3 witness scripts
    txStore.put(record);
    txStore.put(pool);

    const inputs = sortedInputs(record.decoded);
    spendInputRef = formatInputRef(inputs[1]!); // spend:1
    const referenceInputs = (record.decoded.transaction.body.reference_inputs as Array<{ transaction_id: string; index: number }>) ?? [];
    referenceInputRef = `${referenceInputs[0]!.transaction_id.toLowerCase()}#${referenceInputs[0]!.index}`;
    const poolScript = pool.scripts[0]!;
    const utxoSet = [
      ...inputs.map((input, i) => ({
        utxo: {
          input: { txHash: input.tx_hash, outputIndex: input.output_index },
          output: {
            address: i === 1 ? SCRIPT_ADDR : KEY_ADDR,
            amount: [{ unit: "lovelace", quantity: i === 1 ? "5000000" : "123456789012345678" }],
            dataHash: i === 1 ? SCRIPT_DATUM_HASH : undefined,
            plutusData: i === 1 ? "d8799f41aa1bffffffffffffffffff" : undefined,
          },
        },
        isSpent: i === 0,
      })),
      {
        utxo: {
          input: { txHash: referenceInputRef.split("#")[0], outputIndex: Number(referenceInputRef.split("#")[1]) },
          output: { address: KEY_ADDR, amount: [{ unit: "lovelace", quantity: "2000000" }], scriptRef: `8203${"59" + (poolScript.hex!.length / 2).toString(16).padStart(4, "0") + poolScript.hex}`, scriptHash: poolScript.script_hash },
        },
        isSpent: false,
      },
    ];
    record.validationContext = { utxoSet, slot: 1 };
  });

  afterAll(async () => {
    ctx.sessions.closeAll("shutdown");
    await lib.dispose();
  });

  it("buildTxRecord refuses bytes that are not one well-formed CBOR item (trailing bytes) with the library's reason", async () => {
    const clean = await buildTxRecord(lib, { tx: fixture("vote-tx.tx"), network: "mainnet" });
    expect(clean.sizeBytes).toBe(fixture("vote-tx.tx").length / 2);
    expect(clean.sizeBytes).toBe(fxInt("s12.size"));
    const error = await buildTxRecord(lib, { tx: fixture("vote-tx.tx") + "deadbeef", network: "mainnet" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TxDecodeError);
    expect((error as TxDecodeError).message).toMatch(new RegExp(`Malformed CBOR: trailing CBOR data at offset ${fxInt("s12.size")} \\(4 byte\\(s\\) left\\)`));
    expect((error as TxDecodeError).message).toContain("cbor_validate(hex=<the same bytes>, rule='transaction')");
  });

  it("Plutus scripts decode as { bytes, language }; the inventory reads their hex from it", () => {
    const witnessScripts = pool.decoded.transaction.witness_set.plutus_scripts as Array<{ bytes: string; language: string }>;
    expect(witnessScripts).toHaveLength(fxInt("s07.scriptCount"));
    expect(witnessScripts.length).toBeGreaterThan(0);
    for (const script of witnessScripts) {
      expect(Object.keys(script).sort()).toEqual(["bytes", "language"]);
      expect(script.language).toMatch(/^PlutusV[123]$/);
    }
    const fromWitness = pool.scripts.filter((s) => s.source === "witness" && s.plutus_version !== "native");
    expect(fromWitness.map((s) => s.hex)).toEqual(witnessScripts.map((s) => s.bytes));
    expect(fromWitness.every((s) => s.size_bytes === s.hex!.length / 2)).toBe(true);
    expect(plutusScriptHex({ bytes: "4d01", language: "PlutusV3" })).toBe("4d01");
    expect(plutusScriptHex("4d01")).toBeUndefined();
  });

  it("txView: resolved rows, spend script hash from the spent address, reference script in the inventory", () => {
    const view = txView(ctx, record);
    expect(view.resolved.size).toBe(sortedInputs(record.decoded).length + 1);
    expect(view.resolved.get(spendInputRef)?.payment).toEqual({ kind: "script", hash: SCRIPT_HASH });
    const spend = view.redeemers.find((r) => r.ref === "spend:1")!;
    expect(spend.script_hash).toBe(SCRIPT_HASH);
    expect(record.redeemerTargets.find((r) => r.ref === "spend:1")!.script_hash).toBeUndefined(); // record untouched
    const reference = view.scripts.find((s) => s.source === `reference ${referenceInputRef}`)!;
    expect(reference).toMatchObject({ script_hash: pool.scripts[0]!.script_hash, plutus_version: "V3" });
  });

  it("inputs section: resolved rows with decoded inline datum (integers as strings), spent flag, big lovelace as string", async () => {
    const result = await txInspect(ctx, { tx_id: record.txId, section: "inputs" });
    expect(result.isError).toBeFalsy();
    const rows = result.structuredContent.rows as Array<Record<string, unknown>>;
    const spendRow = rows.find((r) => r.utxo === spendInputRef)!;
    expect(spendRow.redeemer).toBe("spend:1");
    expect(spendRow.script_hash).toBe(SCRIPT_HASH);
    const resolved = spendRow.resolved as Record<string, unknown>;
    expect(resolved.address).toBe(SCRIPT_ADDR);
    expect(resolved.lovelace).toBe("5000000");
    expect(resolved.payment_credential).toEqual({ kind: "script", hash: SCRIPT_HASH });
    expect(resolved.inline_datum).toEqual({ constructor: "0", fields: [{ bytes: "aa" }, { int: "18446744073709551615" }] });
    expect(resolved.inline_datum_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(resolved).not.toHaveProperty("_inline_datum_hex");
    const first = rows.find((r) => r.spend_index === 0)!;
    expect((first.resolved as Record<string, unknown>).spent).toBe(true);
    expect((first.resolved as Record<string, unknown>).lovelace).toBe("123456789012345678");
    const reference = rows.find((r) => r.role === "reference")!;
    expect((reference.resolved as Record<string, unknown>).ref_script_hash).toBe(pool.scripts[0]!.script_hash);
    expect((reference.resolved as Record<string, unknown>).ref_script_version).toBe("V3");
    expect(result.structuredContent.note).toBeUndefined();
    expect(result.structuredContent.unresolved_utxos).toBeDefined(); // the collateral input is not in the context
  });

  it("redeemers / scripts / body sections reflect the enrichment", async () => {
    const redeemers = await txInspect(ctx, { tx_id: record.txId, section: "redeemers" });
    const row = (redeemers.structuredContent.rows as Array<Record<string, unknown>>)[0]!;
    expect(row.script_hash).toBe(SCRIPT_HASH);
    expect(redeemers.structuredContent.note).toBeUndefined();

    const scripts = await txInspect(ctx, { tx_id: record.txId, section: "scripts" });
    const rows = scripts.structuredContent.rows as Array<Record<string, unknown>>;
    expect(rows.some((s) => String(s.source).startsWith("reference "))).toBe(true);

    const body = await txInspect(ctx, { tx_id: record.txId, section: "body" });
    const summary = (body.structuredContent.rows as Array<Record<string, unknown>>)[0]!;
    expect(summary.chain_context).toBe("resolved");
    expect((summary.counts as Record<string, number>).reference_scripts).toBe(1);
  });

  it("row pages stay under the character budget (page_cut + next_offset) on a 26-output tx at depth 6 / limit 100", async () => {
    const big = await buildTxRecord(lib, { tx: fixture("wide-mint.tx"), network: "mainnet" }); // s09: 26 outputs, 25 of them with big inline datums
    const outputCount = fxInt("s09.outputCount");
    ctx.txStore.put(big);
    const seen: number[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const result = await txInspect(ctx, { tx_id: big.txId, section: "outputs", depth: 6, limit: 100, offset });
      const text = (result.content[0] as { text: string }).text;
      expect(text.length).toBeLessThan(32_000);
      const page = result.structuredContent as { rows: Array<{ index: number }>; next_offset?: number; page_cut?: boolean; total: number };
      expect(page.total).toBe(outputCount);
      seen.push(...page.rows.map((r) => r.index));
      offset = page.next_offset;
    }
    expect(seen).toEqual(Array.from({ length: outputCount }, (_, i) => i));
    const first = await txInspect(ctx, { tx_id: big.txId, section: "outputs", depth: 6, limit: 100 });
    expect(first.structuredContent.page_cut).toBe(true);
    expect(String(first.structuredContent.page_note)).toMatch(/offset=/);
  });

  it("a registered resolvedUtxos provider wins over the record's context", async () => {
    const unregister = providersOf(ctx).register({ resolvedUtxos: () => new Map() });
    try {
      const inputs = await txInspect(ctx, { tx_id: record.txId, section: "inputs" });
      expect(inputs.structuredContent.note).toMatch(/not resolved/);
    } finally {
      unregister();
    }
  });

  it("resources: validation.json + redeemer artefacts appear once a validation is stored; parts.json needs a provider", async () => {
    const base = `cardano-debug://tx/${record.txId}`;
    await expect(readResourceUri(ctx, new URL(`${base}/validation.json`))).rejects.toMatchObject({ code: -32602 });
    record.validation = {
      at: Date.now(),
      elapsedMs: 5,
      phases: "both",
      result: { errors: [], warnings: [], phase2_errors: [], phase2_warnings: [] },
      redeemers: new Map([
        [
          "spend:1",
          {
            tag: "Spend",
            index: 1,
            provided_ex_units: { mem: String(fx("s08.redeemer.mem")), steps: String(fx("s08.redeemer.steps")) },
            calculated_ex_units: { mem: 100, steps: 200 },
            logs: ["hello", "world"],
            success: false,
            error: "boom\nsecond line",
            script_context: '{"purpose":{"Spending":1},"tx_info":{"V2":{"fee":99999999999999999999}}}',
            script_context_bytes: "d87980",
            script_bytes: pool.scripts[0]!.hex!,
            plutus_version: "V3",
          },
        ],
      ]),
    };
    const validation = JSON.parse((await readResourceUri(ctx, new URL(`${base}/validation.json`))).contents[0]!.text) as { eval_redeemer_results: Array<Record<string, unknown>> };
    expect(validation.eval_redeemer_results[0]).toMatchObject({ redeemer: "spend:1", logs_count: 2, script_bytes_present: true });
    expect(validation.eval_redeemer_results[0]).not.toHaveProperty("script_bytes");

    const traces = await readResourceUri(ctx, new URL(`${base}/redeemer/spend:1/traces.txt?offset=1`));
    expect(traces.contents[0]!.text).toBe("world");
    expect(traces.contents[0]!._meta).toMatchObject({ offset: 1, total_lines: 2 });
    const context = JSON.parse((await readResourceUri(ctx, new URL(`${base}/redeemer/Spending%20%231/context.json`))).contents[0]!.text) as { tx_info: { V2: { fee: string } } };
    expect(context.tx_info.V2.fee).toBe("99999999999999999999");
    expect((await readResourceUri(ctx, new URL(`${base}/redeemer/r:0/context.cbor`))).contents[0]!.text).toBe("d87980");
    expect((await readResourceUri(ctx, new URL(`${base}/redeemer/spend:1/error.txt`))).contents[0]!.text).toBe("boom\nsecond line");
    expect((await readResourceUri(ctx, new URL(`${base}/redeemer/spend:1/script.hex`))).contents[0]!.text).toBe(pool.scripts[0]!.hex);
    await expect(readResourceUri(ctx, new URL(`${base}/redeemer/spend:1/parts.json`))).rejects.toMatchObject({ code: -32602 });
    await expect(readResourceUri(ctx, new URL(`${base}/redeemer/mint:0/traces.txt`))).rejects.toMatchObject({ code: -32602 });

    const unregister = providersOf(ctx).register({
      redeemerArtifact: (_record, ref, part) => (part === "parts.json" ? { text: JSON.stringify({ script: "00", language: "v3", ref }), mimeType: "application/json" } : undefined),
      epochParams: (network) => ({ network, min_fee_a: "44" }),
    });
    try {
      const parts = await readResourceUri(ctx, new URL(`${base}/redeemer/spend:1/parts.json`));
      expect(JSON.parse(parts.contents[0]!.text)).toEqual({ script: "00", language: "v3", ref: { purpose: "spend", index: 1 } });
      expect(parts.contents[0]!.mimeType).toBe("application/json");
      const params = await readResourceUri(ctx, new URL("cardano-debug://chain/preprod/epoch_params"));
      expect(JSON.parse(params.contents[0]!.text)).toEqual({ network: "preprod", min_fee_a: "44" });
    } finally {
      unregister();
    }
    // the tx now links its validation resource
    const body = await txInspect(ctx, { tx_id: record.txId, section: "body" });
    expect((body.structuredContent.resources as Array<{ uri: string }>).map((r) => r.uri)).toContain(`${base}/validation.json`);
    const redeemers = await txInspect(ctx, { tx_id: record.txId, section: "redeemers" });
    expect((redeemers.structuredContent.rows as Array<Record<string, unknown>>)[0]!.validated).toMatchObject({ success: false, error_headline: "boom", trace_count: 2, calculated_ex_units: { mem: "100", steps: "200" } });
  });

  it("resources: script bytes / uplc from the store, session state.json from the registry", async () => {
    const hash = pool.scripts[0]!.script_hash;
    expect((await readResourceUri(ctx, new URL(`cardano-debug://script/${hash}/bytes.hex`))).contents[0]!.text).toBe(pool.scripts[0]!.hex);
    const uplc = await readResourceUri(ctx, new URL(`cardano-debug://script/${hash}/uplc.txt?limit=1`));
    expect(uplc.contents[0]!.text).toBe("(program");
    await expect(readResourceUri(ctx, new URL(`cardano-debug://script/${hash}/pseudocode.txt`))).rejects.toMatchObject({ code: -32602 });

    const { record: session } = ctx.sessions.create({ mode: "program", language: "V2", partsConfig: { program: "(program 1.0.0 (con integer 1))" } });
    const state = JSON.parse((await readResourceUri(ctx, new URL(`cardano-debug://session/${session.dbgId}/state.json`))).contents[0]!.text) as Record<string, unknown>;
    expect(state).toMatchObject({ dbg_id: session.dbgId, mode: "program", language: "V2", worker: null, total_steps: 0 });
    await expect(readResourceUri(ctx, new URL(`cardano-debug://session/${session.dbgId}/uplc.txt`))).rejects.toMatchObject({ code: -32602 });
    ctx.sessions.close(session.dbgId);
    await expect(readResourceUri(ctx, new URL(`cardano-debug://session/${session.dbgId}/state.json`))).rejects.toMatchObject({ code: -32602 });
  });
});
