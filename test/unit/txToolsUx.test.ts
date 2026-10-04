// The tx tools' answers: shape, caps and resource-link policy (tx_validate, tx_redeemer, tx_inspect,
// tx_add_witnesses, bundle_export, the shared ok() / missingUtxosView), against fake chain services
// (no network, no evaluation) and, where bytes matter, the real lib worker.
import { existsSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { chainStateOf, emptyChainState, setChainState } from "../../src/chain/state.js";
import { PHASE2_REDEEMER_ROWS, splitValidation, validationSummary, verdictOf } from "../../src/chain/validate.js";
import { loadConfig } from "../../src/config.js";
import type { AppContext } from "../../src/context.js";
import { createLibClient, type EvalRedeemerResultWire, type LibClient, type ValidationResultWire } from "../../src/lib.js";
import { expiredHandleError, SessionRegistry } from "../../src/store/sessionRegistry.js";
import { TxStore, type RedeemerTarget, type TxRecord } from "../../src/store/txStore.js";
import { bundleExport } from "../../src/tools/bundle_export.js";
import { MISSING_UTXOS_SHOWN, missingUtxosView, ok, resourceLink } from "../../src/tools/_shared.js";
import { txAddWitnesses } from "../../src/tools/tx_add_witnesses.js";
import { txInspect, txInspectTool } from "../../src/tools/tx_inspect.js";
import { txRedeemer } from "../../src/tools/tx_redeemer.js";
import { txValidate } from "../../src/tools/tx_validate.js";
import { referenceScriptsOf, resolvedUtxosFromContext, withSpendScriptHashes } from "../../src/tx/dataView.js";
import { buildTxRecord } from "../../src/tx/record.js";
import { readTx } from "../helpers/fixtures.js";
import { PROJECT_ROOT } from "../mcpClient.js";

type Json = Record<string, any>;

// ---------- fixtures ----------

function target(purpose: RedeemerTarget["purpose"], index: number, witness: number): RedeemerTarget {
  return { ref: `${purpose}:${index}`, purpose, index, witness_index: witness, target: `input x#${index}`, ex_units: { mem: "10", steps: "100" } };
}

function fakeRecord(targets: RedeemerTarget[] = [target("spend", 2, 0), target("publish", 0, 1)]): TxRecord {
  const now = Date.now();
  return {
    txId: "tx_mainnet_000000000001",
    txHash: "00".repeat(31) + "01",
    network: "mainnet",
    txHex: "84a0",
    sizeBytes: 2,
    source: "cbor",
    createdAt: now,
    lastUsedAt: now,
    decoded: { transaction_hash: "00".repeat(31) + "01", transaction: { body: {}, witness_set: {}, is_valid: true, auxiliary_data: null } },
    hashes: { witness_native_script_hashes: [], witness_plutus_scripts: [], witness_datum_hashes: [], output_inline_scripts: [], output_inline_datum_hashes: [], output_datum_hashes: [] },
    redeemerTargets: targets,
    scripts: [],
    extra: {},
  };
}

/** Attach a chain state with a (fake) context so the tools see a loaded transaction. */
function withContext(record: TxRecord, patch: Partial<ReturnType<typeof emptyChainState>> = {}): TxRecord {
  const state = emptyChainState("mainnet", "test");
  state.status = "bundle";
  state.context = { utxoSet: [], slot: 1 } as unknown as NonNullable<typeof state.context>;
  Object.assign(state, patch);
  setChainState(record, state);
  return record;
}

function ev(tag: string, index: number, overrides: Partial<EvalRedeemerResultWire> = {}): EvalRedeemerResultWire {
  return { tag, index, provided_ex_units: { mem: 10, steps: "100" }, calculated_ex_units: { mem: 8, steps: 90 }, logs: ["a", "b"], success: true, ...overrides } as EvalRedeemerResultWire;
}

function validation(evals: EvalRedeemerResultWire[], rest: Partial<ValidationResultWire> = {}) {
  return splitValidation({ errors: [], warnings: [], phase2_errors: [], phase2_warnings: [], ...rest, eval_redeemer_results: evals } as unknown as ValidationResultWire, 5);
}

function fakeCtx(chain: Record<string, unknown> = {}): AppContext {
  return { config: loadConfig({}), txStore: new TxStore(), services: { chain }, onShutdown: () => undefined } as unknown as AppContext;
}

const uris = (result: { structuredContent: Json }) => ((result.structuredContent.resources ?? []) as Array<{ uri: string }>).map((r) => r.uri);

// ---------- shared helpers ----------

describe("ok(): one carrier for resource links", () => {
  it("lists links in `resources` of the text / structured content and adds no resource_link blocks", () => {
    const result = ok({ a: 1 }, { links: [resourceLink("cardano-debug://x", "x", "text/plain", "a description")] });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }]);
    expect(result.structuredContent).toEqual({ a: 1, resources: [{ uri: "cardano-debug://x", name: "x", mimeType: "text/plain" }] });
    const twice = ok({}, { links: [resourceLink("cardano-debug://x", "x"), resourceLink("cardano-debug://y", "y"), resourceLink("cardano-debug://x", "x again")] });
    expect(uris(twice as never)).toEqual(["cardano-debug://x", "cardano-debug://y"]);
    expect(ok({ a: 1 }).structuredContent).toEqual({ a: 1 });
    expect(ok({ a: 1 }, { links: [] }).structuredContent).toEqual({ a: 1 });
  });
});

describe("missingUtxosView", () => {
  it("shows the first 20, the total when there are any and a truncated flag when some were cut", () => {
    expect(missingUtxosView(undefined)).toEqual({ missing_utxos: [] });
    expect(missingUtxosView([])).toEqual({ missing_utxos: [] });
    expect(missingUtxosView(["a#0", "b#1"])).toEqual({ missing_utxos: ["a#0", "b#1"], missing_utxos_total: 2 });
    const many = Array.from({ length: 25 }, (_, i) => `${"ab".repeat(32)}#${i}`);
    const view = missingUtxosView(many);
    expect(view.missing_utxos).toEqual(many.slice(0, MISSING_UTXOS_SHOWN));
    expect(view).toMatchObject({ missing_utxos_total: 25, missing_utxos_truncated: true });
    expect(missingUtxosView(many.slice(0, MISSING_UTXOS_SHOWN))).not.toHaveProperty("missing_utxos_truncated");
  });
});

// ---------- validationSummary / tx_validate ----------

describe("validationSummary", () => {
  it("carries no per-call `semantics` block", () => {
    const record = withContext(fakeRecord());
    record.validation = validation([ev("Spend", 2), ev("Cert", 0)]);
    expect(validationSummary(record)).not.toHaveProperty("semantics");
  });

  it("defaults_applied: a count and a pointer by default (only when there are any), the list on request", () => {
    const record = withContext(fakeRecord());
    record.validation = validation([ev("Spend", 2), ev("Cert", 0)]);
    expect(validationSummary(record)).not.toHaveProperty("defaults_applied");
    expect(validationSummary(record)).not.toHaveProperty("defaults_applied_count");
    chainStateOf(record)!.defaultsApplied = ["slot=5: no tip", "treasuryValue=0"];
    const counted = validationSummary(record) as Json;
    expect(counted.defaults_applied).toBeUndefined();
    expect(counted.defaults_applied_count).toBe(2);
    expect(counted.defaults_note).toMatch(/tx_load's defaults_applied/);
    expect(JSON.stringify(counted).length).toBeLessThan(JSON.stringify(validationSummary(record, { defaults: "full" })).length + 400);
    expect((validationSummary(record, { defaults: "full" }) as Json).defaults_applied).toEqual(["slot=5: no tip", "treasuryValue=0"]);
    expect(validationSummary(withContext(fakeRecord()), { defaults: "full" })).toMatchObject({ defaults_applied: [] });
  });

  it("phase2.redeemers: all rows in order up to 20 with the totals; beyond 20 the failing ones come first", () => {
    const small = withContext(fakeRecord());
    small.validation = validation([ev("Spend", 2), ev("Cert", 0, { success: false, error: "boom" })]);
    const smallPhase2 = (validationSummary(small) as Json).phase2;
    expect(smallPhase2.redeemers.map((r: Json) => r.ref)).toEqual(["spend:2", "publish:0"]);
    expect(smallPhase2).toMatchObject({ redeemers_total: 2, failed_count: 1 });
    expect(smallPhase2.redeemers_truncated).toBeUndefined();

    const total = 30;
    const targets = Array.from({ length: total }, (_, i) => target("spend", i, i));
    const big = withContext(fakeRecord(targets));
    // spend:25 fails, spend:27 only breaks its declared budget, spend:28 has no result at all
    big.validation = validation(
      targets.filter((_, i) => i !== 28).map((t) => ev("Spend", t.index, t.index === 25 ? { success: false, error: "explicit error" } : t.index === 27 ? { calculated_ex_units: { mem: 80, steps: 900 } } : {})),
    );
    const phase2 = (validationSummary(big) as Json).phase2;
    expect(phase2.redeemers).toHaveLength(PHASE2_REDEEMER_ROWS);
    expect(phase2.redeemers.map((r: Json) => r.ref).slice(0, 3)).toEqual(["spend:25", "spend:28", "spend:27"]);
    expect(phase2.redeemers.slice(3).map((r: Json) => r.ref)).toEqual(Array.from({ length: 17 }, (_, i) => `spend:${i}`));
    expect(phase2).toMatchObject({ redeemers_total: total, failed_count: 2, redeemers_truncated: true });
    expect(phase2.redeemers_note).toMatch(/Showing 20 of 30 redeemers, failing first.*tx_redeemer\(redeemer=<ref>\).*tx_inspect\(section='redeemers'\)/);
  });

  it("a redeemer named by a phase-2 error counts as failing", () => {
    const targets = Array.from({ length: 25 }, (_, i) => target("spend", i, i));
    const record = withContext(fakeRecord(targets));
    record.validation = validation(
      targets.map((t) => ev("Spend", t.index)),
      { phase2_errors: [{ error: { NoEnoughBudget: { tag: "Spend", index: 24 } }, error_message: "over", locations: ["transaction.witness_set.redeemers.24"] }] as never },
    );
    const phase2 = (validationSummary(record) as Json).phase2;
    expect(phase2.redeemers[0].ref).toBe("spend:24");
    expect(phase2.failed_count).toBe(1);
  });

  it("phases='phase1' says the scripts still ran: phase2.ran, the failed count, and the verdict counts them", () => {
    const record = withContext(fakeRecord());
    record.validation = validation([ev("Spend", 2), ev("Cert", 0, { success: false, error: "boom" })]);
    expect(verdictOf(record)).toBe("phase2_failed");
    const summary = validationSummary(record, { phases: "phase1" }) as Json;
    expect(summary.verdict).toBe("phase2_failed");
    expect(summary.phase2).toMatchObject({ skipped: true, ran: true, failed_count: 1, redeemers_total: 2, errors_total: 0 });
    expect(summary.phase2.note).toMatch(/hides the phase-2 rows only: the scripts still ran/);
    expect(summary.phase2.redeemers).toBeUndefined();
  });

  it("missing_utxos is capped at 20 with the total", () => {
    const many = Array.from({ length: 25 }, (_, i) => `${"cd".repeat(32)}#${i}`);
    const record = withContext(fakeRecord(), { missingUtxos: many });
    const summary = validationSummary(record) as Json;
    expect(summary.verdict).toBe("incomplete_context");
    expect(summary.missing_utxos).toHaveLength(20);
    expect(summary).toMatchObject({ missing_utxos_total: 25, missing_utxos_truncated: true });
  });
});

describe("tx_validate answers", () => {
  function serviceFor(record: TxRecord, evals: EvalRedeemerResultWire[], state?: Partial<ReturnType<typeof emptyChainState>>) {
    let loads = 0;
    let runs = 0;
    const service = {
      loadContext: async () => {
        loads++;
        withContext(record, state);
      },
      validate: async () => {
        runs++;
        record.validation = validation(evals);
        return record.validation;
      },
    };
    return { service, counts: () => ({ loads, runs }) };
  }

  it("lists the validation resource only, no semantics; defaults as a count once the context was loaded earlier", async () => {
    const record = withContext(fakeRecord(), { defaultsApplied: ["slot=5: no tip", "treasuryValue=0"] });
    const { service, counts } = serviceFor(record, [ev("Spend", 2), ev("Cert", 0)]);
    const ctx = fakeCtx(service);
    ctx.txStore.put(record);
    const first = await txValidate(ctx, { tx_id: record.txId });
    expect(first.isError).toBeFalsy();
    expect(first.content).toHaveLength(1);
    const body = first.structuredContent as Json;
    expect(body).toMatchObject({ verdict: "valid", cached: false, phases: "both", defaults_applied_count: 2 });
    expect(body.semantics).toBeUndefined();
    expect(body.defaults_applied).toBeUndefined();
    expect(uris(first as never)).toEqual([`cardano-debug://tx/${record.txId}/validation.json`]);
    expect(counts()).toEqual({ loads: 0, runs: 1 });
    const cached = await txValidate(ctx, { tx_id: record.txId });
    expect(cached.structuredContent).toMatchObject({ cached: true });
    expect(counts().runs).toBe(1);
  });

  it("a call that loaded the chain state itself lists the defaults in full (tx_load never showed them)", async () => {
    const record = fakeRecord();
    const { service, counts } = serviceFor(record, [ev("Spend", 2), ev("Cert", 0)], { defaultsApplied: ["slot=5: no tip"] });
    const ctx = fakeCtx(service);
    ctx.txStore.put(record);
    const result = await txValidate(ctx, { tx_id: record.txId });
    expect(counts().loads).toBe(1);
    expect(result.structuredContent).toMatchObject({ defaults_applied: ["slot=5: no tip"] });
    expect(result.structuredContent).not.toHaveProperty("defaults_applied_count");
  });

  it("an incomplete context lists the validation / necessary resources it has and the capped missing_utxos", async () => {
    const many = Array.from({ length: 30 }, (_, i) => `${"ef".repeat(32)}#${i}`);
    const record = withContext(fakeRecord(), { missingUtxos: many });
    const ctx = fakeCtx(serviceFor(record, []).service);
    ctx.txStore.put(record);
    const result = await txValidate(ctx, { tx_id: record.txId });
    expect(result.structuredContent).toMatchObject({ verdict: "incomplete_context", missing_utxos_total: 30, missing_utxos_truncated: true });
    expect((result.structuredContent as Json).missing_utxos).toHaveLength(20);
    expect(uris(result as never)).toEqual([`cardano-debug://tx/${record.txId}/necessary.json`]);
  });

  it("an unknown handle is the shared expired_handle answer", async () => {
    const ctx = fakeCtx({});
    const result = await txValidate(ctx, { tx_id: "tx_mainnet_0000000000ff" });
    expect(result).toEqual(expiredHandleError("tx_mainnet_0000000000ff", "tx_load"));
  });
});

// ---------- tx_redeemer ----------

describe("tx_redeemer", () => {
  const CONTEXT_PAD = { script_context_version: "V2", tx_info: { V2: { inputs: Array.from({ length: 3000 }, (_, i) => ({ index: i, pad: "x".repeat(12) })) } }, purpose: {} };

  function loaded(extra: Partial<EvalRedeemerResultWire> = {}, state: Partial<ReturnType<typeof emptyChainState>> = {}) {
    const record = withContext(fakeRecord(), state);
    record.validation = validation([
      ev("Spend", 2, { script_bytes: "4d01", plutus_version: "V2", script_context_bytes: "d87980", script_context: JSON.stringify(CONTEXT_PAD), ...extra }),
      ev("Cert", 0),
    ]);
    const ctx = fakeCtx({ loadContext: async () => undefined, validate: async () => record.validation });
    ctx.txStore.put(record);
    return { record, ctx };
  }
  const call = (ctx: AppContext, record: TxRecord, args: Json = {}) => txRedeemer(ctx, { tx_id: record.txId, redeemer: "spend:2", decode_data: false, ...args } as never);

  it("part=summary lists the seven artefacts of the redeemer and nothing of the transaction", async () => {
    const { record, ctx } = loaded();
    const result = await call(ctx, record);
    expect(result.isError).toBeFalsy();
    expect(uris(result as never)).toEqual(["context.json", "context.cbor", "traces.txt", "error.txt", "script.hex", "parts.json", "links.txt"].map((f) => `cardano-debug://tx/${record.txId}/redeemer/spend:2/${f}`));
  });

  it("the other parts list a link only when the answer was cut (or points at one)", async () => {
    const { record, ctx } = loaded();
    const error = await call(ctx, record, { part: "error" });
    expect(error.structuredContent.resources).toBeUndefined();
    const traces = await call(ctx, record, { part: "traces" });
    expect(traces.structuredContent.resources).toBeUndefined();
    expect(traces.structuredContent.items).toHaveLength(2);

    const cutError = loaded({ success: false, error: "x".repeat(5000) });
    const cut = await call(cutError.ctx, cutError.record, { part: "error" });
    expect(uris(cut as never)).toEqual([`cardano-debug://tx/${cutError.record.txId}/redeemer/spend:2/error.txt`]);

    const cutTrace = loaded({ logs: ["short", "y".repeat(600)] });
    const longTrace = await call(cutTrace.ctx, cutTrace.record, { part: "traces" });
    expect(uris(longTrace as never)).toEqual([`cardano-debug://tx/${cutTrace.record.txId}/redeemer/spend:2/traces.txt`]);
  });

  it("part=context: a cut slice names the context.json resource by its full URI and links it; a whole slice links nothing", async () => {
    const { record, ctx } = loaded();
    const whole = await call(ctx, record, { part: "context", path: "purpose" });
    expect(whole.isError).toBeFalsy();
    expect(whole.structuredContent.resources).toBeUndefined();
    const cut = await call(ctx, record, { part: "context", path: "inputs" });
    expect(cut.structuredContent.truncated).toBe(true);
    const uri = `cardano-debug://tx/${record.txId}/redeemer/spend:2/context.json`;
    expect(cut.structuredContent.hint).toContain(uri);
    expect(uris(cut as never)).toEqual([uri]);
  });

  it("part=script lists the bytes and the two script texts, as `resources` objects", async () => {
    const { record, ctx } = loaded();
    const result = await call(ctx, record, { part: "script" });
    const hash = result.structuredContent.script_hash as string | null;
    expect(hash).toBeNull(); // no hash is known for this fake: the bytes link stays, the texts need a hash
    expect(uris(result as never)).toEqual([`cardano-debug://tx/${record.txId}/redeemer/spend:2/script.hex`]);
    const state = chainStateOf(record)!;
    state.scriptHashes["spend:2"] = { script_hash: "ab".repeat(28), plutus_version: "V2" };
    const known = await call(ctx, record, { part: "script" });
    expect(known.structuredContent.script_hash).toBe("ab".repeat(28));
    expect(uris(known as never)).toEqual([
      `cardano-debug://tx/${record.txId}/redeemer/spend:2/script.hex`,
      `cardano-debug://script/${"ab".repeat(28)}/pseudocode.txt`,
      `cardano-debug://script/${"ab".repeat(28)}/uplc.txt`,
    ]);
    expect((known.structuredContent.resources as Json[])[0]).toMatchObject({ uri: expect.any(String), name: "spend:2 script", mimeType: "text/plain" });
  });

  it("an unknown handle is the shared expired_handle answer", async () => {
    const ctx = fakeCtx({});
    const result = await txRedeemer(ctx, { tx_id: "tx_mainnet_0000000000ff", redeemer: "spend:0" } as never);
    expect(result).toEqual(expiredHandleError("tx_mainnet_0000000000ff", "tx_load"));
  });

  it("a validation cleared while the call ran (parallel refresh) is an answer, not a crash", async () => {
    const record = withContext(fakeRecord());
    const ctx = fakeCtx({ loadContext: async () => undefined, validate: async () => undefined }); // validate leaves record.validation empty
    ctx.txStore.put(record);
    const result = await call(ctx, record);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "no_eval_result", ref: "spend:2" });
    expect(result.structuredContent.message).toMatch(/cleared while this call ran/);
  });

  it("unresolved UTxOs: incomplete_context with the capped list and the total", async () => {
    const many = Array.from({ length: 22 }, (_, i) => `${"12".repeat(32)}#${i}`);
    const { record, ctx } = loaded({}, { missingUtxos: many });
    const result = await call(ctx, record);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "incomplete_context", missing_utxos_total: 22, missing_utxos_truncated: true });
    expect(result.structuredContent.missing_utxos).toHaveLength(20);
  });
});

// ---------- bundle_export ----------

describe("bundle_export", () => {
  const bundle = { captured_at: null, slot: "5", protocol_major: 10, validation_result: undefined, validation_input_context: { utxoSet: [] } };
  function exportCtx(written: Json) {
    const record = withContext(fakeRecord());
    const ctx = fakeCtx({ writeBundle: async () => ({ bundle, text: '{"cardano_debug_bundle":1}', ...written }) });
    ctx.txStore.put(record);
    return { ctx, record };
  }

  it("an unknown handle is the shared expired_handle answer", async () => {
    expect(await bundleExport(fakeCtx({}), { tx_id: "tx_mainnet_0000000000ff" })).toEqual(expiredHandleError("tx_mainnet_0000000000ff", "tx_load"));
  });

  it("written: the path, and the bundle.json resource as the only link", async () => {
    const { ctx, record } = exportCtx({ path: "/cache/bundles/mainnet/x.json", size_bytes: 26 });
    const result = await bundleExport(ctx, { tx_id: record.txId });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ path: "/cache/bundles/mainnet/x.json" });
    expect(result.structuredContent.warning).toBeUndefined();
    expect(result.structuredContent.bundle).toBeUndefined();
    expect(uris(result as never)).toEqual([`cardano-debug://tx/${record.txId}/bundle.json`]);
  });

  it("not written (cache write failed): a warning, the small bundle inlined, no dead resource link", async () => {
    const { ctx, record } = exportCtx({ path: undefined, size_bytes: 26 });
    const result = await bundleExport(ctx, { tx_id: record.txId });
    expect(result.isError).toBeFalsy();
    const body = result.structuredContent as Json;
    expect(body.path).toBeNull();
    expect(body.warning).toMatch(/could not be written to the disk cache.*CARDANO_DEBUG_CACHE_DIR/);
    expect(body.bundle).toBe('{"cardano_debug_bundle":1}');
    expect(body.replay).toMatch(/the bundle JSON/);
    expect(body.resources).toBeUndefined();
  });

  it("not written and too large to inline: an error that says so", async () => {
    const { ctx, record } = exportCtx({ path: undefined, size_bytes: 200_000 });
    const result = await bundleExport(ctx, { tx_id: record.txId });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "bundle_not_written", size_bytes: 200_000 });
    expect(result.structuredContent.message).toMatch(/CARDANO_DEBUG_CACHE_DIR/);
  });
});

// ---------- dataView: versions ----------

describe("reference script versions", () => {
  const HASH = "ab".repeat(28);
  const resolved = resolvedUtxosFromContext({
    validationContext: {
      utxoSet: [
        { utxo: { input: { txHash: "cc".repeat(32), outputIndex: 0 }, output: { address: "addr1vx", amount: [], scriptHash: HASH } }, isSpent: false },
        { utxo: { input: { txHash: "dd".repeat(32), outputIndex: 1 }, output: { address: "addr1vx", amount: [], scriptRef: "820359ab00", scriptHash: "cd".repeat(28) } }, isSpent: false },
      ],
    },
  });

  it("a reference script whose language the data lacks is `unknown`, not V2", () => {
    const rows = referenceScriptsOf(resolved, [`${"cc".repeat(32)}#0`, `${"dd".repeat(32)}#1`]);
    expect(rows.map((r) => [r.script_hash, r.plutus_version])).toEqual([
      [HASH, "unknown"],
      ["cd".repeat(28), "V3"],
    ]);
  });

  it("mint / withdraw / publish redeemers get the version of their script from the inventory; a version they carry stays", () => {
    const mint: RedeemerTarget = { ...target("mint", 0, 0), script_hash: "cd".repeat(28) };
    const withdraw: RedeemerTarget = { ...target("withdraw", 0, 1), script_hash: "cd".repeat(28), plutus_version: "V1" };
    const publishUnknown: RedeemerTarget = { ...target("publish", 0, 2), script_hash: HASH };
    const out = withSpendScriptHashes([mint, withdraw, publishUnknown], [], resolved, new Map([["cd".repeat(28), "V3"]]));
    expect(out[0]).toMatchObject({ ref: "mint:0", plutus_version: "V3" });
    expect(out[1]).toBe(withdraw);
    expect(out[2]).toBe(publishUnknown);
    expect(mint.plutus_version).toBeUndefined(); // input untouched
  });
});

// ---------- tx_inspect / tx_add_witnesses against the real lib ----------

const LIB_WORKER = path.join(PROJECT_ROOT, "dist", "workers", "lib.worker.js");
const fixture = readTx;

describe.skipIf(!existsSync(LIB_WORKER))("tx_inspect / tx_add_witnesses (real lib worker)", () => {
  let lib: LibClient;
  let ctx: AppContext;
  let record: TxRecord;

  beforeAll(async () => {
    const config = loadConfig({});
    lib = createLibClient(config, { entry: new URL(`file://${LIB_WORKER}`) });
    const txStore = new TxStore();
    const sessions = new SessionRegistry({ sweepIntervalMs: 60_000 });
    ctx = { config, lib, txStore, sessions, startedAt: Date.now(), services: { chain: {} as never }, onShutdown: () => undefined, shutdown: async () => undefined };
    record = await buildTxRecord(lib, { tx: fixture("lock-spend.tx"), network: "mainnet" });
    txStore.put(record);
  });

  afterAll(async () => {
    ctx.sessions.closeAll("shutdown");
    await lib.dispose();
  });

  it("section is optional and defaults to body; the schema error lists the sections", async () => {
    const result = await txInspect(ctx, { tx_id: record.txId });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.section).toBe("body");
    expect(result.structuredContent.rows).toHaveLength(1);

    let schema: { safeParse(input: unknown): { success: boolean; error?: { issues: Array<{ message: string }> } } } | undefined;
    txInspectTool.register({ registerTool: (_name: string, config: { inputSchema: typeof schema }) => void (schema = config.inputSchema) } as never, ctx);
    expect(schema!.safeParse({ tx_id: record.txId }).success).toBe(true);
    expect(schema!.safeParse({ tx_id: record.txId, section: "inputs" }).success).toBe(true);
    const bad = schema!.safeParse({ tx_id: record.txId, section: "view" });
    expect(bad.success).toBe(false);
    const message = bad.error!.issues[0]!.message;
    expect(message).toContain('"view"');
    for (const section of ["body", "inputs", "outputs", "redeemers", "scripts", "datums", "witnesses", "certs", "governance", "aux", "mint", "withdrawals", "raw_json"]) expect(message).toContain(section);
    expect(message).toContain("default body");
  });

  it("resources are listed by body (and a cut raw_json), not repeated by other sections or pages", async () => {
    const base = `cardano-debug://tx/${record.txId}`;
    const body = await txInspect(ctx, { tx_id: record.txId, section: "body" });
    expect(uris(body as never)).toEqual([`${base}/decoded.json`, `${base}/cbor`]);
    expect(body.content).toHaveLength(1);
    for (const section of ["inputs", "outputs", "redeemers", "scripts"] as const) {
      const answer = await txInspect(ctx, { tx_id: record.txId, section });
      expect(answer.isError, section).toBeFalsy();
      expect(answer.structuredContent.resources, section).toBeUndefined();
    }
    const small = await txInspect(ctx, { tx_id: record.txId, section: "raw_json", path: "/transaction/body/fee" });
    expect(small.structuredContent.resources).toBeUndefined();
    const big = await buildTxRecord(lib, { tx: fixture("wide-mint.tx"), network: "mainnet" });
    ctx.txStore.put(big);
    const whole = await txInspect(ctx, { tx_id: big.txId, section: "raw_json", depth: 6 });
    expect(whole.structuredContent.truncated).toBe(true);
    expect(uris(whole as never)).toEqual([`cardano-debug://tx/${big.txId}/decoded.json`]);
    expect(whole.structuredContent.hint).toContain(`cardano-debug://tx/${big.txId}/decoded.json`);
  });

  it("body: the redeemers' unresolved UTxOs are capped like everywhere else", async () => {
    const many = Array.from({ length: 23 }, (_, i) => `${"34".repeat(32)}#${i}`);
    const copy = { ...record, txId: "tx_mainnet_0000000000aa", missingUtxos: many } as TxRecord;
    ctx.txStore.put(copy);
    const result = await txInspect(ctx, { tx_id: copy.txId, section: "body" });
    const row = (result.structuredContent.rows as Json[])[0]!;
    expect(row.missing_utxos).toHaveLength(20);
    expect(row).toMatchObject({ missing_utxos_total: 23, missing_utxos_truncated: true });
  });

  it("tx_add_witnesses: the handle's own bytes are signed even if the store evicted the record meanwhile; unknown handles are the shared answer", async () => {
    const unknown = await txAddWitnesses(ctx, { tx_id: "tx_mainnet_0000000000ff", witnesses: ["00"] });
    expect(unknown).toEqual(expiredHandleError("tx_mainnet_0000000000ff", "tx_load"));

    const signedCopy = await buildTxRecord(lib, { tx: fixture("lock-spend.tx"), network: "mainnet" });
    ctx.txStore.put(signedCopy);
    const evicting = {
      ...ctx,
      lib: new Proxy(lib, {
        get(target, property, receiver) {
          if (property === "addWitnesses") {
            return async (...args: Parameters<LibClient["addWitnesses"]>) => {
              ctx.txStore.evict(signedCopy.txId); // the LRU / TTL took it while the library worked
              return target.addWitnesses(...args);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as AppContext;
    const result = await txAddWitnesses(evicting, { tx_id: signedCopy.txId, witnesses: [fixture("lock-spend.tx")], revalidate: false });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ tx_id: signedCopy.txId, tx_id_unchanged: true });
    expect(uris(result as never)).toEqual([`cardano-debug://tx/${signedCopy.txId}/cbor`]);
    expect(ctx.txStore.peek(signedCopy.txId)).toBeDefined();
  });
});
