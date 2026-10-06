// Builtins bucketed into six readable groups for the profile report: a naming heuristic over the
// builtin names, the same buckets de-uplc-web's profiler shows (its "Builtins" table and the DATA
// DECODING headline). `data` is exactly the `*Data` builtins. A name this table does not know
// lands in `control` instead of vanishing.

export type BuiltinGroupId = "data" | "equality" | "list" | "arith" | "crypto" | "control";

/** Declaration order: the tie-break when two groups cost the same. */
export const BUILTIN_GROUPS: ReadonlyArray<{ id: BuiltinGroupId; title: string }> = [
  { id: "data", title: "Data decode / encode" },
  { id: "equality", title: "Equality & compare" },
  { id: "list", title: "List & pair ops" },
  { id: "arith", title: "Integer & bytestring" },
  { id: "crypto", title: "Crypto & hashing" },
  { id: "control", title: "Control & misc" },
];

const MEMBERS: Record<BuiltinGroupId, readonly string[]> = {
  data: [
    "chooseData", "constrData", "mapData", "listData", "iData", "bData", "unConstrData", "unMapData", "unListData",
    "unIData", "unBData", "equalsData", "serialiseData", "mkPairData", "mkNilData", "mkNilPairData",
  ],
  equality: [
    "equalsInteger", "lessThanInteger", "lessThanEqualsInteger", "equalsByteString", "lessThanByteString",
    "lessThanEqualsByteString", "equalsString",
  ],
  list: [
    "fstPair", "sndPair", "chooseList", "mkCons", "headList", "tailList", "nullList", "dropList", "lengthOfArray",
    "listToArray", "indexArray",
  ],
  arith: [
    "addInteger", "subtractInteger", "multiplyInteger", "divideInteger", "quotientInteger", "remainderInteger", "modInteger",
    "expModInteger", "appendByteString", "consByteString", "sliceByteString", "lengthOfByteString", "indexByteString",
    "integerToByteString", "byteStringToInteger", "andByteString", "orByteString", "xorByteString", "complementByteString",
    "readBit", "writeBits", "replicateByte", "shiftByteString", "rotateByteString", "countSetBits", "findFirstSetBit",
    "appendString", "encodeUtf8", "decodeUtf8",
  ],
  crypto: [
    "sha2_256", "sha3_256", "blake2b_256", "blake2b_224", "keccak_256", "ripemd_160", "verifySignature",
    "verifyEd25519Signature", "verifyEcdsaSecp256k1Signature", "verifySchnorrSecp256k1Signature",
    "bls12_381_G1_add", "bls12_381_G1_neg", "bls12_381_G1_scalarMul", "bls12_381_G1_equal", "bls12_381_G1_compress",
    "bls12_381_G1_uncompress", "bls12_381_G1_hashToGroup", "bls12_381_G1_multiScalarMul",
    "bls12_381_G2_add", "bls12_381_G2_neg", "bls12_381_G2_scalarMul", "bls12_381_G2_equal", "bls12_381_G2_compress",
    "bls12_381_G2_uncompress", "bls12_381_G2_hashToGroup", "bls12_381_G2_multiScalarMul",
    "bls12_381_millerLoop", "bls12_381_mulMlResult", "bls12_381_finalVerify",
  ],
  control: ["ifThenElse", "chooseUnit", "trace"],
};

const GROUP_OF: ReadonlyMap<string, BuiltinGroupId> = new Map(
  (Object.entries(MEMBERS) as Array<[BuiltinGroupId, readonly string[]]>).flatMap(([id, names]) => names.map((name) => [name, id] as const)),
);

/** Group of a builtin name; an unknown name is `control`. */
export function groupOf(name: string): BuiltinGroupId {
  return GROUP_OF.get(name) ?? "control";
}

/** Whether the table knows `name` (a test pins that every builtin of the engine is classified on purpose). */
export function isClassified(name: string): boolean {
  return GROUP_OF.has(name);
}

export interface BuiltinRow {
  name: string;
  calls: bigint;
  cpu: bigint;
  mem: bigint;
}

export interface BuiltinGroupRow {
  group: BuiltinGroupId;
  title: string;
  /** Distinct builtins of the group that ran. */
  builtins: number;
  calls: bigint;
  cpu: bigint;
  mem: bigint;
  /** Share of all builtin cpu, in percent (two decimals). */
  cpu_pct: number;
}

function pct(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  return Number((part * 10_000n) / whole) / 100;
}

/** Totals over all builtins, and one row per group that ran, the costliest (cpu) first. */
export function groupBuiltins(rows: readonly BuiltinRow[]): { total: { calls: bigint; cpu: bigint; mem: bigint }; groups: BuiltinGroupRow[] } {
  const total = { calls: 0n, cpu: 0n, mem: 0n };
  const groups = new Map<BuiltinGroupId, BuiltinGroupRow>();
  for (const row of rows) {
    total.calls += row.calls;
    total.cpu += row.cpu;
    total.mem += row.mem;
    const id = groupOf(row.name);
    const title = BUILTIN_GROUPS.find((g) => g.id === id)!.title;
    const acc = groups.get(id) ?? { group: id, title, builtins: 0, calls: 0n, cpu: 0n, mem: 0n, cpu_pct: 0 };
    acc.builtins += 1;
    acc.calls += row.calls;
    acc.cpu += row.cpu;
    acc.mem += row.mem;
    groups.set(id, acc);
  }
  const order = new Map(BUILTIN_GROUPS.map((g, i) => [g.id, i] as const));
  const out = Array.from(groups.values()).sort((a, b) => (a.cpu === b.cpu ? order.get(a.group)! - order.get(b.group)! : a.cpu > b.cpu ? -1 : 1));
  for (const g of out) g.cpu_pct = pct(g.cpu, total.cpu);
  return { total, groups: out };
}
