---
gist: what changed between Shelley-Babbage and Conway (sets, outputs, redeemers, witness keys, body keys, certificates, auxiliary data) and how a wrong preset shows up.
---
# What changed between eras

Pick the preset by the bytes' target era, not the default.

| Feature | Shelley-Babbage | Conway | How it shows up |
|---|---|---|---|
| Sets | plain arrays | `#6.258([…])` or plain array | older preset: `expected array [ * a0 ], got #6.258(…)` at `$[0][0]` |
| Transaction output | Alonzo array `[address, value, ? datum_hash]`; Babbage adds the map `{0, 1, ?2 datum_option, ?3 script_ref}` | both | map output on `alonzo`: `expected array [ address, amount: value, … ], got map(N entries)` |
| Redeemers | `[* [tag, index, data, ex_units]]`, tags 0-3 | array or `{+ [tag, index] => [data, ex_units]}` (both validate), tags 0-5 (4 voting, 5 proposing) | map form on `babbage`: `expected array [ * redeemer ], got map(…)`; tag 4: `range 0 <= value <= 3, got 4` |
| Witness set | keys 0-6, plain arrays (6 = V2 scripts, Babbage) | keys 0-7 as `nonempty_set` (7 = V3 scripts) | `unexpected key 7` |
| Body keys | Alonzo 0-5, 6 (update), 7-9, 11, 13-15; Babbage adds 16-18 | drops 6, adds 19-22 (votes, proposals, treasury value, donation) | `unexpected key 19`; a body without key 1 or 2: `map missing key: N` |
| Certificates | kinds 0-6 (5 genesis delegation, 6 MIR) | kinds 0-4, 7-18 (DRep, committee, combined delegation) | cert 16 on `babbage`: `expected value 5, got 16` at `$[0]` |
| Auxiliary data | Shelley map, Allegra array, Alonzo `#6.259` map keys 0-2, Babbage adds 3 | adds key 4 | key 4 on `babbage`: head `unexpected key 4`, then `expected map { * metadatum_label => metadatum }, got #6.259(…)` |
