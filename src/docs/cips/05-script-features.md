---
gist: Script CIPs 0031 to 0160, how to decode with a CIP-0057 blueprint, CIP-0029 native script JSON.
---
# Script features from CIPs

- CIP-0031 reference inputs (Vasil): body key 18 (not the 16 in its text). Read-only: unspent, value not balanced, no witness or script run, visible to scripts; tx still spends an input.
- CIP-0032 inline datums (Vasil): no witness datum; min-UTxO grows with size. V1 cannot run beside inline datums, so a V1 output with one may be unspendable (`InlineDatumNotAllowedForPlutusV1`).
- CIP-0033 reference scripts (Vasil): an output script satisfies a script requirement. Not found: `MissingScriptWitnesses`.
- CIP-0040 collateral return (Vasil): tokens in collateral inputs need `collateral_return` (else `CollateralInputContainsNonAdaAssets`); `total_collateral` = amount consumed: tx-anatomy/collateral.
- CIP-0069 (Chang #1): V3 takes one argument `ScriptContext=[TxInfo,Redeemer,ScriptInfo]`; spend datum is `Maybe`, so datum-less outputs spend. V1/V2 still fail them (`MissingRequiredInlineDatumOrHash`): script-context/script-arguments.
- CIP-0110 (Chang #1): V1 may run with reference inputs (not in its context), so V1 scripts can be referenced. Text still fails inline datums, spent-input reference scripts; actual: script-context/what-breaks-v1.
- CIP-0117: new Plutus version only (unnamed): script must evaluate to unit. Before, any non-error end passed, even a lambda (missing argument) or `false`.
- CIP-0112 Proposed, NOT live: `Observe` purpose with no ledger action; key 14 `required_observers`.
- CIP-0160 Proposed, NOT live: `Receiving` purpose (redeemer tag 6) for outputs to a `ProtectedAddress`; live tags 0-5.
- CIP-0057 `plutus.json`: `preamble`, `validators[]{datum,redeemer,compiledCode,hash}`, `definitions`. Datum/redeemer: `purpose` (spend|mint|withdraw|publish; none = any) + `schema`. Decode: `anyOf`/`oneOf` pick the `constructor` whose `index` = constr number, `fields` positional; also `integer`, `bytes`, `list` `items`, `map` `keys`/`values`; no `dataType` = any; `$ref` into `definitions`. `parameters`: baked into code.
- CIP-0029 native JSON=CBOR: `sig`{keyHash}=[0,h], `all`{scripts}=[1,[..]], `any`=[2,[..]], `atLeast`{required,scripts}=[3,n,[..]], `after`{slot}=[4,s] start incl., `before`{slot}=[5,s] end excl.
