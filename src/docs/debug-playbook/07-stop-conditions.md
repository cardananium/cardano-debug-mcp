---
gist: every until kind, trace / budget pinning by replay, persistent breakpoints, per-call step and time caps, restart.
---
# Stop conditions, breakpoints, pinning, restart

- `until`: `error`/`done` = finished (tx mode: `parity` = stepper spend vs validator's calculated units); `steps` (`steps=N`) after N transitions; `term`/`uplc_line` (`term_id=`/`line=`) before execution, resume steps off the paused term (gdb); `builtin` (`builtin=`) before its evaluation, case/underscores ignored, a name the script lacks -> `invalid_argument` + close names.
- `trace` (`contains=`; stops in Return just after the trace) / `budget` (`cpu=`): coarse scan, then deterministic replay from step 0 pins the exact step; `steps_this_call` counts replayed transitions, `steps_total` = machine position. Replay cut by the time cap: `pinning{anchor_steps,rewound_from,replayed_steps}`, `steps_total` = rewound position; repeat the SAME `until/contains/cpu` (changing it abandons replay).
- `hit=N` (term / uplc_line / builtin / trace): stop at the N-th visit instead of the first. `stop_before=true` (error / done): stop one transition before the failure, with the value or env in the reply.
- `breakpoints.{term_ids,uplc_lines}`: persistent, checked before each term; `clear_breakpoints=true` removes; out-of-range/term-less lines -> `invalid_argument` (names the nearest term).
- Per-call caps: `max_steps` default 2,000,000, max 50,000,000; `timeout_ms` default 60 s, max 110 s; `stopped.kind='limit'`: repeat the call.
- Finished machine: `restart=true` runs again (resets traces/counters; keeps ids, lines, breakpoints).
