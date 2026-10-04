---
gist: what bundle_export writes, offline replay with tx_load(bundle), what a de-uplc DebuggerContext lacks.
---
# Offline bundles

`bundle_export(tx_id)` writes bundle v1 (`tx_cbor,validation_input_context`, provider rows, `slot,protocol_major`, `validation_result` with per-redeemer bytes, `on_chain`), returns `path`; `tx_load(bundle=…)` replays offline (`validated:true` when embedded). A de-uplc `DebuggerContext` holds only tx, network, UTxOs, cost models; `defaults_applied` fills the rest (validation-errors/defaults-applied), so fee/deposit/validity/withdrawal/certificate errors may be import artefacts; scripts, datums, ScriptContext unaffected.
