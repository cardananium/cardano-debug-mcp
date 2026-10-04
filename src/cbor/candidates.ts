// Root-rule candidate selection for `cbor_validate` without a `rule`: which root rules of a schema
// can accept the document's root kind (lib: candidateRootRules / ruleRootKinds / cborRootKind),
// in what order they are tried, and which outcome is reported as the best match.

import { cborPathDepth } from "@cardananium/cquisitor-lib/cddl/cborPath";
import { isImplementationLimit } from "@cardananium/cquisitor-lib/cddl/cddlError";
import { candidateRootRules } from "@cardananium/cquisitor-lib/cddl/ruleSelection";
import type { CddlOutlineEntry } from "@cardananium/cquisitor-lib";

import { findMapEntry, type RawNode } from "./rawTree.js";

/** Root rules tried first when several admit the document's root kind (most useful objects first). */
export const PREFERRED_ROOTS: readonly string[] = [
  "transaction",
  "transaction_body",
  "transaction_witness_set",
  "transaction_output",
  "plutus_data",
  "block",
  "header",
  "redeemers",
  "redeemer",
  "certificate",
  "auxiliary_data",
  "script",
  "native_script",
  "transaction_input",
  "babbage_transaction_output",
  "alonzo_transaction_output",
  "post_alonzo_transaction_output",
  "legacy_transaction_output",
  "value",
  "multiasset",
  "mint",
  "protocol_param_update",
  "voting_procedures",
  "proposal_procedure",
  "gov_action",
  "datum_option",
  "script_ref",
  "metadata",
  "vkeywitness",
  "bootstrap_witness",
  "ex_units",
  "cost_models",
  "withdrawals",
  "address",
  "reward_account",
  "unit_interval",
  "big_int",
  "bounded_bytes",
];

/** How many candidate roots one auto run validates at most. */
export const CANDIDATE_CAP = 12;

/**
 * Candidates in trial order: the preferred roots (in `PREFERRED_ROOTS` order) that are among
 * `candidates`, then the rest in their given (declaration) order, capped.
 */
export function orderCandidates(candidates: readonly string[], cap: number = CANDIDATE_CAP, preferred: readonly string[] = PREFERRED_ROOTS): string[] {
  const set = new Set(candidates);
  const ordered: string[] = [];
  for (const name of preferred) if (set.has(name) && !ordered.includes(name)) ordered.push(name);
  for (const name of candidates) if (!ordered.includes(name)) ordered.push(name);
  return ordered.slice(0, Math.max(0, cap));
}

/**
 * Root rules of `outline` that may accept a document whose root kind is `rootKind`
 * (`cborRootKind` of the decoded root; null admits every root rule), in trial order. Empty when no
 * root rule can accept that kind.
 */
export function candidateRules(outline: CddlOutlineEntry[], source: string, rootKind: string | null, cap: number = CANDIDATE_CAP): string[] {
  return orderCandidates(candidateRootRules(outline, source, "", rootKind), cap);
}

/** Depth of a validator path (`$` = 0, `$[0][2]` = 2); -1 when the path is missing. */
export function pathDepth(path: string | null | undefined): number {
  if (typeof path !== "string" || path === "") return -1;
  try {
    return cborPathDepth(path);
  } catch {
    return path.split(/[.[]/).length - 1;
  }
}

export interface CandidateOutcome {
  rule: string;
  valid: boolean;
  /** Head diagnostic of a failed run (absent when valid). */
  head?: { kind: string; path: string | null; message: string };
  /** Bytes the head problem blames (the refused item, or a key's entry); absent when valid or unknown. */
  head_bytes?: number;
  /** Deduplicated problems the run reported (head + additional + truncated count); absent when valid. */
  problems?: number;
  /** Bytes of the document the rule could not account for (union of the blamed spans); absent when valid. */
  unmatched_bytes?: number;
  /** True when the run stopped at an implementation limit: it says nothing about the bytes. */
  unexamined?: boolean;
}

interface RawError {
  kind?: string;
  path?: string;
  message?: string;
  byte_spans?: Array<{ offset: number; length: number }>;
  anchor_spans?: Array<{ offset: number; length: number }>;
  additional?: RawError[];
  additional_truncated?: number;
}

interface RawOutcome {
  valid: boolean;
  error?: RawError;
}

/**
 * Messages that fault the content of a container whose kind the rule accepted: a key that is
 * missing or not allowed, an array with the wrong number of slots. The container itself matched,
 * so only its header (`byte_spans`) is blamed, never the whole item.
 */
export const CONTENT_FAULT = /unexpected key|missing key|with length \d+, got|must have (exactly|at least)/i;

const UNEXPECTED_KEY = /unexpected key:? (.+)$/;

/**
 * Span a problem blames: for an unexpected key the whole entry (key and value — what the rule
 * could not account for; the validator's `anchor_spans` are the key and the whole value, the
 * positional tree the fallback); for another content fault (missing key / slot count) the header
 * the validator points at (`byte_spans`); for a mismatching item the whole item (`anchor_spans`),
 * since none of it matched the rule.
 */
export function blamedSpans(error: RawError, rawRoot?: unknown): Array<{ offset: number; length: number }> {
  const message = error.message ?? "";
  if (UNEXPECTED_KEY.test(message)) {
    const key = error.byte_spans?.[0] ?? error.anchor_spans?.[0];
    let value = error.anchor_spans?.[1] ?? error.byte_spans?.[1];
    if (key && !value && rawRoot !== undefined) {
      const entry = findMapEntry(rawRoot, error.path);
      const v = entry?.value as RawNode | undefined;
      value = v?.struct_position_info ?? v?.position_info;
    }
    if (key && value) return [{ offset: key.offset, length: Math.max(1, value.offset + value.length - key.offset) }];
    if (key) return [{ offset: key.offset, length: Math.max(1, key.length) }];
  }
  const contentFault = CONTENT_FAULT.test(message);
  const spans = contentFault ? (error.byte_spans ?? error.anchor_spans) : (error.anchor_spans ?? error.byte_spans);
  return (spans ?? []).filter((s) => Number.isFinite(s.offset) && Number.isFinite(s.length) && s.length > 0);
}

/** Total length of the union of the spans every problem in the error set blames (`rawRoot`: the positional tree, for key entries). */
export function unmatchedBytes(error: RawError, rawRoot?: unknown): number {
  const spans: Array<{ offset: number; length: number }> = [];
  const stack: RawError[] = [error];
  let visited = 0;
  while (stack.length > 0 && visited < 400) {
    const e = stack.pop()!;
    visited++;
    spans.push(...blamedSpans(e, rawRoot));
    if (Array.isArray(e.additional)) for (const a of e.additional) stack.push(a);
  }
  spans.sort((a, b) => a.offset - b.offset);
  let total = 0;
  let end = -1;
  for (const span of spans) {
    const from = Math.max(span.offset, end);
    const to = span.offset + span.length;
    if (to > from) total += to - from;
    end = Math.max(end, to);
  }
  return total;
}

/** `CandidateOutcome` from a raw `validate_cbor_against_cddl` answer (`rawRoot`: the positional tree of the bytes, when at hand). */
export function outcomeOf(rule: string, result: RawOutcome | undefined | null, rawRoot?: unknown): CandidateOutcome {
  if (result?.valid) return { rule, valid: true };
  const error = result?.error ?? {};
  const kind = error.kind ?? "generic";
  const headSpans = blamedSpans(error, rawRoot);
  const outcome: CandidateOutcome = {
    rule,
    valid: false,
    head: { kind, path: error.path || null, message: error.message ?? "" },
    problems: 1 + (Array.isArray(error.additional) ? error.additional.length : 0) + (typeof error.additional_truncated === "number" ? error.additional_truncated : 0),
    unmatched_bytes: unmatchedBytes(error, rawRoot),
  };
  if (headSpans.length > 0) outcome.head_bytes = headSpans.reduce((sum, s) => sum + s.length, 0);
  if (isImplementationLimit(kind)) outcome.unexamined = true;
  return outcome;
}

const DATA_FAILURE_KINDS = new Set(["mismatch", "map_cut", "generic"]);

/**
 * Roots that accept any CBOR tree of their shape (PlutusData is any int / bytes / list / map /
 * constructor; metadata any int / bytes / text / list / map): getting deep into a document says
 * nothing about it, and a failure only ever concerns a tag or a byte-string length.
 */
export const PERMISSIVE_RULES: ReadonlySet<string> = new Set(["plutus_data", "metadata", "metadatum", "transaction_metadatum", "auxiliary_data", "auxiliary_data_array", "auxiliary_data_map"]);

/** A key missing from the root map: the keys that are present were examined, the run got inside. */
const ROOT_MISSING_KEY = /missing key/i;
/** The root container has the right kind but the wrong number of slots: its content was not examined. */
const ROOT_SLOT_COUNT = /with length \d+, got|must have (exactly|at least)/i;

/**
 * True when a failed outcome refused the root item's kind (`expected map …, got array` at `$`):
 * the rule says nothing about the content. A content fault at the root (`map missing key: 2`,
 * `expected array with length 4, got 3`) is not a refusal — the rule accepted the root's kind.
 */
export function isRootKindRefusal(outcome: CandidateOutcome): boolean {
  if (outcome.valid || !outcome.head) return false;
  return pathDepth(outcome.head.path) <= 0 && !CONTENT_FAULT.test(outcome.head.message);
}

/** Tiers of `candidateScore` (higher = closer match). */
export const SCORE_TIER = {
  valid: 8,
  /** The run got inside the root and accounts for most of the bytes (unmatched ≤ half of the input). */
  inside: 6,
  /** The root has the rule's kind but the wrong slot count; its content was not examined. */
  rootSlotCount: 5,
  /** The run got inside the root but blames most of the document (a shallow fit: `certificate` on `[map, map, null]`). */
  insideWeak: 4,
  /** A permissive root (plutus_data, metadata) failed: it accepts any tree, so the depth reached says nothing. */
  permissive: 3,
  /** The root item's kind was refused (`expected map, got array` at `$`). */
  rootKind: 0,
  /** Schema / bytes fault: says nothing about the rule. */
  schema: -1,
  unexamined: -2,
} as const;

/** Share of the input the head may refuse as one container before the fit counts as weak. */
export const STRONG_FIT_UNMATCHED_SHARE = 0.5;
/** The head refused a whole container (`got map(4 entries)`, `got #6.258(array(1 items))`) rather than a scalar. */
const REFUSED_CONTAINER = /got (indefinite )?(map|array)\(|got #6\.\d+\((indefinite )?(map|array)\(/;

/**
 * Rank of a failed outcome, higher = closer match (`inputBytes`: the document size, for the fit
 * share). Runs that stopped at an implementation limit or failed on the schema / the bytes
 * themselves say nothing about the rule and rank last; a run that refused the root item's kind
 * (path `$`, `expected X, got Y`) ranks next; then a permissive root (plutus_data, metadata: they
 * accept any tree, so their failures only concern tags and lengths); then a run whose head refused a
 * whole container holding more than half of the bytes (`certificate` on `[body, {}, null]`:
 * `expected value 0, got map(4 entries)`); then a rule that accepted the root's kind but faulted its
 * slot count (`expected array with length 4, got 3`: the content was never examined); then every
 * other run that got inside — a mismatch below `$` (a scalar mismatch counts however large the
 * item: `expected bstr, got text` on a 66-byte hex string is a strong fit), or a key missing from the
 * root map (the present keys were examined). Within a tier the rule that leaves the fewest bytes
 * unaccounted for wins, then the deeper head, then fewer problems.
 */
export function candidateScore(outcome: CandidateOutcome, inputBytes?: number): [number, number, number, number] {
  if (outcome.valid) return [SCORE_TIER.valid, 0, 0, 0];
  const kind = outcome.head?.kind ?? "generic";
  if (outcome.unexamined) return [SCORE_TIER.unexamined, 0, 0, 0];
  if (!DATA_FAILURE_KINDS.has(kind)) return [SCORE_TIER.schema, 0, 0, 0];
  if (isRootKindRefusal(outcome)) return [SCORE_TIER.rootKind, 0, 0, 0];
  const depth = Math.max(0, pathDepth(outcome.head?.path));
  const unmatched = outcome.unmatched_bytes ?? Number.MAX_SAFE_INTEGER;
  const rest: [number, number, number] = [-unmatched, depth, -(outcome.problems ?? 1)];
  if (PERMISSIVE_RULES.has(outcome.rule)) return [SCORE_TIER.permissive, ...rest];
  const message = outcome.head?.message ?? "";
  if (depth <= 0 && ROOT_SLOT_COUNT.test(message) && !ROOT_MISSING_KEY.test(message)) return [SCORE_TIER.rootSlotCount, ...rest];
  const weak = inputBytes !== undefined && inputBytes > 0 && (outcome.head_bytes ?? 0) > inputBytes * STRONG_FIT_UNMATCHED_SHARE && REFUSED_CONTAINER.test(message);
  return [weak ? SCORE_TIER.insideWeak : SCORE_TIER.inside, ...rest];
}

function compareScores(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

/**
 * The outcome to report: the first valid one; otherwise the first run that stopped at an
 * implementation limit (it may be the valid reading — no failed run rules it out, so the verdict is
 * "not examined", never "invalid"); otherwise the failed run with the best `candidateScore` (ties
 * keep trial order). `inputBytes` (the document size) tells a strong fit from a weak one.
 */
export function pickBestCandidate(outcomes: readonly CandidateOutcome[], inputBytes?: number): CandidateOutcome | undefined {
  const valid = outcomes.find((o) => o.valid);
  if (valid) return valid;
  const unexamined = outcomes.find((o) => o.unexamined);
  if (unexamined) return unexamined;
  let best: CandidateOutcome | undefined;
  let bestScore: readonly number[] | undefined;
  for (const outcome of outcomes) {
    const score = candidateScore(outcome, inputBytes);
    if (!bestScore || compareScores(score, bestScore) > 0) {
      best = outcome;
      bestScore = score;
    }
  }
  return best ?? outcomes[0];
}
