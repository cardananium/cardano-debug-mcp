---
gist: how to write the conclusion: root cause with decisive values, evidence, fix, caveats.
---
# Writing the explanation for a human

- Root cause: one sentence, failed rule/expression + decisive values (`fee 1900000 < min_fee 2000000`) and their origin: datum field, redeemer, context path (`tx_info.outputs.0.value`), protocol parameter, chain state (bundle default?).
- Evidence: verdict; phase-1 `name`/`locations`; phase-2 `redeemer`, `error_message`, traces, `term_id/uplc_line`, UPLC window, values by `ref`; pseudocode labelled as such.
- Fix: fee/witnesses/inputs/redeemer/ex-units or datum/off-chain code; recheck `tx_validate` (`script_data_hash` if redeemers change).
- Caveats: bundle defaults, `semantics` (cardano-debug://server/info), `notes[]` guesses, unverified claims. Cite `tx_id`, `dbg_id`, `cardano-debug://` resources.
