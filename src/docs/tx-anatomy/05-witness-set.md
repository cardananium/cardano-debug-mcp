---
gist: witness set keys 0-7 (vkeys, native scripts, bootstrap, Plutus scripts, datums, redeemers) and the rules on each.
---
# Witness set

- 0 vkeywitness: `[vkey (32 B),signature (64 B)]`, Ed25519 over body hash (`InvalidSignature`); body key credentials/`required_signers` need one (`MissingVKeyWitnesses`); unused `ExtraneousSignature`
- 1 native_script: `[0 pubkey|1 all|2 any|3 n_of_k|4 invalid_before|5 invalid_hereafter]`; phase 1 (`NativeScriptIsUnsuccessful`)
- 2 bootstrap_witness: Byron `[vkey,signature,chain_code,attributes]`
- 3/6/7 plutus_v1/v2/v3_script: raw bytes, no `[tag,bytes]` wrapper
- 4 plutus_data: datums by value for required hashes (`MissingDatum,ExtraneousDatumWitnesses`)
- 5 redeemers: nonempty legacy `[+ [tag,index,data,ex_units]]` or Conway `{[tag,index]=>[data,ex_units]}`

Required scripts: witnesses or `script_ref` (`MissingScriptWitnesses`); unneeded witness scripts `ExtraneousScriptWitnesses`; reference scripts never extraneous.
