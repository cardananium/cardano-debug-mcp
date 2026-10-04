---
gist: UPLC constant types and how debug_inspect renders them; Data constructors and tags.
---
# Constants and their types

How `debug_inspect(what='env')` renders `(con T c)` (`type`, `summary`):

| Type `T` | Syntax | Shown as |
|---|---|---|
| `integer` | `(con integer -42)` | `Con:Integer`, `-42` (decimal string; unbounded) |
| `bytestring` | `(con bytestring #abcd)` | `Con:ByteString`, `#abcd` (hex; cut at 64 chars, byte length added) |
| `string`, `unit`, `bool` | `(con string "hi")`, `(con unit ())`, `(con bool True)` | `Con:String` `"hi"`; `()`; `True`/`False` |
| `(list T)`, `(pair A B)` | `(con (list integer) [1, 2])`, `(con (pair integer data) (1, I 5))` | `list[2]`, `pair` |
| `data` | `(con data (Constr 0 [I 5, B #abcd]))`; also `Map [(k, v)]`, `List [...]` | `Con:Data`; `Constr 0 [2 fields]`, `Map [n pairs]`, `List [n]`, `I 5`, `B #abcd` |
| `bls12_381_G1_element` / `_G2_element` / `_mlresult` | `(con bls12_381_G1_element 0x…)` | the type name |

Datum, redeemer, ScriptContext each arrive as one `data` value. A `Constr` carries its CBOR tag; summaries show the constructor index (tags 121–127 → 0–6, 1280–1400 → 7–127, else the explicit `any_constructor`). Expanded with `what='value'`, a `Con:Data` is `{constant:{type:"Data", data:{type:"Constr", tag:121, fields:[...]}}}`; nested fields stay `{… N keys}` until `depth` or a deeper `path` reaches them.
