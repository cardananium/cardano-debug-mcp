// Walkers over the positional tree `cbor_to_json` answers: the compact view `cbor_decode(as='raw')`
// shows, the oddity list with validator-style paths, root descriptions and a few probes the hint
// rules need. Every walk is iterative over an explicit stack (the tree may be 16k levels deep).

import { abbreviatePath } from "@cardananium/cquisitor-lib/cddl/cddlError";
import { joinCborPath, CBOR_PATH_ROOT } from "@cardananium/cquisitor-lib/cddl/cborPath";
import { cborRootKind, tagNumberOf } from "@cardananium/cquisitor-lib/cddl/rootKinds";

/** A node of the library's positional tree (success value or partial tree), loosely typed. */
export interface RawNode {
  type?: string;
  position_info?: { offset: number; length: number };
  struct_position_info?: { offset: number; length: number };
  value?: unknown;
  values?: unknown[];
  chunks?: unknown[];
  items?: unknown;
  tag?: unknown;
  key?: unknown;
  oddities?: Array<{ kind: string; detail?: string }>;
  incomplete?: boolean;
  [key: string]: unknown;
}

export interface Oddity {
  kind: string;
  detail?: string;
  offset?: number;
}

/**
 * Compact form of the library's positional tree: `{type, at: "<offset>+<length>", value | values |
 * chunks, tag, items}`, `Break` markers dropped, map entries as `{k, v}`, oddities collected into one
 * flat list. `at` is the byte span of the whole item as a scalar string (`"44+70"`: offset 44, 70
 * bytes), so it survives any depth pruning. Integer values become decimal strings.
 */
export function compactRaw(root: unknown, oddities: Oddity[]): unknown {
  const convert = (node: unknown): { out: unknown; children: Array<{ source: unknown; assign: (v: unknown) => void }> } => {
    const children: Array<{ source: unknown; assign: (v: unknown) => void }> = [];
    if (node === null || typeof node !== "object") return { out: node, children };
    const n = node as RawNode;
    if ("key" in n && "value" in n && !("type" in n)) {
      const entry: Record<string, unknown> = {};
      children.push({ source: n.key, assign: (v) => (entry.k = v) }, { source: n.value, assign: (v) => (entry.v = v) });
      if (n.incomplete) entry.incomplete = true;
      return { out: entry, children };
    }
    if (n.type === "Break") return { out: undefined, children };
    const span = n.struct_position_info ?? n.position_info;
    const out: Record<string, unknown> = { type: n.type };
    if (span) out.at = `${span.offset}+${span.length}`;
    if (n.tag !== undefined) out.tag = typeof n.tag === "number" ? String(n.tag) : n.tag;
    if (n.items !== undefined) out.items = typeof n.items === "string" ? n.items.toLowerCase() : n.items;
    if (Array.isArray(n.values) || Array.isArray(n.chunks)) {
      const key = Array.isArray(n.values) ? "values" : "chunks";
      const list: unknown[] = [];
      out[key] = list;
      for (const child of (n.values ?? n.chunks) as unknown[]) {
        children.push({
          source: child,
          assign: (v) => {
            if (v !== undefined) list.push(v);
          },
        });
      }
    } else if (n.value !== undefined && n.value !== null && typeof n.value === "object") {
      children.push({ source: n.value, assign: (v) => (out.value = v) });
    } else if (n.value !== undefined) {
      out.value = typeof n.value === "number" && Number.isInteger(n.value) ? String(n.value) : n.value;
    }
    if (n.incomplete) out.incomplete = true;
    if (Array.isArray(n.oddities)) {
      for (const o of n.oddities) oddities.push({ kind: o.kind, detail: o.detail, offset: n.position_info?.offset });
    }
    return { out, children };
  };

  let result: unknown;
  const stack: Array<{ source: unknown; assign: (v: unknown) => void }> = [{ source: root, assign: (v) => (result = v) }];
  // Children are processed in order so `values` arrays keep their sequence: push in reverse.
  while (stack.length > 0) {
    const { source, assign } = stack.pop()!;
    const { out, children } = convert(source);
    assign(out);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return result;
}

// ---------- oddities with paths ----------

export interface OddityRow {
  kind: string;
  /** Validator-style path (`$[0][2]`, `$.key`); tags are transparent, like in `cbor_validate` errors. */
  path: string;
  /** Header of the item the oddity is about (`byte_length` bytes: the whole item for a scalar, the header of a container). */
  byte_offset: number;
  byte_length: number;
  /** The library's detail (actual value, narrowest alternative, …). */
  note: string;
}

const NOTE_BY_KIND: Record<string, string> = {
  IntNotShortest: "integer not in its shortest encoding",
  FloatNotShortest: "float representable in a narrower width",
  IndefiniteLength: "indefinite-length item",
  MapKeysNotSorted: "map keys not in canonical (bytewise) order",
  DuplicateMapKeys: "duplicate map keys",
  BignumForSmallInt: "tag 2/3 bignum for a value that fits a native integer",
  BignumLeadingZeroes: "bignum with leading zero bytes",
};

const isRawNode = (v: unknown): v is RawNode => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * A node in CBOR diagnostic notation (RFC 8949 §8), as the validator renders composite map keys:
 * integers in decimal, byte strings `h'…'`, text quoted, `true` / `false` / `null` / `undefined`,
 * `simple(n)`, tags `n(item)`, arrays `[a, b]`, maps `{k: v}`; nesting past 8 levels is elided as
 * `[...]` / `{...}` / `n(...)`, like the validator does.
 */
export function diagnosticNotation(node: unknown, depth = 0): string {
  if (!isRawNode(node)) return "?";
  const type = node.type ?? "";
  const v = node.value;
  switch (type) {
    case "Bytes":
      return `h'${typeof v === "string" ? v : ""}'`;
    case "String":
      return JSON.stringify(typeof v === "string" ? v : "");
    case "Bool":
      return String(Boolean(v));
    case "Null":
      return "null";
    case "Undefined":
      return "undefined";
    case "Simple":
      return `simple(${String(v)})`;
    case "F16":
    case "F32":
    case "F64":
      return typeof v === "number" && Number.isInteger(v) ? `${v}.0` : String(v);
    case "Tag": {
      const n = rawTagNumber(node) ?? String(node.tag);
      return depth < MAX_NOTATION_DEPTH ? `${n}(${diagnosticNotation(node.value, depth + 1)})` : `${n}(...)`;
    }
    case "Array": {
      if (depth >= MAX_NOTATION_DEPTH) return "[...]";
      const items = (node.values ?? []).filter((c) => !(isRawNode(c) && c.type === "Break"));
      return `[${items.map((c) => diagnosticNotation(c, depth + 1)).join(", ")}]`;
    }
    case "Map": {
      if (depth >= MAX_NOTATION_DEPTH) return "{...}";
      const entries = (node.values ?? []).filter((c): c is RawNode => isRawNode(c) && "key" in c);
      return `{${entries.map((e) => `${diagnosticNotation(e.key, depth + 1)}: ${diagnosticNotation(e.value, depth + 1)}`).join(", ")}}`;
    }
    case "IndefiniteLengthBytes":
      return `h'${(node.chunks ?? []).map((c) => (isRawNode(c) && typeof c.value === "string" ? c.value : "")).join("")}'`;
    case "IndefiniteLengthString":
      return JSON.stringify((node.chunks ?? []).map((c) => (isRawNode(c) && typeof c.value === "string" ? c.value : "")).join(""));
    default:
      if (/^[UI]\d+$|^Int$/.test(type)) return String(v);
      return type.toLowerCase() || "?";
  }
}

/** Nesting depth past which `diagnosticNotation` elides (the validator's bound). */
const MAX_NOTATION_DEPTH = 8;

/** Map key kinds the validator writes in bracket form with diagnostic notation (`[[2, h'01']]`, `[{1: 2}]`, `[24(0)]`, `[simple(32)]`). */
const COMPOSITE_KEY_TYPES: ReadonlySet<string> = new Set(["Array", "Map", "Tag", "Simple", "IndefiniteLengthBytes", "IndefiniteLengthString"]);

/**
 * Path segment for a map key node, in the validator's grammar: integer keys index like arrays
 * (`[2]`, `[-1]`), text keys dot (`.name`, or `["a b"]` when not an identifier), byte keys `.h'0102'`,
 * floats / booleans / null their literal (`.1.5`, `.true`, `.null`); composite keys (arrays, maps,
 * tags, simple values) in bracket form with their diagnostic notation (`[[2, h'0102']]`, `[{1: 2}]`).
 */
export function keySegment(parent: string, key: unknown): string {
  if (!isRawNode(key)) return joinCborPath(parent, "?");
  if (COMPOSITE_KEY_TYPES.has(key.type ?? "")) return `${parent}[${diagnosticNotation(key)}]`;
  const v = key.value;
  if (typeof v === "number" && Number.isInteger(v)) return `${parent}[${v}]`;
  if (typeof v === "bigint") return `${parent}[${String(v)}]`;
  if (typeof v === "number") return `${parent}.${String(v)}`;
  if (typeof v === "string" && key.type === "Bytes") return `${parent}.h'${v}'`;
  if (typeof v === "string" && /^-?\d+$/.test(v) && /^[UI]\d+$|^Int$/.test(key.type ?? "")) return `${parent}[${v}]`; // big integers arrive as decimal strings
  if (typeof v === "string") return joinCborPath(parent, v);
  if (typeof v === "boolean") return `${parent}.${String(v)}`;
  if (v === null) return `${parent}.${key.type === "Null" ? "null" : "?"}`;
  return joinCborPath(parent, key.type ? key.type.toLowerCase() : "?");
}

/** Literal a validator path segment / `unexpected key` message uses for a map key node (composite keys in diagnostic notation). */
export function keyLiteral(key: unknown): string | null {
  if (!isRawNode(key)) return null;
  if (COMPOSITE_KEY_TYPES.has(key.type ?? "")) return diagnosticNotation(key);
  const v = key.value;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "string" && key.type === "Bytes") return `h'${v}'`;
  if (typeof v === "string" && /^[UI]\d+$|^Int$/.test(key.type ?? "")) return v;
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return String(v);
  if (v === null && key.type === "Null") return "null";
  return null;
}

/** Strip the quotes / `h'…'` a literal may carry so `"name"`, `name`, `h'01'` and `01` compare alike. */
function bareLiteral(text: string): string {
  const t = text.trim();
  if (/^".*"$/.test(t)) return t.slice(1, -1);
  if (/^h'.*'$/i.test(t)) return t.slice(2, -1).toLowerCase();
  return t;
}

/** True when a map key node renders as `literal` (as a path segment or in an `unexpected key` message). */
export function keyMatchesLiteral(key: unknown, literal: string): boolean {
  const own = keyLiteral(key);
  if (own === null) return false;
  return bareLiteral(own) === bareLiteral(literal);
}

/**
 * The node of the positional tree a validator path names (`$[0][2]`, `$.name`, `$.h'01'`, `$[-1]`,
 * `$[[2, h'01']]`): array segments index arrays, map segments select the entry whose key renders to
 * the segment; tags and indefinite-string chunks are transparent. Undefined when the path does not
 * resolve (a segment that names no child, a path in another grammar).
 */
export function resolveRawNode(root: unknown, path: string | null | undefined): RawNode | undefined {
  const segments = validatorPathSegments(path);
  return segments ? resolveSegments(root, segments) : undefined;
}

function resolveSegments(root: unknown, segments: readonly string[], unwrapLast = true): RawNode | undefined {
  let node: unknown = root;
  for (const segment of segments) {
    node = unwrapTags(node);
    if (!isRawNode(node)) return undefined;
    if (node.type === "Map" && Array.isArray(node.values)) {
      const entry = (node.values as RawNode[]).find((e) => isRawNode(e) && keyMatchesLiteral(e.key, segment));
      if (!entry) return undefined;
      node = entry.value;
    } else if (Array.isArray(node.values) || Array.isArray(node.chunks)) {
      if (!/^\d+$/.test(segment)) return undefined;
      const list = ((node.values ?? node.chunks) as unknown[]).filter((v) => !(isRawNode(v) && v.type === "Break"));
      node = list[Number(segment)];
    } else {
      return undefined;
    }
  }
  if (unwrapLast) node = unwrapTags(node);
  return isRawNode(node) ? node : undefined;
}

/** Why a `$` path does not resolve: the path text that does, and the child paths available there. */
export interface RawPathMiss {
  resolved: string;
  available: string[];
}

/** `resolveRawNode`, or where the path stops resolving (for `path_not_found` answers). A path that is not a validator path (no `$`) misses at the root. */
export function lookupRawPath(root: unknown, path: string): { node: RawNode } | { miss: RawPathMiss } {
  const segments = validatorPathSegments(path);
  if (!segments) return { miss: { resolved: "", available: [] } };
  const full = resolveSegments(root, segments);
  if (full) return { node: full };
  // longest prefix that resolves (resolution is monotonic in the prefix length)
  let lo = 0;
  let hi = segments.length; // known not to resolve
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (resolveSegments(root, segments.slice(0, mid))) lo = mid;
    else hi = mid;
  }
  const node = resolveSegments(root, segments.slice(0, lo));
  let resolved: string = CBOR_PATH_ROOT;
  for (const seg of segments.slice(0, lo)) resolved = /^-?\d+$/.test(seg) ? `${resolved}[${seg}]` : joinCborPath(resolved, seg);
  return { miss: { resolved, available: node ? childPaths(node, resolved) : [] } };
}

/** Paths of the children of a node (at most 20; an array as `[0..n-1]`). */
function childPaths(node: RawNode, path: string): string[] {
  if (node.type === "Map" && Array.isArray(node.values)) return (node.values as RawNode[]).filter((e) => isRawNode(e) && "key" in e).slice(0, 20).map((e) => keySegment(path, e.key));
  const list = Array.isArray(node.values) ? node.values : Array.isArray(node.chunks) ? node.chunks : undefined;
  if (!list) return [];
  const count = list.filter((v) => !(isRawNode(v) && v.type === "Break")).length;
  return count === 0 ? [] : [`${path}[0..${count - 1}]`];
}

/**
 * The map entry (`{key, value}`) a validator path names (the path of an `unexpected key` error:
 * `$[0][19]` is key 19 of the map at `$[0]`), with the map node itself. Undefined when the path
 * does not resolve to an entry of a map.
 */
export function findMapEntry(root: unknown, entryPath: string | null | undefined): { map: RawNode; key: RawNode; value: unknown } | undefined {
  const segments = validatorPathSegments(entryPath);
  if (!segments || segments.length === 0) return undefined;
  const map = resolveSegments(root, segments.slice(0, -1));
  if (!map || map.type !== "Map" || !Array.isArray(map.values)) return undefined;
  const literal = segments[segments.length - 1]!;
  const entry = (map.values as RawNode[]).find((e) => isRawNode(e) && keyMatchesLiteral(e.key, literal));
  return entry && isRawNode(entry.key) ? { map, key: entry.key, value: entry.value } : undefined;
}

function unwrapTags(node: unknown): unknown {
  let current = node;
  for (let i = 0; i < 64 && isRawNode(current) && current.type === "Tag"; i++) current = current.value;
  return current;
}

/** Segments of a validator path, or null when it is not one (`$…`). */
function validatorPathSegments(path: string | null | undefined): string[] | null {
  if (typeof path !== "string" || !path.startsWith(CBOR_PATH_ROOT)) return null;
  return splitValidatorPath(path.slice(CBOR_PATH_ROOT.length));
}

/** Index just past the `]` closing the bracket opened at `open`: `[]` / `{}` / `()` nest, `"…"` and `h'…'` literals are skipped whole. */
function bracketEnd(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      i = close < 0 ? text.length : close + 1;
      continue;
    }
    if (c === "[" || c === "{" || c === "(") depth++;
    else if (c === "]" || c === "}" || c === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/**
 * Segments of a validator path after `$`: `[n]` / `[-n]` / `["text"]` / `[<diagnostic notation>]`
 * (brackets balanced, so a composite key is one segment) / `.literal` (dots inside `h'…'` and floats kept).
 */
function splitValidatorPath(rest: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === "[") {
      if (rest[i + 1] === '"') {
        const close = rest.indexOf('"]', i + 2);
        if (close < 0) return null;
        out.push(rest.slice(i + 2, close).replace(/\\(.)/g, "$1"));
        i = close + 2;
      } else {
        const end = bracketEnd(rest, i);
        if (end < 0) return null;
        out.push(rest.slice(i + 1, end - 1));
        i = end;
      }
    } else if (ch === ".") {
      let j = i + 1;
      if (rest.startsWith("h'", j)) {
        const close = rest.indexOf("'", j + 2);
        if (close < 0) return null;
        j = close + 1;
      } else {
        // a float literal keeps its dot (`.1.5`): digits, then an optional fraction
        if (/^-?\d+\.\d/.test(rest.slice(j))) j += /^-?\d+\.\d+/.exec(rest.slice(j))![0].length;
        else while (j < rest.length && rest[j] !== "." && rest[j] !== "[") j++;
      }
      out.push(rest.slice(i + 1, j));
      i = j;
    } else {
      return null;
    }
  }
  return out;
}

/** Every oddity in the tree with its path and byte offset, root first, at most `limit` rows. */
export function collectOddities(root: unknown, limit = 1_000): { rows: OddityRow[]; total: number } {
  const rows: OddityRow[] = [];
  let total = 0;
  const stack: Array<{ node: unknown; path: string }> = [{ node: root, path: CBOR_PATH_ROOT }];
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (!isRawNode(node)) continue;
    if (Array.isArray(node.oddities)) {
      for (const o of node.oddities) {
        total++;
        if (rows.length < limit) rows.push({ kind: o.kind, path, byte_offset: node.position_info?.offset ?? 0, byte_length: node.position_info?.length ?? 1, note: o.detail ?? NOTE_BY_KIND[o.kind] ?? o.kind });
      }
    }
    const children: Array<{ node: unknown; path: string }> = [];
    if (node.type === "Map" && Array.isArray(node.values)) {
      for (const entry of node.values as RawNode[]) {
        if (!isRawNode(entry)) continue;
        const entryPath = keySegment(path, entry.key);
        children.push({ node: entry.key, path: entryPath }, { node: entry.value, path: entryPath });
      }
    } else if (Array.isArray(node.values)) {
      node.values.forEach((child, i) => children.push({ node: child, path: joinCborPath(path, i) }));
    } else if (Array.isArray(node.chunks)) {
      node.chunks.forEach((child, i) => children.push({ node: child, path: joinCborPath(path, i) }));
    } else if (isRawNode(node.value)) {
      children.push({ node: node.value, path }); // tags are transparent
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  rows.sort((a, b) => a.byte_offset - b.byte_offset);
  return { rows, total };
}

// ---------- spans ----------

/** One node of the positional tree as a row: where its bytes are, in the `cbor_path` grammar. */
export interface SpanRow {
  /** Path of the item (`$[0][2]`); tags are transparent (a tag and its content share it), a map key shares its entry's path (`key: true`). */
  path: string;
  /** The library's node type (`U8`, `Bytes`, `String`, `Array`, `Map`, `Tag`, `Bool`, …). */
  type: string;
  /** First byte of the whole item (header included) and its length: pass both as a `cbor_span`. */
  offset: number;
  length: number;
  /** The row is a map key (its value has its own row, same path). */
  key?: true;
  /** Tag number of a `Tag` row. */
  tag?: string;
  /** The value of an integer / bool row. */
  value?: string;
}

/** Longest path a span row echoes whole (past it the row carries the abbreviated form, like error rows). */
const SPAN_PATH_CHARS = 1_000;

/**
 * Rows `{path, type, offset, length}` for the nodes at or below `path` (the root by default) within
 * `depth` path segments of it (any depth by default), in document order, `limit` rows from `offset`;
 * `total` counts every row (only the requested window is built). `path` is a validator path
 * (`$[0][2]`); `{miss}` says where it stops resolving. The key of a map entry is a row of its own
 * (`key: true`, its entry's path); a composite key's own children are not listed.
 */
export function rawSpans(root: unknown, options: { path?: string; depth?: number; offset: number; limit: number }): { rows: SpanRow[]; total: number } | { miss: RawPathMiss } {
  const startPath = options.path && options.path.trim() !== "" ? options.path.trim() : CBOR_PATH_ROOT;
  let start: unknown = root;
  if (startPath !== CBOR_PATH_ROOT) {
    const segments = validatorPathSegments(startPath);
    const node = segments ? resolveSegments(root, segments, false) : undefined;
    if (!node) {
      const lookup = lookupRawPath(root, startPath);
      return "miss" in lookup ? lookup : { miss: { resolved: CBOR_PATH_ROOT, available: [] } };
    }
    start = node;
  }
  const maxLevel = options.depth ?? Number.POSITIVE_INFINITY;
  const rows: SpanRow[] = [];
  let total = 0;
  const stack: Array<{ node: unknown; path: string; level: number; key?: true }> = [{ node: start, path: startPath, level: 0 }];
  while (stack.length > 0) {
    const { node, path, level, key } = stack.pop()!;
    if (!isRawNode(node) || node.type === "Break") continue;
    const span = node.struct_position_info ?? node.position_info;
    if (span) {
      if (total >= options.offset && rows.length < options.limit) {
        const type = node.type ?? "?";
        const row: SpanRow = { path: path.length > SPAN_PATH_CHARS ? abbreviatePath(path) : path, type, offset: span.offset, length: span.length };
        if (key) row.key = true;
        if (type === "Tag") row.tag = String(rawTagNumber(node) ?? node.tag);
        if ((/^[UI]\d+$|^Int$/.test(type) || type === "Bool") && node.value !== undefined && node.value !== null) row.value = String(node.value);
        rows.push(row);
      }
      total++;
    }
    const children: Array<{ node: unknown; path: string; level: number; key?: true }> = [];
    if (key) {
      // a map key's own children are not listed (their paths would collide with the value's)
    } else if (node.type === "Tag") {
      children.push({ node: node.value, path, level }); // transparent: same path, same level
    } else if (level < maxLevel) {
      if (node.type === "Map" && Array.isArray(node.values)) {
        for (const entry of node.values as RawNode[]) {
          if (!isRawNode(entry)) continue;
          const entryPath = keySegment(path, entry.key);
          children.push({ node: entry.key, path: entryPath, level: level + 1, key: true });
          children.push({ node: entry.value, path: entryPath, level: level + 1 });
        }
      } else if (Array.isArray(node.values)) {
        let index = 0;
        for (const child of node.values) {
          if (isRawNode(child) && child.type === "Break") continue;
          children.push({ node: child, path: joinCborPath(path, index++), level: level + 1 });
        }
      } else if (Array.isArray(node.chunks)) {
        let index = 0;
        for (const child of node.chunks) {
          if (isRawNode(child) && child.type === "Break") continue;
          children.push({ node: child, path: joinCborPath(path, index++), level: level + 1 });
        }
      }
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return { rows, total };
}

// ---------- descriptions ----------

/** Tag number of a tree node (`Unassigned(258)` -> 258, `PosBignum` -> 2), or null. */
export function rawTagNumber(node: RawNode): number | null {
  if (typeof node.tag === "number") return node.tag;
  return typeof node.tag === "string" ? tagNumberOf(node.tag) : null;
}

/** One-line description of a node in the validator's vocabulary: `array(4 items)`, `#6.258(array(2 items))`, `bytes (32 bytes)`, `uint 5`. */
export function describeRawNode(node: unknown, depth = 0): string {
  if (!isRawNode(node)) return "?";
  const type = node.type ?? "?";
  const indefinite = node.items === "Indefinite" ? "indefinite " : "";
  const count = (list: unknown[] | undefined) => (list ?? []).filter((v) => !(isRawNode(v) && v.type === "Break")).length;
  switch (type) {
    case "Array":
      return `${indefinite}array(${node.items === "Indefinite" ? count(node.values) : String(node.items)} items${node.incomplete ? ", incomplete" : ""})`;
    case "Map":
      return `${indefinite}map(${node.items === "Indefinite" ? count(node.values) : String(node.items)} entries${node.incomplete ? ", incomplete" : ""})`;
    case "Tag": {
      const n = rawTagNumber(node);
      const inner = depth < 3 ? describeRawNode(node.value, depth + 1) : "…";
      return `#6.${n ?? String(node.tag)}(${inner})`;
    }
    case "Bytes": {
      const hex = typeof node.value === "string" ? node.value : "";
      return `bytes (${hex.length / 2} bytes${hex ? ` 0x${hex.slice(0, 16)}${hex.length > 16 ? "…" : ""}` : ""})`;
    }
    case "IndefiniteLengthBytes":
      return `indefinite bytes(${count(node.chunks)} chunks)`;
    case "IndefiniteLengthString":
      return `indefinite text(${count(node.chunks)} chunks)`;
    case "String": {
      const text = typeof node.value === "string" ? node.value : "";
      return `text ${JSON.stringify(text.length > 24 ? `${text.slice(0, 24)}…` : text)}`;
    }
    case "Bool":
      return `bool ${String(node.value)}`;
    case "Null":
      return "null";
    case "Undefined":
      return "undefined";
    case "Simple":
      return `simple(${String(node.value)})`;
    case "F16":
    case "F32":
    case "F64":
      return `float ${String(node.value)}`;
    case "Break":
      return "break";
    default:
      if (/^[UI]\d+$|^Int$/.test(type)) return `${type.startsWith("U") ? "uint" : "int"} ${String(node.value)}`;
      return type.toLowerCase();
  }
}

/** The lib's root kind of a tree (`array`, `map`, `tag:258`, …), null when unknown. */
export function rawRootKind(root: unknown): string | null {
  return isRawNode(root) && typeof root.type === "string" ? cborRootKind({ type: root.type, tag: typeof root.tag === "string" ? root.tag : undefined }) : null;
}

/** Hex values of the first `limit` definite byte strings in the tree (root first), for the hint rules. */
export function byteStringValues(root: unknown, limit = 64): string[] {
  const out: string[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0 && out.length < limit) {
    const node = stack.pop();
    if (!isRawNode(node)) continue;
    if (node.type === "Bytes" && typeof node.value === "string") out.push(node.value);
    const kids: unknown[] = [];
    if (Array.isArray(node.values)) for (const v of node.values) kids.push(isRawNode(v) && "key" in v && !("type" in v) ? v.value : v);
    if (Array.isArray(node.chunks)) kids.push(...node.chunks);
    if (isRawNode(node.value)) kids.push(node.value);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

/** Whether any container in the tree is indefinite-length (cheap probe for the hint rules). */
export function hasIndefiniteContainer(root: unknown): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRawNode(node)) continue;
    if (node.items === "Indefinite" || node.type === "IndefiniteLengthBytes" || node.type === "IndefiniteLengthString") return true;
    if (Array.isArray(node.values)) for (const v of node.values) stack.push(isRawNode(v) && "key" in v && !("type" in v) ? v.value : v);
    if (isRawNode(node.value)) stack.push(node.value);
  }
  return false;
}
