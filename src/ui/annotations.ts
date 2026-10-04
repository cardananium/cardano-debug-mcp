// Annotations for UI links: validation of caller-supplied entries with a reason for every dropped
// one, the target kinds each app / tab accepts, and the focus mapping onto the kept entries.
// The lib's normalizer (run again by its encoders) then finds nothing to drop.

import {
  MAX_ANNOTATION_HINT,
  MAX_ANNOTATION_LABEL,
  MAX_ANNOTATIONS,
  isCquisitorTarget,
  isDeUplcTarget,
  type Annotation,
  type AnnotationSeverity,
  type CquisitorTarget,
  type DeUplcTarget,
} from "@cardananium/cquisitor-lib/share";
import type { TabId } from "@cardananium/cquisitor-lib/share";

export type UiApp = "cquisitor" | "de_uplc" | "decompiler";
export type AnyTarget = CquisitorTarget | DeUplcTarget;
export type AnyAnnotation = Annotation<AnyTarget>;

export interface DroppedAnnotation {
  index: number;
  reason: string;
  /** What would have resolved (valid range, nearby paths, names), when the server knows. */
  available?: unknown;
}

/**
 * The server's verdict on a well-formed target: undefined = fine or not checkable, `drop` = it does
 * not resolve (with a hint of what does), `target` = the same target spelled canonically.
 */
export type TargetVerdict = { drop: string; available?: unknown } | { target: AnyTarget } | undefined;
export type TargetResolver = (target: AnyTarget, rawIndex: number) => TargetVerdict;

/** Target kinds per cquisitor tab and per de-uplc-web view. */
export const KINDS_BY_TAB: Record<TabId, readonly string[]> = {
  "transaction-validator": ["tx_path", "diagnostic", "redeemer"],
  "cardano-cbor": [],
  "general-cbor": ["cbor_span", "cbor_path"],
  "cddl-validator": ["cbor_span", "cbor_path", "cddl_range", "cddl_rule"],
};
export const KINDS_BY_VIEW: Record<"de_uplc" | "decompiler", readonly string[]> = {
  de_uplc: ["term", "uplc_line"],
  decompiler: ["pseudo_line"],
};

const SEVERITIES: readonly AnnotationSeverity[] = ["error", "warning", "info"];
const CQUISITOR_KINDS = new Set(Object.values(KINDS_BY_TAB).flat());
const DE_UPLC_KINDS = new Set(Object.values(KINDS_BY_VIEW).flat());

export function acceptedKinds(app: UiApp, tab: TabId | undefined): readonly string[] {
  return app === "cquisitor" ? KINDS_BY_TAB[tab ?? "transaction-validator"] : KINDS_BY_VIEW[app];
}

/** Where a target kind has to fit, for messages: "the cddl-validator tab". */
function placeOf(app: UiApp, tab: TabId | undefined): string {
  return app === "cquisitor" ? `the ${tab ?? "transaction-validator"} tab` : app === "decompiler" ? "the decompiler view" : "the debugger view";
}

/** The kinds a place accepts, as the tail of an error message. */
function acceptedText(app: UiApp, tab: TabId | undefined): string {
  const kinds = acceptedKinds(app, tab);
  return kinds.length === 0 ? `${placeOf(app, tab)} takes no annotations` : `${placeOf(app, tab)} accepts: ${kinds.join(", ")}`;
}

/** Cut `text` to `max` characters (an ellipsis marks the cut). */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function kindOf(target: unknown): string | undefined {
  return target !== null && typeof target === "object" && typeof (target as { kind?: unknown }).kind === "string" ? (target as { kind: string }).kind : undefined;
}

function malformedReason(kind: string, app: UiApp, tab: TabId | undefined): string {
  switch (kind) {
    case "tx_path":
    case "cbor_path":
      return `${kind} needs path: string`;
    case "diagnostic":
      return "diagnostic needs index (non-negative integer) or name (string), occurrence optional";
    case "redeemer":
      return "redeemer needs tag (string, e.g. Spend) and index (non-negative integer)";
    case "cbor_span":
      return "cbor_span needs offset (non-negative integer) and length (integer >= 1)";
    case "cddl_range":
      return "cddl_range needs start and end (non-negative integers, end > start)";
    case "cddl_rule":
      return "cddl_rule needs name: string";
    case "term":
      return "term needs term_id (non-negative integer)";
    case "uplc_line":
      return "uplc_line needs line (integer >= 1)";
    case "pseudo_line":
      return "pseudo_line needs line (integer >= 1), end_line >= line optional";
    default:
      return `unknown target kind '${kind}'; ${acceptedText(app, tab)}`;
  }
}

/**
 * Why one raw entry cannot be used for `app` / `tab`, or undefined when it can. Checks the entry
 * shape, the target (the lib's guards), the kind against the tab / view, label / hint / severity.
 */
export function rejectReason(raw: unknown, app: UiApp, tab: TabId | undefined): string | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "not an object";
  const entry = raw as Record<string, unknown>;
  const kind = kindOf(entry.target);
  if (!kind) return "target must be an object with a string kind";
  const isTarget = app === "cquisitor" ? isCquisitorTarget : isDeUplcTarget;
  const otherKinds = app === "cquisitor" ? DE_UPLC_KINDS : CQUISITOR_KINDS;
  if (!isTarget(entry.target)) {
    if (otherKinds.has(kind)) return `${kind} is a ${app === "cquisitor" ? "de-uplc-web" : "cquisitor"} target, not one of ${app}`;
    return malformedReason(kind, app, tab);
  }
  const kinds = acceptedKinds(app, tab);
  if (!kinds.includes(kind)) return `${kind} does not apply to ${placeOf(app, tab)} (accepted: ${kinds.join(", ") || "none"})`;
  if (entry.label !== undefined && typeof entry.label !== "string") return "label must be a string";
  if (entry.hint !== undefined && typeof entry.hint !== "string") return "hint must be a string";
  if (entry.severity !== undefined && !SEVERITIES.includes(entry.severity as AnnotationSeverity)) return `severity must be one of ${SEVERITIES.join(", ")}`;
  return undefined;
}

export interface CheckedAnnotations {
  annotations: AnyAnnotation[];
  dropped: DroppedAnnotation[];
  /** Index into `annotations`. */
  focus: number;
  /** Labels / hints cut to the length limits. */
  clipped: number;
}

/**
 * Validate `raw` (caller entries and generated ones, in that order) for `app` / `tab`. Entries past
 * MAX_ANNOTATIONS are dropped with a reason. `rawFocus` indexes `raw`: a dropped focused entry moves
 * focus to the next kept one (else the last kept one). `resolve` asks the server whether a well-formed
 * target points at something that exists (it may also rewrite the target canonically).
 */
export function checkAnnotations(raw: readonly unknown[], app: UiApp, tab: TabId | undefined, rawFocus = 0, resolve?: TargetResolver): CheckedAnnotations {
  const annotations: AnyAnnotation[] = [];
  const dropped: DroppedAnnotation[] = [];
  const keptRawIndex: number[] = [];
  let clipped = 0;
  raw.forEach((entry, index) => {
    if (index >= MAX_ANNOTATIONS) {
      dropped.push({ index, reason: `past the ${MAX_ANNOTATIONS}-annotation limit of a link` });
      return;
    }
    const reason = rejectReason(entry, app, tab);
    if (reason) {
      dropped.push({ index, reason });
      return;
    }
    const e = entry as { target: AnyTarget; label?: string; hint?: string; severity?: AnnotationSeverity };
    let target = e.target;
    const verdict = resolve?.(target, index);
    if (verdict && "drop" in verdict) {
      dropped.push({ index, reason: verdict.drop, ...(verdict.available !== undefined ? { available: verdict.available } : {}) });
      return;
    }
    if (verdict && "target" in verdict) target = verdict.target;
    const out: AnyAnnotation = { target };
    if (e.label) {
      out.label = clip(e.label, MAX_ANNOTATION_LABEL);
      if (out.label !== e.label) clipped++;
    }
    if (e.hint) {
      out.hint = clip(e.hint, MAX_ANNOTATION_HINT);
      if (out.hint !== e.hint) clipped++;
    }
    if (e.severity) out.severity = e.severity;
    annotations.push(out);
    keptRawIndex.push(index);
  });
  let focus = 0;
  if (annotations.length > 0) {
    const next = keptRawIndex.findIndex((i) => i >= rawFocus);
    focus = next >= 0 ? next : annotations.length - 1;
  }
  return { annotations, dropped, focus, clipped };
}
