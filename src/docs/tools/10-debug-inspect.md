---
gist: the debug_inspect views (position, frames, env, value, term, context, traces, budget), refs, depth, paging and when the stack is read.
---
# debug_inspect

| what | Shows |
|---|---|
| position | UPLC window, innermost frames |
| frames | continuation stack |
| env | variables in scope: name from the enclosing lambdas, type, summary, ref |
| value | expands a ref: `env.values.7`, `env.values.4.constant.values.0`, `frames.0.env.values.2`, `state.value` |
| term | the current term's UPLC subtree (depth-limited), or the one named by `term_id` |
| context | ScriptContext as typed JSON by path (`tx_info.outputs.0`, `purpose`) |
| traces, budget | the log; spent vs declared |

- env rows: index 0 = outermost binding, the last row = innermost; a Var's de Bruijn index counts from the innermost (1). The environment exists only in Compute state (empty in Return / Done / Error; the `note` says how to reach one).
- `context` takes tx_redeemer(part='context')'s path grammar and integer policy (language key optional).
- Integers are decimal strings, bytes hex. Large PlutusData is depth-limited with `{… N keys}` summaries; bytes are cut at 64 hex chars (full length given). Lists page with offset / limit (20, max 100); the whole lazy state is `session/{dbg_id}/state.json`.
- The engine copies the whole stack on every frame read (cost grows with depth squared; about 5,600 frames overflow it and lose the session). Reports therefore carry `frames_total: "unknown"` plus `frames_note` after a cut run or once a read was slow; `what='frames'` reads them on request (rows are `index` here, `depth` in run reports).
