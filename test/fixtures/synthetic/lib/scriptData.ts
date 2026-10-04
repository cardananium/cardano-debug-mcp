// script_data_hash (Conway): blake2b-256 of  redeemers || datums || language views, per the ledger CDDL notes.
//   - redeemers / datums are the exact bytes of the witness-set fields (array or map form, tag 258 or not);
//   - no datums: the middle part is empty;
//   - no redeemers but datums: `a0 || datums || a0`;
//   - language views: a map {language -> cost model}, canonical: PlutusV2 (key 1) and PlutusV3 (key 2) first as definite lists,
//     PlutusV1 last with key `4100` (the uint 0 wrapped in a byte string) and the cost model as an indefinite list wrapped in a byte string.

import type { ProtocolParameters } from "@cardananium/cquisitor-lib";

import { blake2b256 } from "./blake2b.js";
import { bytesToHex, concat } from "./bytes.js";
import { array, bytes as cbytes, encode, int, map as cmap, sortedMap, uint, type Cbor } from "./cbor.js";
import type { PlutusVersion } from "./script.js";

export function costModelOf(params: ProtocolParameters, version: PlutusVersion): number[] {
  const models = params.costModels;
  const model = version === 1 ? models.plutusV1 : version === 2 ? models.plutusV2 : models.plutusV3;
  if (!model) throw new Error(`the protocol parameters carry no PlutusV${version} cost model`);
  return model;
}

/** The language-views map for the languages in use (empty map when none). */
export function languageViewsCbor(params: ProtocolParameters, languages: readonly PlutusVersion[]): Cbor {
  const unique = Array.from(new Set(languages));
  const entries: Array<[Cbor, Cbor]> = unique.map((v) => {
    const model = costModelOf(params, v).map((n) => int(n));
    if (v === 1) return [cbytes(encode(uint(0))), cbytes(encode(array(model, { indefinite: true })))] as [Cbor, Cbor];
    return [uint(v - 1), array(model)] as [Cbor, Cbor];
  });
  return sortedMap(entries, "shortlex");
}

export function languageViewsBytes(params: ProtocolParameters, languages: readonly PlutusVersion[]): Uint8Array {
  return encode(languageViewsCbor(params, languages));
}

export interface ScriptDataParts {
  /** Exact bytes of witness-set field 5, when there are redeemers. */
  redeemers?: Uint8Array;
  /** Exact bytes of witness-set field 4, when there are datums. */
  datums?: Uint8Array;
  languages: readonly PlutusVersion[];
}

/** The byte string whose blake2b-256 is the script data hash. */
export function scriptDataPreimage(parts: ScriptDataParts, params: ProtocolParameters): Uint8Array {
  const views = languageViewsBytes(params, parts.languages);
  if (!parts.redeemers) {
    if (!parts.datums) throw new Error("no redeemers and no datums: there is no script data hash");
    return concat(encode(cmap([])), parts.datums, encode(cmap([])));
  }
  return concat(parts.redeemers, parts.datums ?? new Uint8Array(0), views);
}

export function scriptDataHash(parts: ScriptDataParts, params: ProtocolParameters): string {
  return bytesToHex(blake2b256(scriptDataPreimage(parts, params)));
}
