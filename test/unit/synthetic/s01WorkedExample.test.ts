// The playbook's worked example (src/docs/debug-playbook/11-worked-example.md) quotes a real run of the S1 transaction and of a
// failing program-only probe. The document is generated (test/fixtures/synthetic/worked-example.ts): this test fails when the
// committed text is not what the generator prints from the current fixtures and engine, and checks the sentences other tests
// (chain.e2e) look for. Regenerate with `npx tsx test/fixtures/synthetic/worked-example.ts`.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DOC_LIMIT, DOC_PATH, measureProbe, renderWorkedExample } from "../../fixtures/synthetic/worked-example.js";
import { fx, fxStr } from "../../helpers/fixtures.js";

const committed = readFileSync(DOC_PATH, "utf8");

describe("11-worked-example.md", () => {
  it("is exactly what the generator prints (numbers from the S1 run and the probe, not typed by hand)", () => {
    expect(committed).toBe(renderWorkedExample());
  });

  it("keeps its structure and stays inside the section cap", () => {
    expect(committed.length).toBeLessThanOrEqual(DOC_LIMIT);
    expect(committed).toMatch(/^---\ngist: .+\n---\n# Worked example \(sample bundle\)\n/);
    expect(committed).toContain("`tx_load(bundle=<sample DebuggerContext>)`:");
    expect(committed).toContain("Failing program-only probe, datum `Constr 0 [I 1900000]`, min_fee 2000000:");
    expect(committed).toContain("Root cause:");
  });

  it("quotes the numbers the manifest records for S1 (what chain.e2e looks for: data.actual_fee=…,min_fee=… and fee A < B)", () => {
    expect(committed).toContain(`\`tx_id=${fxStr("s01.txId")}\``);
    expect(committed).toContain(`fee ${fxStr("s01.fee")};`);
    expect(committed).toContain(`data.actual_fee=${fxStr("s01.fee")},min_fee=${fxStr("s01.minFee")}`);
    expect(committed).toContain(`fee ${fxStr("s01.fee")} < ${fxStr("s01.minFee")}`);
    expect(committed).toContain(`declared ${fxStr("s01.spend.exUnits.declared.steps")} steps, calculated ${fxStr("s01.spend.exUnits.calculated.steps")}, delta ${fxStr("s01.spend.exUnits.deltaSteps")}`);
    expect(committed).toContain(`term_count ${fx<number>("s01.debug.spend.termCount")}, uplc_lines ${fx<number>("s01.debug.spend.uplcLines")}`);
    expect(committed).toContain(`steps ${fxStr("s01.debug.spend.profile.stepsTotal")}, cpu ${fxStr("s01.debug.spend.profile.cpu")} (cpu_pct ${fx<number>("s01.debug.spend.cpuPct")} of declared)`);
    const hot = fx<{ termId: number; uplcLine: number; hits: string; pct: number }>("s01.debug.spend.profile.hotTerms.0");
    expect(committed).toContain(`Hot term ${hot.termId} / line ${hot.uplcLine}`);
    expect(committed).toContain(`hits ${hot.hits}, pct ${hot.pct}`);
    expect(committed).toContain(`\`${fxStr("s01.spendScript.hash").slice(0, 8)}…${fxStr("s01.spendScript.hash").slice(-4)}\``);
  });

  it("the probe's story holds: the (error) term is on line N, the trace line before it, the environment is order / min_fee / fee", () => {
    const probe = measureProbe();
    expect(probe.errorKind).toBe("Error");
    expect(probe.errorState).toBe("Error");
    expect(probe.traces).toEqual(["batcher fee too low"]);
    expect(probe.traceLine).toBeLessThan(probe.errorLine);
    expect(probe.back).toMatchObject({ kind: "term", term: probe.errorTerm, line: probe.errorLine, state: "Compute" });
    expect(probe.env.map((e) => e.name)).toEqual(["order", "min_fee", "fee"]);
    expect(probe.env.map((e) => e.summary)).toEqual(["Constr 0 [1 fields]", "2000000", "1900000"]);
    expect(probe.builtin.kind).toBe("builtin");
  });
});
