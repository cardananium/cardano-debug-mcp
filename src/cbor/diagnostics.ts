// Shaping of the library's diagnostics into the rows the tools answer: validator errors with byte
// offsets, a hex excerpt and the schema fragment they point at; structural (decoder) errors with
// the partial tree summarised; schema errors with line / column and a source snippet.

import { cborDiagnostics, cborDiagnosticsTruncated, abbreviatePath, cddlErrorReason, cddlUnresolvedNames, cddlParseErrorRange } from "@cardananium/cquisitor-lib/cddl/cddlError";
import type { CborDecodeError, CborValidationErrorInfo, CddlErrorInfo } from "@cardananium/cquisitor-lib";

import { cddlFragment, firstSpan, hexExcerpt, lineColOf, sourceLine, type HexExcerpt } from "./arithmetic.js";
import { describeRawNode, findMapEntry, rawRootKind, type RawNode } from "./rawTree.js";

export interface ErrorRow extends Partial<HexExcerpt> {
  kind: string;
  message: string;
  expected: string | null;
  /** Validator path into the CBOR (`$[0][2]`), abbreviated past `PATH_ECHO_CHARS`. */
  path: string | null;
  /** `path` abbreviated when longer than 120 characters. */
  path_short: string | null;
  byte_offset: number | null;
  byte_length: number | null;
  /** Span of the whole item the row is about (`byte_offset` marks its header): for `unexpected key` rows the whole entry, key and value. */
  anchor_offset?: number;
  anchor_length?: number;
  /** For `unexpected key N` rows: the span of the key's value (`byte_offset` is the key). */
  value_offset?: number;
  value_length?: number;
  /** The schema text the validator applied when it failed (≤ 200 chars, whitespace collapsed). */
  cddl_fragment: string | null;
  cddl_line: number | null;
  /** `[start, end)` character range of the applied schema text in the schema source (what `cddl_fragment` shows). */
  cddl_range?: [number, number];
  /** Other `expected` renderings of a folded choice (what the alternatives tried). */
  alternatives?: string[];
  /** How many reported errors fold into this row (absent = 1). */
  occurrences?: number;
  /** True when the row blames bytes inside an embedded `.cbor` payload. */
  embedded?: true;
  /** True when the row states what one alternative of a type choice wanted, not what the document has to be. */
  from_type_choice?: true;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Look up `alternatives` / `occurrences` / `embedded_span` for a diagnostic in the raw error tree (the lib's flattening drops them). */
function rawExtras(error: CborValidationErrorInfo, path: string | null, kind: string): Pick<ErrorRow, "alternatives" | "occurrences" | "embedded" | "from_type_choice"> {
  const stack: CborValidationErrorInfo[] = [error];
  while (stack.length > 0) {
    const e = stack.pop()!;
    if ((e.path ?? null) === path && e.kind === kind) {
      const out: Pick<ErrorRow, "alternatives" | "occurrences" | "embedded" | "from_type_choice"> = {};
      if (Array.isArray(e.alternatives) && e.alternatives.length > 0) out.alternatives = e.alternatives.slice(0, 5);
      if (typeof e.occurrences === "number" && e.occurrences > 1) out.occurrences = e.occurrences;
      if (e.embedded_span) out.embedded = true;
      if (e.from_type_choice) out.from_type_choice = true;
      return out;
    }
    if (Array.isArray(e.additional)) for (const a of e.additional) stack.push(a);
  }
  return {};
}

/** Character budget of the compact JSON of `errors[]` (the whole answer must stay well under 32k). */
export const ERROR_ROWS_CHARS = 14_000;

const UNEXPECTED_KEY = /^unexpected key:? (.+)$/;
/** `map missing key: 2` / `map missing key: "name"`: the fragment keeps that member visible. */
const MISSING_KEY = /^map missing key: (.+)$/;

type Span = { offset: number; length: number };

/**
 * The spans of an `unexpected key` diagnostic: the validator anchors it on the map ENTRY — its
 * `byte_spans` are the key and the value's header, its `anchor_spans` the key and the whole value.
 * Falls back to the positional tree (`rawRoot`) when the value span is missing.
 */
function unexpectedKeySpans(d: { path: string | null; byteSpans?: readonly Span[] | null; anchorSpans?: readonly Span[] | null }, rawRoot: unknown): { key: Span | null; value: Span | null } {
  const key = firstSpan(d.byteSpans) ?? firstSpan(d.anchorSpans);
  let value: Span | null = d.anchorSpans?.[1] ?? d.byteSpans?.[1] ?? null;
  if (!value && rawRoot !== undefined) {
    const entry = findMapEntry(rawRoot, d.path);
    const v = entry?.value as RawNode | undefined;
    const vs = v?.struct_position_info ?? v?.position_info;
    if (vs) value = { offset: vs.offset, length: vs.length };
  }
  return { key, value };
}

/**
 * A row's `path` is echoed whole up to this many characters, abbreviated past it (both ends and a
 * segment count, like `path_short`): a path through a deep document runs to tens of thousands of
 * segments, more than an answer can carry.
 */
export const PATH_ECHO_CHARS = 1_000;

/**
 * The validator's error set as rows: the library's head error first (the mismatch it reports
 * deepest — the same one `schema.candidates[].head_path` and the verdict name), then the rest
 * innermost first (`cborDiagnostics` order), deduplicated by the lib; at most `max` rows and at
 * most `maxChars` of JSON, the remainder counted in `additional_count`.
 *
 * An `unexpected key N` row names the entry (`path` = `$[0][19]`, the map's path plus the key) and
 * points at the key's bytes; its value is given as `value_offset` / `value_length` and the whole
 * entry as the anchor. `rawRoot` (the `cbor_to_json` value of `hex`) is only consulted when the
 * validator reported no value span.
 */
export function shapeValidationErrors(error: CborValidationErrorInfo | undefined | null, hex: string, source: string, max: number, maxChars: number = ERROR_ROWS_CHARS, rawRoot?: unknown): { errors: ErrorRow[]; additional_count: number } {
  if (!error) return { errors: [], additional_count: 0 };
  const list = headFirst(cborDiagnostics(error), error);
  const rows: ErrorRow[] = [];
  for (const d of list.slice(0, Math.max(1, max))) {
    let span = firstSpan(d.byteSpans);
    let anchor = firstSpan(d.anchorSpans);
    let valueSpan: Span | null = null;
    if (UNEXPECTED_KEY.test(d.message)) {
      const entry = unexpectedKeySpans(d, rawRoot);
      span = entry.key ?? span;
      valueSpan = entry.value;
      anchor = span && valueSpan ? { offset: span.offset, length: Math.max(1, valueSpan.offset + valueSpan.length - span.offset) } : span;
    }
    const offset = span?.offset ?? (d.kind === "input_parse" && typeof error.offset === "number" && (d.path ?? null) === (error.path ?? null) ? error.offset : null);
    const fragment = cddlFragment(source, d.cddlRange, undefined, MISSING_KEY.exec(d.message)?.[1]);
    const path = d.path || null;
    const row: ErrorRow = {
      kind: d.kind,
      message: d.message,
      expected: d.expected,
      path: path && path.length > PATH_ECHO_CHARS ? abbreviatePath(path) : path,
      path_short: path ? abbreviatePath(path) : null,
      byte_offset: offset,
      byte_length: span?.length ?? (offset !== null ? 1 : null),
      cddl_fragment: fragment?.text ?? null,
      cddl_line: fragment?.line ?? null,
    };
    if (d.cddlRange && d.cddlRange[1] > d.cddlRange[0]) row.cddl_range = [d.cddlRange[0], d.cddlRange[1]];
    if (anchor) {
      row.anchor_offset = anchor.offset;
      row.anchor_length = anchor.length;
    }
    if (valueSpan) {
      row.value_offset = valueSpan.offset;
      row.value_length = valueSpan.length;
    }
    if (offset !== null) Object.assign(row, hexExcerpt(hex, offset, span?.length ?? 1));
    Object.assign(row, rawExtras(error, d.path, d.kind));
    rows.push(row);
  }
  while (rows.length > 1 && JSON.stringify(rows).length > maxChars) rows.pop();
  return { errors: rows, additional_count: Math.max(0, list.length - rows.length) + cborDiagnosticsTruncated(error) };
}

/** `list` with the diagnostic that is the library's head error moved to the front (the rest keep their order). */
function headFirst<T extends { kind: string; path: string | null; message: string }>(list: T[], head: CborValidationErrorInfo): T[] {
  const headMessage = cddlErrorReason(head.message);
  const index = list.findIndex((d) => d.kind === head.kind && (d.path ?? null) === (head.path ?? null) && d.message === headMessage);
  if (index <= 0) return list;
  return [list[index]!, ...list.slice(0, index), ...list.slice(index + 1)];
}

export interface StructuralError extends Partial<HexExcerpt> {
  kind: string;
  message: string;
  offset: number | null;
  /** Decoder path (`$[0].entries[3].value`) of the failing position, abbreviated when longer than 120 characters. */
  path: string;
  byte_length: number | null;
  /** What decoded before the failure (`array(4 items, incomplete)`), when a prefix decoded. */
  partial_summary: string | null;
  /** Root kind of the partial tree (`array`, `map`, `tag:258`, …). */
  partial_root_kind: string | null;
}

/** A `cbor_to_json` failure as the tools report it. */
export function shapeStructuralError(error: CborDecodeError, partial: unknown, hex: string): StructuralError {
  const span = error.byte_span;
  const offset = typeof error.offset === "number" ? error.offset : span ? span.offset : null;
  const out: StructuralError = {
    kind: error.kind,
    message: error.message,
    offset,
    path: abbreviatePath(error.path),
    byte_length: span ? span.length : offset !== null ? 1 : null,
    partial_summary: isRecord(partial) ? describeRawNode(partial) : null,
    partial_root_kind: isRecord(partial) ? rawRootKind(partial) : null,
  };
  if (offset !== null) Object.assign(out, hexExcerpt(hex, offset, span?.length ?? 1));
  return out;
}

export interface SchemaErrorRow {
  kind: string;
  message: string;
  line: number | null;
  col: number | null;
  /** The source line the error points at, trimmed. */
  snippet: string | null;
  unresolved: Array<{ name: string; line: number; col: number }>;
  /** True when the unresolved list was cut short by the library. */
  unresolved_truncated?: true;
}

/** A `validate_cddl` failure with line / column and snippet. */
export function shapeSchemaError(error: CddlErrorInfo, source: string): SchemaErrorRow {
  const range = cddlParseErrorRange(error);
  const at = range ? lineColOf(source, range[0]) : error.byte_span ? { line: error.byte_span.line, col: lineColOf(source, error.byte_span.char_offset).col } : null;
  const unresolved = cddlUnresolvedNames(error).map((u) => {
    const pos = lineColOf(source, u.range[0]);
    return { name: u.name, line: pos.line, col: pos.col };
  });
  const row: SchemaErrorRow = {
    kind: error.kind,
    message: cddlErrorReason(error.message),
    line: at?.line ?? null,
    col: at?.col ?? null,
    snippet: at ? sourceLine(source, at.line).trim() || null : null,
    unresolved,
  };
  if (error.truncated) row.unresolved_truncated = true;
  return row;
}
