---
gist: recognising let, branches, Aiken expect / fail, field access, Scott / SOP sums and recursion in UPLC.
---
# Compiled-code idioms

- **Let**: `[(lam i body) value]`; nested = helper prelude, one env row each.
- **Branch**: `(force [[[(force (builtin ifThenElse)) cond] (delay then)] (delay else)])`; only the chosen delay is forced/costed. Final `(delay (con unit ()))` / `(delay (error))`: often the last check.
- **Aiken expect/fail**: `chooseData` kind check, delayed `unConstrData` arm, delayed errors elsewhere; traced failure: the Aiken trace pattern (uplc-cek/traces) with msg `"expect …"`, body `(error)`.
- **Fields**: `[(force (force (builtin sndPair))) [(builtin unConstrData) d]]`; field n = n forced `tailList`, forced `headList`, then `unIData/unBData/unListData`. Forced-twice `fstPair` gives the index for `equalsInteger`.
- **Scott sums (1.0.0)**: one continuation per constructor; `Just 1 = (delay (lam n (lam j [j (con integer 1)])))`, matched by `[[(force v) nothingCase] justCase]`. In 1.1.0: `(constr 1 (con integer 1))`, `(case v nothingBranch justBranch)`; bools may be `(constr 0)/(constr 1)` under case.
- **Recursion**: fixpoint combinator: `[(lam f [(lam s [s s]) (lam s [f (lam x [[s s] x])])]) (lam rec (lam n …))]`; thousands of profile `hits` suggest a loop body.
