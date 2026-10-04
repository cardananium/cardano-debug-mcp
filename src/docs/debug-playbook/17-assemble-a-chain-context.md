---
gist: when the tx tab needs a chain context you assemble yourself (chained, draft or made-up transactions), how to build it and carry it in the link.
---
# Assemble a chain context for the tx tab

The transaction tab judges the transaction against the context in the link. A tx loaded online (`tx_hash`, `tx_cbor`) or from a share link with context brings its fetched context; a chained transaction's context lacks the parent's outputs (`missing_utxos`). What Koios does not know shows as missing UTxOs, which is not the real problem:
- a chained transaction: an input is an output of a parent that is not on chain yet;
- a draft that was never submitted, or a made-up transaction built to teach how a transaction works.

Assemble the context yourself:
1. Collect the UTxOs the transaction spends or references. `tx_validate` names the missing ones (`missing_utxos`); a parent's outputs: its `tx_hash` and `tx_inspect` outputs; for a made-up transaction, write them.
2. Put them with the protocol parameters into a DebuggerContext and `tx_load(bundle=…)`: `{transaction: <hex>, network, utxos: [{txHash, outputIndex, address, value: {lovelace, assets?: {"<policy>.<name hex>": qty}}, datumHash?, inlineDatum?, referenceScript?: {type, script}}], protocolParams: {protocolVersion: [10, 0], …}}`. `protocolParams.protocolVersion` is required; the rest is defaulted and listed in `defaults_applied` (no cost models: phase 2 answers CostModelNotFound). `tx_validate` then answers on exactly that state.
3. `ui_link(tx_id, annotations)` embeds that context in the link (`notes`: "assembled from the bundle / DebuggerContext, not fetched"): the app judges the same state, the indices of `from=['validation']` mean what the server validated, and the inputs are not refetched from Koios.

Check: `tx_validate` says `valid` (or the error you mean to show), `dropped` of `ui_link` is empty, `notes` has no "transaction only" entry.

Say in the answer that the context is assembled and which inputs are assumed, so nobody reads it as chain state.
