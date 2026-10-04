---
gist: tx size, ex-units, reference-script bytes and value size limits with their errors; what is not checked.
---
# Size and execution limits

- tx size (as for fee): `max_transaction_size` (pp 3) → `MaxTxSizeUTxO`
- sum of redeemer `ex_units`: `max_tx_execution_units` (pp 20), mem and steps separately → `ExUnitsTooBigUTxO`
- total reference-script bytes: 204,800 (200 KiB) → `RefScriptsSizeTooBig`
- one output's value bytes: `max_value_size` (pp 22) → `OutputsValueTooBig`
- not checked: block-level `max_block_ex_units` (pp 21), max block body size (pp 2)

Declared `ex_units` are a budget: needing more fails phase 2 (`NoEnoughBudget`); excess only costs fee (`BudgetIsBiggerThanExpected` warning).
