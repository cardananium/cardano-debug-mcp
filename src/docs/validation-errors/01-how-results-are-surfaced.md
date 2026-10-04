---
gist: verdict values, the error / warning lists and their caps, per-redeemer rows, location indices, library limits (lib_error, not_examined).
---
# How results are surfaced

- verdict: valid/phase1_failed/phase2_failed/both_failed/incomplete_context/timeout/not_examined; phase 2 fails on errors or success=false; missing UTxOs: nothing ran; timeout: raise timeout_ms ≤ 300000 (tx-mode debug_open needs a finished validation)
- phase1.errors[], phase2.errors[]: first 25 (errors_total counts all); warnings first 10; full in validation.json
- phase2.redeemers[]: success,error_headline,ex_units{declared,calculated,delta,delta_pct,verdict},trace_count,last_trace,fidelity (full replayable); first 20, failing first (redeemers_total, failed_count, redeemers_truncated)
- missing_utxos: first 20 (missing_utxos_total); defaults_applied_count (list: tx_load); phases=phase1: phase2 {skipped, ran:true, failed_count}, the verdict still counts phase 2

Locations use sorted index (transaction.body.inputs.<i>; if InputsAreNotSorted trust redeemer). Library throws: lib_error, no verdict; tx nesting > 64 typed / 128 CSL (tag-24 payloads count at their depth; native scripts exempt, ≤ 32768): code unexamined. Context UTxO past 128 (native script past 32768): NativeScriptNotExamined / ScriptContextNotExamined (redeemers not run) = limit, not finding (verdict not_examined).
