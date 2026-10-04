// rewind advice after a failure with no term of its own: builtin failure vs machine error, and the
// machine error of a missing force, which does involve a builtin (until='builtin' stops on it).
import { describe, expect, it } from "vitest";

import { builtinOfMachineError, failureKind, rewindAdvice } from "../../src/tools/debug_run.js";

const position = { term_id: null } as never;

describe("rewindAdvice", () => {
  it("a missing force names the builtin (UPLC spelling) and offers until='builtin'", () => {
    const message = "a builtin received a term argument when something else was expected\n         Term Builtin {\n                  fun: HeadList,\n                  uniq_id: 1,\n              }\n         Hint You probably forgot to wrap the builtin with a force.";
    const advice = rewindAdvice({ steps_total: 5, position, error_message: message });
    expect(advice).toMatchObject({ failure: "machine_error", builtin: "headList", at_builtin: { until: "builtin", builtin: "headList", restart: true }, one_step_before: { until: "steps", steps: 4, restart: true } });
    expect(String(advice.note)).not.toMatch(/No builtin|does not apply/);
    expect(String(advice.note)).toMatch(/until='builtin', builtin='headList', restart=true/);
    expect(advice.stop_before).toEqual({ until: "error", stop_before: true, restart: true });
  });

  it("maps engine builtin names to the listing's spelling", () => {
    expect(builtinOfMachineError("fun: FstPair,")).toBe("fstPair");
    expect(builtinOfMachineError("fun: Bls12_381_G1_Add,")).toBe("bls12_381_G1_add");
    expect(builtinOfMachineError("fun: UnConstrData")).toBe("unConstrData");
    expect(builtinOfMachineError("fun: NotABuiltin")).toBeUndefined();
    expect(builtinOfMachineError("no name here")).toBeUndefined();
  });

  it("a missing force without a parsable name still points at until='builtin'", () => {
    const advice = rewindAdvice({ steps_total: 5, position, error_message: "a builtin received a term argument when something else was expected" });
    expect(advice.failure).toBe("machine_error");
    expect(advice).not.toHaveProperty("at_builtin");
    expect(String(advice.note)).toMatch(/builtin=<name>/);
  });

  it("other machine errors are not builtin failures; builtin failures keep their advice", () => {
    const machine = rewindAdvice({ steps_total: 5, position, error_message: "attempted to apply an argument to a non-function" });
    expect(machine.failure).toBe("machine_error");
    expect(String(machine.note)).toMatch(/a machine error, not a builtin failure/);
    expect(String(machine.note)).not.toMatch(/a builtin failed/);
    expect(machine).not.toHaveProperty("builtin");
    const builtin = rewindAdvice({ steps_total: 9, position, error_message: "divide By Zero: 1 / 0" });
    expect(builtin.failure).toBe("builtin");
    expect(String(builtin.note)).toMatch(/steps_total 9/);
    expect(String(builtin.note)).toMatch(/hit=N/);
  });

  it("an explicit (error) term offers failing_term; the notes stay short (they ride on every error run)", () => {
    const explicit = rewindAdvice({ steps_total: 12, position: { term_id: 7 } as never, error_message: "the validator crashed / exited prematurely" });
    expect(explicit.failing_term).toEqual({ until: "term", term_id: 7, restart: true });
    expect(String(explicit.note)).toMatch(/explicit \(error\)/);
    const longest = [
      rewindAdvice({ steps_total: 5, position, error_message: "a builtin received a term argument when something else was expected\n fun: HeadList," }),
      rewindAdvice({ steps_total: 5, position, error_message: "attempted to apply an argument to a non-function" }),
      rewindAdvice({ steps_total: 9, position, error_message: "divide By Zero: 1 / 0" }),
      explicit,
    ].map((a) => String(a.note).length);
    expect(Math.max(...longest)).toBeLessThan(450);
  });

  it("failureKind names the class of a failure", () => {
    expect(failureKind("the validator crashed", true)).toBe("explicit");
    expect(failureKind("attempted to apply an argument to a non-function", false)).toBe("machine_error");
    expect(failureKind("divide By Zero: 1 / 0", false)).toBe("builtin");
  });
});
