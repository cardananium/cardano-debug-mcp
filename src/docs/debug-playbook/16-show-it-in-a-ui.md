---
gist: when to build a ui_link without waiting to be asked, which app and annotations per kind of confusion, how to hand it over.
---
# Show it in cquisitor / de-uplc-web

Prose is a poor fit for positions: a byte offset, a deep CBOR path, a field of a big transaction, a UPLC term, a branch of the pseudocode. Build a `ui_link` (docs(topic='tools', section='ui_link'); targets in section='ui_link_targets') on your own initiative when:
- the user says they do not follow, or asks "where exactly", "show me", "what does this look like";
- your explanation rests on a spot that is hard to point at in words;
- you reached the root cause and the decisive spot (a field, a byte range, a term) is the best evidence;
- the user is learning how a transaction, a script or some bytes are built.

A short answer the user already understood needs no link; one link per point.

Pick the app by what is unclear:
- Which field or rule of the transaction: `app='cquisitor'`, `tx_id`, `from=['validation']`; add `tx_path` annotations for the decisive fields (the fee and the min fee it was compared to). Inputs not on chain: section='assemble-a-chain-context'.
- Which bytes, or why they do not match a schema: `app='cquisitor'` with `cbor` (plus `cddl` / `preset` / `rule`), `from=['cbor_errors']`; `cbor_span` / `cbor_path` for the row you are explaining.
- Where the script fails or what a value was: `app='de_uplc'`, `dbg_id`, `from=['session']` after `debug_run` stopped on the spot; add `term` / `uplc_line` annotations for the binder of a value or the comparison that decided.
- What the script does, one branch of it: `app='decompiler'` with `script`, targeting the line range of the `script_decompile` output you are explaining.

Make each annotation explain itself: a `label` in plain words ("fee below the minimum") and a `hint` with what is wrong, actual versus expected, and the fix. Mark the decisive spot `error` and the context `info`. A few annotations in cause-then-effect order tell the story; dozens do not.

Hand it over: put the URL in the answer with one line saying where to look (tab, term, line, which highlight is the cause). Showing it to the user: `open=true`. Sharing it: do not open; write `url` exactly (an object: the `link_file` path). If `opened` is false, the URL is the answer. Check `dropped` and `notes`: a dropped annotation means the target did not resolve (`available` says what does): fix it and rebuild instead of sending a link that points nowhere.
