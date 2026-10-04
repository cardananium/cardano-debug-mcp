---
gist: what tx_load substitutes when a bundle or provider lacks data (slot, prices, cost models, accounts, treasury…), which errors each default can cause, and the provider_warnings kinds.
---
# `defaults_applied` and `provider_warnings` (tx_load)

defaults_applied lists substitutions/reasons (live Koios: null protocol rows); tx_validate shows only `defaults_applied_count` (the list when it loaded the chain state itself). De-uplc DebuggerContext has tx/UTxOs/partial params:

- utxoSet[*].isSpent=false: spent inputs undetected; no BadInputsUTxO
- on-chain tx (tx_hash, `on_chain`): at inclusion slot, epoch params, own inputs unspent; accounts/pools/DReps/governance current: withdrawal/registration errors may be artefacts; `on_chain.note` names real failures
- slot=…: no tip: inside validity interval, else wall clock; drives OutsideValidityIntervalUTxO, ScriptContext POSIX range
- absent executionPrices -> mainnet: FeeTooSmallUTxO ex-unit part may differ
- minFeeRefScriptCostPerByte=15, adaPerUtxoByte, deposits, collateralPercent, other missing params: check values
- absent costModels={}: CostModelNotFound; cannot hash script data
- treasuryValue=0; empty account/pool/DRep/gov-action/committee; constitution=null: RewardAccountNotExisting, StakeNotRegistered/StakePoolNotRegistered, CannotCheck*Refund, VoterDoNotExist, TreasuryValueMismatch

Verify default-dependent findings live (`tx_load(tx_cbor,network)`). Share links carry a fetched context; server bundles their original list.

provider_warnings: anonymous Koios rate limits; Blockfrost no constitution endpoint (guardrails skipped); `script_unverified: <utxo> …` missing/hash-mismatched reference bytes; `chain state not loaded: …` bytes-only (incomplete_context); bundle tx_hash ≠ CBOR (CBOR wins).
