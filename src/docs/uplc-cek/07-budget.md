---
gist: ExBudget charges (startup, per-term, builtin costing), over_budget, builtin semantics vs cost tables per protocol, parity.
---
# Budget: steps, builtin costs, over_budget

`ExBudget {cpu,mem}`; cpu = redeemer `ex_units.steps`. Charges:
- Startup once (100 / 100); fixed Compute cost per kind, `cek_{var,const,lam,apply,delay,force,builtin,constr,case}_cost`: 16000 cpu / 100 mem each (defaults/mainnet).
- Saturated builtins: argument-size costing functions (CIP-35): integer = 64-bit words (0 -> 1); bytestring = 8-byte words (empty -> 1); string = characters (D/E: ⌈UTF-8 bytes / 4⌉); bool/unit = 1; Data = 4/node + leaves; closures/constrs = 1.
- Slippage 1 (exact per step). Profile splits `step_kinds` (count/cost, `StartUp`) and `builtins` (calls/cpu/mem), charging transitions to `hot_terms/hot_lines`.

The stepper never enforces a declared limit; scripts run to their real end. `budget.over_budget` = spent > declared; `cpu_declared,cpu_pct,mem_pct` only if declared. The machine has its own safety cap (about 1e13 cpu / 1.4e13 mem): a script that reaches it stops with an error saying so (`over_budget` stays false: it is not your declared budget). Chain stops at first excess (`execution went over budget`); validator: `NoEnoughBudget`. `until='budget', cpu=N` stops when spent cpu first reaches N.

Builtin **behaviour** and **cost table** follow the tx protocol major in the validator and the stepper alike: V1/V2 B at 9-10, D at 11+; V3 C at 9-10, E at 11+ (C/E add checks e.g. `consByteString` byte bounds; D/E cost strings by UTF-8 bytes; CIP-153 value builtins only V3 at 11+; array builtins 89-91 unsupported). Same path and parameters = same ex-units; `parity.match=false` means a different path (traces/early errors) or other parameters. `debug_open.cost_model_source`: `protocol_params` (tx mode or that arg), `supplied` (`cost_models`), `engine_default`.
