Explain this Plutus script.

Script: {{script}}
Plutus version: {{plutus_version}}
Purpose: {{purpose}}

1) script_decompile it (pseudocode, first 120 lines): pseudocode is the primary way to understand a script. Read the leading // Info / // Warning / // Note lines, page further as needed.
2) Summarise what the validator checks, the datum and redeemer shapes, the failure paths (fail / expect), and what the decompiler was unsure about.
3) Only for a branch the notes mark as uncertain (church-bool polarity, V1/V2 ambiguity): script_decompile with view='uplc', and confirm the pseudocode reading against the exact UPLC.
4) Pseudocode line numbers are not debugger positions: to step through it, debug_open and work in {term_id, uplc_line} of the session's UPLC listing (debug_source; find='<constant | builtin>' anchors a pseudocode fragment); docs(topic='debug-playbook', section='correlating-pseudocode') ties them to UPLC.
5) When the user wants to see a region or does not follow a branch, build ui_link(app='decompiler', script, annotations with script_decompile's line range as target) unasked (section='show-it-in-a-ui' of the playbook); open=true to show it to the user; to share it, write the URL.
An unclear builtin, Data shape or ScriptContext field: docs(topic='uplc-cek') (builtins, idioms) or docs(topic='script-context') (TxInfo fields, PlutusData encoding), rather than guessing.
