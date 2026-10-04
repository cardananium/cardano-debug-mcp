// CEK debugging tools over stdio against dist/server.js: program-only session, parts session from
// the validator bytes fixture, breakpoints, resources, busy / expired handles, script_locate.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EvalRedeemerResultWire } from "../../src/lib.js";
import { fixturePath, fx, fxBig, fxInt, fxStr, readFixtureJson } from "../helpers/fixtures.js";
import { PROJECT_ROOT, StdioClient } from "../helpers/stdioClient.js";

interface Fixture {
  protocol_parameters: { protocolVersion: [number, number]; costModels: { plutusV2: number[] } };
  eval_redeemer_results: EvalRedeemerResultWire[];
}
// The raw validator result of the artificial S1 transaction (`s01.evalFile`); every number it holds is read from the manifest.
const fixture = readFixtureJson<Fixture>(fxStr("s01.evalFile"));
const spend = fixture.eval_redeemer_results.find((r) => r.tag === "Spend")!;

const TRACE_PROGRAM = '(program 1.0.0 [[(force (builtin trace)) (con string "hello")] [(lam x [(builtin addInteger) x (con integer 1)]) (con integer 41)]])';
const OMEGA = "(program 1.0.0 [(lam f [f f]) (lam f [f f])])";
/** A self-applying loop of `n` iterations (~43 transitions each) that traces "end" when it is done. */
function loopProgram(n: number): string {
  const body = '(lam self (lam n (force [ [ [ (force (builtin ifThenElse)) [ [ (builtin equalsInteger) n ] (con integer 0) ] ] (delay [ [ (force (builtin trace)) (con string "end") ] (con unit ()) ]) ] (delay [ [ self self ] [ [ (builtin subtractInteger) n ] (con integer 1) ] ]) ])))';
  return `(program 1.0.0 [ [ (lam f [ f f ]) ${body} ] (con integer ${n}) ])`;
}

const NODE20 = path.join(process.env.HOME ?? "", ".nvm/versions/node/v20.14.0/bin/node");
const variants: Array<{ label: string; make: () => StdioClient }> = [{ label: `dist (node ${process.version})`, make: () => StdioClient.dist() }];
if (existsSync(NODE20)) variants.push({ label: "dist (node v20.14.0)", make: () => StdioClient.dist(NODE20) });
if (process.env.CARDANO_DEBUG_E2E_DEV === "1") variants.push({ label: "dev (tsx)", make: () => StdioClient.dev() });

type Json = Record<string, any>;

describe.each(variants)("debug tools over stdio — $label", ({ make }) => {
  let client: StdioClient;

  beforeAll(async () => {
    expect(existsSync(path.join(PROJECT_ROOT, "dist", "server.js")), "run `npm run build` before the e2e test").toBe(true);
    client = make();
    await client.initialize();
  });

  afterAll(async () => {
    const code = await client.close();
    expect(client.nonJsonStdout, "stdout must carry only JSON-RPC").toEqual([]);
    expect(code).toBe(0);
  });

  it("registers the seven debug tools with flat input schemas", async () => {
    const { tools } = await client.request<{ tools: Array<{ name: string; inputSchema: { type: string; anyOf?: unknown; oneOf?: unknown; properties: Record<string, unknown> } }> }>("tools/list");
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["debug_open", "debug_run", "debug_inspect", "debug_source", "debug_profile", "debug_close", "script_locate"]) {
      const tool = byName.get(name);
      expect(tool, name).toBeDefined();
      expect(tool!.inputSchema.type).toBe("object");
      expect(tool!.inputSchema.anyOf).toBeUndefined();
      expect(tool!.inputSchema.oneOf).toBeUndefined();
    }
    expect(Object.keys(byName.get("debug_open")!.inputSchema.properties)).toEqual(expect.arrayContaining(["tx_id", "redeemer", "script", "plutus_version", "context", "redeemer_data", "datum", "cost_models", "protocol_major", "ex_units", "allow_program_only", "reopen"]));
    expect(Object.keys(byName.get("debug_run")!.inputSchema.properties)).toEqual(expect.arrayContaining(["dbg_id", "until", "steps", "term_id", "line", "contains", "builtin", "cpu", "restart", "max_steps", "timeout_ms", "context_lines", "breakpoints", "clear_breakpoints", "hit", "stop_before"]));
    // parameters that did nothing are gone; the ones that were missing are there
    expect(Object.keys(byName.get("debug_open")!.inputSchema.properties)).not.toContain("network");
    expect(Object.keys(byName.get("debug_inspect")!.inputSchema.properties)).not.toContain("decode_data");
    expect(Object.keys(byName.get("debug_inspect")!.inputSchema.properties)).toContain("term_id");
    // UPLC-only surface: no pseudocode positional inputs anywhere in the debug_* / script_locate schemas.
    const props = (name: string) => byName.get(name)!.inputSchema.properties as Record<string, Json>;
    expect(props("debug_open")).not.toHaveProperty("decompile");
    expect(props("debug_run").until!.enum).toEqual(["error", "done", "steps", "term", "uplc_line", "trace", "builtin", "budget"]);
    expect(Object.keys(props("debug_run").breakpoints!.properties)).toEqual(["term_ids", "uplc_lines"]);
    expect(props("debug_source")).not.toHaveProperty("view");
    expect(Object.keys(props("script_locate"))).toEqual(["dbg_id", "script", "plutus_version", "term_id", "uplc_line", "context_lines"]);
    for (const name of ["debug_open", "debug_run", "debug_inspect", "debug_source", "debug_profile", "script_locate"]) {
      expect(JSON.stringify(byName.get(name)!.inputSchema), name).not.toMatch(/pseudo_line|pseudo_lines|pseudocode_status|mapping/);
    }
  });

  it("a native (timelock) script's hex is refused with code native_script, never opened as a garbage UPLC program", async () => {
    const pubkey = "8200581c" + "11".repeat(28);
    const deep = "820181".repeat(10_000) + pubkey; // ScriptAll 10,000 levels deep (≈20k CBOR levels)
    const wrapped = "8200" + pubkey; // [0, native_script] (the script_ref form)
    for (const [script, form] of [[pubkey, "bare"], [deep, "bare"], [wrapped, "wrapped"]] as const) {
      for (const tool of ["debug_open", "script_locate", "script_decompile"]) {
        const args: Json = tool === "script_locate" ? { script, term_id: 0 } : { script };
        const answer = await client.callTool<Json>(tool, args);
        expect(answer.isError, `${tool} ${form} ${script.length}`).toBe(true);
        expect(answer.structuredContent, tool).toMatchObject({ code: "native_script", argument: "script", form });
        expect(answer.structuredContent!.message).toMatch(/native \(timelock\) script.*not a Plutus script/);
        expect(answer.content[0]!.text!.length).toBeLessThan(2_000);
      }
    }
  });

  it("program-only session: open, run to a trace, inspect, source, run to done, close, expired handle", async () => {
    const opened = await client.callTool<Json>("debug_open", { script: TRACE_PROGRAM, plutus_version: "V2" });
    expect(opened.isError).toBeFalsy();
    const sc = opened.structuredContent!;
    expect(sc.mode).toBe("program");
    expect(sc.dbg_id).toMatch(/^dbg_[0-9a-f-]{36}$/);
    expect(sc.plutus_version).toBe("V2");
    expect(sc.term_count).toBe(13);
    expect(sc.uplc_lines).toBe(20);
    expect(sc.position).toEqual({ term_id: 12, kind: "Apply", uplc_line: 1, machine_state: "Compute" });
    expect(sc).not.toHaveProperty("pseudocode_status");
    expect(sc).not.toHaveProperty("pseudocode_notes");
    expect(sc.resources.map((r: Json) => r.uri)).toEqual([`cardano-debug://session/${sc.dbg_id}/uplc.txt`, `cardano-debug://session/${sc.dbg_id}/state.json`, `cardano-debug://session/${sc.dbg_id}/traces.txt`]);
    expect(JSON.parse(opened.content[0]!.text!)).toEqual(sc);
    const dbg = sc.dbg_id as string;

    const trace = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "trace" });
    expect(trace.isError).toBeFalsy();
    expect(trace.structuredContent!.stopped.kind).toBe("trace");
    expect(trace.structuredContent!.traces).toMatchObject({ total: 1, new: ["hello"] });
    expect(trace.structuredContent!.status).toBe("ready");

    // breakpoints are range-checked like until='term' / until='uplc_line'
    const outside = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "done", breakpoints: { term_ids: [123456] } });
    expect(outside.isError).toBe(true);
    expect(outside.structuredContent).toMatchObject({ code: "invalid_argument", argument: "breakpoints" });
    expect(outside.structuredContent!.message).toMatch(/0\.\.12/);
    const outsideLine = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "done", breakpoints: { uplc_lines: [21] } });
    expect(outsideLine.structuredContent).toMatchObject({ code: "invalid_argument", argument: "breakpoints" });
    const restarted = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "builtin", builtin: "addInteger", restart: true, breakpoints: { uplc_lines: [4] } });
    expect(restarted.structuredContent!.stopped.kind).toBe("breakpoint");
    expect(restarted.structuredContent!.position.uplc_line).toBe(4);
    expect(restarted.structuredContent!.uplc_window).toContain("4>*");
    const resumed = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "builtin", builtin: "addInteger" });
    expect(resumed.structuredContent!.stopped.kind).toBe("builtin");
    expect(resumed.structuredContent!.position).toMatchObject({ term_id: 4, label: "addInteger", uplc_line: 12 });

    const env = await client.callTool<Json>("debug_inspect", { dbg_id: dbg, what: "env" });
    expect(env.structuredContent!.items).toEqual([expect.objectContaining({ index: 0, name: "x", debruijn: 1, type: "Con:Integer", summary: "41", ref: "env.values.0" })]);
    const value = await client.callTool<Json>("debug_inspect", { dbg_id: dbg, what: "value", path: "env.values.0" });
    expect(value.structuredContent!.value).toEqual({ constant: { type: "Integer", value: "41" }, value_type: "Con" });
    const frames = await client.callTool<Json>("debug_inspect", { dbg_id: dbg, what: "frames" });
    expect(frames.structuredContent!.total).toBe(3);
    const source = await client.callTool<Json>("debug_source", { dbg_id: dbg, radius: 1, with_ids: true });
    expect(source.structuredContent).not.toHaveProperty("view"); // UPLC is the only listing; no view selector
    expect(source.structuredContent).not.toHaveProperty("mapping");
    expect(source.structuredContent).not.toHaveProperty("pseudocode");
    expect(source.structuredContent!.current).toEqual({ term_id: 4, line: 12 });
    // with_ids: lines[] = {n, term_ids} only; the text (with the '>' marker) is sent once, in `text`.
    expect(source.structuredContent!.lines.map((l: Json) => l.n)).toEqual([11, 12, 13]);
    expect(source.structuredContent!.lines[1]).toEqual({ n: 12, term_ids: [4] });
    expect(source.structuredContent!.text).toMatch(/^12> /m);

    const done = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "done" });
    expect(done.structuredContent!.status).toBe("done");
    expect(done.structuredContent!.budget.cpu_spent).toBe("368806");
    const position = await client.callTool<Json>("debug_inspect", { dbg_id: dbg, what: "position" });
    expect(position.structuredContent!.position.machine_state).toBe("Done");

    const traces = await client.readResource(`cardano-debug://session/${dbg}/traces.txt`);
    expect(traces.contents[0]!.text).toBe("hello");
    const uplc = await client.readResource(`cardano-debug://session/${dbg}/uplc.txt`);
    expect(uplc.contents[0]!.text!.split("\n").length).toBe(20);
    const state = JSON.parse((await client.readResource(`cardano-debug://session/${dbg}/state.json`)).contents[0]!.text!);
    expect(state.dbg_id).toBe(dbg);
    expect(state.machine_state.machine_state_type).toBe("Done");

    const closed = await client.callTool<Json>("debug_close", { dbg_id: dbg });
    expect(closed.structuredContent).toEqual({ closed: [dbg], remaining: 0 });
    const expired = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "done" });
    expect(expired.isError).toBe(true);
    expect(expired.structuredContent).toMatchObject({ code: "expired_handle", recreate_with: "debug_open", handle: dbg });
  });

  it("parts session from validator bytes: parity with the validator, context, profile, locate, resources", async () => {
    const opened = await client.callTool<Json>("debug_open", {
      script: spend.script_bytes,
      plutus_version: "V2",
      context: spend.script_context_bytes,
      redeemer_data: spend.redeemer_bytes,
      datum: spend.datum_bytes,
      cost_models: fixture.protocol_parameters.costModels.plutusV2,
      protocol_major: fixture.protocol_parameters.protocolVersion[0],
      ex_units: spend.provided_ex_units,
    });
    expect(opened.isError).toBeFalsy();
    const sc = opened.structuredContent!;
    expect(sc.mode).toBe("parts");
    expect(sc.script_hash).toBe(fxStr("s01.spendScript.hash"));
    expect(sc.purpose).toBe("spend");
    expect(sc.declared_ex_units).toEqual({ steps: fxStr("s01.spend.exUnits.declared.steps"), mem: fxStr("s01.spend.exUnits.declared.mem") });
    expect(sc.cost_model_source).toBe("supplied");
    expect(sc.applied).toEqual(["datum", "redeemer", "context"]);
    const dbg = sc.dbg_id as string;

    const run = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "error" });
    expect(run.structuredContent!.stopped.kind).toBe("done");
    expect(run.structuredContent!.budget).toMatchObject({
      cpu_spent: fxStr("s01.spend.exUnits.calculated.steps"),
      mem_spent: fxStr("s01.spend.exUnits.calculated.mem"),
      cpu_declared: fxStr("s01.spend.exUnits.declared.steps"),
      over_budget: false,
    });
    expect(run.structuredContent!.uplc_window_dedent).toBe(fxInt("s01.debug.spend.windowDedent"));
    expect(run.structuredContent!.parity).toBeUndefined(); // no validator result attached in parts mode

    const ctx = await client.callTool<Json>("debug_inspect", { dbg_id: dbg, what: "context", path: "tx_info.V2.outputs.0", depth: 2 });
    expect(ctx.structuredContent!.value.address).toBe(fxStr("s01.out0.address"));
    // a miss has tx_redeemer(part='context')'s semantics: path_not_found with resolved / available
    const miss = await client.callTool<Json>("debug_inspect", { dbg_id: dbg, what: "context", path: "tx_info.nope" });
    expect(miss.isError).toBe(true);
    expect(miss.structuredContent).toMatchObject({ code: "path_not_found", argument: "path", resolved: "tx_info.V2" });
    expect(miss.structuredContent!.available).toEqual(expect.arrayContaining(["inputs", "outputs"]));
    // the script spends less cpu than the declared ex-units: a stop target inside the run, not the declared budget
    const budgetStop = fxStr("s01.debug.spend.budgetStopCpu");
    const budget = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "budget", cpu: budgetStop, restart: true });
    expect(budget.structuredContent!.stopped.kind).toBe("budget");
    expect(BigInt(budget.structuredContent!.budget.cpu_spent) >= BigInt(budgetStop)).toBe(true);

    const profile = await client.callTool<Json>("debug_profile", { dbg_id: dbg, top: 3, include_traces: 5 });
    expect(profile.structuredContent!.outcome).toBe("done");
    expect(profile.structuredContent!.totals.cpu).toBe(fxStr("s01.spend.exUnits.calculated.steps"));
    expect(profile.structuredContent!.hot_terms.length).toBe(3);
    expect(profile.structuredContent!.hot_terms[0].excerpt).toBeTruthy();
    // the hottest terms by self cpu are the ones the manifest recorded for the S1 spend script
    const hot = fx<Array<{ termId: number; uplcLine: number; kind: string; selfCpu: string }>>("s01.debug.spend.profile.hotTerms");
    expect(profile.structuredContent!.hot_terms.slice(0, 3).map((t: Json) => [t.term_id, t.uplc_line, t.kind, t.self_cpu])).toEqual(hot.slice(0, 3).map((t) => [t.termId, t.uplcLine, t.kind, t.selfCpu]));
    expect(profile.structuredContent!.resources.map((r: Json) => r.uri)).toContain(`cardano-debug://session/${dbg}/profile.json`);
    const report = JSON.parse((await client.readResource(`cardano-debug://session/${dbg}/profile.json`)).contents[0]!.text!);
    expect(report.totals.cpuSpent).toBe(Number(fxBig("s01.spend.exUnits.calculated.steps")));
    // The session did not move.
    const pos = await client.callTool<Json>("debug_inspect", { dbg_id: dbg, what: "position" });
    expect(pos.structuredContent!.steps_total).toBe(budget.structuredContent!.steps_total);

    const located = await client.callTool<Json>("script_locate", { dbg_id: dbg, term_id: pos.structuredContent!.position.last_term_id ?? pos.structuredContent!.position.term_id });
    expect(located.isError).toBeFalsy();
    expect(located.structuredContent!.uplc.line).toBeGreaterThan(0);
    expect(located.structuredContent).not.toHaveProperty("mapping");
    expect(located.structuredContent).not.toHaveProperty("pseudocode");
    // pseudo_line is not a coordinate any more: it is an unknown parameter (strict inputs: plain text, no structuredContent).
    const pseudo = await client.callTool<Json>("script_locate", { dbg_id: dbg, pseudo_line: 3 });
    expect(pseudo.isError).toBe(true);
    expect(pseudo.content[0]!.text).toMatch(/unknown parameter 'pseudo_line' for script_locate; valid parameters: dbg_id, script/);

    const closed = await client.callTool<Json>("debug_close", { dbg_id: "all" });
    expect(closed.structuredContent!.closed).toEqual([dbg]);
  });

  it("an error run carries a `rewind` block: explicit (error) term -> until='term'; failing builtin -> steps_total-1 (term_id null)", async () => {
    const explicit = await client.callTool<Json>("debug_open", { script: '(program 1.0.0 [(lam fee (force [[[(force (builtin ifThenElse)) [[(builtin lessThanInteger) fee] (con integer 2000000)]] (delay (error))] (delay (con unit ()))])) (con integer 1900000)])', plutus_version: "V2" });
    const e1 = await client.callTool<Json>("debug_run", { dbg_id: explicit.structuredContent!.dbg_id, until: "error" });
    expect(e1.structuredContent!.stopped.kind).toBe("error");
    expect(e1.structuredContent!.position).toMatchObject({ kind: "Error", machine_state: "Error" });
    const errTerm = e1.structuredContent!.position.term_id as number;
    expect(e1.structuredContent!.rewind).toMatchObject({ failing_term: { until: "term", term_id: errTerm, restart: true }, one_step_before: { until: "steps", steps: e1.structuredContent!.steps_total - 1, restart: true } });
    expect(e1.structuredContent!.rewind.note).toMatch(/explicit \(error\)/);
    const back = await client.callTool<Json>("debug_run", { dbg_id: explicit.structuredContent!.dbg_id, ...e1.structuredContent!.rewind.failing_term });
    expect(back.structuredContent!.position).toMatchObject({ term_id: errTerm, machine_state: "Compute" });
    const env = await client.callTool<Json>("debug_inspect", { dbg_id: explicit.structuredContent!.dbg_id, what: "env" });
    expect(env.structuredContent!.items).toEqual([expect.objectContaining({ name: "fee", summary: "1900000" })]);

    const builtin = await client.callTool<Json>("debug_open", { script: "(program 1.0.0 [(lam f [[(builtin addInteger) [f (con integer 5)]] [f (con integer 0)]]) (lam y [[(builtin divideInteger) (con integer 10)] y])])", plutus_version: "V2" });
    const dbg = builtin.structuredContent!.dbg_id as string;
    const e2 = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "error" });
    expect(e2.structuredContent!.error_message).toMatch(/divide By Zero/);
    expect(e2.structuredContent!.position.term_id).toBeNull();
    expect(e2.structuredContent!.frames_total).toBe(0);
    expect(e2.structuredContent!.rewind.failing_term).toBeUndefined();
    expect(e2.structuredContent!.rewind.note).toMatch(/builtin failed/);
    const noEnv = await client.callTool<Json>("debug_inspect", { dbg_id: dbg, what: "env" });
    expect(noEnv.structuredContent!.total).toBe(0);
    expect(noEnv.structuredContent!.note).toContain(`steps=${e2.structuredContent!.steps_total - 1}, restart=true`);
    const before = await client.callTool<Json>("debug_run", { dbg_id: dbg, ...e2.structuredContent!.rewind.one_step_before });
    expect(before.structuredContent!.stopped.kind).toBe("steps");
    expect(before.structuredContent!.position.machine_state).toBe("Return");
    expect(before.structuredContent!.frames[0]).toMatchObject({ kind: "FrameAwaitArg", detail: expect.stringMatching(/builtin divideInteger \(1\/2 args/) });
    const value = await client.callTool<Json>("debug_inspect", { dbg_id: dbg, what: "value", path: "state.value" });
    expect(value.structuredContent!.value).toEqual({ constant: { type: "Integer", value: "0" }, value_type: "Con" });
    await client.callTool<Json>("debug_close", { dbg_id: "all" });
  });

  it("a machine error (non-function applied, non-delay forced) is not called a builtin failure in `rewind`", async () => {
    for (const [script, frame] of [
      ["(program 1.0.0 [(lam x [x (con integer 2)]) (con integer 1)])", /FrameAwait/],
      ["(program 1.0.0 [(lam x (force x)) (con integer 1)])", /FrameForce/],
    ] as const) {
      const opened = await client.callTool<Json>("debug_open", { script, plutus_version: "V2" });
      const dbg = opened.structuredContent!.dbg_id as string;
      const run = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "error" });
      expect(run.structuredContent!.position.term_id).toBeNull();
      const rewind = run.structuredContent!.rewind as Json;
      expect(rewind.failure).toBe("machine_error");
      expect(rewind.note).toMatch(/machine error, not a builtin failure/);
      expect(rewind.note).not.toMatch(/a builtin failed/);
      expect(rewind).not.toHaveProperty("at_builtin");
      const before = await client.callTool<Json>("debug_run", { dbg_id: dbg, ...rewind.one_step_before });
      expect(before.structuredContent!.position.machine_state).toBe("Return");
      expect(JSON.stringify(before.structuredContent!.frames)).toMatch(frame);
    }
    const builtin = await client.callTool<Json>("debug_open", { script: "(program 1.0.0 [[(builtin divideInteger) (con integer 10)] (con integer 0)])", plutus_version: "V2" });
    const failed = await client.callTool<Json>("debug_run", { dbg_id: builtin.structuredContent!.dbg_id, until: "error" });
    expect(failed.structuredContent!.rewind.failure).toBe("builtin");
    await client.callTool<Json>("debug_close", { dbg_id: "all" });
  });

  it("a missing force is a machine error that names its builtin; until='builtin' stops on it", async () => {
    for (const [script, name, line] of [
      ["(program 1.0.0 [(builtin headList) (con (list integer) [])])", "headList", 2],
      ["(program 1.0.0 [(force (builtin fstPair)) (con (pair integer integer) (1, 2))])", "fstPair", 3],
    ] as const) {
      const opened = await client.callTool<Json>("debug_open", { script, plutus_version: "V2" });
      const dbg = opened.structuredContent!.dbg_id as string;
      const run = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "error" });
      expect(run.structuredContent!.error_message).toMatch(/builtin received a term argument/);
      const rewind = run.structuredContent!.rewind as Json;
      expect(rewind).toMatchObject({ failure: "machine_error", builtin: name, at_builtin: { until: "builtin", builtin: name, restart: true } });
      expect(rewind.note).not.toMatch(/No builtin|does not apply/);
      expect(rewind.note).toMatch(new RegExp(`${name} was applied to an argument before all its forces`));
      const at = await client.callTool<Json>("debug_run", { dbg_id: dbg, ...rewind.at_builtin });
      expect(at.structuredContent!.stopped.kind).toBe("builtin");
      expect(at.structuredContent!.position).toMatchObject({ kind: "Builtin", label: name, uplc_line: line, machine_state: "Compute" });
    }
    await client.callTool<Json>("debug_close", { dbg_id: "all" });
  });

  it("breakpoints on a line where no term starts are refused with the nearest term; until='builtin' names are checked", async () => {
    const opened = await client.callTool<Json>("debug_open", { script: "(program 1.0.0 [(lam x [(builtin addInteger) x (con integer 1)]) (con integer 41)])", plutus_version: "V2" });
    const dbg = opened.structuredContent!.dbg_id as string;
    // line 7 is the `]` closing [(builtin addInteger) x]
    const termless = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "done", breakpoints: { uplc_lines: [7] } });
    expect(termless.isError).toBe(true);
    expect(termless.structuredContent).toMatchObject({ code: "invalid_argument", argument: "breakpoints" });
    expect(termless.structuredContent!.message).toMatch(/no term starts there/);
    expect((termless.structuredContent!.termless_lines as Json[])[0]).toMatchObject({ uplc_line: 7 });
    expect(typeof (termless.structuredContent!.termless_lines as Json[])[0]!.nearest_line).toBe("number");
    const valid = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "done", breakpoints: { uplc_lines: [5] } });
    expect(valid.structuredContent!.stopped.kind).toBe("breakpoint");

    const snake = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "builtin", builtin: "add_integer", restart: true, clear_breakpoints: true });
    expect(snake.isError, JSON.stringify(snake.structuredContent)).toBeFalsy();
    expect(snake.structuredContent!.stopped.kind).toBe("builtin");
    const typo = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "builtin", builtin: "addIntegr", restart: true });
    expect(typo.isError).toBe(true);
    expect(typo.structuredContent).toMatchObject({ code: "invalid_argument", argument: "builtin" });
    expect(typo.structuredContent!.message).toMatch(/did you mean addInteger/);
    const unused = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "builtin", builtin: "unConstrData", restart: true });
    expect(unused.isError).toBe(true);
    expect(unused.structuredContent!.message).toMatch(/never occurs in this script.*addInteger/);
    await client.callTool<Json>("debug_close", { dbg_id: "all" });
  });

  it("script_locate on a bare script, argument errors", async () => {
    const located = await client.callTool<Json>("script_locate", { script: "(program 1.0.0 [(lam x x) (con integer 42)])", uplc_line: 2 });
    expect(located.isError).toBeFalsy();
    expect(located.structuredContent).toMatchObject({ term_id: 1, term_kind: "Lambda", label: "x", term_count: 4 });
    expect(located.structuredContent).not.toHaveProperty("mapping");
    const both = await client.callTool<Json>("script_locate", { script: "(program 1.0.0 (con integer 1))", term_id: 0, uplc_line: 1 });
    expect(both.isError).toBe(true);
    expect(both.structuredContent!.code).toBe("invalid_argument");
    const bad = await client.callTool<Json>("debug_open", { script: "(program 1.0.0 (con integer", plutus_version: "V2" });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent!.code).toBe("invalid_argument");
    const noArgs = await client.callTool<Json>("debug_open", {});
    expect(noArgs.isError).toBe(true);
    expect(noArgs.structuredContent!.code).toBe("invalid_argument");
    const badHex = await client.callTool<Json>("debug_open", { script: "zz", plutus_version: "V2", context: "00" });
    expect(badHex.isError).toBe(true);
    expect(badHex.structuredContent!.code).toBe("invalid_argument");
  });

  it("a long run is chunked, honours timeout_ms, reports busy to concurrent commands and leaves the session intact", async () => {
    const opened = await client.callTool<Json>("debug_open", { script: OMEGA, plutus_version: "V2" });
    const dbg = opened.structuredContent!.dbg_id as string;
    const runPromise = client.callTool<Json>("debug_run", { dbg_id: dbg, until: "done", timeout_ms: 2_500, max_steps: 50_000_000 }, 20_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const busy = await client.callTool<Json>("debug_inspect", { dbg_id: dbg, what: "budget" });
    expect(busy.isError).toBe(true);
    expect(busy.structuredContent!.code).toBe("busy");
    const run = await runPromise;
    expect(run.isError).toBeFalsy();
    expect(run.structuredContent!.stopped.kind).toBe("limit");
    expect(run.structuredContent!.stopped.detail).toMatch(/wall-clock/);
    expect(run.structuredContent!.chunks).toBeGreaterThanOrEqual(2);
    expect(run.structuredContent!.steps_total).toBeGreaterThan(10_000);
    const capped = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "done", max_steps: 1000 });
    expect(capped.structuredContent!.stopped.detail).toMatch(/max_steps/);
    expect(capped.structuredContent!.steps_this_call).toBe(1000);
    const after = await client.callTool<Json>("debug_inspect", { dbg_id: dbg, what: "budget" });
    expect(after.isError).toBeFalsy();
    expect(after.structuredContent!.machine_state).toMatch(/Compute|Return/);
    await client.callTool<Json>("debug_close", { dbg_id: dbg });
  });

  it("a trace further than one chunk from the start is pinned by a replay that the chunk loop drives to completion", async () => {
    // ~4.3M transitions: the coarse scan and the replay each outlast the 2 s chunk, so the pin is
    // cut at least once and continued by the next chunk instead of restarting from zero.
    const opened = await client.callTool<Json>("debug_open", { script: loopProgram(100_000), plutus_version: "V2" });
    const dbg = opened.structuredContent!.dbg_id as string;
    const run = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "trace", contains: "end", timeout_ms: 30_000, max_steps: 50_000_000 }, 60_000);
    expect(run.isError).toBeFalsy();
    const sc = run.structuredContent!;
    expect(sc.stopped.kind).toBe("trace");
    expect(sc.traces).toMatchObject({ total: 1, new: ["end"] });
    expect(sc.chunks).toBeGreaterThanOrEqual(2);
    expect(sc.pinning).toBeUndefined();
    expect(sc.note).toMatch(/replaying the machine from the start/);
    expect(sc.steps_total).toBeGreaterThan(4_000_000);
    // Replayed transitions are counted as work, the position is the machine's real one.
    expect(sc.steps_this_call).toBeGreaterThan(sc.steps_total);
    // The machine really is one step past the trace: stepping on finishes at once.
    const done = await client.callTool<Json>("debug_run", { dbg_id: dbg, until: "done" });
    expect(done.structuredContent!.stopped.kind).toBe("done");
    expect(done.structuredContent!.steps_this_call).toBeLessThan(10);
    await client.callTool<Json>("debug_close", { dbg_id: dbg });
  }, 90_000);
});

// tx mode: tx_load (de-uplc DebuggerContext bundle of the artificial S1 transaction, offline) -> debug_open(tx_id, redeemer)
// validates on demand through the chain layer and steps the exact bytes the validator applied.
const SAMPLE_BUNDLE = fixturePath(fxStr("s01.contextFile"));
describe("tx-mode debug session from an offline bundle", () => {
  let client: StdioClient;
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "cdm-e2e-debug-tx-"));

  beforeAll(async () => {
    client = StdioClient.dist(process.execPath, { CARDANO_DEBUG_OFFLINE: "1", CARDANO_DEBUG_CACHE_DIR: cacheDir });
    await client.initialize();
  });

  afterAll(async () => {
    await client.close();
  });

  it("debug_open(tx_id, redeemer) reproduces the validator's ex-units (parity) for both redeemers", async () => {
    const { tools } = await client.request<{ tools: Array<{ name: string }> }>("tools/list");
    if (!tools.some((t) => t.name === "tx_load") || !tools.some((t) => t.name === "tx_validate")) return; // chain layer absent from this build
    const loaded = await client.callTool<Json>("tx_load", { bundle: readFileSync(SAMPLE_BUNDLE, "utf8"), network: "mainnet" }, 60_000);
    expect(loaded.isError, JSON.stringify(loaded.structuredContent)).toBeFalsy();
    const txId = loaded.structuredContent!.tx_id as string;
    expect(txId).toBe(fxStr("s01.txId"));

    const spendRef = fxStr("s01.spend.ref");
    const mintRef = fxStr("s01.mint.ref");
    const spendCalculated = { steps: fxStr("s01.spend.exUnits.calculated.steps"), mem: fxStr("s01.spend.exUnits.calculated.mem") };
    const opened = await client.callTool<Json>("debug_open", { tx_id: txId, redeemer: spendRef }, 60_000);
    expect(opened.isError, JSON.stringify(opened.structuredContent)).toBeFalsy();
    const sc = opened.structuredContent!;
    expect(sc.mode).toBe("tx");
    expect(sc.tx_id).toBe(txId);
    expect(sc.redeemer).toBe(spendRef);
    expect(sc.cost_model_source).toBe("protocol_params");
    expect(sc.protocol_major).toBe(fxInt("s01.protocolMajor"));
    expect(sc.script_hash).toBe(fxStr("s01.spendScript.hash"));
    expect(sc.applied).toEqual(["datum", "redeemer", "context"]);
    expect(sc.validator_calculated_ex_units).toEqual(spendCalculated);

    const run = await client.callTool<Json>("debug_run", { dbg_id: sc.dbg_id, until: "error" });
    expect(run.structuredContent!.status).toBe("done");
    expect(run.structuredContent!.parity).toEqual({ validator_calculated: spendCalculated, stepper_spent: { cpu: spendCalculated.steps, mem: spendCalculated.mem }, match: true });

    const mint = await client.callTool<Json>("debug_open", { tx_id: txId, redeemer: `Minting #${fxInt("s01.mint.index")}` });
    expect(mint.structuredContent!.redeemer).toBe(mintRef);
    expect(mint.structuredContent!.applied).toEqual(["redeemer", "context"]);
    const mintRun = await client.callTool<Json>("debug_run", { dbg_id: mint.structuredContent!.dbg_id, until: "done" });
    expect(mintRun.structuredContent!.parity.match).toBe(true);
    expect(mintRun.structuredContent!.budget.cpu_spent).toBe(fxStr("s01.mint.exUnits.calculated.steps"));

    const unknown = await client.callTool<Json>("debug_open", { tx_id: txId, redeemer: "spend:7" });
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent!.code).toBe("invalid_argument");
    const gone = await client.callTool<Json>("debug_open", { tx_id: "tx_mainnet_000000000000", redeemer: "spend:0" });
    expect(gone.structuredContent).toMatchObject({ code: "expired_handle", recreate_with: "tx_load" });
    await client.callTool<Json>("debug_close", { dbg_id: "all" });
  });
});
