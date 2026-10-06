---
gist: when to offer or open a ui_link, which app and annotations per kind of confusion, what to say around it.
---
# Show it in cquisitor / de-uplc-web

Prose is a poor fit for positions (a byte, a CBOR path, a field, a UPLC term, a pseudocode branch). A `ui_link` (docs(topic='tools', section='ui_link'); targets in section='ui_link_targets') shows them.

When:
- the user asks ("show me", "where exactly") or does not follow: build it and open it at once;
- you reached the root cause of a failure, or know where a script's cost sits (the answer carries the call in `show_it`): explain in words first, then OFFER in one line what they would see ("I can open the transaction in cquisitor with the failing vote marked"). The user rarely knows it exists. Open it after a yes, not unasked;
- the user is learning how a transaction, a script or bytes are built: offer the same way.

An answer the user already understood needs no offer.

Pick the app by what is unclear:
- Which field or rule of the transaction: `app='cquisitor'`, `tx_id`, `from=['validation']`; `tx_path` annotations for the decisive fields. Inputs not on chain: section='assemble-a-chain-context'.
- Which bytes, or why they do not match a schema: `app='cquisitor'` with `cbor` (plus `cddl` / `preset` / `rule`), `from=['cbor_errors']`; `cbor_span` / `cbor_path` for the row you explain.
- Where the script fails or what a value was: `app='de_uplc'`, `dbg_id`, `from=['session']` after `debug_run` stopped on the spot, `from=['profile']` after `debug_profile` for the cost; `term` / `uplc_line` annotations for the binder or the deciding comparison.
- What a script does, one branch: `app='decompiler'` with `script`, targeting the line range of the `script_decompile` output you explain.

The app shows its own messages, hints, ids, hashes and amounts. An annotation adds only what it does not say: a `label` in plain words ("pool vote on a parameter outside its group") and a `hint` with the cause or fix. Generated ones (`from=`) only point. Mark the decisive spot `error`, the context `info`; a few, cause then effect, tell the story.

Once it opens, write one or two lines: what opened, where to look (tab, term, line, which highlight) and what the app cannot show (why, the fix). Do not repeat what it displays. For someone else, do not open: write `url` exactly (an object: `link_file`). If `opened` is false, the URL is the answer. `dropped` annotations did not resolve (`available` says what does): fix and rebuild.
