// Plutus builtin names (as the UPLC listing and the de-uplc engine label them) and the name matching
// of debug_run(until='builtin'): case-insensitive, underscores ignored, so the snake_case spelling of
// script_decompile pseudocode (builtin.un_constr_data) finds unConstrData.

/** Every builtin of Plutus V1-V3 up to protocol version 11 (for suggestions; the script's own nodes decide). */
export const PLUTUS_BUILTINS = [
  "addInteger", "subtractInteger", "multiplyInteger", "divideInteger", "quotientInteger", "remainderInteger", "modInteger",
  "equalsInteger", "lessThanInteger", "lessThanEqualsInteger",
  "appendByteString", "consByteString", "sliceByteString", "lengthOfByteString", "indexByteString", "equalsByteString",
  "lessThanByteString", "lessThanEqualsByteString",
  "sha2_256", "sha3_256", "blake2b_256", "blake2b_224", "keccak_256", "ripemd_160",
  "verifyEd25519Signature", "verifyEcdsaSecp256k1Signature", "verifySchnorrSecp256k1Signature",
  "appendString", "equalsString", "encodeUtf8", "decodeUtf8",
  "ifThenElse", "chooseUnit", "trace", "fstPair", "sndPair",
  "chooseList", "mkCons", "headList", "tailList", "nullList", "dropList",
  "chooseData", "constrData", "mapData", "listData", "iData", "bData",
  "unConstrData", "unMapData", "unListData", "unIData", "unBData", "equalsData", "serialiseData",
  "mkPairData", "mkNilData", "mkNilPairData",
  "bls12_381_G1_add", "bls12_381_G1_neg", "bls12_381_G1_scalarMul", "bls12_381_G1_equal", "bls12_381_G1_hashToGroup",
  "bls12_381_G1_compress", "bls12_381_G1_uncompress", "bls12_381_G1_multiScalarMul",
  "bls12_381_G2_add", "bls12_381_G2_neg", "bls12_381_G2_scalarMul", "bls12_381_G2_equal", "bls12_381_G2_hashToGroup",
  "bls12_381_G2_compress", "bls12_381_G2_uncompress", "bls12_381_G2_multiScalarMul",
  "bls12_381_millerLoop", "bls12_381_mulMlResult", "bls12_381_finalVerify",
  "integerToByteString", "byteStringToInteger",
  "andByteString", "orByteString", "xorByteString", "complementByteString", "readBit", "writeBits", "replicateByte",
  "shiftByteString", "rotateByteString", "countSetBits", "findFirstSetBit",
  "expModInteger", "lengthOfArray", "listToArray", "indexArray",
] as const;

/** Comparison key: lower case, underscores and spaces dropped (unConstrData == un_constr_data). */
export function builtinKey(name: string): string {
  return name.trim().toLowerCase().replace(/[_\s]/g, "");
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/** Up to `max` names closest to `wanted` (prefix / substring matches first, then small edit distance). */
export function closeBuiltinNames(wanted: string, names: readonly string[], max = 5): string[] {
  const key = builtinKey(wanted);
  const scored = names.map((name) => {
    const k = builtinKey(name);
    const score = k === key ? 0 : k.startsWith(key) || key.startsWith(k) ? 1 : k.includes(key) || key.includes(k) ? 2 : 3 + editDistance(key, k);
    return { name, score };
  });
  return scored
    .filter((s) => s.score <= Math.max(3 + 3, Math.ceil(key.length / 2) + 3))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((s) => s.name);
}
