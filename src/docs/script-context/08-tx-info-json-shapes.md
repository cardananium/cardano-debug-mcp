---
gist: JSON shapes of tx_info keys (inputs, value, datum_option, script_ref, mint, withdrawals, valid_range, redeemers, data) and of typed PlutusData.
---
# JSON shapes of tx_info and PlutusData

`tx_info` shapes (both views: context-json-views):

| Key | Shape |
|---|---|
| `inputs[i]` | `{out_ref:{transaction_id,index},resolved:{output_format:"PostAlonzo",address:<bech32>,value,datum_option,script_ref}}` |
| `value` | `{value_type:"Coin",amount}` or `{value_type:"Multiasset",coin,assets:[{policy_id,tokens:[{asset_name:<hex>,quantity}]}]}` |
| `datum_option` | `null`, `{datum_type:"Hash",hash}`, or `{datum_type:"Data",data}` |
| `script_ref` | `null` or `{script_type:"PlutusV2Script"\|…,script:<hex>}` |
| `mint` | `{mint_value:[…assets…]}` |
| `withdrawals` | `[[<stake bech32>,amount]]` |
| `valid_range` | `{lower_bound:ms\|null,upper_bound:ms\|null}`; no closure flags |
| `redeemers` | `[[purpose,{tag:{tag:"Spend"},index,data,ex_units:{mem,steps}}]]`; in V1 JSON too, not in V1 Data |
| `data` | `[[<datum hash>,<PlutusData JSON>]]` |

Typed PlutusData there:
```json
{"type":"Constr","tag":"121","any_constructor":null,"fields":[{"type":"BigInt","Int":"1500000000000"}]}
{"type":"Map","key_value_pairs":[{"key":{"type":"BoundedBytes","value":"4d454c44"},"value":{"type":"BigInt","Int":"1"}}]}
{"type":"Array","values":[…]}   big integers: {"type":"BigInt","BigUInt"|"BigNInt":"…"}
```

`tx_redeemer(part='summary')` (`redeemer_data`, `datum`) and `cbor_decode` use DetailedSchema with the constructor index, not raw tag: `{"constructor":"0","fields":[…]}`, `{"int":"42"}`, `{"bytes":"6869"}`, `{"list":[…]}`, `{"map":[{"k":…,"v":…}]}`. Env/value summaries: `Constr 0 [2 fields]`, `Map [3 pairs]`, `List [4]`, `I 42`, `B #…`.
