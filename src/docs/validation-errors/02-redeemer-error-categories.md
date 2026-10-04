---
gist: how tx_redeemer(part='error') maps a phase-2 error name to its category (budget, decode, missing_script, missing_datum, context_build, machine_error, none).
---
# Redeemer error categories

`tx_redeemer(part='error')` category (by phase2_errors[].name, else message): budget NoEnoughBudget; decode ScriptDecodeError; missing_script MissingRequiredScript/ScriptLookupError; missing_datum MissingRequiredDatum/MissingRequiredInlineDatumOrHash; context_build BuildTxContextError or a context refusal (script never ran); machine_error MachineError (data_shape: wrong datum/redeemer/context Data) or default; none success. within_budget:false = over declared ex-units though script finished.
