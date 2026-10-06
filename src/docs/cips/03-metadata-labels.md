---
gist: read transaction metadata by label (CIP-0010): messages, Catalyst, registrations, SPO polls, off-chain metadata, the 64-byte limit.
---
# Transaction metadata labels

Metadata is `{label(uint) => metadatum}` in auxiliary_data (tx-anatomy/top-level-shape). CIP-0010 registry (0-15 reserved, 65536-131071 private). Text and bytes are at most 64 bytes (CIP-0010 CDDL `.size (0..64)`; CIP-0020 counts UTF-8 bytes): long text is an array of pieces (cbor-cddl/plutusdata-encoding).

| Label | CIP, shape |
|---|---|
| 721, 777 | CIP-0025, CIP-0027: cips/nft-and-token-standards |
| 674 | CIP-0020 `{"msg":[text,...]}`. CIP-0083 adds `"enc":"basic"`: msg = base64 of AES-256-CBC (openssl, PBKDF2, default passphrase `cardano`) of the msg array |
| 61284, 61285 | CIP-0015 `61284:{1 vote key, 2 stake pubkey, 3 reward address, 4 nonce}`, `61285:{1 signature}`. CIP-0036 (Proposed): key 1 = `[[vote key, weight]]`, `?5` purpose (0 = Catalyst); 61286 `{1 stake pubkey, 2 nonce, ?3 purpose}` = deregistration |
| 867 | CIP-0088 `{0 version, 1 payload, 2 witnesses [[pubkey, sig]]}`; payload `1` scope `[0, policy id, [script hex chunks]]`, `2` [CIP numbers], `3` `[0]` signature / `[1,[policy, asset]]` beacon token, `4` nonce (highest wins), `?6` {CIP: details}. CIP-0151 (v2): scope `[1, pool id]`, `7` Calidus key (all zeros = revoked), method `[2]` = CIP-0008, witness `{0 type, 1 key, 2 sig}` |
| 94 | CIP-0094 question `{0 [prompt], 1 [[choice]], "_" nonce}`; answer `{2 blake2b-256 of the question metadata, 3 choice index from 0}`; signed by the pool cold key (required_signers); first answer counts |
| 1990, 1991 | CIP-0012 (Proposed) board / direct to delegates: `[{<language>: {title, content [text], valid, expire}}]` |

Off-chain:
- CIP-0006: the pool registration points to the pool JSON (`ticker`, `name`, ..., optional `extDataUrl`, `extSigUrl`, `extVkey`); the extended JSON is verified by the `extSigUrl` signature and `extVkey`. No hash is stated.
- CIP-0026: nothing on chain. Entries per subject (token: policy id + asset name hex): `value`, `sequenceNumber`, `signatures [{publicKey, signature}]` (Ed25519 over blake2b-256 of subject, name, value, sequenceNumber). Superseded: `policy` (native script CBOR) must blake2b-224 to the subject's first 28 bytes.
