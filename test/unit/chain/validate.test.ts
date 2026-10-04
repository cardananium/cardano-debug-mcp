import { describe, expect, it } from "vitest";

import { missingUtxoRefs } from "../../../src/chain/fetchContext.js";
import { chainStateOf, emptyChainState, setChainState } from "../../../src/chain/state.js";
import {
  exUnitsSummary,
  errorHeadline,
  fidelityOf,
  neverEvaluated,
  redeemerRefFromLocations,
  refOfEval,
  splitValidation,
  summarizeDiagnostics,
  validationSummary,
  variantData,
  variantName,
  verdictOf,
} from "../../../src/chain/validate.js";
import type { EvalRedeemerResultWire, ValidationResultWire } from "../../../src/lib.js";
import type { TxRecord } from "../../../src/store/txStore.js";

function record(): TxRecord {
  const now = Date.now();
  return {
    txId: "tx_mainnet_000000000001",
    txHash: "00".repeat(31) + "01",
    network: "mainnet",
    txHex: "84a0",
    sizeBytes: 2,
    source: "cbor",
    createdAt: now,
    lastUsedAt: now,
    decoded: { transaction_hash: "00".repeat(31) + "01", transaction: { body: {}, witness_set: {}, is_valid: true, auxiliary_data: null } },
    hashes: { witness_native_script_hashes: [], witness_plutus_scripts: [], witness_datum_hashes: [], output_inline_scripts: [], output_inline_datum_hashes: [], output_datum_hashes: [] },
    redeemerTargets: [
      { ref: "spend:2", purpose: "spend", index: 2, witness_index: 0, target: "input x#0", ex_units: { mem: "10", steps: "100" } },
      { ref: "publish:0", purpose: "publish", index: 0, witness_index: 1, target: "cert #0", ex_units: { mem: "1", steps: "1" } },
    ],
    scripts: [],
    extra: {},
  };
}

function ev(overrides: Partial<EvalRedeemerResultWire> = {}): EvalRedeemerResultWire {
  return { tag: "Spend", index: 2, provided_ex_units: { mem: 10, steps: "100" }, calculated_ex_units: { mem: 8, steps: 90 }, logs: ["a", "b"], success: true, ...overrides };
}

describe("vocabulary mapping of eval results", () => {
  it("maps lib tags to canonical refs (Cert -> publish, Reward -> withdraw)", () => {
    expect(refOfEval({ tag: "Spend", index: 2 })).toBe("spend:2");
    expect(refOfEval({ tag: "Cert", index: 0 })).toBe("publish:0");
    expect(refOfEval({ tag: "Reward", index: 1 })).toBe("withdraw:1");
    expect(refOfEval({ tag: "Mint", index: "3" as unknown as number })).toBe("mint:3");
    expect(refOfEval({ tag: "Vote", index: 0 })).toBe("vote:0");
    expect(refOfEval({ tag: "Propose", index: 0 })).toBe("propose:0");
  });

  it("splits a result into per-ref eval results and joins the verdict", () => {
    const result: ValidationResultWire = {
      errors: [],
      warnings: [],
      phase2_errors: [],
      phase2_warnings: [],
      eval_redeemer_results: [ev(), ev({ tag: "Cert", index: 0, success: false, error: "explicit error\nmore" })],
    };
    const stored = splitValidation(result, 12);
    expect(Array.from(stored.redeemers.keys())).toEqual(["spend:2", "publish:0"]);
    expect(stored.elapsedMs).toBe(12);
    const rec = record();
    rec.validation = stored;
    expect(verdictOf(rec)).toBe("phase2_failed");
    stored.result.errors = [{ error: "InputSetEmptyUTxO", error_message: "empty", locations: [] }];
    expect(verdictOf(rec)).toBe("both_failed");
    stored.redeemers.get("publish:0")!.success = true;
    expect(verdictOf(rec)).toBe("phase1_failed");
    stored.result.errors = [];
    expect(verdictOf(rec)).toBe("valid");
  });

  it("incomplete_context and timeout come from the chain state", () => {
    const rec = record();
    expect(verdictOf(rec)).toBeUndefined();
    const state = emptyChainState("mainnet", "test");
    state.missingUtxos.push("aa#0");
    setChainState(rec, state);
    expect(verdictOf(rec)).toBe("incomplete_context");
    state.missingUtxos.length = 0;
    state.timedOut = { timeout_ms: 90_000, at: Date.now() };
    expect(verdictOf(rec)).toBe("timeout");
    expect(chainStateOf(rec)).toBe(state);
    expect(rec.missingUtxos).toBe(state.missingUtxos);
  });
});

describe("ex-units and headlines", () => {
  it("computes delta / delta_pct / verdict", () => {
    expect(exUnitsSummary(ev())).toEqual({
      declared: { mem: "10", steps: "100" },
      calculated: { mem: "8", steps: "90" },
      delta: { mem: "-2", steps: "-10" },
      delta_pct: { mem: -20, steps: -10 },
      verdict: "slack",
    });
    expect(exUnitsSummary(ev({ calculated_ex_units: { mem: 10, steps: 100 } })).verdict).toBe("exact");
    expect(exUnitsSummary(ev({ calculated_ex_units: { mem: 10, steps: 101 } })).verdict).toBe("over_budget");
    expect(exUnitsSummary(ev({ calculated_ex_units: null })).verdict).toBe("unknown");
    expect(exUnitsSummary(ev({ provided_ex_units: { mem: 0, steps: 0 }, calculated_ex_units: { mem: 5, steps: 0 } })).delta_pct).toEqual({ mem: 100, steps: 0 });
  });

  it("headline is the first non-empty line, fidelity needs context + script bytes", () => {
    expect(errorHeadline("\n\nexplicit error\nmore")).toBe("explicit error");
    expect(errorHeadline(null)).toBeUndefined();
    expect(fidelityOf(ev())).toBe("program-only");
    expect(fidelityOf(ev({ script_bytes: "59", plutus_version: "V2", script_context_bytes: "d8" }))).toBe("full");
  });
});

describe("diagnostics", () => {
  it("names serde variants and maps locations / payloads to redeemers", () => {
    expect(variantName("InputSetEmptyUTxO")).toBe("InputSetEmptyUTxO");
    expect(variantName({ FeeTooSmallUTxO: { actual_fee: 1 } })).toBe("FeeTooSmallUTxO");
    expect(variantData({ FeeTooSmallUTxO: { actual_fee: 1 } })).toEqual({ actual_fee: 1 });
    const rec = record();
    expect(redeemerRefFromLocations(["transaction.witness_set.redeemers.1"], rec)).toBe("publish:0");
    expect(redeemerRefFromLocations(["transaction.body.fee"], rec)).toBeUndefined();
    const summary = summarizeDiagnostics(
      [
        { error: { FeeTooSmallUTxO: { actual_fee: 18446744073709551615n, min_fee: 2 } }, error_message: "x".repeat(600), locations: ["transaction.body.fee"], hint: "raise it" },
        { error: { NoEnoughBudget: { expected_budget: { mem: 1, steps: 1 }, actual_budget: { mem: 2, steps: 2 } } }, error_message: "budget", locations: ["transaction.witness_set.redeemers.0"] },
        { error: { ExtraneousRedeemer: { tag: "Cert", index: 0 } }, error_message: "extra", locations: [] },
      ],
      "error",
      rec,
      2,
    );
    expect(summary.total).toBe(3);
    expect(summary.items).toHaveLength(2);
    expect(summary.items[0]!.name).toBe("FeeTooSmallUTxO");
    expect(summary.items[0]!.message.length).toBeLessThanOrEqual(400);
    expect(summary.items[0]!.hint).toBe("raise it");
    expect(summary.items[0]!.data).toEqual({ actual_fee: "18446744073709551615", min_fee: "2" });
    expect(summary.items[1]!.redeemer).toBe("spend:2");
    const third = summarizeDiagnostics([{ error: { ExtraneousRedeemer: { tag: "Cert", index: 0 } }, error_message: "extra", locations: [] }], "error", rec).items[0]!;
    expect(third.redeemer).toBe("publish:0");
  });
});

describe("a redeemer the library never evaluated (its ScriptContext was refused)", () => {
  // what validate_transaction_js answers for UnreadableOutput / CertificateNotSupportedInPlutusV1V2 / …:
  // success false and zero calculated units, plus a budget warning comparing those zeros with the declaration
  const refused = ev({ success: false, calculated_ex_units: { mem: 0, steps: 0 }, error: "Output 0 cannot be translated into a script context: its address cannot be read: invalid address length 10" });

  it("is not_run, with no delta against the declaration", () => {
    expect(neverEvaluated(refused)).toBe(true);
    expect(exUnitsSummary(refused)).toEqual({ declared: { mem: "10", steps: "100" }, verdict: "not_run" });
    // a script that ran and failed spent units: its comparison stays
    expect(neverEvaluated(ev({ success: false }))).toBe(false);
    expect(exUnitsSummary(ev({ success: false })).verdict).toBe("slack");
    // zero units are only "never ran" on a failure
    expect(neverEvaluated(ev({ calculated_ex_units: { mem: 0, steps: 0 } }))).toBe(false);
    expect(neverEvaluated(ev({ success: false, calculated_ex_units: null }))).toBe(false);
  });

  it("tx_validate drops the library's zero-unit budget warning for it and keeps the others", () => {
    const rec = record();
    const budget = (witness: number) => ({
      warning: { BudgetIsBiggerThanExpected: { expected_budget: { mem: 0, steps: 0 }, actual_budget: { mem: 10, steps: 100 } } },
      warning_message: "Budget is bigger than expected",
      locations: [`transaction.witness_set.redeemers.${witness}`],
    });
    const result = {
      errors: [],
      warnings: [],
      phase2_errors: [{ error: { UnreadableOutput: { output_index: 0, reason: "its address cannot be read" } }, error_message: "Output 0 cannot be translated into a script context", locations: ["transaction.witness_set.redeemers.0"] }],
      phase2_warnings: [budget(0), budget(1)],
      eval_redeemer_results: [{ ...refused, tag: "Spend", index: 2 }, ev({ tag: "Cert", index: 0, calculated_ex_units: { mem: 1, steps: 0 } })],
    } as unknown as ValidationResultWire;
    rec.validation = splitValidation(result, 5);
    const summary = validationSummary(rec) as { phase2: { errors: Array<{ name: string; redeemer?: string }>; warnings: Array<{ name: string; redeemer?: string }>; warnings_total: number; redeemers: Array<{ ref: string; ex_units: { verdict: string } }> } };
    expect(summary.phase2.errors).toMatchObject([{ name: "UnreadableOutput", redeemer: "spend:2" }]);
    expect(summary.phase2.warnings).toMatchObject([{ name: "BudgetIsBiggerThanExpected", redeemer: "publish:0" }]);
    expect(summary.phase2.warnings_total).toBe(1);
    expect(summary.phase2.redeemers.map((r) => [r.ref, r.ex_units.verdict])).toEqual([
      ["spend:2", "not_run"],
      ["publish:0", "slack"],
    ]);
  });
});

describe("parts the library did not examine (a validation-context UTxO nested past its bounds)", () => {
  const nativeNotExamined = {
    warning: { NativeScriptNotExamined: { script_hash: "ab".repeat(28), reason: "CBOR nesting is deeper than the supported limit of 32768 levels" } },
    warning_message: "Native script abab… was not evaluated (implementation limit, not a finding): …",
    locations: ["transaction.witness_set.native_scripts"],
  };
  const contextNotExamined = (witness: number) => ({
    warning: { ScriptContextNotExamined: { input: "cd".repeat(32) + "#0", reason: "CBOR nesting is deeper than the supported limit of 128 levels for decoding by pallas and the Plutus evaluator; native scripts do not count toward it and may nest up to 32768 levels" } },
    warning_message: "The redeemer was not evaluated (implementation limit, not a finding): …",
    locations: [`transaction.witness_set.redeemers.${witness}`],
  });

  it("with nothing failed the verdict is not_examined, never valid; a real failure keeps its verdict", () => {
    const rec = record();
    rec.validation = splitValidation({ errors: [], warnings: [nativeNotExamined], phase2_errors: [], phase2_warnings: [], eval_redeemer_results: [ev(), ev({ tag: "Cert", index: 0 })] } as unknown as ValidationResultWire, 1);
    expect(verdictOf(rec)).toBe("not_examined");
    rec.validation.result.errors = [{ error: "InputSetEmptyUTxO", error_message: "empty", locations: [] }];
    expect(verdictOf(rec)).toBe("phase1_failed");
  });

  it("tx_validate lists them under not_examined and reports the redeemers it could not run as not run, not failed", () => {
    const rec = record();
    rec.validation = splitValidation({ errors: [], warnings: [], phase2_errors: [], phase2_warnings: [contextNotExamined(0), contextNotExamined(1)], eval_redeemer_results: [] } as unknown as ValidationResultWire, 1);
    expect(verdictOf(rec)).toBe("not_examined");
    const summary = validationSummary(rec) as { not_examined: { items: Array<{ name: string; redeemer?: string }>; total: number; note: string }; phase2: { redeemers: Array<{ ref: string; success: boolean | null; error_headline: string }> } };
    expect(summary.not_examined.total).toBe(2);
    expect(summary.not_examined.items.map((w) => [w.name, w.redeemer])).toEqual([
      ["ScriptContextNotExamined", "spend:2"],
      ["ScriptContextNotExamined", "publish:0"],
    ]);
    expect(summary.not_examined.note).toMatch(/^Implementation limit, not a finding/);
    for (const r of summary.phase2.redeemers) {
      expect(r.success).toBeNull();
      expect(r.error_headline).toMatch(/^not run: .*implementation limit, not a finding/);
    }
  });
});

describe("missingUtxoRefs", () => {
  it("compares requested refs with returned rows before validation", () => {
    const necessary = { utxos: [{ txHash: "AA".repeat(32), outputIndex: 0 }, { txHash: "bb".repeat(32), outputIndex: 1 }, { txHash: "bb".repeat(32), outputIndex: 1 }], accounts: [], pools: [], dReps: [], govActions: [], lastEnactedGovAction: [], committeeMembersCold: [], committeeMembersHot: [] };
    const utxoSet = [{ utxo: { input: { txHash: "aa".repeat(32), outputIndex: 0 }, output: { address: "a", amount: [] } }, isSpent: false }];
    expect(missingUtxoRefs(necessary, utxoSet)).toEqual([`${"bb".repeat(32)}#1`]);
  });
});
