// A small UPLC term builder and `flat` encoder (de Bruijn form, the encoding Plutus scripts are stored in), enough to
// hand-write test scripts without any external compiler: lambdas, applications, delay / force, constants (unit,
// integer, bytestring, string, bool, data), builtins by name, constr / case (Plutus V3), error.
//
//   const alwaysSucceeds = flatProgram(lam(lam(lam(unit()))));        // \datum redeemer ctx -> ()
//   plutusFromFlat(2, flatProgram(...))                                 // see script.ts
//
// Flat rules used here: terms are 4-bit tags; naturals are 7-bit groups, least significant first, high bit = more;
// integers are zigzag naturals; byte strings are byte-aligned chunks of <= 255 bytes ended by a zero byte; lists are a
// 1 bit before every element and a final 0 bit; the program ends with `0..01` padding to a byte boundary.

import { encodePlutusData, type PlutusData } from "./plutusData.js";
import { utf8 } from "./bytes.js";

export type Term =
  | { k: "var"; i: number }
  | { k: "lam"; body: Term }
  | { k: "app"; f: Term; a: Term }
  | { k: "delay"; t: Term }
  | { k: "force"; t: Term }
  | { k: "unit" }
  | { k: "int"; v: bigint }
  | { k: "bytes"; v: Uint8Array }
  | { k: "string"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "data"; v: PlutusData }
  | { k: "builtin"; name: BuiltinName }
  | { k: "error" }
  | { k: "constr"; tag: number; fields: Term[] }
  | { k: "case"; scrutinee: Term; branches: Term[] };

/** The first 52 builtins of the default universe, in their on-chain numbering. */
export const BUILTINS = [
  "addInteger", "subtractInteger", "multiplyInteger", "divideInteger", "quotientInteger", "remainderInteger", "modInteger", "equalsInteger",
  "lessThanInteger", "lessThanEqualsInteger", "appendByteString", "consByteString", "sliceByteString", "lengthOfByteString", "indexByteString",
  "equalsByteString", "lessThanByteString", "lessThanEqualsByteString", "sha2_256", "sha3_256", "blake2b_256", "verifyEd25519Signature",
  "appendString", "equalsString", "encodeUtf8", "decodeUtf8", "ifThenElse", "chooseUnit", "trace", "fstPair", "sndPair", "chooseList", "mkCons",
  "headList", "tailList", "nullList", "chooseData", "constrData", "mapData", "listData", "iData", "bData", "unConstrData", "unMapData", "unListData",
  "unIData", "unBData", "equalsData", "mkPairData", "mkNilData", "mkNilPairData", "serialiseData",
] as const;
export type BuiltinName = (typeof BUILTINS)[number];

export const v = (i: number): Term => ({ k: "var", i });
export const lam = (body: Term): Term => ({ k: "lam", body });
export const app = (f: Term, ...args: Term[]): Term => args.reduce((acc, a) => ({ k: "app", f: acc, a }), f);
export const delay = (t: Term): Term => ({ k: "delay", t });
export const force = (t: Term): Term => ({ k: "force", t });
export const unit = (): Term => ({ k: "unit" });
export const integer = (n: number | bigint): Term => ({ k: "int", v: BigInt(n) });
export const byteString = (b: Uint8Array): Term => ({ k: "bytes", v: b });
export const str = (s: string): Term => ({ k: "string", v: s });
export const bool = (b: boolean): Term => ({ k: "bool", v: b });
export const dataConst = (d: PlutusData): Term => ({ k: "data", v: d });
export const builtin = (name: BuiltinName): Term => ({ k: "builtin", name });
export const error = (): Term => ({ k: "error" });
export const constrTerm = (tag: number, ...fields: Term[]): Term => ({ k: "constr", tag, fields });
export const caseTerm = (scrutinee: Term, ...branches: Term[]): Term => ({ k: "case", scrutinee, branches });

/** `\ _ ... _ -> body` with `n` lambdas. */
export const lams = (n: number, body: Term): Term => (n === 0 ? body : lam(lams(n - 1, body)));

/** The omega loop `(\x -> x x) (\x -> x x)`: never finishes. */
export const omega = (): Term => app(lam(app(v(1), v(1))), lam(app(v(1), v(1))));

class Bits {
  private bytes: number[] = [];
  private cur = 0;
  private used = 0;
  bit(b: 0 | 1): void {
    this.cur = (this.cur << 1) | b;
    if (++this.used === 8) this.flush();
  }
  bits(value: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) this.bit(((value >> i) & 1) as 0 | 1);
  }
  private flush(): void {
    this.bytes.push(this.cur);
    this.cur = 0;
    this.used = 0;
  }
  /** `0..01` up to the next byte boundary (a whole `00000001` byte when already aligned). */
  filler(): void {
    while (this.used !== 7) this.bit(0);
    this.bit(1);
  }
  natural(n: bigint): void {
    let rest = n;
    do {
      const group = Number(rest & 0x7fn);
      rest >>= 7n;
      this.bits(rest > 0n ? group | 0x80 : group, 8);
    } while (rest > 0n);
  }
  byteString(data: Uint8Array): void {
    this.filler();
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.subarray(i, i + 255);
      this.bits(chunk.length, 8);
      for (const b of chunk) this.bits(b, 8);
    }
    this.bits(0, 8);
  }
  finish(): Uint8Array {
    this.filler();
    return Uint8Array.from(this.bytes);
  }
}

const TERM_TAG = { var: 0, delay: 1, lam: 2, app: 3, con: 4, force: 5, error: 6, builtin: 7, constr: 8, case: 9 } as const;

function typeTags(t: Term): number[] {
  switch (t.k) {
    case "int":
      return [0];
    case "bytes":
      return [1];
    case "string":
      return [2];
    case "unit":
      return [3];
    case "bool":
      return [4];
    case "data":
      return [8];
    default:
      throw new Error("not a constant");
  }
}

function writeList<T>(w: Bits, items: T[], each: (x: T) => void): void {
  for (const x of items) {
    w.bit(1);
    each(x);
  }
  w.bit(0);
}

function writeTerm(w: Bits, t: Term): void {
  switch (t.k) {
    case "var":
      w.bits(TERM_TAG.var, 4);
      w.natural(BigInt(t.i));
      return;
    case "delay":
      w.bits(TERM_TAG.delay, 4);
      writeTerm(w, t.t);
      return;
    case "lam":
      w.bits(TERM_TAG.lam, 4);
      writeTerm(w, t.body);
      return;
    case "app":
      w.bits(TERM_TAG.app, 4);
      writeTerm(w, t.f);
      writeTerm(w, t.a);
      return;
    case "force":
      w.bits(TERM_TAG.force, 4);
      writeTerm(w, t.t);
      return;
    case "error":
      w.bits(TERM_TAG.error, 4);
      return;
    case "builtin": {
      const index = BUILTINS.indexOf(t.name);
      if (index < 0) throw new Error(`unknown builtin ${t.name}`);
      w.bits(TERM_TAG.builtin, 4);
      w.bits(index, 7);
      return;
    }
    case "constr":
      w.bits(TERM_TAG.constr, 4);
      w.natural(BigInt(t.tag));
      writeList(w, t.fields, (f) => writeTerm(w, f));
      return;
    case "case":
      w.bits(TERM_TAG.case, 4);
      writeTerm(w, t.scrutinee);
      writeList(w, t.branches, (b) => writeTerm(w, b));
      return;
    default: {
      // constants
      w.bits(TERM_TAG.con, 4);
      writeList(w, typeTags(t), (tag) => w.bits(tag, 4));
      switch (t.k) {
        case "int":
          w.natural(t.v >= 0n ? t.v << 1n : (-t.v << 1n) - 1n);
          return;
        case "bytes":
          w.byteString(t.v);
          return;
        case "string":
          w.byteString(utf8(t.v));
          return;
        case "unit":
          return;
        case "bool":
          w.bit(t.v ? 1 : 0);
          return;
        case "data":
          w.byteString(encodePlutusData(t.v));
          return;
      }
    }
  }
}

/** The flat encoding of a program (version 1.0.0 for V1 / V2, 1.1.0 for V3) with the given body. */
export function flatProgram(body: Term, version: [number, number, number] = [1, 0, 0]): Uint8Array {
  const w = new Bits();
  for (const n of version) w.natural(BigInt(n));
  writeTerm(w, body);
  return w.finish();
}

/** Version header Plutus V3 programs carry. */
export const V3_VERSION: [number, number, number] = [1, 1, 0];
