---
gist: steps 7-9: which rewind call per failure kind, reading env / frames / values, the UPLC window.
---
# Phase 2: rewind and inspect the failure

Continues debug-playbook/phase-2-script-failures (steps 1-6).

Shortcut for steps 7-8: `debug_run(until='error', stop_before=true)` replays to the transition before the failure and answers `position`, `frames`, `error_at`, `failure` and the `value` or `env` in one reply. `frames_total: "unknown"` (+ `frames_note`) = a stack too deep to read cheaply: page it with `debug_inspect(what='frames', limit=…)`.

7. Follow the report's `rewind`, with `restart=true`:
   - Explicit `(error)`: `until='term',term_id=<position.term_id>` -> Compute on the error, full env; term computed exactly once.
   - Builtin/machine error (`rewind.failure`; missing force: `rewind.at_builtin`): `until='steps',steps=<steps_total>-1` -> Return; inspect `frames` and the value `state.value` (step 8 below).
   - Earlier node/env: `until='builtin',builtin=<name>`; later visits: resume without restart (failure ends at steps_total). Never `until='term'` on last_term_id: its first visit may hold unrelated values.
8. `what='env'` rows index,debruijn,type,summary,ref,name,binder_term_id,binder_uplc_line (index 0 outermost, debruijn 1 innermost; names repeat: use binder_uplc_line). `what='frames'`: index 0 receives the next value; per frame term_id/uplc_line, env `frames.N.env`; at a failure `frames.0` FrameAwaitArg = partial builtin or non-function (`detail` like `builtin ifThenElse (0/3 args, 1 forces)`), FrameForce = forcing a non-delay. `what='value',path=<ref>` expands (env.values.7, state.value): Data Constr has fields, tag 121+n = constructor n; bytes hex.
9. `debug_source(dbg_id,around='current',radius=20,with_ids=true)`: n> current, n* breakpoint, lines[].term_ids. `debug_inspect` what='term' = subtree; `what='context',path='tx_info.outputs.0'` = typed context (tx_redeemer paths).
