---
gist: phase-1 procedure: read the error row, open the tx_inspect section its location names, apply the fix, add witnesses.
---
# Phase 1: ledger rule failures

1. `phase1.errors[]`: `name,message,locations[],hint,data` (`actual_fee/min_fee,expected_hash/provided_hash,missing_key_hash`).
2. `tx_inspect` section by location: fee/script_data_hash/total_collateral -> body; inputs/reference_inputs/collateral.N -> inputs (role, spend_index, redeemer, script_hash, resolved address/value/datum); outputs.N -> outputs; required_signers.N, vkeys.N -> witnesses.signature_check; redeemers.N -> redeemers (error also gives canonical ref); else mint/withdrawals/certs/datums/scripts or raw_json + path.
3. Fix by rule (docs(error=<Name>)): FeeTooSmallUTxO -> data.min_fee; MissingVKeyWitnesses -> the listed key signs; OutsideValidityIntervalUTxO -> slot/validity; ScriptDataHashMismatch -> redeemers/datums/used models; ValueNotConservedUTxO -> inputs+mint+withdrawals vs outputs+fee+burn+deposits.
4. `tx_add_witnesses(tx_id,witnesses=[…])` merges vkeys / a signTx set and revalidates; added_key_hashes must cover the missing hashes.
