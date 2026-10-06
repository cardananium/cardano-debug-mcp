// Validation: run `validate_transaction_js` in the lib worker under the watchdog, split the result
// into the TxStore record (byte-heavy per-redeemer fields kept server-side, never inlined), compute
// script identities, and reduce everything to the small summaries tx_validate / tx_redeemer show.

import { findError } from "../docs/index.js";
import type { EvalRedeemerResultWire, LibApi, ValidationResultWire } from "../lib.js";
import type { OnChainInfo, RedeemerTarget, StoredValidation, TxRecord } from "../store/txStore.js";
import { capString, MESSAGE_CHARS, missingUtxosView, pruneDepth, ToolInputError } from "../tools/_shared.js";
import { integersAsStrings } from "../tx/dataView.js";
import { bigintFromWire } from "../vocab/json.js";
import { formatRedeemerRef, refFromLibTag } from "../vocab/redeemerRef.js";
import { WorkerTimeoutError } from "../workers/rpc.js";
import { stringifyForLib } from "./contextCodec.js";
import { readableActionIds, readableActionIdValues } from "./govId.js";
import { isIncludedBytes } from "./onChain.js";
import { capturedAtIso, chainStateOf, type ChainState } from "./state.js";

export type Verdict = "valid" | "phase1_failed" | "phase2_failed" | "both_failed" | "incomplete_context" | "timeout" | "not_examined";

/**
 * Warnings for parts of a transaction the library did not examine because a validation-context UTxO
 * nests past what it reads: an implementation limit, not a finding about the transaction.
 * `NativeScriptNotExamined` (phase 1): whether a native script reference is satisfied was not checked.
 * `ScriptContextNotExamined` (phase 2): no script context was built, so the redeemers were not run.
 */
export const NOT_EXAMINED_WARNINGS: ReadonlySet<string> = new Set(["NativeScriptNotExamined", "ScriptContextNotExamined"]);

/** The not-examined warnings of a stored result, phase 1 then phase 2. */
export function notExaminedWarnings(stored: StoredValidation): unknown[] {
  const lists = phaseLists(stored);
  return [...lists.warnings, ...lists.phase2_warnings].filter((w) => NOT_EXAMINED_WARNINGS.has(variantName((w as Record<string, unknown> | null)?.warning)));
}

/** Honest statement of what the two engines implement today (cardano-debug://server/info `semantics`; tx_validate does not repeat it per call). */
export const SEMANTICS = {
  validator: "protocol-aware builtins and costs: V1/V2 B at PV9-10, D at PV11+; V3 C at PV9-10, E at PV11+",
  stepper: "same protocol-aware builtins and costs as the validator",
  note: "Both engines (uplc v1.1.24) run the PV11 builtins (expModInteger, dropList, BLS multiScalarMul, CIP-153 values) but not the array builtins (lengthOfArray, listToArray, indexArray: script decode fails). protocol_version and cost models come from the same epoch parameters for both, so on the same script path their ex-units agree.",
} as const;

export interface RunValidationOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  phases?: "both" | "phase1";
}

/** Canonical ref of an eval result (`Cert` -> publish, `Reward` -> withdraw). */
export function refOfEval(ev: Pick<EvalRedeemerResultWire, "tag" | "index">): string {
  return formatRedeemerRef(refFromLibTag(ev.tag, Number(ev.index)));
}

/** Split a ValidationResult: eval results move to a Map by canonical ref; the rest stays as-is. */
export function splitValidation(result: ValidationResultWire, elapsedMs: number, phases: "both" | "phase1" = "both"): StoredValidation {
  const { eval_redeemer_results, ...rest } = result;
  const redeemers = new Map<string, EvalRedeemerResultWire>();
  for (const ev of eval_redeemer_results ?? []) redeemers.set(refOfEval(ev), ev);
  return { result: rest, redeemers, at: Date.now(), elapsedMs, phases };
}

/** The phase lists of a stored result (`Omit` over an index-signature type loses the known keys). */
export function phaseLists(stored: StoredValidation): Pick<ValidationResultWire, "errors" | "warnings" | "phase2_errors" | "phase2_warnings"> {
  const r = stored.result as Record<string, unknown>;
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  return { errors: list(r.errors), warnings: list(r.warnings), phase2_errors: list(r.phase2_errors), phase2_warnings: list(r.phase2_warnings) };
}

/** Rebuild the wire ValidationResult (for bundles / resources). */
export function joinValidation(stored: StoredValidation): ValidationResultWire {
  return { ...stored.result, eval_redeemer_results: Array.from(stored.redeemers.values()) } as ValidationResultWire;
}

/** Run the validation for a record whose chain state carries a complete context. */
export async function runValidation(lib: LibApi, record: TxRecord, options: RunValidationOptions = {}): Promise<StoredValidation> {
  const state = chainStateOf(record);
  if (!state?.context) throw new ToolInputError("The transaction has no chain context yet; tx_load it with a network (or a bundle) first.", "tx_id");
  const ctxJson = stringifyForLib(state.context);
  const started = Date.now();
  try {
    const result = await lib.validateTx(record.txHex, ctxJson, { timeoutMs: options.timeoutMs, signal: options.signal });
    const stored = splitValidation(result, Date.now() - started, options.phases ?? "both");
    record.validation = stored;
    delete state.timedOut;
    delete state.lastError;
    await computeScriptHashes(lib, record, state);
    return stored;
  } catch (error) {
    if (error instanceof WorkerTimeoutError) state.timedOut = { timeout_ms: error.timeoutMs, at: Date.now() };
    else state.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

/** Attach a ValidationResult that arrived with a bundle. */
export async function attachValidation(lib: LibApi, record: TxRecord, validation: ValidationResultWire): Promise<void> {
  record.validation = splitValidation(validation, 0, "both");
  const state = chainStateOf(record);
  if (state) await computeScriptHashes(lib, record, state);
}

/** Script hash + version per redeemer from the eval results' `script_bytes` (the result has no hash field). */
export async function computeScriptHashes(lib: LibApi, record: TxRecord, state: ChainState): Promise<void> {
  const stored = record.validation;
  if (!stored) return;
  for (const [ref, ev] of stored.redeemers) {
    if (state.scriptHashes[ref]) continue;
    const version = ev.plutus_version;
    if (!ev.script_bytes || !version) continue;
    try {
      const decoded = await lib.decodeType<{ script_hash?: string }>(ev.script_bytes, "PlutusScript", { plutus_script_version: Number(version.slice(1)) });
      if (decoded?.script_hash) state.scriptHashes[ref] = { script_hash: decoded.script_hash.toLowerCase(), plutus_version: version };
    } catch {
      // leave unknown; the summary says so
    }
  }
  for (const target of record.redeemerTargets) {
    const info = state.scriptHashes[target.ref];
    if (info) {
      target.script_hash = info.script_hash;
      target.plutus_version = info.plutus_version;
    }
  }
}

// ---------- verdict ----------

export function verdictOf(record: TxRecord): Verdict | undefined {
  const state = chainStateOf(record);
  if (state && state.missingUtxos.length > 0) return "incomplete_context";
  if (!record.validation) return state?.timedOut ? "timeout" : undefined;
  const result = phaseLists(record.validation);
  const phase1Failed = result.errors.length > 0;
  const phase2Failed = result.phase2_errors.length > 0 || Array.from(record.validation.redeemers.values()).some((r) => !r.success);
  if (phase1Failed && phase2Failed) return "both_failed";
  if (phase1Failed) return "phase1_failed";
  if (phase2Failed) return "phase2_failed";
  // No failure found, but part of the tx was not examined: no "valid" verdict for it.
  if (notExaminedWarnings(record.validation).length > 0) return "not_examined";
  return "valid";
}

// ---------- error summaries ----------

type Json = Record<string, unknown>;

/** Variant name of a serde externally-tagged enum value (`"InputSetEmptyUTxO"` or `{FeeTooSmallUTxO: {...}}`). */
export function variantName(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value as Json);
    if (keys.length === 1) return keys[0]!;
  }
  return "Unknown";
}

export function variantData(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value as Json);
    if (keys.length === 1) return (value as Json)[keys[0]!];
  }
  return undefined;
}

export interface DiagnosticSummary {
  name: string;
  message: string;
  locations: string[];
  hint?: string;
  data?: unknown;
  /** Canonical redeemer ref when a location points at a witness-set redeemer. */
  redeemer?: string;
}

const REDEEMER_LOCATION = /witness_set\.redeemers[.[](\d+)/;

/** `transaction.witness_set.redeemers.3` -> canonical ref of the 3rd redeemer. */
export function redeemerRefFromLocations(locations: readonly string[], record: TxRecord): string | undefined {
  for (const location of locations) {
    const m = REDEEMER_LOCATION.exec(location);
    if (!m) continue;
    const witnessIndex = Number.parseInt(m[1]!, 10);
    const target = record.redeemerTargets.find((t) => t.witness_index === witnessIndex);
    if (target) return target.ref;
  }
  return undefined;
}

function summarizeDiagnostic(raw: unknown, kind: "error" | "warning", record: TxRecord): DiagnosticSummary {
  const r = (raw ?? {}) as Json;
  const variant = r[kind];
  const message = typeof r[`${kind}_message`] === "string" ? (r[`${kind}_message`] as string) : variantName(variant);
  const locations = Array.isArray(r.locations) ? r.locations.filter((l): l is string => typeof l === "string") : [];
  const out: DiagnosticSummary = { name: variantName(variant), message: capString(readableActionIds(message, record.network), MESSAGE_CHARS), locations: locations.slice(0, 8) };
  if (typeof r.hint === "string" && r.hint) out.hint = capString(r.hint, MESSAGE_CHARS);
  const data = variantData(variant);
  if (data !== undefined) out.data = pruneDepth(integersAsStrings(readableActionIdValues(data, record.network)), 4, MESSAGE_CHARS);
  const ref = redeemerRefFromLocations(locations, record) ?? redeemerRefFromData(data, record);
  if (ref) out.redeemer = ref;
  return out;
}

/** Phase-2 payloads carry `{tag, index}` for redeemer-specific variants. */
function redeemerRefFromData(data: unknown, record: TxRecord): string | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const d = data as Json;
  if (typeof d.tag === "string" && d.index !== undefined) {
    try {
      const ref = formatRedeemerRef(refFromLibTag(d.tag, Number(d.index)));
      if (record.redeemerTargets.some((t) => t.ref === ref)) return ref;
    } catch {
      // unknown tag
    }
  }
  return undefined;
}

export function summarizeDiagnostics(list: unknown[] | undefined, kind: "error" | "warning", record: TxRecord, limit = 25): { items: DiagnosticSummary[]; total: number } {
  const all = list ?? [];
  return { items: all.slice(0, limit).map((d) => summarizeDiagnostic(d, kind, record)), total: all.length };
}

// ---------- ex-units ----------

export interface ExUnitsPair {
  mem: string;
  steps: string;
}

export interface ExUnitsSummary {
  declared: ExUnitsPair;
  calculated?: ExUnitsPair;
  /** calculated - declared (negative = slack). */
  delta?: ExUnitsPair;
  delta_pct?: { mem: number; steps: number };
  /** `not_run`: the script was never evaluated (no ScriptContext could be built, no script): nothing to compare. */
  verdict: "exact" | "slack" | "over_budget" | "not_run" | "unknown";
}

/**
 * The script was never evaluated: a failed result with zero calculated units. Every CEK run spends
 * at least the machine's startup cost, so zero means the library stopped before the machine — the
 * ledger refused the ScriptContext (UnreadableOutput, a Conway certificate or field under
 * PlutusV1/V2, a Byron address, …) or the script / cost model was missing.
 */
export function neverEvaluated(ev: Pick<EvalRedeemerResultWire, "success" | "calculated_ex_units">): boolean {
  const calculated = pair(ev.calculated_ex_units);
  return !ev.success && calculated !== undefined && calculated.mem === 0n && calculated.steps === 0n;
}

function pair(value: unknown): { mem: bigint; steps: bigint } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as Json;
  const mem = bigintFromWire(v.mem);
  const steps = bigintFromWire(v.steps);
  if (mem === undefined || steps === undefined) return undefined;
  return { mem, steps };
}

function pct(delta: bigint, base: bigint): number {
  if (base === 0n) return delta === 0n ? 0 : 100;
  return Number((delta * 10_000n) / base) / 100;
}

export function exUnitsSummary(ev: EvalRedeemerResultWire): ExUnitsSummary {
  const declared = pair(ev.provided_ex_units) ?? { mem: 0n, steps: 0n };
  const calculated = pair(ev.calculated_ex_units);
  const out: ExUnitsSummary = { declared: { mem: declared.mem.toString(), steps: declared.steps.toString() }, verdict: "unknown" };
  if (!calculated) return out;
  if (neverEvaluated(ev)) {
    out.verdict = "not_run";
    return out;
  }
  const delta = { mem: calculated.mem - declared.mem, steps: calculated.steps - declared.steps };
  out.calculated = { mem: calculated.mem.toString(), steps: calculated.steps.toString() };
  out.delta = { mem: delta.mem.toString(), steps: delta.steps.toString() };
  out.delta_pct = { mem: pct(delta.mem, declared.mem), steps: pct(delta.steps, declared.steps) };
  out.verdict = delta.mem === 0n && delta.steps === 0n ? "exact" : delta.mem > 0n || delta.steps > 0n ? "over_budget" : "slack";
  return out;
}

// ---------- per-redeemer summary ----------

export type Fidelity = "full" | "program-only";

export function fidelityOf(ev: EvalRedeemerResultWire): Fidelity {
  return ev.script_bytes && ev.plutus_version && ev.script_context_bytes ? "full" : "program-only";
}

export function errorHeadline(error: string | null | undefined, maxChars = 200): string | undefined {
  if (!error) return undefined;
  const firstLine = error.split("\n").find((l) => l.trim() !== "") ?? error;
  return capString(firstLine.trim(), maxChars);
}

export interface RedeemerValidationSummary {
  ref: string;
  witness_index: number;
  target: string;
  script_hash?: string;
  plutus_version?: string;
  success: boolean;
  error_headline?: string;
  ex_units: ExUnitsSummary;
  trace_count: number;
  last_trace?: string;
  fidelity: Fidelity;
}

export function redeemerSummary(record: TxRecord, target: RedeemerTarget, ev: EvalRedeemerResultWire): RedeemerValidationSummary {
  const state = chainStateOf(record);
  const info = state?.scriptHashes[target.ref];
  const logs = Array.isArray(ev.logs) ? ev.logs : [];
  const out: RedeemerValidationSummary = {
    ref: target.ref,
    witness_index: target.witness_index,
    target: target.target,
    script_hash: info?.script_hash ?? target.script_hash,
    plutus_version: info?.plutus_version ?? ev.plutus_version ?? target.plutus_version,
    success: Boolean(ev.success),
    ex_units: exUnitsSummary(ev),
    trace_count: logs.length,
    fidelity: fidelityOf(ev),
  };
  const headline = errorHeadline(ev.error);
  if (headline) out.error_headline = headline;
  if (logs.length > 0) out.last_trace = capString(String(logs[logs.length - 1]), 200);
  return out;
}

/** Eval result for a canonical ref; also resolves refs given as witness index through the record. */
export function evalFor(record: TxRecord, ref: string): EvalRedeemerResultWire | undefined {
  return record.validation?.redeemers.get(ref);
}

// ---------- on-chain transactions ----------

/**
 * The `on_chain` block of tx_load / tx_validate: where the tx sits and how that shaped the verdict.
 * `txHex` are the record's bytes: the ledger's verdict (accepted, is_valid) belongs to the included
 * bytes only, while the replay point applies to every tx of the same body.
 */
export function onChainView(at: OnChainInfo, txHex: string, verdict?: Verdict): Record<string, unknown> {
  const asIncluded = isIncludedBytes(at, txHex);
  const out: Record<string, unknown> = {
    slot: at.slot,
    epoch: at.epoch,
    block_height: at.block_height,
    is_valid: at.is_valid,
    ...(asIncluded !== undefined ? { bytes_as_included: asIncluded } : {}),
    replayed_at: "inclusion slot, inclusion-epoch parameters, own inputs unspent (see defaults_applied)",
  };
  const failing = verdict !== undefined && verdict !== "valid" && verdict !== "incomplete_context" && verdict !== "timeout" && verdict !== "not_examined";
  if (asIncluded === false) {
    out.note =
      "These are NOT the bytes the ledger included (same body; other witnesses, redeemers, ex-units or is_valid flag): the replay point above still applies, but is_valid and the acceptance belong to the included bytes. A failure here is real for these bytes (debug it) unless it comes from state the providers only give as of today (defaults_applied).";
  } else if (at.is_valid === false) {
    out.note =
      "Included with is_valid=false: phase 1 passed, a script failed in phase 2 and the collateral was collected. A phase-2 failure here is the one the chain saw: debug it. A phase-1 failure, or phase 2 passing, is a replay artefact (tx_load's defaults_applied; engine differences: cardano-debug://server/info semantics.note).";
  } else if (failing) {
    out.note =
      "The ledger ACCEPTED this tx. A remaining failure is a replay artefact, not a defect of the tx: state the providers only give as of today (tx_load's defaults_applied) or an engine / ledger difference (cardano-debug://server/info semantics.note). Explain it as such; do not debug it as a script bug.";
  }
  return out;
}

// ---------- the tx_validate body ----------

/** Most catalogue names one `error_docs` pointer lists (it stays one line, at most ~550 characters). */
export const ERROR_DOCS_MAX_NAMES = 10;

/**
 * One pointer for the whole answer instead of a per-row text: the distinct reported names that have
 * a docs catalogue entry (rows already carry the library's hint).
 */
export function errorDocsPointer(summary: Record<string, unknown>): string | undefined {
  const names: string[] = [];
  const collect = (rows: unknown) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      const name = (row as { name?: unknown }).name;
      if (typeof name === "string" && !names.includes(name) && findError(name).entry) names.push(name);
    }
  };
  for (const phase of [summary.phase1, summary.phase2] as Array<Record<string, unknown> | undefined>) {
    collect(phase?.errors);
    collect(phase?.warnings);
  }
  collect((summary.not_examined as { items?: unknown } | undefined)?.items);
  if (names.length === 0) return undefined;
  const shown = names.slice(0, ERROR_DOCS_MAX_NAMES);
  const more = names.length > shown.length ? ` (+${names.length - shown.length} more)` : "";
  return `docs(error=<Name>) explains each name: ${shown.join(", ")}${more}`;
}

/** Most redeemer rows tx_validate lists (failing ones first); `redeemers_total` counts them all. */
export const PHASE2_REDEEMER_ROWS = 20;

export interface ValidationSummaryOptions {
  phases?: "both" | "phase1";
  /**
   * `full`: list `defaults_applied` (the call that built the chain state: tx_load's list was never shown).
   * Default `count`: only `defaults_applied_count` and a pointer, and only when there are any.
   */
  defaults?: "full" | "count";
}

export function validationSummary(record: TxRecord, options: ValidationSummaryOptions = {}): Record<string, unknown> {
  const state = chainStateOf(record);
  const stored = record.validation;
  const verdict = verdictOf(record) ?? "incomplete_context";
  const phases = options.phases ?? "both";
  const out: Record<string, unknown> = {
    verdict,
    ...(record.onChain ? { on_chain: onChainView(record.onChain, record.txHex, verdict) } : {}),
    protocol_major: state?.protocolMajor,
    slot: state?.slot?.toString(),
    context: state
      ? { status: state.status, origin: state.origin, provider: state.provider, captured_at: capturedAtIso(state), utxos: state.context?.utxoSet.length ?? 0 }
      : undefined,
  };
  if (stored) {
    const lists = phaseLists(stored);
    const errors = summarizeDiagnostics(lists.errors, "error", record);
    const warnings = summarizeDiagnostics(lists.warnings, "warning", record, 10);
    out.phase1 = { errors: errors.items, errors_total: errors.total, warnings: warnings.items, warnings_total: warnings.total };
    const unexamined = notExaminedWarnings(stored);
    if (unexamined.length > 0) {
      const items = summarizeDiagnostics(unexamined, "warning", record, 10);
      out.not_examined = {
        items: items.items,
        total: items.total,
        note:
          "Implementation limit, not a finding: a validation-context UTxO nests deeper than the library reads (128 levels for its inline datum or a Plutus script reference; 32768 for a native script), so the named native script was not checked (NativeScriptNotExamined) or no script context was built and the redeemers were not run (ScriptContextNotExamined). Everything else was validated; nothing is known about what was not examined.",
      };
    }
    if (phases === "both") {
      const p2errors = summarizeDiagnostics(lists.phase2_errors, "error", record);
      // The library also compares the zero units of a never-evaluated redeemer with its declaration
      // (BudgetIsBiggerThanExpected, "Expected: 0"): budget advice does not apply to a script that never ran.
      const unrun = (ref: string | undefined) => {
        const result = ref ? stored.redeemers.get(ref) : undefined;
        return result !== undefined && neverEvaluated(result);
      };
      const p2warningRows = summarizeDiagnostics(lists.phase2_warnings, "warning", record, Number.MAX_SAFE_INTEGER).items.filter((w) => !(w.name === "BudgetIsBiggerThanExpected" && unrun(w.redeemer)));
      const p2warnings = { items: p2warningRows.slice(0, 10), total: p2warningRows.length };
      const notRun = new Set(p2warningRows.filter((w) => w.name === "ScriptContextNotExamined" && w.redeemer).map((w) => w.redeemer!));
      const rows = record.redeemerTargets.map((target) => {
        const ev = stored.redeemers.get(target.ref);
        const headline = notRun.has(target.ref) ? "not run: no script context could be built (implementation limit, not a finding; see not_examined)" : "no evaluation result for this redeemer";
        return ev ? redeemerSummary(record, target, ev) : { ref: target.ref, witness_index: target.witness_index, target: target.target, success: notRun.has(target.ref) ? null : false, error_headline: headline, fidelity: "program-only" as Fidelity, ex_units: { declared: target.ex_units, verdict: "unknown" as const }, trace_count: 0 };
      });
      const namedByError = new Set(p2errors.items.flatMap((e) => (e.redeemer ? [e.redeemer] : [])));
      // 0: failed (or named by a phase-2 error), 1: not run / over its declared units, 2: fine.
      const attention = (row: { ref: string; success: boolean | null; ex_units: { verdict: string } }) =>
        row.success === false || namedByError.has(row.ref) ? 0 : row.success === null || row.ex_units.verdict === "over_budget" ? 1 : 2;
      const failedCount = rows.filter((row) => attention(row) === 0).length;
      const truncated = rows.length > PHASE2_REDEEMER_ROWS;
      const shown = truncated
        ? rows
            .map((row, index) => ({ row, index }))
            .sort((a, b) => attention(a.row) - attention(b.row) || a.index - b.index)
            .slice(0, PHASE2_REDEEMER_ROWS)
            .map(({ row }) => row)
        : rows;
      out.phase2 = {
        errors: p2errors.items,
        errors_total: p2errors.total,
        warnings: p2warnings.items,
        warnings_total: p2warnings.total,
        redeemers: shown,
        redeemers_total: rows.length,
        failed_count: failedCount,
        ...(truncated
          ? { redeemers_truncated: true, redeemers_note: `Showing ${shown.length} of ${rows.length} redeemers, failing first; one redeemer: tx_redeemer(redeemer=<ref>), all of them: tx_inspect(section='redeemers').` }
          : {}),
      };
    } else {
      // The library evaluates both phases whatever was asked: the rows are hidden, the verdict still counts them.
      const evaluated = Array.from(stored.redeemers.values());
      out.phase2 = {
        skipped: true,
        ran: true,
        errors_total: lists.phase2_errors.length,
        failed_count: evaluated.filter((ev) => !ev.success).length,
        redeemers_total: record.redeemerTargets.length,
        note: "phases=phase1 hides the phase-2 rows only: the scripts still ran and the verdict counts their failures. Call again with phases=both to see them.",
      };
    }
    out.elapsed_ms = stored.elapsedMs;
    out.validated_at = new Date(stored.at).toISOString();
  }
  const docs = errorDocsPointer(out);
  if (docs) out.error_docs = docs;
  Object.assign(out, missingUtxosView(state?.missingUtxos));
  out.provider_warnings = state?.providerWarnings ?? [];
  const defaultsApplied = state?.defaultsApplied ?? [];
  if (options.defaults === "full") out.defaults_applied = defaultsApplied;
  else if (defaultsApplied.length > 0) {
    out.defaults_applied_count = defaultsApplied.length;
    out.defaults_note = "Values the provider or bundle lacked were substituted: tx_load's defaults_applied lists them (tx_load with the same arguments is cached); docs(topic='validation-errors', section='defaults_applied') says which findings they can cause.";
  }
  if (verdict === "incomplete_context") {
    out.note =
      "Phase 2 (and, until the library separates the phases, phase 1 too) cannot run without every input, reference input and collateral UTxO. The listed UTxOs were not returned by the provider: they may already be spent, belong to another network, or the provider may be lagging. Re-run tx_load with refresh=true, another provider, or load a bundle captured while they were live.";
  }
  if (verdict === "timeout" && state?.timedOut) {
    out.note = `The last validation exceeded ${state.timedOut.timeout_ms} ms and the worker was terminated (phase 2 runs with an unbounded budget). Retry with a larger timeout_ms (<= 300000). A tx-mode debug_open needs a finished validation, so it cannot open this tx; for a script that never finishes, debug_open it outside the tx (script + parts; the bytes: tx_redeemer(part='script') or cardano-debug://tx/${record.txId}/redeemer/<ref>/script.hex) and bound debug_run with max_steps.`;
  }
  return out;
}
