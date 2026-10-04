// script_locate(script=…) accepts every script wrapping script_decompile does (hex, base64, cardano-cli
// envelope, ScriptRef) and names the argument when it cannot read it. The engine session is a stub:
// what is checked is the bytes and language handed to it.
import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import type { AppContext } from "../../src/context.js";
import { wrapCborBytes } from "../../src/decompiler/scriptBytes.js";
import type { SessionClient } from "../../src/engine/service.js";
import { SessionRegistry } from "../../src/store/sessionRegistry.js";
import type { ToolResult } from "../../src/tools/_shared.js";
import { scriptLocateTool } from "../../src/tools/script_locate.js";
import { WorkerCallError } from "../../src/workers/rpc.js";
import { fxStr, readFixtureText } from "../helpers/fixtures.js";
import { inProcessLib } from "../helpers/inProcessLib.js";

const SINGLE = readFixtureText(fxStr("s01.spendScriptFile")).trim(); // the artificial S1 spend script (single-CBOR-wrapped)
const FLAT = SINGLE.slice(6);
const DOUBLE = wrapCborBytes(SINGLE);

type Json = Record<string, any>;

interface Opened {
  source: string;
  language: string;
}

function setup(openError?: Error) {
  const opened: Opened[] = [];
  let clients = 0;
  const client = {
    openProgram: async (source: string, language: string) => {
      opened.push({ source, language });
      if (openError) throw openError;
      return { script_hash: "ab".repeat(28), language, term_count: 3, uplc_lines: 5 };
    },
    locate: async () => ({ term_id: 0, term_kind: "Apply", uplc: { line: 1, excerpt: ["(program"] } }),
    close: async () => undefined,
  };
  const registry = new SessionRegistry({ sweepIntervalMs: 60_000 });
  registries.push(registry);
  const ctx = {
    config: loadConfig({}),
    lib: inProcessLib(),
    sessions: registry,
    services: { engine: { newClient: () => ((clients += 1), client as unknown as SessionClient) } },
  } as unknown as AppContext;
  let handler!: (args: Record<string, unknown>) => Promise<ToolResult>;
  const server = { registerTool: (_name: string, _config: unknown, h: (args: Record<string, unknown>) => Promise<ToolResult>) => (handler = h) } as unknown as McpServer;
  scriptLocateTool.register(server, ctx);
  return { call: (args: Record<string, unknown>) => handler(args), opened, clients: () => clients };
}

const registries: SessionRegistry[] = [];
afterEach(() => {
  for (const r of registries.splice(0)) r.closeAll("shutdown");
});

const body = (result: ToolResult): Json => result.structuredContent as Json;

describe("script_locate script input", () => {
  it("opens the single-wrapped bytes for every wrapping, with the language the wrapping states", async () => {
    const { call, opened } = setup();
    const envelope = JSON.stringify({ type: "PlutusScriptV1", description: "", cborHex: DOUBLE });
    const cases: Array<[string, string, string]> = [
      ["flat hex", FLAT, "V3"],
      ["single hex", `0x${SINGLE}`, "V3"],
      ["double hex", DOUBLE, "V3"],
      ["cli envelope", envelope, "V1"],
      ["ScriptRef", `8202${DOUBLE}`, "V2"],
      ["base64", Buffer.from(SINGLE, "hex").toString("base64"), "V3"],
    ];
    for (const [label, script, language] of cases) {
      const answer = await call({ script, term_id: 0 });
      expect(answer.isError, label).toBeFalsy();
      const last = opened[opened.length - 1]!;
      expect(last.source, label).toBe(SINGLE);
      expect(last.language, label).toBe(language);
      expect(body(answer), label).toMatchObject({ term_id: 0, script_hash: "ab".repeat(28), uplc: { line: 1 } });
    }
  });

  it("plutus_version wins over the wrapping; UPLC text is passed as it is", async () => {
    const { call, opened } = setup();
    await call({ script: JSON.stringify({ type: "PlutusScriptV1", cborHex: DOUBLE }), plutus_version: "V2", term_id: 0 });
    expect(opened[0]).toEqual({ source: SINGLE, language: "V2" });
    await call({ script: "  (program 1.1.0 (con integer 1))\n", term_id: 0 });
    expect(opened[1]).toEqual({ source: "(program 1.1.0 (con integer 1))", language: "V3" });
    const bad = await call({ script: SINGLE, plutus_version: "V9", term_id: 0 });
    expect(body(bad)).toMatchObject({ code: "invalid_argument", argument: "plutus_version" });
  });

  it("names the argument and what is accepted when the input is not a script", async () => {
    const { call, opened, clients } = setup();
    for (const script of ["hello world", '{"type":"PlutusScriptV2"}', "abc", fxStr("s01.spendScript.address")]) {
      const answer = await call({ script, term_id: 0 });
      expect(answer.isError, script).toBe(true);
      expect(body(answer), script).toMatchObject({ code: "invalid_argument", argument: "script" });
      expect(body(answer).message, script).toMatch(/accepts UPLC text.*cardano-cli envelope/);
    }
    const none = await call({ term_id: 0 });
    expect(body(none)).toMatchObject({ code: "invalid_argument", argument: "script" });
    expect(body(none).message).toMatch(/dbg_id.*script \(UPLC text/);
    expect(opened).toEqual([]);
    expect(clients()).toBe(0); // nothing was opened for any of them
  });

  it("a native script is refused however it arrives", async () => {
    const { call, clients } = setup();
    const pubkey = "8200581c" + "11".repeat(28);
    const wrapped = "8200" + pubkey;
    for (const script of [pubkey, wrapped, JSON.stringify({ type: "SimpleScript", cborHex: pubkey }), Buffer.from(pubkey, "hex").toString("base64")]) {
      const answer = await call({ script, term_id: 0 });
      expect(answer.isError, script).toBe(true);
      expect(body(answer), script).toMatchObject({ code: "native_script", argument: "script" });
    }
    expect(clients()).toBe(0);
  });

  it("an engine decode failure names the script argument and the accepted forms", async () => {
    const { call } = setup(new WorkerCallError({ name: "Error", message: "Failed to decode flat program: unexpected end of input", fatal: false }));
    const answer = await call({ script: SINGLE, term_id: 0 });
    expect(answer.isError).toBe(true);
    expect(body(answer)).toMatchObject({ code: "invalid_argument", argument: "script" });
    expect(body(answer).message).toMatch(/Failed to decode flat program.*accepts UPLC text/);
  });
});
