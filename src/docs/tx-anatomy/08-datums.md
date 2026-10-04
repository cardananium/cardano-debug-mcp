---
gist: datum by hash vs inline, datum-less script outputs per version, extraneous witness datums.
---
# Datums

- By hash (`[0,hash32]` / Alonzo third element): preimage in witness key 4; hash=blake2b-256(datum CBOR). Inline datums on other inputs/reference inputs don't satisfy it.
- Inline (`[1,data]`): no witness entry; V2/V3 read TxOut.
- Datum-less script UTxO: V1/V2 unspendable (ledger phase 1; validator lookup `MissingRequiredInlineDatumOrHash`); V3 gets `Nothing`.
- Unneeded witness datum: `ExtraneousDatumWitnesses`, unless an output references its hash.
