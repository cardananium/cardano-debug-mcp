import { describe, expect, it } from "vitest";

import { capLine, ScriptIndex, termIdRange, type Term } from "../../../src/engine/termIndex.js";

// `[(lam x [(builtin addInteger) x (con integer 1)]) (con integer 41)]` with ids assigned the way
// the engine does (post-order, process-global offset 1000).
const program: Term = {
  term_type: "Apply",
  id: 1009,
  function: {
    term_type: "Lambda",
    id: 1007,
    parameterName: "x",
    body: {
      term_type: "Apply",
      id: 1006,
      function: { term_type: "Apply", id: 1004, function: { term_type: "Builtin", id: 1002, fun: "AddInteger" }, argument: { term_type: "Var", id: 1003, name: "x" } },
      argument: { term_type: "Constant", id: 1005, constant: { type: "Integer", value: "1" } },
    },
  },
  argument: { term_type: "Constant", id: 1008, constant: { type: "Integer", value: "41" } },
};

describe("ScriptIndex", () => {
  const index = new ScriptIndex(program);

  it("renders canonical UPLC one term per line and normalises ids by the smallest one", () => {
    expect(index.count).toBe(8);
    expect(index.base).toBe(1002);
    expect(index.maxRaw).toBe(1009);
    expect(index.lines).toEqual(["[", "  (lam x", "    [", "      [", "        (builtin addInteger)", "        x", "      ]", "      (con integer 1)", "    ]", "  )", "  (con integer 41)", "]"]);
    expect(termIdRange(program)).toEqual({ min: 1002, max: 1009, count: 8 });
  });

  it("maps term ids to lines and back", () => {
    expect(index.normalize(1009)).toBe(7);
    expect(index.normalize(1002)).toBe(0);
    expect(index.normalize(5000)).toBeNull(); // not a node (a discharged value id)
    expect(index.normalize(-1)).toBeNull();
    expect(index.denormalize(7)).toBe(1009);
    expect(index.denormalize(8)).toBeUndefined();
    expect(index.denormalize(-1)).toBeUndefined();
    expect(index.lineOfRaw(1002)).toBe(5);
    expect(index.lineOfRaw(1009)).toBe(1);
    expect(index.infoOf(0)).toMatchObject({ term_id: 0, raw_id: 1002, kind: "Builtin", label: "addInteger", uplc_line: 5, end_line: 5 });
    expect(index.infoOf(5)).toMatchObject({ kind: "Lambda", label: "x", uplc_line: 2, end_line: 10, depth: 1 });
  });

  it("answers the terms starting on a line, the breakpoint resolution of a closing bracket, and ids on lines", () => {
    expect(index.termsOnLine(5).map((t) => t.term_id)).toEqual([0]);
    expect(index.termsOnLine(7)).toEqual([]);
    expect(index.rawIdsOnLines([5, 6, 7])).toEqual([1002, 1003]);
    // The nearest-term rule the gutter uses: line 7 (`]`) resolves to the enclosing apply on line 4.
    expect(index.resolveLine(7)?.uplc_line).toBe(4);
    expect(index.resolveLine(12)?.term_id).toBe(7);
  });

  it("lists the enclosing lambdas of a term outermost first", () => {
    expect(index.enclosingLambdas(1002)).toEqual([{ name: "x", term_id: 5, uplc_line: 2 }]);
    expect(index.enclosingLambdas(1008)).toEqual([]);
  });

  it("renders windows with markers, dedent and ids; caps long lines", () => {
    const window = index.window({ from: 3, to: 8, current: 5, breakpointLines: new Set([4, 5]), withIds: true });
    expect(window.dedent).toBe(4);
    expect(window.line_from).toBe(3);
    expect(window.line_to).toBe(8);
    expect(window.lines.map((l) => `${l.n}${l.marker}|${l.text}`)).toEqual(["3|[", "4*|  [", "5>*|    (builtin addInteger)", "6|    x", "7|  ]", "8|  (con integer 1)"]);
    expect(window.lines[2]!.term_ids).toEqual([0]);
    expect(window.text.split("\n")[2]).toBe("5>*    (builtin addInteger)");
    const around = index.windowAround(1, 2);
    expect(around.line_from).toBe(1);
    expect(around.line_to).toBe(3);
    expect(capLine("a".repeat(250)).endsWith("… [+50 chars]")).toBe(true);
    expect(index.oneLiner(1006)).toBe("[ [ (builtin addInteger) x ] (con integer 1) ]");
    expect(index.subtreeText(1006, 100)).toEqual({ text: "[\n  [\n    (builtin addInteger)\n    x\n  ]\n  (con integer 1)\n]", lines: 7, truncated: false });
    expect(index.subtreeText(1006, 3).truncated).toBe(true);
  });

  it("respects max_chars in windows", () => {
    const window = index.window({ from: 1, to: 12, current: null, maxChars: 30 });
    expect(window.lines.length).toBeGreaterThan(0);
    expect(window.lines.length).toBeLessThan(12);
    expect(window.line_to).toBe(window.lines[window.lines.length - 1]!.n);
  });
});
