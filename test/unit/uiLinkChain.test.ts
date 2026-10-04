// ui_link over a loaded transaction, offline: the artificial S1 sample DebuggerContext through tx_load, the
// library in this thread (no worker, no dist). The chain context a link carries (a bundle's context is
// assembled into the link and loads back), and the resolution of the caller's targets against the
// decoded transaction, its validation and its redeemers.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { configure, type ValidationInputContext } from "@cardananium/cquisitor-lib";
import { nodeBrotliCompressor } from "@cardananium/cquisitor-lib/node";
import { parseCardanoCborShare, parseHash, parseValidatorShare } from "@cardananium/cquisitor-lib/share";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { stringifyForLib } from "../../src/chain/contextCodec.js";
import { assembledFetchedData, buildLinks, contextNote, cquisitorTxUrl } from "../../src/chain/links.js";
import { chainStateOf } from "../../src/chain/state.js";
import { loadConfig } from "../../src/config.js";
import { createAppContext, type AppContext } from "../../src/context.js";
import type { LibClient } from "../../src/lib.js";
import { readResourceUri } from "../../src/resources.js";
import type { TxRecord } from "../../src/store/txStore.js";
import { txLoad } from "../../src/tools/tx_load.js";
import { uiLink, uiLinkInputSchema } from "../../src/tools/ui_link.js";
import { fixturePath, fxArr, fxInt, fxStr } from "../helpers/fixtures.js";
import { inProcessLib } from "../helpers/inProcessLib.js";

type Json = Record<string, any>;

const SAMPLE = fixturePath(fxStr("s01.contextFile"));
// the validator's verdict on the S1 sample, in the order ui_link numbers it (errors phase 1, phase 2, then warnings)
const DIAGNOSTICS = [...fxArr<string>("s01.diagnostics.errors"), ...fxArr<string>("s01.diagnostics.phase2Warnings")];
const DIAGNOSTIC_NAMES = [...new Set(DIAGNOSTICS)];
const CQ = "http://localhost:3011";

const shareOf = async (url: string) => parseValidatorShare(parseHash(url.split("#")[1]!).params);

describe("the context a transaction link carries", () => {
  const emptyContext = (): ValidationInputContext =>
    ({
      utxoSet: [
        { utxo: { input: { txHash: "AA".repeat(32), outputIndex: 1 }, output: { address: "addr_test1", amount: [{ unit: "lovelace", quantity: "5000000" }, { unit: `${"bb".repeat(28)}6162`, quantity: "7" }], dataHash: "cc".repeat(32), plutusData: "d87980", scriptRef: null, scriptHash: null } }, isSpent: false },
        { utxo: { input: { txHash: "dd".repeat(32), outputIndex: 0 }, output: { address: "addr_test2", amount: [{ unit: "lovelace", quantity: "1" }], scriptRef: null, scriptHash: null } }, isSpent: true },
      ],
      protocolParameters: { protocolVersion: [9, 0] } as never,
      slot: 1234,
      accountContexts: [],
      drepContexts: [],
      poolContexts: [],
      govActionContexts: [],
      lastEnactedGovAction: [],
      currentCommitteeMembers: [],
      potentialCommitteeMembers: [],
      treasuryValue: 99,
      networkType: "preprod",
    }) as ValidationInputContext;

  it("assembledFetchedData: the context fields without networkType, bigints, a row per UTxO (the provider's own row wins)", () => {
    expect(assembledFetchedData({ context: undefined, providerRows: undefined })).toBeUndefined();
    const fetched = assembledFetchedData({ context: emptyContext(), providerRows: undefined })!;
    expect(fetched).not.toHaveProperty("networkType");
    expect(fetched.slot).toBe(1234n);
    expect(fetched.treasuryValue).toBe(99n);
    expect(fetched.constitution).toBeNull();
    expect(fetched.utxoSet).toHaveLength(2);
    expect(fetched.utxoInfos).toEqual([
      {
        tx_hash: "aa".repeat(32),
        tx_index: 1,
        address: "addr_test1",
        value: "5000000",
        stake_address: null,
        payment_cred: null,
        epoch_no: 0,
        block_height: 0,
        block_time: 0,
        datum_hash: "cc".repeat(32),
        inline_datum: { bytes: "d87980", value: null },
        reference_script: null,
        asset_list: [{ policy_id: "bb".repeat(28), asset_name: "6162", fingerprint: "", decimals: 0, quantity: "7" }],
        is_spent: false,
      },
      expect.objectContaining({ tx_hash: "dd".repeat(32), tx_index: 0, value: "1", asset_list: null, datum_hash: null, inline_datum: null, is_spent: false }),
    ]);
    const own = { tx_hash: "dd".repeat(32), tx_index: 0, address: "addr_provider", value: "1", stake_address: "stake1x", payment_cred: "ee", epoch_no: 7, block_height: 8, block_time: 9, datum_hash: null, inline_datum: null, reference_script: null, asset_list: null, is_spent: true };
    const merged = assembledFetchedData({ context: emptyContext(), providerRows: { utxo_info: [own] } as never })!;
    expect(merged.utxoInfos[1]).toBe(own);
    expect(merged.utxoInfos[0]!.address).toBe("addr_test1");
  });

  it("cquisitorTxUrl: fetched data as is; else an assembled context; else the transaction alone; each with its note", async () => {
    const config = { cquisitorBase: { origin: CQ, basePath: "" } };
    configure({ compressor: nodeBrotliCompressor });
    const record = (chain: Json | undefined) => ({ txHex: "84a0f5f6", network: "preprod", extra: chain ? { chain } : {} }) as unknown as TxRecord;
    const fetched = assembledFetchedData({ context: emptyContext(), providerRows: undefined })!;

    const live = await cquisitorTxUrl(config, record({ context: emptyContext(), fetched, capturedAt: 5 }));
    expect(live).toMatchObject({ withContext: true, assembled: false });
    expect(contextNote(live)).toBeUndefined();
    expect((await shareOf(live.url)).ctx!.utxoInfos).toHaveLength(2);

    const assembled = await cquisitorTxUrl(config, record({ context: emptyContext(), capturedAt: null }));
    expect(assembled).toMatchObject({ withContext: true, assembled: true });
    expect(contextNote(assembled)).toMatch(/assembled from the bundle \/ DebuggerContext, not fetched/);
    const share = await shareOf(assembled.url);
    expect(share.net).toBe("preprod");
    expect(share.ctx!.utxoSet).toHaveLength(2);
    expect(share.ctx!.utxoInfos).toHaveLength(2);
    expect(share.capturedAt).toBeUndefined();

    const bare = await cquisitorTxUrl(config, record(undefined));
    expect(bare).toMatchObject({ withContext: false, assembled: false });
    expect(contextNote(bare)).toMatch(/carries the transaction only/);
    expect((await shareOf(bare.url)).ctx).toBeUndefined();
  });
});

describe("ui_link over the S1 sample transaction (offline bundle)", () => {
  let ctx: AppContext;
  let txId: string;
  let cacheDir: string;

  beforeAll(async () => {
    configure({ compressor: nodeBrotliCompressor });
    cacheDir = mkdtempSync(path.join(os.tmpdir(), "cdm-uichain-"));
    const config = { ...loadConfig({ CARDANO_DEBUG_OFFLINE: "1", CARDANO_DEBUG_NO_OPEN: "1" }), cacheDir, cquisitorBase: { origin: CQ, basePath: "" } };
    const lib = Object.assign(inProcessLib(), { dispose: async () => undefined }) as unknown as LibClient;
    ctx = createAppContext({ config, lib });
    const load = await txLoad(ctx, { bundle: SAMPLE });
    expect(load.isError).toBeFalsy();
    txId = load.structuredContent.tx_id as string;
  }, 60_000);

  afterAll(async () => {
    await ctx.shutdown();
  });

  const call = async (args: Json) => (await uiLink(ctx, uiLinkInputSchema.parse(args))).structuredContent as Json;
  const fullUrl = async (body: Json): Promise<string> => (typeof body.url === "string" ? body.url : (await readResourceUri(ctx, new URL(body.link_resource))).contents[0]!.text!);

  it("targets are resolved against the decoded transaction and its redeemers; a redeemer tag gets its canonical case", async () => {
    const body = await call({
      app: "cquisitor",
      tx_id: txId,
      annotations: [
        { target: { kind: "tx_path", path: "transaction.body.fee" }, label: "fee" },
        { target: { kind: "tx_path", path: "transaction.body.nonsense.99" } },
        { target: { kind: "tx_path", path: "transaction.body.outputs.99" } },
        { target: { kind: "tx_path", path: "/transaction/body/fee" } },
        { target: { kind: "tx_path", path: "body.fee" } },
        { target: { kind: "redeemer", tag: "spend", index: 2 }, label: "the spend" },
        { target: { kind: "redeemer", tag: "Spend", index: 77 } },
        { target: { kind: "redeemer", tag: "Frobnicate", index: 0 } },
        { target: { kind: "diagnostic", index: 500 } },
        { target: { kind: "diagnostic", name: "FeeTooSmallUTxO" } },
      ],
      focus: 5,
    });
    expect(body.annotations_count).toBe(4);
    const dropped = body.dropped as Array<{ index: number; reason: string; available?: unknown }>;
    expect(dropped.map((d) => d.index)).toEqual([1, 2, 3, 4, 6, 7]);
    expect(dropped[0]!.reason).toMatch(/tx_path transaction\.body\.nonsense\.99 is not in the decoded transaction \(resolved up to transaction\.body\)/);
    expect(dropped[0]!.available).toEqual(expect.arrayContaining(["transaction.body.fee", "transaction.body.outputs"]));
    expect(dropped[1]!.reason).toMatch(/resolved up to transaction\.body\.outputs/);
    expect(dropped[1]!.available).toEqual([expect.stringMatching(/^transaction\.body\.outputs\.0\.\.transaction\.body\.outputs\.\d+$/)]);
    expect(dropped[2]!.reason).toMatch(/dotted path.*not a JSON pointer/);
    expect(dropped[3]!.reason).toMatch(/starts at "transaction"/);
    expect(dropped[4]).toMatchObject({ reason: "this transaction has no Spend redeemer with index 77", available: fxArr<string>("s01.redeemers") });
    expect(dropped[5]).toMatchObject({ reason: 'unknown redeemer tag "Frobnicate"', available: expect.arrayContaining(["Spend", "Mint"]) });
    // the diagnostics were not checked: the transaction has not been validated here
    expect(body.notes.join("\n")).toMatch(/diagnostic targets are not checked: the transaction has not been validated here/);
    expect(body.focus).toBe(1);
    const share = await shareOf(await fullUrl(body));
    expect(share.annotations.map((a) => a.target)).toEqual([
      { kind: "tx_path", path: "transaction.body.fee" },
      { kind: "redeemer", tag: "Spend", index: 2 },
      { kind: "diagnostic", index: 500 },
      { kind: "diagnostic", name: "FeeTooSmallUTxO" },
    ]);
    expect(share.annotationFocus).toBe(1);
  });

  it("the cardano-cbor tab of a loaded transaction: its bytes, its network, the Transaction type; a different network asked for is ignored with a note", async () => {
    const body = await call({ app: "cquisitor", tab: "cardano-cbor", tx_id: txId, network: "preprod" });
    expect(body.notes.join("\n")).toMatch(/network preprod ignored: the transaction tx_mainnet_[0-9a-f]{12} is on mainnet/);
    const share = await parseCardanoCborShare(parseHash((await fullUrl(body)).split("#")[1]!).params);
    expect(share).toMatchObject({ net: "mainnet", type: "Transaction", cbor: ctx.txStore.peek(txId)!.txHex });
  });

  it("once validated, diagnostics are bounds-checked: by index, by name and occurrence", async () => {
    const validated = await call({ app: "cquisitor", tx_id: txId, from: ["validation"] });
    expect(validated.annotations_count).toBe(fxInt("s01.diagnostics.uiAnnotations")); // each diagnostic, with the first of its locations
    const total = fxInt("s01.diagnostics.total");
    expect(DIAGNOSTICS).toHaveLength(total);
    const budgetCount = DIAGNOSTICS.filter((name) => name === "BudgetIsBiggerThanExpected").length;
    const body = await call({
      app: "cquisitor",
      tx_id: txId,
      annotations: [
        { target: { kind: "diagnostic", index: total - 1 } },
        { target: { kind: "diagnostic", index: total } },
        { target: { kind: "diagnostic", name: "ScriptDataHashMismatch" } },
        { target: { kind: "diagnostic", name: "BudgetIsBiggerThanExpected", occurrence: 1 } },
        { target: { kind: "diagnostic", name: "BudgetIsBiggerThanExpected", occurrence: budgetCount + 1 } },
        { target: { kind: "diagnostic", name: "NoSuchError" } },
      ],
      focus: 1,
    });
    const dropped = body.dropped as Array<{ index: number; reason: string; available?: string[] }>;
    expect(dropped.map((d) => d.index)).toEqual([1, 4, 5]);
    expect(dropped[0]).toMatchObject({ reason: `diagnostic index ${total} is past the last diagnostic (${total}; errors phase 1, phase 2, then warnings)` });
    expect(dropped[0]!.available).toEqual(DIAGNOSTICS.map((name, i) => `${i}: ${name}`));
    expect(dropped[1]!.reason).toBe(`diagnostic BudgetIsBiggerThanExpected occurs ${budgetCount} time(s); occurrence ${budgetCount + 1} does not exist`);
    expect(dropped[2]).toMatchObject({ reason: "no diagnostic named NoSuchError in the validation", available: DIAGNOSTIC_NAMES });
    expect(body.annotations_count).toBe(3);
    // focus 1 pointed at the dropped entry: the next kept one (raw 2) is focused, and the note says so
    expect(body.focus).toBe(1);
    expect(body.notes.join("\n")).toMatch(new RegExp(`focus 1 pointed at a dropped annotation \\(diagnostic index ${total} is past the last diagnostic`));
  });

  it("a bundle's link carries the context it was validated against (rows included) and loads back through tx_load", async () => {
    const body = await call({ app: "cquisitor", tx_id: txId, annotations: [{ target: { kind: "tx_path", path: "transaction.body.fee" }, label: "fee" }] });
    expect(body).toMatchObject({ tab: "transaction-validator", annotations_count: 1, dropped: [] });
    expect(body.notes.join("\n")).toMatch(/assembled from the bundle \/ DebuggerContext, not fetched/);
    expect(body.notes.join("\n")).not.toMatch(/transaction only/);
    const url = await fullUrl(body);
    const share = await shareOf(url);
    const original = chainStateOf(ctx.txStore.peek(txId)!)!.context!;
    expect(share.net).toBe("mainnet");
    expect(share.ctx).toBeDefined();
    expect(share.ctx).not.toHaveProperty("networkType");
    expect(share.ctx!.utxoSet).toHaveLength(original.utxoSet.length);
    const rows = share.ctx!.utxoInfos;
    expect(rows).toHaveLength(original.utxoSet.length);
    for (const [i, row] of rows.entries()) {
      const { input, output } = original.utxoSet[i]!.utxo;
      expect(row).toMatchObject({ tx_hash: input.txHash, tx_index: input.outputIndex, address: output.address, value: output.amount[0]!.quantity, is_spent: false });
    }
    const withAssets = rows.find((r) => r.asset_list)!;
    expect(withAssets.asset_list!.every((a) => a.policy_id.length === 56 && /^\d+$/.test(a.quantity))).toBe(true);
    const inline = original.utxoSet.find((u) => u.utxo.output.plutusData)!;
    expect(rows.find((r) => r.tx_hash === inline.utxo.input.txHash && r.tx_index === inline.utxo.input.outputIndex)!.inline_datum!.bytes).toBe(inline.utxo.output.plutusData);
    const ref = rows.find((r) => r.reference_script)!;
    expect(ref.reference_script).toMatchObject({ type: expect.stringMatching(/^plutusV[123]$/), size: expect.any(Number), bytes: expect.any(String) });
    expect(ref.reference_script!.size).toBe(ref.reference_script!.bytes.length / 2);
    expect(original.utxoSet.some((u) => u.utxo.output.scriptHash === ref.reference_script!.hash)).toBe(true);

    // the link is a transaction-validator share link with context: tx_load reads it back into the same state
    await call({ app: "cquisitor", tx_id: txId, from: ["validation"] });
    const before = ctx.txStore.peek(txId)!;
    const verdict = JSON.stringify(before.validation!.result);
    ctx.txStore.evict(txId);
    const reload = await txLoad(ctx, { bundle: url });
    expect(reload.isError, JSON.stringify(reload.structuredContent).slice(0, 300)).toBeFalsy();
    expect(reload.structuredContent.tx_id).toBe(txId);
    const after = ctx.txStore.peek(txId)!;
    const state = chainStateOf(after)!;
    expect(state.fetched).toBeDefined();
    expect(state.origin).toMatch(/cquisitor share link/);
    expect(stringifyForLib(state.context!)).toBe(stringifyForLib(original));
    expect(state.missingUtxos).toEqual([]);
    await call({ app: "cquisitor", tx_id: txId, from: ["validation"] });
    expect(JSON.stringify(ctx.txStore.peek(txId)!.validation!.result)).toBe(verdict);
    // and now the link embeds the fetched data itself: no "assembled" note
    const again = await call({ app: "cquisitor", tx_id: txId });
    expect(again.notes.join("\n")).not.toMatch(/assembled|transaction only/);
  });

  it("from=validation: a diagnostic per error and a tx_path for its first location only; diagnostics are bounds-checked", async () => {
    const sample = JSON.parse(readFileSync(SAMPLE, "utf8")) as Json;
    (sample.utxos as Json[]).find((u) => typeof u.inlineDatum === "string")!.inlineDatum = "81".repeat(100) + "00";
    const failingFile = path.join(cacheDir, "failing-spend.json");
    writeFileSync(failingFile, JSON.stringify(sample));
    expect((await txLoad(ctx, { bundle: failingFile })).isError).toBeFalsy();

    const body = await call({ app: "cquisitor", tx_id: txId, from: ["validation"], annotations: [{ target: { kind: "diagnostic", index: 500 } }] });
    const record = ctx.txStore.peek(txId)!;
    const diagnostics = (await import("../../src/ui/autoAnnotations.js")).indexedDiagnostics(record);
    expect(diagnostics.length).toBeGreaterThan(1);
    expect(body.dropped).toEqual([{ index: 0, reason: expect.stringMatching(new RegExp(`diagnostic index 500 is past the last diagnostic \\(${diagnostics.length};`)), available: diagnostics.slice(0, 12).map((d) => `${d.index}: ${d.name}`) }]);
    const share = await shareOf(await fullUrl(body));
    const kinds = share.annotations.map((a) => a.target.kind);
    expect(kinds.filter((k) => k === "diagnostic")).toHaveLength(diagnostics.length);
    expect(kinds.filter((k) => k === "tx_path").length).toBeLessThanOrEqual(diagnostics.length);
    expect(body.annotations_count).toBeLessThanOrEqual(2 * diagnostics.length);
    // the app re-validates against the embedded context, so these indices mean what the server's validation says
    expect(share.ctx).toBeDefined();
    expect(share.annotations.find((a) => a.label === "MachineError")).toMatchObject({ severity: "error", target: { kind: "diagnostic" } });
  });

  it("the failing term of a failed redeemer survives the rewind: ui_link(tx_id, from=validation) and tx_redeemer's links both mark it", async () => {
    // the failing variant of the previous test is still loaded
    const record = ctx.txStore.peek(txId)!;
    const ev = record.validation!.redeemers.get("spend:2")!;
    expect(ev.success).toBe(false);
    const deUplc = (url: string): Json => JSON.parse(gunzipSync(Buffer.from(url.split("#d=")[1]!, "base64url")).toString("utf8"));

    const none = await call({ app: "de_uplc", tx_id: txId, redeemer: "spend:2", from: ["validation"] });
    expect(none.annotations_count).toBe(0);
    expect(none.notes.join("\n")).toMatch(/does not report the failing term: debug_open \+ debug_run\(until='error'\)/);
    expect((await buildLinks(ctx, record, ev)).notes.join("\n")).toMatch(/no failing-term annotation: the validator does not report the failing term/);

    // a session that ran to an error term and was rewound (status back to ready)
    const stub = { lost: false, close: async () => undefined } as never;
    const { record: session } = ctx.sessions.create({ mode: "tx", language: "V2", partsConfig: { script: "00" }, txId, redeemer: "spend:2", client: stub, lastStatus: "ready", errorTermId: 12 });
    const viaTx = await call({ app: "de_uplc", tx_id: txId, redeemer: "spend:2", from: ["validation"] });
    expect(viaTx).toMatchObject({ annotations_count: 1, dropped: [] });
    const marked = (deUplc(await fullUrl(viaTx)).ann as Json[])[0]!;
    expect(marked).toEqual({ target: { kind: "term", term_id: 12 }, label: "spend:2 fails here", severity: "error", hint: expect.stringMatching(/^Plutus machine error: /) });
    expect(marked.hint).not.toMatch(/Environment|\n.{300}/);
    const links = await buildLinks(ctx, record, ev);
    expect(deUplc(links.de_uplc_url!).ann).toEqual([marked]);
    expect(links.notes.join("\n")).not.toMatch(/failing-term annotation/);
    // the cquisitor link of the same redeemer embeds the assembled context
    expect(links.notes.join("\n")).toMatch(/cquisitor link embeds a context assembled from the bundle/);
    expect((await shareOf(links.cquisitor_url!)).ctx).toBeDefined();

    // a failure without a term of its own, once rewound: nothing to mark, and the note says why instead of looping
    session.errorTermId = null;
    const gone = await call({ app: "de_uplc", tx_id: txId, redeemer: "spend:2", from: ["validation"] });
    expect(gone.annotations_count).toBe(0);
    expect(gone.notes.join("\n")).toMatch(/failed without a term of its own \(a builtin or machine error\): there is no term to mark/);
    ctx.sessions.close(session.dbgId);
  });
});
