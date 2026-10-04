Replay this offline bundle.

Bundle: {{bundle}}

1) tx_load(bundle=…) and keep the tx_id. A bundle cannot carry everything the ledger knows (tip slot, account balances, prices): read tx_load's defaults_applied / provider_warnings and docs(topic='validation-errors', section='defaults_applied') before blaming the transaction for an error those defaults can cause.
{{steps}}
No network is used: state the bundle's captured_at and slot in your conclusions, and say so when the chain may have moved since. captured_at null means the source carried no capture time (a DebuggerContext, for one): say the capture time is unknown instead of naming one.
