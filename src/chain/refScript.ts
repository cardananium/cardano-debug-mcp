// Reference scripts: one canonical internal form and the derived forms every consumer needs.
//
//   inner        Plutus: the single CBOR byte string around the flat program (`59xxxx 01 …`, the
//                `cborHex` of a .plutus file, what the ledger hashes as blake2b-224(tag ‖ inner)).
//                Native: the native script CBOR as-is.
//   lib form     `82 0<tag> bstr(inner)` for Plutus, `82 00 <native>` for native — what
//                ValidationInputContext.utxoSet[].utxo.output.scriptRef expects.
//   engine form  `inner` (the de-uplc PartsConfig `script`).
//
// Provider rows carry `inner` directly (Koios `reference_script.bytes`); `get_ref_script_bytes`
// answers `bstr(inner)` (one layer outside), and raw flat programs (no byte-string wrapper at all)
// turn up in hand-written contexts. `canonicalizeRefScript` folds all of those to `inner` by
// structure alone; `verifyRefScript` then checks the content against the provider's hash through
// the library (which is wrapping-lenient but version-sensitive), trying the alternative wrapping
// once before marking the row `script_unverified`.

import { encodeCborBytes } from "@cardananium/cquisitor-lib/chain/scriptRefFormat";

import type { LibApi } from "../lib.js";

export type PlutusVersion = "V1" | "V2" | "V3";
export type RefScriptKind = "plutus" | "native";

export interface RefScriptType {
  kind: RefScriptKind;
  plutus_version?: PlutusVersion;
  /** ScriptRef array tag: 0 native, 1..3 Plutus V1..V3. */
  tag: 0 | 1 | 2 | 3;
}

/** Read a provider / de-uplc / lib script type label: plutusv2, PlutusV2, V2, native, timelock, multisig, NativeScript. */
export function refScriptType(label: string | undefined | null): RefScriptType | undefined {
  if (!label) return undefined;
  const n = label.trim().toLowerCase().replace(/[\s_-]/g, "");
  if (n === "native" || n === "nativescript" || n === "timelock" || n === "multisig") return { kind: "native", tag: 0 };
  const m = /^(?:plutus)?(?:script)?v?([123])$/.exec(n);
  if (m) {
    const v = Number(m[1]) as 1 | 2 | 3;
    return { kind: "plutus", plutus_version: `V${v}` as PlutusVersion, tag: v };
  }
  return undefined;
}

export interface BstrHeader {
  /** Header length in bytes. */
  headerBytes: number;
  /** Payload length in bytes. */
  payloadBytes: number;
}

/** Parse a CBOR byte-string header (major type 2, definite length) at the start of `hex`. */
export function readBstrHeader(hex: string): BstrHeader | undefined {
  if (hex.length < 2) return undefined;
  const initial = Number.parseInt(hex.slice(0, 2), 16);
  if (Number.isNaN(initial) || initial >> 5 !== 2) return undefined;
  const info = initial & 0x1f;
  if (info < 24) return { headerBytes: 1, payloadBytes: info };
  const extra = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
  if (extra === 0) return undefined; // indefinite or reserved
  if (hex.length < 2 + extra * 2) return undefined;
  const payloadBytes = Number.parseInt(hex.slice(2, 2 + extra * 2), 16);
  if (!Number.isSafeInteger(payloadBytes)) return undefined;
  return { headerBytes: 1 + extra, payloadBytes };
}

/** True when `hex` is exactly one definite byte string (header + payload, nothing else). */
export function isWholeBstr(hex: string): boolean {
  const header = readBstrHeader(hex);
  return header !== undefined && (header.headerBytes + header.payloadBytes) * 2 === hex.length;
}

/** Payload of a whole byte string, or undefined. */
export function bstrPayload(hex: string): string | undefined {
  const header = readBstrHeader(hex);
  if (!header || (header.headerBytes + header.payloadBytes) * 2 !== hex.length) return undefined;
  return hex.slice(header.headerBytes * 2);
}

export interface CanonicalRefScript extends RefScriptType {
  inner: string;
  lib_form: string;
  engine_form: string;
  /** How the input related to `inner`: 0 = it was inner, n>0 = n byte-string layers removed, -1 = raw flat wrapped once. */
  layers_removed: number;
}

/**
 * Fold any Plutus wrapping to `inner` (= bstr(flat)): strip byte-string layers while the payload is
 * itself a whole byte string; a raw flat program (no wrapper) is wrapped once. Native scripts are
 * taken as-is. Pure.
 */
export function canonicalizeRefScript(bytesHex: string, type: RefScriptType): CanonicalRefScript {
  const hex = bytesHex.replace(/\s+/g, "").toLowerCase();
  if (type.kind === "native") {
    return { ...type, inner: hex, lib_form: `8200${hex}`, engine_form: hex, layers_removed: 0 };
  }
  let inner = hex;
  let layers = 0;
  if (!isWholeBstr(inner)) {
    // Raw flat program: wrap once.
    inner = encodeCborBytes(inner);
    layers = -1;
  } else {
    // Strip while the payload is itself a whole byte string (bstr(bstr(flat)) -> bstr(flat)).
    for (;;) {
      const payload = bstrPayload(inner);
      if (payload === undefined || !isWholeBstr(payload)) break;
      inner = payload;
      layers++;
    }
  }
  const tagHex = type.tag.toString(16).padStart(2, "0");
  return {
    ...type,
    inner,
    lib_form: `82${tagHex}${encodeCborBytes(inner)}`,
    engine_form: inner,
    layers_removed: layers,
  };
}

/** `inner` from a lib-form `82 0X bstr(inner)` (or `82 00 native`); undefined when not lib form. */
export function innerFromLibForm(libForm: string): { type: RefScriptType; inner: string } | undefined {
  const hex = libForm.toLowerCase();
  if (!hex.startsWith("82") || hex.length < 6) return undefined;
  const tag = Number.parseInt(hex.slice(2, 4), 16);
  if (tag === 0) return { type: { kind: "native", tag: 0 }, inner: hex.slice(4) };
  if (tag < 1 || tag > 3) return undefined;
  const payload = bstrPayload(hex.slice(4));
  if (payload === undefined) return undefined;
  return { type: { kind: "plutus", plutus_version: `V${tag}` as PlutusVersion, tag: tag as 1 | 2 | 3 }, inner: payload };
}

export interface RefScriptVerification {
  verified: boolean;
  /** Hash the library computed for the canonical inner (28-byte hex). */
  computed_hash?: string;
  /** Hash the provider row declared. */
  expected_hash?: string;
  /** When the canonical form mismatched, the alternative wrapping that was tried and whether it matched. */
  alternative?: { form: string; matched: boolean };
  error?: string;
}

/** Script hash of `inner` (Plutus with `plutus_version`, or native) through the library. */
export async function scriptHashOf(lib: LibApi, inner: string, type: RefScriptType): Promise<string> {
  if (type.kind === "native") {
    const decoded = await lib.decodeType<{ script_hash?: string }>(inner, "NativeScript", {});
    if (!decoded?.script_hash) throw new Error("NativeScript decoded without a script_hash");
    return decoded.script_hash.toLowerCase();
  }
  const version = Number(type.plutus_version!.slice(1));
  const decoded = await lib.decodeType<{ script_hash?: string }>(inner, "PlutusScript", { plutus_script_version: version });
  if (!decoded?.script_hash) throw new Error("PlutusScript decoded without a script_hash");
  return decoded.script_hash.toLowerCase();
}

/**
 * Check blake2b-224(tag ‖ inner) == `expectedHash`. On a mismatch the alternative wrapping (the
 * flat payload wrapped once more, or one layer less) is tried; if neither matches the row is
 * `verified: false` and must be surfaced as `script_unverified`, never fed silently.
 */
export async function verifyRefScript(lib: LibApi, canonical: CanonicalRefScript, expectedHash: string | undefined | null): Promise<RefScriptVerification> {
  if (!expectedHash) return { verified: false, error: "provider row carries no reference_script.hash" };
  const expected = expectedHash.toLowerCase();
  try {
    const computed = await scriptHashOf(lib, canonical.inner, canonical);
    if (computed === expected) return { verified: true, computed_hash: computed, expected_hash: expected };
    if (canonical.kind === "plutus") {
      const alternative = canonical.layers_removed === -1 ? bstrPayload(canonical.inner) ?? canonical.inner : encodeCborBytes(canonical.inner);
      try {
        const altHash = await scriptHashOf(lib, alternative, canonical);
        return { verified: altHash === expected, computed_hash: computed, expected_hash: expected, alternative: { form: alternative.slice(0, 16) + "…", matched: altHash === expected } };
      } catch (error) {
        return { verified: false, computed_hash: computed, expected_hash: expected, alternative: { form: alternative.slice(0, 16) + "…", matched: false }, error: messageOf(error) };
      }
    }
    return { verified: false, computed_hash: computed, expected_hash: expected };
  } catch (error) {
    return { verified: false, expected_hash: expected, error: messageOf(error) };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
