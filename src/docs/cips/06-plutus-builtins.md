---
gist: Which CIP adds which Plutus builtin or feature, the exact names, and whether a machine has it.
---
# Plutus builtins by CIP

Active unless marked. Proposed = maybe absent on the machine under debug: check protocol version and cost model, never assume. CIP-0035: new builtin = hard fork, changed one = new ledger language. Names below are this engine's; some CIP texts spell them differently (`builtinIntegerToByteString`, `bitwiseLogicalAnd`, `bitwiseShift`, `replicateByteString`, `modularExponentiation`). Forces, arity: uplc-cek/builtins.

| CIP | Names | Note |
|---|---|---|
| CIP-0042 | `serialiseData` | Vasil |
| CIP-0049 | `verifyEcdsaSecp256k1Signature`, `verifySchnorrSecp256k1Signature` | key, input, sig. ECDSA key 33 B, input 32 B hash; Schnorr key 32 B; sig 64 B |
| CIP-0381 | `bls12_381_{G1,G2}_{add,neg,scalarMul,equal,compress,uncompress,hashToGroup}`, `bls12_381_{mulMlResult,millerLoop,finalVerify}` | Chang #1. Compressed: G1 48 B, G2 96 B |
| CIP-0133 Proposed | `bls12_381_{G1,G2}_multiScalarMul` | lists non-empty, equal length |
| CIP-0121 | `integerToByteString` (msb-first?, length, n), `byteStringToInteger` (msb-first?, bytes) | V3; replaces CIP-0058 (Inactive). Fails: n < 0, length outside 0..2^29-1 or short |
| CIP-0122, CIP-0123, CIP-0127 | `andByteString`/`orByteString`/`xorByteString` (pad?, a, b), `complementByteString`, `readBit`, `writeBits`, `replicateByte` (len, byte); `shiftByteString`, `rotateByteString` (bytes, n), `countSetBits`, `findFirstSetBit`; `ripemd_160` | Plomin. pad? True pads, False truncates. Bit 0 = lowest bit of the LAST byte. n > 0 = toward higher bits; findFirstSetBit -1 if none |
| CIP-0101 Proposed | `keccak_256` | 32 B |
| CIP-0109 Proposed | `expModInteger` (base, exp, modulus) | exp < 0 uses inverse; modulus < 1 or no inverse fails |
| CIP-0132 Proposed | `dropList` (n, list) | V4; bad n errors |
| CIP-0138, CIP-0156 Proposed | `Array`, `indexArray`, `lengthOfArray`, `listToArray`; `multiIndexArray` ([Integer], arr) | bad index fails |
| CIP-0153 Proposed | `BuiltinValue`, `insertCoin`, `lookupCoin`, `unionValue`, `valueContains`, `valueData`, `unValueData`, `scaleValue` | Data `Value` constructor from Dijkstra (V4) |

- CIP-0085: `constr`/`case`, UPLC 1.1.0 (illegal in 1.0.0), from V3: uplc-cek/term-grammar.
- Not in this engine: `multiIndexArray`, the CIP-0153 builtins.
- Proposed: CIP-0091 forceless builtins (not planned); CIP-0152 modules via script-hash arguments (Dijkstra earliest).
