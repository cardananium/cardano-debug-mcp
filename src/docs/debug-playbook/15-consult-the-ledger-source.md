---
gist: a last resort when docs, tools and the chain still disagree on something the answer depends on: when NOT to, where to read.
---
# Last resort: the cardano-ledger source

The validator here is not the node, so in rare cases it can differ from the ledger. Reading https://github.com/IntersectMBO/cardano-ledger is slow and almost never needed: a last resort, not a routine step.

Do NOT open it for:
- an error whose catalogue entry (`docs(error=<Name>)`) and tool output already explain the failure;
- a script failure that `debug_run` and the pseudocode show;
- anything the docs answer, or curiosity about how a rule is implemented.

Open it only when, after the docs and the tools, one open question still decides the conclusion:
- the chain accepted what `tx_validate` rejected (or the reverse) and `on_chain.note`, `node_may_accept` and `defaults_applied` do not explain it;
- the docs and a tool result contradict each other;
- the docs are silent on an era or protocol-version difference, or on a wire-format detail the conclusion rests on.

Then read narrowly: one rule, one file.
- Rules and their order: `eras/<era>/impl/src/Cardano/Ledger/<Era>/Rules/` — `Utxo.hs` (fee, value conservation, validity interval, collateral), `Utxow.hs` (witnesses, script data hash, datums), `Utxos.hs` (phase-2 evaluation, `is_valid`). Conway reuses Babbage / Alonzo rules: follow the imports. Error names are the `PredicateFailure` constructors there.
- ScriptContext / TxInfo: `eras/conway/impl/src/Cardano/Ledger/Conway/TxInfo.hs`; Babbage and Alonzo (`.../Alonzo/Plutus/TxInfo.hs`) have their own, shared parts are in `libs/cardano-ledger-core/src/Cardano/Ledger/Plutus/TxInfo.hs`.
- Wire format: the era CDDL under `eras/<era>/impl/cddl/data/` (the bundled schemas are copies of a pinned revision, the upstream may be newer); the `EncCBOR` / `DecCBOR` instances settle what the node accepts.

Name the file you relied on in the explanation. Without web or repository access, say the claim is unverified against the ledger source instead of asserting it.
