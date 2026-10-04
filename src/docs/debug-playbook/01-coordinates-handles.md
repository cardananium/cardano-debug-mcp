---
gist: term_id vs uplc_line, tx_id / dbg_id lifetimes and limits, expired_handle, output paging, integer encoding.
---
# Coordinates, handles, limits

- `term_id`: normalised node ordinal, `0..term_count-1`, stable per script across sessions. `uplc_line`: 1-based canonical-listing line; `script_locate` maps `term_id <-> uplc_line` (several terms may start on a line).
- `tx_id=tx_<network>_<12 hex>`: 32 kept, 2 h idle, rebuilt from disk cache after restart. `dbg_id=dbg_<uuid>`: 30 min idle / 4 h, 8 concurrent, LRU eviction; all busy -> `session_limit`; lost on restart. `expired_handle`: repeat the call named by `recreate_with='tx_load'|'debug_open'`.
- Output: host cap ~25k tokens. Page with `offset/limit`, `from_line/lines`; zoom `path/depth`; text resources take `?offset=&limit=` (UPLC listings: 400-line windows).
- On-chain quantities and PlutusData integers are decimal strings; indices, lines, counters are JSON numbers.
