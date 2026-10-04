---
gist: the four error classes (explicit, builtin, machine, budget), their messages and positions, and the rewind call.
---
# Errors: explicit, builtin, machine, budget

| Class | Cause | `debug_run(until='error')` |
|---|---|---|
| explicit | `(error)` | `position.term_id` = Error term, `kind:"Error"`, `error_message:"the validator crashed / exited prematurely"` |
| builtin | wrong Data kind (`unConstrData` in uplc-cek/builtins, `unIData` on bytes); empty `headList/tailList` (`unexpected empty list …`); `divideInteger` by 0 (`divide By Zero: 1 / 0`); bad UTF-8 / negative sizes | `position.term_id:null`, `last_term_id` = last computed term (often last arg); message + offending value, `…redacted…` after 10 lines |
| machine | applying non-function, forcing non-delay, missing/extra builtin force, missing case branch | as builtin (`rewind.failure` = `machine_error` vs `builtin`); `error_message`: `attempted to apply an argument to a non-function`, `attempted to instantiate a non-polymorphic term`, `a builtin received a term argument…` (missing force; `rewind.builtin` names it, `rewind.at_builtin`: until='builtin' stops on its node), `Cases: … are missing branch for constr …` |
| budget | a declared budget is never enforced; only the engine's own cap (about 1e13 cpu) stops a run | `budget.over_budget:true`, status stays `ready/done`; at the cap an error naming it |

First three: `status:"error",stopped.kind:"error",stopped.detail=<message>,frames_total:0`, empty env; failed transition sets state `Done(Error)`.

Fastest: `debug_run(restart=true, until='error', stop_before=true)` answers with the state before the failure (`env` or `value` included). Report `rewind` = `debug_run(restart=true, until='steps', steps=<steps_total at error>-1)`. Explicit error: also `until='term', term_id=<error id>` (computed once). Then `what='frames'` (e.g. `FrameAwaitArg "builtin divideInteger (1/2 args, 0 forces)"`), `what='value', path='state.value'` (arg 0); or `until='builtin', builtin='divideInteger'` stops earlier at the builtin node, with env. Never rewind to `last_term_id` (terms repeat). Tx-mode `debug_open` warns of validator failure; phase-2 hints use these classes.
