---
gist: the fields of a cbor_validate answer and what each hint family covers.
---
# cbor_validate

Answer: `valid` (true | false | null = not examined), `verdict`, `errors[]` {kind, path, expected, message, byte_offset, byte_length, hex_excerpt, cddl_fragment, cddl_line}, `additional_count`, `structural_error` (malformed CBOR: kind, offset, path, what decoded so far), `oddities[]` (non-canonical encodings), `hints[]` (likely cause and fix: era set tags, map vs array, PlutusData tags, truncation, double-wrapped scripts, hex-as-text), `decoded` (labelled JSON, field names from the schema) and optionally `raw` (positional tree, spans as `at: "offset+length"`). Without `rule` it reports the first valid root or the closest failure. Reading the fields: cbor-cddl/reading-cbor-validate-errors.

Windows: `decoded` and `raw` are each fitted breadth-first into 6,000 chars (`truncated: true` + a note; `depth` caps levels, omitted = as many as fit). `path` zooms `decoded` (JSON pointer, `/transaction_body/2`); a `$` path (`$[0][2]`) or `raw_path` zooms `raw`. A path only the other view reads is `skipped` with a note, one neither reads is `path_not_found` with `view: decoded | raw`. Rows carry `path_short` (abbreviated long path) and `cddl_range` (cbor-cddl/cbor-validate-error-details).
- `show_it` (invalid bytes): the ready `ui_link` call that shows the failing byte in cquisitor. Explain first, offer it in one line, make the call on a yes.
