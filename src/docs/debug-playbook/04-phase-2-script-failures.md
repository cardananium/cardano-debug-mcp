---
gist: phase-2 procedure steps 1-6: redeemer rows, part='error', pseudocode first, debug_open, debug_profile, debug_run(until='error').
---
# Phase 2: script failures

1. `tx_validate.phase2.redeemers[]`: `success,error_headline,ex_units{declared,calculated,delta,verdict},trace_count,last_trace,fidelity` (full = replayable).
2. `tx_redeemer(tx_id,redeemer,part='error')`: hint + category `machine_error,budget,decode,missing_script,missing_datum,context_build` (indices too) or `none`; explicit-error message: `the validator crashed / exited prematurely`. Other parts: traces (paged, filter), context (purpose, tx_info.inputs.2), summary.
3. **Pseudocode before stepping:** `script_decompile(tx_id,script_hash=<redeemer's script_hash>)` or `dbg_id`: checks, datum/redeemer shapes, fail/expect branches, far easier than UPLC; page; respect notes[] guesses (confirm via `view='uplc'`/`debug_source`).
4. `debug_open(tx_id,redeemer)`: dbg_id, term_count, uplc_lines, validator_calculated_ex_units; applied = datum/redeemer/context V1/V2 spend, redeemer/context other V1/V2, context V3.
5. `debug_profile(dbg_id,top=10)` (session unmoved): outcome done|error|limit|timeout|cancelled; error{message,term_id,uplc_line} (null for builtin/machine); traces.items[].{step,message,term_id,uplc_line}; hotspots (debug-playbook/budget-analysis).
6. `debug_run(dbg_id,until='error')`: stopped.kind, error_message, traces.new, uplc_window, steps_total, position (explicit error: term_id, kind Error, uplc_line, machine_state Error). Builtin/machine error (`divide By Zero`, `attempted to apply an argument to a non-function`): term_id null, read error_message; last_term_id = last computed term (many visits). No env/frames at termination.

Next: the rewind and inspection steps, debug-playbook/phase-2-rewind.
