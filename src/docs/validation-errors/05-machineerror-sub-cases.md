---
gist: the MachineError message families (explicit error, builtin failure on bad data, argument-count / open term) and the first move for each.
---
# MachineError sub-cases

- `the validator crashed / exited prematurely`: explicit error (Aiken fail/expect, Plutus traceError); last trace (part='traces') -> debug_open -> `debug_run(until='error')` -> rewind.
- Builtin `divide By Zero,unexpected empty list,type mismatch,failed to deserialise PlutusData,Out of Bounds`: bad data, often datum/redeemer shape; compare part='summary' `redeemer_data/datum` with blueprint (CIP-57).
- `attempted to apply an argument to a non-function` / open term: argument count (V3 run as V2 or vice versa).
- `execution went over budget` never appears.
