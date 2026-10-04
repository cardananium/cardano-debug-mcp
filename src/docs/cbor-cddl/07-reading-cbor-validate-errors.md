---
gist: cbor_validate error kinds (mismatch, generic, limits, tool errors) and the path grammar.
---
# Reading cbor_validate errors

`cbor_validate` returns `valid`, `verdict`, `errors[]` (head first), `additional_count`, `oddities[]`, `hints[]`, `structural_error` for malformed CBOR. Error fields:

| Field | Meaning |
|---|---|
| `kind` | `mismatch` (incl. `unexpected key N`) / `map_cut`; `generic` (`map missing key: N`); `input_parse` (malformed CBOR); `nesting_too_deep` (more than 32768 levels, native scripts included, or a depth limit while shaping the answer) / `validation_too_complex` (work bound): run stopped, bytes not proven wrong (`unexamined`, `valid: null`). Tool errors instead: unknown or group `rule` = `invalid_argument` (`argument: 'rule'`); unusable schema = `invalid_schema`, `error.kind` `parse_error` / `unresolved_references` / `no_rules` |
| `path` | `$` root; `$[n]` array index or int map key (`$[0][0][0]` = body key 0, first input, first slot; `$[-1]`); `$.name` text key (`$["a.b"]` if not an identifier); other literal keys `$.h'0102'`, `$.true`, `$[1.5]`; composite keys in diagnostic notation (`$[[2, h'…']]` etc.), an over-long key by entry index (`$[1]`) or `$[...]`; an `unexpected key` row names the entry (`$[0][19]`); `embedded: true` inside a `.cbor` payload |
| `path_short` | `path` abbreviated past 120 characters (both ends and a segment count); `path` itself is cut past 1,000, so a row deep in a huge document carries the short form only |

More fields, head vs additional rows and `structural_error`: cbor-cddl/cbor-validate-error-details.
