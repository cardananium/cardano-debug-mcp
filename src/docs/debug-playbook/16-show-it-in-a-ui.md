---
gist: when to offer or open a ui_link, which app per kind of confusion, how to write the cards (label, hint) that tell the story.
---
# Show it in cquisitor / de-uplc-web

Prose is a poor fit for positions (a byte, a CBOR path, a field, a UPLC term, a pseudocode branch). A `ui_link` (docs(topic='tools', section='ui_link'); targets in section='ui_link_targets') shows them.

When:
- the user asks ("show me", "where exactly") or does not follow: build it and open it at once;
- you reached the root cause of a failure, or know where a script's cost sits (the answer carries the call in `show_it`): explain in words first, then OFFER in one line what they would see ("I can open the transaction in cquisitor with the failing vote marked"). The user rarely knows it exists. Open it after a yes, not unasked;
- the user is learning how a transaction, a script or bytes are built: offer the same way.

Pick the app by what is unclear:
- Which field or rule of the transaction: `app='cquisitor'`, `tx_id`; cards on `diagnostic` (the rule) and `tx_path` / `redeemer` (the place). Inputs not on chain: section='assemble-a-chain-context'.
- Which bytes, or why they do not match a schema: `app='cquisitor'` with `cbor` (plus `cddl` / `preset` / `rule`); `cbor_span` / `cbor_path` cards.
- Where the script fails or what a value was: `app='de_uplc'`, `dbg_id`; `term` / `uplc_line` cards for the failing check and the values it compared; `from=['profile']` marks the hot terms.
- What a script does, one branch: `app='decompiler'` with `script`, a card on the line range of the `script_decompile` output.

The cards ARE the explanation: the user reads them one after another, so write them as the story, cause then effect. `label` = what is here (a few words), `hint` = why it matters and the fix (one to three sentences). The app already shows its messages, ids, hashes and amounts: do not repeat them. `show_it` has the targets filled in; you write the text. `from=` only points (a name, no text): yours replace it at the same place. Mark the decisive card `error`, the others `info`.

Once it opens, say in a line what opened and where to start. For someone else, do not open: write `url` exactly (an object: `link_file`). If `opened` is false, the URL is the answer. `dropped` annotations did not resolve (`available` says what does): fix and rebuild.
