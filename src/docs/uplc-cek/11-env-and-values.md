---
gist: paging env rows, expanding refs with what='value', ref path forms, context and term views.
---
# Reading the environment and values

`what='env'` pages via `offset/limit` (20/page). Expand a row `ref` via `what='value', path=<ref>`; `depth` 2 (max 5); `children_refs` lists collapsed nodes; `truncated` = 8k-char cut.

Paths: `env.values.3.constant.data.fields.1`, `env.values.3.constant.values.0` (list), `frames.0.env.values.2`, `frames.1.value`, `state.value` (Return), `state.term` (Compute/Done). Integers are strings, bytes hex, decoded Data typed JSON. `what='context', path='tx_info.outputs.0'` follows tx_redeemer's path grammar/integer policy. `what='term'`: current subtree, or `path=<term_id>`.
