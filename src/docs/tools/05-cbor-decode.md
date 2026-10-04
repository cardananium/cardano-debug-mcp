---
gist: cbor_decode modes (auto, typed, raw, spans), how output is cut to its budget, byte spans, structural / closest_schema answers, nesting refusals.
---
# cbor_decode

- No typed candidate (always so for bytes that are not one well-formed item: truncated, trailing bytes): the answer carries `structural` (decoder error with offset / path, or the root shape) and `closest_schema` (closest Conway CDDL root, its head mismatch). Typed answers carry an oddities summary (cbor-cddl/oddity-kinds), plus `closest_schema` when only PlutusData / metadata accept a map or array that looks like a ledger structure.
- `notes` explains how non-hex input was read (odd length, base64, envelope). Integers are decimal strings, bytes hex.
- Size: `value` (typed, `raw`, and the tree of an untyped answer) is fitted breadth-first to 10k chars, 100k when you pass `depth` >= 6: levels are shown whole from the root down, only the deepest bulk is folded (`{… N keys}`; raw: `collapsed: true`), a long list shows its first items and `… N more items` (raw: `more`). `depth` (1-8) caps the levels, omitted = as many as fit. `truncated: true` plus a note when the budget cut. Zoom with `path`.
- `as='raw'`: nodes `{type, at: "offset+length", value | values | chunks, tag, items}`, maps as `{k, v}` entries; `at` is the whole item's byte span (cbor-cddl/cbor-data-model). `path` = a JSON pointer into that tree, or a `$` path (`$[0][2]`, tags transparent). `oddities[]` rows: kind, path, byte_offset, byte_length, note.
- `as='spans'`: every node as a row `{path, type, offset, length}` in document order (+ `key: true` on a map key, whose value has its own row on the same path; `tag` on tag rows; `value` of ints / bools). A tag and its content share a path. `offset` / `limit` page it (default 50, max 100, `next_offset`); `path` (`$` grammar) = the subtree, `depth` = levels below it (default all). A row's offset and length are a ui_link `cbor_span`, its path a `cbor_path`.
- Refusals (nesting > 64 levels typed, native scripts exempt; > 32768 raw) come back as code `unexamined` (as='auto': an unexamined field; `not_tried` beside decoded types), not `invalid`.
