---
gist: min fee = size fee + reference-script fee (25,600-byte tiers) + ex-unit fee; min-UTxO.
---
# Fees and min-UTxO

`min_fee=size_fee+ref_script_fee+ex_units_fee`; too little `FeeTooSmallUTxO`, >10% above warns; validator exposes `fee_decomposition`.

- Size: `minFeeA*tx_size+minFeeB` (pp 0,1); size = CBOR `[body,witnesses,aux]` (no is_valid, ~1 byte less)
- Execution: `ceil(mem*mem_price+steps*step_price)`, summed declared units; rational prices (pp 19)
- Reference scripts: original bytes of every `script_ref` on `inputs ∪ reference_inputs` (a UTxO in both counts once; one script on two UTxOs twice). 25,600-byte tiers: base `minFeeRefScriptCostPerByte` (pp 33), each tier ×1.2; floor `base*25600*(1.2^n-1)/0.2+r*base*1.2^n`, n full tiers/r remainder
- Min-UTxO: see tx-anatomy/outputs; collateral return included
