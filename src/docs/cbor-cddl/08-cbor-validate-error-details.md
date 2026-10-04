---
gist: expected / message, byte offsets and hex excerpts, CDDL fragments, folded rows, head vs additional errors, structural_error kinds.
---
# cbor_validate error fields (continued)

| Field | Meaning |
|---|---|
| `expected`, `message` | CDDL tried, rendered from source (`bstr`, `integer to be in range 0 <= value <= 3`, `byte string of size 28 bytes`; the key for `map missing key: N`; absent for `unexpected key` and limits); the message adds `, got Y` (`array(3 items)`, `map(2 entries)`, `bytes 0x0102 (2 bytes)`, `#6.121(array(0 items))`, `27 bytes`) |
| `byte_offset`, `byte_length`, `hex_excerpt` | failing item's header (for `unexpected key N` the key; its value at `value_offset/length`); `hex_excerpt`: ≤ 64 hex chars from byte `excerpt_offset`; blamed bytes at hex index `2*(byte_offset-excerpt_offset)`, `2*byte_length` long (`excerpt_truncated` when cut); `anchor_offset/length` cover the whole item (key and value for a key) |
| `cddl_fragment`, `cddl_line`, `cddl_range` | schema text applied (the enclosing container when occurrences leave the slot ambiguous; for `unexpected key` its map written out (the choice if 2+ alternatives are maps)); `cddl_range` = `[start, end)` character offsets of it in the schema source (a ui_link `cddl_range`) |
| `occurrences`, `alternatives`, `from_type_choice` | errors with equal path, schema span and kind fold into one (`occurrences`); `alternatives` (≤ 5): what the choice branches wanted; `from_type_choice`: the message is about one branch, not the only acceptable form (hints skip such rows) |

Head vs additional: `errors[0]` is the library's head (deepest mismatch, named by `schema.candidates[].head_path` and the verdict), the rest innermost first (deduplicated; `additional_count` = overflow). For a wrong inline datum or script the head may blame the sibling alternative (`expected value 0, got 1` at the datum_option index) while the cause sits in a later row (`embedded`).

`structural_error` (also `cbor_decode.structural`): `kind` is `invalid_hex` (no offset), `invalid_syntax`, `unexpected_eof`, `unexpected_break`, `trailing_data`, `invalid_utf8`, `invalid_chunk`, `int_not_representable`, `non_finite_float` or `nesting_too_deep`; `path` uses the decoder grammar (`$.entries[2].value`); `partial_summary`: the decoded prefix.
