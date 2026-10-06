---
gist: Serialization and ledger CIPs (CIP-0080 to CIP-0176, charge-only ref scripts) with Status; every Proposed one is not live.
---
# Serialization and ledger CIPs

Proposed = NOT live: never assume it when decoding or judging a tx.

- CIP-0080 Active: only serious flaws break formats at once; others need a cycle (old form kept 6+ months). Alonzo array outputs retirable after 2023-03-22, yet both decode: cbor-cddl/eras. Conway dropped zero-valued multi-assets.
- CIP-0114 Proposed: tag registry holding only the four CIP-0115 tags; unregistered tags are for tests, not mainnet. Tags in real use (24, 258, 121...) are not in it: cbor-cddl/tags.
- CIP-0115 Proposed: ED25519-BIP32 private 32771 (bstr 32), extended private 32772 (64), public 32773 (32), signature 32774 (64).
- CIP-0116 Proposed: JSON for domain types: lower-case hex, maps as `[{key,value}]`, variants `{tag,value}`, bech32 addresses, no extra properties. Babbage schema only.
- CIP-0118 Proposed: key 23 `[+ sub_transaction]` = `[body, witnesses, aux/nil]`; sub body has no fee (2), collateral (13, 16), adds 24 `required_top_level_guard`; key 14 `guards`. Needs PlutusV4; V1-V3 only in an isolated top level. Batch balances as a whole.
- CIP-0128 Proposed: inputs (0), reference inputs (18) become `oset`: CBOR order kept, not the sort of tx-anatomy/inputs.
- CIP-0167 Proposed (Dijkstra): standalone tx `[body, witnesses, aux/nil]`, no `is_valid`; blocks keep validity apart.
- CIP-0176 Proposed (Dijkstra): block `[header, [invalid_transactions, transactions]]`, each tx whole; today bodies, witnesses, aux, invalid indices are separate items.
- CIP-0159 Proposed: reward-account deposits: key 23 `direct_deposits` (clashes with CIP-0118), 24 `account_balance_intervals`, certificate 19 (whitelist), `accountWhitelistCostPerByte`. Conway keys end at 22.
- CIP-0165 Proposed: ledger-state snapshot file, not a tx: u32 size + type byte; `HDR` 0x00 (`SCLS`), `MANIFEST` 0x01, `CHUNK` 0x10.
- charge-only-used-ref-scripts (no number) Proposed: reference-script fee only for scripts in `scriptsNeeded`; hard fork. Today unused ones are charged: tx-anatomy/fees-min-utxo. Parameter spelled `minFeeRefScriptCostPerByte` (CIP-0110: `minFeeRefScriptCoinsPerByte`).
