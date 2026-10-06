---
gist: ui_link sources per app and tab, from=, the answer (url, link_file, dropped, notes), open and handing the link over.
---
# ui_link

Use it when the user wants to SEE the problem in a UI: a link into cquisitor or de-uplc-web that highlights targets, each with a label and hint. `open=true` starts the user's browser: when you show the link to the user, not when it is meant for sharing (the server may have opening disabled: `opened: false` + a note, give them the URL).

Sources: `app='cquisitor'` with tx_id (tab transaction-validator), `cbor` (general-cbor, or tab='cardano-cbor'; the byte parameter is `cbor`, not `hex`), cbor + cddl / rule / preset (cddl-validator). `app='de_uplc'` (debugger) or `'decompiler'` with tx_id + redeemer, dbg_id or script (+ plutus_version). Targets: docs(topic='tools', section='ui_link_targets').

Tabs: transaction-validator carries the transaction and its chain context (fetched, or assembled from the bundle / DebuggerContext: `notes` says which; with no context loaded the app fetches the inputs). cardano-cbor takes no annotations and is tagged with `network` (default: the tx's, else mainnet). cddl-validator: an era name or no `cddl` goes as the app's own preset (short link) unless your annotations hold a cddl_range / cddl_rule; malformed bytes with no `rule` open general-cbor, which shows the structural error.

`from` adds generated annotations: `validation` (tx_id; a `diagnostic` per error / warning, name as label, a tx_path for its first location; no hint: the app shows its own), `cbor_errors` (runs cbor_validate on cbor / cddl / rule: a span or path per error row, cddl_range with an embedded schema; the first 20 rows), `session` (dbg_id: the failing term, error, and the current position, info). A de_uplc link from tx_id marks the failing term once a session of that redeemer stopped on an `(error)` term (debug_run until='error'; a rewind keeps it).

Answer: `url` (inline up to 16,000 characters, else `{length, preview, note}`), `link_file` (absolute path of a file holding the URL), `link_resource` (the same text as a resource), `annotations_count`, `dropped: [{index, reason, available?}]` (yours first, then generated), `focus`, `opened`, `open_error`, `notes`. At most 64 annotations per link; labels 80, hints 2,000 characters.

Copy `url` exactly: one wrong character of the base64 breaks the payload. When it is an object, give the user `link_file` (a path to open or copy from) instead of retyping.
