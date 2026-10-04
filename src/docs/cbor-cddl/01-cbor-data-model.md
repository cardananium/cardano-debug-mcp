---
gist: initial byte = major type + additional info, the eight major types with their initial bytes, structural decode errors, the raw tree's byte spans.
---
# CBOR data model

Initial byte = `major type (3 bits) | additional info (5 bits)`. Info 0-23 = the argument, 24-27: it follows in 1/2/4/8 bytes, 28-30 invalid (`invalid_syntax`), 31: indefinite length (major 2-5) or break `ff` (major 7). Argument = value (0/1), byte or item count (2-5), tag number (6).

| Major | Meaning | Initial bytes | Notes |
|---|---|---|---|
| 0 | unsigned int | `00`-`17` = 0-23, `18`-`1b` | up to 2^64-1 |
| 1 | negative int | `20` = -1, `38 xx` = -1-xx, `39`-`3b` | |
| 2 | bytes | `40` = h'', `58`-`5b`; `5f … ff` indefinite | chunks: definite bytes only |
| 3 | text | `60`, `78`-`7b`; `7f … ff` indefinite | bad UTF-8: `invalid_utf8` |
| 4 | array | `80`-`97`, `98`-`9b`; `9f … ff` indefinite | count = items |
| 5 | map | `a0`-`b7`, `b8`-`bb`; `bf … ff` indefinite | count = pairs; any key |
| 6 | tag | `c0`-`d7` = 0-23, `d8`-`db` | one item follows |
| 7 | simple / float | `f4` false, `f5` true, `f6` null, `f7` undefined, `f8 xx` simple, `f9`/`fa`/`fb` floats, `ff` break | NaN/Inf: `non_finite_float` |

Errors: a header promising more than remains = `unexpected_eof` at the content's start offset; stray `ff` = `unexpected_break`; bytes after the root = `trailing_data`. Raw tree (`cbor_decode(as='raw')`, `include_raw`): a node is `{type, at, …}`, `at` = `"offset+length"`, the byte span of the whole item header included (`"44+70"` = 70 bytes from offset 44; a tag's span covers its content); maps list `{k, v}` entries, a folded node says `collapsed: true`, a cut list `more: N`; tags appear by name (`PosBignum`, `Cbor`, else `Unassigned(N)`). `cbor_decode(as='spans')` lists the same spans as rows `{path, type, offset, length}` (paths as in `cbor_validate` errors): offset and length go straight into a ui_link `cbor_span`.
