---
gist: read NFT and token metadata: CIP-0025 721 layout, CIP-0067 asset name prefixes, CIP-0068 datums, royalties, smaller token CIPs.
---
# NFT and token standards

**CIP-0025** label 721: `{policy: {asset name: {name, image, ?mediaType, ?description, ?files [{name, mediaType, src}]}}, ?"version"}`. v1: text keys (asset name UTF-8). v2: bytes keys and `"version": 2` beside the policies. URIs over 64 chars are arrays of strings to join. Current metadata = latest mint tx (positive amount) with 721 for the token.
- CIP-0027 label 777, written on the policy's unnamed token minted first (only the first mint counts): `{rate: "0.2" (0.0-1.0; legacy pct), addr: text | [text]}`.
- CIP-0060 music (721 entry or CIP-0068 datum): `music_metadata_version` (3), `release`, `files[].song`.
- CIP-0124 (Proposed): `strings: {"de-CH": {name, ...}}` per policy or asset. CIP-0054 (Proposed): `uses: {transactions, tokens, renderer}`.
- CIP-0086 (Proposed): label 86 (stand-in), keys `assign_metadata_oracle`, `simple_`/`regex_`/`tabular_metadata_update`: field updates to 721 without minting.

**CIP-0067** (Proposed): asset name starts with 4 bytes `0000 | label 16 bits | CRC-8 (poly 0x07) of the label | 0000`.

| Label | Prefix | Class |
|---|---|---|
| 100 | `000643b0` | reference NFT |
| 222 / 333 / 444 | `000de140` / `0014df10` / `001bc280` | NFT / FT / RFT |
| 500 | `001f4d70` | royalty NFT |

**CIP-0068**: a user token (222/333/444) and exactly one reference NFT (100) share the policy id and the name after the prefix. Metadata = datum of the output holding the reference NFT: `Constr 0 [metadata map, version, extra]` (cbor-cddl/tags); keys and text are UTF-8 bytes; extra is any PlutusData (at least `Constr 0 []`). Validators use a reference input (tx-anatomy/datums). Version 1: 222 (CIP-0025 fields), 333 (name, description, ?ticker, ?url, ?decimals, ?logo); 2 adds 444 (222 fields, ?decimals); 3 allows image/src as a list of bytes.

**CIP-0102** (Proposed): `(500)Royalty` = `001f4d70526f79616c7479`, collection policy, datum `Constr 0 [[recipient], 1, extra]`, recipient `Constr 0 [address, fee, min, max]`; fee = 1/(rate/10) (1.6% = 625); min and max (lovelace) are `Constr 0 [n]` or `Constr 1 []`.

**CIP-0014** fingerprint `asset1...`: cips/addresses-and-identifiers.
