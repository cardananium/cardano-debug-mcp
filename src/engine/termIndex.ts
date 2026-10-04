// ScriptIndex: the canonical UPLC rendering of a session's term (`get_script()` JSON) plus the
// term-id <-> line mapping, normalised ids, enclosing-lambda names and window rendering.
//
// Built once per session (in the worker: the script JSON never leaves it). Uses @cardananium/de-uplc-core's
// `serializeTermUplc` (one term per line, so every term has a start line) and `TermIndex`
// (parents / children / line lookups). Ids on the way out are `uniq_id - base` (protocol.ts).

import { serializeTermUplc, TermIndex, type DebuggerTypes, type TermLocation } from "@cardananium/de-uplc-core";

import type { UplcWindow, UplcWindowLine } from "./protocol.js";

export type Term = DebuggerTypes.Term;

/** Cap on one rendered line in a window (the applied ScriptContext constant is a single 5k+ char line). */
export const MAX_LINE_CHARS = 200;

export interface TermInfo {
  /** Normalised id. */
  term_id: number;
  raw_id: number;
  kind: string;
  label?: string;
  /** 1-based. */
  uplc_line: number;
  /** 1-based inclusive last line. */
  end_line: number;
  depth: number;
}

export class ScriptIndex {
  readonly text: string;
  readonly lines: readonly string[];
  readonly locations: readonly TermLocation[];
  readonly index: TermIndex;
  /** Smallest uniq id in the tree. */
  readonly base: number;
  /** Largest uniq id in the tree. */
  readonly maxRaw: number;
  readonly count: number;
  readonly longestLine: number;

  constructor(term: Term) {
    const rendered = serializeTermUplc(term);
    this.text = rendered.text;
    this.lines = rendered.text.split("\n");
    this.locations = rendered.locations;
    this.index = new TermIndex(rendered.locations, "uplc");
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const loc of rendered.locations) {
      if (loc.termId < min) min = loc.termId;
      if (loc.termId > max) max = loc.termId;
    }
    this.base = rendered.locations.length > 0 ? min : 0;
    this.maxRaw = rendered.locations.length > 0 ? max : -1;
    this.count = rendered.locations.length;
    let longest = 0;
    for (const line of this.lines) if (line.length > longest) longest = line.length;
    this.longestLine = longest;
  }

  static fromJson(json: string): ScriptIndex {
    return new ScriptIndex(JSON.parse(json) as Term);
  }

  /** True when `raw` is a node of the source tree (not a synthetic discharged-value id). */
  hasRaw(raw: number): boolean {
    return raw >= 0 && this.index.byTermId.has(raw);
  }

  normalize(raw: number): number | null {
    return this.hasRaw(raw) ? raw - this.base : null;
  }

  /** Raw id of a normalised one, or undefined when out of range / not a node. */
  denormalize(termId: number): number | undefined {
    if (!Number.isInteger(termId) || termId < 0) return undefined;
    const raw = termId + this.base;
    return this.index.byTermId.has(raw) ? raw : undefined;
  }

  rankOfRaw(raw: number): number | undefined {
    return this.index.byTermId.get(raw);
  }

  infoOfRank(rank: number): TermInfo {
    const loc = this.locations[rank]!;
    const info: TermInfo = {
      term_id: loc.termId - this.base,
      raw_id: loc.termId,
      kind: loc.kind,
      uplc_line: this.index.startLine[rank]! + 1,
      end_line: this.index.endLine[rank]! + 1,
      depth: this.index.depth[rank]!,
    };
    if (loc.label !== undefined) info.label = loc.label;
    return info;
  }

  infoOfRaw(raw: number): TermInfo | undefined {
    const rank = this.rankOfRaw(raw);
    return rank === undefined ? undefined : this.infoOfRank(rank);
  }

  infoOf(termId: number): TermInfo | undefined {
    const raw = this.denormalize(termId);
    return raw === undefined ? undefined : this.infoOfRaw(raw);
  }

  /** 1-based line the (raw) term starts on. */
  lineOfRaw(raw: number): number | null {
    const line = this.index.lineOfTerm(raw);
    return line === undefined ? null : line + 1;
  }

  /** Terms starting on a 1-based line, in document order. Empty for a line with none (a closing bracket). */
  termsOnLine(line1: number): TermInfo[] {
    const ranks = this.index.byLine.get(line1 - 1);
    return ranks ? ranks.map((r) => this.infoOfRank(r)) : [];
  }

  /** Raw ids of every term starting on any of the given 1-based lines (breakpoint expansion). */
  rawIdsOnLines(lines: readonly number[]): number[] {
    const out: number[] = [];
    for (const line of lines) {
      const ranks = this.index.byLine.get(line - 1);
      if (ranks) for (const r of ranks) out.push(this.locations[r]!.termId);
    }
    return out;
  }

  /**
   * The line a breakpoint on `line1` really lands on (the gutter rule: a term starting there, else
   * the nearest term's start line), with that term's info. Undefined for an empty tree.
   */
  resolveLine(line1: number): TermInfo | undefined {
    const hit = this.index.termAtLineForBreakpoint(line1 - 1);
    if (!hit) return undefined;
    return this.infoOfRaw(hit.termId);
  }

  /**
   * Parameter names of the lambdas enclosing the (raw) term, OUTERMOST FIRST. In a CEK
   * environment the value bound by the outermost enclosing lambda is `values[0]` and the innermost
   * is the last one, so when `names.length === env.length` the two line up index for index.
   */
  enclosingLambdas(raw: number): Array<{ name: string; term_id: number; uplc_line: number }> {
    const rank = this.rankOfRaw(raw);
    if (rank === undefined) return [];
    const out: Array<{ name: string; term_id: number; uplc_line: number }> = [];
    for (const a of this.index.ancestors(rank)) {
      const loc = this.locations[a]!;
      if (loc.kind === "Lambda") out.push({ name: loc.label ?? "?", term_id: loc.termId - this.base, uplc_line: this.index.startLine[a]! + 1 });
    }
    return out;
  }

  /** The (raw) term's own subtree as UPLC text, capped to `maxLines`. */
  subtreeText(raw: number, maxLines: number): { text: string; lines: number; truncated: boolean } {
    const rank = this.rankOfRaw(raw);
    if (rank === undefined) return { text: "", lines: 0, truncated: false };
    const from = this.index.startLine[rank]!;
    const to = this.index.endLine[rank]!;
    const total = to - from + 1;
    const slice = this.lines.slice(from, Math.min(to, from + maxLines - 1) + 1);
    // Drop the common indentation so the subtree reads as its own program.
    const indent = Math.min(...slice.filter((l) => l.trim() !== "").map((l) => l.length - l.trimStart().length));
    const text = slice.map((l) => capLine(l.slice(Number.isFinite(indent) ? indent : 0))).join("\n");
    return { text, lines: total, truncated: total > slice.length };
  }

  /** Compact one-line UPLC of the (raw) term's subtree: lines trimmed and joined, capped. */
  oneLiner(raw: number, maxChars = 100): string {
    const rank = this.rankOfRaw(raw);
    if (rank === undefined) return "";
    const from = this.index.startLine[rank]!;
    const to = this.index.endLine[rank]!;
    let out = "";
    for (let i = from; i <= to; i++) {
      const piece = (this.lines[i] ?? "").trim();
      if (!piece) continue;
      out = out ? `${out} ${piece}` : piece;
      if (out.length > maxChars) return `${out.slice(0, maxChars)}…`;
    }
    return out;
  }

  /**
   * A numbered window of lines. `current` and `breakpointLines` are 1-based. Marker column:
   * `>` current, `*` breakpoint, `>*` both. Deeply nested scripts indent by hundreds of columns,
   * so the common indentation of the window is removed and reported as `dedent`.
   */
  window(options: { from: number; to: number; current: number | null; breakpointLines?: ReadonlySet<number>; withIds?: boolean; maxChars?: number }): UplcWindow {
    const total = this.lines.length;
    const from = Math.max(1, Math.min(options.from, total));
    const to = Math.max(from, Math.min(options.to, total));
    let dedent = Number.POSITIVE_INFINITY;
    for (let n = from; n <= to; n++) {
      const line = this.lines[n - 1] ?? "";
      if (line.trim() === "") continue;
      const indent = line.length - line.trimStart().length;
      if (indent < dedent) dedent = indent;
    }
    if (!Number.isFinite(dedent)) dedent = 0;
    const lines: UplcWindowLine[] = [];
    const width = String(to).length;
    const textRows: string[] = [];
    let chars = 0;
    let truncatedAt: number | undefined;
    for (let n = from; n <= to; n++) {
      const isCurrent = options.current === n;
      const isBreak = options.breakpointLines?.has(n) ?? false;
      const marker = `${isCurrent ? ">" : ""}${isBreak ? "*" : ""}`;
      const text = capLine((this.lines[n - 1] ?? "").slice(dedent));
      const row: UplcWindowLine = { n, marker, text };
      if (options.withIds) row.term_ids = this.termsOnLine(n).map((t) => t.term_id);
      const rendered = `${String(n).padStart(width)}${marker.padEnd(2)}${text}`;
      chars += rendered.length + 1;
      if (options.maxChars !== undefined && chars > options.maxChars && lines.length > 0) {
        truncatedAt = n;
        break;
      }
      lines.push(row);
      textRows.push(rendered);
    }
    const window: UplcWindow = { total_lines: total, line_from: from, line_to: truncatedAt !== undefined ? truncatedAt - 1 : to, dedent, lines, text: textRows.join("\n") };
    return window;
  }

  /** Window centred on a 1-based line. */
  windowAround(line: number | null, radius: number, extra: { breakpointLines?: ReadonlySet<number>; withIds?: boolean; maxChars?: number } = {}): UplcWindow {
    const centre = line ?? 1;
    return this.window({ from: centre - radius, to: centre + radius, current: line, ...extra });
  }
}

export function capLine(line: string, max = MAX_LINE_CHARS): string {
  if (line.length <= max) return line;
  return `${line.slice(0, max)}… [+${line.length - max} chars]`;
}

/** Minimum / maximum / count of ids in a raw term tree — the `term_id_base` rule without rendering. */
export function termIdRange(term: Term): { min: number; max: number; count: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let count = 0;
  const stack: Term[] = [term];
  while (stack.length > 0) {
    const t = stack.pop()!;
    count++;
    if (t.id < min) min = t.id;
    if (t.id > max) max = t.id;
    switch (t.term_type) {
      case "Delay":
      case "Force":
        stack.push(t.term);
        break;
      case "Lambda":
        stack.push(t.body);
        break;
      case "Apply":
        stack.push(t.function, t.argument);
        break;
      case "Constr":
        stack.push(...t.fields);
        break;
      case "Case":
        stack.push(t.constr, ...t.branches);
        break;
      default:
        break;
    }
  }
  return { min: count ? min : 0, max: count ? max : -1, count };
}
