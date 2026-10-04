---
gist: over-budget vs slack, debug_profile rankings and fields, chain cost differences and parity.
---
# Budget analysis

- Unbounded evaluation, then compared: calculated > declared (mem or steps) -> `NoEnoughBudget`, `over_budget`, positive `delta`; less -> `BudgetIsBiggerThanExpected`, `slack` (`delta_pct` of declared); equal -> `exact`. `success:true` can still fail on budget (`within_budget:false` in tx_redeemer).
- `debug_profile(by=self_cpu|total_cpu|self_mem|hits)`: `hot_terms[].excerpt/pct` (of total cpu), `hot_lines`, `builtins[]` calls/cpu, `step_kinds`, `timeline`, `totals.cpu_pct/mem_pct`, `over_budget`. Current spend: `debug_inspect(what='budget')`; threshold: `until='budget'`.
- Chain differences: validator and stepper both follow the tx protocol major (D/E at 11, as the ledger; `semantics` of cardano-debug://server/info; uplc-cek/budget); `parity.match=false` = a different path (traces/errors) or other parameters (`cost_model_source`).
