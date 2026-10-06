// EngineSession over a real engine instance loaded in-process (initSync from the wasm bytes).
import * as engine from "@cardananium/de-uplc-engine-wasm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { partsFromEval } from "../../../src/engine/parts.js";
import type { RunReport, RunSpec } from "../../../src/engine/protocol.js";
import { BATCH_STEPS, EngineInputError, EnginePathError, EngineSession, NoContextError } from "../../../src/engine/session-core.js";
import type { EvalRedeemerResultWire } from "../../../src/lib.js";
import { readWasm } from "../../../src/wasm-assets.js";
import { fx, fxBig, fxInt, fxStr, readFixtureJson } from "../../helpers/fixtures.js";

const TRACE_PROGRAM = '(program 1.0.0 [[(force (builtin trace)) (con string "hello")] [(lam x [(builtin addInteger) x (con integer 1)]) (con integer 41)]])';
const ERROR_PROGRAM = "(program 1.0.0 [(lam x (error)) (con integer 1)])";
/** `f 5 + f 0` with `f y = 10 / y`: the failing builtin's last argument (Var y) is visited twice; the failure is the second visit. */
const BUILTIN_ERROR_PROGRAM = "(program 1.0.0 [(lam f [[(builtin addInteger) [f (con integer 5)]] [f (con integer 0)]]) (lam y [[(builtin divideInteger) (con integer 10)] y])])";
const IDENTITY_PROGRAM = "(program 1.1.0 [(lam x x) (con integer 42)])";

interface Fixture {
  protocol_parameters: { protocolVersion: [number, number]; costModels: { plutusV2: number[] } };
  eval_redeemer_results: EvalRedeemerResultWire[];
}
// The raw validator result of the artificial S1 transaction; the numbers the debugger reports on it are the manifest's s01.debug.spend.*.
const fixture = readFixtureJson<Fixture>(fxStr("s01.evalFile"));

function spec(over: Partial<RunSpec> & Pick<RunSpec, "until">): RunSpec {
  return {
    max_steps: 1_000_000,
    deadline_at: Date.now() + 30_000,
    breakpoints: { term_ids: [], uplc_lines: [] },
    skip_first: false,
    context_lines: 3,
    frames: 6,
    max_new_traces: 10,
    ...over,
  };
}

const open: EngineSession[] = [];
function program(source = TRACE_PROGRAM, language: "V1" | "V2" | "V3" = "V2"): EngineSession {
  const s = EngineSession.openProgram(engine, source, language);
  open.push(s);
  return s;
}

beforeAll(() => {
  engine.initSync({ module: readWasm("de_uplc_bg.wasm") });
});

afterEach(() => {
  for (const s of open.splice(0)) s.free();
});

describe("EngineSession (program mode)", () => {
  it("opens a program: summary, normalised ids, start position", () => {
    const s = program();
    const summary = s.summary(2);
    expect(summary.language).toBe("V2");
    expect(summary.script_hash).toBeNull();
    expect(summary.term_count).toBe(13);
    expect(summary.uplc_lines).toBe(20);
    expect(summary.declared_ex_units).toBeNull();
    expect(summary.has_script_context).toBe(false);
    expect(summary.position).toMatchObject({ term_id: 12, kind: "Apply", uplc_line: 1, machine_state: "Compute" });
    expect(summary.uplc_window.text.split("\n")[0]).toBe("1> [");
    expect(s.version).toBe("0");
    expect(s.script.base).toBeGreaterThan(0);
  });

  it("runs to done and reports the budget, new traces and the final position", () => {
    const s = program();
    const r = s.run(spec({ until: "done" }));
    expect(r.stopped.kind).toBe("done");
    expect(r.status).toBe("done");
    expect(r.steps_this_call).toBe(r.steps_total);
    expect(r.steps_total).toBeGreaterThan(20);
    expect(r.traces).toEqual({ total: 1, new: ["hello"], new_total: 1 });
    expect(r.budget.cpu_spent).toBe("368806");
    expect(r.budget.mem_spent).toBe("1434");
    expect(r.budget.over_budget).toBe(false);
    expect(r.position.machine_state).toBe("Done");
    expect(r.position.term_id).not.toBeNull();
    // A second run after completion does not move.
    const again = s.run(spec({ until: "done" }));
    expect(again.stopped.kind).toBe("done");
    expect(again.steps_this_call).toBe(0);
    expect(again.traces.new).toEqual([]);
  });

  it("stops on 'steps', 'term', 'uplc_line' and 'builtin' before the matching term executes", () => {
    const s = program();
    const three = s.run(spec({ until: "steps", steps: 3 }));
    expect(three.stopped.kind).toBe("steps");
    expect(three.steps_this_call).toBe(3);
    expect(three.position).toMatchObject({ term_id: 0, kind: "Builtin", label: "trace", uplc_line: 4 });

    const builtin = s.run(spec({ until: "builtin", builtin: "AddInteger" }));
    expect(builtin.stopped.kind).toBe("builtin");
    expect(builtin.position).toMatchObject({ term_id: 4, kind: "Builtin", label: "addInteger", uplc_line: 12, machine_state: "Compute" });
    expect(builtin.frames.length).toBe(3);
    expect(builtin.frames[0]).toMatchObject({ index: 0, kind: "FrameAwaitFunTerm", term_id: 5, uplc_line: 13, env_size: 1 });
    expect(builtin.frames[2]?.detail).toMatch(/builtin trace/);
    const stepsAtBuiltin = builtin.steps_total;

    s.reset();
    expect(s.stepsTotal).toBe(0);
    const term = s.run(spec({ until: "term", term_id: 4 }));
    expect(term.stopped.kind).toBe("term");
    expect(term.steps_total).toBe(stepsAtBuiltin);

    s.reset();
    const line = s.run(spec({ until: "uplc_line", line: 12 }));
    expect(line.stopped.kind).toBe("uplc_line");
    expect(line.position.uplc_line).toBe(12);
    expect(line.steps_total).toBe(stepsAtBuiltin);

    s.reset();
    const bracket = s.run(spec({ until: "uplc_line", line: 14 }));
    expect(bracket.stopped.kind).toBe("uplc_line");
    expect(bracket.stopped.detail).toMatch(/nearest term/);

    expect(() => s.run(spec({ until: "term", term_id: 99 }))).toThrow(EngineInputError);
    expect(() => s.run(spec({ until: "uplc_line", line: 999 }))).toThrow(/outside/);
  });

  it("breakpoints use gdb semantics: pause before the term, resume steps off it", () => {
    const s = program();
    const bp = { term_ids: [4], uplc_lines: [] };
    const first = s.run(spec({ until: "done", breakpoints: bp }));
    expect(first.stopped.kind).toBe("breakpoint");
    expect(first.stopped.detail).toMatch(/term 4/);
    expect(first.position.term_id).toBe(4);
    const paused = first.steps_total;
    // Without skip_first the same term re-triggers at once.
    const again = s.run(spec({ until: "done", breakpoints: bp }));
    expect(again.stopped.kind).toBe("breakpoint");
    expect(again.steps_this_call).toBe(0);
    // A resume steps off it.
    const resumed = s.run(spec({ until: "done", breakpoints: bp, skip_first: true }));
    expect(resumed.stopped.kind).toBe("done");
    expect(resumed.steps_total).toBeGreaterThan(paused);
    // Line breakpoints expand to the terms starting on the line.
    s.reset();
    const byLine = s.run(spec({ until: "done", breakpoints: { term_ids: [], uplc_lines: [12] } }));
    expect(byLine.stopped.kind).toBe("breakpoint");
    expect(byLine.stopped.detail).toMatch(/line 12/);
    expect(byLine.steps_total).toBe(paused);
  });

  it("stops exactly at the step that emitted a trace (coarse scan + replay)", () => {
    const s = program();
    const r = s.run(spec({ until: "trace" }));
    expect(r.stopped.kind).toBe("trace");
    expect(r.traces.new).toEqual(["hello"]);
    expect(r.replayed).toBe(true);
    const at = r.steps_total;
    // Reference: a fresh machine has no trace after `at - 1` steps and exactly one after `at`.
    const ref = program();
    const before = ref.run(spec({ until: "steps", steps: at - 1 }));
    expect(before.traces.total).toBe(0);
    const after = ref.run(spec({ until: "steps", steps: 1 }));
    expect(after.traces.total).toBe(1);
    // `contains` filters; no further trace -> the run ends.
    const none = s.run(spec({ until: "trace", contains: "nope" }));
    expect(none.stopped.kind).toBe("done");
  });

  it("stops exactly when the cpu budget crosses the target", () => {
    const s = program();
    const target = 200_000;
    const r = s.run(spec({ until: "budget", cpu: target }));
    expect(r.stopped.kind).toBe("budget");
    expect(BigInt(r.budget.cpu_spent) >= BigInt(target)).toBe(true);
    const ref = program();
    const before = ref.run(spec({ until: "steps", steps: r.steps_total - 1 }));
    expect(BigInt(before.budget.cpu_spent) < BigInt(target)).toBe(true);
    // Already past the target: answers at once.
    const past = s.run(spec({ until: "budget", cpu: 1 }));
    expect(past.stopped.kind).toBe("budget");
    expect(past.steps_this_call).toBe(0);
  });

  it("honours max_steps and the stop flag without losing the session", () => {
    const s = program();
    const limited = s.run(spec({ until: "done", max_steps: 5 }));
    expect(limited.stopped).toMatchObject({ kind: "limit", reason: "max_steps" });
    expect(limited.steps_this_call).toBe(5);
    expect(limited.status).toBe("ready");
    const cancelled = s.run(spec({ until: "done" }), () => true);
    // The flag is polled every 512 steps; this program finishes before that.
    expect(["cancelled", "done"]).toContain(cancelled.stopped.kind);
    const done = s.run(spec({ until: "done" }));
    expect(done.status).toBe("done");
  });

  it("lands on the failing Error term and reports the message", () => {
    const s = program(ERROR_PROGRAM);
    const r = s.run(spec({ until: "error" }));
    expect(r.stopped.kind).toBe("error");
    expect(r.status).toBe("error");
    expect(r.error_message).toMatch(/crashed|exited|error/i);
    expect(r.position).toMatchObject({ term_id: 0, kind: "Error", machine_state: "Error", uplc_line: 3 });
    // no env in Error state; the note names the rewind (steps_total - 1)
    const env = s.env(0, 20);
    expect(env.total).toBe(0);
    expect(env.note).toContain(`steps=${r.steps_total - 1}, restart=true`);
    const done = program(ERROR_PROGRAM).run(spec({ until: "done" }));
    expect(done.stopped.kind).toBe("error");
  });

  it("a builtin failure has no term of its own: term_id null, last_term_id = the last computed term; steps_total-1 is the Return state with the argument in hand", () => {
    const s = program(BUILTIN_ERROR_PROGRAM);
    const r = s.run(spec({ until: "error" }));
    expect(r.stopped.kind).toBe("error");
    expect(r.error_message).toMatch(/divide By Zero/);
    expect(r.position.term_id).toBeNull();
    expect(r.position.machine_state).toBe("Error");
    expect(r.position.last_term_id).not.toBeNull();
    expect(s.frames()).toEqual([]);
    const before = s.run(spec({ until: "steps", steps: r.steps_total - 1 }));
    expect(before.stopped.kind).toBe("error"); // finished machine: must restart first
    s.reset();
    const rewound = s.run(spec({ until: "steps", steps: r.steps_total - 1 }));
    expect(rewound.stopped.kind).toBe("steps");
    expect(rewound.position.machine_state).toBe("Return");
    expect(rewound.frames[0]).toMatchObject({ kind: "FrameAwaitArg", detail: expect.stringMatching(/builtin divideInteger \(1\/2 args/) });
    expect(s.value("state.value", 2, 4000).value).toEqual({ constant: { type: "Integer", value: "0" }, value_type: "Con" });
    expect(s.run(spec({ until: "steps", steps: 1 })).stopped.kind).toBe("error");
  });

  it("reports Done (not a phantom Compute) once the final value is in hand, and no stop condition matches there", () => {
    // (program 1.1.0 [(lam x x) (con integer 42)]): 8 transitions; after the 7th the machine holds Done(42) with status still ready
    const s = program(IDENTITY_PROGRAM, "V3");
    const seven = s.run(spec({ until: "steps", steps: 7 }));
    expect(seven.stopped.kind).toBe("steps");
    expect(seven.status).toBe("ready");
    expect(seven.position).toMatchObject({ term_id: 0, kind: "Var", machine_state: "Done" });
    expect(s.env(0, 20).note).toMatch(/Done state/);
    const last = s.run(spec({ until: "steps", steps: 1 }));
    expect(last.stopped.kind).toBe("done");
    expect(last.steps_total).toBe(8);
    // until='term' on the last computed term stops at its real visit (step 5), then finishes instead of re-matching the held value
    s.reset();
    const visit = s.run(spec({ until: "term", term_id: 0 }));
    expect(visit).toMatchObject({ stopped: { kind: "term" }, steps_total: 5 });
    expect(visit.position.machine_state).toBe("Compute");
    const rest = s.run(spec({ until: "term", term_id: 0, skip_first: true }));
    expect(rest.stopped.kind).toBe("done");
    expect(rest.steps_total).toBe(8);
  });

  it("names environment values from the enclosing lambda chain and expands values by ref", () => {
    const s = program();
    s.run(spec({ until: "builtin", builtin: "addInteger" }));
    const env = s.env(0, 20);
    expect(env.total).toBe(1);
    expect(env.items[0]).toMatchObject({ index: 0, name: "x", debruijn: 1, type: "Con:Integer", summary: "41", ref: "env.values.0", binder_term_id: 9, binder_uplc_line: 9 });
    const value = s.value("env.values.0", 2, 4000);
    expect(value.type).toBe("Con:Integer");
    expect(value.value).toEqual({ constant: { type: "Integer", value: "41" }, value_type: "Con" });
    expect(() => s.value("nowhere.0", 2, 4000)).toThrow(EngineInputError);
    expect(() => s.value("env.values.9", 2, 4000)).toThrow(EngineInputError);
    const term = s.inspect("term", { depth: 2, offset: 0, limit: 20, context_lines: 2, max_chars: 4000 });
    expect(term).toMatchObject({ term_id: 4, kind: "Builtin", uplc_text: "(builtin addInteger)" });
    const frames = s.inspect("frames", { depth: 2, offset: 1, limit: 1, context_lines: 2, max_chars: 4000 });
    expect(frames.total).toBe(3);
    expect((frames.items as unknown[]).length).toBe(1);
    expect(frames.next_offset).toBe(2);
    expect(() => s.scriptContext()).toThrow(NoContextError);
    expect(s.inspect("budget", { depth: 2, offset: 0, limit: 20, context_lines: 2, max_chars: 4000 })).toMatchObject({ over_budget: false, machine_state: "Compute" });
  });

  it("renders source windows and locates terms / lines", () => {
    const s = program();
    s.run(spec({ until: "builtin", builtin: "addInteger" }));
    const w = s.sourceWindow({ around: "current", radius: 1, with_ids: true, max_chars: 4000, breakpoints: { term_ids: [0], uplc_lines: [13] } });
    expect(w.window).toEqual({ line_from: 11, line_to: 13, dedent: 8 });
    expect(w.current).toEqual({ term_id: 4, line: 12 });
    expect(w.lines.map((l) => l.marker)).toEqual(["", ">", "*"]);
    expect(w.lines[1]?.term_ids).toEqual([4]);
    const byTerm = s.sourceWindow({ around: 0, radius: 0, with_ids: false, max_chars: 4000, breakpoints: { term_ids: [], uplc_lines: [] } });
    expect(byTerm.window.line_from).toBe(4);
    expect(byTerm.lines[0]?.marker).toBe("");
    const explicit = s.sourceWindow({ line_from: 1, line_to: 2, radius: 5, with_ids: false, max_chars: 4000, breakpoints: { term_ids: [], uplc_lines: [] } });
    expect(explicit.lines.map((l) => l.n)).toEqual([1, 2]);
    expect(() => s.sourceWindow({ around: 99, radius: 1, with_ids: false, max_chars: 4000, breakpoints: { term_ids: [], uplc_lines: [] } })).toThrow(EngineInputError);

    expect(s.locate({ term_id: 4, context_lines: 1 })).toMatchObject({ term_id: 4, term_kind: "Builtin", label: "addInteger", uplc: { line: 12 } });
    const line = s.locate({ uplc_line: 12, context_lines: 0 });
    expect(line.candidates).toEqual([{ term_id: 4, kind: "Builtin", label: "addInteger" }]);
    expect(line.term_id).toBe(4);
    const bracket = s.locate({ uplc_line: 14, context_lines: 0 });
    expect(bracket.term_id).toBeUndefined();
    expect(bracket.note).toMatch(/closing bracket/);
    expect(bracket.candidates?.length).toBe(1);
    expect(() => s.locate({ term_id: 13, context_lines: 0 })).toThrow(EngineInputError);
  });

  it("profiles on a second machine without moving the session", () => {
    const s = program();
    s.run(spec({ until: "steps", steps: 3 }));
    const report = s.profile({ top: 3, by: "self_cpu", max_steps: 100_000, deadline_at: Date.now() + 10_000, include_traces: 5, chunk_steps: 1000 });
    expect(report.outcome).toBe("done");
    expect(report.totals.cpu).toBe("368806");
    expect(report.totals.over_budget).toBe(false);
    expect(report.hot_terms.length).toBe(3);
    expect(report.hot_terms[0]).toMatchObject({ term_id: 8, kind: "Apply", uplc_line: 10 });
    expect(report.hot_terms[0]?.excerpt).toMatch(/^\[ \[ \(builtin addInteger\)/);
    expect(report.builtins.map((b) => b.name).sort()).toEqual(["addInteger", "trace"]);
    // the buckets cover every builtin that ran: addInteger is arithmetic, trace is control
    expect(report.builtin_groups.map((g) => g.group).sort()).toEqual(["arith", "control"]);
    const builtinCpu = report.builtins.reduce((sum, b) => sum + BigInt(b.cpu), 0n);
    expect(report.builtins_total.cpu).toBe(builtinCpu.toString());
    expect(report.builtin_groups.reduce((sum, g) => sum + BigInt(g.cpu), 0n)).toBe(builtinCpu);
    expect(report.builtin_groups.reduce((sum, g) => sum + g.cpu_pct, 0)).toBeCloseTo(100, 1);
    expect(report.traces.items[0]).toMatchObject({ index: 0, message: "hello" });
    expect(report.step_kinds.length).toBeGreaterThan(5);
    expect(report.timeline.length).toBeGreaterThan(0);
    expect(s.profileJson()).not.toBeNull();
    // The session did not move.
    expect(s.stepsTotal).toBe(3);
    expect(s.status).toBe("ready");
    const limited = s.profile({ top: 3, by: "hits", max_steps: 5, deadline_at: Date.now() + 10_000, include_traces: 0, chunk_steps: 2 });
    expect(limited.outcome).toBe("limit");
    const failing = program(ERROR_PROGRAM).profile({ top: 3, by: "self_cpu", max_steps: 1000, deadline_at: Date.now() + 10_000, include_traces: 0, chunk_steps: 100 });
    expect(failing.outcome).toBe("error");
    expect(failing.error).toMatchObject({ term_id: 0, uplc_line: 3 });
  });
});

describe("EngineSession (parts mode from validator bytes)", () => {
  const spend = fixture.eval_redeemer_results.find((r) => r.tag === "Spend")!;

  it("reproduces the validator's calculated ex-units and exposes the ScriptContext", () => {
    const { config, meta } = partsFromEval(spend, fixture.protocol_parameters);
    const s = EngineSession.openParts(engine, config);
    open.push(s);
    const summary = s.summary(2);
    expect(summary.script_hash).toBe(fxStr("s01.spendScript.hash"));
    expect(summary.language).toBe("V2");
    expect(summary.purpose).toBe("Spending");
    expect(summary.declared_ex_units).toEqual({ cpu: fxStr("s01.spend.exUnits.declared.steps"), mem: fxStr("s01.spend.exUnits.declared.mem") });
    expect(summary.has_script_context).toBe(true);
    expect(summary.term_count).toBe(fxInt("s01.debug.spend.termCount"));
    const r = s.run(spec({ until: "error" }));
    expect(r.stopped.kind).toBe("done");
    expect(r.budget.cpu_spent).toBe(meta.calculated_ex_units!.steps);
    expect(r.budget.mem_spent).toBe(meta.calculated_ex_units!.mem);
    expect(r.budget.cpu_spent).toBe(fxStr("s01.debug.spend.cpuSpent"));
    expect(r.budget.cpu_pct).toBeCloseTo(fx<number>("s01.debug.spend.cpuPct"), 1);
    expect(r.budget.over_budget).toBe(false);
    expect(r.uplc_window.dedent).toBe(fxInt("s01.debug.spend.windowDedent"));
    expect(r.uplc_window.text).not.toMatch(/^\d+>?\s{40}/m);
    const ctx = s.inspect("context", { path: "tx_info.V2.outputs.0.address", depth: 2, offset: 0, limit: 20, context_lines: 0, max_chars: 4000 });
    expect(ctx.value).toBe(fxStr("s01.out0.address"));
    // same path grammar and integer policy as tx_redeemer(part='context'): the language key is optional, integers are strings
    const short = s.inspect("context", { path: "tx_info.outputs.0.address", depth: 2, offset: 0, limit: 20, context_lines: 0, max_chars: 4000 });
    expect(short.path).toBe("tx_info.V2.outputs.0.address");
    expect(short.value).toBe(ctx.value);
    const fee = s.inspect("context", { path: "fee", depth: 2, offset: 0, limit: 20, context_lines: 0, max_chars: 4000 });
    expect(fee.path).toBe("tx_info.V2.fee");
    expect(fee.value).toEqual({ value_type: "Coin", amount: fxBig("s01.fee").toString() });
    const purpose = s.inspect("context", { path: "purpose", depth: 1, offset: 0, limit: 20, context_lines: 0, max_chars: 4000 });
    expect(purpose.path).toBe("purpose");
    expect((purpose.value as { purpose_type: string }).purpose_type).toBe("Spending");
    // a miss is tx_redeemer(part='context')'s path_not_found, naming the keys available where the path stopped
    let missing: unknown;
    try {
      s.inspect("context", { path: "tx_info.V2.nope", depth: 2, offset: 0, limit: 20, context_lines: 0, max_chars: 4000 });
    } catch (error) {
      missing = error;
    }
    expect(missing).toBeInstanceOf(EnginePathError);
    expect((missing as EnginePathError).data).toMatchObject({ code: "path_not_found", argument: "path", resolved: "tx_info.V2" });
    expect((missing as EnginePathError).data.available).toEqual(expect.arrayContaining(["outputs"]));
    expect((missing as Error).message).toMatch(/resolved up to tx_info\.V2; available: .*outputs/);
    expect(JSON.parse(s.contextJson(1_000_000)).script_context_version).toBe(fxStr("s01.debug.spend.scriptContextVersion"));
    expect(JSON.parse(s.stateJson()).machine_state_type).toBe("Done");
    const profile = s.profile({ top: 5, by: "total_cpu", max_steps: 1_000_000, deadline_at: Date.now() + 20_000, include_traces: 10, chunk_steps: 200_000 });
    expect(profile.outcome).toBe("done");
    expect(profile.totals.cpu).toBe(fxStr("s01.spend.exUnits.calculated.steps"));
    expect(profile.totals.cpu_declared).toBe(fxStr("s01.spend.exUnits.declared.steps"));
    expect(profile.terms_executed).toBe(fxInt("s01.debug.spend.profile.termsExecuted"));
    expect(profile.hot_lines.length).toBe(fxInt("s01.debug.spend.profile.hotLines"));
    expect(profile.hot_lines[0]?.text.length).toBeGreaterThan(1);
  });

  it("aligns environment names with the lambda chain of compiled scripts", () => {
    const { config } = partsFromEval(spend, fixture.protocol_parameters);
    const s = EngineSession.openParts(engine, config);
    open.push(s);
    s.run(spec({ until: "uplc_line", line: 12 }));
    const env = s.env(0, 10);
    const expected = fx<{ line: number; total: number; items: Array<{ debruijn: number; name: string; type: string; summary: string; binderUplcLine: number }> }>("s01.debug.spend.envAtLine12");
    expect(env.total).toBe(expected.total);
    expect(env.items.map((i) => i.debruijn)).toEqual(expected.items.map((i) => i.debruijn));
    expect(env.items[0]).toMatchObject({ name: expected.items[0]!.name, type: expected.items[0]!.type, binder_uplc_line: expected.items[0]!.binderUplcLine });
    expect(env.items.map((i) => i.summary)).toEqual(expected.items.map((i) => i.summary));
  });
});

/** A self-applying loop of `n` iterations (~43 transitions each) that traces `message` at the end. */
function loopProgram(n: number, message = "end"): string {
  const body = `(lam self (lam n (force [ [ [ (force (builtin ifThenElse)) [ [ (builtin equalsInteger) n ] (con integer 0) ] ] (delay [ [ (force (builtin trace)) (con string "${message}") ] (con unit ()) ]) ] (delay [ [ self self ] [ [ (builtin subtractInteger) n ] (con integer 1) ] ]) ])))`;
  return `(program 1.0.0 [ [ (lam f [ f f ]) ${body} ] (con integer ${n}) ])`;
}

/** Drive `run` until a non-limit / non-cancelled stop; checks the step counters never silently rewind. */
function driveToStop(s: EngineSession, make: () => RunSpec, stopRequested?: () => boolean, maxCalls = 400) {
  const reports: RunReport[] = [];
  for (let i = 0; i < maxCalls; i++) {
    const r = s.run(make(), stopRequested);
    const prev = reports[reports.length - 1];
    if (prev && r.steps_total < prev.steps_total) {
      // The only allowed rewind is the pin replay, and it says so.
      expect(r.rewound_from).toBe(prev.steps_total);
      expect(r.pinning ?? r.replayed).toBeTruthy();
    }
    expect(r.steps_this_call).toBeGreaterThanOrEqual(0);
    reports.push(r);
    if (r.stopped.kind !== "limit" && r.stopped.kind !== "cancelled") break;
  }
  return reports;
}

describe("EngineSession exact-position pins (trace / budget) survive deadline and stop-flag cuts", () => {
  const N = 2000;

  it("a trace target further than one call's deadline converges and lands on the exact step", () => {
    const s = program(loopProgram(N));
    const full = s.run(spec({ until: "done", max_steps: 10_000_000 }));
    expect(full.stopped.kind).toBe("done");
    expect(full.steps_total).toBeGreaterThan(20 * BATCH_STEPS);
    s.reset();
    // 5 ms chunks: the coarse scan needs several calls and the replay is cut repeatedly.
    const reports = driveToStop(s, () => spec({ until: "trace", contains: "end", max_steps: 10_000_000, deadline_at: Date.now() + 5 }));
    const last = reports[reports.length - 1]!;
    expect(last.stopped.kind).toBe("trace");
    expect(last.replayed).toBe(true);
    expect(last.pinning).toBeUndefined();
    expect(last.traces.new).toEqual(["end"]);
    expect(s.hasPendingPin).toBe(false);
    // Deadline-cut replays were reported as pinning, with limit/deadline so a chunk loop keeps driving them.
    const pinned = reports.filter((r) => r.pinning !== undefined);
    expect(pinned.length).toBeGreaterThan(0);
    for (const r of pinned) {
      expect(r.stopped).toMatchObject({ kind: "limit", reason: "deadline" });
      expect(r.pinning!.anchor_steps).toBeLessThanOrEqual(r.pinning!.rewound_from);
      expect(r.steps_total).toBe(r.pinning!.replayed_steps);
      expect(r.steps_total).toBeLessThanOrEqual(r.pinning!.anchor_steps);
    }
    // Replayed steps never decrease across the pinning calls.
    for (let i = 1; i < pinned.length; i++) expect(pinned[i]!.steps_total).toBeGreaterThan(pinned[i - 1]!.steps_total);
    // The exact step: a fresh machine has no trace after `at - 1` steps and exactly one after `at`.
    const at = last.steps_total;
    const ref = program(loopProgram(N));
    expect(ref.run(spec({ until: "steps", steps: at - 1, max_steps: 10_000_000 })).traces.total).toBe(0);
    expect(ref.run(spec({ until: "steps", steps: 1 })).traces.total).toBe(1);
    // Work is accounted honestly: transitions executed >= the position (a replay re-executes steps).
    const work = reports.reduce((sum, r) => sum + r.steps_this_call, 0);
    expect(work).toBeGreaterThan(at);
  });

  it("a budget target keeps its pin across stop-flag cuts (cancelled) and finishes on the same condition", () => {
    const s = program(loopProgram(N));
    const target = 30_000_000n;
    let polls = 0;
    // Every third poll of the stop flag says stop: deterministic cuts in both the scan and the replay.
    const reports = driveToStop(s, () => spec({ until: "budget", cpu: target.toString(), max_steps: 10_000_000, deadline_at: Date.now() + 60_000 }), () => ++polls % 3 === 0);
    const last = reports[reports.length - 1]!;
    expect(last.stopped.kind).toBe("budget");
    expect(BigInt(last.budget.cpu_spent) >= target).toBe(true);
    const cancelledWhilePinning = reports.filter((r) => r.stopped.kind === "cancelled" && r.pinning !== undefined);
    expect(cancelledWhilePinning.length).toBeGreaterThan(0);
    expect(cancelledWhilePinning[0]!.status).toBe("cancelled");
    const ref = program(loopProgram(N));
    const before = ref.run(spec({ until: "steps", steps: last.steps_total - 1, max_steps: 10_000_000 }));
    expect(BigInt(before.budget.cpu_spent) < target).toBe(true);
  });

  it("a different stop condition abandons the pending pin from the rewound position and says so", () => {
    const s = program(loopProgram(N));
    let cut: RunReport | undefined;
    for (let i = 0; i < 400 && !cut; i++) {
      const r = s.run(spec({ until: "trace", max_steps: 10_000_000, deadline_at: Date.now() + 5 }));
      if (r.pinning) cut = r;
      expect(["limit", "trace"]).toContain(r.stopped.kind);
      if (r.stopped.kind === "trace") break;
    }
    if (!cut) return; // the machine was fast enough to never cut the replay: nothing to abandon
    expect(s.hasPendingPin).toBe(true);
    const step = s.run(spec({ until: "steps", steps: 1 }));
    expect(step.stopped.kind).toBe("steps");
    expect(step.stopped.detail).toMatch(/abandoned/);
    expect(step.steps_total).toBe(cut.steps_total + 1);
    expect(step.steps_this_call).toBe(1);
    expect(s.hasPendingPin).toBe(false);
    // restart clears a pin as well.
    const again = s.run(spec({ until: "trace", max_steps: 10_000_000, deadline_at: Date.now() + 5 }));
    if (again.pinning) {
      s.reset();
      expect(s.hasPendingPin).toBe(false);
      expect(s.stepsTotal).toBe(0);
    }
  });

  it("rejects a cpu that is not a non-negative decimal integer as invalid_argument 'cpu'", () => {
    const s = program();
    for (const bad of ["abc", "1e6", "12.5", "-1", "", " ", 1.5, -3, Number.NaN]) {
      let caught: unknown;
      try {
        s.run(spec({ until: "budget", cpu: bad }));
      } catch (error) {
        caught = error;
      }
      expect(caught, `cpu=${JSON.stringify(bad)}`).toBeInstanceOf(EngineInputError);
      expect((caught as EngineInputError).data).toEqual({ code: "invalid_argument", argument: "cpu" });
    }
    expect(s.run(spec({ until: "budget", cpu: " 200000 " })).stopped.kind).toBe("budget");
    expect(s.stepsTotal).toBeGreaterThan(0);
  });
});

describe("until='builtin' names", () => {
  it("match case- and underscore-insensitively; unknown or unused names are input errors with suggestions", () => {
    const s = EngineSession.openProgram(engine, TRACE_PROGRAM, "V2");
    try {
      const snake = s.run(spec({ until: "builtin", builtin: "add_integer" }));
      expect(snake.stopped.kind).toBe("builtin");
      expect(snake.position.label).toBe("addInteger");
      expect(() => s.run(spec({ until: "builtin", builtin: "addIntegr" }))).toThrow(/unknown builtin "addIntegr"; did you mean addInteger/);
      expect(() => s.run(spec({ until: "builtin", builtin: "unConstrData" }))).toThrow(/builtin unConstrData never occurs in this script.*uses: addInteger, trace/);
      let caught: unknown;
      try {
        s.run(spec({ until: "builtin", builtin: "noSuchBuiltin" }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(EngineInputError);
      expect((caught as EngineInputError).data).toEqual({ code: "invalid_argument", argument: "builtin" });
    } finally {
      s.free();
    }
  });
});
