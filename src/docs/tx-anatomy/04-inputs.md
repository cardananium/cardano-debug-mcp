---
gist: inputs vs reference inputs vs collateral: consumed or not, what scripts see, overlap rules, sorted order.
---
# Inputs, reference inputs, collateral inputs

- inputs (0), consumed yes: resolved `TxInInfo`; spend datum from spent output; must be unspent (`BadInputsUTxO`)
- reference_inputs (18), consumed no: resolved outputs/datums/values, `script_ref`; unspent. Overlap with inputs rejected: PV 9–10 always, PV ≥ 11 if PlutusV3 runs (`ReferenceInputOverlapsWithInput`; validation-errors)
- collateral (13), consumed only if `is_valid=false`: absent from TxInfo; see tx-anatomy/collateral

Input order = sorted `(tx_id bytes,index)` for redeemer indices, `TxInfo.inputs`, `spend_index`, not CBOR order; unsorted CBOR warns `InputsAreNotSorted`.
