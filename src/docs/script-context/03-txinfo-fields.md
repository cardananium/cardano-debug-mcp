---
gist: TxInfo field indices per version (V1 / V2 / V3), JSON keys and PlutusData types; what TxInfo never contains.
---
# TxInfo fields per version

| V1 | V2 | V3 | Field = JSON key | PlutusData type |
|---|---|---|---|---|
| 0 | 0 | 0 | `inputs` | `List TxInInfo`, sorted by `(tx_id, index)` |
| – | 1 | 1 | `reference_inputs` (CIP-31) | `List TxInInfo`, sorted |
| 1 | 2 | 2 | `outputs` | `List TxOut`, body order |
| 2 | 3 | 3 | `fee` | V1/V2: `Value` `{"" -> {"" -> fee}}`; V3: `I fee` |
| 3 | 4 | 4 | `mint` | `Value`; V1/V2 lead with `{"" -> {"" -> 0}}` (never empty), V3 does not; policies, names sorted bytewise |
| 4 | 5 | 5 | `certificates` | V1/V2: `List DCert` (5 legacy kinds); V3: `List TxCert` (11 kinds) |
| 5 | 6 | 6 | `withdrawals` | V1: `List` of pairs (`Constr 0 [StakingCredential, I]`); V2: `Map StakingCredential I`; V3: `Map Credential I`; sorted network, script-before-key, hash |
| 6 | 7 | 7 | `valid_range` | `POSIXTimeRange` (ms) |
| 7 | 8 | 8 | `signatories` | `List B`, sorted 28-byte key hashes of `required_signers` (body key 14), never who actually signed |
| – | 9 | 9 | `redeemers` | `Map ScriptPurpose Redeemer` (data only), sorted by tag, index |
| 8 | 10 | 10 | `data` (datums) | V1: `List` of pairs (`Constr 0 [B hash, Data]`); V2/V3: `Map B Data`; witness-set datums only (inline ones live in outputs), sorted |
| 9 | 11 | 11 | `id` (tx id) | V1/V2: `Constr 0 [B]`; V3: bare `B` (32 bytes) |
| – | – | 12 | `votes` | `Map Voter (Map GovActionId Vote)` |
| – | – | 13 | `proposal_procedures` | `List ProposalProcedure`, body order |
| – | – | 14 | `current_treasury_amount` | `Maybe I` |
| – | – | 15 | `treasury_donation` | `Maybe I` |

No `TxInfo` has collateral (inputs, return, total), `script_data_hash`, auxiliary data or vkey witnesses.
