---
gist: ScriptPurpose (V1/V2) and ScriptInfo (V3) constructors and payloads, and how a redeemer's tag / index selects the purpose.
---
# ScriptPurpose (V1/V2) and ScriptInfo (V3)

| Index | Name | V1/V2 payload | V3 payload | JSON fields |
|---|---|---|---|---|
| 0 | Minting | `B policy_id` | same | `policy_id` |
| 1 | Spending | `TxOutRef` (V1/V2 shape) | `TxOutRef` (V3 shape), `Maybe Data` datum | `utxo_ref{transaction_id,index}`, V3 `datum` |
| 2 | Rewarding | `StakingCredential` = `Constr 0 [Credential]` | `Credential` | `stake_credential{credential_type:KeyHash\|ScriptHash,hash}` |
| 3 | Certifying | `DCert` | `I index` (in `certificates`), `TxCert` | `index`, `certificate{certificate_type,…}` |
| 4 | Voting | – | `Voter` | `voter{voter_type,…}` |
| 5 | Proposing | – | `I index` (in `proposal_procedures`), `ProposalProcedure` | `index`, `proposal` |

`TxInfo.redeemers` keys use the same constructors (V3 keys never carry a datum). Purpose from the redeemer's `(tag, index)` (tags 0..5): spend → sorted input, mint → sorted policy, cert → `certificates[index]`, reward → sorted reward account, vote → sorted voter, propose → `proposal_procedures[index]`.
