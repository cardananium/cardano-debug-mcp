---
gist: which call answers which context question (purpose, exact context, positional Data, session context, datum, time, failures).
---
# How to use this while debugging

| Need | Call / result |
|---|---|
| Purpose/index/script/version | `tx_load.redeemers[]` (`ref,target,script_hash,plutus_version`); `tx_redeemer(part='summary')`; `debug_open` (`plutus_version,applied`) |
| Exact context, true indices/ex-units | `tx_redeemer(part='context', path='tx_info.inputs.0', depth=4)`; root `depth=1` shows version; full `context.json` |
| Positional Data / `fields[7]` | `context.cbor` -> `cbor_decode(hex, as='PlutusData', path=…, depth=…)` |
| Session context | `debug_inspect(what='context', path='tx_info.outputs.0')` |
| Datum/redeemer | `part='summary'`; witness set: `tx_inspect(section='datums'\|'redeemers')` |
| Data at builtin | `debug_run(until='builtin', builtin='unConstrData')` -> `what='env'`, expand ref with `what='value'` |
| Time | `tx_load.validity` slots vs `part='context', path='tx_info.valid_range'` ms |
| Context failure | `part='error'`: `context_build/missing_datum/missing_script`, phase-2 name + hint |
