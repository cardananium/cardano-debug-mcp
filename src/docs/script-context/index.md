---
when: What a script receives: argument order per Plutus version, ScriptContext / TxInfo fields per version, ScriptPurpose vs ScriptInfo, PlutusData encoding of ledger types, the JSON views tx_redeemer and debug_inspect show.
---
# ScriptContext, TxInfo and script arguments (Plutus V1/V2/V3)

The ledger translates the transaction and resolved inputs into PlutusData arguments; validators never read tx CBOR. Field orders, encodings and JSON paths in its sections describe what tx_redeemer(part='context'), debug_inspect(what='context') and context.json/context.cbor expose. Redeemer index rules: tx-anatomy/redeemers.
