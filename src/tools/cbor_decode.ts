// cbor_decode: decode any Cardano CBOR — typed (auto or a named ledger type) or the positional raw
// tree. When no typed decoder accepts the bytes, the answer says what they are structurally and which
// Conway CDDL root comes closest (cbor_validate has the full diagnosis; CDDL-annotated decoding lives
// there too).
//
// Size discipline: 10k characters by default; an explicit depth >= 6 unlocks 100k characters (the
// tool's `_meta` allows 120k). The answer is fitted breadth-first (src/cbor/budget.ts): shallow levels
// are shown whole and only the deepest bulk is folded; `depth` caps the levels, none = as many as
// fit. as='spans' lists every node of the positional tree with its byte span, paged. Integers in the
// decoded value are decimal strings, bytes are hex. Library refusals (nesting deeper than the typed
// decoders' 64 levels, native-script levels not counted) are reported as code `unexamined` for a named type, and
// as `unexamined: {reason:'nesting', limit: 64, depth?}` on the positional answer of as='auto'
// (`limit: 32768` when even the positional decoder stopped) — the bytes were not judged invalid, they
// were not examined. When some types decoded and others were skipped on that bound (deep native
// scripts), the typed answer stands and `not_tried` names the skipped types.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { CborDecodeResult } from "@cardananium/cquisitor-lib";

import { CBOR_WALKER_DEPTH_LIMIT, NATIVE_SCRIPT_DEPTH_LIMIT, TYPED_DECODING_DEPTH_LIMIT } from "@cardananium/cquisitor-lib/util";

import { CANDIDATE_CAP, PERMISSIVE_RULES } from "../cbor/candidates.js";
import { abbreviatePath } from "@cardananium/cquisitor-lib/cddl/cddlError";

import { shapeStructuralError, type StructuralError } from "../cbor/diagnostics.js";
import { hintsFor } from "../cbor/hints.js";
import { DEFAULT_ERA, loadEraCddl, resolveSchemaInput } from "../cbor/presets.js";
import { budgetJson, budgetRaw } from "../cbor/budget.js";
import { byteStringValues, collectOddities, compactRaw, describeRawNode, lookupRawPath, rawRootKind, rawSpans, type Oddity, type OddityRow } from "../cbor/rawTree.js";
import { loadSchemaInfo } from "../cbor/schema.js";
import { runValidation, type ValidationRun } from "../cbor/validate.js";
import type { AppContext, ToolModule } from "../context.js";
import { integersAsStrings } from "../tx/dataView.js";
import { WorkerCallError } from "../workers/rpc.js";
import {
  childKeys,
  clampInt,
  fail,
  failFromError,
  isNestingRefusal,
  lookupPath,
  nestingRefusalLimit,
  MAX_DEPTH,
  normalizeBytesInput,
  ok,
  parsePath,
  ToolInputError,
  truncateArray,
  type InputKind,
  type ToolResult,
} from "./_shared.js";
import { TOOL_TEXT } from "./descriptions.js";

const T = TOOL_TEXT.cbor_decode;

export { compactRaw, type Oddity } from "../cbor/rawTree.js";

/** Default output cap (characters of the compact JSON of `value`). */
export const CBOR_DECODE_CHARS = 10_000;
/** Cap when the caller explicitly asks for `depth >= MAX_DEPTH`. */
export const CBOR_DECODE_LARGE_CHARS = 100_000;
/** Levels inlined when `depth` is omitted: as many as fit the character budget, up to the maximum a caller may ask for. */
export const CBOR_DECODE_DEFAULT_DEPTH = 8;
/** Rows of an `as='spans'` page. */
export const CBOR_SPANS_DEFAULT_ROWS = 50;
export const CBOR_SPANS_MAX_ROWS = 100;
/** Characters one `as='spans'` page may carry. */
const SPANS_PAGE_CHARS = 24_000;

/** Preferred pick when `as='auto'` yields several candidates (most specific / most useful first). */
export const AUTO_PREFERENCE = [
  "Transaction",
  "Block",
  "TransactionBody",
  "TransactionWitnessSet",
  "TransactionOutput",
  "TransactionUnspentOutput",
  "TransactionInput",
  "Redeemers",
  "Redeemer",
  "PlutusData",
  "Address",
  "RewardAddress",
  "BaseAddress",
  "EnterpriseAddress",
  "PointerAddress",
  "ByronAddress",
  "PlutusScript",
  "NativeScript",
  "Certificate",
  "AuxiliaryData",
  "GeneralTransactionMetadata",
  "TransactionMetadatum",
  "Value",
  "MultiAsset",
  "Mint",
  "ProtocolParamUpdate",
  "VotingProcedures",
  "VotingProposal",
  "Vkeywitness",
  "BootstrapWitness",
  "Ed25519KeyHash",
  "ScriptHash",
  "DataHash",
  "TransactionHash",
  "AssetName",
];

const HASH_KEYS = ["transaction_hash", "data_hash", "script_hash", "hash", "tx_hash", "policy_id"];

const inputSchema = z.object({
  hex: z
    .string()
    .min(1)
    .describe(T.params["hex"]),
  as: z
    .string()
    .optional()
    .describe(T.params["as"]),
  path: z.string().optional().describe(T.params["path"]),
  depth: z
    .number()
    .int()
    .min(1)
    .max(8)
    .optional()
    .describe(T.params["depth"]),
  offset: z.number().int().min(0).optional().describe(T.params["offset"]),
  limit: z.number().int().min(1).max(CBOR_SPANS_MAX_ROWS).optional().describe(T.params["limit"]),
  plutus_version: z.enum(["V1", "V2", "V3"]).optional().describe(T.params["plutus_version"]),
  schema: z.enum(["detailed", "basic"]).optional().describe(T.params["schema"]),
});

export type CborDecodeArgs = z.infer<typeof inputSchema>;

/** The bundled Conway CDDL text (src/assets/cddl/conway.cddl; every era at cardano-debug://cddl/{era}). */
export function loadConwayCddl(): string {
  return loadEraCddl(DEFAULT_ERA);
}

let decodableTypes: Promise<string[]> | null = null;
async function knownTypes(ctx: AppContext): Promise<string[]> {
  if (!decodableTypes) {
    decodableTypes = ctx.lib.decodableTypes().catch(() => {
      decodableTypes = null;
      return [];
    });
  }
  return decodableTypes;
}

// ---------- helpers ----------

function pickHash(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  for (const key of HASH_KEYS) {
    const v = rec[key];
    if (typeof v === "string" && /^[0-9a-f]{56,64}$/i.test(v)) return v.toLowerCase();
  }
  return undefined;
}

/** Library messages that mean "not examined" rather than "invalid". */
export function isRefusalMessage(message: string): boolean {
  return isNestingRefusal(message) || /nested more than|too deep|recursion limit/i.test(message);
}

/** Why nothing was examined: the bytes nest past a decoder's bound (`depth` when the scan measured it). */
export interface NestingUnexamined {
  reason: "nesting";
  /** The bound, in CBOR levels. */
  limit: number;
  /** Which decoders stopped: the typed ledger decoders, or even the positional (CBOR / CDDL) walker. */
  decoder: "typed" | "walker";
  depth?: number;
}

/** Names of the skipped types a typed answer lists; the rest is a count. */
const NOT_TRIED_NAMES = 12;

/**
 * Types not tried on the typed decoders' nesting bound while others decoded (the bytes hold deep
 * native scripts, which that bound does not count): the found candidates stand.
 */
export interface NestingNotTried {
  reason: "nesting";
  limit: number;
  decoder: "typed";
  depth?: number;
  count: number;
  types: string[];
  types_truncated_count?: number;
}

const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{20,}$/;

/** cardano-cli envelope `type` -> Plutus version (PlutusScriptV2, PlutusScriptV3, …). */
export function plutusVersionFromEnvelopeType(type: string | undefined): "V1" | "V2" | "V3" | undefined {
  const m = type ? /PlutusScriptV([123])/i.exec(type) : null;
  return m ? (`V${m[1]}` as "V1" | "V2" | "V3") : undefined;
}

function envelopeType(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw.trim()) as { type?: unknown };
    return typeof parsed.type === "string" ? parsed.type : undefined;
  } catch {
    return undefined;
  }
}

function zoomInto(value: unknown, path: string | undefined): { ok: true; value: unknown; path?: string } | { ok: false; result: ToolResult } {
  if (path !== undefined && path.trim().startsWith("$")) {
    return {
      ok: false,
      result: fail({
        code: "invalid_argument",
        argument: "path",
        message: `Path ${JSON.stringify(path)} is in the CBOR path grammar ($[0][2]), which names an item of the bytes: use it with as='raw' or as='spans'. A typed answer takes a JSON pointer (/transaction/body/fee) or a dotted path (transaction.body.fee).`,
      }),
    };
  }
  const segments = parsePath(path);
  if (segments.length === 0) return { ok: true, value };
  const lookup = lookupPath(value, segments);
  if (!lookup.found) {
    return {
      ok: false,
      result: fail({
        code: "path_not_found",
        message: `Path ${JSON.stringify(path)} does not exist; resolved up to ${JSON.stringify("/" + lookup.resolved.join("/"))}.`,
        resolved: "/" + lookup.resolved.join("/"),
        available: lookup.available ?? childKeys(lookupPath(value, lookup.resolved).value),
      }),
    };
  }
  return { ok: true, value: lookup.value, path: "/" + segments.join("/") };
}

/**
 * The positional tree (compact form) a `path` selects: a `$` path (`$[0][2]`, the grammar of
 * `as='spans'` rows and validator errors; tags transparent) resolves in the library's tree, anything
 * else is a JSON pointer / dotted path into the compact tree itself.
 */
function zoomRaw(root: unknown, path: string | undefined): { ok: true; tree: unknown; path?: string } | { ok: false; result: ToolResult } {
  const text = path?.trim();
  if (text === undefined || !text.startsWith("$")) {
    const zoom = zoomInto(compactRaw(root, [] as Oddity[]), path);
    return zoom.ok ? { ok: true, tree: zoom.value, path: zoom.path } : zoom;
  }
  const hit = lookupRawPath(root, text);
  if ("node" in hit) return { ok: true, tree: compactRaw(hit.node, [] as Oddity[]), path: text };
  return {
    ok: false,
    result: fail({
      code: "path_not_found",
      message: `Path ${JSON.stringify(text)} names no item; resolved up to ${JSON.stringify(hit.miss.resolved)}.`,
      resolved: hit.miss.resolved,
      available: hit.miss.available,
    }),
  };
}

/** Note for an answer fitted to its character budget, saying how to see the rest. */
function budgetNote(chars: number, spans: boolean): string {
  return `cut to the ${chars.toLocaleString("en-US")}-character budget, breadth-first: deeper nodes are folded (${spans ? "`collapsed: true`; `more` counts the children left out" : "a `{… N keys}` summary"}) and a long list shows its first items; zoom with path${spans ? ", or as='spans' for the byte span of every node" : ""}${chars < CBOR_DECODE_LARGE_CHARS ? `; an explicit depth >= ${MAX_DEPTH} raises the cap to ${CBOR_DECODE_LARGE_CHARS.toLocaleString("en-US")}` : ""}`;
}

function refusal(base: Record<string, unknown>, message: string, as: string): ToolResult {
  return fail({
    ...base,
    as,
    code: "unexamined",
    message: `Refused, not invalid: ${message}. The bytes were not examined by this decoder; use as='raw' for the positional tree (bounded by depth/path).`,
    refusal: message,
  });
}

// ---------- input notes / untyped answers ----------

/**
 * Why a string is not bytes (for `invalid_argument` messages): names the real fault, in a sentence that
 * reads after "…must be hex, base64 or a cardano-cli JSON envelope; ". Whitespace and a `0x` prefix are
 * dropped first, as the tools do, so "84 a4 0" is odd-length hex, not "hex broken by whitespace".
 */
export function describeTextInput(raw: string): string {
  const original = raw.trim();
  const text = original.replace(/\s+/g, "").replace(/^0x/i, "");
  if (text === "") return "the input is empty (nothing but whitespace or a bare 0x).";
  if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 1) {
    return `this is hex with an odd number of digits (${text.length})${/\s/.test(original) ? " once the whitespace is removed" : ""} — a nibble is missing or a character was lost.`;
  }
  if (normalizeBytesInput(original).kind === "bech32") return "this is a bech32 string, not CBOR bytes — cbor_decode decodes addresses, keys and hashes; pass the hex of the bytes to tools that take CBOR.";
  // positions below count in the text as given (a leading 0x blanked, whitespace kept)
  const body = original.replace(/^0x/i, "  ");
  const stray = /[^0-9a-fA-F\s]/.exec(body);
  if (stray && text.length >= 8 && text.replace(/[^0-9a-fA-F]/g, "").length >= text.length * 0.9) {
    return `this is hex with a stray character: ${JSON.stringify(stray[0])} at position ${stray.index + 1} is not a hex digit (0-9, a-f).`;
  }
  if (/^([a-z][a-z_]{0,15}1[02-9ac-hj-np-z]{6,}|[A-Z][A-Z_]{0,15}1[02-9AC-HJ-NP-Z]{6,})$/.test(text)) return "this looks like a bech32 string with an unknown prefix (addr, stake, script, pool, drep, … are accepted).";
  if (/^[A-Za-z0-9+/=_-]+$/.test(text)) return "this looks like base64 that does not round-trip (padding / stray characters) — check the copy.";
  const odd = /[^A-Za-z0-9+/=_\s-]/.exec(body);
  return odd ? `it holds ${JSON.stringify(odd[0])} at position ${odd.index + 1}, which hex, base64 and bech32 do not use.` : "this looks like none of them.";
}

/** Notes about how the input was read (base64 / envelope / non-hex), prepended to the answer's notes. */
export function inputNotes(raw: string, kind: InputKind | "base58"): string[] {
  const notes: string[] = [];
  const text = raw.trim();
  if (kind === "base64") {
    notes.push("input read as base64 and converted to hex");
    if (/^(0x)?[0-9a-fA-F]+$/.test(text) && text.replace(/^0x/i, "").length % 2 === 1) notes.push(`the text is also odd-length hex (${text.replace(/^0x/i, "").length} digits): if it was meant as hex, a nibble is missing`);
  }
  if (kind === "cli_envelope") notes.push("input read from a cardano-cli JSON envelope (cborHex)");
  if (kind === "base58") notes.push("input read as a base58 Byron address");
  if (kind === "text" && /^(0x)?[0-9a-fA-F]+$/.test(text) && text.replace(/^0x/i, "").length % 2 === 1) notes.push(`odd hex length (${text.replace(/^0x/i, "").length} digits)`);
  if (kind === "text" && /^[A-Za-z0-9+/=_-]+$/.test(text) && !/^[0-9a-fA-F]+$/.test(text)) notes.push("base64-looking text that does not round-trip");
  return notes;
}

export interface OdditiesSummary {
  total: number;
  by_kind: Record<string, number>;
  /** First rows in byte order (at most 4). */
  first: OddityRow[];
}

/**
 * What the positional decoder says about bytes a typed decoder accepted: the non-canonical encodings
 * (`oddities`) and — should a typed decoder ever accept bytes the positional decoder refuses (the
 * library checks well-formedness first, so this is a safety net) — the `structural` error with a note.
 */
export async function odditiesSummary(ctx: AppContext, hex: string, raw?: CborDecodeResult): Promise<{ oddities?: OdditiesSummary; structural?: StructuralError; note?: string }> {
  try {
    const result = raw ?? (await ctx.lib.cborToJson<CborDecodeResult>(hex));
    const root = result.ok ? result.value : result.partial;
    const out: { oddities?: OdditiesSummary; structural?: StructuralError; note?: string } = {};
    if (!result.ok) {
      out.structural = shapeStructuralError(result.error, result.partial, hex);
      out.note = typedDecoderToleranceNote(result.error, hex.length / 2);
    }
    if (root === undefined) return out;
    const { rows, total } = collectOddities(root);
    if (total > 0) {
      const by_kind: Record<string, number> = {};
      for (const row of rows) by_kind[row.kind] = (by_kind[row.kind] ?? 0) + 1;
      out.oddities = { total, by_kind, first: rows.slice(0, 4) };
    }
    return out;
  } catch {
    return {};
  }
}

/** Note for a typed answer whose bytes the positional decoder refuses (the typed decoder tolerated the fault). */
export function typedDecoderToleranceNote(error: { kind: string; message: string; offset?: number }, inputBytes: number): string {
  if (error.kind === "trailing_data" && typeof error.offset === "number") {
    const left = inputBytes - error.offset;
    return `${left} trailing byte(s) after the item ending at offset ${error.offset} were tolerated by the typed decoder — the node rejects them (cbor_validate reports trailing_data); the value and hash above cover only the first ${error.offset} bytes.`;
  }
  return `the typed decoder tolerated a fault the positional decoder reports (${error.kind}${typeof error.offset === "number" ? ` at offset ${error.offset}` : ""}: ${error.message}) — see structural; cbor_validate gives the precise diagnosis.`;
}

/**
 * Typed decoders that accept any CBOR tree of the right shape (PlutusData is any int / bytes / list /
 * map / constructor; metadata is any int / bytes / text / list / map): when they are the only
 * candidates for a map or array root, the bytes may as well be a broken ledger structure.
 */
export const PERMISSIVE_TYPES: ReadonlySet<string> = new Set(["PlutusData", "TransactionMetadatum", "MetadataMap", "MetadataList", "GeneralTransactionMetadata", "AuxiliaryData"]);

/**
 * For a typed pick that is only a permissive type (`PlutusData`, metadata) over a map / array root:
 * the closest Conway ledger rule (plutus_data and the metadata rules excluded from the search) and
 * its head mismatch, so a broken ledger structure that happens to parse as PlutusData is recognised.
 * Undefined when the bytes are not a map / array or the search finds nothing to say.
 */
async function ledgerLookalike(ctx: AppContext, hex: string, raw: CborDecodeResult, candidates: string[]): Promise<{ closest_schema: Record<string, unknown>; note: string } | undefined> {
  if (!raw.ok || candidates.length === 0 || !candidates.every((c) => PERMISSIVE_TYPES.has(c))) return undefined;
  const rootKind = rawRootKind(raw.value);
  if (rootKind !== "map" && rootKind !== "array") return undefined;
  try {
    const info = await loadSchemaInfo(ctx.lib, resolveSchemaInput(DEFAULT_ERA));
    const run = await runValidation(ctx.lib, hex, info, undefined, rootKind, CANDIDATE_CAP, PERMISSIVE_RULES, raw.value);
    if (!run.rule || !run.result) return undefined;
    const closest = closestSchemaBlock(info.source.label, run);
    const inputBytes = hex.length / 2;
    if (run.result.valid) {
      return { closest_schema: closest, note: `${candidates.join(" / ")} accept any CBOR tree of this shape; the bytes are also a valid Conway '${run.rule}' — cbor_validate(hex, rule='${run.rule}') shows them under that reading.` };
    }
    const best = run.candidates.find((c) => c.rule === run.rule);
    const unmatched = best?.unmatched_bytes;
    const share = typeof unmatched === "number" && inputBytes > 0 ? unmatched / inputBytes : 1;
    const head = run.result.error;
    const where = head.path ? ` at ${abbreviatePath(head.path)}` : "";
    const note =
      share <= 0.5
        ? `${candidates.join(" / ")} accept any CBOR tree of this shape, so the typed pick says little; the bytes look like a Conway '${run.rule}' that fails${where}: ${head.message} (the rule accounts for all but ${unmatched} of ${inputBytes} bytes) — cbor_validate(hex, rule='${run.rule}') for the full diagnosis.`
        : `${candidates.join(" / ")} accept any CBOR tree of this shape; the nearest Conway ledger rule, '${run.rule}', fails${where} (${head.message}) and accounts for few of the bytes (${unmatched} of ${inputBytes} unmatched), so the datum / metadata reading is the likelier one.`;
    return { closest_schema: { ...closest, lookalike: share <= 0.5 }, note };
  } catch {
    return undefined;
  }
}

/** The `closest_schema` block of a run (rule, candidates tried, head mismatch, next call). */
function closestSchemaBlock(label: string, run: ValidationRun): Record<string, unknown> {
  const head = run.result && !run.result.valid ? run.result.error : undefined;
  const best = run.candidates.find((c) => c.rule === run.rule);
  return {
    schema: label,
    rule: run.rule,
    // null: the closest rule stopped at an implementation limit, so no verdict
    valid: run.result?.valid === true ? true : best?.unexamined ? null : false,
    candidates_tried: run.candidates.length,
    candidates: run.candidates.map((c) => c.rule),
    ...(best?.unmatched_bytes !== undefined ? { unmatched_bytes: best.unmatched_bytes } : {}),
    ...(head ? { head: { kind: head.kind, message: head.message, expected: head.expected ?? null, path: head.path ? abbreviatePath(head.path) : null, byte_offset: head.byte_spans?.[0]?.offset ?? head.offset ?? null } } : {}),
    next: run.rule ? `cbor_validate(hex, rule='${run.rule}') for every mismatch with offsets, schema fragments and hints` : "cbor_validate(hex, cddl='<era>') with another era preset or your own schema",
  };
}

/**
 * `as='auto'` with no typed candidate: the positional tree (as `raw` would show it), `structural`
 * (decoder error, or the root shape with its oddities) and `closest_schema` (the Conway root that
 * matches deepest and its head mismatch) so the model learns what the bytes most likely are.
 */
async function untypedAnswer(
  ctx: AppContext,
  hex: string,
  base: Record<string, unknown>,
  candidates: string[],
  notes: string[],
  args: CborDecodeArgs,
  depth: number,
  maxChars: number,
  precomputed?: CborDecodeResult,
  typedUnexamined?: NestingUnexamined,
): Promise<ToolResult> {
  const raw = precomputed ?? (await ctx.lib.cborToJson<CborDecodeResult>(hex));
  const walkerStopped = !raw.ok && raw.error.kind === "nesting_too_deep";
  const unexamined: NestingUnexamined | undefined = walkerStopped
    ? { reason: "nesting", limit: nestingRefusalLimit(raw.error.message) || CBOR_WALKER_DEPTH_LIMIT, decoder: "walker" }
    : typedUnexamined;
  const root = raw.ok ? raw.value : raw.partial;
  const odd = collectOddities(root);
  const oddList = truncateArray(odd.rows, 16);
  const structural: Record<string, unknown> = raw.ok
    ? { ok: true, root: describeRawNode(raw.value), root_kind: rawRootKind(raw.value), oddities_total: odd.total || undefined }
    : { ok: false, error: shapeStructuralError(raw.error, raw.partial, hex), root: root !== undefined ? describeRawNode(root) : undefined };
  let closest: Record<string, unknown> | undefined;
  const hintContext: Parameters<typeof hintsFor>[0] = { oddities: odd.rows, inputBytes: hex.length / 2, byteStrings: byteStringValues(root), era: DEFAULT_ERA, rootKind: raw.ok ? rawRootKind(raw.value) : null };
  if (walkerStopped) {
    hintContext.structural = raw.error;
    notes.push(
      `not examined: the bytes nest deeper than the ${unexamined!.limit} levels even the positional decoder follows (an implementation limit, not a verdict on the bytes); the typed decoders and the CDDL roots were not tried; value is the prefix decoded before the limit`,
    );
  } else if (!raw.ok) {
    hintContext.structural = raw.error;
    notes.push("no typed decoder accepted these bytes and they are not well-formed CBOR; see structural.error");
  } else {
    try {
      const info = await loadSchemaInfo(ctx.lib, resolveSchemaInput(DEFAULT_ERA));
      const run = await runValidation(ctx.lib, hex, info, undefined, rawRootKind(raw.value), CANDIDATE_CAP, undefined, raw.value);
      const head = run.result && !run.result.valid ? run.result.error : undefined;
      closest = closestSchemaBlock(info.source.label, run);
      hintContext.rule = run.rule;
      hintContext.candidates = { tried: run.candidates.length, anyValid: run.candidates.some((c) => c.valid) };
      if (head) hintContext.errors = [head, ...(head.additional ?? []).slice(0, 5)].map((e) => ({ kind: e.kind, message: e.message, expected: e.expected ?? null, path: e.path || null, from_type_choice: e.from_type_choice === true }));
      if (unexamined) {
        notes.push(
          `the typed decoders were NOT tried: the bytes nest ${unexamined.depth !== undefined ? `${unexamined.depth.toLocaleString("en-US")} levels deep, ` : ""}deeper than their ${unexamined.limit}-level limit, a tag-24 payload (inline datum, script_ref) counting at the depth it is embedded at (an implementation limit, not a verdict on the bytes)${run.result?.valid ? `; they validate as Conway CDDL rule '${run.rule}'` : ""}; showing the positional CBOR tree and the closest Conway CDDL root`,
        );
      } else {
        notes.push(run.result?.valid ? `no typed decoder accepted these bytes, but they validate as Conway CDDL rule '${run.rule}'` : "no typed decoder accepted these bytes; showing the positional CBOR tree, the structural shape and the closest Conway CDDL root");
      }
    } catch (error) {
      closest = { schema: `preset:${DEFAULT_ERA}`, note: `candidate search failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const zoom = zoomRaw(root, args.path);
  if (!zoom.ok) return zoom.result;
  const capped = budgetRaw(zoom.tree, depth, maxChars);
  if (capped.truncated) notes.push(budgetNote(maxChars, true));
  return ok({
    ...base,
    as: "raw",
    candidates,
    ...(unexamined ? { unexamined } : {}),
    path: zoom.path,
    value: capped.value,
    ...(raw.ok ? {} : { partial: true }),
    structural,
    closest_schema: closest,
    oddities: oddList.items.length > 0 ? oddList.items : undefined,
    oddities_total: odd.total || undefined,
    oddities_truncated_count: oddList.truncated_count || undefined,
    hints: hintsFor(hintContext),
    truncated: capped.truncated || undefined,
    depth: capped.depth,
    notes: notes.length ? notes : undefined,
  });
}

// ---------- the tool ----------

export async function cborDecode(ctx: AppContext, args: CborDecodeArgs): Promise<ToolResult> {
  const depth = clampInt(args.depth, CBOR_DECODE_DEFAULT_DEPTH, 1, 8);
  const maxChars = args.depth !== undefined && args.depth >= MAX_DEPTH ? CBOR_DECODE_LARGE_CHARS : CBOR_DECODE_CHARS;
  const normalized = normalizeBytesInput(args.hex);
  const input = normalized.value;
  let kind: InputKind | "base58" = normalized.kind;
  if (kind === "text" && BASE58_PATTERN.test(input)) kind = "base58";
  if (kind === "text") {
    return fail({
      code: "invalid_argument",
      message: `hex must be hex, base64, a cardano-cli JSON envelope, a bech32 string or a base58 Byron address; ${describeTextInput(args.hex)}`,
      argument: "hex",
      input_kind: "text",
      input_notes: inputNotes(args.hex, kind),
    });
  }
  const isBytes = kind === "hex" || kind === "base64" || kind === "cli_envelope";
  const envelope = kind === "cli_envelope" ? envelopeType(args.hex) : undefined;
  const mode = (args.as ?? "auto").trim();
  const base: Record<string, unknown> = {
    input_kind: kind,
    ...(isBytes ? { input_bytes: input.length / 2 } : {}),
    ...(envelope ? { envelope_type: envelope } : {}),
  };
  const notes: string[] = inputNotes(args.hex, kind);
  let as = mode;

  try {
    let candidates: string[] | undefined;
    /** Types skipped on the nesting bound while others decoded (as='auto'). */
    let notTried: NestingNotTried | undefined;
    /** Positional decode of the bytes (auto mode): reused by the untyped answer and the oddities summary. */
    let raw: CborDecodeResult | undefined;

    if (mode.toLowerCase() === "auto") {
      if (isBytes) {
        // Structure first: bytes that are not one well-formed CBOR item (truncated, trailing data, …)
        // are refused by every typed decoder too, so they need no typed attempt.
        raw = await ctx.lib.cborToJson<CborDecodeResult>(input);
        if (!raw.ok) return await untypedAnswer(ctx, input, base, [], notes, args, depth, maxChars, raw);
      }
      let typedUnexamined: NestingUnexamined | undefined;
      try {
        const report = await ctx.lib.possibleTypesReport(input);
        candidates = report.types;
        const skipped = report.unexamined;
        if (skipped && report.types.length === 0) {
          typedUnexamined = { reason: "nesting", limit: skipped.limit, decoder: "typed", ...(skipped.depth !== undefined ? { depth: skipped.depth } : {}) };
        } else if (skipped) {
          const names = skipped.types ?? [];
          notTried = {
            reason: "nesting",
            limit: skipped.limit,
            decoder: "typed",
            ...(skipped.depth !== undefined ? { depth: skipped.depth } : {}),
            count: names.length,
            types: names.slice(0, NOT_TRIED_NAMES),
            ...(names.length > NOT_TRIED_NAMES ? { types_truncated_count: names.length - NOT_TRIED_NAMES } : {}),
          };
          notes.push(
            `${names.length} other ledger type${names.length === 1 ? " was" : "s were"} not tried (see not_tried): the bytes nest ${skipped.depth !== undefined ? `${skipped.depth.toLocaleString("en-US")} levels deep, ` : ""}past the typed decoders' ${skipped.limit}-level limit, which levels inside native scripts do not count toward (they may nest up to ${NATIVE_SCRIPT_DEPTH_LIMIT}); the listed candidates decoded`,
          );
        }
      } catch (error) {
        if (!isBytes || !(error instanceof WorkerCallError)) throw error;
        notes.push(`the typed decoders could not be probed (${error.fatal ? "the library trapped on these bytes" : error.message}); showing the positional tree`);
        return await untypedAnswer(ctx, input, base, [], notes, args, depth, maxChars, raw);
      }
      const envelopeVersion = plutusVersionFromEnvelopeType(envelope);
      const pick = envelopeVersion && candidates.includes("PlutusScript") ? "PlutusScript" : (AUTO_PREFERENCE.find((t) => candidates!.includes(t)) ?? candidates[0]);
      if (!pick) {
        if (!isBytes) return fail({ ...base, code: "undecodable", message: `No ledger type decodes this ${kind} string.`, candidates });
        // Past the typed decoders' nesting limit nothing was examined: say so instead of "no decoder accepted".
        return await untypedAnswer(ctx, input, base, candidates, notes, args, depth, maxChars, raw, typedUnexamined);
      } else {
        as = pick;
        if (candidates.length > 1) notes.push(`${candidates.length} ledger types accept these bytes; showing ${pick} — pass as=<TypeName> for another candidate`);
      }
    }

    // ---- raw ----
    if (as.toLowerCase() === "raw") {
      if (!isBytes) throw new ToolInputError(`as='raw' needs CBOR bytes, not a ${kind} string`, "as");
      raw ??= await ctx.lib.cborToJson<CborDecodeResult>(input);
      const root = raw.ok ? raw.value : raw.partial;
      const zoom = zoomRaw(root, args.path);
      if (!zoom.ok) return zoom.result;
      const capped = budgetRaw(zoom.tree, depth, maxChars);
      if (capped.truncated) notes.push(budgetNote(maxChars, true));
      const odd = collectOddities(root);
      const oddList = truncateArray(odd.rows, 32);
      return ok({
        ...base,
        as: "raw",
        candidates,
        path: zoom.path,
        root: root !== undefined ? describeRawNode(root) : undefined,
        value: capped.value,
        ...(raw.ok ? {} : { error: shapeStructuralError(raw.error, raw.partial, input), partial: true, hints: hintsFor({ structural: raw.error, oddities: odd.rows, inputBytes: input.length / 2 }) }),
        oddities: oddList.items.length > 0 ? oddList.items : undefined,
        oddities_total: odd.total || undefined,
        oddities_truncated_count: oddList.truncated_count || undefined,
        truncated: capped.truncated || undefined,
        depth: capped.depth,
        notes: notes.length ? notes : undefined,
      });
    }

    // ---- spans ----
    if (as.toLowerCase() === "spans") {
      if (!isBytes) throw new ToolInputError(`as='spans' needs CBOR bytes, not a ${kind} string`, "as");
      const from = args.path?.trim();
      if (from !== undefined && from !== "" && !from.startsWith("$")) {
        return fail({ ...base, code: "invalid_argument", argument: "path", message: `as='spans' takes a path in the CBOR path grammar ($, $[0][2], $.name), the one its rows and validator errors use; ${JSON.stringify(args.path)} is not one.` });
      }
      raw ??= await ctx.lib.cborToJson<CborDecodeResult>(input);
      const root = raw.ok ? raw.value : raw.partial;
      const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = clampInt(args.limit, CBOR_SPANS_DEFAULT_ROWS, 1, CBOR_SPANS_MAX_ROWS);
      const spans = rawSpans(root, { path: from, depth: args.depth, offset, limit });
      if ("miss" in spans) {
        return fail({ ...base, code: "path_not_found", message: `Path ${JSON.stringify(from)} names no item; resolved up to ${JSON.stringify(spans.miss.resolved)}.`, resolved: spans.miss.resolved, available: spans.miss.available });
      }
      let rows = spans.rows;
      let used = 0;
      let kept = 0;
      for (const row of rows) {
        const size = JSON.stringify(row).length + 1;
        if (kept > 0 && used + size > SPANS_PAGE_CHARS) break;
        used += size;
        kept++;
      }
      const pageCut = kept < rows.length;
      rows = rows.slice(0, kept);
      const next = offset + rows.length;
      const odd = collectOddities(root);
      return ok({
        ...base,
        as: "spans",
        path: from || "$",
        root: root !== undefined ? describeRawNode(root) : undefined,
        rows,
        total: spans.total,
        offset,
        limit,
        ...(next < spans.total ? { next_offset: next, truncated: true } : {}),
        ...(pageCut ? { page_cut: true } : {}),
        ...(args.depth !== undefined ? { depth: args.depth } : {}),
        ...(raw.ok ? {} : { error: shapeStructuralError(raw.error, raw.partial, input), partial: true, hints: hintsFor({ structural: raw.error, oddities: odd.rows, inputBytes: input.length / 2 }) }),
        ...(odd.total > 0 ? { oddities_total: odd.total } : {}),
        notes: notes.length ? notes : undefined,
      });
    }

    // ---- typed ----
    if (mode.toLowerCase() !== "auto") {
      const types = await knownTypes(ctx);
      const exact = types.find((t) => t === as) ?? types.find((t) => t.toLowerCase() === as.toLowerCase());
      if (!exact) {
        const needle = as.toLowerCase();
        const similar = types.filter((t) => t.toLowerCase().includes(needle) || needle.includes(t.toLowerCase())).slice(0, 10);
        return fail({
          ...base,
          code: "invalid_argument",
          argument: "as",
          message: `Unknown type '${as}'. Use as='auto' to list the candidates, 'raw', or one of the ${types.length} ledger type names${similar.length ? ` (similar: ${similar.join(", ")})` : ""}; CDDL rules go to cbor_validate(rule=…).`,
          similar,
        });
      }
      as = exact;
    }
    const params: { plutus_script_version?: number; plutus_data_schema?: "DetailedSchema" | "BasicConversions" } = {
      plutus_data_schema: args.schema === "basic" ? "BasicConversions" : "DetailedSchema",
    };
    let plutusVersion = args.plutus_version ?? plutusVersionFromEnvelopeType(envelope);
    if (as === "PlutusScript") {
      if (!plutusVersion) {
        plutusVersion = "V2";
        notes.push("plutus_version not given (and not in an envelope); script hash computed as V2 — pass plutus_version for the exact hash");
      } else if (!args.plutus_version) {
        notes.push(`plutus_version ${plutusVersion} taken from the cardano-cli envelope type`);
      }
    }
    if (plutusVersion) params.plutus_script_version = Number(plutusVersion.slice(1));
    const decoded = integersAsStrings(await ctx.lib.decodeType(input, as, params));
    const hash = pickHash(decoded);
    const zoom = zoomInto(decoded, args.path);
    if (!zoom.ok) return zoom.result;
    const capped = budgetJson(zoom.value, depth, maxChars);
    if (capped.truncated) notes.push(budgetNote(maxChars, false));
    const summary = isBytes ? await odditiesSummary(ctx, input, raw) : {};
    if (summary.note) notes.push(summary.note);
    const lookalike = candidates && raw ? await ledgerLookalike(ctx, input, raw, candidates) : undefined;
    if (lookalike) notes.push(lookalike.note);
    return ok({
      ...base,
      as,
      candidates,
      ...(notTried ? { not_tried: notTried } : {}),
      hash,
      ...(as === "PlutusScript" && plutusVersion ? { plutus_version: plutusVersion } : {}),
      path: zoom.path,
      value: capped.value,
      truncated: capped.truncated || undefined,
      depth: capped.depth,
      ...(summary.oddities ? { oddities: summary.oddities } : {}),
      ...(summary.structural ? { structural: summary.structural } : {}),
      ...(lookalike ? { closest_schema: lookalike.closest_schema } : {}),
      notes: notes.length ? notes : undefined,
    });
  } catch (error) {
    if (error instanceof RangeError) return refusal(base, `the document nests deeper than this host can shape (${error.message}; the library itself examines up to ${CBOR_WALKER_DEPTH_LIMIT} levels positionally, ${TYPED_DECODING_DEPTH_LIMIT} with the typed decoders)`, as);
    if (error instanceof WorkerCallError && !error.fatal) {
      if (isRefusalMessage(error.message)) return refusal(base, error.message, as);
      if (/Unsupported type/i.test(error.message)) {
        return fail({ ...base, code: "invalid_argument", argument: "as", message: `${error.message}. Use as='auto' to list candidates, or one of the ledger type names.` });
      }
      return fail({ ...base, code: "decode_failed", as, message: `${as} did not decode: ${error.message}. Try as='auto' for the candidates or as='raw' for the positional tree.` });
    }
    return failFromError(error, "internal_error", base);
  }
}

export const cborDecodeTool: ToolModule = {
  name: "cbor_decode",
  register(server: McpServer, ctx: AppContext) {
    server.registerTool(
      "cbor_decode",
      {
        title: T.title,
        description: T.description,
        inputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        _meta: { "anthropic/maxResultSizeChars": 120_000 },
      },
      async (args) => cborDecode(ctx, args),
    );
  },
};
