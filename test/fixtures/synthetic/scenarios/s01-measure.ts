// Debugger-facing numbers of the S1 redeemers, MEASURED by the real engine (the de-uplc wasm, in this process) on the
// bytes the real validator applied (script, datum, redeemer, script context, cost model): the same session `debug_open`
// builds in tx mode (src/engine/parts.ts `partsFromEval` + src/engine/session-core.ts, the code the server runs).
//
// These are facts about the compiled scripts and the engine, not choices: term count, listing lines, steps, hot terms,
// the environment at a line, the ScriptContext version. They go to the manifest under `s01.debug.*` (marked
// `measured: true`) so a test reads them instead of hard-coding a figure; `fixtures:check` re-measures them, so a change
// of the engine or of a script that moves a figure shows up as a fixture diff, not as a surprising test failure.

import * as engine from "@cardananium/de-uplc-engine-wasm";

import { partsFromEval } from "../../../../src/engine/parts.js";
import type { RunSpec } from "../../../../src/engine/protocol.js";
import { EngineSession } from "../../../../src/engine/session-core.js";
import { readWasm } from "../../../../src/wasm-assets.js";
import type { EvalResult } from "../lib/validator.js";

let initialised = false;
function initEngine(): void {
  if (initialised) return;
  engine.initSync({ module: readWasm("de_uplc_bg.wasm") });
  initialised = true;
}

/** The `protocol_parameters` of the eval fixture: the protocol version and the cost models of the languages. */
export interface MeasureParams {
  protocolVersion: [number, number];
  costModels: { plutusV1?: number[] | null; plutusV2?: number[] | null; plutusV3?: number[] | null };
}

export interface HotTerm {
  termId: number;
  kind: string | null;
  uplcLine: number | null;
  hits: string;
  selfCpu: string;
  pct: number;
  excerpt: string;
}

export interface EnvItemFact {
  debruijn: number;
  name: string | null;
  type: string;
  summary: string;
  binderUplcLine: number | null;
}

export interface RedeemerMeasurement {
  ref: string;
  scriptHash: string | null;
  language: string;
  termCount: number;
  /** Lines of the debugger's UPLC listing (`debug_source`, session/<id>/uplc.txt) of this session (the applied arguments included). */
  uplcLines: number;
  longestUplcLine: number;
  /** Transitions executed by `debug_run(until='error')` on a script that finishes. */
  stepsTotal: number;
  cpuSpent: string;
  memSpent: string;
  cpuDeclared: string | null;
  memDeclared: string | null;
  cpuPct: number | null;
  memPct: number | null;
  /** Columns of common indentation removed from the listing window at the end of the run. */
  windowDedent: number;
  traceCount: number;
  scriptContextVersion: string;
  /** `cpu` a `debug_run(until='budget')` can use: a round figure that is reached before the script ends (about 45 % of the spend). */
  budgetStopCpu: string;
  profile: {
    by: "self_cpu";
    top: number;
    stepsTotal: string;
    cpu: string;
    termsExecuted: number;
    hotTerms: HotTerm[];
    hotLines: number;
  };
  envAtLine12: { line: number; total: number; items: EnvItemFact[] };
}

const spec = (over: Partial<RunSpec> & Pick<RunSpec, "until">): RunSpec => ({
  max_steps: 5_000_000,
  deadline_at: Date.now() + 120_000,
  breakpoints: { term_ids: [], uplc_lines: [] },
  skip_first: false,
  context_lines: 3,
  frames: 6,
  max_new_traces: 10,
  ...over,
});

/** A round number at or below ~45 % of `value` with two significant digits (so it is clearly reached before the end). */
function roundBelow(value: bigint): string {
  const target = (value * 45n) / 100n;
  const digits = target.toString().length;
  const unit = 10n ** BigInt(Math.max(digits - 2, 0));
  return ((target / unit) * unit).toString();
}

export function measureRedeemer(result: EvalResult, protocolParameters: MeasureParams): RedeemerMeasurement {
  initEngine();
  const ref = `${result.tag.toLowerCase()}:${result.index}`;
  const { config } = partsFromEval(result as never, protocolParameters as never);
  const open = (): EngineSession => EngineSession.openParts(engine as never, config);

  const s = open();
  try {
    const summary = s.summary(2);
    const run = s.run(spec({ until: "error" }));
    if (run.stopped.kind !== "done") throw new Error(`s01 measure: ${ref} did not finish: ${run.stopped.kind} ${run.stopped.detail}`);
    const context = JSON.parse(s.contextJson(1_000_000)) as { script_context_version: string };
    const profile = s.profile({ top: 5, by: "self_cpu", max_steps: 5_000_000, deadline_at: Date.now() + 120_000, include_traces: 10, chunk_steps: 200_000 });
    if (profile.outcome !== "done") throw new Error(`s01 measure: the profile of ${ref} ended in ${profile.outcome}`);

    const probe = open();
    let env: EnvItemFact[];
    let envTotal: number;
    try {
      const atLine = probe.run(spec({ until: "uplc_line", line: 12 }));
      if (atLine.stopped.kind !== "uplc_line") throw new Error(`s01 measure: ${ref} never reached UPLC line 12`);
      const e = probe.env(0, 20);
      envTotal = e.total;
      env = e.items.map((i) => ({ debruijn: i.debruijn, name: i.name ?? null, type: i.type, summary: i.summary, binderUplcLine: i.binder_uplc_line ?? null }));
    } finally {
      probe.free();
    }

    return {
      ref,
      scriptHash: summary.script_hash,
      language: summary.language,
      termCount: summary.term_count,
      uplcLines: summary.uplc_lines,
      longestUplcLine: summary.longest_uplc_line,
      stepsTotal: run.steps_total,
      cpuSpent: run.budget.cpu_spent,
      memSpent: run.budget.mem_spent,
      cpuDeclared: run.budget.cpu_declared ?? null,
      memDeclared: run.budget.mem_declared ?? null,
      cpuPct: run.budget.cpu_pct ?? null,
      memPct: run.budget.mem_pct ?? null,
      windowDedent: run.uplc_window.dedent,
      traceCount: s.tracesAll().length,
      scriptContextVersion: context.script_context_version,
      budgetStopCpu: roundBelow(BigInt(run.budget.cpu_spent)),
      profile: {
        by: "self_cpu",
        top: profile.hot_terms.length,
        stepsTotal: profile.totals.steps,
        cpu: profile.totals.cpu,
        termsExecuted: profile.terms_executed,
        hotTerms: profile.hot_terms.map((t) => ({ termId: t.term_id, kind: t.kind, uplcLine: t.uplc_line, hits: t.hits, selfCpu: t.self_cpu, pct: t.pct, excerpt: t.excerpt ?? "" })),
        hotLines: profile.hot_lines.length,
      },
      envAtLine12: { line: 12, total: envTotal, items: env },
    };
  } finally {
    s.free();
  }
}

export interface HubMeasurement {
  measured: true;
  /** What produced these numbers (so a reader of the manifest knows they are not choices). */
  by: string;
  spend: RedeemerMeasurement;
  mint: RedeemerMeasurement;
}

/** Measure the two S1 redeemers (spend:2 and mint:1) from the validator's own answer. */
export function measureHub(results: EvalResult[], protocolParameters: MeasureParams): HubMeasurement {
  const find = (tag: string) => {
    const r = results.find((x) => x.tag === tag);
    if (!r) throw new Error(`s01 measure: the validator returned no ${tag} redeemer`);
    return r;
  };
  return {
    measured: true,
    by: "de-uplc engine (wasm, in-process) over the bytes cquisitor-lib's validate_transaction_js applied: src/engine/parts.ts partsFromEval + src/engine/session-core.ts",
    spend: measureRedeemer(find("Spend"), protocolParameters),
    mint: measureRedeemer(find("Mint"), protocolParameters),
  };
}
