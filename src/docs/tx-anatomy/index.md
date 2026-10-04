---
when: Conway transaction fields (CDDL keys), fees / min-UTxO / collateral rules, redeemer tags and index rules, scripts and datums, script_data_hash, validity interval and slot-time conversion, how each maps to tool outputs.
---
# Cardano transaction anatomy (Conway era)

A Conway transaction is CBOR [body, witness_set, is_valid, auxiliary_data | null]: actions, authorization, the phase-2 success claim, metadata (invisible to scripts). CDDL keys, ledger rules, tool outputs.
