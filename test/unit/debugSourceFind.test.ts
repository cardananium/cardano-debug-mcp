// debug_source: find (anchoring a pseudocode fragment in the UPLC listing) and the ids-only rows of
// with_ids. The listing and the term ids come from a real engine session loaded in-process; the
// session client is a thin stand-in over it (no worker).
import * as engine from "@cardananium/de-uplc-engine-wasm";
import type { McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppContext } from "../../src/context.js";
import { EngineSession } from "../../src/engine/session-core.js";
import type { SessionClient } from "../../src/engine/service.js";
import { SessionRegistry } from "../../src/store/sessionRegistry.js";
import { debugSourceTool, excerptAround, findInListing, idRows } from "../../src/tools/debug_source.js";
import type { ToolResult } from "../../src/tools/_shared.js";
import { readWasm } from "../../src/wasm-assets.js";

const PROGRAM =
  '(program 1.0.0 [[(force (builtin trace)) (con string "Hello Msg")] [(lam x [[(builtin appendByteString) x] (con bytestring #9e3c01)]) (con bytestring #aa)]])';

type Json = Record<string, any>;
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

let session: EngineSession;
let registry: SessionRegistry;
let dbgId: string;
let call: Handler;

beforeAll(() => {
  engine.initSync({ module: readWasm("de_uplc_bg.wasm") });
  session = EngineSession.openProgram(engine, PROGRAM, "V2");
  registry = new SessionRegistry({ sweepIntervalMs: 60_000 });
  const { record } = registry.create({ mode: "program", language: "V2", partsConfig: { program: PROGRAM, language: "v2" } });
  dbgId = record.dbgId;
  record.client = {
    lost: false,
    uplcText: async () => session.uplcText(),
    locate: async (query: Parameters<EngineSession["locate"]>[0]) => session.locate(query),
    sourceWindow: async (options: Parameters<EngineSession["sourceWindow"]>[0]) => session.sourceWindow(options),
    close: async () => undefined,
  } as unknown as SessionClient;
  const handlers = new Map<string, (args: Record<string, unknown>, mcp: unknown) => Promise<ToolResult>>();
  const server = { registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>, mcp: unknown) => Promise<ToolResult>) => handlers.set(name, handler) } as unknown as McpServer;
  debugSourceTool.register(server, { sessions: registry } as unknown as AppContext);
  const handler = handlers.get("debug_source")!;
  call = (args) => handler({ dbg_id: dbgId, ...args }, {});
});

afterAll(() => {
  session.free();
  registry.closeAll("shutdown");
});

const body = (result: ToolResult): Json => result.structuredContent as Json;

describe("debug_source find", () => {
  it("anchors a builtin by name: matching line, term id, kind and label", async () => {
    const result = await call({ find: "appendByteString" });
    expect(result.isError).toBeFalsy();
    const b = body(result);
    expect(b).toMatchObject({ dbg_id: dbgId, find: "appendByteString", matches_total: 1 });
    expect(b.total_lines).toBe(session.uplcText().split("\n").length);
    const hit = (b.matches as Json[])[0]!;
    expect(hit).toMatchObject({ kind: "Builtin", label: "appendByteString" });
    expect(hit.text).toBe("(builtin appendByteString)");
    // The id and line are the session's own coordinates.
    expect(session.locate({ term_id: hit.term_id, context_lines: 0 }).uplc?.line).toBe(hit.line);
    expect(session.uplcText().split("\n")[hit.line - 1]).toContain("appendByteString");
  });

  it("finds constant bytes (#hex, any case) and string text", async () => {
    const bytes = body(await call({ find: "#9E3C" }));
    expect(bytes.matches_total).toBe(1);
    expect(bytes.matches[0]).toMatchObject({ kind: "Constant", text: "(con bytestring #9e3c01)" });
    const text = body(await call({ find: "hello msg" }));
    expect(text.matches_total).toBe(1);
    expect(text.matches[0].text).toBe('(con string "Hello Msg")');
  });

  it("matches pseudocode spelling (un_list_data ~ unListData) and says so", async () => {
    const b = body(await call({ find: "append_byte_string" }));
    expect(b.matches_total).toBe(1);
    expect(b.matches[0].label).toBe("appendByteString");
    expect(b.note).toMatch(/ignoring case, spaces and underscores/);
    // A literal underscore hit would not need the retry.
    expect(findInListing(["(con string \"a_b\")"], "a_b", { from: 1, to: 1 }, 5).loose).toBe(false);
  });

  it("no match: empty list, total 0 and what the search is", async () => {
    const b = body(await call({ find: "unListData" }));
    expect(b).toMatchObject({ matches_total: 0, matches: [] });
    expect(b.note).toMatch(/case-insensitive substring/);
    expect(b).not.toHaveProperty("truncated");
  });

  it("caps the matches, reports the total and where to continue; line_from / line_to narrow the range", async () => {
    const lines = session.uplcText().split("\n");
    const conLines = lines.map((l, i) => (l.includes("(con ") ? i + 1 : 0)).filter(Boolean);
    expect(conLines.length).toBeGreaterThanOrEqual(3);
    const capped = body(await call({ find: "(con ", max_matches: 1 }));
    expect(capped.matches_total).toBe(conLines.length);
    expect(capped.matches).toHaveLength(1);
    expect(capped).toMatchObject({ truncated: true, next_line_from: conLines[0]! + 1 });
    expect(capped.note).toContain(`line_from=${conLines[0]! + 1}`);
    const next = body(await call({ find: "(con ", max_matches: 1, line_from: capped.next_line_from }));
    expect(next.matches[0].line).toBe(conLines[1]);
    expect(next.matches_total).toBe(conLines.length - 1);
    expect(next.searched).toEqual({ line_from: capped.next_line_from, line_to: lines.length });
    const narrow = body(await call({ find: "(con ", line_from: conLines[1], line_to: conLines[1] }));
    expect(narrow.matches.map((m: Json) => m.line)).toEqual([conLines[1]]);
  });

  it("find does not mix with window arguments; max_matches needs find; the reply carries no resource links", async () => {
    for (const args of [{ find: "x", radius: 3 }, { find: "x", around: 0 }, { find: "x", with_ids: true }, { find: "x", max_chars: 500 }]) {
      const result = await call(args);
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({ code: "invalid_argument", argument: Object.keys(args)[1] });
    }
    expect((await call({ find: "appendByteString", with_ids: false })).isError).toBeFalsy();
    const lone = await call({ max_matches: 3 });
    expect(body(lone)).toMatchObject({ code: "invalid_argument", argument: "max_matches" });
    const blank = await call({ find: "   " });
    expect(body(blank)).toMatchObject({ code: "invalid_argument", argument: "find" });
    const found = await call({ find: "appendByteString" });
    expect(found.content).toHaveLength(1);
    expect(body(found)).not.toHaveProperty("resources");
    expect(body(await call({ radius: 1 }))).not.toHaveProperty("resources");
  });
});

describe("debug_source with_ids", () => {
  it("sends each line once: the text carries the lines, lines[] only the ids", async () => {
    const result = await call({ with_ids: true, radius: 200 });
    const b = body(result);
    const rows = b.lines as Json[];
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["n", "term_ids"]);
    // Same ids the engine reports for the same window.
    const reference = session.sourceWindow({ around: "current", radius: 200, with_ids: true, max_chars: 12_000, breakpoints: { term_ids: [], uplc_lines: [] } });
    expect(rows).toEqual(reference.lines.map((l) => ({ n: l.n, term_ids: l.term_ids })));
    expect(b.text).toBe(reference.text);
    // The records do not repeat every line's text (or marker) next to `text`.
    expect(JSON.stringify(rows).length).toBeLessThan(JSON.stringify(reference.lines).length);
    expect(JSON.stringify(rows)).not.toContain("builtin");
    expect(b).not.toHaveProperty("resources");
    const plain = body(await call({ radius: 200 }));
    expect(plain).not.toHaveProperty("lines");
  });

  it("idRows keeps a row for a line with no term start", () => {
    expect(idRows([{ n: 3, term_ids: [1, 2] }, { n: 4 }])).toEqual([{ n: 3, term_ids: [1, 2] }, { n: 4, term_ids: [] }]);
  });
});

describe("findInListing / excerptAround", () => {
  const listing = ["(program 1.0.0", "  (lam x", "    (con bytestring #AB12)", "    (con integer 7)", ")"];

  it("is a case-insensitive substring over the lines, counted before the cap", () => {
    const found = findInListing(listing, "ab12", { from: 1, to: 99 }, 5);
    expect(found).toMatchObject({ total: 1, loose: false });
    expect(found.hits[0]).toMatchObject({ line: 3, text: "(con bytestring #AB12)" });
    const many = findInListing(listing, "con", { from: 1, to: listing.length }, 1);
    expect(many.total).toBe(2);
    expect(many.hits).toHaveLength(1);
    expect(findInListing(listing, "con", { from: 4, to: 4 }, 5).hits.map((h) => h.line)).toEqual([4]);
    expect(findInListing(listing, "con", { from: 0, to: 2 }, 5).total).toBe(0);
  });

  it("cuts a very long line around the match", () => {
    const line = `(con data (Constr 0 [${"B #00 , ".repeat(800)}B #9e3c77 , ${"B #11 , ".repeat(800)}]))`;
    const [hit] = findInListing([line], "#9e3c77", { from: 1, to: 1 }, 1).hits;
    const shown = excerptAround(hit!.text, hit!.at);
    expect(shown).toContain("#9e3c77");
    expect(shown.length).toBeLessThan(220);
    expect(shown).toMatch(/^… .*… \[\+\d+ chars\]$/);
    expect(excerptAround("short", 0)).toBe("short");
  });
});
