---
gist: the CBOR tags Cardano uses (2/3, 24, 30, 102, 121-127, 1280-1400, 258, 259), their hex and where they appear.
---
# Tags used on Cardano

| Tag | Hex | Where | Content |
|---|---|---|---|
| 2 / 3 | `c2` / `c3` | `big_uint` / `big_nint` in `plutus_data` | big-endian magnitude bytes (tag 3 holds -1-n); `bounded_bytes` |
| 24 | `d818` | inline datum `data`, `script_ref`: `#6.24(bytes .cbor plutus_data / script)` | CBOR inside bytes; validator descends (`error decoding embedded CBOR` if broken) |
| 30 | `d81e` | `unit_interval = #6.30([uint, uint])`, `nonnegative_interval` | numerator / denominator |
| 102 | `d866` | `constr` general form | `[uint, [* plutus_data]]`: index, then fields |
| 121-127 | `d879`-`d87f` | `constr` | constructor 0-6, fields in the tagged array |
| 1280-1400 | `d90500`-`d90578` | valid on chain, in no era schema | constructor 7-127 (`tag - 1280 + 7`) |
| 258 | `d90102` | `set`, `nonempty_set`, `nonempty_oset` (Conway) | optional in Conway (`set<a0>`: cbor-cddl/cddl-cheat-sheet), absent before |
| 259 | `d90103` | `auxiliary_data_map` (Alonzo+) | `{?0: metadata, ?1: native scripts, ?2-4: v1/v2/v3 scripts}` |
