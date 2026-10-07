// Result builders and size discipline shared by every tool.
//
// Every tool answers `{content: [{type:'text', text: <compact JSON>}], structuredContent: <the same
// object>}`. Failures the model can recover from are ordinary results with `isError: true` and
// `{code, message}` in the structured content — never protocol errors.
//
// Resource links have ONE carrier: the `resources: [{uri, name, mimeType}]` array inside that JSON.
// It is part of the text every client hands to the model; separate `resource_link` blocks would repeat
// the same URIs and (client-dependent) be rendered as a second copy.

import {
  CBOR_WALKER_DEPTH_LIMIT,
  CSL_DECODING_DEPTH_LIMIT,
  EVALUATOR_DECODING_DEPTH_LIMIT,
  NATIVE_SCRIPT_DEPTH_LIMIT,
  TYPED_DECODING_DEPTH_LIMIT,
} from "@cardananium/cquisitor-lib/util";

import { RedeemerRefError } from "../vocab/redeemerRef.js";
import { toWireJson } from "../vocab/json.js";
import {
  WorkerAbortedError,
  WorkerCallError,
  WorkerInputTooLargeError,
  WorkerTimeoutError,
  WorkerUnavailableError,
} from "../workers/rpc.js";

export type { AppContext, ToolModule } from "../context.js";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ResourceLink {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
}

export type ContentBlock = TextBlock | ResourceLink;

export interface ToolResult {
  content: ContentBlock[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface OkOptions {
  /** Listed once each (by uri) as `resources: [{uri, name, mimeType}]` in the structured content (and so in the text); no `resource_link` blocks. */
  links?: ResourceLink[];
}

/** Successful result: `text` is the compact JSON of `structuredContent` (wire-normalised). */
export function ok(structured: Record<string, unknown>, options: OkOptions = {}): ToolResult {
  const links = (options.links ?? []).filter((link, i, all) => all.findIndex((other) => other.uri === link.uri) === i);
  const body = toWireJson<Record<string, unknown>>(
    links.length > 0 ? { ...structured, resources: links.map(({ uri, name, mimeType }) => ({ uri, name, mimeType })) } : structured,
  );
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

export interface FailPayload extends Record<string, unknown> {
  /** Stable machine-readable code (`expired_handle`, `invalid_argument`, `timeout`, `lib_error`, …). */
  code: string;
  /** What went wrong and, when possible, what to do instead. This is all the model sees. */
  message: string;
}

/** Recoverable failure: `isError: true`, same text/structured discipline as `ok`. */
export function fail(structured: FailPayload): ToolResult {
  const body = toWireJson<Record<string, unknown>>(structured);
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    isError: true,
  };
}

/**
 * Nesting depth the library's typed decoders (a named type, the transaction as tx_load reads it) accept.
 * Like the serialization-library and evaluator bounds, it counts no level inside a native script.
 */
export const TYPED_NESTING_LIMIT = TYPED_DECODING_DEPTH_LIMIT;

/** Nesting depth the serialization library deserializes without rendering: validation, necessary data, hashes, signatures, a context UTxO's script reference. */
export const CSL_NESTING_LIMIT = CSL_DECODING_DEPTH_LIMIT;

/** Nesting depth of bytes only pallas and the script evaluator read: script execution, a validation-context UTxO's inline datum. */
export const EVALUATOR_NESTING_LIMIT = EVALUATOR_DECODING_DEPTH_LIMIT;

/** Nesting depth the positional / CDDL walkers follow (cbor_decode as='raw', cbor_validate). */
export const WALKER_NESTING_LIMIT = CBOR_WALKER_DEPTH_LIMIT;

/**
 * Nesting depth of an input holding native scripts, the scripts' own levels included: native scripts are
 * exempt from the typed, serialization-library and evaluator bounds and stop only at the walkers' bound.
 */
export const NATIVE_SCRIPT_NESTING_LIMIT = NATIVE_SCRIPT_DEPTH_LIMIT;

/**
 * The library's refusal of bytes nested past one of its decoders' bounds (kind `nesting_too_deep`):
 * `CBOR nesting is deeper than the supported limit of 64 levels for typed decoding`, `… of 128 levels
 * for decoding by the serialization library`, `… of 128 levels for decoding by pallas and the Plutus
 * evaluator` (each followed by `; native scripts do not count toward it and may nest up to 32768
 * levels`), or `… of 32768 levels` (the walkers, native scripts included). A tag-24 payload (inline
 * datum, script_ref) counts at the depth it is embedded at, so a shallow document can carry it;
 * nothing was examined, so it is no verdict on the bytes.
 */
export function isNestingRefusal(message: string): boolean {
  return /nesting is deeper than the supported limit|kind: nesting_too_deep/i.test(message);
}

/** True when the refusal states that native scripts do not count toward its bound. */
export function nestingRefusalExemptsNativeScripts(message: string): boolean {
  return /native scripts do not count toward it/i.test(message);
}

/** Which decoder a nesting refusal names. */
export type NestingBound = "typed" | "serialization_library" | "evaluator" | "walker";

/** The decoder a refusal names by its wording; the typed decoders' when it names none. */
export function nestingRefusalBound(message: string): NestingBound {
  if (/for decoding by pallas|Plutus evaluator/i.test(message)) return "evaluator";
  if (/serialization library/i.test(message)) return "serialization_library";
  if (/for typed decoding/i.test(message)) return "typed";
  if (new RegExp(`supported limit of ${WALKER_NESTING_LIMIT} levels`).test(message)) return "walker";
  return "typed";
}

const BOUND_LIMIT: Record<NestingBound, number> = {
  typed: TYPED_NESTING_LIMIT,
  serialization_library: CSL_NESTING_LIMIT,
  evaluator: EVALUATOR_NESTING_LIMIT,
  walker: WALKER_NESTING_LIMIT,
};

/** The bound a nesting refusal names (`… supported limit of <n> levels …`); its decoder's bound when it states none. */
export function nestingRefusalLimit(message: string): number {
  const stated = /supported limit of (\d+) levels/i.exec(message);
  const limit = stated ? Number(stated[1]) : NaN;
  return Number.isSafeInteger(limit) && limit > 0 ? limit : BOUND_LIMIT[nestingRefusalBound(message)];
}

const BOUND_NAME: Record<NestingBound, string> = {
  typed: "the typed-decoding bound",
  serialization_library: "the serialization-library bound",
  evaluator: "the pallas / Plutus evaluator bound",
  walker: "the CBOR / CDDL walkers' bound",
};

/** Every bound in the library's own terms, and which one the refusal `message` is. */
export function nestingBoundsNote(message: string): string {
  return (
    `The library reads at most ${TYPED_NESTING_LIMIT} levels for typed decoding (a named ledger type; the transaction as tx_load decodes it), ` +
    `${CSL_NESTING_LIMIT} for decoding by the serialization library (validation, necessary data, hashes, signatures; a validation-context UTxO's script reference) and ` +
    `${EVALUATOR_NESTING_LIMIT} for decoding by pallas and the Plutus evaluator (script execution; a validation-context UTxO's inline datum); ` +
    `levels inside native scripts count toward none of these, so native scripts may nest up to ${NATIVE_SCRIPT_NESTING_LIMIT} levels; ` +
    `cbor_validate and cbor_decode(as='raw') follow ${WALKER_NESTING_LIMIT}. This refusal is ${BOUND_NAME[nestingRefusalBound(message)]}.`
  );
}

/** Map a thrown error to a `fail` result with a stable code. */
export function failFromError(error: unknown, fallbackCode = "internal_error", extra: Record<string, unknown> = {}): ToolResult {
  if (error instanceof WorkerCallError && !error.fatal && isNestingRefusal(error.message)) {
    const limit = nestingRefusalLimit(error.message);
    return fail({
      code: "unexamined",
      message:
        `Refused, not invalid: ${capString(error.message, MESSAGE_CHARS)}. ${nestingBoundsNote(error.message)} An inline datum or script_ref (tag 24) counts at the depth it is embedded at, in the transaction or in a UTxO of the validation context. ` +
        "Nothing was examined, so there is no verdict: cbor_validate(hex) checks the bytes against the CDDL, cbor_decode(hex, as='raw') shows the tree.",
      refusal: capString(error.message, MESSAGE_CHARS),
      limit,
      ...extra,
    });
  }
  if (error instanceof WorkerTimeoutError) {
    return fail({ code: "timeout", message: error.message, timeout_ms: error.timeoutMs, ...extra });
  }
  if (error instanceof WorkerInputTooLargeError) {
    return fail({ code: "input_too_large", message: error.message, bytes: error.bytes, ...(error.atLeast ? { bytes_at_least: true } : {}), limit: error.limit, ...extra });
  }
  if (error instanceof WorkerUnavailableError) {
    return fail({ code: "worker_unavailable", message: error.message, ...extra });
  }
  if (error instanceof WorkerAbortedError) {
    return fail({ code: "cancelled", message: error.message, ...extra });
  }
  if (error instanceof WorkerCallError) {
    return fail({
      code: error.fatal ? "wasm_trap" : "lib_error",
      message: error.fatal ? `${error.message} (the engine instance was poisoned and has been restarted)` : error.message,
      error_name: error.remoteName,
      ...(error.data !== undefined ? { data: error.data } : {}),
      ...extra,
    });
  }
  if (error instanceof RedeemerRefError) {
    return fail({ code: "invalid_argument", message: error.message, argument: "redeemer", ...extra });
  }
  if (error instanceof TxDecodeError) {
    return fail({ code: "decode_failed", message: error.message, argument: error.argument, lib_message: error.libMessage, input_bytes: error.inputBytes, next: error.next, ...extra });
  }
  if (error instanceof ToolInputError) {
    return fail({ code: "invalid_argument", message: error.message, ...(error.argument ? { argument: error.argument } : {}), ...extra });
  }
  const message = error instanceof Error ? error.message : String(error);
  return fail({ code: fallbackCode, message, ...extra });
}

/** The calls that show where bytes diverge from a transaction; the `next` field of a `decode_failed` result. */
export const TX_DECODE_NEXT_STEPS = [
  "cbor_validate(hex=<the same bytes>, rule='transaction') — the mismatch with path, byte offset, hex excerpt, schema fragment and hints (conway preset; add cddl='babbage' | 'alonzo' | … for an older era)",
  "cbor_decode(hex=<the same bytes>, as='auto') — what the bytes actually are (typed candidates, or the structural error / closest schema root)",
  "docs(topic='cbor-cddl') — how to read the errors, the tags Cardano uses and what changed between eras",
] as const;

/** The reason inside the library's `Failed to decode Transaction: JsValue("…")` wrapper, unquoted and capped. */
export function libDecodeReason(message: string): string {
  let reason = message.trim();
  const wrapped = /^Failed to decode \w+:\s*(.*)$/s.exec(reason);
  if (wrapped) reason = wrapped[1]!.trim();
  const jsValue = /^JsValue\((?:"((?:[^"\\]|\\.)*)"|(.*))\)$/s.exec(reason);
  if (jsValue) reason = (jsValue[1] !== undefined ? jsValue[1].replace(/\\"/g, '"') : jsValue[2]!).trim();
  reason = reason.replace(/^Deserialization failed in /, "at ").replace(/\s+/g, " ").replace(/\.$/, "");
  return capString(reason, MESSAGE_CHARS);
}

/**
 * Bytes that are not a transaction. `failFromError` answers `decode_failed` with the library's reason
 * and the `next` calls (cbor_validate on the same bytes with rule='transaction', cbor_decode, docs).
 */
export class TxDecodeError extends Error {
  readonly argument: string;
  readonly libMessage: string;
  readonly inputBytes: number;
  readonly next: readonly string[] = TX_DECODE_NEXT_STEPS;
  constructor(libMessage: string, inputBytes: number, argument = "tx_cbor") {
    const reason = libDecodeReason(libMessage);
    super(
      `The bytes did not decode as a Cardano transaction (${reason}). ` +
        "Run cbor_validate(hex=<the same bytes>, rule='transaction') to see where they diverge from the schema (path, byte offset, hex excerpt, hints), " +
        "or cbor_decode(hex, as='auto') to learn what they are instead.",
    );
    this.name = "TxDecodeError";
    this.argument = argument;
    this.libMessage = capString(libMessage, STRING_CHARS);
    this.inputBytes = inputBytes;
  }
}

/** Throw from a tool for a bad argument; `failFromError` turns it into `invalid_argument`. */
export class ToolInputError extends Error {
  readonly argument: string | undefined;
  constructor(message: string, argument?: string) {
    super(message);
    this.name = "ToolInputError";
    this.argument = argument;
  }
}

export function resourceLink(uri: string, name: string, mimeType?: string, description?: string): ResourceLink {
  const link: ResourceLink = { type: "resource_link", uri, name };
  if (mimeType) link.mimeType = mimeType;
  if (description) link.description = description;
  return link;
}

// ---------- size discipline ----------

export const DEFAULT_ROWS = 20;
export const MAX_ROWS = 100;
export const DEFAULT_DEPTH = 3;
export const MAX_DEPTH = 6;
/** Cap of a `raw_json` / `context` slice in characters. */
export const RAW_JSON_CHARS = 12_000;
/** Cap of an error message inlined in a result. */
export const MESSAGE_CHARS = 400;
/** Cap of any single inlined string. */
export const STRING_CHARS = 2_000;
export const TRUNCATED_MARK = "[truncated]";

/** Most unresolved UTxOs a tool answer lists inline. */
export const MISSING_UTXOS_SHOWN = 20;

/**
 * `missing_utxos` of a tool answer: the first MISSING_UTXOS_SHOWN refs, `missing_utxos_total` when there
 * are any, and `missing_utxos_truncated` when some were cut. Spread it into the answer.
 */
export function missingUtxosView(missing: readonly string[] | undefined): { missing_utxos: string[]; missing_utxos_total?: number; missing_utxos_truncated?: true } {
  const all = missing ?? [];
  if (all.length === 0) return { missing_utxos: [] };
  const cut = all.length > MISSING_UTXOS_SHOWN;
  return { missing_utxos: all.slice(0, MISSING_UTXOS_SHOWN), missing_utxos_total: all.length, ...(cut ? { missing_utxos_truncated: true as const } : {}) };
}

/** First `limit` items plus how many were dropped. */
export function truncateArray<T>(items: readonly T[], limit: number): { items: T[]; truncated_count: number } {
  if (items.length <= limit) return { items: Array.from(items), truncated_count: 0 };
  return { items: items.slice(0, limit), truncated_count: items.length - limit };
}

/** `text` cut to `maxChars` and suffixed with `… [truncated]` (fits `maxChars` whenever it is >= 13). */
export function capString(text: string, maxChars: number = STRING_CHARS): string {
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - TRUNCATED_MARK.length - 2);
  return `${text.slice(0, keep)}… ${TRUNCATED_MARK}`;
}

export interface Page<T> {
  rows: T[];
  total: number;
  offset: number;
  limit: number;
  next_offset?: number;
  truncated?: boolean;
}

/** Slice `items[offset, offset+limit)`; `next_offset` when more follow. */
export function pageOf<T>(items: readonly T[], offset = 0, limit = DEFAULT_ROWS): Page<T> {
  const safeOffset = Math.max(0, Math.min(offset, items.length));
  const safeLimit = Math.max(1, Math.min(limit, MAX_ROWS));
  const rows = items.slice(safeOffset, safeOffset + safeLimit);
  const page: Page<T> = { rows, total: items.length, offset: safeOffset, limit: safeLimit };
  if (safeOffset + rows.length < items.length) {
    page.next_offset = safeOffset + rows.length;
    page.truncated = true;
  }
  return page;
}

/** Characters of rows one tx_inspect page may carry (the answer adds its envelope and links: < 32k in total). */
export const ROW_PAGE_CHARS = 24_000;

export interface CharPage<T> extends Page<T> {
  /** The page stopped before `limit` rows because the next row would pass the character budget. */
  page_cut?: true;
}

function jsonChars(value: unknown): number {
  try {
    return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v))?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * `pageOf` with a character budget: rows are taken in order until `limit` or until the next row
 * would push the page past `budget` (the first row is always taken, so a page is never empty).
 * A cut page sets `page_cut` and a `next_offset` that continues right after it.
 */
export function pageWithinChars<T>(items: readonly T[], offset = 0, limit = DEFAULT_ROWS, budget = ROW_PAGE_CHARS): CharPage<T> {
  const page: CharPage<T> = pageOf(items, offset, limit);
  let used = 0;
  let kept = 0;
  for (const row of page.rows) {
    const size = jsonChars(row) + 1;
    if (kept > 0 && used + size > budget) break;
    used += size;
    kept++;
  }
  if (kept < page.rows.length) {
    page.rows = page.rows.slice(0, kept);
    page.next_offset = page.offset + kept;
    page.truncated = true;
    page.page_cut = true;
  }
  return page;
}

function summaryOf(value: unknown): string {
  if (Array.isArray(value)) return `[… ${value.length} items]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return `{… ${keys.length} ${keys.length === 1 ? "key" : "keys"}${keys.length > 0 ? ": " + keys.slice(0, 6).join(", ") + (keys.length > 6 ? ", …" : "") : ""}}`;
  }
  return String(value);
}

/**
 * Copy of `value` with every node deeper than `depth` replaced by a one-line summary
 * (`[… N items]`, `{… N keys: a, b}`), strings capped, bigint -> decimal string. Iterative.
 */
export function pruneDepth(value: unknown, depth: number = DEFAULT_DEPTH, stringChars: number = STRING_CHARS): unknown {
  const wire = toWireJson(value);
  if (wire === null || typeof wire !== "object") return typeof wire === "string" ? capString(wire, stringChars) : wire;
  if (depth <= 0) return summaryOf(wire);
  const root: Record<string, unknown> | unknown[] = Array.isArray(wire) ? [] : {};
  const stack: Array<{ source: Record<string, unknown> | unknown[]; target: Record<string, unknown> | unknown[]; level: number }> = [
    { source: wire as Record<string, unknown> | unknown[], target: root, level: 1 },
  ];
  while (stack.length > 0) {
    const { source, target, level } = stack.pop()!;
    const entries: Array<[string | number, unknown]> = Array.isArray(source)
      ? source.map((v, i) => [i, v] as [number, unknown])
      : Object.entries(source);
    for (const [key, raw] of entries) {
      let out: unknown;
      if (raw !== null && typeof raw === "object") {
        if (level >= depth) {
          out = summaryOf(raw);
        } else {
          const child: Record<string, unknown> | unknown[] = Array.isArray(raw) ? [] : {};
          stack.push({ source: raw as Record<string, unknown> | unknown[], target: child, level: level + 1 });
          out = child;
        }
      } else if (typeof raw === "string") {
        out = capString(raw, stringChars);
      } else {
        out = raw;
      }
      if (Array.isArray(target)) target[key as number] = out;
      else target[key as string] = out;
    }
  }
  return root;
}

/** Length of the compact JSON of `value`. */
export function jsonSizeOf(value: unknown): number {
  return JSON.stringify(toWireJson(value)).length;
}

/**
 * Shrink `value` until its compact JSON fits `maxChars`: first by pruning depth (from `depth`
 * down to 1), finally by cutting the JSON text itself. Reports whether anything was lost.
 */
export function capJson(value: unknown, maxChars: number = RAW_JSON_CHARS, depth: number = MAX_DEPTH): { value: unknown; truncated: boolean; depth: number } {
  let current = pruneDepth(value, depth);
  let text = JSON.stringify(current);
  let usedDepth = depth;
  let truncated = false;
  while (text.length > maxChars && usedDepth > 1) {
    usedDepth--;
    current = pruneDepth(value, usedDepth);
    text = JSON.stringify(current);
    truncated = true;
  }
  if (text.length > maxChars) {
    return { value: capString(text, maxChars), truncated: true, depth: usedDepth };
  }
  return { value: current, truncated: truncated || usedDepth < depth, depth: usedDepth };
}

// ---------- paths ----------

/** Split a JSON pointer (`/a/b/0`) or dotted path (`a.b.0`, `tx_info.V2.inputs.2`) into segments. */
export function parsePath(path: string | undefined): string[] {
  if (!path) return [];
  const trimmed = path.trim();
  if (trimmed === "" || trimmed === "/" || trimmed === ".") return [];
  if (trimmed.startsWith("/")) {
    return trimmed
      .slice(1)
      .split("/")
      .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
  }
  return trimmed.split(".").filter((seg) => seg !== "");
}

export interface PathLookup {
  found: boolean;
  value: unknown;
  /** Segments that resolved. */
  resolved: string[];
  /** Keys available at the deepest node reached (a hint for the model when `found` is false). */
  available?: string[];
}

/** Walk `root` by `segments`; arrays accept numeric segments. */
export function lookupPath(root: unknown, segments: readonly string[]): PathLookup {
  let node: unknown = root;
  const resolved: string[] = [];
  for (const seg of segments) {
    if (node === null || typeof node !== "object") {
      return { found: false, value: undefined, resolved };
    }
    if (Array.isArray(node)) {
      const index = Number.parseInt(seg, 10);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) {
        return { found: false, value: undefined, resolved, available: [`0..${node.length - 1}`] };
      }
      node = node[index];
    } else {
      const record = node as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, seg)) {
        return { found: false, value: undefined, resolved, available: Object.keys(record).slice(0, 50) };
      }
      node = record[seg];
    }
    resolved.push(seg);
  }
  return { found: true, value: node, resolved };
}

/**
 * ScriptContext paths: the typed JSON nests `tx_info` under its language key (`tx_info.V2.inputs.2`).
 * Accept `tx_info.inputs.2` and bare `inputs.2` as well, so `tx_redeemer(part='context')` and
 * `debug_inspect(what='context')` answer the same path grammar. Anything already explicit, or that
 * names a root key (`purpose`, `redeemer`, `script_context_version`), is returned unchanged.
 */
export function normalizeContextPath(context: Record<string, unknown>, segments: string[]): string[] {
  const txInfo = context.tx_info;
  const versionKey = txInfo !== null && typeof txInfo === "object" ? Object.keys(txInfo as Record<string, unknown>).find((k) => /^V[123]$/.test(k)) : undefined;
  if (!versionKey) return segments;
  if (segments.length === 0) return segments;
  if (segments[0] === "tx_info") {
    if (segments.length === 1 || /^V[123]$/.test(segments[1]!)) return segments;
    return ["tx_info", versionKey, ...segments.slice(1)];
  }
  const head = segments[0]!;
  if (head in context) return segments;
  const inner = (txInfo as Record<string, unknown>)[versionKey];
  if (inner !== null && typeof inner === "object" && head in (inner as Record<string, unknown>)) return ["tx_info", versionKey, ...segments];
  return segments;
}

/** Child keys (objects) or `0..N-1` (arrays) of a node, for "where to look next" hints. */
export function childKeys(value: unknown, limit = 50): string[] | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return value.length === 0 ? [] : [`0..${value.length - 1}`];
  return Object.keys(value as Record<string, unknown>).slice(0, limit);
}

// ---------- input normalisation ----------

export type InputKind = "hex" | "base64" | "cli_envelope" | "bech32" | "text";

const HEX_PATTERN = /^[0-9a-fA-F]*$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/=_-]+$/;
const BECH32_PATTERN = /^[a-z0-9]{1,83}1[02-9ac-hj-np-z]{6,}$/i;

export function isHexString(text: string): boolean {
  return text.length % 2 === 0 && HEX_PATTERN.test(text);
}

/**
 * Bring a byte-carrying input to lowercase hex: hex (with optional `0x` and whitespace), base64 /
 * base64url, or a cardano-cli JSON text envelope (`{"cborHex": "…"}`). Bech32 strings are passed
 * through with `kind: 'bech32'` (the library decodes them itself); anything else is `text` — including
 * an odd-length run of hex digits, which the tools explain as a broken hex string.
 */
export function normalizeBytesInput(input: string): { value: string; kind: InputKind } {
  let text = input.trim();
  if (text.startsWith("{")) {
    try {
      const envelope = JSON.parse(text) as { cborHex?: unknown };
      if (typeof envelope.cborHex === "string") {
        return { value: envelope.cborHex.replace(/\s+/g, "").toLowerCase(), kind: "cli_envelope" };
      }
    } catch {
      // not an envelope
    }
  }
  text = text.replace(/\s+/g, "");
  if (text.startsWith("0x") || text.startsWith("0X")) text = text.slice(2);
  if (text.length > 0 && isHexString(text)) return { value: text.toLowerCase(), kind: "hex" };
  // Hex digits only but an odd count: a broken hex string, not base64 (a base64 text made of hex digits alone is vanishingly unlikely).
  if (text.length > 2 && HEX_PATTERN.test(text)) return { value: input.trim(), kind: "text" };
  if (BECH32_PATTERN.test(text) && text.includes("1") && /^(addr|stake|script|ed25519|drep|cc_|pool|asset|xpub|xprv|acct|vk|sk)/i.test(text)) {
    return { value: text.toLowerCase(), kind: "bech32" };
  }
  if (BASE64_PATTERN.test(text) && text.length % 4 !== 1) {
    try {
      const bytes = Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      if (bytes.length > 0) {
        const roundTrip = bytes.toString("base64").replace(/=+$/, "");
        if (roundTrip === text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "")) {
          return { value: bytes.toString("hex"), kind: "base64" };
        }
      }
    } catch {
      // not base64
    }
  }
  return { value: input.trim(), kind: "text" };
}

/** Clamp an optional integer argument to `[min, max]` with a default. */
export function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
