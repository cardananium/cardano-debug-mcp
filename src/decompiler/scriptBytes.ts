// Plutus script bytes arrive in several wrappings and the tools must accept all of them:
//
//   flat    — the flat-encoded UPLC program itself (starts with the version bytes 01 00 00 / 01 01 00)
//   single  — CBOR `bytes(flat)`: the ledger's PlutusBinary; the on-chain script hash is
//             blake2b-224(language tag || single)
//   double  — CBOR `bytes(single)`: the witness-set encoding and cardano-cli's `cborHex`
//   ScriptRef — CBOR `[tag, double]` (tag 1..3 = V1..V3) as carried by reference-script UTxO rows
//   cli envelope — `{"type": "PlutusScriptV2", "cborHex": "<double>"}`
//
// Everything here is pure string/byte work; hashing goes through the lib (see resolve.ts).

import { normalizeBytesInput } from "../tools/_shared.js";

export type PlutusVersion = "V1" | "V2" | "V3";

export type ScriptWrapping = "flat" | "single" | "double" | "script_ref";

export interface NormalizedScript {
  /** CBOR `bytes(flat)` — what the decompiler and the hash want. Lowercase hex. */
  singleHex: string;
  /** The bare flat program. Lowercase hex. */
  flatHex: string;
  /** How the input was wrapped. */
  wrapping: ScriptWrapping;
  /** Version stated by the wrapping itself (ScriptRef tag or cli envelope type), when any. */
  statedVersion?: PlutusVersion;
  /** From the flat header: `(1,1,_)` is V3 for certain; `(1,0,_)` is V1 or V2. */
  headerVersion: "V3" | "V1_or_V2" | "unknown";
  /** Size of the single-wrapped form in bytes. */
  sizeBytes: number;
  /** Input kind reported by `normalizeBytesInput` (hex / base64 / cli_envelope). */
  inputKind: string;
}

export class ScriptBytesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptBytesError";
  }
}

/** Parse one CBOR byte-string header at `offset` (hex offsets). Returns the content span or undefined. */
function cborBytesHeader(hex: string, offset = 0): { contentStart: number; contentLength: number } | undefined {
  if (hex.length < offset + 2) return undefined;
  const initial = Number.parseInt(hex.slice(offset, offset + 2), 16);
  if (Number.isNaN(initial) || initial >> 5 !== 2) return undefined; // major type 2 = byte string
  const info = initial & 0x1f;
  let lengthDigits: number;
  if (info < 24) return { contentStart: offset + 2, contentLength: info * 2 };
  if (info === 24) lengthDigits = 2;
  else if (info === 25) lengthDigits = 4;
  else if (info === 26) lengthDigits = 8;
  else if (info === 27) lengthDigits = 16;
  else return undefined; // indefinite-length byte strings never wrap scripts
  const lengthHex = hex.slice(offset + 2, offset + 2 + lengthDigits);
  if (lengthHex.length < lengthDigits) return undefined;
  const length = Number.parseInt(lengthHex, 16);
  if (!Number.isFinite(length)) return undefined;
  return { contentStart: offset + 2 + lengthDigits, contentLength: length * 2 };
}

/** Unwrap one exact CBOR byte-string layer: the header must cover the whole remainder. */
function peelBytes(hex: string): string | undefined {
  const header = cborBytesHeader(hex);
  if (!header) return undefined;
  if (header.contentStart + header.contentLength !== hex.length) return undefined;
  return hex.slice(header.contentStart);
}

/** CBOR `bytes(hex)` with the shortest length encoding. */
export function wrapCborBytes(hex: string): string {
  const length = hex.length / 2;
  if (length < 24) return (0x40 + length).toString(16).padStart(2, "0") + hex;
  if (length < 0x100) return "58" + length.toString(16).padStart(2, "0") + hex;
  if (length < 0x10000) return "59" + length.toString(16).padStart(4, "0") + hex;
  return "5a" + length.toString(16).padStart(8, "0") + hex;
}

/** Flat programs start with the version naturals; `(1, minor, patch)` with 7-bit naturals fits one byte each here. */
function headerVersionOf(flatHex: string): NormalizedScript["headerVersion"] {
  if (flatHex.length < 6 || flatHex.slice(0, 2) !== "01") return "unknown";
  const minor = flatHex.slice(2, 4);
  if (minor === "01") return "V3";
  if (minor === "00") return "V1_or_V2";
  return "unknown";
}

function looksLikeFlat(hex: string): boolean {
  return headerVersionOf(hex) !== "unknown";
}

const ENVELOPE_TYPES: Record<string, PlutusVersion> = {
  plutusscriptv1: "V1",
  plutusscriptv2: "V2",
  plutusscriptv3: "V3",
};

/**
 * Bring a script input (any wrapping, hex / base64 / cli envelope) to its single-wrapped and flat
 * forms and read what the wrapping says about the Plutus version.
 */
export function normalizeScriptInput(input: string): NormalizedScript {
  let statedVersion: PlutusVersion | undefined;
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    try {
      const envelope = JSON.parse(trimmed) as { type?: unknown; cborHex?: unknown };
      if (typeof envelope.type === "string") statedVersion = ENVELOPE_TYPES[envelope.type.toLowerCase()];
      if (typeof envelope.cborHex !== "string") {
        throw new ScriptBytesError("The JSON envelope has no string `cborHex` field; pass the script hex directly.");
      }
    } catch (error) {
      if (error instanceof ScriptBytesError) throw error;
      throw new ScriptBytesError("The script looks like JSON but is not a cardano-cli text envelope ({\"type\", \"cborHex\"}).");
    }
  }
  const normalized = normalizeBytesInput(input);
  if (normalized.kind !== "hex" && normalized.kind !== "base64" && normalized.kind !== "cli_envelope") {
    throw new ScriptBytesError("The script must be given as hex (0x optional), base64 or a cardano-cli JSON envelope; this input is neither.");
  }
  const hex = normalized.value;
  if (hex.length === 0) throw new ScriptBytesError("The script is empty.");
  const shaped = unwrapScriptHex(hex);
  return { ...shaped, statedVersion: shaped.statedVersion ?? statedVersion, inputKind: normalized.kind };
}

/** Wrapping detection on clean lowercase hex. Exported for tests and for bytes that never came from user text. */
export function unwrapScriptHex(hex: string): Omit<NormalizedScript, "inputKind"> {
  let statedVersion: PlutusVersion | undefined;
  let current = hex.toLowerCase();
  let wrapping: ScriptWrapping;

  // ScriptRef `[tag, bytes]`: 82 0N <bytes>
  const refMatch = /^820([123])/.exec(current);
  if (refMatch && !looksLikeFlat(current)) {
    const inner = peelBytes(current.slice(4));
    if (inner !== undefined) {
      statedVersion = `V${refMatch[1]}` as PlutusVersion;
      const single = looksLikeFlat(inner) ? wrapCborBytes(inner) : inner;
      const flat = looksLikeFlat(inner) ? inner : peelBytes(inner);
      if (flat === undefined || !looksLikeFlat(flat)) {
        throw new ScriptBytesError("The ScriptRef carries bytes that do not decode as a flat UPLC program (a native script cannot be decompiled).");
      }
      return { singleHex: single, flatHex: flat, wrapping: "script_ref", statedVersion, headerVersion: headerVersionOf(flat), sizeBytes: single.length / 2 };
    }
  }

  if (looksLikeFlat(current)) {
    wrapping = "flat";
    return { singleHex: wrapCborBytes(current), flatHex: current, wrapping, headerVersion: headerVersionOf(current), sizeBytes: current.length / 2 + cborHeaderBytes(current.length / 2) };
  }
  const once = peelBytes(current);
  if (once !== undefined && looksLikeFlat(once)) {
    return { singleHex: current, flatHex: once, wrapping: "single", headerVersion: headerVersionOf(once), sizeBytes: current.length / 2 };
  }
  if (once !== undefined) {
    const twice = peelBytes(once);
    if (twice !== undefined && looksLikeFlat(twice)) {
      return { singleHex: once, flatHex: twice, wrapping: "double", headerVersion: headerVersionOf(twice), sizeBytes: once.length / 2 };
    }
  }
  // Accept an unknown-header flat program as a last resort when nothing is wrapped: the decompiler
  // reports the precise decoding error and the header diagnostic itself.
  if (once === undefined) {
    return { singleHex: wrapCborBytes(current), flatHex: current, wrapping: "flat", headerVersion: "unknown", sizeBytes: current.length / 2 + cborHeaderBytes(current.length / 2) };
  }
  const deepest = peelBytes(once) ?? once;
  return { singleHex: once, flatHex: deepest, wrapping: "single", headerVersion: "unknown", sizeBytes: once.length / 2 };
}

function cborHeaderBytes(length: number): number {
  if (length < 24) return 1;
  if (length < 0x100) return 2;
  if (length < 0x10000) return 3;
  return 5;
}

export function isPlutusVersion(value: unknown): value is PlutusVersion {
  return value === "V1" || value === "V2" || value === "V3";
}

/** `V2` / `v2` / `PlutusV2` / `2` / `plutus_v2` → `V2`. */
export function parsePlutusVersion(input: string | number | undefined | null): PlutusVersion | undefined {
  if (input === undefined || input === null) return undefined;
  const text = String(input).trim().toLowerCase().replace(/^plutus[_-]?(script)?[_-]?/, "").replace(/^v/, "");
  if (text === "1") return "V1";
  if (text === "2") return "V2";
  if (text === "3") return "V3";
  return undefined;
}

/** Language tag used when hashing: 1 / 2 / 3. */
export function plutusVersionNumber(version: PlutusVersion): 1 | 2 | 3 {
  return version === "V1" ? 1 : version === "V2" ? 2 : 3;
}
