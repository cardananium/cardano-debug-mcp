// Wire form of the library's answers: JSON with integers that do not fit a double.
//
// cquisitor-lib serialises u64/i128 as bare JSON numbers (lovelace, ex-units, slots), and
// `decode_specific_type` answers with BigInt values and serde_json boxes
// `{"$serde_json::private::Number": "123"}`. On the MCP wire every such integer is a decimal
// string; small indices/counters stay JSON numbers.
//
//   parseJsonBigintSafe(text)  -> the library's exact parser (`parseJsonExact`, reviver `context.source`
//                                 on Node >= 21, iterative rewrite on Node 20) asked for decimal strings:
//                                 any integer literal outside ±2^53 is a string, serde boxes unboxed.
//   toWireJson(value)          -> deep copy where bigint -> decimal string, serde boxes unboxed,
//                                 unsafe numbers -> decimal string; iterative, so depth does not
//                                 cost stack. Safe to hand to JSON.stringify / structuredContent.
//   stringifyWire(value)       -> compact JSON text of toWireJson(value).

import { integerFromText as libIntegerFromText, parseJsonExact } from "@cardananium/cquisitor-lib/util";

// The library's parser internals, re-exported for the tests that exercise the Node 20 fallback path.
export { quoteUnsafeIntegers, REVIVER_HAS_SOURCE } from "@cardananium/cquisitor-lib/util";

const SERDE_NUMBER_KEY = "$serde_json::private::Number";
const BIGINT_BOX_KEY = "$bi";
const INTEGER_LITERAL = /^-?\d+$/;

/** Decimal integer text -> number when exactly representable, else the normalised text itself. */
export function integerFromText(text: string): number | string {
  return libIntegerFromText(text, "string") as number | string;
}

function unboxSerde(value: Record<string, unknown>): number | string | undefined {
  if (SERDE_NUMBER_KEY in value) {
    const raw = value[SERDE_NUMBER_KEY];
    if (typeof raw === "string") return INTEGER_LITERAL.test(raw) ? integerFromText(raw) : Number(raw);
    if (typeof raw === "number") return raw;
    if (typeof raw === "bigint") return bigintToWire(raw);
  }
  if (BIGINT_BOX_KEY in value && Object.keys(value).length === 1) {
    const raw = value[BIGINT_BOX_KEY];
    if (typeof raw === "string" && INTEGER_LITERAL.test(raw)) return integerFromText(raw);
  }
  return undefined;
}

function bigintToWire(value: bigint): number | string {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

/**
 * JSON.parse that keeps every integer exact: literals outside ±2^53 become decimal strings, serde
 * number boxes (`{"$serde_json::private::Number": "…"}`) and `{"$bi": "…"}` are unboxed the same way.
 * The library's `parseJsonExact` does the parsing; only the `$bi` boxes (the share-link / disk-cache
 * encoding) are the server's own.
 */
export function parseJsonBigintSafe(text: string): unknown {
  const parsed = parseJsonExact(text, { bigIntegers: "string" });
  // The library's parse already walks the tree once; walk again only when a `$bi` box can exist.
  return text.includes('"$bi"') ? unboxBigintBoxes(parsed) : parsed;
}

/** Unbox `{"$bi": "…"}` in place (returns a new value only at the root); iterative. */
function unboxBigintBoxes(root: unknown): unknown {
  if (root === null || typeof root !== "object") return root;
  if (!Array.isArray(root)) {
    const boxed = unboxSerde(root as Record<string, unknown>);
    if (boxed !== undefined) return boxed;
  }
  const stack: Array<Record<string, unknown> | unknown[]> = [root as Record<string, unknown> | unknown[]];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const child = node[i];
        if (child !== null && typeof child === "object") {
          const boxed = Array.isArray(child) ? undefined : unboxSerde(child as Record<string, unknown>);
          if (boxed !== undefined) node[i] = boxed;
          else stack.push(child as Record<string, unknown> | unknown[]);
        }
      }
    } else {
      for (const key of Object.keys(node)) {
        const child = node[key];
        if (child !== null && typeof child === "object") {
          const boxed = Array.isArray(child) ? undefined : unboxSerde(child as Record<string, unknown>);
          if (boxed !== undefined) setOwn(node, key, boxed);
          else stack.push(child as Record<string, unknown> | unknown[]);
        }
      }
    }
  }
  return root;
}

function setOwn(target: Record<string, unknown> | unknown[], key: string | number, value: unknown): void {
  if (Array.isArray(target)) {
    target[key as number] = value;
  } else if (key === "__proto__") {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  } else {
    (target as Record<string, unknown>)[key as string] = value;
  }
}

function wireScalar(value: unknown): unknown {
  switch (typeof value) {
    case "bigint":
      return bigintToWire(value);
    case "number":
      return Number.isInteger(value) && !Number.isSafeInteger(value) ? BigInt(value).toString() : value;
    case "undefined":
    case "function":
    case "symbol":
      return null;
    default:
      return value;
  }
}

/**
 * Deep copy suitable for `JSON.stringify` and `structuredContent`: bigint -> decimal string (or
 * number when safe), serde boxes unboxed, Map -> object, Set -> array, Uint8Array -> hex string,
 * undefined -> omitted in objects / null in arrays. Iterative.
 */
export function toWireJson<T = unknown>(value: unknown): T {
  if (value === null || typeof value !== "object") return wireScalar(value) as T;
  const convertNode = (node: object): unknown => {
    if (node instanceof Uint8Array) return Buffer.from(node).toString("hex");
    if (node instanceof Map) return Object.fromEntries(node);
    if (node instanceof Set) return Array.from(node);
    if (node instanceof Date) return node.toISOString();
    if (!Array.isArray(node)) {
      const boxed = unboxSerde(node as Record<string, unknown>);
      if (boxed !== undefined) return boxed;
    }
    return node;
  };
  const first = convertNode(value);
  if (first === null || typeof first !== "object") return first as T;
  const root: Record<string, unknown> | unknown[] = Array.isArray(first) ? [] : {};
  const stack: Array<{ source: Record<string, unknown> | unknown[]; target: Record<string, unknown> | unknown[] }> = [
    { source: first as Record<string, unknown> | unknown[], target: root },
  ];
  while (stack.length > 0) {
    const { source, target } = stack.pop()!;
    const keys: Array<string | number> = Array.isArray(source) ? source.map((_, i) => i) : Object.keys(source);
    for (const key of keys) {
      const raw = (source as Record<string | number, unknown>)[key];
      if (raw === undefined && !Array.isArray(source)) continue;
      if (raw === null || typeof raw !== "object") {
        setOwn(target, key, wireScalar(raw));
        continue;
      }
      const converted = convertNode(raw);
      if (converted === null || typeof converted !== "object") {
        setOwn(target, key, converted);
        continue;
      }
      const child: Record<string, unknown> | unknown[] = Array.isArray(converted) ? [] : {};
      setOwn(target, key, child);
      stack.push({ source: converted as Record<string, unknown> | unknown[], target: child });
    }
  }
  return root as T;
}

/**
 * Wire form of a decoded data tree with EVERY integer as a decimal string (also small ones), so
 * a tree never mixes numbers and strings and nothing is lost above 2^53. Non-integer numbers are
 * kept. Iterative; keys are preserved. Used for PlutusData, metadata and CDDL-shaped values —
 * never for indices / counters / offsets of the tool result itself.
 */
export function integersAsStrings<T = unknown>(value: unknown): T {
  const wire = toWireJson(value);
  if (typeof wire === "number") return (Number.isInteger(wire) ? String(wire) : wire) as T;
  if (wire === null || typeof wire !== "object") return wire as T;
  const root: Record<string, unknown> | unknown[] = Array.isArray(wire) ? [] : {};
  const stack: Array<{ source: Record<string, unknown> | unknown[]; target: Record<string, unknown> | unknown[] }> = [
    { source: wire as Record<string, unknown> | unknown[], target: root },
  ];
  while (stack.length > 0) {
    const { source, target } = stack.pop()!;
    const entries: Array<[string | number, unknown]> = Array.isArray(source) ? source.map((v, i) => [i, v] as [number, unknown]) : Object.entries(source);
    for (const [key, raw] of entries) {
      let out: unknown = raw;
      if (typeof raw === "number") out = Number.isInteger(raw) ? String(raw) : raw;
      else if (raw !== null && typeof raw === "object") {
        const child: Record<string, unknown> | unknown[] = Array.isArray(raw) ? [] : {};
        stack.push({ source: raw as Record<string, unknown> | unknown[], target: child });
        out = child;
      }
      if (Array.isArray(target)) target[key as number] = out;
      else target[key as string] = out;
    }
  }
  return root as T;
}

/**
 * JSON text of `toWireJson(value)` with one row per line: an array or object whose compact form
 * (with its indentation and key) fits `inline` characters stays on one line; a larger one opens
 * one line per member (1-space indent). Line windows (?offset=&limit=) then page it row by row,
 * at about the size of the compact text (a key-per-line pretty print is ~40% larger).
 */
export function rowsJson(value: unknown, inline = 200): string {
  const lines: string[] = [];
  // Iterative: [node, indent, prefix ("key": ), suffix (","), close?] — a close entry emits the bracket.
  const stack: Array<{ node: unknown; indent: string; prefix: string; suffix: string; close?: string }> = [{ node: toWireJson(value), indent: "", prefix: "", suffix: "" }];
  while (stack.length > 0) {
    const { node, indent, prefix, suffix, close } = stack.pop()!;
    if (close !== undefined) {
      lines.push(indent + close + suffix);
      continue;
    }
    const members: Array<[string, unknown]> =
      node !== null && typeof node === "object" ? (Array.isArray(node) ? node.map((v) => ["", v] as [string, unknown]) : Object.entries(node).map(([k, v]) => [`${JSON.stringify(k)}: `, v] as [string, unknown])) : [];
    // Bounded: a node is only ever written whole when it fits the line, so its text is read no further.
    const room = Math.max(0, inline - indent.length - prefix.length - suffix.length);
    const compact = members.length === 0 ? compactJsonUpTo(node, Number.MAX_SAFE_INTEGER)! : compactJsonUpTo(node, room);
    if (compact !== null) {
      lines.push(indent + prefix + compact + suffix);
      continue;
    }
    const array = Array.isArray(node);
    lines.push(indent + prefix + (array ? "[" : "{"));
    stack.push({ node: undefined, indent, prefix: "", suffix, close: array ? "]" : "}" });
    for (let i = members.length - 1; i >= 0; i--) {
      stack.push({ node: members[i]![1], indent: `${indent} `, prefix: members[i]![0], suffix: i < members.length - 1 ? "," : "" });
    }
  }
  return lines.join("\n");
}

/**
 * Compact JSON text of a wire value (what `JSON.stringify` writes), or null once it passes
 * `maxChars`. Iterative and bounded: a value nested thousands of levels deep neither overflows the
 * stack nor costs more than `maxChars` of text.
 */
export function compactJsonUpTo(value: unknown, maxChars: number): string | null {
  let out = "";
  const stack: Array<{ value: unknown } | { text: string }> = [{ value }];
  while (stack.length > 0) {
    const task = stack.pop()!;
    if ("text" in task) {
      out += task.text;
    } else {
      const v = task.value;
      if (v === null || typeof v !== "object") {
        out += JSON.stringify(v) ?? "null";
      } else if (Array.isArray(v)) {
        out += "[";
        stack.push({ text: "]" });
        for (let i = v.length - 1; i >= 0; i--) {
          stack.push({ value: v[i] === undefined ? null : v[i] });
          if (i > 0) stack.push({ text: "," });
        }
      } else {
        const entries = Object.entries(v as Record<string, unknown>).filter(([, item]) => item !== undefined);
        out += "{";
        stack.push({ text: "}" });
        for (let i = entries.length - 1; i >= 0; i--) {
          stack.push({ value: entries[i]![1] });
          stack.push({ text: `${JSON.stringify(entries[i]![0])}:` });
          if (i > 0) stack.push({ text: "," });
        }
      }
    }
    if (out.length > maxChars) return null;
  }
  return out;
}

/** Compact JSON text of `toWireJson(value)`. */
export function stringifyWire(value: unknown): string {
  return JSON.stringify(toWireJson(value));
}

/** Parse a decimal-string-or-number quantity into bigint (for arithmetic on wire values). */
export function bigintFromWire(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && INTEGER_LITERAL.test(value.trim())) return BigInt(value.trim());
  return undefined;
}
