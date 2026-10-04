// Regenerates src/docs/debug-playbook/11-worked-example.md from a real run: the S1 transaction through the validator
// and the debugger engine (the numbers tx_load / tx_validate / debug_open / debug_profile / debug_run report for it)
// and a failing program-only probe stepped by the same engine. Nothing in the document is typed by hand except the
// prose; `test/unit/synthetic/s01WorkedExample.test.ts` fails when the committed document differs from this output.
//
//   npx tsx test/fixtures/synthetic/worked-example.ts        rewrite the document
//
// The document has a size cap (2,500 characters per section, test/unit/modelTexts.test.ts); `renderWorkedExample` throws beyond it.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as engine from "@cardananium/de-uplc-engine-wasm";

import type { RunSpec } from "../../../src/engine/protocol.js";
import { EngineSession } from "../../../src/engine/session-core.js";
import { readWasm } from "../../../src/wasm-assets.js";
import { toolkit, type Toolkit } from "./lib/toolkit.js";
import { hub } from "./scenarios/s01-hub.js";
import { measureHub } from "./scenarios/s01-measure.js";

export const DOC_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "docs", "debug-playbook", "11-worked-example.md");
export const DOC_LIMIT = 2_500;

/** The failing probe: a "fee below the minimum" check that traces a message, then fails with an explicit (error). The datum is `Constr 0 [I 1900000]`, the minimum 2000000. */
export const PROBE_PROGRAM = `(program 1.0.0
  [ [ (lam order
        (lam min_fee
          [ (lam fee
              (force
                [ [ [ (force (builtin ifThenElse))
                      [ [ (builtin lessThanInteger) fee ] min_fee ] ]
                    (delay
                      [ [ (force (builtin chooseUnit))
                          [ [ (force (builtin trace)) (con string "batcher fee too low") ] (con unit ()) ] ]
                        (error) ]) ]
                  (delay (con unit ())) ]))
            [ (builtin unIData)
              [ (force (builtin headList))
                [ (force (force (builtin sndPair))) [ (builtin unConstrData) order ] ] ] ] ]))
      (con data (Constr 0 [I 1900000])) ]
    (con integer 2000000) ])`;

const spec = (over: Partial<RunSpec> & Pick<RunSpec, "until">): RunSpec => ({
  max_steps: 1_000_000,
  deadline_at: Date.now() + 60_000,
  breakpoints: { term_ids: [], uplc_lines: [] },
  skip_first: false,
  context_lines: 6,
  frames: 6,
  max_new_traces: 10,
  ...over,
});

let initialised = false;

/** What the failing probe does in the engine (the facts the document quotes). */
export function measureProbe() {
  if (!initialised) {
    engine.initSync({ module: readWasm("de_uplc_bg.wasm") });
    initialised = true;
  }
  const s = EngineSession.openProgram(engine as never, PROBE_PROGRAM, "V2");
  try {
    const listing = s.uplcText().split("\n");
    const lineOf = (needle: string): number => {
      const i = listing.findIndex((l) => l.includes(needle));
      if (i < 0) throw new Error(`worked example: the probe listing has no line with ${needle}`);
      return i + 1;
    };
    const run = s.run(spec({ until: "error" }));
    if (run.stopped.kind !== "error") throw new Error(`worked example: the probe stopped with ${run.stopped.kind}, expected error`);
    // debug_run's `rewind.failing_term` is {until: "term", term_id: <the explicit (error) term>, restart: true} (src/tools/debug_run.ts)
    const failingTerm = run.position.term_id;
    if (failingTerm === null || run.position.kind !== "Error") throw new Error("worked example: the probe did not stop on an explicit (error) term");
    const position = run.position;
    const traces = run.traces.new;
    const back = s.run(spec({ until: "term", term_id: failingTerm, restart: true }));
    const env = s.env(0, 20);
    const lessThan = s.run(spec({ until: "builtin", builtin: "lessThanInteger", restart: true }));
    return {
      stepsTotal: run.steps_total,
      errorTerm: position.term_id as number,
      errorKind: position.kind as string,
      errorLine: position.uplc_line as number,
      errorState: position.machine_state,
      traceLine: lineOf('(con string "batcher fee too low")'),
      traces,
      back: { kind: back.stopped.kind, term: back.position.term_id as number, line: back.position.uplc_line as number, kindOfTerm: back.position.kind as string, state: back.position.machine_state },
      env: env.items.map((i) => ({ index: i.index, debruijn: i.debruijn, name: i.name as string, type: i.type, summary: i.summary, ref: i.ref, binderLine: i.binder_uplc_line as number })),
      envTotal: env.total,
      builtin: { kind: lessThan.stopped.kind, term: lessThan.position.term_id as number, line: lessThan.position.uplc_line as number },
    };
  } finally {
    s.free();
  }
}

const abbreviate = (hash: string): string => `${hash.slice(0, 8)}…${hash.slice(-4)}`;

export function renderWorkedExample(tk: Toolkit = toolkit): string {
  const h = hub(tk);
  const pp = h.ctx.params;
  const measured = measureHub(h.validation.eval_redeemer_results, { protocolVersion: pp.protocolVersion, costModels: pp.costModels });
  const probe = measureProbe();
  const spend = measured.spend;

  const fee = h.spec.fee!;
  const feeError = h.validation.errors.find((e) => tk.validator.errorKind(e) === "FeeTooSmallUTxO")!;
  const minFee = BigInt((feeError.error as Record<string, { min_fee: number | string }>).FeeTooSmallUTxO!.min_fee);
  const result = h.validation.eval_redeemer_results.find((r) => r.tag === "Spend")!;
  const declaredSteps = BigInt(result.provided_ex_units.steps);
  const calculatedSteps = BigInt(result.calculated_ex_units!.steps);
  const hot = spend.profile.hotTerms[0]!;
  if (probe.envTotal !== 3 || probe.env[0]?.name !== "order" || probe.env[1]?.name !== "min_fee" || probe.env[2]?.name !== "fee") throw new Error("worked example: the probe's environment is not order / min_fee / fee");
  const envRow = (i: number, extra: string) => {
    const e = probe.env[i]!;
    return `${i === 0 ? `index ${e.index} / debruijn ${e.debruijn}` : `${e.index} / ${e.debruijn}`} \`${e.name}\` ${e.type} ${e.type === "Con:Data" ? `\`${e.summary}\`` : e.summary}${extra}`;
  };

  const text = `---
gist: a full session on the sample bundle and a failing program-only probe, with the real numbers each tool returns.
---
# Worked example (sample bundle)

\`tx_load(bundle=<sample DebuggerContext>)\`:

- \`tx_id=${tk.writers.txHandle(h.net, h.tx.txHash)}\`, protocol_major ${pp.protocolVersion[0]}, fee ${fee}; redeemers \`spend:2\` (hash \`${abbreviate(h.ids.spendHash!)}\`, V2), \`mint:1\`; \`defaults_applied=[…]\`.
- \`tx_validate\`: \`phase1_failed\`; \`FeeTooSmallUTxO\` at \`transaction.body.fee\`, \`data.actual_fee=${fee},min_fee=${minFee}\`. Phase-2 errors empty; spend:2 \`success:true,fidelity:full\`; ex_units declared ${declaredSteps} steps, calculated ${calculatedSteps}, delta ${calculatedSteps - declaredSteps}, verdict slack.
- \`debug_open(redeemer='spend:2')\`: \`dbg_id=dbg_6d02…\`, term_count ${spend.termCount}, uplc_lines ${spend.uplcLines}.
- \`debug_profile(top=5)\`: done; steps ${spend.profile.stepsTotal}, cpu ${spend.profile.cpu} (cpu_pct ${spend.cpuPct} of declared), over_budget false, parity.match true. Hot term ${hot.termId} / line ${hot.uplcLine}, \`[ [ [ i i ] (delay (con bool False)) ] … ]\`, hits ${hot.hits}, pct ${hot.pct}.
- \`debug_run(until='error')\`: done, parity.match true. The script passes; phase 1 fails: fee ${fee} < ${minFee}, reference input repeated as input, stale script-data hash.

Failing program-only probe, datum \`Constr 0 [I 1900000]\`, min_fee 2000000:

- \`debug_run(until='error')\`: stopped.kind error, steps_total ${probe.stepsTotal}; term ${probe.errorTerm}, kind ${probe.errorKind}, line ${probe.errorLine}, machine_state ${probe.errorState}. Window: line ${probe.traceLine} \`(con string "batcher fee too low")\`, line ${probe.errorLine} \`(error)\`; traces new \`${JSON.stringify(probe.traces)}\`.
- \`rewind\`.failing_term -> \`debug_run(until='term',term_id=${probe.errorTerm},restart=true)\`: stopped.kind ${probe.back.kind}, term ${probe.back.term} / line ${probe.back.line} / kind ${probe.back.kindOfTerm}, machine_state ${probe.back.state}.
- \`debug_inspect(what='env')\`: total ${probe.envTotal} — ${envRow(0, ` (ref ${probe.env[0]!.ref}, binder line ${probe.env[0]!.binderLine})`)}; ${envRow(1, "")}; ${envRow(2, ` (binder line ${probe.env[2]!.binderLine})`)}.

Root cause: \`fee\` 1900000 (datum's first field) \`< min_fee\` 2000000 picks the \`ifThenElse\` branch tracing \`batcher fee too low\`, then \`(error)\` at line ${probe.errorLine} (term ${probe.errorTerm}). \`until='builtin',builtin='lessThanInteger'\` stops on the comparison (term ${probe.builtin.term}, line ${probe.builtin.line}).
`;
  if (text.length > DOC_LIMIT) throw new Error(`worked example: ${text.length} characters, over the ${DOC_LIMIT} cap`);
  return text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(DOC_PATH, renderWorkedExample());
  console.log(`wrote ${DOC_PATH}`);
}
