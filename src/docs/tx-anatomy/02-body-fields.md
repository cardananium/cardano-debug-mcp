---
gist: every Conway body key (0-22) with its CDDL type and rule, and the value preservation equation.
---
# Transaction body fields

- 0 inputs: `set<transaction_input>`, input `[tx_id (32 B), index]`; tag 258 allowed; non-empty (`InputSetEmptyUTxO`)
- 1 outputs: `[* transaction_output]`, see tx-anatomy/outputs
- 2 fee: `coin` (lovelace)
- 3 ttl: `slot`, validity upper bound
- 4 certs: `nonempty_oset<certificate>` (tag 258 allowed)
- 5 withdrawals: `{+ reward_account => coin}`, 29-byte stake address
- 7 auxiliary_data_hash: `hash32` of position 3
- 8 validity_interval_start: `slot`; lower bound
- 9 mint: `{+ policy_id => {+ asset_name => nonzero_int64}}`; negative = burn
- 11 script_data_hash: `hash32`, see tx-anatomy/script-data-hash
- 13/18 collateral/reference_inputs: `nonempty_set<transaction_input>` (18: CIP-31)
- 14 required_signers: `nonempty_set<addr_keyhash>`; each signs; scripts see `signatories`
- 15 network_id: `0` testnet/`1` mainnet; must match every output and withdrawal address
- 16/17 collateral_return/total_collateral: `transaction_output`/`coin` (CIP-40)
- 19 voting_procedures: `{+ voter => {+ gov_action_id => [vote, anchor / null]}}`
- 20 proposal_procedures: `nonempty_oset<[deposit, reward_account, gov_action, anchor]>`
- 21 current_treasury_value: `coin`; must equal ledger treasury (`TreasuryValueMismatch`)
- 22 donation: `positive_coin` to treasury

Value preservation: `inputs+withdrawals+refunds+mint(positive)` = `outputs+fee+deposits+burn+donation` per asset (`ValueNotConservedUTxO`).
