---
gist: what each tx_inspect section shows, paging (rows, page_cut), datum depth and when it lists resources.
---
# tx_inspect

| section | Shows |
|---|---|
| body (default) | summary + counts |
| inputs | spend index, redeemer ref and, once tx_load resolved them, address, value, datum and reference script of each UTxO |
| outputs, mint, withdrawals | rows (mint / withdrawals with redeemer refs) |
| redeemers | ref, target, script hash, ex-units, data |
| scripts | witness and reference scripts (a reference script of unknown language says `plutus_version: "unknown"`) |
| datums, witnesses | witnesses with `signature_check` |
| certs, governance, aux | aux = metadata |
| raw_json | any path into the decoded CSL JSON |

Rows are paged (`offset/limit`, default 20); a page also stops at ~24k characters (`page_cut` + `next_offset`). Datum trees are cut at `depth` (default 3); integers are decimal strings. Field ↔ CDDL key mapping: tx-anatomy/tool-outputs.

`section` may be left out (body). `resources` (decoded.json, cbor, validation.json once validated) is listed by `body`, and by a truncated `raw_json`; other sections and pages do not repeat it.
