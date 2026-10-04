---
gist: how to find the own input, continuing outputs, signatories, own mint, time, datum / redeemer, sibling scripts, reference inputs.
---
# Practical lookups for a debugger

| Need | Lookup |
|---|---|
| Own spend input | Match `purpose.utxo_ref` to `tx_info.inputs[i].out_ref`; redeemer ref `spend:i`, `tx_load.redeemers[].target` = `input <tx>#<ix>`. Address has own `ScriptCredential`; datum in `datum_option` |
| Continuing outputs | Filter `tx_info.outputs` by payment credential: `Constr 0 [Constr 1 [B own_hash], _]`. Read `value`, `datum_option`; hash datum needs a match in `data`. Body order |
| Signatories | `tx_info.signatories` = `required_signers`, not `vkey_witnesses`; a missing key was not added to the body list |
| Own mint | `purpose.policy_id` selects `mint[policy]`; V1/V2 first entry is `""/""/0` lovelace, not own policy |
| Time | POSIX ms = `zero_time + (slot-zero_slot)*1000`. Mainnet 4,492,800 / 1,596,059,091,000; preprod 86,400 / 1,655,769,600,000; preview 0 / 1,666,656,000,000. `null` = unbounded; missing `validity_interval_start/ttl` fails finite-bound checks |
| Datum/redeemer | after the outer lambdas, env `Con:Data` -> `what='value', path='env.values.N'`. V3 datum: `purpose.datum`, null if absent |
| Sibling scripts | `tx_info.redeemers` (tag/index order), e.g. batcher/withdraw-zero checks |
| Reference inputs (V2+) | Resolved like inputs; oracle datum in `datum_option` |
