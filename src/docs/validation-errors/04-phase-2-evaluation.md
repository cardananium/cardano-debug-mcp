---
gist: how each redeemer is evaluated, the ex_units verdicts (exact, slack, over_budget, not_run, unknown) and the expected_budget / actual_budget naming.
---
# Phase 2: script evaluation

Per redeemer: find script (witness/reference script_ref), build context, apply datum+redeemer+context (V1/V2) or context (V3), run unbounded. `ex_units.verdict`: `exact` both dimensions equal; `slack` calculated ≤ declared (negative delta, delta_pct relative to declared; warning `BudgetIsBiggerThanExpected`); `over_budget` calculated > declared in mem/steps: `NoEnoughBudget`, phase2_failed even if success=true; `not_run` never evaluated (context refused, no script/cost model: zero units); `unknown` no result. `expected_budget` = used, `actual_budget` = declared (costs may differ slightly from chain).

Context refusals (the script never ran): UnreadableOutput, UnreadableTransactionField, ByronAddressNotAllowed, CertificateNotSupportedInPlutusV1V2, FieldNotSupportedInPlutusV1V2, InlineDatumNotAllowedForPlutusV1, ReferenceInputsNotAllowedForPlutusV1 (V1 rules: script-context/what-breaks-v1).
