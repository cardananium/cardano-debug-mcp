---
when: Any phase-1 / phase-2 error or warning name tx_validate reports (docs(error=<Name>) answers one catalogue entry: meaning, causes, where to look, fix), how results are surfaced, phase-2 sub-cases, warnings that predict rejection, what an offline bundle cannot know.
---
# Validation errors and warnings

`tx_validate` runs the Conway phase-1 rules, then every redeemer unbounded with the parameters' cost models; errors do not hide phase 2. Rows: name, message, locations, hint, data (integers as strings), redeemer ref. Warnings are library additions, not ledger rules. Every name is a catalogue entry: docs(error=<Name>).
