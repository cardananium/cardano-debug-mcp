---
gist: debug_open modes (tx, parts, program-only, reopen), what the answer returns and says about ignored arguments, session limits, expiry and loss.
---
# debug_open

- Tx mode (`tx_id`, + `redeemer` unless the tx has exactly one; otherwise the error lists them) applies the validator's own bytes and settings, so steps reproduce the validation. Parts: `script` + `plutus_version` with `context` / `redeemer_data` / `datum`, `cost_models` / `protocol_major` / `ex_units`; program-only: `script` alone (debug-playbook/sessions-outside-a-tx). `context` is applied last; `cost_models` is the flat list of the script's language; `purpose` (spend | mint | withdraw | publish | vote | propose) labels a parts session whose context does not decode.
- `script`: UPLC text `(program …`, hex (flat, CBOR, double CBOR), base64, a cardano-cli envelope or a ScriptRef (their stated version is used when `plutus_version` is absent).
- Arguments that do not belong to the chosen mode are not an error: `notes[]` lists them ("ignored in tx mode: script, context"; `redeemer` without `tx_id`; `protocol_major` on a program-only session).
- Returns the start position {term_id, uplc_line} of the canonical one-term-per-line UPLC listing (resource `session/{dbg_id}/uplc.txt`, announced in `resources` here only), the UPLC window, script identity (hash, version, purpose), the declared budget and the effective `protocol_major` (engine default 11) with `protocol_major_source`.
- `reopen=<dbg_id>` rebuilds a session that was evicted, expired or lost from its kept inputs (no script or context to resend); position and breakpoints start over.
- Sessions: 30 min idle, 4 h max, 8 concurrent; a new session takes the slot of a lost one, else of the least recently used idle one (`evicted` names it); a failed open evicts nothing; `session_limit` when all are busy. Lost on restart.
- A dead handle answers `expired_handle` (why: evicted, idle, closed, lost) or `session_lost` (`cause`: wasm_trap | hard_timeout | out_of_memory | worker_crash, `last_known` step and position, what to do instead of a plain retry). Short commands on one session queue; while debug_run / debug_profile runs the others answer `busy` (`running`, `since_ms`).
- Then debug_run, debug_inspect, debug_source, debug_profile, debug_close; read the logic with script_decompile(dbg_id).
