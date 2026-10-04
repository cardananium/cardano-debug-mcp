---
gist: term id range and stability, uplc_line, script_locate, why decompiler lines never map to positions.
---
# Term ids vs UPLC lines

`term_id` = engine id − `debug_open.term_id_base`, range `0…term_count-1`; stable across restarts. A fresh session re-indexes: never reuse another session's ids. Discharged results/error sentinels: synthetic out-of-range ids, never positions.

`uplc_line` = 1-based session-listing start line. `script_locate(dbg_id, term_id=…)` -> line/excerpt; `uplc_line=…` -> `candidates`. `until='uplc_line'` stops before any term on that line (bracket-only: nearest term, noted in `stopped.detail`). Decompiler pseudocode and `uplc/uplc_canonical` renderings (program header, renamed binders) number lines differently: map via term id, never line.
