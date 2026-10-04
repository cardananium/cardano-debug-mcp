import { describe, expect, it } from "vitest";

import { bigintFromWire, compactJsonUpTo, parseJsonBigintSafe, quoteUnsafeIntegers, REVIVER_HAS_SOURCE, rowsJson, stringifyWire, toWireJson } from "../../src/vocab/json.js";
import { fxBig } from "../helpers/fixtures.js";

const BIG = "18446744073709551615"; // u64::MAX
const NEG_BIG = "-9223372036854775808";

describe("parseJsonBigintSafe", () => {
  it("keeps big integers exact as decimal strings and small ones as numbers", () => {
    const text = `{"fee":123,"coin":${BIG},"neg":${NEG_BIG},"list":[1,${BIG},2.5,-3],"str":"${BIG}","nested":{"x":${BIG}}}`;
    const value = parseJsonBigintSafe(text) as Record<string, unknown>;
    expect(value.fee).toBe(123);
    expect(value.coin).toBe(BIG);
    expect(value.neg).toBe(NEG_BIG);
    expect(value.list).toEqual([1, BIG, 2.5, -3]);
    expect(value.str).toBe(BIG);
    expect((value.nested as Record<string, unknown>).x).toBe(BIG);
  });
  it("unboxes serde number boxes", () => {
    const text = `{"index":{"$serde_json::private::Number":"1"},"big":{"$serde_json::private::Number":"${BIG}"},"f":{"$serde_json::private::Number":"1.5"},"bi":{"$bi":"${BIG}"}}`;
    const value = parseJsonBigintSafe(text) as Record<string, unknown>;
    expect(value.index).toBe(1);
    expect(value.big).toBe(BIG);
    expect(value.f).toBe(1.5);
    expect(value.bi).toBe(BIG);
  });
  it("handles 2^53 boundaries", () => {
    const value = parseJsonBigintSafe(`[9007199254740991, 9007199254740992, -9007199254740991, -9007199254740992]`) as unknown[];
    expect(value).toEqual([9007199254740991, "9007199254740992", -9007199254740991, "-9007199254740992"]);
  });
  it("tokenizer fallback agrees with the reviver path", () => {
    const text = `{"a":${BIG},"s":"x ${BIG} \\" y","arr":[${BIG},1e3,1.25,-${BIG}],"z":0}`;
    const rewritten = quoteUnsafeIntegers(text);
    expect(JSON.parse(rewritten)).toEqual({ a: BIG, s: `x ${BIG} " y`, arr: [BIG, 1000, 1.25, `-${BIG}`], z: 0 });
    expect(JSON.parse(rewritten)).toEqual(parseJsonBigintSafe(text));
    expect(typeof REVIVER_HAS_SOURCE).toBe("boolean");
  });
  it("survives documents nested thousands of levels deep (the reviver path overflows the stack, the tokenizer path does not)", () => {
    for (const depth of [1500, 5000]) {
      const text = `${"[".repeat(depth)}${BIG}${"]".repeat(depth)}`;
      let node = parseJsonBigintSafe(text);
      let levels = 0;
      while (Array.isArray(node)) {
        node = node[0];
        levels++;
      }
      expect(levels).toBe(depth);
      expect(node).toBe(BIG);
    }
    // an object form too (the library's positional tree is objects in arrays)
    const objects = `${'{"type":"Array","values":['.repeat(3000)}{"type":"U8","value":${BIG}}${"]}".repeat(3000)}`;
    let node = parseJsonBigintSafe(objects) as { values?: unknown[]; value?: unknown };
    for (let i = 0; i < 3000; i++) node = node.values![0] as typeof node;
    expect(node.value).toBe(BIG);
  });
});

describe("toWireJson", () => {
  it("converts bigint, serde boxes, maps, sets, bytes", () => {
    const value = toWireJson({
      big: BigInt(BIG),
      small: 7n,
      boxed: { "$serde_json::private::Number": "42" },
      map: new Map([["k", 1n]]),
      set: new Set([1, 2]),
      bytes: new Uint8Array([0xde, 0xad]),
      nested: [{ deep: { deeper: BigInt(BIG) } }],
      undef: undefined,
    }) as Record<string, unknown>;
    expect(value.big).toBe(BIG);
    expect(value.small).toBe(7);
    expect(value.boxed).toBe(42);
    expect(value.map).toEqual({ k: 1 });
    expect(value.set).toEqual([1, 2]);
    expect(value.bytes).toBe("dead");
    expect(value.nested).toEqual([{ deep: { deeper: BIG } }]);
    expect("undef" in value).toBe(false);
  });
  it("survives deep nesting without recursion", () => {
    let deep: unknown = 1n;
    for (let i = 0; i < 20_000; i++) deep = [deep];
    expect(() => toWireJson(deep)).not.toThrow();
  });
  it("stringifyWire produces JSON", () => {
    expect(stringifyWire({ a: 1n, b: [BigInt(BIG)] })).toBe(`{"a":1,"b":["${BIG}"]}`);
  });
  it("bigintFromWire", () => {
    expect(bigintFromWire(BIG)).toBe(BigInt(BIG));
    expect(bigintFromWire(5)).toBe(5n);
    expect(bigintFromWire("x")).toBeUndefined();
  });
});

describe("rowsJson (line-pageable JSON resources)", () => {
  it("keeps each small row on one line and stays near the compact size", () => {
    // a profile-report-shaped value: the totals are those of the artificial S1 spend script (manifest s01.debug.spend)
    const steps = Number(fxBig("s01.debug.spend.profile.stepsTotal"));
    const cpuSpent = fxBig("s01.debug.spend.cpuSpent");
    const report = {
      totals: { steps, cpuSpent, outcome: { outcome_type: "Done" } },
      terms: Array.from({ length: 500 }, (_, i) => ({ termId: i, hits: 1, selfCpu: 16000, selfMem: 100, totalCpu: 16000, totalMem: 100 })),
      traces: [],
      dropped: undefined,
    };
    const text = rowsJson(report);
    expect(JSON.parse(text)).toEqual(toWireJson(report));
    const compact = stringifyWire(report).length;
    expect(text.length).toBeLessThan(compact * 1.1);
    expect(JSON.stringify(toWireJson(report), null, 1).length).toBeGreaterThan(compact * 1.3);
    const lines = text.split("\n");
    // {, totals (inline), "terms": [, 500 rows, ], traces, }
    expect(lines).toHaveLength(500 + 6);
    expect(lines[1]).toBe(` "totals": {"steps":${steps},"cpuSpent":${cpuSpent},"outcome":{"outcome_type":"Done"}},`);
    expect(lines[3]).toBe('  {"termId":0,"hits":1,"selfCpu":16000,"selfMem":100,"totalCpu":16000,"totalMem":100},');
    expect(lines.at(-2)).toBe(' "traces": []');
  });

  it("opens containers wider than the inline width, scalars and empties as compact JSON", () => {
    expect(rowsJson(1)).toBe("1");
    expect(rowsJson(null)).toBe("null");
    expect(rowsJson({})).toBe("{}");
    expect(rowsJson({ a: [1, 2] }, 5)).toBe('{\n "a": [\n  1,\n  2\n ]\n}');
    const deep = { a: { b: { c: "x".repeat(300) } } };
    expect(JSON.parse(rowsJson(deep))).toEqual(deep);
    expect(rowsJson(deep).split("\n")).toHaveLength(7);
  });
});

describe("compactJsonUpTo / rowsJson on deep values", () => {
  it("writes what JSON.stringify writes, or null past the budget", () => {
    for (const v of [null, 1, "a\"b", true, [1, [2, {}]], { a: 1, b: [null, "x"], c: undefined }, []]) expect(compactJsonUpTo(v, 1_000)).toBe(JSON.stringify(v));
    expect(compactJsonUpTo({ a: "x".repeat(50) }, 20)).toBeNull();
  });
  it("reads no further than the budget of a value nested 50,000 levels deep (no RangeError), and rowsJson pages deep values", () => {
    let deep: unknown = 0;
    for (let i = 0; i < 50_000; i++) deep = { v: [deep] };
    expect(compactJsonUpTo(deep, 100)).toBeNull();
    let nested: unknown = 0;
    for (let i = 0; i < 2_000; i++) nested = { v: [nested] };
    const text = rowsJson(nested);
    expect(text.split("\n").length).toBeGreaterThan(2_000);
    expect(text.replace(/\s+/g, "")).toBe(JSON.stringify(nested).replace(/\s+/g, "").replace(/:/g, ":"));
  });
});
