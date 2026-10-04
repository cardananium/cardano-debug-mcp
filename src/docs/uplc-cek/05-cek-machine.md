---
gist: the four machine states and their fields, step accounting, the six frame kinds and their printed details.
---
# The CEK machine: states, environment, frames

| `position.machine_state` | State / exposed fields |
|---|---|
| `Compute` | term + env + stack; `position.term_id/kind/uplc_line` about to run; `state.term,state.env,state.context` |
| `Return` | value + stack; `position.term_id:null`, `last_term_id` (+kind/line) = source; `state.value`, frames; no env |
| `Done` | result at `state.term`; `status:done`, last real term as position, `frames_total:0` |
| `Error` | failing term id; see uplc-cek/errors |

One `debug_run` step = one transition. Compute costs a machine step; Return is free except builtin saturation. `what='frames'`: innermost = 0; run/position reports show first 6; bottom `NoFrame` omitted.

| Frame | On receiving a value / printed detail |
|---|---|
| `FrameAwaitFunTerm` | function of `[M N]` arrived; compute N in saved env; N's `term_id/uplc_line,env_size` |
| `FrameAwaitArg` | argument arrived; apply saved function; e.g. `λx (term 1 @ line 2), 3 captured`, `builtin sndPair (0/1 args, 2 forces)` |
| `FrameAwaitFunValue` | function arrived; apply saved argument (case fields, first innermost); argument summary |
| `FrameForce` | enter delay body or force builtin; no detail |
| `FrameConstr` | compute fields left→right; `tag k, i values ready, j terms pending`, constr `term_id` |
| `FrameCases` | scrutinee `constr k` selects branch k; fields become `FrameAwaitFunValue` frames; `n branches` |
