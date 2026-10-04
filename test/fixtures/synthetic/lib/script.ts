// Scripts as the ledger sees them: native (timelock / multisig) scripts and Plutus V1 / V2 / V3 scripts.
//
// A Plutus script is kept as the bytes the ledger hashes and the witness set carries inside a CBOR byte string:
// the CBOR-wrapped flat program ("single wrapped", what Aiken's `compiledCode` is, e.g. `59052d 010000..`).
// Hash = blake2b-224(language tag || those bytes). `plutusFromFlat` wraps raw flat bytes for you.

import { blake2b224 } from "./blake2b.js";
import { bytesToHex, concat, toBytes } from "./bytes.js";
import { array, bytes as cbytes, encode, int, uint, type Cbor } from "./cbor.js";

export type PlutusVersion = 1 | 2 | 3;

export type NativeScript =
  | { type: "sig"; keyHash: string | Uint8Array }
  | { type: "all"; scripts: NativeScript[] }
  | { type: "any"; scripts: NativeScript[] }
  | { type: "atLeast"; n: number; scripts: NativeScript[] }
  | { type: "after"; slot: bigint | number }
  | { type: "before"; slot: bigint | number };

export interface NativeScriptWitness {
  kind: "native";
  script: NativeScript;
}

export interface PlutusScript {
  kind: "plutus";
  version: PlutusVersion;
  /** Single-wrapped script bytes (CBOR byte string around the flat encoding). */
  bytes: Uint8Array;
}

export type Script = NativeScriptWitness | PlutusScript;

export const native = (script: NativeScript): NativeScriptWitness => ({ kind: "native", script });

/** A Plutus script from the single-wrapped hex (or bytes). */
export function plutus(version: PlutusVersion, singleWrapped: string | Uint8Array): PlutusScript {
  return { kind: "plutus", version, bytes: toBytes(singleWrapped) };
}

/** A Plutus script from raw flat bytes: wraps them once in a CBOR byte string. */
export function plutusFromFlat(version: PlutusVersion, flat: string | Uint8Array): PlutusScript {
  return { kind: "plutus", version, bytes: encode(cbytes(toBytes(flat))) };
}

export function nativeScriptCbor(s: NativeScript): Cbor {
  switch (s.type) {
    case "sig":
      return array([uint(0), cbytes(s.keyHash)]);
    case "all":
      return array([uint(1), array(s.scripts.map(nativeScriptCbor))]);
    case "any":
      return array([uint(2), array(s.scripts.map(nativeScriptCbor))]);
    case "atLeast":
      return array([uint(3), int(s.n), array(s.scripts.map(nativeScriptCbor))]);
    case "after":
      return array([uint(4), uint(s.slot)]);
    case "before":
      return array([uint(5), uint(s.slot)]);
  }
}

export function nativeScriptBytes(s: NativeScript): Uint8Array {
  return encode(nativeScriptCbor(s));
}

/** `ScriptAll` nested `depth` levels deep around `leaf` (definite lengths, built without recursion): a deep native script. */
export function deepNativeScriptBytes(depth: number, leaf: NativeScript): Uint8Array {
  const unit = Uint8Array.of(0x82, 0x01, 0x81); // [1, [ ... ]]
  const leafBytes = nativeScriptBytes(leaf);
  const out = new Uint8Array(unit.length * depth + leafBytes.length);
  for (let i = 0; i < depth; i++) out.set(unit, i * unit.length);
  out.set(leafBytes, unit.length * depth);
  return out;
}

export const languageTag = (s: Script): number => (s.kind === "native" ? 0 : s.version);

/** The bytes the hash covers after the tag: the CBOR of a native script, the single-wrapped bytes of a Plutus one. */
export function scriptBody(s: Script): Uint8Array {
  return s.kind === "native" ? nativeScriptBytes(s.script) : s.bytes;
}

export function scriptHashBytes(s: Script): Uint8Array {
  return blake2b224(concat([languageTag(s)], scriptBody(s)));
}

export function scriptHash(s: Script): string {
  return bytesToHex(scriptHashBytes(s));
}

/** Hash of a native script, or of raw script bytes under a language tag (0 native, 1..3 Plutus). */
export function hashScriptBytes(tagByte: number, body: Uint8Array | string): string {
  return bytesToHex(blake2b224(concat([tagByte], toBytes(body))));
}

/** `script = [0, native_script] / [1, plutus_v1_script] / [2, plutus_v2_script] / [3, plutus_v3_script]` */
export function scriptCbor(s: Script): Cbor {
  return s.kind === "native" ? array([uint(0), nativeScriptCbor(s.script)]) : array([uint(s.version), cbytes(s.bytes)]);
}

/** Size the reference-script fee counts: the script bytes for Plutus, the CBOR of a native script. */
export function scriptSize(s: Script): number {
  return scriptBody(s).length;
}

/** The kind names tools use: `native`, `plutusV1`, `plutusV2`, `plutusV3`. */
export function scriptTypeName(s: Script): "native" | "plutusV1" | "plutusV2" | "plutusV3" {
  return s.kind === "native" ? "native" : (`plutusV${s.version}` as "plutusV1" | "plutusV2" | "plutusV3");
}
