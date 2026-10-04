---
gist: builtin forces and arity, saturation, missing / extra force errors, the Data access builtins.
---
# Builtins: forces, saturation, Data access

Builtins accumulate args, run at saturation. Polymorphic ones take forces before any arg; too few: `a builtin received a term argument … forgot to wrap the builtin with a force`; too many: `… have an extra force`.

| Builtin | forces | arity | Meaning |
|---|---|---|---|
| `ifThenElse` | 1 | 3 | returns 2nd/3rd arg; strict, so branches are delayed + outer force |
| `chooseUnit,trace,mkCons,headList,tailList,nullList,chooseData` | 1 | 2,2,2,1,1,1,6 | `chooseData d c m l i b` selects by Data kind |
| `fstPair,sndPair,chooseList` | 2 | 1,1,3 | |
| all others (arithmetic, bytes, hashes, signatures, Data, BLS, bits) | 0 | 1–3 | |

Data access (inverse in brackets): `unConstrData d` -> `pair integer (list data)`, index and fields (`constrData i fields`); `unMapData` -> `list (pair data data)` (`mapData`); `unListData` -> `list data` (`listData`); `unIData`/`unBData` -> integer/bytestring (`iData`/`bData`); also `equalsData,serialiseData,mkPairData,mkNilData,mkNilPairData`. Wrong Data kind fails (`failed to deserialise PlutusData using UnConstrData …`), e.g. Aiken `expect` on a wrong constructor.
