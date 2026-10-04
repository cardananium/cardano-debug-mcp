// EngineSession behaviour: stack reads (when, how often, what a slow or
// trapping read does), restart validated before anything moves, term-id breakpoint markers, the
// engine's budget cap wording, stop_before / hit, and the adaptive coarse trace scan.
import * as engine from "@cardananium/de-uplc-engine-wasm";
import type { SessionController } from "@cardananium/de-uplc-engine-wasm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { RunReport, RunSpec } from "../../../src/engine/protocol.js";
import { describeEngineFailure, EngineInputError, EngineSession, type EngineApi } from "../../../src/engine/session-core.js";
import { isWasmTrap } from "../../../src/workers/rpc.js";
import { readWasm } from "../../../src/wasm-assets.js";

const TRACE_PROGRAM = '(program 1.0.0 [[(force (builtin trace)) (con string "hello")] [(lam x [(builtin addInteger) x (con integer 1)]) (con integer 41)]])';
const ERROR_PROGRAM = "(program 1.0.0 [(lam x (error)) (con integer 1)])";
const BUILTIN_ERROR_PROGRAM = "(program 1.0.0 [(lam f [[(builtin addInteger) [f (con integer 5)]] [f (con integer 0)]]) (lam y [[(builtin divideInteger) (con integer 10)] y])])";
/** Two traces: "a", then "b". */
const TWO_TRACES = '(program 1.0.0 [(lam _ [(lam _ (con unit ())) [[(force (builtin trace)) (con string "b")] (con unit ())]]) [[(force (builtin trace)) (con string "a")] (con unit ())]])';

const NEXT = "[ [ self self ] [ [ (builtin subtractInteger) n ] (con integer 1) ] ]";

/** A self-applying loop of `n` iterations: `done` runs at n == 0, `again` (a delayed term using NEXT) otherwise. */
function loopWith(n: number, done: string, again: string): string {
  const body = `(lam self (lam n (force [ [ [ (force (builtin ifThenElse)) [ [ (builtin equalsInteger) n ] (con integer 0) ] ] ${done} ] ${again} ])))`;
  return `(program 1.0.0 [ [ (lam f [ f f ]) ${body} ] (con integer ${n}) ])`;
}
const loop = (n: number) => loopWith(n, "(delay (con unit ()))", `(delay ${NEXT})`);
const loopThatFails = (n: number) => loopWith(n, "(delay (error))", `(delay ${NEXT})`);
/** Traces "t" once per iteration. */
const loopThatTraces = (n: number) => loopWith(n, "(delay (con unit ()))", `(delay [ (lam _ ${NEXT}) [ [ (force (builtin trace)) (con string "t") ] (con unit ()) ] ])`);
/** Non-tail recursion `1 + f (n - 1)`: the stack grows by about two frames per level. */
function deepRecursion(n: number): string {
  const body = `(lam self (lam n (force [ [ [ (force (builtin ifThenElse)) [ [ (builtin equalsInteger) n ] (con integer 0) ] ] (delay (con integer 0)) ] (delay [ [ (builtin addInteger) (con integer 1) ] [ [ self self ] [ [ (builtin subtractInteger) n ] (con integer 1) ] ] ]) ])))`;
  return `(program 1.0.0 [ [ (lam f [ f f ]) ${body} ] (con integer ${n}) ])`;
}

function spec(over: Partial<RunSpec> & Pick<RunSpec, "until">): RunSpec {
  return {
    max_steps: 5_000_000,
    deadline_at: Date.now() + 60_000,
    breakpoints: { term_ids: [], uplc_lines: [] },
    skip_first: false,
    context_lines: 3,
    frames: 6,
    max_new_traces: 10,
    ...over,
  };
}

type Hook = (call: () => unknown, args: unknown[]) => unknown;

/** The real engine with per-method hooks on the session controller (counting, delaying, failing). */
function hooked(hooks: Record<string, Hook>, calls: Record<string, number> = {}): EngineApi {
  const wrap = (controller: SessionController): SessionController =>
    new Proxy(controller, {
      get(target, prop) {
        const value = (target as unknown as Record<string, unknown>)[prop as string];
        if (typeof value !== "function") return value;
        const name = String(prop);
        return (...args: unknown[]) => {
          calls[name] = (calls[name] ?? 0) + 1;
          const call = () => (value as (...a: unknown[]) => unknown).apply(target, args);
          const hook = hooks[name];
          return hook ? hook(call, args) : call();
        };
      },
    });
  return {
    new_session_from_program: (source, language) => wrap(engine.new_session_from_program(source, language)),
    new_session_from_parts: (config) => wrap(engine.new_session_from_parts(config)),
  };
}

const open: EngineSession[] = [];
function program(source: string, api: EngineApi = engine, language: "V1" | "V2" | "V3" = "V2"): EngineSession {
  const s = EngineSession.openProgram(api, source, language);
  open.push(s);
  return s;
}

beforeAll(() => {
  engine.initSync({ module: readWasm("de_uplc_bg.wasm") });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const s of open.splice(0)) {
    try {
      s.free();
    } catch {
      // a poisoned stub controller
    }
  }
});

describe("frames in reports", () => {
  it("are read only when asked for: frames=0 never touches the stack, frames=6 reads it once", () => {
    const calls: Record<string, number> = {};
    const s = program(TRACE_PROGRAM, hooked({}, calls));
    const none = s.run(spec({ until: "builtin", builtin: "addInteger", frames: 0 }));
    expect(none.frames).toEqual([]);
    expect(calls.get_machine_context_lazy ?? 0).toBe(0);
    const some = s.run(spec({ until: "steps", steps: 1, frames: 6 }));
    expect(some.frames.length).toBeGreaterThan(0);
    expect(some.frames_total).toBe(some.frames.length);
    expect(calls.get_machine_context_lazy).toBe(1);
  });

  it("a finished machine keeps no stack: frames_total 0 without a read", () => {
    const calls: Record<string, number> = {};
    const s = program(ERROR_PROGRAM, hooked({}, calls));
    const r = s.run(spec({ until: "error" }));
    expect(r).toMatchObject({ frames: [], frames_total: 0 });
    const done = program(TRACE_PROGRAM, hooked({}, calls)).run(spec({ until: "done" }));
    expect(done).toMatchObject({ frames: [], frames_total: 0 });
    expect(calls.get_machine_context_lazy ?? 0).toBe(0);
  });

  it("a cut run does not read a stack that may be deep: 'unknown' plus a note; an explicit read still works and lifts the hold", () => {
    const calls: Record<string, number> = {};
    const s = program(loop(3000), hooked({}, calls));
    const cut = s.run(spec({ until: "done", max_steps: 5_000 }));
    expect(cut.stopped).toMatchObject({ kind: "limit", reason: "max_steps" });
    expect(cut.frames).toEqual([]);
    expect(cut.frames_total).toBe("unknown");
    expect(cut.frames_note).toMatch(/not read.*debug_inspect\(what='frames'\)/);
    expect(calls.get_machine_context_lazy ?? 0).toBe(0);
    // A position report right after skips it too (same unknown depth) ...
    const position = s.positionReport(2);
    expect(position.frames_total).toBe("unknown");
    expect(calls.get_machine_context_lazy ?? 0).toBe(0);
    // ... while the explicit read answers and teaches the session how deep the stack is.
    expect(s.frames().length).toBeGreaterThan(0);
    expect(calls.get_machine_context_lazy).toBe(1);
    expect(s.positionReport(2).frames_total).toEqual(expect.any(Number));
  });

  it("a short cut run (at most 1,000 steps) still carries its frames", () => {
    const s = program(loop(3000));
    const cut = s.run(spec({ until: "done", max_steps: 400 }));
    expect(cut.stopped.kind).toBe("limit");
    expect(cut.frames_total).toEqual(expect.any(Number));
  });

  it("a stack read slower than the limit stops reports from carrying frames until restart", () => {
    let clock = 5_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const s = program(
      TRACE_PROGRAM,
      hooked({
        get_machine_context_lazy: (call) => {
          clock += 600;
          return call();
        },
      }),
    );
    s.run(spec({ until: "steps", steps: 5, frames: 0, deadline_at: clock + 1e9 }));
    expect(s.frames().length).toBeGreaterThan(0); // the slow read itself answers
    const later = s.run(spec({ until: "steps", steps: 1, deadline_at: clock + 1e9 }));
    expect(later.frames).toEqual([]);
    expect(later.frames_total).toBe("unknown");
    expect(later.frames_note).toMatch(/frames not attached: reading the stack \(\d+ frames\) took 600 ms/);
    // restart clears the hold
    s.reset();
    const again = s.run(spec({ until: "steps", steps: 5, deadline_at: clock + 1e9 }));
    expect(again.frames_total).toEqual(expect.any(Number));
    expect(again.frames_note).toMatch(/later reports omit frames/); // this read was slow again
  });

  it("a wasm trap while reading the stack is rethrown (the worker is lost with its cause), not turned into 'no frames'", () => {
    const trap = new RangeError("Maximum call stack size exceeded");
    const s = program(
      TRACE_PROGRAM,
      hooked({
        get_machine_context_lazy: () => {
          throw trap;
        },
      }),
    );
    s.run(spec({ until: "steps", steps: 3, frames: 0 }));
    let thrown: unknown;
    try {
      s.frames();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(trap);
    expect(isWasmTrap(thrown)).toBe(true);
    expect(() => s.run(spec({ until: "steps", steps: 1, frames: 6 }))).toThrow(RangeError);
    expect(() => s.value("frames.0", 2, 1000)).toThrow(RangeError);
  });

  it("any other failure of the read is an empty stack, as before", () => {
    const s = program(
      TRACE_PROGRAM,
      hooked({
        get_machine_context_lazy: () => {
          throw new Error("bad path");
        },
      }),
    );
    s.run(spec({ until: "steps", steps: 3, frames: 0 }));
    expect(s.frames()).toEqual([]);
  });

  it("a deep non-tail recursion: the final report reads the stack once, quickly, with the true depth", () => {
    const calls: Record<string, number> = {};
    const s = program(deepRecursion(400), hooked({}, calls));
    const started = Date.now();
    const r = s.run(spec({ until: "builtin", builtin: "equalsInteger", hit: 300, frames: 3 }));
    expect(r.stopped.kind).toBe("builtin");
    expect(r.frames.length).toBe(3);
    expect(r.frames_total).toBeGreaterThan(200);
    expect(calls.get_machine_context_lazy).toBe(1);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("restart is validated before anything moves", () => {
  it("an invalid call (unknown term, bad cpu, bad hit) leaves the machine, traces and pin where they were", () => {
    const s = program(TRACE_PROGRAM);
    const first = s.run(spec({ until: "trace" }));
    expect(first.traces.total).toBe(1);
    const steps = s.stepsTotal;
    for (const bad of [spec({ until: "term", term_id: 99, restart: true }), spec({ until: "budget", cpu: "abc", restart: true }), spec({ until: "done", hit: 2, restart: true }), spec({ until: "steps", steps: 2, hit: 0, restart: true })]) {
      expect(() => s.run(bad)).toThrow(EngineInputError);
      expect(s.stepsTotal).toBe(steps);
    }
    expect(s.inspect("traces", { depth: 1, offset: 0, limit: 10, context_lines: 0, max_chars: 1000 })).toMatchObject({ total: 1 });
  });

  it("a valid restart rewinds, resets traces and runs from step 0", () => {
    const s = program(TRACE_PROGRAM);
    s.run(spec({ until: "done" }));
    const r = s.run(spec({ until: "steps", steps: 3, restart: true }));
    expect(r.steps_total).toBe(3);
    expect(r.status).toBe("ready");
    expect(r.traces).toEqual({ total: 0, new: [], new_total: 0 });
    const again = s.run(spec({ until: "trace" }));
    expect(again.traces.new).toEqual(["hello"]);
  });
});

describe("breakpoints given as term ids are marked in the windows", () => {
  it("run and position reports mark the start line of a term-id breakpoint with '*'", () => {
    const s = program(TRACE_PROGRAM);
    const r = s.run(spec({ until: "steps", steps: 1, context_lines: 30, breakpoints: { term_ids: [4], uplc_lines: [] } }));
    const row = r.uplc_window.lines.find((l) => l.n === 12)!;
    expect(row.marker).toContain("*");
    const position = s.positionReport(30, 6, new Set(), [4]);
    expect(position.uplc_window.lines.find((l) => l.n === 12)!.marker).toContain("*");
    // term id and line breakpoints together: both marked, a plain line is not
    const both = s.positionReport(30, 6, new Set([4]), [4]);
    expect(both.uplc_window.lines.filter((l) => l.marker.includes("*")).map((l) => l.n)).toEqual([4, 12]);
  });
});

describe("the engine's own budget cap", () => {
  it("is named as such, not as the declared budget", () => {
    const raw = "execution went over budget Mem 13999999096196 CPU -19865487570051";
    expect(describeEngineFailure(raw)).toMatch(/safety cap.*1e13 cpu.*not a budget you declared/);
    expect(describeEngineFailure(raw)).toContain(raw);
    expect(describeEngineFailure("divide By Zero: 1 / 0")).toBe("divide By Zero: 1 / 0");
    let steps = 0;
    const s = program(
      TRACE_PROGRAM,
      hooked({
        step: (call) => {
          const real = JSON.parse(call() as string) as { term_id: number; status: unknown };
          if (++steps === 3) real.status = { status_type: "Error", message: raw };
          return JSON.stringify(real);
        },
      }),
    );
    const r = s.run(spec({ until: "error" }));
    expect(r.stopped.kind).toBe("error");
    expect(r.error_message).toMatch(/safety cap/);
    expect(r.error_message).toContain(raw);
    expect(r.budget.over_budget).toBe(false);
  });
});

describe("until='error' with stop_before", () => {
  it("an explicit (error) term: stops in Compute state on it, env in hand, the failure named", () => {
    const s = program(ERROR_PROGRAM);
    const r = s.run(spec({ until: "error", stop_before: true }));
    expect(r.stopped.kind).toBe("error");
    expect(r.stopped.detail).toMatch(/fails on the next transition.*one transition before it/);
    expect(r.status).toBe("ready");
    expect(r.position).toMatchObject({ kind: "Error", machine_state: "Compute", term_id: 0 });
    expect(r.error_at).toMatchObject({ machine_state: "Error", term_id: 0 });
    expect(r.error_message).toMatch(/crashed|exited|error/i);
    expect(r.at_failure?.env).toMatchObject({ total: 1, items: [expect.objectContaining({ name: "x", summary: "1" })] });
    expect(r.replayed).toBe(true);
    expect(s.stepsTotal).toBe(r.steps_total);
    // the failing transition is the next one
    const fail = s.run(spec({ until: "steps", steps: 1 }));
    expect(fail.stopped.kind).toBe("error");
    expect(fail.steps_total).toBe(r.steps_total + 1);
  });

  it("a builtin failure: stops in Return state with the argument in hand and the partial builtin in the frames", () => {
    const s = program(BUILTIN_ERROR_PROGRAM);
    const r = s.run(spec({ until: "error", stop_before: true }));
    expect(r.stopped.kind).toBe("error");
    expect(r.position.machine_state).toBe("Return");
    expect(r.error_at?.term_id).toBeNull();
    expect(r.error_message).toMatch(/divide By Zero/);
    expect(r.at_failure?.value).toEqual({ type: "Con:Integer", summary: "0", ref: "state.value" });
    expect(r.frames[0]).toMatchObject({ kind: "FrameAwaitArg", detail: expect.stringMatching(/builtin divideInteger \(1\/2 args/) });
  });

  it("works on a finished machine (already failed) and with until='done'; a script that succeeds just finishes", () => {
    const s = program(ERROR_PROGRAM);
    const failed = s.run(spec({ until: "error" }));
    expect(failed.status).toBe("error");
    const back = s.run(spec({ until: "done", stop_before: true }));
    expect(back.stopped.kind).toBe("error");
    expect(back.steps_total).toBe(failed.steps_total - 1);
    expect(back.status).toBe("ready");
    const fine = program(TRACE_PROGRAM).run(spec({ until: "error", stop_before: true }));
    expect(fine.stopped.kind).toBe("done");
    expect(fine.error_at).toBeUndefined();
  });

  it("is refused with other stop conditions", () => {
    const s = program(ERROR_PROGRAM);
    let caught: unknown;
    try {
      s.run(spec({ until: "steps", steps: 2, stop_before: true }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineInputError);
    expect((caught as EngineInputError).data).toEqual({ code: "invalid_argument", argument: "stop_before" });
  });

  it("a long way to the failure: the step back is a pin that survives deadline cuts and lands one step before the failure", () => {
    const n = 1500;
    const ref = program(loopThatFails(n));
    const failed = ref.run(spec({ until: "error" }));
    expect(failed.stopped.kind).toBe("error");
    const s = program(loopThatFails(n));
    let last: RunReport | undefined;
    let sawPin = false;
    for (let i = 0; i < 400; i++) {
      last = s.run(spec({ until: "error", stop_before: true, deadline_at: Date.now() + 3 }));
      if (last.pinning) sawPin = true;
      if (last.stopped.kind !== "limit") break;
    }
    expect(last!.stopped.kind).toBe("error");
    expect(last!.status).toBe("ready");
    expect(last!.steps_total).toBe(failed.steps_total - 1);
    expect(last!.error_at).toMatchObject({ machine_state: "Error" });
    expect(s.hasPendingPin).toBe(false);
    // Not an assertion on speed: only that a cut, when it happened, said so.
    if (sawPin) expect(last!.replayed).toBe(true);
  });
});

describe("hit: the N-th visit", () => {
  it("until='builtin' stops at the N-th evaluation, the same step as resuming N times", () => {
    const viaResume = program(loop(5));
    let stepsAtThird = 0;
    for (let i = 0; i < 3; i++) {
      const r = viaResume.run(spec({ until: "builtin", builtin: "subtractInteger", skip_first: i > 0 }));
      expect(r.stopped.kind).toBe("builtin");
      stepsAtThird = r.steps_total;
    }
    const direct = program(loop(5)).run(spec({ until: "builtin", builtin: "subtractInteger", hit: 3 }));
    expect(direct.stopped).toMatchObject({ kind: "builtin", detail: expect.stringContaining("(visit 3)") });
    expect(direct.steps_total).toBe(stepsAtThird);
  });

  it("until='term' and 'uplc_line' count visits; fewer visits than hit run to the end", () => {
    const probe = program(loop(5));
    const first = probe.run(spec({ until: "builtin", builtin: "equalsInteger" }));
    const termId = first.position.term_id!;
    const line = first.position.uplc_line!;
    const fourthTerm = program(loop(5)).run(spec({ until: "term", term_id: termId, hit: 4 }));
    expect(fourthTerm.stopped).toMatchObject({ kind: "term", detail: expect.stringContaining("(visit 4)") });
    const fourthLine = program(loop(5)).run(spec({ until: "uplc_line", line, hit: 4 }));
    expect(fourthLine.stopped.kind).toBe("uplc_line");
    expect(fourthLine.steps_total).toBe(fourthTerm.steps_total);
    const never = program(loop(2)).run(spec({ until: "term", term_id: termId, hit: 50 }));
    expect(never.stopped.kind).toBe("done");
  });

  it("until='trace' stops at the exact step of the N-th trace", () => {
    const two = program(TWO_TRACES).run(spec({ until: "trace", hit: 2 }));
    expect(two.stopped.kind).toBe("trace");
    expect(two.stopped.detail).toMatch(/trace #2/);
    expect(two.traces.total).toBe(2);
    const first = program(TWO_TRACES).run(spec({ until: "trace" }));
    expect(first.traces.total).toBe(1);
    expect(two.steps_total).toBeGreaterThan(first.steps_total);
    // the step before the second trace has one trace only
    const ref = program(TWO_TRACES);
    expect(ref.run(spec({ until: "steps", steps: two.steps_total - 1 })).traces.total).toBe(1);
    expect(ref.run(spec({ until: "steps", steps: 1 })).traces.total).toBe(2);
    // hit counts matching traces only
    const onlyB = program(TWO_TRACES).run(spec({ until: "trace", contains: "b", hit: 1 }));
    expect(onlyB.steps_total).toBe(two.steps_total);
    expect(program(TWO_TRACES).run(spec({ until: "trace", contains: "b", hit: 2 })).stopped.kind).toBe("done");
  });

  it("is refused for stop conditions it does not mean anything for", () => {
    const s = program(TRACE_PROGRAM);
    for (const until of ["error", "done", "steps", "budget"] as const) expect(() => s.run(spec({ until, hit: 2, steps: 2, cpu: 1 }))).toThrow(/hit counts visits/);
    expect(() => s.run(spec({ until: "builtin", builtin: "addInteger", hit: 0 }))).toThrow(/hit must be an integer >= 1/);
  });
});

describe("the coarse trace scan stays exact with the adaptive interval", () => {
  it("lands on the exact step of the 50th trace in a loop that traces every iteration", () => {
    const n = 400;
    const program1 = loopThatTraces(n);
    const s = program(program1);
    const r = s.run(spec({ until: "trace", contains: "t", hit: 50 }));
    expect(r.stopped.kind).toBe("trace");
    expect(r.traces.total).toBe(50);
    const ref = program(program1);
    expect(ref.run(spec({ until: "steps", steps: r.steps_total - 1 })).traces.total).toBe(49);
    expect(ref.run(spec({ until: "steps", steps: 1 })).traces.total).toBe(50);
  });

  it("a trace that never matches costs one scan, not one per 64 steps (checked by counting trace reads)", () => {
    const calls: Record<string, number> = {};
    const s = program(loopThatTraces(1500), hooked({}, calls));
    const r = s.run(spec({ until: "trace", contains: "never" }));
    expect(r.stopped.kind).toBe("done");
    expect(r.traces.total).toBe(1500);
    // 64-step checks would read the vector steps / 64 times; the interval grows with the run
    expect(calls.get_logs).toBeLessThan(r.steps_total / 64 / 2);
  });
});
