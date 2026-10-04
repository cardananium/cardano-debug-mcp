---
gist: what each tx_redeemer part answers (summary, error, traces, context, script, links), which resources it lists and the context path roots.
---
# tx_redeemer

- `summary`: script identity, target, ex-units, error headline, decoded redeemer / datum.
- `error`: the full machine error with a category (validation-errors/redeemer-error-categories), hint and `within_budget`.
- `traces`: the trace messages emitted during validation (paged, substring filter).
- `context`: a slice of the ScriptContext as the engine (uplc) built it; `context.cbor` is the exact Data applied (differences: script-context/context-json-views).
- `script`: hash, version, size and links to the bytes and pseudocode (also after a validation timeout).
- `links`: deep links into de-uplc-web / cquisitor / the decompiler; a failed redeemer's cquisitor link highlights its Plutus row and diagnostics, its de-uplc link the failing term once a debug session of it stopped there. Custom targets: ui_link.

Context path roots: `tx_info` (the version key `tx_info.V1|V2|V3` may be omitted, bare `inputs.0` works), `purpose`, `script_context_version`, `redeemer` (V3 only). Field names per version: script-context/txinfo-fields.

`resources` (context.json / context.cbor, traces.txt, error.txt, script.hex, parts.json, links.txt of this redeemer) are listed by `summary`; another part lists only the one it points at (script: the bytes, pseudocode and UPLC; a cut error, trace, context or URL: its full text). Unresolved UTxOs give `incomplete_context` with `missing_utxos` (first 20, `missing_utxos_total`).
