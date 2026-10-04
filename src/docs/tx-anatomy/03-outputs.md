---
gist: output forms (Babbage map, Alonzo array), address header bits, value, datum_option, script_ref, min-UTxO.
---
# Outputs

Babbage `{0:address,1:value,?2:datum_option,?3:script_ref}` and Alonzo `[address,value,?datum_hash]` may mix. Example: mainnet enterprise script (0x71), one token, inline `Constr 0 []`, V3 reference script:
```
{0: h'71<28-byte script hash>', 1: [2000000, {h'<policy id>': {h'': 1}}],
 2: [1, 24(h'd87980')], 3: 24(h'8203<bstr: script bytes>')}
```

- address: header bit 4 = script payment cred, bit 5 = script stake cred (base); high nibble enterprise `0110/0111`, reward `1110/1111`, Byron `1000`; low nibble = network. key payment cred → vkey witness; script → script + Plutus redeemer
- value: coin or `[coin,{policy_id=>{asset_name=>positive_coin}}]`; size: `max_value_size`
- datum_option: `[0,hash32]` or inline `[1,#6.24(bytes .cbor plutus_data)]` (CIP-32). Conway rejects V1 only over inline datums (V1 reference inputs/scripts allowed; the server's ReferenceInputsNotAllowedForPlutusV1 is its own, see script-context)
- script_ref: `#6.24(bytes .cbor script)`; `script=[0,native]|[1,v1]|[2,v2]|[3,v3]` (CIP-33); input/reference-input UTxOs supply scripts
- min-UTxO: lovelace ≥ `(160+serialized_output_size)*coinsPerUTxOByte` (pp 17), every output incl. collateral return; raising coin can add a byte, iterate; `OutputTooSmallUTxO`
