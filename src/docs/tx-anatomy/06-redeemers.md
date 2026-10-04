---
gist: redeemer tag / index per purpose, the index order of each tag, where the script hash comes from, datum and lookup rules.
---
# Redeemers: tag, index, and how the script is found

`redeemer=[tag,index,data,ex_units]`, `ex_units=[mem,steps]`. Tag/index selects one execution; the hash comes from the body element, not the redeemer. Example: second sorted input, `Constr 0 []`:
```
{[0, 1]: [121([]), [520000, 180000000]]}
```

| Tag | Purpose | Index order | Script hash source |
|---|---|---|---|
| 0 | spend | inputs sorted `(tx_id,index)` | spent output payment credential |
| 1 | mint | policies bytewise | policy id |
| 2 | publish (cert) | body `certs` order | stake/DRep/committee credential; legacy stake reg and pool certs take none (`UnsupportedCertificateType`) |
| 3 | withdraw (reward) | network, script before key, hash | reward-account script credential (`NonScriptWithdrawal` otherwise) |
| 4 | vote | committee script, committee key, DRep script, DRep key, pool key; then hash | script voter cred |
| 5 | propose | body `proposal_procedures` order | guardrails hash for `parameter_change/treasury_withdrawals`; others `NoGuardrailScriptForProcedure` |

- Spend datum required V1/V2 (`MissingRequiredInlineDatumOrHash`), optional V3 (CIP-69); other purposes have none.
- Phase 1: exactly one per script element. Past-end index `RedeemerIndexOutOfBounds`; key-credential target extraneous; missing `MissingRedeemer`.
- Hash resolved in witness set and input/reference-input `script_ref`s: absent `MissingRequiredScript`; native-script target too (no Plutus script; node calls the redeemer extra).
- Args: V1/V2 spend `datum,redeemer,context`; other V1/V2 `redeemer,context`; V3 `context` only (holds redeemer, optional datum in `ScriptInfo.Spending`). Context = ledger-built PlutusData `Constr` (TxInfo + purpose).
