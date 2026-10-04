---
gist: debug_open from parts (script + datum / redeemer / context) or program-only, and what each session lacks.
---
# Sessions outside a transaction

- Parts: `debug_open(script=<hex>,plutus_version='V2',datum=…,redeemer_data=…,context=<ScriptContext PlutusData hex>,cost_models=[…],protocol_major=11,ex_units={steps,mem})`; V3 takes context only. `fidelity.level='parts'`; another tx's `context.cbor` gives realistic context.
- Program-only: `debug_open(script=…)`, hex or text starting `(program` (native-script hex: `native_script`); no arguments/declared budget/context (`no_script_context`). A hex session decompiles by `dbg_id`; a text one answers `no_script_bytes` (pass hex via `script`). An unapplied validator finishes at once (awaiting arguments); probe with literal values.
