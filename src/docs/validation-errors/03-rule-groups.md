---
gist: the phase-1 rule groups (balance, witnesses, collateral, outputs, certificates, governance, limits, network, auxiliary data) with the rules that span a whole group and the tx_inspect section to open.
---
# Phase-1 rule groups

Each name's entry: docs(error=<Name>). Group-wide facts:

- Balance and fees: data.difference = input − output; fee tiers for reference scripts: tx-anatomy/fees-min-utxo.
- Witnesses, signatures, scripts, datums: requirements come from spent payment credentials, collateral, withdrawals, certs/votes/proposals, mint, required_signers; sources are witnesses and input/reference script_ref. `tx_add_witnesses` reports added hashes.
- Collateral: with redeemers, collateral ≥ ceil(fee × pct / 100) (collateralPercentage; fee 267027, pct 150 -> 400541).
- Outputs and min-UTxO: inspect `tx_inspect outputs`.
- Certificates and governance: inspect `tx_inspect certs/governance` and live rows. Cert order matters (register before delegate); withdrawals apply first. Bundles lack accounts, pools, DReps, governance state.
- Limits, sizes, validity, inputs: compare `body.validity` with the slot and defaults.
- Network: network ≠ context. Check `defaults_applied` (`network=… inferred`): fix the builder network or pass `tx_load(network=…)`; preview/preprod share prefixes.
- Auxiliary data: inspect `tx_inspect aux`.

Declared by the library but never emitted (entries say so): MalformedProposal, ExpirationEpochTooSmall, InvalidPrevGovActionId, ProposalCantFollow, OutputBootAddrAttrsTooBig, PlutusScriptIsUnsuccessful, MissingTxBodyMetadataHash, MissingTxMetadata, ConflictingMetadataHash, InvalidMetadata, InsufficientFundsForMir, UnknownError, InputUsesRewardAddress, InvalidRedeemerIndex, NativeScriptIsReferencedByRedeemer.
