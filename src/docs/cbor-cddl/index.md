---
when: CBOR data model and the tags Cardano uses (2/3, 24, 30, 102, 121-127, 1280-1400, 258, 259), the seven oddity kinds, PlutusData encoding rules, symptom -> cause -> fix for bytes that will not decode, a CDDL cheat sheet, how to read cbor_validate / cddl_check / cbor_decode errors (kinds, path grammar, byte offsets, head vs additional, implementation limits), era presets and what changed between eras.
---
# CBOR and CDDL diagnostics

Cardano wire objects are CBOR (RFC 8949) described by era CDDL schemas (RFC 8610). Three tools: `cbor_decode` says what the bytes are (a typed ledger object, or a raw positional tree with oddities and byte spans, `as='spans'`: every item's offset and length), `cbor_validate` why they do not fit a rule, `cddl_check` whether a schema is usable.
