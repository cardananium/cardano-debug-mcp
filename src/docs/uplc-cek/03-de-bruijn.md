---
gist: de Bruijn indices vs env row index, where names come from, identifying binders by line.
---
# Variables: de Bruijn indices and names

De Bruijn 1 = innermost lambda, 2 = next outward. `what='env'` rows run outermost-first, `index` 0 (used in `ref=env.values.N`): de Bruijn k among n values is `values[n-k]`, shown as `debruijn=total-index`; also `type`, `summary`, `ref`.

Names come from enclosing lambdas: if binder count = env size, rows add `name,binder_term_id,binder_uplc_line`; otherwise a `note` says only debruijn is authoritative. On-chain bytes lack names (every binder `i`): identify by `binder_uplc_line`. Outside Compute: `total:0`, pointing to saved `frames.N.env` or error `rewind`.
