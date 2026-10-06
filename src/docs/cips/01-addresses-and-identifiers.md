---
gist: Read address bytes and bech32 strings (CIP-0019, 0005, 0014, 0129, 0016): header types, prefixes, asset fingerprint, governance ids, key sizes.
---
# Addresses and identifiers

**CIP-0019**: 1 header byte + payload. Header = type (high nibble) + network (low: 0 testnet, 1 mainnet). Bit logic: tx-anatomy/outputs; as Plutus data: script-context/plutusdata-core-types. Hashes are blake2b-224 (28 B).

| Type | Payment | Delegation | Mainnet starts |
|---|---|---|---|
| 0 / 1 | key / script | key | addr1q / addr1z |
| 2 / 3 | key / script | script | addr1y / addr1x |
| 4 / 5 | key / script | pointer | addr1g / addr12 |
| 6 / 7 | key / script | none | addr1v / addr1w |
| 14 / 15 | stake key / stake script | - | stake1u / stake17 |
| 8 | Byron: Base58 CBOR (root hash, attributes, type); CIP-0008: `Ae2` Icarus, `Dd` Daedalus | | |

- Testnet prefixes `addr_test`, `stake_test`. Pointer = 3 variable-length uints (slot, tx index, cert index); Conway: no new pointer addresses on mainnet.
- Byron attributes: network tag only on testnets; derivation path is encrypted.

**CIP-0005 prefixes**: `*_sk`/`*_vk` 32-byte key, `*_xsk`/`*_xvk` extended (+ chain code), `*_vkh` key hash; families `root acct addr stake drep cc_cold cc_hot policy pool kes vrf`, `_shared` = CIP-1854. Hashes: `pool` pool id, `script` script hash, `datum`, `script_data` (blake2b-256).

**CIP-0014 fingerprint**: bech32 `asset1...` of blake2b-160 (20 B) over raw policy id bytes ++ raw asset name bytes. User-facing label; collisions are possible.

**CIP-0129 governance ids** (Proposed: do not assume it is live on chain; UI and sharing format): header byte + 28-byte hash. High nibble 0 CC hot, 1 CC cold, 2 DRep; low nibble 2 key hash, 3 script hash (0, 1 reserved).
- `0x22` drep key, `0x23` drep script, `0x02`/`0x03` cc_hot, `0x12`/`0x13` cc_cold.
- `gov_action1...` = 32-byte tx id + index byte (`11` = 17).
- Replaces CIP-0105 headerless 28-byte `drep`, `cc_cold`, `cc_hot` (key) and `drep_script`, `cc_cold_script`, `cc_hot_script`. Same prefix: 28 B old, 29 B new. Ledger kinds: tx-anatomy/governance.

**CIP-0016 keys** (bech32 of raw bytes): vk 32 B; xvk 64 B = key 32 + chain code 32; sk 32 B; xsk 96 B = extended key 64 + chain code 32.
