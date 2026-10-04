// One validation run as `cbor_validate` and `cbor_decode` (closest_schema) share it: an explicit
// rule, or the candidate search over the root rules that admit the document's root kind.

import type { CborValidationResult } from "@cardananium/cquisitor-lib";
import { abbreviatePath } from "@cardananium/cquisitor-lib/cddl/cddlError";

import type { LibApi } from "../lib.js";
import { CANDIDATE_CAP, candidateRules, outcomeOf, pickBestCandidate, type CandidateOutcome } from "./candidates.js";
import type { SchemaInfo } from "./schema.js";

export interface CandidateReport {
  rule: string;
  valid: boolean;
  head_kind?: string;
  head_path?: string;
  /** Problems the run reported (head + additional), for a failed candidate. */
  problems?: number;
  /** Bytes the rule could not account for (union of blamed spans), for a failed candidate. */
  unmatched_bytes?: number;
  /** The run stopped at an implementation limit: it says nothing about the bytes. */
  unexamined?: true;
}

export interface ValidationRun {
  /** The rule the verdict is about (null when no candidate could be tried). */
  rule: string | null;
  /** Every candidate tried, in trial order (just the explicit rule when one was given). */
  candidates: CandidateReport[];
  /** Raw library answer for `rule`. */
  result: CborValidationResult | null;
  /** True when `rule` was picked by the search rather than given. */
  auto: boolean;
  /** Root rules that admit the document's root kind (the search space; 0 for an explicit rule). */
  admitted: number;
  /** Admissible roots the cap left out (only counted when no candidate was valid). */
  untried: number;
}

export function reportOf(outcome: CandidateOutcome): CandidateReport {
  const report: CandidateReport = { rule: outcome.rule, valid: outcome.valid };
  if (outcome.head) {
    report.head_kind = outcome.head.kind;
    // abbreviated: a path through a deep document runs to tens of thousands of segments
    if (outcome.head.path) report.head_path = abbreviatePath(outcome.head.path);
    if (outcome.problems !== undefined) report.problems = outcome.problems;
    if (outcome.unmatched_bytes !== undefined) report.unmatched_bytes = outcome.unmatched_bytes;
  }
  if (outcome.unexamined) report.unexamined = true;
  return report;
}

/**
 * Validate `hex` against `rule`, or — when `rule` is undefined — against the candidate roots for
 * `rootKind` (trial order from `candidateRules`, minus `exclude`), stopping at the first valid one.
 * `rawRoot` (the positional tree of `hex`) sharpens the unmatched-byte counts. Runs are serial (the
 * lib worker is single-threaded).
 */
export async function runValidation(lib: LibApi, hex: string, info: SchemaInfo, rule: string | undefined, rootKind: string | null, cap: number = CANDIDATE_CAP, exclude?: ReadonlySet<string>, rawRoot?: unknown): Promise<ValidationRun> {
  if (rule !== undefined) {
    const result = await lib.validateAgainstCddl(hex, info.source.text, rule);
    return { rule, candidates: [reportOf(outcomeOf(rule, result, rawRoot))], result, auto: false, admitted: 0, untried: 0 };
  }
  const admitted = candidateRules(info.outline, info.source.text, rootKind, Number.MAX_SAFE_INTEGER).filter((name) => !exclude?.has(name));
  const trial = admitted.slice(0, cap);
  const outcomes: CandidateOutcome[] = [];
  const results = new Map<string, CborValidationResult>();
  for (const candidate of trial) {
    const result = await lib.validateAgainstCddl(hex, info.source.text, candidate);
    results.set(candidate, result);
    outcomes.push(outcomeOf(candidate, result, rawRoot));
    if (result.valid) break;
  }
  const best = pickBestCandidate(outcomes, hex.length / 2);
  return {
    rule: best?.rule ?? null,
    candidates: outcomes.map(reportOf),
    result: best ? (results.get(best.rule) ?? null) : null,
    auto: true,
    admitted: admitted.length,
    untried: best?.valid ? 0 : Math.max(0, admitted.length - trial.length),
  };
}
