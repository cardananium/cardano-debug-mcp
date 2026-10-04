// Hex / offset arithmetic and CDDL span slicing shared by the CBOR diagnostics tools.
//
// CBOR spans are byte offsets into the decoded buffer: hex index = offset * 2. CDDL spans carry
// UTF-8 byte offsets and UTF-16 `char_offset`/`char_length`; only the char pair may index a JS string.

import type { CborPosition, SourceSpan } from "@cardananium/cquisitor-lib";

/** Widest hex excerpt a diagnostic carries (characters = 32 bytes). */
export const EXCERPT_HEX_CHARS = 64;
/** Longest CDDL fragment a diagnostic carries. */
export const CDDL_FRAGMENT_CHARS = 200;

export interface HexExcerpt {
  /** Lowercase hex of the window, at most `maxHexChars` characters. */
  hex_excerpt: string;
  /** Byte offset of the first byte of the window in the input. */
  excerpt_offset: number;
  /** Bytes in the window. */
  excerpt_bytes: number;
  /** True when the blamed span is longer than the window (the window starts at the span). */
  excerpt_truncated?: true;
}

/**
 * A window of `maxHexChars` hex characters around the bytes `[offset, offset+length)`: the blamed
 * span sits in the middle when it fits, at the start when it is longer than the window. Offsets
 * beyond the input are clamped to the last byte (a truncation error points one past the end).
 */
export function hexExcerpt(hex: string, offset: number, length = 1, maxHexChars: number = EXCERPT_HEX_CHARS): HexExcerpt {
  const totalBytes = Math.floor(hex.length / 2);
  const windowBytes = Math.max(1, Math.floor(maxHexChars / 2));
  const spanLength = Math.max(1, Math.trunc(length) || 1);
  const at = Math.max(0, Math.min(Math.trunc(offset) || 0, Math.max(0, totalBytes - 1)));
  if (totalBytes === 0) return { hex_excerpt: "", excerpt_offset: 0, excerpt_bytes: 0 };
  let start: number;
  let truncated = false;
  if (spanLength >= windowBytes) {
    start = at;
    truncated = spanLength > windowBytes;
  } else {
    start = at - Math.floor((windowBytes - spanLength) / 2);
  }
  start = Math.max(0, Math.min(start, Math.max(0, totalBytes - windowBytes)));
  const end = Math.min(totalBytes, start + windowBytes);
  const out: HexExcerpt = { hex_excerpt: hex.slice(start * 2, end * 2).toLowerCase(), excerpt_offset: start, excerpt_bytes: end - start };
  if (truncated) out.excerpt_truncated = true;
  return out;
}

/** The bytes `[offset, offset+length)` as lowercase hex (clamped to the input). */
export function sliceHexBytes(hex: string, offset: number, length: number): string {
  const start = Math.max(0, Math.trunc(offset)) * 2;
  const end = Math.min(hex.length, start + Math.max(0, Math.trunc(length)) * 2);
  return start >= hex.length ? "" : hex.slice(start, end).toLowerCase();
}

/** First span of a `byte_spans` / `anchor_spans` list, or null. */
export function firstSpan(spans: ReadonlyArray<CborPosition> | undefined | null): CborPosition | null {
  const span = spans?.[0];
  return span && Number.isFinite(span.offset) ? { offset: span.offset, length: Math.max(0, span.length) } : null;
}

/** 1-based line and column of a UTF-16 index in `source`. */
export function lineColOf(source: string, charOffset: number): { line: number; col: number } {
  const at = Math.max(0, Math.min(charOffset, source.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < at; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, col: at - lineStart + 1 };
}

/** Collapse runs of whitespace (a CDDL fragment often spans several indented lines). */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * `text` without its CDDL comments (`;` to the end of the line). A `;` inside a text ("…") or byte
 * ('…', h'…', b64'…') literal is content, not a comment. The line breaks stay, so once the
 * whitespace is collapsed the code on either side of a comment stays apart, and no comment can
 * swallow the members that follow it on a single line.
 */
export function stripCddlComments(text: string): string {
  let out = "";
  let from = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ";") {
      out += text.slice(from, i);
      const eol = text.indexOf("\n", i);
      if (eol < 0) return out;
      from = eol;
      i = eol - 1;
    }
  }
  return out + text.slice(from);
}

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * Index in one-line CDDL `text` of the member whose key the library names as `key` in `map missing
 * key: <key>` (`2`, `-3`, `"name"`; a text key may be written bare, `name:`), stepping back over its
 * occurrence indicator (`? 3 : slot`). -1 when there is no such member or the key is of another kind.
 */
export function mapKeyEntryIndex(text: string, key: string): number {
  const k = key.trim();
  let pattern: RegExp;
  if (/^-?\d+$/.test(k)) {
    pattern = new RegExp(`(?<![\\w.-])${k.replace(ESCAPE_RE, "\\$&")}\\s*(?::|=>)`);
  } else if (/^".*"$/.test(k)) {
    const alternatives = [`${k.replace(ESCAPE_RE, "\\$&")}\\s*(?::|=>)`];
    const bare = k.slice(1, -1);
    if (/^[A-Za-z@_$][\w@$.-]*$/.test(bare)) alternatives.push(`(?<![\\w@$."-])${bare.replace(ESCAPE_RE, "\\$&")}\\s*:`);
    pattern = new RegExp(alternatives.join("|"));
  } else return -1;
  const match = pattern.exec(text);
  if (!match) return -1;
  const indicator = /[?*+]\s?$/.exec(text.slice(Math.max(0, match.index - 2), match.index));
  return indicator ? match.index - indicator[0].length : match.index;
}

const FRAGMENT_CUT = " … ";
/** Below this budget a fragment is cut at its end only (a head and a tail would each be too short to read). */
const HEAD_TAIL_MIN_CHARS = 40;

/** End of a head of at most `budget` characters: just after its last `,` when that is in its second half. */
function headEnd(text: string, budget: number): number {
  if (budget >= text.length) return text.length;
  if (/^\s*,/.test(text.slice(budget))) return budget; // the head already ends at a member boundary
  const at = text.lastIndexOf(",", budget - 1);
  return at >= budget / 2 ? at + 1 : budget;
}

/** Start of a tail of at most `budget` characters: just after a `,` in its first half, unless it already starts at a member. */
function tailStart(text: string, budget: number): number {
  const from = text.length - budget;
  if (/,\s*$/.test(text.slice(0, from))) return from;
  const at = text.indexOf(",", from);
  return at >= 0 && at - from <= budget / 2 ? at + 1 : from;
}

/**
 * `text` in at most `maxChars` characters: whole when it fits; else its head and its tail joined by
 * " … " (a map's last members matter as much as its first: a newer era's keys sit at the end), each
 * cut at a `,` near its budget. With `focusAt` (an index into `text`) that neither part keeps, a
 * window starting there sits between them. Under `HEAD_TAIL_MIN_CHARS` the text is cut at its end.
 */
export function fitHeadTail(text: string, maxChars: number, focusAt = -1): string {
  if (text.length <= maxChars) return text;
  if (maxChars < HEAD_TAIL_MIN_CHARS) return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
  const twoParts = maxChars - FRAGMENT_CUT.length;
  const end = headEnd(text, Math.ceil(twoParts * 0.5));
  const start = tailStart(text, twoParts - end);
  if (focusAt < 0 || focusAt < end || focusAt >= start) return text.slice(0, end).trimEnd() + FRAGMENT_CUT + text.slice(start).trimStart();
  const threeParts = maxChars - 2 * FRAGMENT_CUT.length;
  const end3 = headEnd(text, Math.floor(threeParts * 0.3));
  const start3 = tailStart(text, Math.floor(threeParts * 0.3));
  const from = Math.max(focusAt, end3);
  const windowBudget = Math.min(threeParts - end3 - (text.length - start3), start3 - from);
  const middle = text.slice(from, from + headEnd(text.slice(from, start3), windowBudget));
  return text.slice(0, end3).trimEnd() + FRAGMENT_CUT + middle.trim() + FRAGMENT_CUT + text.slice(start3).trimStart();
}

export interface CddlFragment {
  /** The source text of the span, comments removed and whitespace collapsed, fitted to `maxChars` (head … tail). */
  text: string;
  line: number;
  col: number;
}

/**
 * Source text a CDDL span points at (`char_offset`/`char_length`), with its line/column. `null`
 * for a missing or empty span. `[start, end)` char ranges (the lib's `CddlRange`) are accepted too.
 * Comments are removed before the whitespace is collapsed; a text longer than `maxChars` keeps its
 * head and tail (see `fitHeadTail`), plus the member of `focusKey` (a key as `map missing key: <key>`
 * prints it) when that falls in the cut.
 */
export function cddlFragment(
  source: string,
  span: SourceSpan | readonly [number, number] | undefined | null,
  maxChars: number = CDDL_FRAGMENT_CHARS,
  focusKey?: string,
): CddlFragment | null {
  if (!span) return null;
  const [start, end] = Array.isArray(span) ? [span[0], span[1]] : [(span as SourceSpan).char_offset, (span as SourceSpan).char_offset + (span as SourceSpan).char_length];
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0 || start >= source.length) return null;
  const raw = source.slice(start, Math.min(end, source.length));
  const oneLine = collapseWhitespace(stripCddlComments(raw));
  const text = fitHeadTail(oneLine, maxChars, focusKey === undefined ? -1 : mapKeyEntryIndex(oneLine, focusKey));
  const { line, col } = lineColOf(source, start);
  return { text, line, col };
}

/** The whole source line (1-based) a span starts on, trimmed, for snippets in schema errors. */
export function sourceLine(source: string, line: number): string {
  const lines = source.split("\n");
  return (lines[line - 1] ?? "").replace(/\s+$/, "");
}
