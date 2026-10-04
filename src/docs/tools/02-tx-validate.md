---
gist: what tx_validate checks per phase, its caching, the shape and caps of its answer, and where the verdicts and rows are explained.
---
# tx_validate

- Phase 1 covers balance, fees, witnesses, collateral, limits, certificates, governance; phase 2 evaluates every redeemer (per redeemer: ex_units verdict exact | slack | over_budget | not_run, trace count, last trace).
- Verdict meanings and what to do next: debug-playbook/verdict-decision-tree; rows, caps and limits: validation-errors/how-results-are-surfaced; one name: docs(error=<Name>).
- Unresolved UTxOs (network / already spent) give `incomplete_context`: read `missing_utxos` (first 20; `missing_utxos_total` counts all).
- Results are cached per exact bytes; `refresh=true` re-fetches and re-runs.
- `phases='phase1'` hides the phase-2 rows only: the scripts still run, `phase2` says `ran: true` with `failed_count`, and the verdict counts their failures.
- `phase2.redeemers` lists at most 20 rows, failing first; `redeemers_total` and `failed_count` count them all (`redeemers_truncated`). One redeemer: tx_redeemer; all of them: tx_inspect(section='redeemers').
- The defaults of the chain state are tx_load's `defaults_applied`: here only `defaults_applied_count` (the full list when this call loaded the chain state itself, e.g. from tx_cbor).
- Engine semantics (protocol-aware builtins and costs; no array builtins yet) are in uplc-cek/budget and `semantics` of cardano-debug://server/info, not repeated per answer. `resources` lists validation.json (and necessary.json when incomplete).
