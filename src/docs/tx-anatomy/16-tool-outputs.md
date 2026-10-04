---
gist: which tx_inspect / tx_redeemer / debug_open / cbor_validate field shows each part; redeemer refs and targets; tx_validate verdicts.
---
# How this maps to tool outputs

| Tool / view | Fields |
|---|---|
| `tx_inspect body` | keys 2/3/7/8/11/14/15/16/17/21/22, counts, redeemer refs |
| `inputs` | all three roles, `spend_index`, `redeemer`; after tx_load address/value/datum/reference script |
| `outputs,mint,withdrawals` | mint/withdrawals with redeemer refs |
| `redeemers` | ref, target, script hash, version, ex_units, data |
| `scripts` | witness/reference hash, version (`unknown`: a reference script whose language the chain data lacks), size, source |
| other tx_inspect | `datums,witnesses` (vkey `signature_check`, bootstrap, native), `certs,governance,aux,raw_json` (any path) |
| `tx_redeemer` | `summary\|error\|traces\|context\|script\|links`; context zoom `path/depth` |
| `debug_open(tx_id,redeemer)` | exact evaluated script/datum/redeemer/context bytes |
| `cbor_validate(hex, rule=…)` | `transaction_body,redeemer,babbage_transaction_output,certificate`; full CDDL: `cardano-debug://cddl/conway` |

Refs `<purpose>:<index>`: `spend:0,mint:1,withdraw:0,publish:2,vote:0,propose:0`; index = redeemer index field. `target`: sorted `input <tx>#<ix>`, `policy <hash>`, `stake <bech32>`, `cert #n`, `vote <voter>`, `proposal #n`. Aliases: `Reward:0/Cert:0`, `Rewarding #0`, `r:<n>` (n-th witness entry).

`tx_validate.verdict`: `valid`; `phase1_failed` (rule, `location` e.g. `transaction.body.inputs.0`, hint); `phase2_failed` (success:false or context/lookup error); `both_failed`; `incomplete_context` (missing input/reference/collateral UTxO in `missing_utxos`; nothing evaluated); `timeout`; `not_examined` (a limit, not a finding). Per redeemer: `success,error_headline`, declared/calculated `ex_units`, `exact|slack|over_budget|not_run`, trace count/last trace.
