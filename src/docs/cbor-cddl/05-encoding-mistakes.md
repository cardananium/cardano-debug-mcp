---
gist: symptom -> likely cause -> fix for bytes that will not decode or validate (odd hex, truncation, trailing data, wrong era, double-wrapped scripts…).
---
# Common encoding mistakes

| Symptom | Likely cause | Fix |
|---|---|---|
| `invalid_argument`: `hex with an odd number of digits (3)` (bad envelope `cborHex`: `structural_error.kind invalid_hex`) | dropped nibble, `0x` inside, base64/bech32 as hex (`input_kind` says which) | re-copy; base64 and cardano-cli envelopes are accepted |
| `unexpected_eof` at offset N | truncated paste, or length prefix > payload (`5820` before 31 bytes) | compare declared length with the rest |
| `trailing_data` at N, k bytes left (`Malformed CBOR`: no typed decoder accepts them) | concatenated items (body + witness set), short prefix, or body instead of transaction | wrap in an array (`84 body witnesses f5 f6`) or fix the prefix |
| `got text "<hex digits>"` | hex written as text (`7840…`, not `5820…`) | decode the hex before encoding |
| `expected array with length 4, got 3` at `$` for `transaction` | no `auxiliary_data / nil`, or pre-Alonzo 3-element tx | append `f6`, or `f5 f6` |
| `expected value 0, got 1` at output `$[2][0]` | `datum_option` index and payload disagree | inline `82 01 d818 <bytes>`, hash `82 00 5820 <32 bytes>` |
| `got #6.258(…)`, `unexpected key 7`/`19`, `range 0 <= value <= 3, got 4` | Conway bytes, older preset (cbor-cddl/eras) | `cddl='conway'` |
| `bytes` node content starts `58 xx 01 00 00` / `59 xxxx 01 00 00` | double-wrapped Plutus script | one byte string around the flat `01 00 00` |
| `expected map { … }, got array(0 items)` at a map slot | `80` where a map `a0` belongs (empty witness set) | write `a0` |
| `expected tagged data #6.121([ * a0 ]), got #6.1280(…)` in `plutus_data` | constructor ≥ 7: bundled `constr` omits tags 1280-1400; the node accepts them | nothing; trust the hint |
