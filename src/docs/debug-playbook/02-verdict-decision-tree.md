---
gist: what to do for each tx_validate verdict, and how to read failures of a tx replayed from the chain (on_chain).
---
# Decision tree from tx_validate.verdict

`timeout_ms` default 90 s, max 300 s. Phase 1 fails iff `phase1.errors` is non-empty; phase 2 iff `phase2.errors` is non-empty or a redeemer has `success:false`. A `tx_hash` load replays at its inclusion point (`on_chain`: slot, epoch parameters, own inputs unspent); `on_chain.note` classifies failures: accepted bytes -> replay artefact (`defaults_applied`, `semantics` of cardano-debug://server/info); `is_valid:false` -> the chain's phase-2 failure, debug it; `bytes_as_included:false` (edited) -> real.

- `valid`: warnings (`BudgetIsBiggerThanExpected` = overpaying), `ex_units.verdict`. Chain rejected it? Changed inputs/slot/parameters: `tx_load(refresh=true)`.
- `phase1_failed`: Phase 1; scripts still ran (`phase2.redeemers[]`).
- `phase2_failed`: Phase 2 on `success:false` / `phase2.errors[]` (`redeemer` = the ref).
- `both_failed`: phase 1 first only if it changes script inputs (redeemer index, missing datum); else debug the script.
- `incomplete_context`: `missing_utxos[]` (spent, wrong network, provider lag): refresh, other `provider`, or a bundle captured while live.
- `timeout`: raise `timeout_ms`. Tx-mode `debug_open` needs a finished validation (`validation_timeout`): step a never-ending script as parts (`debug_open(script,…)`, bytes from `tx_redeemer(part='script')`) bounded by `max_steps`.
- `not_examined`: nothing failed; a context UTxO past the library's bounds (limit, not finding) had its native script / redeemers unchecked.
