---
gist: ui_link sources per app and tab, from=, the answer (url, link_file, dropped, notes), open and handing the link over.
---
# ui_link

A link into cquisitor or de-uplc-web that highlights targets, each with a label and hint, for a user who wants to SEE the problem. `open=true` starts the user's browser: when you show the link to the user, not when it is meant for sharing (opening may be disabled: `opened: false` + a note, give them the URL).

Sources: `app='cquisitor'` with tx_id (tab transaction-validator), `cbor` (general-cbor, or tab='cardano-cbor'; the byte parameter is `cbor`, not `hex`), cbor + cddl / rule / preset (cddl-validator). `app='de_uplc'` (debugger) or `'decompiler'` with tx_id + redeemer, dbg_id or script (+ plutus_version). Targets: docs(topic='tools', section='ui_link_targets').

Tabs: transaction-validator carries the transaction and its chain context (fetched, or assembled from the bundle / DebuggerContext: `notes` says which; with no context loaded the app fetches the inputs). cardano-cbor takes no annotations and is tagged with `network` (default: the tx's, else mainnet). cddl-validator: an era name or no `cddl` goes as the app's own preset (short link) unless your annotations hold a cddl_range / cddl_rule; malformed bytes with no `rule` open general-cbor, which shows the structural error.

`from` adds generated annotations: `validation` (tx_id; a `diagnostic` per error / warning, name as label, a tx_path for its first location; no text: write cards, they replace these at the same place), `cbor_errors` (runs cbor_validate on cbor / cddl / rule: a span or path per error row, cddl_range with an embedded schema; the first 20 rows), `session` (dbg_id: the failing term, error, and the current position, info), `profile` (dbg_id or tx_id + redeemer: the 5 hottest terms of the last debug_profile). From tx_id, a de_uplc link marks the failing term once a session of that redeemer stopped on an `(error)` (debug_run until='error'; a rewind keeps it).

Answer: `url` (inline up to 16,000 characters, else `{length, preview, note}`), `link_file` (absolute path of a file holding the URL), `link_resource` (the same text as a resource), `annotations_count`, `dropped: [{index, reason, available?}]`, `focus`, `opened`, `open_error`, `notes`. At most 64 annotations per link; labels 80, hints 2,000 characters.

Copy `url` exactly: one wrong base64 character breaks the payload. When it is an object, give the user `link_file` instead of retyping.
