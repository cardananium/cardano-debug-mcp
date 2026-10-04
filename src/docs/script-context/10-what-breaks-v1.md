---
gist: V1 context shape differences, what the context builder refuses, where the Conway ledger differs, what V1/V2 cannot express.
---
# What breaks V1 scripts

- Shape: 10-field TxInfo, no `reference_inputs/redeemers`; 3-field TxOut with `Maybe datum_hash`; wrapped tx id in TxOutRef; withdrawals/data are pair lists; fee is Value. Swapping V1/V2 contexts misaligns field accesses.
- Builder rejects: any body `reference_inputs` or spent-input `script_ref` (`ReferenceInputsNotAllowedForPlutusV1`); spent inline datum (`InlineDatumNotAllowedForPlutusV1`); it turns an output inline datum into “no datum” and drops output reference scripts. All versions reject Byron-address input (`ByronAddressNotAllowed`), stake-address input (`NoPaymentCredential`), slot below `zero_slot` (`SlotTooFarInThePast`), redeemer aimed at no script element (`ExtraneousRedeemer`).
- Ledger divergence: for V1 the Conway ledger rejects only inline datums (spent inputs, reference inputs, outputs: `InlineDatumsNotSupported`); reference scripts and reference inputs are accepted (absent from the V1 TxInfo). The node accepts txs the server's `ReferenceInputsNotAllowedForPlutusV1` refuses: confirm V1 verdicts against the chain.
- V1/V2 cannot express Conway vote-delegation/DRep/committee certificates, votes, proposals, treasury value/donation: ledger translation refuses them (`CertificateNotSupported`, `…FieldNotSupported`); the engine cannot encode them.
