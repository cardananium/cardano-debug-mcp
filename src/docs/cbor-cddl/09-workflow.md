---
gist: cbor_decode -> cbor_validate -> cddl_check step by step: what each answer field says and how the root rule is auto-picked.
---
# Workflow with the three tools

1. `cbor_decode(hex, as='auto')`. Typed candidate (`Transaction`, `TransactionBody`, `PlutusData`, `Address`, …) = known ledger object; transactions: continue with `tx_load` / `tx_inspect` (`not_tried`: types skipped at the typed decoders' 64 levels, native scripts exempt); `closest_schema` appears when only PlutusData / metadata (accept any tree) take a map or array. No candidate (or malformed bytes): read `input_kind`, `structural` (decode error, or the raw root with oddities) and `closest_schema` (best Conway rule, head mismatch only).
2. `cbor_validate(hex, cddl?, rule?)`. `cddl`: era preset (`conway` default; `cardano-debug://cddl`), schema text or an absolute `.cddl` path. Without `rule` it tries rules whose root kind admits the decoded root, well-known roots first (`transaction`, `transaction_body`, `transaction_witness_set`, `transaction_output`, `plutus_data`, `block`, …), and reports the first valid one, else the one that got inside the root (a missing key or wrong slot count at `$` counts; a wrong root kind does not) with fewest unmatched bytes, then deepest head; `schema.candidates[]` lists all attempts. `decode=true` adds labelled JSON (`@tag` / `@value`, `@entries`, `@extra` / `@positional`), zoomable with `path` (JSON pointer) / `depth`; `include_raw` adds the positional tree, zoomed by `raw_path` or a `$` path.
3. `cddl_check(cddl, rule?, format?)` for a user schema: `error.line` / `col` / `snippet`, positioned `unresolved[]`, `outline.roots_by_kind`, `references` (a rule's definition and uses), `formatted`.

Byte span of an item (to mark it in ui_link)? `cbor_decode(hex, as='spans', path='$[0]', depth=1)`: rows `{path, type, offset, length}`, paged.

Report what the bytes are, the first failure (path, offset, hex excerpt), what the schema wanted, why (hints, era), the fix; quote offsets and hex, not the blob.
