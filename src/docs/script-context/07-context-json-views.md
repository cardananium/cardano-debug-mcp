---
gist: tx_redeemer(part='context') vs debug_inspect(what='context'): source, fidelity, size caps, resources, path grammar.
---
# JSON views used by the tools

Both views take dotted paths or JSON pointers; the language key is optional (`tx_info.inputs.0` ≡ `tx_info.V2.inputs.0`; bare `inputs.0` works). Root keys include `purpose`, `script_context_version`, V3 `redeemer`. Missing path: `path_not_found` with `resolved` / `available`. Integers are decimal strings (`"index":"2"`, `"tag":"121"`).

| | `tx_redeemer(part='context')` | `debug_inspect(what='context')` |
|---|---|---|
| Source/fidelity | typed context the engine (uplc) built; known differences listed here (V3 Reg/UnReg deposit shown, script gets `Nothing`); `context.cbor` is the exact Data applied | applied Data decoded to named shape; lost: `redeemers[].index/ex_units` = 0, addresses rebuilt as mainnet bech32, certificate deposits/anchors absent |
| Size | `depth` 1..6, default 2; 10k chars; `truncated` + `children` | `depth` 1..5, default 2; 8k chars; `keys` lists the children |
| Full resource | `tx/{tx_id}/redeemer/{ref}/context.json`, `…/context.cbor` | no session context resource; tx mode uses the redeemer resource |
