// ui_link building blocks: UI base URLs from the environment, the OS opener (injected spawn, no real
// browser), annotation validation with drop reasons and focus mapping, generated annotations,
// the link store, and the tool itself for the sources that need no loaded transaction (CBOR / CDDL
// tabs, a bare script), decoded back with the library's parsers.
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { configure } from "@cardananium/cquisitor-lib";
import { nodeBrotliCompressor } from "@cardananium/cquisitor-lib/node";
import { parseCardanoCborShare, parseCddlShare, parseGeneralCborShare, parseHash } from "@cardananium/cquisitor-lib/share";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CQUISITOR_BASE, DEFAULT_DE_UPLC_BASE, loadConfig, parseUiBase } from "../../src/config.js";
import { inlineUrl, INLINE_URL_CHARS, UI_LINK_INLINE_CHARS } from "../../src/chain/links.js";
import type { AppContext } from "../../src/context.js";
import { createLibClient, type LibClient } from "../../src/lib.js";
import { readResourceUri } from "../../src/resources.js";
import { SessionRegistry } from "../../src/store/sessionRegistry.js";
import { TxStore, type TxRecord } from "../../src/store/txStore.js";
import { uiLink, uiLinkInputSchema } from "../../src/tools/ui_link.js";
import { checkAnnotations, rejectReason } from "../../src/ui/annotations.js";
import { cborErrorAnnotations, indexedDiagnostics, redeemerAnnotations, validationAnnotations } from "../../src/ui/autoAnnotations.js";
import { UiLinkStore, writeLinkFile } from "../../src/ui/linkStore.js";
import { isOpenableUrl, openerCommand, openUrl, systemOpener, type SpawnFn } from "../../src/ui/opener.js";
import { fxStr, readFixtureText, readTx } from "../helpers/fixtures.js";
import { PROJECT_ROOT } from "../mcpClient.js";

type Json = Record<string, any>;

const LIB_WORKER = path.join(PROJECT_ROOT, "dist", "workers", "lib.worker.js");
const REF_SCRIPT = readFixtureText(fxStr("s01.spendScriptFile")).trim(); // the S1 spend script (V2, single-CBOR-wrapped)
const LINK = "https://example.org/app/#d=abc&x=1";

describe("UI base URLs from the environment", () => {
  it("defaults to the deployed apps; overrides split into origin + base path", () => {
    const defaults = loadConfig({});
    expect(defaults.cquisitorBase).toEqual(DEFAULT_CQUISITOR_BASE);
    expect(defaults.deUplcBase).toBe(DEFAULT_DE_UPLC_BASE);
    expect(defaults.noOpen).toBe(false);
    const local = loadConfig({ CARDANO_DEBUG_CQUISITOR_URL: "http://localhost:3011", CARDANO_DEBUG_DE_UPLC_URL: "http://localhost:5173/", CARDANO_DEBUG_NO_OPEN: "1" });
    expect(local.cquisitorBase).toEqual({ origin: "http://localhost:3011", basePath: "" });
    expect(local.deUplcBase).toBe("http://localhost:5173");
    expect(local.noOpen).toBe(true);
    expect(parseUiBase("https://host.example/sub/app/")).toEqual({ origin: "https://host.example", basePath: "/sub/app" });
    for (const bad of ["ftp://x.org", "not a url", "https://x.org/#frag", "https://x.org/?q=1", "javascript:alert(1)"]) expect(parseUiBase(bad), bad).toBeUndefined();
    expect(loadConfig({ CARDANO_DEBUG_CQUISITOR_URL: "ftp://x.org" }).cquisitorBase).toEqual(DEFAULT_CQUISITOR_BASE);
  });
});

/** A fake child process: emits `spawn` or `error` on the next tick, records unref(). */
function fakeSpawn(outcome: "spawn" | "error"): { spawn: SpawnFn; calls: Array<{ command: string; args: readonly string[]; options: Json }>; unrefs: number } {
  const record = { calls: [] as Array<{ command: string; args: readonly string[]; options: Json }>, unrefs: 0 };
  const spawn = ((command: string, args: readonly string[], options: Json) => {
    record.calls.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {
      record.unrefs++;
    };
    setImmediate(() => (outcome === "spawn" ? child.emit("spawn") : child.emit("error", new Error("spawn xdg-open ENOENT"))));
    return child;
  }) as unknown as SpawnFn;
  return { spawn, ...record, get calls() { return record.calls; }, get unrefs() { return record.unrefs; } };
}

describe("the OS opener", () => {
  it("one command per platform, an argument array, detached, no shell; Windows quotes the URL verbatim", () => {
    expect(openerCommand(LINK, "darwin")).toMatchObject({ command: "open", args: [LINK], options: { detached: true, stdio: "ignore", shell: false } });
    expect(openerCommand(LINK, "linux")).toMatchObject({ command: "xdg-open", args: [LINK] });
    expect(openerCommand(LINK, "win32")).toMatchObject({ command: "cmd", args: ["/c", "start", '""', `"${LINK}"`], options: { windowsVerbatimArguments: true, detached: true, shell: false } });
    expect(openerCommand("https://x.org/a%20b", "win32")).toHaveProperty("error");
    expect(openerCommand(`https://x.org/${"a".repeat(9000)}`, "win32")).toHaveProperty("error");
    expect(isOpenableUrl("http://localhost:3011/#x")).toBe(true);
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "cardano-debug://link/x/url.txt", "nope"]) expect(isOpenableUrl(bad), bad).toBe(false);
  });

  it("systemOpener waits for the opener process to start (never for the browser) and reports a failed start", async () => {
    const started = fakeSpawn("spawn");
    expect(await systemOpener("darwin", started.spawn)(LINK)).toEqual({ ok: true });
    expect(started.calls).toEqual([{ command: "open", args: [LINK], options: expect.objectContaining({ detached: true, stdio: "ignore" }) }]);
    expect(started.unrefs).toBe(1);
    const missing = fakeSpawn("error");
    expect(await systemOpener("linux", missing.spawn)(LINK)).toEqual({ ok: false, error: "xdg-open: spawn xdg-open ENOENT" });
    const refused = fakeSpawn("spawn");
    expect(await systemOpener("linux", refused.spawn)("file:///etc/passwd")).toEqual({ ok: false, error: "only http(s) URLs are opened" });
    expect(refused.calls).toEqual([]);
  });

  it("openUrl: CARDANO_DEBUG_NO_OPEN wins, the injected opener is used, failures come back as open_error", async () => {
    const seen: string[] = [];
    const ctx = { config: { noOpen: false }, services: { urlOpener: async (url: string) => (seen.push(url), { ok: true as const }) } } as unknown as AppContext;
    expect(await openUrl(ctx, LINK)).toEqual({ opened: true });
    expect(seen).toEqual([LINK]);
    expect(await openUrl(ctx, "file:///x")).toEqual({ opened: false, open_error: "only http(s) URLs are opened" });
    expect(seen).toHaveLength(1);
    const disabled = { config: { noOpen: true }, services: ctx.services } as unknown as AppContext;
    const off = await openUrl(disabled, LINK);
    expect(off.opened).toBe(false);
    expect(off.note).toMatch(/CARDANO_DEBUG_NO_OPEN=1/);
    expect(seen).toHaveLength(1);
    const failing = { config: { noOpen: false }, services: { urlOpener: async () => ({ ok: false as const, error: "boom" }) } } as unknown as AppContext;
    expect(await openUrl(failing, LINK)).toEqual({ opened: false, open_error: "boom" });
  });
});

describe("annotation checks", () => {
  it("every rejected entry has a reason: shape, target (lib guards), app, tab, label / hint / severity, the 64 cap", () => {
    expect(rejectReason("x", "cquisitor", "transaction-validator")).toBe("not an object");
    expect(rejectReason({ target: "tx_path" }, "cquisitor", undefined)).toMatch(/string kind/);
    expect(rejectReason({ target: { kind: "nope" } }, "cquisitor", undefined)).toBe("unknown target kind 'nope'; the transaction-validator tab accepts: tx_path, diagnostic, redeemer");
    expect(rejectReason({ target: { kind: "nope" } }, "cquisitor", "cardano-cbor")).toBe("unknown target kind 'nope'; the cardano-cbor tab takes no annotations");
    expect(rejectReason({ target: { kind: "nope" } }, "cquisitor", "cddl-validator")).toMatch(/the cddl-validator tab accepts: cbor_span, cbor_path, cddl_range, cddl_rule/);
    expect(rejectReason({ target: { kind: "nope" } }, "de_uplc", undefined)).toMatch(/the debugger view accepts: term, uplc_line/);
    expect(rejectReason({ target: { kind: "nope" } }, "decompiler", undefined)).toMatch(/the decompiler view accepts: pseudo_line/);
    // a malformed target of the other app's kind is reported as that, not as a malformed target of this app
    expect(rejectReason({ target: { kind: "term" } }, "cquisitor", "transaction-validator")).toBe("term is a de-uplc-web target, not one of cquisitor");
    expect(rejectReason({ target: { kind: "cbor_span", offset: -1, length: 2 } }, "cquisitor", "general-cbor")).toMatch(/non-negative/);
    expect(rejectReason({ target: { kind: "uplc_line", line: 0 } }, "de_uplc", undefined)).toMatch(/>= 1/);
    expect(rejectReason({ target: { kind: "term", term_id: 3 } }, "cquisitor", "transaction-validator")).toMatch(/de-uplc-web target/);
    expect(rejectReason({ target: { kind: "tx_path", path: "transaction.body.fee" } }, "de_uplc", undefined)).toMatch(/cquisitor target/);
    expect(rejectReason({ target: { kind: "cbor_span", offset: 0, length: 1 } }, "cquisitor", "transaction-validator")).toMatch(/does not apply to the transaction-validator tab/);
    expect(rejectReason({ target: { kind: "pseudo_line", line: 2 } }, "de_uplc", undefined)).toMatch(/debugger view/);
    expect(rejectReason({ target: { kind: "term", term_id: 1 } }, "decompiler", undefined)).toMatch(/decompiler view/);
    expect(rejectReason({ target: { kind: "cddl_rule", name: "x" } }, "cquisitor", "general-cbor")).toMatch(/accepted: cbor_span, cbor_path/);
    expect(rejectReason({ target: { kind: "term", term_id: 1 }, label: 5 }, "de_uplc", undefined)).toBe("label must be a string");
    expect(rejectReason({ target: { kind: "term", term_id: 1 }, severity: "fatal" }, "de_uplc", undefined)).toMatch(/severity/);
    expect(rejectReason({ target: { kind: "diagnostic", name: "FeeTooSmallUTxO", occurrence: 1 } }, "cquisitor", "transaction-validator")).toBeUndefined();

    const many = Array.from({ length: 66 }, (_, i) => ({ target: { kind: "term", term_id: i } }));
    const capped = checkAnnotations(many, "de_uplc", undefined);
    expect(capped.annotations).toHaveLength(64);
    expect(capped.dropped).toEqual([
      { index: 64, reason: "past the 64-annotation limit of a link" },
      { index: 65, reason: "past the 64-annotation limit of a link" },
    ]);
  });

  it("focus indexes the raw list and moves to the next kept entry (else the last); labels / hints are cut to the limits", () => {
    const raw = [{ target: { kind: "term", term_id: 1 } }, "bad", { target: { kind: "uplc_line", line: 3 }, label: "x".repeat(100), hint: "h".repeat(2100), severity: "error" }, { target: { kind: "nope" } }];
    expect(checkAnnotations(raw, "de_uplc", undefined, 1).focus).toBe(1);
    expect(checkAnnotations(raw, "de_uplc", undefined, 3).focus).toBe(1);
    expect(checkAnnotations(raw, "de_uplc", undefined, 0).focus).toBe(0);
    const checked = checkAnnotations(raw, "de_uplc", undefined);
    expect(checked.dropped.map((d) => d.index)).toEqual([1, 3]);
    expect(checked.clipped).toBe(2);
    expect(checked.annotations[1]!.label).toHaveLength(80);
    expect(checked.annotations[1]!.hint).toHaveLength(2000);
    expect(checked.annotations[1]!.severity).toBe("error");
    expect(checkAnnotations([], "de_uplc", undefined, 5)).toMatchObject({ annotations: [], focus: 0 });
  });
});

describe("generated annotations", () => {
  const record = {
    txId: "tx_mainnet_000000000000",
    redeemerTargets: [{ ref: "spend:2", purpose: "spend", index: 2, witness_index: 0, target: "input x#0", ex_units: { mem: "1", steps: "1" } }],
    validation: {
      at: 0,
      elapsedMs: 1,
      phases: "both",
      redeemers: new Map(),
      result: {
        errors: [{ error: { FeeTooSmallUTxO: { actual_fee: 1 } }, error_message: "fee too small", locations: ["transaction.body.fee"], hint: "raise the fee" }],
        phase2_errors: [{ error: { MachineError: { tag: "Spend", index: 2 } }, error_message: "machine error", locations: ["transaction.witness_set.redeemers.0"] }],
        warnings: [{ warning: "SomeWarning", warning_message: "careful", locations: ["transaction.body.outputs.0", "transaction.body.outputs.1"] }],
        phase2_warnings: [],
      },
    },
  } as unknown as TxRecord;

  it("validation: diagnostics indexed in the app's order, one diagnostic + a tx_path for the first location of each", () => {
    expect(indexedDiagnostics(record).map((d) => [d.index, d.name, d.severity, d.redeemer])).toEqual([
      [0, "FeeTooSmallUTxO", "error", undefined],
      [1, "MachineError", "error", "spend:2"],
      [2, "SomeWarning", "warning", undefined],
    ]);
    const { annotations, total } = validationAnnotations(record);
    expect(total).toBe(6);
    expect(annotations.map((a) => a.target)).toEqual([
      { kind: "diagnostic", index: 0 },
      { kind: "tx_path", path: "transaction.body.fee" },
      { kind: "diagnostic", index: 1 },
      { kind: "tx_path", path: "transaction.witness_set.redeemers.0" },
      { kind: "diagnostic", index: 2 },
      { kind: "tx_path", path: "transaction.body.outputs.0" },
    ]);
    expect(annotations[0]).toEqual({ target: { kind: "diagnostic", index: 0 }, label: "FeeTooSmallUTxO", severity: "error" });
    expect(annotations[4]!.severity).toBe("warning");
  });

  it("a failed redeemer: its Plutus row first, then only its own diagnostics; a clean one gets none", () => {
    const failed = redeemerAnnotations(record, "spend:2", { tag: "Spend", index: 2, success: false, error: "Plutus machine error: boom\nmore" });
    expect(failed.map((a) => a.target)).toEqual([{ kind: "redeemer", tag: "Spend", index: 2 }, { kind: "diagnostic", index: 1 }, { kind: "tx_path", path: "transaction.witness_set.redeemers.0" }]);
    expect(failed[0]).toMatchObject({ label: "spend:2 failed", severity: "error" });
    expect(redeemerAnnotations(record, "mint:0", { tag: "Mint", index: 0, success: true })).toEqual([]);
  });

  it("cbor_errors: a structural error, a span (or path) per row and the schema range when the schema is embedded", () => {
    const rows = [
      { kind: "mismatch", message: "unexpected key 2", expected: null, path: "$[2]", path_short: "$[2]", byte_offset: 3, byte_length: 1, cddl_fragment: "{1: uint}", cddl_line: 1, cddl_range: [7, 16] as [number, number] },
      { kind: "mismatch", message: "no bytes", expected: "uint", path: "$[0]", path_short: "$[0]", byte_offset: null, byte_length: null, cddl_fragment: null, cddl_line: null },
    ];
    const withRange = cborErrorAnnotations({ structural: { kind: "unexpected_eof", message: "eof", offset: 5 } as never, rows, withCddlRange: true });
    expect(withRange.map((a) => a.target)).toEqual([
      { kind: "cbor_span", offset: 5, length: 1 },
      { kind: "cbor_span", offset: 3, length: 1 },
      { kind: "cddl_range", start: 7, end: 16 },
      { kind: "cbor_path", path: "$[0]" },
    ]);
    expect(withRange[1]!.hint).toBe("unexpected key 2\nschema: {1: uint}");
    expect(withRange[3]!.hint).toBe("no bytes\nexpected uint");
    expect(cborErrorAnnotations({ rows, withCddlRange: false }).map((a) => a.target.kind)).toEqual(["cbor_span", "cbor_path"]);
  });
});

describe("URL inlining and the link store", () => {
  it("inlines up to 2,000 characters; longer URLs become length + preview + the resource to read", () => {
    expect(inlineUrl(undefined, "r")).toBeNull();
    const short = `https://x.org/#${"a".repeat(INLINE_URL_CHARS - 15)}`;
    expect(inlineUrl(short, "r")).toBe(short);
    const long = `${short}b`;
    expect(inlineUrl(long, "cardano-debug://link/x/url.txt")).toEqual({ length: long.length, preview: `${long.slice(0, 120)}…`, note: "too long to inline; read the cardano-debug://link/x/url.txt resource" });
  });

  it("a caller-chosen cap (ui_link: 16,000) and a link file named in the note", () => {
    const url = `https://x.org/#${"a".repeat(5_000)}`;
    expect(inlineUrl(url, "r", { cap: UI_LINK_INLINE_CHARS })).toBe(url);
    expect(inlineUrl(url, "r", { cap: 100, file: true })).toEqual({ length: url.length, preview: `${url.slice(0, 120)}…`, note: "too long to inline; open link_file or read the r resource" });
    expect(UI_LINK_INLINE_CHARS).toBe(16_000);
  });

  it("writeLinkFile: an absolute path under <cache>/links, the URL without a newline, the oldest files pruned, an unwritable cache dir gives undefined", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cdm-linkfile-"));
    const first = writeLinkFile(dir, "lnk_0000000000000001", "https://a/#1", 3)!;
    expect(first).toBe(path.join(dir, "links", "lnk_0000000000000001.url.txt"));
    expect(readFileSync(first, "utf8")).toBe("https://a/#1");
    for (const n of [2, 3, 4]) {
      const file = writeLinkFile(dir, `lnk_000000000000000${n}`, `https://a/#${n}`, 3)!;
      utimesSync(file, new Date(Date.now() + n * 1000), new Date(Date.now() + n * 1000));
    }
    expect(readdirSync(path.join(dir, "links")).sort()).toEqual(["lnk_0000000000000002.url.txt", "lnk_0000000000000003.url.txt", "lnk_0000000000000004.url.txt"]);
    const blocker = path.join(dir, "file");
    writeFileSync(blocker, "x");
    expect(writeLinkFile(path.join(blocker, "sub"), "lnk_0000000000000005", "https://a")).toBeUndefined();
  });

  it("the same URL gets the same id; the store keeps the most recent entries", () => {
    const store = new UiLinkStore(2);
    const a = store.put("https://a");
    expect(a).toMatch(/^lnk_[0-9a-f]{16}$/);
    expect(store.put("https://a")).toBe(a);
    const b = store.put("https://b");
    store.put("https://c");
    expect(store.get(a)).toBeUndefined();
    expect(store.get(b)).toBe("https://b");
  });
});

/** The `#d=` payload of a de-uplc-web URL. */
function deUplcPayload(url: string): Json {
  const d = url.split("#d=")[1]!;
  return JSON.parse(gunzipSync(Buffer.from(d, "base64url")).toString("utf8"));
}

describe.skipIf(!existsSync(LIB_WORKER))("ui_link without a loaded transaction", () => {
  let lib: LibClient;
  let ctx: AppContext;
  const opened: string[] = [];

  beforeAll(() => {
    configure({ compressor: nodeBrotliCompressor });
    const config = { ...loadConfig({}), cacheDir: mkdtempSync(path.join(os.tmpdir(), "cdm-uilink-")), cquisitorBase: { origin: "http://localhost:3011", basePath: "" }, deUplcBase: "http://localhost:5173" };
    lib = createLibClient(config, { entry: new URL(`file://${LIB_WORKER}`) });
    ctx = {
      config,
      lib,
      txStore: new TxStore(),
      sessions: new SessionRegistry({ sweepIntervalMs: 60_000 }),
      startedAt: Date.now(),
      services: { urlOpener: async (url: string) => (opened.push(url), { ok: true as const }) },
      onShutdown: () => undefined,
      shutdown: async () => undefined,
    };
  });

  afterAll(async () => {
    await lib.dispose();
  });

  const call = async (args: Json) => (await uiLink(ctx, uiLinkInputSchema.parse(args))).structuredContent as Json;
  const fullUrl = async (body: Json) => (await readResourceUri(ctx, new URL(body.link_resource))).contents[0]!.text!;

  it("schema: app is required and closed, from / tab are enums, annotations take anything (checked later)", () => {
    expect(uiLinkInputSchema.safeParse({}).success).toBe(false);
    expect(uiLinkInputSchema.safeParse({ app: "browser" }).success).toBe(false);
    expect(uiLinkInputSchema.safeParse({ app: "cquisitor", from: ["everything"] }).success).toBe(false);
    expect(uiLinkInputSchema.safeParse({ app: "cquisitor", tab: "home" }).success).toBe(false);
    expect(uiLinkInputSchema.safeParse({ app: "de_uplc", focus: -1 }).success).toBe(false);
    expect(uiLinkInputSchema.safeParse({ app: "de_uplc", annotations: [1, "x", null, { target: {} }] }).success).toBe(true);
  });

  it("refuses incomplete or contradictory sources with invalid_argument / expired_handle", async () => {
    const cases: Array<[Json, string, RegExp]> = [
      [{ app: "cquisitor" }, "invalid_argument", /Give a source/],
      [{ app: "cquisitor", cbor: "00", dbg_id: "dbg_x" }, "invalid_argument", /do not apply to app='cquisitor'/],
      [{ app: "cquisitor", tab: "transaction-validator", cbor: "00" }, "invalid_argument", /needs tx_id/],
      [{ app: "cquisitor", cbor: "00", cddl: "conway", preset: "conway" }, "invalid_argument", /not both/],
      [{ app: "cquisitor", cbor: "00", preset: "dijkstra" }, "invalid_argument", /presets cquisitor ships/],
      [{ app: "de_uplc" }, "invalid_argument", /exactly one source/],
      [{ app: "de_uplc", script: "00", dbg_id: "dbg_x" }, "invalid_argument", /exactly one source/],
      [{ app: "de_uplc", tx_id: "tx_mainnet_000000000000" }, "invalid_argument", /also pass redeemer/],
      [{ app: "de_uplc", script: REF_SCRIPT, tab: "general-cbor" }, "invalid_argument", /tab applies only to app='cquisitor'/],
      [{ app: "de_uplc", script: REF_SCRIPT, decompile_options: {} }, "invalid_argument", /app='decompiler'/],
      [{ app: "de_uplc", tx_id: "tx_mainnet_000000000000", redeemer: "spend:0" }, "expired_handle", /tx_load/],
      [{ app: "cquisitor", tx_id: "tx_mainnet_000000000000" }, "expired_handle", /tx_load/],
      [{ app: "de_uplc", dbg_id: "dbg_00000000-0000-0000-0000-000000000000" }, "expired_handle", /debug_open/],
    ];
    for (const [args, code, message] of cases) {
      const result = await uiLink(ctx, uiLinkInputSchema.parse(args));
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.structuredContent.code, JSON.stringify(args)).toBe(code);
      expect(String(result.structuredContent.message), JSON.stringify(args)).toMatch(message);
    }
  });

  it("general-cbor + from=cbor_errors: the structural error as a byte span, decoded back with the lib parser", async () => {
    const body = await call({ app: "cquisitor", cbor: "d8799f41aa02", from: ["cbor_errors"], annotations: [{ target: { kind: "cbor_path", path: "$" }, label: "root" }] });
    expect(body).toMatchObject({ app: "cquisitor", tab: "general-cbor", annotations_count: 2, focus: 0, dropped: [], opened: false });
    expect(body.url.startsWith("http://localhost:3011/#general-cbor?v=1&e=b&d=")).toBe(true);
    const parsed = parseHash(body.url.split("#")[1]);
    expect(parsed.tab).toBe("general-cbor");
    const share = await parseGeneralCborShare(parsed.params);
    expect(share.cbor).toBe("d8799f41aa02");
    expect(share.annotations.map((a) => a.target)).toEqual([{ kind: "cbor_path", path: "$" }, { kind: "cbor_span", offset: expect.any(Number), length: 1 }]);
    expect(share.annotations[1]!.severity).toBe("error");
  });

  it("cddl-validator with an embedded schema: byte span + schema range per row; the range slices the schema text", async () => {
    const schema = "user = { 1: uint }";
    const body = await call({ app: "cquisitor", cbor: "a201010202", cddl: schema, from: ["cbor_errors"], focus: 1 });
    expect(body).toMatchObject({ tab: "cddl-validator", focus: 1, dropped: [] });
    const share = await parseCddlShare(parseHash(body.url.split("#")[1]).params);
    expect(share).toMatchObject({ cddl: schema, cbor: "a201010202", rule: "user", annotationFocus: 1 });
    const kinds = share.annotations.map((a) => a.target.kind);
    expect(kinds).toContain("cbor_span");
    expect(kinds).toContain("cddl_range");
    const range = share.annotations.find((a) => a.target.kind === "cddl_range")!.target as { start: number; end: number };
    expect(schema.slice(range.start, range.end)).toContain("1: uint");
  });

  it("cddl-validator with the app's preset: no schema ranges (its copy may differ), a note says so; the rule is picked when absent", async () => {
    const tx = readTx("pool-mint.tx");
    const body = await call({ app: "cquisitor", cbor: tx, preset: "conway", from: ["cbor_errors"] });
    const url = typeof body.url === "string" ? body.url : await fullUrl(body);
    const share = await parseCddlShare(parseHash(url.split("#")[1]!).params);
    expect(share.preset).toBe("conway");
    expect(share.rule).toBe("transaction");
    expect(share.annotations.every((a) => a.target.kind !== "cddl_range")).toBe(true);
    if (share.annotations.length > 0) expect(body.notes.join("\n")).toMatch(/no cddl_range targets with preset/);
  });

  it("cardano-cbor takes no targets: they come back in dropped; the network defaults to mainnet", async () => {
    const body = await call({ app: "cquisitor", tab: "cardano-cbor", cbor: "d8799f41aa02ff", annotations: [{ target: { kind: "cbor_span", offset: 0, length: 1 } }] });
    expect(body).toMatchObject({ tab: "cardano-cbor", annotations_count: 0, dropped: [{ index: 0, reason: expect.stringMatching(/does not apply to the cardano-cbor tab \(accepted: none\)/) }] });
    const share = await parseCardanoCborShare(parseHash(body.url.split("#")[1]).params);
    expect(share).toMatchObject({ cbor: "d8799f41aa02ff", net: "mainnet" });
  });

  it("de_uplc from a script: #d= payload with ann / ann_focus; wrong-view targets are dropped and focus follows", async () => {
    const body = await call({
      app: "de_uplc",
      script: REF_SCRIPT,
      plutus_version: "V2",
      annotations: [{ target: { kind: "pseudo_line", line: 1 } }, { target: { kind: "term", term_id: 7 }, label: "here", severity: "warning" }, { target: { kind: "uplc_line", line: 12 }, hint: "line" }],
      focus: 0,
    });
    expect(body).toMatchObject({ app: "de_uplc", annotations_count: 2, focus: 0, dropped: [{ index: 0, reason: expect.stringMatching(/debugger view/) }] });
    expect(body.tab).toBeUndefined();
    const url = typeof body.url === "string" ? body.url : await fullUrl(body);
    expect(url.startsWith("http://localhost:5173/#d=")).toBe(true);
    const payload = deUplcPayload(url);
    expect(payload).toMatchObject({ v: "v2", ann: [{ target: { kind: "term", term_id: 7 }, label: "here", severity: "warning" }, { target: { kind: "uplc_line", line: 12 }, hint: "line" }] });
    expect(payload.ann_focus).toBeUndefined(); // focus 0 is the default
    expect(typeof payload.script).toBe("string");
    expect(body.notes.join("\n")).toMatch(/program-only/);
  });

  it("URLs inline up to 16,000 characters; longer ones are a preview with link_file, the link resource has the full text; open hands the full URL to the opener", async () => {
    const tx = readTx("pool-mint.tx");
    // a ~7 KB transaction (two V3 scripts and a 4 KB image blob in a datum: it hardly compresses) is several thousand characters of URL: inline, and the file / resource carry the same text
    const inline = await call({ app: "cquisitor", cbor: tx, rule: "transaction" });
    expect(inline.url_length).toBeGreaterThan(INLINE_URL_CHARS);
    expect(inline.url_length).toBeLessThanOrEqual(UI_LINK_INLINE_CHARS);
    expect(inline.url).toBe(await fullUrl(inline));
    expect(readFileSync(inline.link_file, "utf8")).toBe(inline.url);

    // incompressible bytes: a 15,000-byte byte string is ~20k characters of base64url
    const noise = `59${(15_000).toString(16).padStart(4, "0")}${randomBytes(15_000).toString("hex")}`;
    const body = await call({ app: "cquisitor", cbor: noise, open: true });
    expect(body.url_length).toBeGreaterThan(UI_LINK_INLINE_CHARS);
    expect(body.url).toMatchObject({ length: body.url_length, note: expect.stringContaining("link_file") });
    expect(body.url.note).toContain(body.link_resource);
    const full = await fullUrl(body);
    expect(full).toHaveLength(body.url_length);
    expect(full.startsWith(body.url.preview.slice(0, 100))).toBe(true);
    expect(body.link_file).toMatch(/links[\\/]lnk_[0-9a-f]{16}\.url\.txt$/);
    expect(path.isAbsolute(body.link_file)).toBe(true);
    expect(readFileSync(body.link_file, "utf8")).toBe(full);
    expect(body.opened).toBe(true);
    expect(opened.at(-1)).toBe(full);
    const ctxNoOpen = { ...ctx, config: { ...ctx.config, noOpen: true } };
    const off = (await uiLink(ctxNoOpen, uiLinkInputSchema.parse({ app: "cquisitor", cbor: "00", open: true }))).structuredContent as Json;
    expect(off.opened).toBe(false);
    expect(off.notes.join("\n")).toMatch(/CARDANO_DEBUG_NO_OPEN=1/);
    expect(opened.at(-1)).toBe(full);
  });
});
