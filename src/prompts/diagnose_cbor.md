Diagnose these CBOR bytes: what are they, what is wrong with them and how do I fix it?

Bytes: {{hex}}
Schema: {{cddl}}
Root rule: {{rule}}

1) cbor_decode(hex, as='auto'): a typed candidate names the object; explain it (a transaction: continue with tx_inspect / tx_validate). Otherwise read `structural` and `closest_schema`.
2) cbor_validate(hex, cddl=<preset or the user's schema>, rule=<rule if known>) for the verdict, the errors (head first) and the hints. A wrong era is the first suspect for a known type: try the other presets before blaming the bytes; valid: null is a refusal (implementation limit), not a mismatch.
3) The user supplied a schema: cddl_check(cddl=…) first, then take `rule` from roots_by_kind.
4) Zoom: cbor_validate(…, path=<decoded path>, depth=…) or include_raw=true; cbor_decode(hex, as='raw', path=…) for any byte run; as='spans' lists every node's {path, offset, length} (the offsets for ui_link cbor_span).
5) When the user cannot see where the problem is, build ui_link(app='cquisitor', cbor, preset=<era> or cddl=<the user's schema>, rule=<rule>, from=['cbor_errors']) (section='show-it-in-a-ui' of the playbook): the mismatch is highlighted in the bytes (without a schema the link is the general-cbor tab, which can only mark malformed bytes; a user schema adds the schema range).
6) Explain WHAT the bytes are (or were meant to be), WHAT is wrong (expected vs found), WHERE (path, byte offset, hex excerpt), WHY (the hint) and HOW to fix it. Quote the tool's numbers; do not paraphrase offsets.
docs(topic='cbor-cddl') has the sections to read: workflow (what each answer field means), reading-cbor-validate-errors, encoding-mistakes (symptom -> cause -> fix), eras, oddity-kinds, cddl-cheat-sheet; docs(topic='tx-anatomy') says what a transaction field means.
