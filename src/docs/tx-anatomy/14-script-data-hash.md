---
gist: how script_data_hash is computed (redeemers, datums, language views) and why it mismatches.
---
# script_data_hash

`blake2b-256(redeemers_bytes || datums_bytes || language_views)`: witness fields 5 and 4 as serialized (absent datums omitted), then canonical `{language=>cost_model}` per used language. V1 legacy double encoding; V2/V3 plain definite arrays. Datums without redeemers: `A0 || datums || A0`. Required iff redeemers or datums exist.

Stale builder cost model or validator/chain parameter mismatch: `ScriptDataHashMismatch`. Validator exposes expected hash plus redeemer CBOR, datum CBOR (set tag 258), cost-model CBOR, languages used.
