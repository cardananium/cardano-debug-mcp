---
gist: the first call for a trace string, a wrong value, or a wrong index / missing script or datum.
---
# Symptom -> first tool to call

Trace string only -> `tx_redeemer(part='traces',filter=…)`, then `until='trace'`. Wrong value -> `until='error'`, `rewind` (debug-playbook/phase-2-rewind), env/frames/value. Wrong index / missing script/datum -> `part='error'`, inputs `spend_index/script_hash`.
