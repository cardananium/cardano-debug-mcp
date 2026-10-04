---
gist: ScriptContext shape per version (PlutusData and JSON envelope) and the arities that identify the version.
---
# ScriptContext by version

| Version | PlutusData | JSON envelope |
|---|---|---|
| V1, V2 | `Constr 0 [TxInfo, ScriptPurpose]` | `{"script_context_version":"V1V2","tx_info":{"V1"\|"V2":{…}},"purpose":{"purpose_type":…}}` |
| V3 | `Constr 0 [TxInfo, Redeemer, ScriptInfo]` | `{"script_context_version":"V3","tx_info":{"V3":{…}},"redeemer":<PlutusData JSON>,"purpose":{"script_info_type":…}}` |

`tx_info` is language-tagged; purpose tags use the same six names. Arity: context 2 = V1/V2, 3 = V3; TxInfo 10 = V1, 12 = V2, 16 = V3.
