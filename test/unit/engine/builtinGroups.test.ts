// The profile report's builtin buckets (data decode / equality / list / arith / crypto / control).
import { describe, expect, it } from "vitest";

import { PLUTUS_BUILTINS } from "../../../src/engine/builtins.js";
import { BUILTIN_GROUPS, groupBuiltins, groupOf, isClassified } from "../../../src/engine/builtinGroups.js";

describe("builtin groups", () => {
  it("every builtin of the engine is classified on purpose, none falls through to the default", () => {
    expect(PLUTUS_BUILTINS.filter((name) => !isClassified(name))).toEqual([]);
  });

  it("`data` is exactly the *Data builtins; the rest land where their name says", () => {
    expect(PLUTUS_BUILTINS.filter((name) => groupOf(name) === "data").sort()).toEqual(PLUTUS_BUILTINS.filter((name) => name.endsWith("Data")).sort());
    expect(groupOf("equalsData")).toBe("data");
    expect(groupOf("equalsInteger")).toBe("equality");
    expect(groupOf("headList")).toBe("list");
    expect(groupOf("dropList")).toBe("list");
    expect(groupOf("addInteger")).toBe("arith");
    expect(groupOf("expModInteger")).toBe("arith");
    expect(groupOf("verifyEd25519Signature")).toBe("crypto");
    expect(groupOf("bls12_381_G1_multiScalarMul")).toBe("crypto");
    expect(groupOf("ifThenElse")).toBe("control");
    expect(groupOf("aBuiltinFromTheFuture")).toBe("control");
    expect(BUILTIN_GROUPS.map((g) => g.id)).toEqual(["data", "equality", "list", "arith", "crypto", "control"]);
  });

  it("totals over all rows; one row per group that ran, costliest first, shares of all builtin cpu", () => {
    const rows = [
      { name: "unConstrData", calls: 4n, cpu: 400n, mem: 8n },
      { name: "equalsData", calls: 1n, cpu: 300n, mem: 1n },
      { name: "headList", calls: 6n, cpu: 200n, mem: 12n },
      { name: "sha2_256", calls: 1n, cpu: 100n, mem: 4n },
    ];
    const { total, groups } = groupBuiltins(rows);
    expect(total).toEqual({ calls: 12n, cpu: 1000n, mem: 25n });
    expect(groups.map((g) => [g.group, g.builtins, g.calls, g.cpu, g.cpu_pct])).toEqual([
      ["data", 2, 5n, 700n, 70],
      ["list", 1, 6n, 200n, 20],
      ["crypto", 1, 1n, 100n, 10],
    ]);
    expect(groupBuiltins([])).toEqual({ total: { calls: 0n, cpu: 0n, mem: 0n }, groups: [] });
  });

  it("equal cost keeps the declaration order of the groups", () => {
    const { groups } = groupBuiltins([
      { name: "addInteger", calls: 1n, cpu: 10n, mem: 1n },
      { name: "iData", calls: 1n, cpu: 10n, mem: 1n },
    ]);
    expect(groups.map((g) => g.group)).toEqual(["data", "arith"]);
  });
});
