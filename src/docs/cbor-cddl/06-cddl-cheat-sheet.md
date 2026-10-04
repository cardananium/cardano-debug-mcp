---
gist: CDDL syntax in brief: rules, groups, arrays and maps, occurrences, choices, literals, tags, controls, generics, prelude.
---
# CDDL in 20 lines

- `name = type` is a rule; a group rule `name = (a, b)` is a run of entries, only usable inside an array or map (`group_rule_root` as a root).
- `[ … ]` array, `{ … }` map; `key : type` (text or int key), `key => type` (any key); `name : type` labels a positional slot.
- Occurrence: `? x` optional, `* x` 0+, `+ x` 1+, `n*m x` bounded. Choices: `a / b` type, `a // b` group; `/=` and `//=` extend an earlier rule.
- Literals: `0`, `-1`, `"text"`, `h'0102'`, `true`; ranges `0 .. 3`, `1 .. max_word64`.
- `#6.24(bytes)` tag 24 around bytes; `#0`-`#7` any item of that major type.
- Controls: `bytes .size 32`, `.size (0 .. 64)`, `uint .size 2` (fits in 2 bytes), `bytes .cbor rule` (holds CBOR matching `rule`), `.le`, `.default`.
- Generics: `set<a0> = #6.258([* a0]) / [* a0]`, used as `set<transaction_input>`; not a root: pick a rule instantiating it.
- Prelude: `uint nint int bstr bytes tstr text bool nil null float16 float32 float64 any biguint bignint bigint`, tagged names (`tdate`, `uri`).
- `;` comments. Order is free; every name must resolve (`unresolved_references`); a name defined twice is a `parse_error`.
