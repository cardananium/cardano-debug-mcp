---
gist: how traces are emitted and reported, until='trace' pinning, the Aiken trace pattern.
---
# Traces

`[[(force (builtin trace)) (con string "msg")] v]` logs msg at saturation, returns v: the only observable side effect. Reports: `traces.total,new` (≤10 new lines, 300 chars each), `new_total` if more. Full log: `what='traces'` pages, `session/{dbg_id}/traces.txt`.

`until='trace', contains='…'` pins the exact next match (coarse scan, then deterministic rewind/replay). `steps_this_call` counts replay too; `steps_total` is position. Report: a `note` that replay pinned it, or `pinning` if the time cap cut replay (repeat the call). Profile traces carry `step,term_id,uplc_line` of the charged application site, for `until='term'`. Aiken `(force [[(force (builtin trace)) msg] (delay body)])` logs before the code it describes.
