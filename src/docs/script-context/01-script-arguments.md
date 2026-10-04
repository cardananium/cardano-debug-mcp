---
gist: argument order per Plutus version and purpose, where the spend datum comes from, how arguments appear in the UPLC listing.
---
# Arguments applied to the script

| Language | Purpose | Apply order (`debug_open.applied`) |
|---|---|---|
| V1, V2 | spend | `["datum","redeemer","context"]` |
| V1, V2 | mint, withdraw (reward), publish (cert) | `["redeemer","context"]` |
| V3 | all | `["context"]`; redeemer in field 2, optional spend datum in `ScriptInfo.Spending` |

- Spend datum: inline (CIP-32) or the witness datum matching `datum_hash`. Missing: V1/V2 `MissingRequiredInlineDatumOrHash`; V3 `Nothing` (CIP-69).
- Arguments are `(con data …)`. V2 spend listing: `[[[body datum] redeemer] context]`, lines 1–3 open the applications, constants near the tail; initial `FrameAwaitFunTerm` frames (`what='position'`) point there. The server never applies a separate V3 redeemer (it would over-apply).
- The context: one `Constr 0`; integers `I` (arbitrary precision), hashes `B`, no strings.
