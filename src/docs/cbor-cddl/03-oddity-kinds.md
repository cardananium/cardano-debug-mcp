---
gist: why exact bytes matter for hashes and the seven oddity kinds the decoder flags (none is an error).
---
# Deterministic encoding and the oddity kinds

Ledger and validator accept every encoding of a value, but hashes (`tx_id`, datum, script data, auxiliary data) cover exact bytes: canonically re-encoding a datum changes its hash. The decoder flags non-canonical forms in `oddities[]` (rows: `kind`, `path`, `byte_offset` / `byte_length` of the item, or of a container's header, and a `note` with detail):

| Kind | Trigger |
|---|---|
| `IntNotShortest` | argument wider than needed (`1801` = 1) |
| `FloatNotShortest` | float fits narrower losslessly (`fb3ff0…` = 1.0) |
| `IndefiniteLength` | indefinite bytes/text/array/map |
| `MapKeysNotSorted` | keys not in bytewise order of their encodings (RFC 8949 §4.2.1: `1818` sorts before `20`; not shortest-first) |
| `DuplicateMapKeys` | two keys with identical encoding |
| `BignumForSmallInt` | tag 2/3 around a magnitude below 2^64 |
| `BignumLeadingZeroes` | bignum payload starts with `00` |

None is an error; provenance hints: indefinite non-empty lists = reference Plutus encoders; overlong int or small bignum = hand-rolled encoder or hex edit; unsorted keys = non-canonical serializer.
