---
gist: PlutusData on the wire: constructor tags, integer and bignum ranges, the 64-byte bounded_bytes chunk rule, reference-encoder forms.
---
# PlutusData encoding rules

`plutus_data = constr<plutus_data> / {* plutus_data => plutus_data} / [* plutus_data] / big_int / bounded_bytes`.
- Constructors (tags 121-127, 1280-1400, 102: cbor-cddl/tags): `Constr 0 []` = `d87980`, `Constr 7 []` = `d9050080`.
- Integers: -2^64 .. 2^64-1 as major 0/1, beyond as tag 2/3 (reference encoders never bignum a value that fits).
- Bytes (`bounded_bytes`, as the ledger): a definite string holds ≤ 64 bytes (65: `length to be in the range 0 <= value <= 64, got 65`; under `plutus_data`: `got bytes 0x… (65 bytes)`); longer values are indefinite strings of definite ≤ 64-byte chunks (`5f 5840 <64 bytes> 41 <1 byte> ff`), valid whatever the total; a chunk over 64 bytes fails, as on the node (`got 70 bytes in chunk 0`; under `plutus_data`: `got indefinite bytes(N chunks)`, the hint names it): re-chunk. Per chunk only under `bounded_bytes`; every other `.size` measures the whole string: two 32-byte chunks are not `hash32` (`got 64 bytes`); a metadatum string over 64 bytes fails chunked or not (the ledger joins chunks). `5fff` is empty.
- Reference encoders: empty list `80`, non-empty list indefinite (`9f … ff`), maps definite; all forms validate.
