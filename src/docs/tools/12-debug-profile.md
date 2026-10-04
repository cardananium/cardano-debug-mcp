---
gist: debug_profile coordinates, how to land on a hot term, and its run bounds.
---
# debug_profile

Term ids and `uplc_line` values in the report are the session's canonical UPLC coordinates: debug_source shows the lines, `debug_run(until='term', term_id=…)` lands on a hot term (`hit=N` for a later visit). The run is bounded by `max_steps` (default 5,000,000) and `timeout_ms` (default: the server run timeout, 60 s); other commands on the session answer `busy` meanwhile. Report fields: debug-playbook/budget-analysis; the full engine report is `session/{dbg_id}/profile.json`, announced in `resources` by the first profile of a session only.
