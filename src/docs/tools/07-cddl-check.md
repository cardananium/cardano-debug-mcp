---
gist: the fields of a cddl_check answer (error, outline, roots_by_kind, rule references, formatted).
---
# cddl_check

Answer: `valid`, `verdict`, `error` {kind, message, line, col, snippet, unresolved[{name, line, col}]} (`parse_error` covers a rule defined twice), `outline` {rules, roots, roots_by_kind (which roots accept an array / map / bytes / uint / tag:N — the candidates cbor_validate tries), groups, parameterised}; `rule=<name>` adds `references` (its definition and uses; a prelude name such as `uint` has `kind: 'prelude'`); `format=true` adds `formatted`, the pretty-printed schema windowed by offset / limit (whole lines within 16,000 chars: `next_offset` continues where the text stops, an offset past the end answers a note). Outline lists show 100 names each, the rest counted in `*_omitted`. CDDL syntax: cbor-cddl/cddl-cheat-sheet.
