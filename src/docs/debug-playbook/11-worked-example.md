---
gist: a full session on the sample bundle and a failing program-only probe, with the real numbers each tool returns.
---
# Worked example (sample bundle)

`tx_load(bundle=<sample DebuggerContext>)`:

- `tx_id=tx_mainnet_8c7c51d7a08d`, protocol_major 10, fee 267027; redeemers `spend:2` (hash `830f17e6…be5f`, V2), `mint:1`; `defaults_applied=[…]`.
- `tx_validate`: `phase1_failed`; `FeeTooSmallUTxO` at `transaction.body.fee`, `data.actual_fee=267027,min_fee=292027`. Phase-2 errors empty; spend:2 `success:true,fidelity:full`; ex_units declared 24144698 steps, calculated 21179559, delta -2965139, verdict slack.
- `debug_open(redeemer='spend:2')`: `dbg_id=dbg_6d02…`, term_count 2571, uplc_lines 4076.
- `debug_profile(top=5)`: done; steps 1245, cpu 21179559 (cpu_pct 87.71 of declared), over_budget false, parity.match true. Hot term 1629 / line 2559, `[ [ [ i i ] (delay (con bool False)) ] … ]`, hits 9, pct 2.11.
- `debug_run(until='error')`: done, parity.match true. The script passes; phase 1 fails: fee 267027 < 292027, reference input repeated as input, stale script-data hash.

Failing program-only probe, datum `Constr 0 [I 1900000]`, min_fee 2000000:

- `debug_run(until='error')`: stopped.kind error, steps_total 82; term 17, kind Error, line 38, machine_state Error. Window: line 33 `(con string "batcher fee too low")`, line 38 `(error)`; traces new `["batcher fee too low"]`.
- `rewind`.failing_term -> `debug_run(until='term',term_id=17,restart=true)`: stopped.kind term, term 17 / line 38 / kind Error, machine_state Compute.
- `debug_inspect(what='env')`: total 3 — index 0 / debruijn 3 `order` Con:Data `Constr 0 [1 fields]` (ref env.values.0, binder line 3); 1 / 2 `min_fee` Con:Integer 2000000; 2 / 1 `fee` Con:Integer 1900000 (binder line 6).

Root cause: `fee` 1900000 (datum's first field) `< min_fee` 2000000 picks the `ifThenElse` branch tracing `batcher fee too low`, then `(error)` at line 38 (term 17). `until='builtin',builtin='lessThanInteger'` stops on the comparison (term 2, line 16).
