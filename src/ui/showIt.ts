// `show_it`: the ready ui_link call a failing (or costly) answer carries. The targets are filled in from what the answer
// knows (the failing rule and its place, the failing term, the failing byte); the cards' text is left to the model, which
// writes it as the story the user reads after the explanation: what is here, why it matters, the fix. A generated card has
// no such text, so the call asks for written ones.

import type { EnginePosition } from "../engine/protocol.js";
import type { TxRecord } from "../store/txStore.js";
import { libTagFromPurpose } from "../vocab/purpose.js";
import { indexedDiagnostics, positionTerm, type IndexedDiagnostic } from "./autoAnnotations.js";
import { resolveLocation } from "./txPaths.js";

/** Failing diagnostics turned into cards: each one a rule card and a place card, so a few errors stay a short story. */
const TX_ERRORS = 2;
const PROFILE_CARDS = 3;

type Severity = "error" | "info";

interface Card {
  target: Record<string, unknown>;
  label: string;
  hint: string;
  severity: Severity;
}

const STORY =
  "WRITE the cards, in reading order (cause, then effect): label = what is here in a few words, hint = why it matters and the fix, one to three sentences; the app already shows messages, ids and amounts, so do not repeat them.";

function card(target: Record<string, unknown>, label: string, hint: string, severity: Severity = "error"): Card {
  return { target, label: `<${label}>`, hint: `<${hint}>`, severity };
}

function offer(what: string, call: string, cards: readonly Card[], tail = ""): string {
  return `After you explain ${what}, offer to show it; on yes call ${call.replace("CARDS", JSON.stringify(cards))}. ${STORY}${tail ? ` ${tail}` : ""}`;
}

/** Where a failing diagnostic sits in the transaction: its redeemer row, else the decoded field its location names. */
function placeOf(record: TxRecord, d: IndexedDiagnostic): Record<string, unknown> | undefined {
  const redeemer = d.redeemer ? record.redeemerTargets.find((t) => t.ref === d.redeemer) : undefined;
  if (redeemer) return { kind: "redeemer", tag: libTagFromPurpose(redeemer.purpose), index: redeemer.index };
  const location = d.locations[0];
  const path = location ? resolveLocation(record.decoded, location) : undefined;
  return path ? { kind: "tx_path", path } : undefined;
}

/** A failing transaction: the rule and the place of its first errors. */
export function showItTx(record: TxRecord): string {
  const cards: Card[] = [];
  for (const d of indexedDiagnostics(record).filter((x) => x.severity === "error").slice(0, TX_ERRORS)) {
    cards.push(card({ kind: "diagnostic", index: d.index }, "the rule in plain words", "why it fires here"));
    const place = placeOf(record, d);
    if (place) cards.push(card(place, "what this is", "what is wrong with it, the fix"));
  }
  return offer(
    "where it breaks",
    `ui_link(app='cquisitor', tx_id='${record.txId}', open=true, annotations=CARDS)`,
    cards,
    "For a failing script, find the cause with debug_run(until='error', stop_before=true): its answer carries the call for the debugger.",
  );
}

/** A session stopped on the script's error: the failing term. */
export function showItDebug(dbgId: string, position: EnginePosition | undefined): string {
  const termId = positionTerm(position);
  const cards = termId === null ? [] : [card({ kind: "term", term_id: termId }, "what this check is", "why it fails: the values, expected against actual, the fix")];
  return offer(
    "the failure",
    `ui_link(app='de_uplc', dbg_id='${dbgId}', open=true, annotations=CARDS)`,
    cards,
    "Add a card (`term` with the term_id from debug_inspect) for each value the check compared, before the failing one.",
  );
}

/** A profile: the hottest terms. */
export function showItProfile(dbgId: string, hotTermIds: ReadonlyArray<number | null>): string {
  const cards = hotTermIds
    .filter((id): id is number => id !== null)
    .slice(0, PROFILE_CARDS)
    .map((id) => card({ kind: "term", term_id: id }, "what this part does", "why it costs: calls, work per call, what would save it", "info"));
  return offer(
    "where the cost sits",
    `ui_link(app='de_uplc', dbg_id='${dbgId}', open=true, annotations=CARDS)`,
    cards,
    "`from=['profile']` marks the five hottest terms with their share only.",
  );
}

/** Bad bytes: the failing byte (or path). */
export function showItCbor(first?: { offset?: number | null; length?: number | null; path?: string | null }): string {
  const target =
    first?.offset !== undefined && first.offset !== null
      ? { kind: "cbor_span", offset: first.offset, length: Math.max(1, first.length ?? 1) }
      : first?.path
        ? { kind: "cbor_path", path: first.path }
        : undefined;
  const cards = target ? [card(target, "what is at this byte", "what the schema expects here, what is found, the fix")] : [];
  return offer(
    "what is wrong",
    "ui_link(app='cquisitor', cbor=<the same bytes>, cddl / preset and rule as here, open=true, annotations=CARDS)",
    cards,
    "`from=['cbor_errors']` marks every error row with its name only.",
  );
}
