---
gist: program versions and the ten UPLC term kinds with what each does on Compute; how the listing prints them.
---
# Programs and the term grammar

`(program v M)`: `v=debug_open.plutus_core_version`. V1/V2: `1.0.0`; `1.1.0` (constr/case) came with V3, but V3 may still declare `1.0.0`. `kind` appears in `position.kind` / `script_locate.term_kind`.

| Term | kind | On Compute |
|---|---|---|
| `x` | `Var` | env lookup -> Return |
| `(lam x M)` | `Lambda` | one parameter; Return closure (body + env) |
| `[M N]` | `Apply` | push `FrameAwaitFunTerm(N,env)`, compute M; `[f a b]=[[f a] b]` |
| `(force M)` | `Force` | push `FrameForce`, compute M; runs delay / instantiates builtin |
| `(delay M)` | `Delay` | Return closure; M unevaluated |
| `(con T c)` | `Constant` | Return constant of builtin type T |
| `(builtin f)` | `Builtin` | Return builtin, 0 args / 0 forces |
| `(error)` | `Error` | enter the Error state |
| `(constr k M1 … Mn)` | `Constr` | tag k ≥ 0; push `FrameConstr`, compute M1; empty constr Returns |
| `(case M B0 … Bn)` | `Case` | push `FrameCases`, compute scrutinee M; branch Bk applied to fields |

Listing: one term per line (bracket-only lines: none). `debug_source(with_ids=true)` adds `term_ids`; `>` current, `*` breakpoint. Long constants (context: 5k+ chars) cut with `… [+N chars]`. Tx listings include the applications: `[[[validator datum] redeemer] context]` (V1/V2 spend), `[validator context]` (V3).
