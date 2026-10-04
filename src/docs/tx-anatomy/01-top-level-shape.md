---
gist: the four elements of a Conway transaction: body, witness set, is_valid, auxiliary data.
---
# Top-level shape

- 0 `transaction_body` map: integer keys below; `tx_id`=blake2b-256(body bytes)
- 1 `transaction_witness_set` map: keys 0..7
- 2 `is_valid`: true = all Plutus scripts succeed; false = included phase-2 failure, only collateral moves
- 3 `auxiliary_data` / null: metadata labels, optional native/Plutus scripts; hash in body key 7
