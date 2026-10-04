---
when: UPLC grammar and constants, de Bruijn indices vs names, builtins, CEK states and the six frame kinds, a worked micro-trace, budget model, traces, the four error classes, compiled-code idioms, term ids vs UPLC lines.
---
# UPLC and the CEK machine as this debugger shows them

UPLC is strict, untyped lambda calculus with builtins and, since Plutus Core 1.1.0 (CIP-85), constr/case. Its sections: terms, CEK states, frames, costs and errors as debugger fields. script_decompile pseudocode reads logic more easily; positions are always {term_id, uplc_line} in the session's canonical UPLC listing.
