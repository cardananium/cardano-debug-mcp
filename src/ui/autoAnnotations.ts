// Annotations generated from what the server already knows: the validation of a loaded transaction
// (cquisitor transaction validator), a debug session's position (de-uplc-web debugger) and
// cbor_validate's error rows (cquisitor CBOR / CDDL tabs). Hints are kept short so links stay small.

import type { Annotation, CquisitorTarget, DeUplcTarget } from "@cardananium/cquisitor-lib/share";

import type { ErrorRow, StructuralError } from "../cbor/diagnostics.js";
import { errorHeadline, phaseLists, summarizeDiagnostics, type DiagnosticSummary } from "../chain/validate.js";
import type { EnginePosition } from "../engine/protocol.js";
import type { SessionRecord, SessionRegistry } from "../store/sessionRegistry.js";
import type { TxRecord } from "../store/txStore.js";
import { clip } from "./annotations.js";
import { resolveLocation } from "./txPaths.js";

/** Hint length of generated annotations. */
export const AUTO_HINT_CHARS = 400;
/** Generated annotations per link (the caller's own come first and count against MAX_ANNOTATIONS too). */
export const AUTO_MAX = 40;
/** Locations turned into tx_path targets per diagnostic: one `diagnostic` row plus the first location says it all. */
const LOCATIONS_PER_DIAGNOSTIC = 1;

type CqAnnotation = Annotation<CquisitorTarget>;

export interface IndexedDiagnostic extends DiagnosticSummary {
  /** Position in the cquisitor diagnostics list: phase-1 errors, phase-2 errors, phase-1 warnings, phase-2 warnings. */
  index: number;
  severity: "error" | "warning";
}

/** Every diagnostic of a validation, indexed in the order the cquisitor app lists them. */
export function indexedDiagnostics(record: TxRecord): IndexedDiagnostic[] {
  if (!record.validation) return [];
  const lists = phaseLists(record.validation);
  const groups: Array<[unknown[] | undefined, "error" | "warning"]> = [
    [lists.errors, "error"],
    [lists.phase2_errors, "error"],
    [lists.warnings, "warning"],
    [lists.phase2_warnings, "warning"],
  ];
  const out: IndexedDiagnostic[] = [];
  for (const [list, kind] of groups) {
    for (const item of summarizeDiagnostics(list, kind, record, Number.MAX_SAFE_INTEGER).items) out.push({ ...item, index: out.length, severity: kind });
  }
  return out;
}

/**
 * One `diagnostic` target per entry plus a `tx_path` for its first location, written the way the decoded transaction
 * (`decoded`) spells it; a location that is not in it is reduced to the closest enclosing place that is. They only
 * point (the name, no hint): the app shows each diagnostic's message and hint itself.
 */
export function diagnosticAnnotations(diagnostics: readonly IndexedDiagnostic[], decoded?: unknown): CqAnnotation[] {
  const out: CqAnnotation[] = [];
  for (const d of diagnostics) {
    const base = { label: clip(d.name, 80), severity: d.severity } as const;
    out.push({ target: { kind: "diagnostic", index: d.index }, ...base });
    for (const location of d.locations.slice(0, LOCATIONS_PER_DIAGNOSTIC)) {
      const path = resolveLocation(decoded, location);
      if (path) out.push({ target: { kind: "tx_path", path }, ...base });
    }
  }
  return out;
}

/** from='validation': every error / warning of the stored validation (none before tx_validate). */
export function validationAnnotations(record: TxRecord): { annotations: CqAnnotation[]; total: number } {
  const all = diagnosticAnnotations(indexedDiagnostics(record), record.decoded);
  return { annotations: all.slice(0, AUTO_MAX), total: all.length };
}

/** A failed redeemer in the cquisitor validator: its Plutus results row, then its diagnostics. */
export function redeemerAnnotations(record: TxRecord, ref: string, ev: { tag: string; index: number; success?: boolean | null; error?: string | null }): CqAnnotation[] {
  const own = indexedDiagnostics(record).filter((d) => d.redeemer === ref);
  if (ev.success && own.length === 0) return [];
  const headline = errorHeadline(ev.error ?? undefined) ?? own[0]?.message;
  const row: CqAnnotation = { target: { kind: "redeemer", tag: ev.tag, index: ev.index }, label: `${ref} failed`, severity: "error" };
  if (headline) row.hint = clip(headline, AUTO_HINT_CHARS);
  return [row, ...diagnosticAnnotations(own, record.decoded)].slice(0, AUTO_MAX);
}

/** Hot terms of the last debug_profile run of a session, kept for ui_link's from='profile'. */
export interface ProfileHot {
  outcome: string;
  over_budget: boolean;
  terms: Array<{ term_id: number | null; kind: string | null; uplc_line: number | null; hits: string; self_cpu: string; total_cpu: string; pct: number }>;
}

/** Hot terms marked per link: the few that explain the cost, not the whole table. */
export const PROFILE_TERMS = 5;

/** What debug_profile kept on the session, or undefined before the first profile. */
export function profileOfSession(session: SessionRecord): ProfileHot | undefined {
  const kept = session.extra.profileHot;
  return kept !== null && typeof kept === "object" ? (kept as ProfileHot) : undefined;
}

/** The profile of a session of this tx / redeemer (the first that ran one). */
export function profileOfRedeemer(sessions: SessionRegistry, txId: string, ref: string): ProfileHot | undefined {
  for (const session of sessions.list()) {
    if (session.txId !== txId || session.redeemer !== ref) continue;
    const kept = profileOfSession(session);
    if (kept) return kept;
  }
  return undefined;
}

/** The hottest terms of a profile as de-uplc-web annotations: rank and cpu share in the label, the counts in the hint. */
export function profileAnnotations(hot: ProfileHot): Annotation<DeUplcTarget>[] {
  const out: Annotation<DeUplcTarget>[] = [];
  for (const [i, t] of hot.terms.entries()) {
    if (out.length >= PROFILE_TERMS) break;
    if (t.term_id === null) continue;
    // no line number: the app numbers its term view differently from the session's UPLC listing
    out.push({
      target: { kind: "term", term_id: t.term_id },
      label: `hot #${i + 1}: ${t.pct}% of cpu`,
      hint: clip(`${t.kind ? `${t.kind}: ` : ""}${t.hits} hits, self cpu ${t.self_cpu}, with callees ${t.total_cpu}`, AUTO_HINT_CHARS),
      severity: i === 0 && hot.over_budget ? "warning" : "info",
    });
  }
  return out;
}

/** The term a position stands on (the last executed term between terms), or null. */
export function positionTerm(position: EnginePosition | undefined): number | null {
  if (!position) return null;
  return position.term_id ?? position.last_term_id ?? null;
}

/** The term a session's run stopped on with the script's error. */
export interface FailingTerm {
  termId: number;
  /** True when the machine stood ON this term (an explicit `(error)`, or a position that is a term, not the gap after a builtin): "fails here" is then literally right. */
  exact: boolean;
}

/**
 * The failing term of a session. `errorTermId` (kept by debug_run through rewinds) is the term of an
 * explicit `(error)`; a failure without a term of its own (a builtin or machine error, `errorTermId`
 * null) is known only while the session still stands on it: the last term before the failure.
 */
export function errorTermOfSession(session: SessionRecord): FailingTerm | undefined {
  if (typeof session.errorTermId === "number") return { termId: session.errorTermId, exact: true };
  const standing = session.lastStatus === "error" ? session.lastPosition : undefined;
  if (!standing) return undefined;
  const termId = positionTerm(standing);
  return termId === null ? undefined : { termId, exact: standing.term_id !== null };
}

/** What the sessions of a redeemer know of its failure: the term, or that the failure has none of its own. */
export function failureOfRedeemer(sessions: SessionRegistry, txId: string, ref: string): { failing?: FailingTerm & { session: SessionRecord }; withoutTerm: boolean } {
  let withoutTerm = false;
  for (const session of sessions.list()) {
    if (session.txId !== txId || session.redeemer !== ref) continue;
    const failing = errorTermOfSession(session);
    if (failing) return { failing: { ...failing, session }, withoutTerm: false };
    if (session.errorTermId === null) withoutTerm = true;
  }
  return { withoutTerm };
}

/** A session of this tx / redeemer that stopped on the script's error: its failing term. */
export function failingTermOf(sessions: SessionRegistry, txId: string, ref: string): (FailingTerm & { session: SessionRecord }) | undefined {
  return failureOfRedeemer(sessions, txId, ref).failing;
}

/** Why a failed redeemer has no failing-term annotation, as a note for the model. */
export function noFailingTermNote(withoutTerm: boolean): string {
  return withoutTerm
    ? "the run to the error failed without a term of its own (a builtin or machine error): there is no term to mark; dbg_id + from=['session'] right after debug_run(until='error') marks the last term before it"
    : "the validator does not report the failing term: debug_open + debug_run(until='error') on this redeemer, then call ui_link again (or use dbg_id with from=['session'])";
}

export function termAnnotation(termId: number, label: string, hint: string | undefined, severity: "error" | "info"): Annotation<DeUplcTarget> {
  const out: Annotation<DeUplcTarget> = { target: { kind: "term", term_id: termId }, label: clip(label, 80), severity };
  if (hint) out.hint = clip(hint, AUTO_HINT_CHARS);
  return out;
}

/** The error's first line plus the last trace: what a reader needs at the failing term, not the engine's state dump. */
export function failureHint(error: string | null | undefined, lastTrace?: string): string | undefined {
  return [errorHeadline(error), lastTrace ? `last trace: ${lastTrace}` : undefined].filter(Boolean).join("\n") || undefined;
}

/** The failing term as an annotation; `what` names the script ("spend:2", "the script"). */
export function failingTermAnnotation(failing: FailingTerm, what: string, error: string | null | undefined, lastTrace?: string): Annotation<DeUplcTarget> {
  const label = failing.exact ? `${what} fails here` : `last term before ${what} fails`;
  return termAnnotation(failing.termId, label, failureHint(error, lastTrace), "error");
}

/**
 * from='cbor_errors': a structural error, or per mismatch row its bytes and (embedded schema only) its
 * schema range. `inputBytes` clamps the structural span into the input: a truncated input reports the
 * error AT its length, one byte past the last.
 */
export function cborErrorAnnotations(input: { structural?: StructuralError; rows: readonly ErrorRow[]; withCddlRange: boolean; inputBytes?: number }): CqAnnotation[] {
  const out: CqAnnotation[] = [];
  const s = input.structural;
  if (s && s.offset !== null) {
    const end = input.inputBytes !== undefined && input.inputBytes > 0 ? input.inputBytes : undefined;
    const atEnd = end !== undefined && s.offset >= end;
    const offset = end !== undefined ? Math.min(s.offset, end - 1) : s.offset;
    const length = Math.max(1, end !== undefined ? Math.min(s.byte_length ?? 1, end - offset) : (s.byte_length ?? 1));
    out.push({ target: { kind: "cbor_span", offset, length }, label: atEnd ? "input ends here" : clip(s.kind, 80), hint: clip(atEnd ? `${s.kind}: ${s.message}` : s.message, AUTO_HINT_CHARS), severity: "error" });
  }
  for (const row of input.rows) {
    const label = clip(row.path_short ? `${row.kind} at ${row.path_short}` : row.kind, 80);
    const hint = clip([row.message, row.expected && !row.message.includes(row.expected) ? `expected ${row.expected}` : "", row.cddl_fragment ? `schema: ${row.cddl_fragment}` : ""].filter(Boolean).join("\n"), AUTO_HINT_CHARS);
    if (row.byte_offset !== null) out.push({ target: { kind: "cbor_span", offset: row.byte_offset, length: Math.max(1, row.byte_length ?? 1) }, label, hint, severity: "error" });
    else if (row.path) out.push({ target: { kind: "cbor_path", path: row.path }, label, hint, severity: "error" });
    if (input.withCddlRange && row.cddl_range) out.push({ target: { kind: "cddl_range", start: row.cddl_range[0], end: row.cddl_range[1] }, label: clip(`schema of ${row.path_short ?? row.kind}`, 80), hint, severity: "error" });
  }
  return out;
}
