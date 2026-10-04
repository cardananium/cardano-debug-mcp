---
gist: what each debug_run stop condition means, stop_before and hit, the error position, the rewind call and what a long run reports.
---
# debug_run

- `until`: `uplc_line` stops before any term starting on `line`; `trace` at the next trace (containing `contains` if given); `builtin` at the next evaluation of `builtin` (a name the script lacks: `invalid_argument` with close names); `budget` once cpu spent >= `cpu`. `hit=N` makes term | uplc_line | builtin | trace stop at the N-th visit (matching trace) counted from this call. Pinning, breakpoints, caps: debug-playbook/stop-conditions.
- `until='error'` with `stop_before=true` (also `until='done'` when the script may fail): when the script fails the machine is replayed to the transition before the failing one and the reply carries that state: `position`, `frames`, `error_at` (where it failed), `failure` (explicit | machine_error | builtin), `error_message`, and `env` (Compute state, an explicit `(error)` term) or `value` (Return state: the value in hand, `state.value`). One call instead of run, rewind, inspect.
- A plain error stop leaves no env or frames: `position.term_id` is the explicit `(error)` term, null for a failing builtin or machine error (`last_term_id` = the last computed term), and `rewind` holds the calls that land before the failure (`stop_before`, `one_step_before`, `failing_term`, `at_builtin`); debug-playbook/phase-2-rewind.
- A call the engine refuses (bad term_id, cpu, builtin, hit) changes nothing: `restart` and new breakpoints apply only to an accepted call. The engine's own budget cap (about 1e13 cpu) ends a run as an error that names the cap.
- A run longer than one 2 s chunk keeps the traces of every chunk (`traces.new` up to 10, `new_total` all). `frames_total` is `"unknown"` after a cut run (`limit`, `cancelled`) on a possibly deep stack: debug_inspect(what='frames') reads it.
- The report's UPLC window marks `>` the current line and `*` breakpoints (term-id ones too); pseudocode lines are never positions. `timeout_ms` defaults to the server run timeout (60 s).
- `show_it` (stopped on an error): the ready `ui_link` call that opens the failing term for the user; make it unasked.
