---
gist: ui_link annotation targets per app and tab, where each address comes from (cbor_path grammar, tx_path, cbor_decode spans), what the server checks and drops.
---
# ui_link targets

`annotations: [{target, label?, hint?, severity: error|warning|info}]`. The server resolves your targets where it can and drops the ones that point at nothing: `dropped` gives the reason and `available` (what exists there). Generated targets are not re-checked.

- transaction-validator: `{kind:'tx_path', path}` = a dotted path of the decoded transaction, the same as tx_inspect(section='raw_json') takes (`transaction.body.fee`, `transaction.body.outputs.0`; a `locations` entry of tx_validate); `{kind:'diagnostic', index}` (errors phase 1, phase 2, then warnings; checked once validated) or `{name, occurrence?}`; `{kind:'redeemer', tag:'Spend', index:0}` (the tag in any case; `Spend Mint Cert Reward Vote Propose`).
- general-cbor / cddl-validator: `{kind:'cbor_span', offset, length}` = bytes of the `cbor` input: cbor_decode(as='spans') rows `{path, type, offset, length}`, or `byte_offset` / `byte_length` of a cbor_validate row; it must lie inside the input. `{kind:'cbor_path', path}` = a validator path from `$`, as cbor_validate rows and cbor_decode spans spell it: `$[0][2]` (array index or integer map key), `$.name`, `$["a b"]`, `$.h'01'` (cbor-cddl/reading-cbor-validate-errors has the grammar). cddl-validator also `{kind:'cddl_range', start, end}` (characters of the schema: a row's cddl_range; needs the schema text, so the link embeds it) and `{kind:'cddl_rule', name}` (a declared rule; also embeds the text).
- de_uplc: `{kind:'term', term_id}` and `{kind:'uplc_line', line}` = the position of debug_run / debug_inspect / debug_profile / script_locate. Checked against an open session of the same program (dbg_id, or the same redeemer / script); without one they pass unchecked and `notes` says so.
- decompiler: `{kind:'pseudo_line', line, end_line?}` = 1-based script_decompile lines; pass the same `decompile_options` (defaults match script_decompile's). Checked against the cached pseudocode of that script once script_decompile ran.
- cardano-cbor: no targets.
