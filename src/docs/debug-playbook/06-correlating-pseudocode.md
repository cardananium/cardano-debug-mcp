---
gist: tying a pseudocode fragment to a UPLC position by trace strings, builtins, constants and control structure.
---
# Correlating pseudocode with a UPLC position

Same term tree, but no line map: match content, never line numbers. Anchor it with `debug_source(dbg_id, find='…')`: a case-insensitive substring over the canonical listing, answering `matches[]` = `{line, term_id, kind, label?, text}` and `matches_total` (`max_matches` default 20, max 100; `line_from` continues after the last match). Then `debug_run(until='term', term_id)`, `debug_source(around=term_id)` or `script_locate(dbg_id, term_id)`.

- Trace strings: `fail @"msg"` / `trace("msg")` <-> `(con string "msg")`: `find='msg'`; `debug_profile.traces.items[].term_id` or `until='trace'`.
- Builtins: `builtin.un_list_data(…)` <-> `(builtin unListData)`: `find='unListData'` lists every occurrence (`un_list_data` matches too); `until='builtin'` finds the next evaluation, `debug_profile.builtins[]` counts calls.
- Constants: `#"9e3c…"` <-> `B #9e3c…` inside `(con (list data) […])`: `find='9e3c'` for policy ids, asset names, thresholds. A long constant line comes back cut around the hit; one constant used twice has two matches: tell them apart by the builtin or lambda around each.
- Shape: `(delay …)` branches of `ifThenElse`, `(error)` alternatives, enclosing `(lam …)` chain; `when q is { Constr<2>(…) -> … _ -> fail }` -> `unConstrData`, tag comparison with `equalsInteger`, error branch.

Confirm with `debug_source`; a `// Warning` on church-bool polarity or V1/V2 can mean an inverted condition.
