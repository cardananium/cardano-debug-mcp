// Breadth-first fitting of typed values and the compact positional tree into a character budget.
import { describe, expect, it } from "vitest";

import { budgetJson, budgetRaw, summaryLine } from "../../../src/cbor/budget.js";
import { compactRaw, type Oddity } from "../../../src/cbor/rawTree.js";
import { readTx } from "../../helpers/fixtures.js";
import { rawLib } from "../../helpers/inProcessLib.js";

const size = (v: unknown) => JSON.stringify(v).length;
const raw = (hex: string) => (JSON.parse(rawLib().cbor_to_json!(hex) as string) as { value: unknown }).value;
const compact = (hex: string) => compactRaw(raw(hex), [] as Oddity[]);

describe("budgetJson", () => {
  it("a value that fits is returned whole, the depth limit untouched", () => {
    const value = { a: { b: [1, 2, { c: "x" }] }, d: "text" };
    expect(budgetJson(value, 8, 1_000)).toEqual({ value, truncated: false, depth: 8 });
  });

  it("depth folds containers below the level into one-line summaries (the root is level 1)", () => {
    const value = { a: { b: 1, list: [1, 2, 3] }, n: 7 };
    expect(budgetJson(value, 1, 1_000).value).toEqual({ a: "{… 2 keys: b, list}", n: 7 });
    expect(budgetJson(value, 2, 1_000).value).toEqual({ a: { b: 1, list: "[… 3 items]" }, n: 7 });
    expect(summaryLine({})).toBe("{… 0 keys}");
  });

  it("shallow structure survives deep bulk: the small sibling keeps its detail while the bulky branch is folded", () => {
    const bulky = { rows: Array.from({ length: 200 }, (_, i) => ({ index: i, address: "addr1".padEnd(60, "x") })) };
    const value = { bulky, small: { fee: "173333", ttl: "99" } };
    const fitted = budgetJson(value, 8, 600);
    expect(fitted.truncated).toBe(true);
    expect(size(fitted.value)).toBeLessThanOrEqual(600);
    expect((fitted.value as { small: unknown }).small).toEqual({ fee: "173333", ttl: "99" });
    // a depth-by-depth cut would have to drop `small` to depth 1 to make room for the bulk
    expect((fitted.value as { bulky: { rows: unknown[] } }).bulky.rows.length).toBeGreaterThan(0);
  });

  it("a long list shows its first items and a count of the rest; an object shows its first keys and a `…` entry", () => {
    const list = budgetJson(Array.from({ length: 300 }, (_, i) => i + 0.5), 8, 400);
    const items = list.value as unknown[];
    expect(list.truncated).toBe(true);
    expect(items.slice(0, 3)).toEqual([0.5, 1.5, 2.5]);
    expect(items[items.length - 1]).toMatch(/^… \d+ more items$/);
    expect(items.length - 1 + Number(/\d+/.exec(items[items.length - 1] as string)![0])).toBe(300);
    expect(size(list.value)).toBeLessThanOrEqual(400);
    const object = budgetJson(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key${i}`, i])), 8, 300).value as Record<string, unknown>;
    expect(object["key0"]).toBe(0);
    expect(object["…"]).toMatch(/^\d+ more keys: key\d+/);
  });

  it("every budget yields a result within it", () => {
    const value = JSON.parse(JSON.stringify({ tx: { body: Array.from({ length: 40 }, (_, i) => ({ i, tags: ["a", "b", { deep: { deeper: [i, i + 1] } }], text: "t".repeat(i * 3) })) } }));
    for (const budget of [50, 120, 333, 1_000, 5_000]) {
      const fitted = budgetJson(value, 8, budget);
      expect(size(fitted.value), `budget ${budget}`).toBeLessThanOrEqual(budget);
    }
  });

  it("caps long strings and writes bigint as decimal text", () => {
    const fitted = budgetJson({ big: 2n ** 70n, text: "x".repeat(5_000) }, 4, 10_000);
    const value = fitted.value as { big: string; text: string };
    expect(value.big).toBe((2n ** 70n).toString());
    expect(value.text.length).toBeLessThan(2_100);
  });

  it("handles a 20,000-level document without recursion", () => {
    let value: unknown = 1;
    for (let i = 0; i < 20_000; i++) value = [value];
    const fitted = budgetJson(value, 8, 10_000);
    expect(size(fitted.value)).toBeLessThanOrEqual(10_000);
  });
});

describe("budgetRaw", () => {
  const TX = readTx("lock-spend.tx"); // scenario s08: body keys 0 1 2 3 first, then a witness map, is_valid, a metadata map

  it("a tree that fits is unchanged and reports the depth limit", () => {
    const tree = compact("a1 00 82 01 02".replace(/ /g, ""));
    expect(budgetRaw(tree, 8, 10_000)).toEqual({ value: tree, truncated: false, depth: 8 });
  });

  it("depth folds a node to its header: type, at, tag, items survive, `collapsed: true` says so", () => {
    const tree = compact("a1 00 d90102 81 4101".replace(/ /g, "")); // { 0: #6.258([h'01']) }
    const folded = budgetRaw(tree, 1, 10_000).value as { values: Array<{ k: unknown; v: unknown }> };
    expect(folded.values[0]!.v).toEqual({ type: "Tag", at: "2+6", tag: "Unassigned(258)", collapsed: true });
    // a tag's content shares its tag's level (like a path segment count): at depth 2 the tag and its array are both shown
    const deeper = budgetRaw(compact("a1 00 d90102 81 81 4101".replace(/ /g, "")), 2, 10_000).value as { values: Array<{ v: { type: string; value: { type: string; values: Array<{ type: string; at: string; items: number; collapsed?: boolean }> } } }> };
    expect(deeper.values[0]!.v.type).toBe("Tag");
    expect(deeper.values[0]!.v.value).toMatchObject({ type: "Array", values: [{ type: "Array", at: "6+3", items: 1, collapsed: true }] });
  });

  it("a full transaction under a small budget keeps the top levels whole and every folded node's byte span", () => {
    const tree = compact(TX);
    const fitted = budgetRaw(tree, 8, 2_500);
    expect(fitted.truncated).toBe(true);
    expect(size(fitted.value)).toBeLessThanOrEqual(2_500);
    const root = fitted.value as { type: string; items: number; values: Array<{ type: string; at: string; collapsed?: boolean; values?: Array<{ k: { value: string } }>; more?: number }> };
    expect(root.type).toBe("Array");
    expect(root.values.map((n) => n.type)).toEqual(["Map", "Map", "Bool", "Map"]); // all four children of the transaction array are shown
    const body = root.values[0]!;
    expect(body.values!.map((e) => e.k.value).slice(0, 4)).toEqual(["0", "1", "2", "3"]); // the body's first entries, in order
    // wherever a node is folded or cut it still says where its bytes are
    const folded: Array<Record<string, unknown>> = [];
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      if (n.collapsed) folded.push(n);
      for (const v of Object.values(n)) if (Array.isArray(v)) v.forEach(walk);
      else walk(v);
    };
    walk(fitted.value);
    expect(folded.length).toBeGreaterThan(0);
    for (const n of folded) expect(n.at, JSON.stringify(n)).toMatch(/^\d+\+\d+$/);
  });

  it("a long list shows its first items and `more`; a map's key / value pairs stay together", () => {
    const entries = Array.from({ length: 60 }, (_, i) => `18${(i + 24).toString(16)}${(i % 24).toString(16).padStart(2, "0")}`).join("");
    const map = compact("b8" + (60).toString(16) + entries); // map(60), keys 24..83 -> small ints
    const fitted = budgetRaw(map, 8, 700);
    const out = fitted.value as { type: string; items: number; values: Array<{ k: { value: string }; v: { value: string } }>; more?: number };
    expect(fitted.truncated).toBe(true);
    expect(size(out)).toBeLessThanOrEqual(700);
    expect(out.values.length).toBeGreaterThan(3);
    expect(out.values.length + out.more!).toBe(60);
    for (const entry of out.values) expect(entry.v).toBeDefined(); // no entry lost its value to the cut
    const array = budgetRaw(compact("98c8" + "00".repeat(200)), 8, 500).value as { values: unknown[]; more?: number };
    expect(array.values.length + array.more!).toBe(200);
  });

  it("every budget yields a result within it", () => {
    const tree = compact(TX);
    for (const budget of [200, 700, 1_500, 4_000, 9_000]) expect(size(budgetRaw(tree, 8, budget).value), `budget ${budget}`).toBeLessThanOrEqual(budget);
  });

  it("a 20,000-level document is fitted without recursion", () => {
    const tree = compact("81".repeat(20_000) + "00");
    const fitted = budgetRaw(tree, 8, 10_000);
    expect(size(fitted.value)).toBeLessThanOrEqual(10_000);
    expect(fitted.depth).toBeLessThanOrEqual(8);
  });
});
