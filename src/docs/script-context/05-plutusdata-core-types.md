---
gist: constructor tag arithmetic and the PlutusData encoding of Bool, Maybe, credentials, addresses, TxOutRef, TxOut, Value, time ranges; a worked output.
---
# PlutusData encoding of the common types

Constructor `i` is CBOR tag `121+i` for `i ≤ 6`, `1280+(i-7)` for `7 ≤ i ≤ 127`, else tag 102 with an explicit index. Tool JSON shows the raw `tag` (121 = constructor 0, …).

| Type | Encoding |
|---|---|
| Bool | `False` = `Constr 0 []`, `True` = `Constr 1 []` |
| Maybe a | `Just x` = `Constr 0 [x]`, `Nothing` = `Constr 1 []` |
| Credential | `PubKeyCredential` = `Constr 0 [B keyhash]`, `ScriptCredential` = `Constr 1 [B scripthash]` |
| StakingCredential (V1/V2 only) | `StakingHash` = `Constr 0 [Credential]`, `StakingPtr` = `Constr 1 [I slot, I tx_ix, I cert_ix]` |
| Address | `Constr 0 [Credential, Maybe StakingCredential]`, also V3 (keeps the `StakingHash` wrapper) |
| TxOutRef | V1/V2: `Constr 0 [Constr 0 [B tx_id], I index]`; V3: `Constr 0 [B tx_id, I index]` |
| TxInInfo | `Constr 0 [TxOutRef, TxOut]` |
| TxOut | V1: `Constr 0 [Address, Value, Maybe B datum_hash]`; V2/V3: `Constr 0 [Address, Value, OutputDatum, Maybe B script_hash]` |
| OutputDatum (V2/V3) | `NoOutputDatum` = `Constr 0 []`, `OutputDatumHash` = `Constr 1 [B]`, `OutputDatum` = `Constr 2 [Data]` |
| Value | `Map (B policy) (Map (B name) (I qty))`; lovelace under policy `""` and name `""`. V1/V2 always include lovelace (even 0); V3 omits it when 0. Mint quantities may be negative (burn) |
| POSIXTimeRange | `Constr 0 [LowerBound, UpperBound]`; each bound `Constr 0 [Extended, Bool closed]`; `Extended`: `NegInf` = `Constr 0 []`, `Finite t` = `Constr 1 [I ms]`, `PosInf` = `Constr 2 []`. Finite lower bound closed (`True`), finite upper open (`False`), infinite bounds `True` |

Example: V2 output to a script address, inline datum, no stake part; then range `[start, ttl)`:

```
Constr 0 [ Constr 0 [Constr 1 [B #830f…be5f], Constr 1 []]  -- Address: ScriptCredential, no stake
         , Map [(B #, Map [(B #, I 2787820)]), (B #5088…, Map [(B #, I 1)])]  -- Value: 2.79 ADA + 1 token
         , Constr 2 [Constr 0 [I 1500000000000]]  -- OutputDatum (inline): Constr 0 [I …]
         , Constr 1 [] ]  -- no reference script
Constr 0 [ Constr 0 [Constr 1 [I 1700000000000], Constr 1 []]  -- from start, inclusive
         , Constr 0 [Constr 1 [I 1700007200000], Constr 0 []] ]  -- to ttl, exclusive
```
