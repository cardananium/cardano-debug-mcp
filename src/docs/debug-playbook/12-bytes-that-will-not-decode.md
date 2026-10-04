---
gist: decode_failed from tx_load / tx_inspect: the cbor_decode -> cbor_validate -> cddl_check path.
---
# Bytes that will not decode

`tx_load`/`tx_inspect` answer `decode_failed` (reason + `next`) for non-transaction bytes. Then `cbor_decode(hex, as='auto')`: typed candidates or `structural` (error kind, offset, path) + `closest_schema`; `cbor_validate(hex, rule='transaction')` (`cddl='babbage'`… for older eras): `errors[0]` = deepest mismatch (`path,expected,byte_offset,hex_excerpt,cddl_fragment`), `hints[]` the likely cause; `valid: null` = refused by a limit. Own schema: `cddl_check(cddl)` first (line:col; `roots_by_kind` picks `rule`). Report path, offset, excerpt, fix; details: cbor-cddl/workflow.
