// debug_source(find=…) and script_locate(script=…) over stdio against dist/server.js.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { wrapCborBytes } from "../../src/decompiler/scriptBytes.js";
import { fixturePath, fxInt, fxStr } from "../helpers/fixtures.js";
import { PROJECT_ROOT, StdioClient } from "../helpers/stdioClient.js";

// the artificial S1 spend script (order_fixed, Plutus V2, single-CBOR-wrapped)
const SAMPLE_SCRIPT = fixturePath(fxStr("s01.spendScriptFile"));
const TRACE_PROGRAM = '(program 1.0.0 [[(force (builtin trace)) (con string "hello")] [(lam x [(builtin addInteger) x (con integer 1)]) (con integer 41)]])';

type Json = Record<string, any>;

describe("debug_source find / script_locate script wrappings over stdio", () => {
  let client: StdioClient;
  let single: string;

  beforeAll(async () => {
    expect(existsSync(path.join(PROJECT_ROOT, "dist", "server.js")), "run `npm run build` before the e2e test").toBe(true);
    single = readFileSync(SAMPLE_SCRIPT, "utf8").trim();
    client = StdioClient.dist();
    await client.initialize();
  });

  afterAll(async () => {
    const code = await client.close();
    expect(client.nonJsonStdout, "stdout must carry only JSON-RPC").toEqual([]);
    expect(code).toBe(0);
  });

  it("debug_source(find) answers the lines holding a builtin / string / constant with their term ids", async () => {
    const opened = await client.callTool<Json>("debug_open", { script: TRACE_PROGRAM, plutus_version: "V2" });
    const dbg = opened.structuredContent!.dbg_id as string;

    const builtin = await client.callTool<Json>("debug_source", { dbg_id: dbg, find: "addInteger" });
    expect(builtin.isError, JSON.stringify(builtin.structuredContent)).toBeFalsy();
    expect(builtin.structuredContent).toMatchObject({ dbg_id: dbg, find: "addInteger", total_lines: 20, matches_total: 1 });
    expect(builtin.structuredContent!.matches).toEqual([expect.objectContaining({ line: 12, term_id: 4, kind: "Builtin", label: "addInteger" })]);
    expect(builtin.structuredContent!.matches[0].text).toContain("addInteger");
    // The reply is the matches only: no window text, no resource links (those are debug_open's).
    expect(builtin.structuredContent).not.toHaveProperty("text");
    expect(builtin.structuredContent).not.toHaveProperty("resources");
    expect(builtin.content.filter((c) => c.type === "resource_link")).toHaveLength(0);

    const text = await client.callTool<Json>("debug_source", { dbg_id: dbg, find: "HELLO" });
    expect(text.structuredContent!.matches_total).toBe(1);
    expect(text.structuredContent!.matches[0]).toMatchObject({ kind: "Constant" });
    expect(text.structuredContent!.matches[0].text).toContain('"hello"');

    const capped = await client.callTool<Json>("debug_source", { dbg_id: dbg, find: "(con ", max_matches: 1 });
    expect(capped.structuredContent!.matches).toHaveLength(1);
    expect(capped.structuredContent!.matches_total).toBeGreaterThanOrEqual(2);
    expect(capped.structuredContent).toMatchObject({ truncated: true });
    expect(capped.structuredContent!.next_line_from).toBe(capped.structuredContent!.matches[0].line + 1);

    const none = await client.callTool<Json>("debug_source", { dbg_id: dbg, find: "unListData" });
    expect(none.structuredContent).toMatchObject({ matches_total: 0, matches: [] });

    const clash = await client.callTool<Json>("debug_source", { dbg_id: dbg, find: "addInteger", radius: 3 });
    expect(clash.isError).toBe(true);
    expect(clash.structuredContent).toMatchObject({ code: "invalid_argument", argument: "radius" });

    const window = await client.callTool<Json>("debug_source", { dbg_id: dbg, radius: 1 });
    expect(window.structuredContent).not.toHaveProperty("resources");
    await client.callTool("debug_close", { dbg_id: dbg });
  });

  it("script_locate reads a cardano-cli envelope, a ScriptRef and base64 like script_decompile does", async () => {
    const double = wrapCborBytes(single);
    const reference = await client.callTool<Json>("script_locate", { script: single, plutus_version: "V2", term_id: 0 });
    expect(reference.isError, JSON.stringify(reference.structuredContent)).toBeFalsy();
    const termCount = reference.structuredContent!.term_count;
    expect(termCount).toBe(fxInt("s01.spendScript.registry.termCount"));

    const envelope = await client.callTool<Json>("script_locate", { script: JSON.stringify({ type: "PlutusScriptV2", description: "", cborHex: double }), term_id: 0 });
    expect(envelope.isError, JSON.stringify(envelope.structuredContent)).toBeFalsy();
    expect(envelope.structuredContent).toMatchObject({ term_count: termCount, plutus_version: "V2" }); // the envelope's type picks the language

    const ref = await client.callTool<Json>("script_locate", { script: "8202" + double, term_id: 0 });
    expect(ref.isError, JSON.stringify(ref.structuredContent)).toBeFalsy();
    expect(ref.structuredContent).toMatchObject({ term_count: termCount, plutus_version: "V2" });

    const b64 = await client.callTool<Json>("script_locate", { script: Buffer.from(single, "hex").toString("base64"), plutus_version: "V2", uplc_line: 3 });
    expect(b64.isError, JSON.stringify(b64.structuredContent)).toBeFalsy();
    expect(b64.structuredContent).toMatchObject({ term_count: termCount });
    expect(b64.structuredContent!.uplc.line).toBe(3);
  });

  it("script_locate names the argument and the accepted forms for input it cannot read; a native script is refused", async () => {
    for (const script of ['{"type":"PlutusScriptV2"}', "not a script"]) {
      const bad = await client.callTool<Json>("script_locate", { script, term_id: 0 });
      expect(bad.isError, script).toBe(true);
      expect(bad.structuredContent, script).toMatchObject({ code: "invalid_argument", argument: "script" });
      expect(bad.structuredContent!.message, script).toMatch(/accepts UPLC text.*cardano-cli envelope/);
    }
    const native = await client.callTool<Json>("script_locate", { script: JSON.stringify({ type: "SimpleScript", cborHex: "8200581c" + "11".repeat(28) }), term_id: 0 });
    expect(native.isError).toBe(true);
    expect(native.structuredContent).toMatchObject({ code: "native_script", argument: "script" });
  });
});
