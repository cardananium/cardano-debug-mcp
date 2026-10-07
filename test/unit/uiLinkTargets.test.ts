// ui_link target resolution without a transaction: byte spans and CBOR paths against the bytes, CDDL
// ranges and rules against the schema, term / line targets against a session; the failing-term
// annotations of a session (they survive a rewind); the preset / network / fallback behaviour of the
// CBOR tabs. The library runs in this thread (no worker, no dist).
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { configure } from "@cardananium/cquisitor-lib";
import { nodeBrotliCompressor } from "@cardananium/cquisitor-lib/node";
import { parseCardanoCborShare, parseCddlShare, parseGeneralCborShare, parseHash } from "@cardananium/cquisitor-lib/share";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createAppContext, type AppContext } from "../../src/context.js";
import type { PositionReport } from "../../src/engine/protocol.js";
import type { SessionClient } from "../../src/engine/service.js";
import type { LibClient } from "../../src/lib.js";
import { readResourceUri } from "../../src/resources.js";
import { SessionRegistry, type SessionRecord } from "../../src/store/sessionRegistry.js";
import { uiLink, uiLinkInputSchema } from "../../src/tools/ui_link.js";
import { cborErrorAnnotations, errorTermOfSession, failingTermAnnotation, failingTermOf, failureHint, noFailingTermNote } from "../../src/ui/autoAnnotations.js";
import { cborTargetResolver, programTargetResolver, pseudocodeTargetResolver } from "../../src/ui/targets.js";
import { fxInt, fxStr, readFixtureText, readTx } from "../helpers/fixtures.js";
import { inProcessLib } from "../helpers/inProcessLib.js";

type Json = Record<string, any>;

const TX = readTx("vote-tx.tx"); // array(4): the s12 transaction
const SIZE = fxInt("s12.size");
const REF_SCRIPT = readFixtureText(fxStr("s01.spendScriptFile")).trim(); // the S1 spend script (V2, single-CBOR-wrapped)

const deUplcPayload = (url: string): Json => JSON.parse(gunzipSync(Buffer.from(url.split("#d=")[1]!, "base64url")).toString("utf8"));
const shareParams = (url: string) => parseHash(url.split("#")[1]!).params;

describe("cborTargetResolver (pure)", () => {
  it("cbor_span: inside the input or dropped with what fits", () => {
    const notes: string[] = [];
    const check = cborTargetResolver({ hex: "00".repeat(SIZE) }, notes);
    expect(check({ kind: "cbor_span", offset: SIZE - 1, length: 1 }, 0)).toBeUndefined();
    expect(check({ kind: "cbor_span", offset: 5000, length: 1 }, 0)).toEqual({ drop: `cbor_span offset 5000 is past the end of the input (${SIZE} bytes)`, available: { input_bytes: SIZE, last_offset: SIZE - 1 } });
    expect(check({ kind: "cbor_span", offset: SIZE - 7, length: 20 }, 0)).toEqual({ drop: `cbor_span ${SIZE - 7}+20 runs past the end of the input (${SIZE} bytes)`, available: { input_bytes: SIZE, max_length_at_offset: 7 } });
    expect(notes).toEqual([]);
  });

  it("cbor_path without a tree stays and says so once; cddl_range / cddl_rule without a schema stay", () => {
    const notes: string[] = [];
    const check = cborTargetResolver({ hex: "00" }, notes);
    expect(check({ kind: "cbor_path", path: "$[9]" }, 0)).toBeUndefined();
    expect(check({ kind: "cbor_path", path: "$[8]" }, 1)).toBeUndefined();
    expect(notes).toEqual(["cbor_path targets are not checked: the bytes could not be decoded to a tree"]);
    expect(check({ kind: "cddl_range", start: 0, end: 1e9 }, 0)).toBeUndefined();
    expect(check({ kind: "cddl_rule", name: "nope" }, 0)).toBeUndefined();
  });

  it("term / uplc_line / pseudo_line: checked when the program's shape is known, kept with one note when not", () => {
    const notes: string[] = [];
    const known = programTargetResolver({ terms: 20, lines: 50 }, notes);
    expect(known({ kind: "term", term_id: 19 }, 0)).toBeUndefined();
    expect(known({ kind: "term", term_id: 999_999 }, 0)).toEqual({ drop: "term_id 999999 is not a node of this program (0..19)", available: { term_ids: "0..19" } });
    expect(known({ kind: "uplc_line", line: 50 }, 0)).toBeUndefined();
    expect(known({ kind: "uplc_line", line: 51 }, 0)).toEqual({ drop: "uplc_line 51 is outside the UPLC listing (1..50)", available: { lines: "1..50" } });
    const unknown = programTargetResolver({}, notes);
    expect(unknown({ kind: "term", term_id: 5 }, 0)).toBeUndefined();
    expect(unknown({ kind: "term", term_id: 6 }, 0)).toBeUndefined();
    expect(unknown({ kind: "uplc_line", line: 6 }, 0)).toBeUndefined();
    expect(notes).toEqual(["term targets are not checked: no debug session of this program is open (debug_open, then pass dbg_id)", "uplc_line targets are not checked: no debug session of this program is open (debug_open, then pass dbg_id)"]);

    const pseudo = pseudocodeTargetResolver(120, []);
    expect(pseudo({ kind: "pseudo_line", line: 1, end_line: 120 }, 0)).toBeUndefined();
    expect(pseudo({ kind: "pseudo_line", line: 100, end_line: 121 }, 0)).toEqual({ drop: "pseudo_line 100-121 is past the end of the pseudocode (120 lines)", available: { lines: "1..120" } });
    expect(pseudo({ kind: "pseudo_line", line: 500 }, 0)).toMatchObject({ drop: "pseudo_line 500 is past the end of the pseudocode (120 lines)" });
    const notDecompiled: string[] = [];
    expect(pseudocodeTargetResolver(undefined, notDecompiled)({ kind: "pseudo_line", line: 500 }, 0)).toBeUndefined();
    expect(notDecompiled[0]).toMatch(/pseudo_line targets are not checked: script_decompile has not produced/);
  });
});

describe("failing-term annotations (pure)", () => {
  const session = (fields: Partial<SessionRecord>): SessionRecord => ({ dbgId: "dbg_x", txId: "tx_mainnet_000000000000", redeemer: "spend:2", ...fields }) as SessionRecord;
  const registry = (...sessions: SessionRecord[]) => ({ list: () => sessions }) as unknown as SessionRegistry;
  const position = (term_id: number | null, last_term_id: number | null) => ({ term_id, last_term_id, raw_term_id: -1, kind: null, uplc_line: null, machine_state: "Return" }) as never;

  it("errorTermId survives the rewind that sets the status back to ready", () => {
    expect(errorTermOfSession(session({ lastStatus: "ready", lastPosition: position(0, null), errorTermId: 12 }))).toEqual({ termId: 12, exact: true });
    expect(failingTermOf(registry(session({ lastStatus: "ready", errorTermId: 12 })), "tx_mainnet_000000000000", "spend:2")).toMatchObject({ termId: 12, exact: true });
    expect(failingTermOf(registry(session({ lastStatus: "ready", errorTermId: 12 })), "tx_mainnet_000000000000", "spend:3")).toBeUndefined();
    expect(failingTermOf(registry(session({ lastStatus: "ready", errorTermId: 12 })), "tx_mainnet_ffffffffffff", "spend:2")).toBeUndefined();
  });

  it("a failure without a term of its own is known only while the session stands on it, as the last term before it", () => {
    expect(errorTermOfSession(session({ lastStatus: "error", lastPosition: position(null, 7), errorTermId: null }))).toEqual({ termId: 7, exact: false });
    expect(errorTermOfSession(session({ lastStatus: "error", lastPosition: position(9, 7) }))).toEqual({ termId: 9, exact: true });
    expect(errorTermOfSession(session({ lastStatus: "ready", lastPosition: position(null, 7), errorTermId: null }))).toBeUndefined();
    expect(errorTermOfSession(session({ lastStatus: "error", lastPosition: position(null, null) }))).toBeUndefined();
    expect(noFailingTermNote(true)).toMatch(/failed without a term of its own.*no term to mark/);
    expect(noFailingTermNote(false)).toMatch(/does not report the failing term/);
  });

  it("the hint is the error's first line plus the last trace, never the engine's state dump; the label says what the term is", () => {
    const dump = "Plutus machine error: failed to deserialise PlutusData using UnConstrData\nValue B #00\nEnvironment: [".padEnd(900, "x");
    expect(failureHint(dump, "datum checked")).toBe("Plutus machine error: failed to deserialise PlutusData using UnConstrData\nlast trace: datum checked");
    expect(failureHint(undefined, undefined)).toBeUndefined();
    expect(failureHint("boom")).toBe("boom");
    expect(failingTermAnnotation({ termId: 4, exact: true }, "spend:2", "boom\nmore", "t1")).toEqual({ target: { kind: "term", term_id: 4 }, label: "spend:2 fails here", severity: "error", hint: "boom\nlast trace: t1" });
    expect(failingTermAnnotation({ termId: 4, exact: false }, "the script", "boom")).toMatchObject({ label: "last term before the script fails", severity: "error", hint: "boom" });
  });

  it("a truncated input reports its error AT the input length: the span is clamped to the last byte and labelled", () => {
    const eof = { kind: "unexpected_eof", message: "unexpected end of input", offset: 1, byte_length: 1 } as never;
    expect(cborErrorAnnotations({ structural: eof, rows: [], withCddlRange: false, inputBytes: 1 })).toEqual([
      { target: { kind: "cbor_span", offset: 0, length: 1 }, label: "input ends here", hint: "unexpected_eof: unexpected end of input", severity: "error" },
    ]);
    expect(cborErrorAnnotations({ structural: { ...(eof as object), offset: 2 } as never, rows: [], withCddlRange: false, inputBytes: 2 })[0]!.target).toEqual({ kind: "cbor_span", offset: 1, length: 1 });
    // an error inside the input keeps its own span (clamped to the input) and its kind as the label
    expect(cborErrorAnnotations({ structural: { kind: "invalid_syntax", message: "bad", offset: 3, byte_length: 9 } as never, rows: [], withCddlRange: false, inputBytes: 6 })).toEqual([
      { target: { kind: "cbor_span", offset: 3, length: 3 }, label: "invalid_syntax", hint: "bad", severity: "error" },
    ]);
  });
});

describe("ui_link CBOR / CDDL tabs and sessions", () => {
  let ctx: AppContext;

  beforeAll(() => {
    configure({ compressor: nodeBrotliCompressor });
    const config = { ...loadConfig({ CARDANO_DEBUG_OFFLINE: "1", CARDANO_DEBUG_NO_OPEN: "1" }), cacheDir: mkdtempSync(path.join(os.tmpdir(), "cdm-uitargets-")), cquisitorBase: { origin: "http://localhost:3011", basePath: "" }, deUplcBase: "http://localhost:5173" };
    ctx = createAppContext({ config, lib: Object.assign(inProcessLib(), { dispose: async () => undefined }) as unknown as LibClient });
  });

  afterAll(async () => {
    await ctx.shutdown();
  });

  const call = async (args: Json) => (await uiLink(ctx, uiLinkInputSchema.parse(args))).structuredContent as Json;
  const fullUrl = async (body: Json): Promise<string> => (typeof body.url === "string" ? body.url : (await readResourceUri(ctx, new URL(body.link_resource))).contents[0]!.text!);

  it("general-cbor: spans against the byte length, paths against the decoded tree, with what exists as the hint", async () => {
    const body = await call({
      app: "cquisitor",
      cbor: TX,
      annotations: [
        { target: { kind: "cbor_span", offset: 0, length: 1 }, label: "array header" },
        { target: { kind: "cbor_span", offset: 5000, length: 1 } },
        { target: { kind: "cbor_span", offset: SIZE - 7, length: 20 } },
        { target: { kind: "cbor_span", offset: SIZE - 1, length: 1 } },
        { target: { kind: "cbor_path", path: "$[0]" } },
        { target: { kind: "cbor_path", path: "$[9][9][9]" } },
        { target: { kind: "cbor_path", path: "$[0].nope" } },
        { target: { kind: "cbor_path", path: "transaction.body" } },
      ],
    });
    expect(body).toMatchObject({ tab: "general-cbor", annotations_count: 3 });
    const dropped = body.dropped as Array<{ index: number; reason: string; available?: Json }>;
    expect(dropped.map((d) => d.index)).toEqual([1, 2, 5, 6, 7]);
    expect(dropped[0]).toMatchObject({ reason: `cbor_span offset 5000 is past the end of the input (${SIZE} bytes)`, available: { input_bytes: SIZE, last_offset: SIZE - 1 } });
    expect(dropped[1]!.available).toEqual({ input_bytes: SIZE, max_length_at_offset: 7 });
    expect(dropped[2]!.reason).toMatch(/cbor_path \$\[9\]\[9\]\[9\] does not resolve: nothing at the next segment after \$ \(array\(4 items\)\)/);
    expect(dropped[2]!.available).toEqual({ resolved_to: "$", node: "array(4 items)", children: ["$[0]..$[3]"] });
    expect(dropped[3]!.reason).toMatch(/after \$\[0\] \(map\(4 entries\)\)/);
    expect(dropped[3]!.available!.children.length).toBe(4);
    expect(dropped[4]!.reason).toMatch(/cbor_path starts at the root/);
    const share = await parseGeneralCborShare(shareParams(await fullUrl(body)));
    expect(share.annotations.map((a) => a.target)).toEqual([{ kind: "cbor_span", offset: 0, length: 1 }, { kind: "cbor_span", offset: SIZE - 1, length: 1 }, { kind: "cbor_path", path: "$[0]" }]);
  });

  it("a path into malformed bytes is checked against the part that decoded", async () => {
    const body = await call({ app: "cquisitor", cbor: "8401", annotations: [{ target: { kind: "cbor_path", path: "$[0]" } }, { target: { kind: "cbor_path", path: "$[2]" } }] });
    expect(body.annotations_count).toBe(1);
    expect(body.dropped).toEqual([expect.objectContaining({ index: 1, reason: expect.stringContaining("in the decoded part of the malformed bytes") })]);
  });

  it("cddl-validator with an embedded schema: ranges against its length, rules against its declarations (case folded to the declared name)", async () => {
    const schema = "user = { 1: uint }\nother = uint";
    const body = await call({
      app: "cquisitor",
      cbor: "a201010202",
      cddl: schema,
      rule: "user",
      annotations: [
        { target: { kind: "cddl_range", start: 0, end: schema.length } },
        { target: { kind: "cddl_range", start: 5, end: schema.length + 1 } },
        { target: { kind: "cddl_rule", name: "OTHER" } },
        { target: { kind: "cddl_rule", name: "usr" } },
        { target: { kind: "cbor_span", offset: 99, length: 1 } },
      ],
    });
    expect(body).toMatchObject({ tab: "cddl-validator", annotations_count: 2 });
    const dropped = body.dropped as Array<{ index: number; reason: string; available?: unknown }>;
    expect(dropped.map((d) => d.index)).toEqual([1, 3, 4]);
    expect(dropped[0]).toEqual({ index: 1, reason: `cddl_range 5..${schema.length + 1} is past the end of the schema (${schema.length} characters)`, available: { schema_chars: schema.length } });
    expect(dropped[1]).toEqual({ index: 3, reason: 'cddl_rule "usr" is not declared in the schema', available: ["user", "other"] });
    const share = await parseCddlShare(shareParams(await fullUrl(body)));
    expect(share.cddl).toBe(schema);
    expect(share.annotations.map((a) => a.target)).toEqual([{ kind: "cddl_range", start: 0, end: schema.length }, { kind: "cddl_rule", name: "other" }]);
  });

  it("an era schema travels as the app's preset (a short link) unless a cddl_range / cddl_rule annotation needs the text", async () => {
    const lengthOf = async (args: Json) => {
      const body = await call({ app: "cquisitor", cbor: TX, rule: "transaction", ...args });
      const url = await fullUrl(body);
      return { body, url, share: await parseCddlShare(shareParams(url)) };
    };
    const byDefault = await lengthOf({});
    expect(byDefault.share.preset).toBe("conway");
    expect(byDefault.share.cddl ?? "").toBe("");
    expect(byDefault.url.length).toBeLessThan(2_000);
    expect((await lengthOf({ cddl: "babbage" })).share.preset).toBe("babbage");
    expect((await lengthOf({ preset: "conway" })).share.preset).toBe("conway");
    // the era the app does not ship, and any custom schema, are embedded
    const dijkstra = await lengthOf({ cddl: "dijkstra" });
    expect(dijkstra.share.preset).toBeUndefined();
    expect(dijkstra.share.cddl!.length).toBeGreaterThan(10_000);
    // a schema target needs the text the server's ranges refer to
    const withRange = await lengthOf({ annotations: [{ target: { kind: "cddl_range", start: 0, end: 10 }, label: "start of the schema" }] });
    expect(withRange.share.preset).toBeUndefined();
    expect(withRange.share.cddl!.length).toBeGreaterThan(10_000);
    expect(withRange.body.annotations_count).toBe(1);
    const withRule = await lengthOf({ annotations: [{ target: { kind: "cddl_rule", name: "transaction" } }] });
    expect(withRule.share.cddl!.length).toBeGreaterThan(10_000);
    expect(withRule.body.dropped).toEqual([]);
    // an undeclared rule of the era schema is dropped, with the closest declared names
    const bad = await lengthOf({ annotations: [{ target: { kind: "cddl_rule", name: "transaction_bodyy" } }] });
    expect(bad.body.dropped[0].reason).toMatch(/cddl_rule "transaction_bodyy" is not declared/);
    expect(bad.body.dropped[0].available).toContain("transaction_body");
  });

  it("the CDDL tab with malformed bytes and no rule falls back to the general-cbor tab (the error is what to show)", async () => {
    const body = await call({ app: "cquisitor", cbor: "8401", cddl: "conway", from: ["cbor_errors"] });
    expect(body).toMatchObject({ tab: "general-cbor", annotations_count: 1, dropped: [] });
    expect(body.notes.join("\n")).toMatch(/not well-formed CBOR, so no schema rule applies: this link opens the general-cbor tab/);
    const share = await parseGeneralCborShare(shareParams(await fullUrl(body)));
    expect(share.annotations).toEqual([{ target: { kind: "cbor_span", offset: 1, length: 1 }, label: "input ends here", hint: expect.stringContaining("unexpected_eof"), severity: "error" }]);
    // without from= the tab still falls back, with nothing generated; caller targets of the schema tab are dropped by the kind check
    const plain = await call({ app: "cquisitor", cbor: "8401", preset: "conway", annotations: [{ target: { kind: "cddl_rule", name: "transaction" } }] });
    expect(plain).toMatchObject({ tab: "general-cbor", annotations_count: 0 });
    expect(plain.dropped[0].reason).toMatch(/cddl_rule does not apply to the general-cbor tab/);
    // with a rule the CDDL tab stays: it can show the span as well
    const ruled = await call({ app: "cquisitor", cbor: "8201", cddl: "conway", rule: "transaction", from: ["cbor_errors"] });
    expect(ruled.tab).toBe("cddl-validator");
    expect(ruled.annotations_count).toBeGreaterThan(0);
    // the same clamp on the general tab: `84` (error at byte 1 of a 1-byte input)
    const one = await call({ app: "cquisitor", cbor: "84", from: ["cbor_errors"] });
    expect((await parseGeneralCborShare(shareParams(await fullUrl(one)))).annotations[0]).toMatchObject({ target: { kind: "cbor_span", offset: 0, length: 1 }, label: "input ends here" });
    // well-formed bytes with no admissible root: the rule is the missing piece
    const refused = await uiLink(ctx, uiLinkInputSchema.parse({ app: "cquisitor", cbor: "f4", cddl: "user = { 1: uint }" }));
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ code: "invalid_argument", argument: "rule" });
  });

  it("cbor_errors on the CDDL tab: errors past the rows read are counted in a note", async () => {
    // 30 distinct map entries, every value a text where the schema wants a uint
    const keys = Array.from({ length: 30 }, (_, i) => i + 1);
    const schema = `r = { ${keys.map((k) => `${k}: uint`).join(", ")} }`;
    const map = `b8${keys.length.toString(16).padStart(2, "0")}${keys.map((k) => `18${k.toString(16).padStart(2, "0")}6161`).join("")}`;
    const body = await call({ app: "cquisitor", cbor: map, cddl: schema, rule: "r", from: ["cbor_errors"] });
    // 20 rows are read (a byte span and a schema range each); the other 10 mismatches are only counted
    expect(body.annotations_count).toBe(40);
    expect(body.notes).toEqual(["from='cbor_errors': 10 more error(s) not shown (the first 20 rows were read); fix these, or read cbor_validate for the rest"]);
  });

  it("cardano-cbor: takes no annotations; tagged with the network asked for (mainnet by default, with a note)", async () => {
    const plain = await call({ app: "cquisitor", tab: "cardano-cbor", cbor: TX });
    expect(plain).toMatchObject({ tab: "cardano-cbor", annotations_count: 0 });
    expect(plain.notes.join("\n")).toMatch(/network not given: the bytes are tagged mainnet/);
    expect(await parseCardanoCborShare(shareParams(await fullUrl(plain)))).toMatchObject({ net: "mainnet" });
    const preprod = await call({ app: "cquisitor", tab: "cardano-cbor", cbor: TX, network: "preprod" });
    expect(preprod.notes.join("\n")).not.toMatch(/network not given/);
    expect(await parseCardanoCborShare(shareParams(await fullUrl(preprod)))).toMatchObject({ net: "preprod" });
    const elsewhere = await call({ app: "cquisitor", cbor: TX, network: "preview" });
    expect(elsewhere.notes.join("\n")).toMatch(/network applies to the cardano-cbor tab only/);
    const wrongApp = await uiLink(ctx, uiLinkInputSchema.parse({ app: "de_uplc", script: REF_SCRIPT, network: "preview" }));
    expect(wrongApp.structuredContent).toMatchObject({ code: "invalid_argument", argument: "network" });
  });

  describe("a debug session", () => {
    const sessions: SessionRecord[] = [];
    const report = (status: PositionReport["status"], term_id: number | null, last_term_id: number | null, error_message?: string): PositionReport =>
      ({ status, error_message, steps_total: 10, position: { term_id, last_term_id, raw_term_id: 3, kind: "Apply", uplc_line: 4, machine_state: "Return" } }) as unknown as PositionReport;

    /** A session record with a stand-in worker client: position and traces as given. */
    const open = (fields: Partial<SessionRecord>, now: PositionReport, traces: string[] = []): string => {
      const client = { lost: false, position: async () => now, tracesAll: async () => traces, close: async () => undefined } as unknown as SessionClient;
      const { record } = ctx.sessions.create({ mode: "program", language: "V2", partsConfig: { script: REF_SCRIPT }, termCount: 20, uplcLines: 50, client, ...fields });
      sessions.push(record);
      return record.dbgId;
    };

    afterAll(() => {
      for (const s of sessions) ctx.sessions.close(s.dbgId);
    });

    it("after the report's rewind the failing term is still marked (error), the current position beside it (info)", async () => {
      const dbg = open({ errorTermId: 12, lastStatus: "ready" }, report("ready", 3, null), ["a trace", "datum checked"]);
      const body = await call({ app: "de_uplc", dbg_id: dbg, from: ["session"] });
      expect(body).toMatchObject({ annotations_count: 2, dropped: [] });
      const ann = deUplcPayload(await fullUrl(body)).ann as Json[];
      expect(ann[0]).toEqual({ target: { kind: "term", term_id: 12 }, label: "the script fails here", severity: "error", hint: "last trace: datum checked" });
      expect(ann[1]).toEqual({ target: { kind: "term", term_id: 3 }, label: "current position (ready)", severity: "info", hint: "last trace: datum checked" });
    });

    it("standing on a builtin failure (no term of its own): the last term before it, never 'fails here'; the error's first line is the hint", async () => {
      const dump = `Plutus machine error: UnIData failed\n${"Environment: ".padEnd(900, "x")}`;
      const dbg = open({ errorTermId: null, lastStatus: "error" }, report("error", null, 7, dump), ["checking"]);
      const body = await call({ app: "de_uplc", dbg_id: dbg, from: ["session"] });
      expect(body.annotations_count).toBe(1);
      const [only] = deUplcPayload(await fullUrl(body)).ann as Json[];
      expect(only).toEqual({ target: { kind: "term", term_id: 7 }, label: "last term before the script fails", severity: "error", hint: "Plutus machine error: UnIData failed\nlast trace: checking" });
    });

    it("rewound after a builtin failure: only the position, and a note says why there is no failing term", async () => {
      const dbg = open({ errorTermId: null, lastStatus: "ready" }, report("ready", 2, null));
      const body = await call({ app: "de_uplc", dbg_id: dbg, from: ["session"] });
      expect(body.annotations_count).toBe(1);
      expect(body.notes.join("\n")).toMatch(/failed without a term of its own/);
      const never = open({ lastStatus: "ready" }, report("ready", 2, null));
      expect((await call({ app: "de_uplc", dbg_id: never, from: ["session"] })).notes.join("\n")).toMatch(/has not stopped on an error/);
    });

    it("from='profile': the hottest terms of the session's last debug_profile, ranked, the first a warning when over budget", async () => {
      const dbg = open({}, report("ready", 1, null));
      const hot = (id: number | null, line: number | null, pct: number) => ({ term_id: id, kind: "Apply", uplc_line: line, hits: "6", self_cpu: "2974014", total_cpu: "3627174", pct });
      ctx.sessions.get(dbg)!.extra.profileHot = {
        outcome: "done",
        over_budget: true,
        terms: [hot(2, 4, 9.11), hot(null, null, 8), hot(3, null, 7), hot(4, 5, 6), hot(5, 6, 5), hot(6, 7, 4), hot(7, 8, 3)],
      };
      const body = await call({ app: "de_uplc", dbg_id: dbg, from: ["profile"] });
      expect(body).toMatchObject({ annotations_count: 5, dropped: [] });
      const ann = deUplcPayload(await fullUrl(body)).ann as Json[];
      expect(ann[0]).toEqual({ target: { kind: "term", term_id: 2 }, label: "hot #1: 9.11% of cpu", severity: "warning", hint: "Apply: 6 hits, self cpu 2974014, with callees 3627174" });
      // a term the report could not place is skipped, the ranks keep their places
      expect(ann.map((a) => a.label)).toEqual(["hot #1: 9.11% of cpu", "hot #3: 7% of cpu", "hot #4: 6% of cpu", "hot #5: 5% of cpu", "hot #6: 4% of cpu"]);
      expect(ann[1]!.severity).toBe("info");
    });

    it("a card the caller wrote replaces the generated pointer at the same place, and says so", async () => {
      const dbg = open({}, report("ready", 1, null));
      ctx.sessions.get(dbg)!.extra.profileHot = {
        outcome: "done",
        over_budget: false,
        terms: [{ term_id: 2, kind: "Apply", uplc_line: 4, hits: "6", self_cpu: "9", total_cpu: "10", pct: 5 }, { term_id: 3, kind: "Apply", uplc_line: 5, hits: "1", self_cpu: "1", total_cpu: "2", pct: 1 }],
      };
      const body = await call({ app: "de_uplc", dbg_id: dbg, from: ["profile"], annotations: [{ target: { kind: "term", term_id: 2 }, label: "the comparison", hint: "why it costs" }] });
      expect(body).toMatchObject({ annotations_count: 2, dropped: [] });
      expect(body.notes.join("\n")).toMatch(/1 generated annotation\(s\) at the same place as yours left out/);
      const ann = deUplcPayload(await fullUrl(body)).ann as Json[];
      expect(ann.map((a) => [a.target.term_id, a.label])).toEqual([[2, "the comparison"], [3, "hot #2: 1% of cpu"]]);
    });

    it("from='profile' before any profile says what to run; a partial run says so; a bare script explains", async () => {
      const dbg = open({}, report("ready", 1, null));
      const none = await call({ app: "de_uplc", dbg_id: dbg, from: ["profile"] });
      expect(none.annotations_count).toBe(0);
      expect(none.notes.join("\n")).toMatch(/run debug_profile on this session first/);
      ctx.sessions.get(dbg)!.extra.profileHot = { outcome: "limit", over_budget: false, terms: [{ term_id: 2, kind: "Apply", uplc_line: 4, hits: "1", self_cpu: "5", total_cpu: "9", pct: 1 }] };
      const partial = await call({ app: "de_uplc", dbg_id: dbg, from: ["profile"] });
      expect(partial.annotations_count).toBe(1);
      expect(partial.notes.join("\n")).toMatch(/ended 'limit': the shares are partial/);
      expect((await call({ app: "de_uplc", script: REF_SCRIPT, from: ["profile"] })).notes.join("\n")).toMatch(/from='profile' needs dbg_id/);
    });

    it("term and uplc_line targets are checked against the session's program", async () => {
      const dbg = open({}, report("ready", 1, null));
      const body = await call({
        app: "de_uplc",
        dbg_id: dbg,
        annotations: [{ target: { kind: "term", term_id: 5 } }, { target: { kind: "term", term_id: 999_999 } }, { target: { kind: "uplc_line", line: 99 } }, { target: { kind: "uplc_line", line: 50 } }],
        focus: 1,
      });
      expect(body.annotations_count).toBe(2);
      expect(body.dropped).toEqual([
        { index: 1, reason: "term_id 999999 is not a node of this program (0..19)", available: { term_ids: "0..19" } },
        { index: 2, reason: "uplc_line 99 is outside the UPLC listing (1..50)", available: { lines: "1..50" } },
      ]);
      expect(body.notes.join("\n")).toMatch(/focus 1 pointed at a dropped annotation \(term_id 999999/);
      expect(body.focus).toBe(1);
      // the same program from a script source finds the open session by its bytes
      const bySource = await call({ app: "de_uplc", script: REF_SCRIPT, plutus_version: "V2", annotations: [{ target: { kind: "term", term_id: 999_999 } }] });
      expect(bySource.dropped).toHaveLength(1);
      // a program nobody opened cannot be checked: the target stays, with a note
      for (const s of sessions) ctx.sessions.close(s.dbgId);
      const other = await call({ app: "de_uplc", script: REF_SCRIPT, plutus_version: "V2", annotations: [{ target: { kind: "term", term_id: 999_999 } }, { target: { kind: "uplc_line", line: 7 } }] });
      expect(other.annotations_count).toBe(2);
      expect(other.notes.join("\n")).toMatch(/term targets are not checked: no debug session of this program is open/);
      expect(other.notes.join("\n")).toMatch(/uplc_line targets are not checked/);
    });

    it("a script without a stated version: the de-uplc link says v2 and the note says it is an assumption", async () => {
      const body = await call({ app: "de_uplc", script: REF_SCRIPT });
      const url = await fullUrl(body);
      expect(url.includes("#d=") ? deUplcPayload(url).v : /[#&]v=(v\d)/.exec(url)?.[1]).toBe("v2");
      expect((body.notes as string[]).some((n) => /Plutus version is not stated.*the link says v2; pass plutus_version/.test(n))).toBe(true);
      const pinned = await call({ app: "de_uplc", script: REF_SCRIPT, plutus_version: "V2" });
      expect(pinned.notes.join("\n")).not.toMatch(/not stated/);
    });
  });
});
