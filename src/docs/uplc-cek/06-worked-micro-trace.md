---
gist: a tiny program stepped transition by transition: positions, frames, env and budget at each step.
---
# Worked micro-trace

`(program 1.1.0 [(lam x x) (con integer 42)])` via `debug_open(script=…)`. Listing: `1 [`, `2 (lam x`, `3 x`, `4 )`, `5 (con integer 42)`, `6 ]`; term ids: Apply 3 (line 1), Lambda 1 (2), Var 0 (3), Constant 2 (5).

| steps_total | machine_state, position | frames (innermost first) | cpu / mem spent |
|---|---|---|---|
| 0 (open) | Compute term 3 `Apply` line 1 | — | 100 / 100 (startup) |
| 1 | Compute term 1 `Lambda` line 2 | `FrameAwaitFunTerm` (arg term 2 line 5, env_size 0) | 16100 / 200 |
| 2 | Return (`last_term_id` 1); value = closure `λx` | `FrameAwaitFunTerm` | 32100 / 300 |
| 3 | Compute term 2 `Constant` line 5 | `FrameAwaitArg` "λx (term 1 @ line 2), 0 captured" | 32100 / 300 |
| 4 | Return (`last_term_id` 2); value `42` | `FrameAwaitArg` | 48100 / 400 |
| 5 | Compute term 0 `Var` line 3; env = `[{index 0, debruijn 1, name x, Con:Integer 42}]` | — | 48100 / 400 |
| 6 | Return (`last_term_id` 0); value `42` | — | 64100 / 500 |
| 7 | empty stack takes the value → `Done(42)`: `machine_state: Done`, position term 0 line 3 (last computed), `status` still `ready`, no env | — | 64100 / 500 |
| 8 | `stopped.kind: done`, `status: done`, same position, `state.term` = `42` | — | same |

4 Compute steps × 16000/100 + startup = 64100/500. `steps_total` counts the final settling transition; `debug_profile.totals.steps` is one less. Tx sessions end alike, plus `parity` (spent vs validator units).
