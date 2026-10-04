// Breadth-first fitting of a tree into a character budget. `capJson` shrinks a whole tree by one
// depth at a time, so one deep bulky branch costs every other branch its detail; here nodes are
// shown in level order (root, its children, their children, …) until the compact JSON of the
// answer would pass the budget, so shallow structure always survives and only the deepest bulk is
// folded: a node that does not fit is a one-line summary, children that do not fit are counted
// (`more` / a trailing marker). Used by cbor_decode (typed value, positional tree) and the
// `decoded` / `raw` windows of cbor_validate. Iterative: documents may be tens of thousands of levels deep.

import { toWireJson } from "../vocab/json.js";
import { capString, STRING_CHARS } from "../tools/_shared.js";

/** What a tree looks like to the fitter. */
interface Adapter<T> {
  /** Whether the node can have children (scalars cannot). */
  container(node: T): boolean;
  /** Children in document order (map entries flattened to key, value, key, value, …). */
  kids(node: T): T[];
  /** Children that stay together when the enumeration is cut (2 for a map's key / value pairs). */
  group?(node: T): number;
  /** Level of a child: 1 below its parent, or 0 for transparent wrappers (a tag's content). */
  step?(parent: T): 0 | 1;
  /** A scalar as shown, or a container shown as a one-line summary. */
  collapsed(node: T): unknown;
  /**
   * A container with some shown children. `kids` are the enumerated children in order (`out`
   * undefined when not shown); `total` is the number of children the node has.
   */
  expanded(node: T, kids: ReadonlyArray<{ src: T; out: unknown }>, total: number): unknown;
}

export interface Budgeted {
  value: unknown;
  /** Nodes were folded to fit the character budget (not merely below the depth limit). */
  truncated: boolean;
  /** The depth limit when the budget did not bind, else the deepest level that still shows children (>= 1). */
  depth: number;
}

interface Slot<T> {
  src: T;
  level: number;
  expandable: boolean;
  /** BFS index of the first enumerated child, and how many were enumerated. */
  first: number;
  count: number;
  /** Children the node has (set when it is expandable). */
  total: number;
}

function fit<T>(root: T, adapter: Adapter<T>, depth: number, maxChars: number): Budgeted {
  // A shown node costs at least two characters (`1,`), so no more than maxChars / 2 can ever fit.
  const cap = Math.floor(maxChars / 2) + 2;
  const slots: Array<Slot<T>> = [{ src: root, level: 1, expandable: false, first: 0, count: 0, total: 0 }];
  let enumerationCut = false;
  const kidsOf = new Map<number, T[]>();
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    if (!adapter.container(slot.src) || slot.level > depth) continue;
    slot.expandable = true;
    const kids = adapter.kids(slot.src);
    slot.total = kids.length;
    slot.first = slots.length;
    const group = adapter.group?.(slot.src) ?? 1;
    const childLevel = slot.level + (adapter.step?.(slot.src) ?? 1);
    let j = 0;
    for (; j < kids.length; j++) {
      if (slots.length >= cap && j % group === 0) break;
      slots.push({ src: kids[j]!, level: childLevel, expandable: false, first: 0, count: 0, total: 0 });
    }
    slot.count = j;
    if (j < kids.length) enumerationCut = true;
    kidsOf.set(i, kids);
  }

  /** The tree with the first `n` slots shown, and the deepest level among nodes that show children. */
  const render = (n: number): { out: unknown; deepest: number } => {
    const outs: unknown[] = new Array(n);
    let deepest = 1;
    for (let i = n - 1; i >= 0; i--) {
      const slot = slots[i]!;
      if (!slot.expandable) {
        outs[i] = adapter.collapsed(slot.src);
        continue;
      }
      const shown = Math.max(0, Math.min(slot.count, n - slot.first));
      if (shown === 0 && slot.total > 0) {
        outs[i] = adapter.collapsed(slot.src);
        continue;
      }
      const kids = kidsOf.get(i)!;
      const list: Array<{ src: T; out: unknown }> = [];
      for (let k = 0; k < slot.count; k++) list.push({ src: kids[k]!, out: k < shown ? outs[slot.first + k] : undefined });
      outs[i] = adapter.expanded(slot.src, list, slot.total);
      if (shown > 0 && slot.level > deepest) deepest = slot.level;
    }
    return { out: outs[0], deepest };
  };
  const size = (out: unknown): number => JSON.stringify(out)?.length ?? 0;

  const rendered = render(slots.length);
  if (size(rendered.out) > maxChars) {
    let lo = 1;
    let hi = slots.length; // known not to fit
    let best = render(1);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const attempt = render(mid);
      if (size(attempt.out) <= maxChars) {
        lo = mid;
        best = attempt;
      } else {
        hi = mid;
      }
    }
    return { value: best.out, truncated: true, depth: best.deepest };
  }
  return { value: rendered.out, truncated: enumerationCut, depth: enumerationCut ? rendered.deepest : depth };
}

// ---------- plain JSON (typed decodes, CDDL-labelled trees) ----------

const isContainer = (v: unknown): v is Record<string, unknown> | unknown[] => v !== null && typeof v === "object";

/** `[… 4 items]` / `{… 2 keys: a, b}`: the one-line form of a folded container. */
export function summaryLine(value: unknown): string {
  if (Array.isArray(value)) return `[… ${value.length} items]`;
  if (isContainer(value)) {
    const keys = Object.keys(value);
    return `{… ${keys.length} ${keys.length === 1 ? "key" : "keys"}${keys.length > 0 ? ": " + keys.slice(0, 6).join(", ") + (keys.length > 6 ? ", …" : "") : ""}}`;
  }
  return String(value);
}

const jsonAdapter = (stringChars: number): Adapter<unknown> => ({
  container: isContainer,
  kids: (node) => (Array.isArray(node) ? node : Object.values(node as Record<string, unknown>)),
  collapsed: (node) => (isContainer(node) ? summaryLine(node) : typeof node === "string" ? capString(node, stringChars) : node),
  expanded: (node, kids, total) => {
    const shown = kids.filter((k) => k.out !== undefined);
    if (Array.isArray(node)) {
      const out = shown.map((k) => k.out);
      if (total > shown.length) out.push(`… ${total - shown.length} more items`);
      return out;
    }
    const keys = Object.keys(node as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    kids.forEach((k, i) => {
      if (k.out !== undefined) out[keys[i]!] = k.out;
    });
    if (total > shown.length) {
      const rest = keys.slice(shown.length);
      out["…"] = `${total - shown.length} more ${total - shown.length === 1 ? "key" : "keys"}: ${rest.slice(0, 6).join(", ")}${rest.length > 6 ? ", …" : ""}`;
    }
    return out;
  },
});

/**
 * `value` shrunk breadth-first to `maxChars` of compact JSON and at most `depth` container levels
 * (the root is level 1; containers below `depth` become `[… N items]` / `{… N keys: …}`); strings
 * capped, bigint -> decimal string. A container with more children than fit shows the first ones and
 * a `… N more items` entry (arrays) / a `"…"` key (objects).
 */
export function budgetJson(value: unknown, depth: number, maxChars: number, stringChars: number = STRING_CHARS): Budgeted {
  return fit(toWireJson(value), jsonAdapter(stringChars), Math.max(1, depth), maxChars);
}

// ---------- the compact positional tree (`compactRaw`) ----------

type CompactNode = Record<string, unknown>;
const isNode = (v: unknown): v is CompactNode => v !== null && typeof v === "object" && !Array.isArray(v);

/** The `at` / `type` / `tag` / `items` header every shown node keeps, so even a folded node says where its bytes are. */
function header(node: CompactNode): CompactNode {
  const out: CompactNode = { type: node.type };
  if (node.at !== undefined) out.at = node.at;
  if (node.tag !== undefined) out.tag = node.tag;
  if (node.items !== undefined) out.items = node.items;
  return out;
}

function rawKids(node: CompactNode): CompactNode[] {
  if (Array.isArray(node.values)) {
    const out: CompactNode[] = [];
    for (const child of node.values as CompactNode[]) {
      if (isNode(child) && "k" in child && "v" in child && !("type" in child)) out.push(child.k as CompactNode, child.v as CompactNode);
      else out.push(child);
    }
    return out;
  }
  if (Array.isArray(node.chunks)) return node.chunks as CompactNode[];
  return isNode(node.value) ? [node.value as CompactNode] : [];
}

const isRawContainer = (node: CompactNode): boolean => Array.isArray(node.values) || Array.isArray(node.chunks) || isNode(node.value);

const rawAdapter = (stringChars: number): Adapter<CompactNode> => ({
  container: (node) => isNode(node) && isRawContainer(node),
  kids: rawKids,
  group: (node) => (node.type === "Map" ? 2 : 1),
  step: (node) => (node.type === "Tag" ? 0 : 1),
  collapsed: (node) => {
    if (!isNode(node)) return node;
    if (!isRawContainer(node)) {
      return typeof node.value === "string" && node.value.length > stringChars ? { ...node, value: capString(node.value, stringChars) } : node;
    }
    const out = header(node);
    if (node.incomplete) out.incomplete = true;
    out.collapsed = true;
    return out;
  },
  expanded: (node, kids, total) => {
    const out = header(node);
    if (Array.isArray(node.chunks)) {
      const shown = kids.filter((k) => k.out !== undefined).map((k) => k.out);
      out.chunks = shown;
      if (node.incomplete) out.incomplete = true;
      if (total > shown.length) out.more = total - shown.length;
      return out;
    }
    if (!Array.isArray(node.values)) {
      // a tag around one item
      out.value = kids[0]!.out;
      if (node.incomplete) out.incomplete = true;
      return out;
    }
    const list: unknown[] = [];
    if (node.type === "Map") {
      const entries = node.values as CompactNode[];
      for (let e = 0; e * 2 < kids.length; e++) {
        const key = kids[e * 2]!;
        const value = kids[e * 2 + 1];
        if (key.out === undefined || !value) break;
        const entry: CompactNode = { k: key.out, v: value.out !== undefined ? value.out : adapterCollapsed(value.src, stringChars) };
        const original = entries[e];
        if (isNode(original) && original.incomplete) entry.incomplete = true;
        list.push(entry);
      }
      out.values = list;
      if (node.incomplete) out.incomplete = true;
      if (total / 2 > list.length) out.more = total / 2 - list.length;
      return out;
    }
    for (const k of kids) if (k.out !== undefined) list.push(k.out);
    out.values = list;
    if (node.incomplete) out.incomplete = true;
    if (total > list.length) out.more = total - list.length;
    return out;
  },
});

function adapterCollapsed(node: CompactNode, stringChars: number): unknown {
  return rawAdapter(stringChars).collapsed(node);
}

/**
 * The compact positional tree (`compactRaw`) shrunk breadth-first to `maxChars` of compact JSON and
 * at most `depth` CBOR levels (the root is level 1; a tag's content shares its tag's level, like a
 * path segment count). A folded node keeps `{type, at, tag?, items?, collapsed: true}`; a container
 * showing only its first children carries `more: <how many are left>` (entries for a map).
 */
export function budgetRaw(tree: unknown, depth: number, maxChars: number, stringChars: number = STRING_CHARS): Budgeted {
  if (!isNode(tree)) return budgetJson(tree, depth, maxChars, stringChars);
  return fit(tree, rawAdapter(stringChars), Math.max(1, depth), maxChars);
}
