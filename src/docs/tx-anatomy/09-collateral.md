---
gist: collateral input rules, the required amount ceil(fee·pct/100), collateral return and total, what is_valid=false consumes.
---
# Collateral rules

Redeemers require collateral (`NoCollateralInputs`); collateral without redeemers warns `CollateralIsUnnecessary`.

- Inputs: unspent, key-locked (`CollateralIsLockedByScript`), ≤ `max_collateral_inputs` (pp 24, `TooManyCollateralInputs`); may overlap regular inputs
- Amount: 100·collateral ≥ collateral_percentage·fee (pp 23), i.e. ceil(fee·pct/100): fee 267027 at 150 needs 400541; `InsufficientCollateral`
- No return: each input ADA-only, `CollateralInputContainsNonAdaAssets`
- With return (CIP-40): consumed = inputs − `collateral_return`; ADA-only (`CalculatedCollateralContainsNonAdaAssets`), = declared `total_collateral` (`IncorrectTotalCollateralField`); return meets min-UTxO (`CollateralReturnTooSmall`)

`is_valid=false`: collateral inputs consumed, return is the only new output, rest is fee; regular inputs/outputs/certs untouched.
