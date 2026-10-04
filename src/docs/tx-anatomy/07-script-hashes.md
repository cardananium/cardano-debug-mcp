---
gist: script hash = blake2b-224 of a language tag plus bytes; policy id and script credential are the same hash.
---
# Scripts and script hashes

`script_hash=blake2b-224(tag || script_bytes)`: native 0x00, V1 0x01, V2 0x02, V3 0x03; 0x04 reserved (V4). Same UPLC hashes differently per version; witness key/`script_ref` tag, not `(1,0,_)`, selects language. `policy_id`=`script_hash`=script-address payment credential (28 B).
