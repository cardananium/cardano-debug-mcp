// Protocol parameter sets (protocol constants: fee coefficients, limits, prices, cost models, governance thresholds).
// `pv10` / `pv11` hold the parameters in cquisitor-lib's ProtocolParameters shape plus the matching Koios `epoch_params`
// row fields (without the epoch number, nonce and block hash, which every scenario sets itself).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ProtocolParameters } from "@cardananium/cquisitor-lib";

export type ParamSetName = "pv10" | "pv11";

export interface ParamSet {
  name: ParamSetName;
  protocolParameters: ProtocolParameters;
  /** Koios epoch_params row fields (no epoch_no / nonce / block_hash / extra_entropy). */
  koiosEpochParams: Record<string, unknown>;
}

const cache = new Map<ParamSetName, ParamSet>();

export function paramSet(name: ParamSetName): ParamSet {
  let set = cache.get(name);
  if (!set) {
    const file = fileURLToPath(new URL(`../params/${name}.json`, import.meta.url));
    const json = JSON.parse(readFileSync(file, "utf8")) as { protocolParameters: ProtocolParameters; koiosEpochParams: Record<string, unknown> };
    set = { name, protocolParameters: json.protocolParameters, koiosEpochParams: json.koiosEpochParams };
    cache.set(name, set);
  }
  return {
    name: set.name,
    protocolParameters: structuredClone(set.protocolParameters),
    koiosEpochParams: structuredClone(set.koiosEpochParams),
  };
}

/** Parameters of a set (a fresh copy: scenarios may tweak fields). */
export const protocolParameters = (name: ParamSetName): ProtocolParameters => paramSet(name).protocolParameters;
