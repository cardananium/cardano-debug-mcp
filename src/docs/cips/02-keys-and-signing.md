---
gist: Key paths, COSE signData shape, wallet API return forms, hardware wallet limits.
---
# Keys and signing

Paths `m / purpose' / 1815' / ...`:
- CIP-1852 `1852'/1815'/acct'/role/idx`: role 0 external, 1 internal, 2 stake, 3 DRep, 4 CC cold, 5 CC hot (3-5: CIP-0105; id = blake2b-224 of the public key). `44'` = Byron wallet.
- CIP-1854 `1854'/1815'/acct'/role/idx`: multisig; role 0 payment, 2 stake.
- CIP-1853 (Proposed) `1853'/1815'/0'/idx'`: pool cold keys. CIP-1855 (Proposed) `1855'/1815'/policy_ix'`: minting policy keys.

**CIP-0008** COSE_Sign1 = `[protected bstr, unprotected map, payload bstr|nil, signature bstr]`. Signed bytes are Sig_structure `[context, protected, external_aad (default h''), payload]`. `hashed: true` (unprotected) = payload is the blake2b-224 of the message.

**CIP-0030** (`cbor<T>` = hex CBOR of T):
- getUtxos: hex `[input, output]` list, null if `amount` unreachable. getBalance: hex `value`. getNetworkId: 0 testnet, 1 mainnet. Addresses return as hex bytes, not bech32.
- signTx(tx, partialSign=false) returns only the new `transaction_witness_set`: merge it (tx-anatomy/witness-set).
- signData(addr, payload): payment key signs for base/enterprise/pointer, stake key for reward. Returns `{signature: hex COSE_Sign1, key: hex COSE_Key}`; `alg`(1) -8 EdDSA, `"address"` = raw address bytes; payload unhashed, no external_aad. COSE_Key: alg(3) -8, crv(-1) 6 Ed25519, x(-2) public key.
- Errors: APIError -1 InvalidRequest, -2 InternalError, -3 Refused, -4 AccountChange; TxSignError 1 ProofGeneration, 2 UserDeclined; DataSignError 1 ProofGeneration, 2 AddressNotPK, 3 UserDeclined.

**CIP-0095** (extension `{cip:95}`): getPubDRepKey, get(Un)RegisteredPubStakeKeys return hex 32-byte keys. Its signTx signs only payment, stake, DRep keys; genesis_key_delegation and MIR certs give TxSignError 3 DeprecatedCertificate. signData also takes a hex DRep id.

**CIP-0021** hardware wallets return witnesses only; the client rebuilds the body in canonical CBOR (sorted keys, definite lengths, tag 258 on all sets or none: cbor-cddl/oddity-kinds). Refused: body keys 6 (update), 20 (proposals); genesis_key_delegation, MIR, stake_vote_deleg, stake_reg_deleg, vote_reg_deleg, stake_vote_reg_deleg certs; duplicate policy ids, asset names or withdrawals.
