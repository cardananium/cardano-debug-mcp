// ui_link over stdio, offline: the artificial S1 sample DebuggerContext (and a variant whose spend
// redeemer fails on a too-deep inline datum) validated without network; links into cquisitor and
// de-uplc-web at the base URLs of CARDANO_DEBUG_CQUISITOR_URL / CARDANO_DEBUG_DE_UPLC_URL, decoded
// back with the library's share parser and by gunzipping the #d= payload. CARDANO_DEBUG_TEST_HOOKS
// replaces the OS opener with a stderr line (no browser).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { configure } from "@cardananium/cquisitor-lib";
import { nodeBrotliCompressor } from "@cardananium/cquisitor-lib/node";
import { parseHash, parseValidatorShare } from "@cardananium/cquisitor-lib/share";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixturePath, fxStr } from "../helpers/fixtures.js";
import { PROJECT_ROOT, StdioClient } from "../helpers/stdioClient.js";

type Json = Record<string, any>;

const SAMPLE = fixturePath(fxStr("s01.contextFile"));
const SPEND_SCRIPT_HASH = fxStr("s01.spendScript.hash");
const CQ = "http://localhost:3011";
const DU = "http://localhost:5173";

function deUplcPayload(url: string): Json {
  expect(url.startsWith(`${DU}/#d=`), url.slice(0, 80)).toBe(true);
  return JSON.parse(gunzipSync(Buffer.from(url.split("#d=")[1]!, "base64url")).toString("utf8"));
}

async function cquisitorShare(url: string) {
  expect(url.startsWith(`${CQ}/#transaction-validator?`), url.slice(0, 80)).toBe(true);
  const parsed = parseHash(url.split("#")[1]!);
  return parseValidatorShare(parsed.params);
}

describe("ui_link over stdio (offline bundle)", () => {
  let client: StdioClient;
  let cacheDir: string;
  let txId: string;
  let failingTx: string;

  /** Full URL of a ui_link answer (inline or from its link resource). */
  const fullUrl = async (body: Json): Promise<string> => (typeof body.url === "string" ? body.url : client.readResourceText(body.link_resource));
  const call = async (args: Json): Promise<Json> => {
    const result = await client.callTool<Json>("ui_link", args, 180_000);
    expect(result.isError, JSON.stringify(result.structuredContent).slice(0, 600)).toBeFalsy();
    return result.structuredContent!;
  };

  beforeAll(async () => {
    configure({ compressor: nodeBrotliCompressor });
    expect(existsSync(path.join(PROJECT_ROOT, "dist", "server.js")), "run `npm run build` before the e2e test").toBe(true);
    cacheDir = mkdtempSync(path.join(os.tmpdir(), "cdm-ui-"));
    client = StdioClient.dist(process.execPath, {
      CARDANO_DEBUG_OFFLINE: "1",
      CARDANO_DEBUG_CACHE_DIR: cacheDir,
      CARDANO_DEBUG_TEST_HOOKS: "1",
      CARDANO_DEBUG_CQUISITOR_URL: CQ,
      CARDANO_DEBUG_DE_UPLC_URL: `${DU}/`,
    });
    await client.initialize();
    const load = await client.callTool<Json>("tx_load", { bundle: SAMPLE });
    expect(load.isError).toBeFalsy();
    txId = load.structuredContent!.tx_id;
    // the spend script meets a list where it expects a constructor: MachineError on spend:2
    const sample = JSON.parse(readFileSync(SAMPLE, "utf8")) as Json;
    (sample.utxos as Json[]).find((u) => typeof u.inlineDatum === "string")!.inlineDatum = "81".repeat(100) + "00";
    const file = path.join(cacheDir, "failing-spend.json");
    writeFileSync(file, JSON.stringify(sample));
    const failing = await client.callTool<Json>("tx_load", { bundle: file });
    expect(failing.isError).toBeFalsy();
    failingTx = failing.structuredContent!.tx_id;
  });

  afterAll(async () => {
    const code = await client.close();
    expect(client.nonJsonStdout, "stdout must carry only JSON-RPC").toEqual([]);
    expect(code).toBe(0);
  });

  it("cquisitor + from=validation: a diagnostic per error / warning and a tx_path for its first location, in the app's order", async () => {
    const validation = (await client.callTool<Json>("tx_validate", { tx_id: failingTx }, 120_000)).structuredContent!;
    const ordered = [...validation.phase1.errors, ...validation.phase2.errors, ...(validation.phase1.warnings ?? []), ...(validation.phase2.warnings ?? [])] as Json[];
    expect(ordered.length).toBeGreaterThan(0);
    const body = await call({ app: "cquisitor", tx_id: failingTx, from: ["validation"], annotations: [{ target: { kind: "tx_path", path: "transaction.body.fee" }, label: "fee" }, { target: { kind: "term", term_id: 1 } }] });
    expect(body).toMatchObject({ app: "cquisitor", tab: "transaction-validator", focus: 0, opened: false });
    expect(body.dropped).toEqual([{ index: 1, reason: "term is a de-uplc-web target, not one of cquisitor" }]);
    const share = await cquisitorShare(await fullUrl(body));
    expect(share.cbor).toBeTruthy();
    // the URL is also a file under the cache dir (link_file), the same text as the resource
    expect(body.link_file.startsWith(path.join(cacheDir, "links"))).toBe(true);
    expect(readFileSync(body.link_file, "utf8")).toBe(await fullUrl(body));
    // a bundle carries no provider-fetched context: the link embeds the one assembled from it, so the app does not refetch
    expect(share.ctx).toBeDefined();
    expect(share.ctx!.utxoInfos.length).toBe(share.ctx!.utxoSet.length);
    expect(body.notes.join("\n")).toMatch(/assembled from the bundle \/ DebuggerContext, not fetched/);
    expect(body.notes.join("\n")).not.toMatch(/transaction only/);
    expect(share.annotations[0]).toEqual({ target: { kind: "tx_path", path: "transaction.body.fee" }, label: "fee" });
    const generated = share.annotations.slice(1);
    expect(generated).toHaveLength(body.annotations_count - 1);
    const diagnostics = generated.filter((a) => a.target.kind === "diagnostic");
    expect(diagnostics.length).toBe(Math.min(ordered.length, diagnostics.length));
    diagnostics.forEach((a, i) => {
      expect(a.target).toEqual({ kind: "diagnostic", index: i });
      expect(a.label).toBe(ordered[i]!.name);
      expect(a.hint).toBeUndefined(); // the app shows each diagnostic's message and hint itself
    });
    const paths = generated.filter((a) => a.target.kind === "tx_path").map((a) => (a.target as { path: string }).path);
    expect(paths).toEqual(ordered.map((o) => (o.locations as string[])[0]).filter((p): p is string => typeof p === "string"));
    expect(generated.find((a) => a.label === "MachineError")!.severity).toBe("error");
  });

  it("tx_redeemer part='links' of a failed redeemer: cquisitor highlights its row and diagnostics; de-uplc gets the failing term once a session stopped there", async () => {
    const before = (await client.callTool<Json>("tx_redeemer", { tx_id: failingTx, redeemer: "spend:2", part: "links" }, 120_000)).structuredContent!;
    expect(before.notes.join("\n")).toMatch(/no failing-term annotation/);
    const links = await client.readResourceText(`cardano-debug://tx/${failingTx}/redeemer/spend:2/links.txt`);
    const line = (name: string) => links.split("\n").find((l) => l.startsWith(`${name}: `))!.slice(name.length + 2);
    expect(line("decompiler_url").startsWith(`${DU}/#`)).toBe(true);
    const cq = await cquisitorShare(line("cquisitor_url"));
    expect(cq.annotations[0]).toMatchObject({ target: { kind: "redeemer", tag: "Spend", index: 2 }, label: "spend:2 failed", severity: "error" });
    expect(cq.annotations.some((a) => a.label === "MachineError" && a.target.kind === "diagnostic")).toBe(true);
    const plain = line("de_uplc_url");
    expect(plain.includes("#d=") ? deUplcPayload(plain).ann : undefined).toBeUndefined();

    const opened = (await client.callTool<Json>("debug_open", { tx_id: failingTx, redeemer: "spend:2" }, 120_000)).structuredContent!;
    const run = (await client.callTool<Json>("debug_run", { dbg_id: opened.dbg_id, until: "error" }, 120_000)).structuredContent!;
    expect(run.stopped.kind).toBe("error");
    const failingTerm = run.position.term_id ?? run.position.last_term_id;
    const after = (await client.callTool<Json>("tx_redeemer", { tx_id: failingTx, redeemer: "spend:2", part: "links" }, 120_000)).structuredContent!;
    expect(after.notes.join("\n")).not.toMatch(/no failing-term annotation/);
    const relinked = await client.readResourceText(`cardano-debug://tx/${failingTx}/redeemer/spend:2/links.txt`);
    const deUplc = relinked.split("\n").find((l) => l.startsWith("de_uplc_url: "))!.slice("de_uplc_url: ".length);
    const payload = deUplcPayload(deUplc);
    // "fails here" when the machine stood on a term, "last term before …" when a builtin failed between terms
    expect(payload.ann).toEqual([{ target: { kind: "term", term_id: failingTerm }, label: expect.stringMatching(/^(spend:2 fails here|last term before spend:2 fails)$/), severity: "error", hint: expect.any(String) }]);
    expect(payload.context).toBeTruthy();

    // ui_link: the same term from the tx (from=validation) and from the session (from=session), opened through the test hook
    const viaTx = await call({ app: "de_uplc", tx_id: failingTx, redeemer: "spend:2", from: ["validation"] });
    expect(deUplcPayload(await fullUrl(viaTx)).ann[0].target).toEqual({ kind: "term", term_id: failingTerm });
    const viaSession = await call({ app: "de_uplc", dbg_id: opened.dbg_id, from: ["session"], annotations: [{ target: { kind: "uplc_line", line: 1 }, label: "start" }], focus: 1, open: true });
    expect(viaSession).toMatchObject({ annotations_count: 2, focus: 1, dropped: [], opened: true });
    const sessionPayload = deUplcPayload(await fullUrl(viaSession));
    expect(sessionPayload.ann_focus).toBe(1);
    expect(sessionPayload.ann[1]).toMatchObject({ target: { kind: "term", term_id: failingTerm }, label: expect.stringMatching(/^(the script fails here|last term before the script fails)$/), severity: "error" });
    expect(sessionPayload.ann[1].hint).toBeTruthy();
    expect(sessionPayload.v).toBe("v2");
    expect(client.stderr.join("")).toMatch(/test-hook open: \d+ chars/);
  });

  it("de_uplc from='profile': the hottest terms of the session's debug_profile, by dbg_id and by tx_id + redeemer", async () => {
    const opened = (await client.callTool<Json>("debug_open", { tx_id: failingTx, redeemer: "spend:2" }, 120_000)).structuredContent!;
    const before = await call({ app: "de_uplc", dbg_id: opened.dbg_id, from: ["profile"] });
    expect(before.annotations_count).toBe(0);
    expect(before.notes.join("\n")).toMatch(/run debug_profile on this session first/);

    const profile = (await client.callTool<Json>("debug_profile", { dbg_id: opened.dbg_id, top: 3 }, 180_000)).structuredContent!;
    // every builtin that ran sits in one of the buckets
    expect(profile.builtin_groups.length).toBeGreaterThan(0);
    expect(profile.builtin_groups.reduce((sum: number, g: Json) => sum + g.cpu_pct, 0)).toBeCloseTo(100, 0);
    expect(profile.builtins_total.cpu_pct_of_spent).toBeGreaterThan(0);
    expect(profile.show_it).toContain(`dbg_id='${opened.dbg_id}', from=['profile']`);
    // the script fails: the validator drops the machine steps it had not charged yet, so the totals differ and the answer says why
    expect(profile).toMatchObject({ outcome: "error", parity: { match: false, note: expect.stringMatching(/failing run/) } });
    const hot = (profile.hot_terms as Json[]).map((t, i) => ({ rank: i + 1, term_id: t.term_id as number | null, pct: t.pct as number })).filter((t) => t.term_id !== null);
    expect(hot.length).toBeGreaterThan(0);

    const expected = hot.map((t) => ({ target: { kind: "term", term_id: t.term_id }, label: `hot #${t.rank}: ${t.pct}% of cpu` }));
    const bySession = deUplcPayload(await fullUrl(await call({ app: "de_uplc", dbg_id: opened.dbg_id, from: ["profile"] }))).ann as Json[];
    expect(bySession.map(({ target, label }) => ({ target, label }))).toEqual(expected);
    expect(bySession[0]!.hint).toMatch(/\w+: \d+ hits, self cpu \d+, with callees \d+/);
    // the same terms through the tx and redeemer the session was opened for
    const byTx = deUplcPayload(await fullUrl(await call({ app: "de_uplc", tx_id: failingTx, redeemer: "spend:2", from: ["profile"] }))).ann as Json[];
    expect(byTx.map(({ target, label }) => ({ target, label }))).toEqual(expected);
  });

  it("decompiler: tx_id + redeemer with pseudocode-line targets carries the decompile options script_decompile uses", async () => {
    const body = await call({
      app: "decompiler",
      tx_id: txId,
      redeemer: "spend:2",
      decompile_options: { strip_all_traces: true },
      annotations: [{ target: { kind: "pseudo_line", line: 3, end_line: 6 }, hint: "the datum check" }, { target: { kind: "term", term_id: 2 } }],
    });
    expect(body).toMatchObject({ app: "decompiler", annotations_count: 1, dropped: [{ index: 1, reason: expect.stringMatching(/decompiler view/) }] });
    const payload = deUplcPayload(await fullUrl(body));
    expect(payload).toMatchObject({ view: "decompiler", v: "v2", purpose: "spend", ann: [{ target: { kind: "pseudo_line", line: 3, end_line: 6 }, hint: "the datum check" }] });
    expect(payload.options).toMatchObject({ strip_all_traces: true, output_layer: "Decompiled" });
    const decompiled = (await client.callTool<Json>("script_decompile", { tx_id: txId, script_hash: SPEND_SCRIPT_HASH, options: { strip_all_traces: true }, lines: 1 }, 180_000)).structuredContent!;
    for (const [key, value] of Object.entries(decompiled.options_used as Json)) if (key !== "passes_overridden") expect(payload.options[key], key).toEqual(value);
    const bad = await client.callTool<Json>("ui_link", { app: "decompiler", tx_id: txId, redeemer: "spend:2", decompile_options: { strip_everything: true } });
    expect(bad.structuredContent).toMatchObject({ code: "invalid_argument", argument: "decompile_options" });
  });

  it("de_uplc from the S1 sample tx: the redeemer's launch fields; a successful redeemer has nothing to annotate", async () => {
    // the failing variant shares the transaction (and so the tx_id): load the sample again
    expect((await client.callTool<Json>("tx_load", { bundle: SAMPLE })).structuredContent!.tx_id).toBe(txId);
    const body = await call({ app: "de_uplc", tx_id: txId, redeemer: "spend:2", from: ["validation", "cbor_errors"] });
    expect(body.annotations_count).toBe(0);
    expect(body.notes.join("\n")).toMatch(/spend:2 succeeded: no failing term/);
    expect(body.notes.join("\n")).toMatch(/cbor_errors' applies to the cquisitor/);
    const url = await fullUrl(body);
    expect(url.startsWith(`${DU}/#`)).toBe(true);
    expect(url).toMatch(/context=|#d=/);
  });

  it("lists the link resource template and refuses an unknown link id", async () => {
    const { resourceTemplates } = await client.request<{ resourceTemplates: Array<{ uriTemplate: string }> }>("resources/templates/list");
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain("cardano-debug://link/{link_id}/url.txt");
    const missing = await client.request("resources/read", { uri: "cardano-debug://link/lnk_0000000000000000/url.txt" }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(Error);
  });
});
