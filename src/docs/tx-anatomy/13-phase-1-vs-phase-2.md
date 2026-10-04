---
gist: what phase 1 and phase 2 check and what each failure costs.
---
# Phase 1 vs phase 2

- Phase 1: decoding, balance, fee, min-UTxO, limits, network, signatures/native scripts, redeemer/script/datum bookkeeping, collateral, cert/governance preconditions. Failure: rejected, costs nothing.
- Phase 2 (after phase 1, if redeemers exist): each Plutus script on CEK with ScriptContext, language cost model, declared ex_units. Error/budget exhaustion: node refuses, or block includes it as `is_valid=false`, taking collateral.

`tx_validate` runs both locally on fetched UTxOs.
