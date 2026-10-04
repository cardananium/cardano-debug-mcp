// Read-only views over a TxRecord that tx_inspect, cbor_decode and the resources share:
//  - the integer policy for decoded data trees (PlutusData / metadata / CDDL-shaped values),
//  - Shelley address credentials (payment script hash of a script address),
//  - resolved UTxO rows read from the ValidationInputContext the chain layer attaches,
//  - reference-script inventory derived from those rows.
// Everything here is pure; nothing mutates the record.

import { bech32 } from "bech32";

import { innerFromLibForm } from "../chain/refScript.js";
import type { RedeemerTarget, ScriptSummary, TxRecord, PlutusVersionOrNative } from "../store/txStore.js";

// ---------- integer policy ----------

// `integersAsStrings` lives in ../vocab/json.ts (worker-safe, no address dependencies); re-exported here
// because the tx tools and the resources import the integer policy from this module.
export { integersAsStrings } from "../vocab/json.js";

// ---------- addresses ----------

export interface AddressCredentials {
  /** Shelley header type (high nibble), or 8 for Byron, 14/15 for reward accounts. */
  header_type: number;
  network_id: number;
  payment?: { kind: "key" | "script"; hash: string };
  stake?: { kind: "key" | "script" | "pointer"; hash?: string };
  /** `addr` | `addr_test` | `stake` | `stake_test` | `byron`. */
  prefix: string;
}

/**
 * Credentials of a Shelley bech32 address / reward account from its header byte alone (no lib
 * call). Byron (base58) and undecodable strings answer `undefined`.
 */
export function addressCredentials(address: string): AddressCredentials | undefined {
  let bytes: Buffer;
  let prefix: string;
  try {
    const decoded = bech32.decode(address.toLowerCase(), 200);
    prefix = decoded.prefix;
    bytes = Buffer.from(bech32.fromWords(decoded.words));
  } catch {
    return undefined;
  }
  const header = bytes[0];
  if (header === undefined) return undefined;
  const type = header >> 4;
  const networkId = header & 0x0f;
  const hex = (from: number, len = 28) => (bytes.length >= from + len ? bytes.subarray(from, from + len).toString("hex") : undefined);
  const result: AddressCredentials = { header_type: type, network_id: networkId, prefix };
  switch (type) {
    case 0: // key/key
    case 1: // script/key
    case 2: // key/script
    case 3: {
      // script/script
      const paymentHash = hex(1);
      const stakeHash = hex(29);
      if (paymentHash) result.payment = { kind: type & 1 ? "script" : "key", hash: paymentHash };
      if (stakeHash) result.stake = { kind: type & 2 ? "script" : "key", hash: stakeHash };
      return result;
    }
    case 4: // key/pointer
    case 5: {
      // script/pointer
      const paymentHash = hex(1);
      if (paymentHash) result.payment = { kind: type & 1 ? "script" : "key", hash: paymentHash };
      result.stake = { kind: "pointer" };
      return result;
    }
    case 6: // key/none
    case 7: {
      // script/none
      const paymentHash = hex(1);
      if (paymentHash) result.payment = { kind: type & 1 ? "script" : "key", hash: paymentHash };
      return result;
    }
    case 14: // reward key
    case 15: {
      // reward script
      const stakeHash = hex(1);
      if (stakeHash) result.stake = { kind: type & 1 ? "script" : "key", hash: stakeHash };
      return result;
    }
    default:
      return result;
  }
}

/** Payment script hash of a script address, or undefined for key addresses / non-Shelley strings. */
export function paymentScriptHash(address: string): string | undefined {
  const creds = addressCredentials(address);
  return creds?.payment?.kind === "script" ? creds.payment.hash : undefined;
}

// ---------- resolved UTxOs ----------

export interface ResolvedAsset {
  unit: string;
  quantity: string;
}

/** One resolved UTxO in tool-facing form (all quantities decimal strings). */
export interface ResolvedUtxo {
  /** `<tx hash>#<index>`. */
  utxo: string;
  address: string;
  lovelace?: string;
  assets: ResolvedAsset[];
  datum_hash?: string;
  /** Inline datum as PlutusData CBOR hex (the lib decodes it on demand). */
  inline_datum_hex?: string;
  /** Hash of the reference script the output carries. */
  ref_script_hash?: string;
  /** CSL ScriptRef CBOR hex (`82 0<tag> <bytes>`) when the chain layer fetched the bytes. */
  script_ref_hex?: string;
  ref_script_version?: PlutusVersionOrNative;
  /** Provider said the output is already spent. */
  spent?: boolean;
  payment?: AddressCredentials["payment"];
}

type Json = Record<string, unknown>;
const rec = (value: unknown): Json => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" || typeof value === "bigint" ? String(value) : undefined;

/** Plutus version encoded in a CSL ScriptRef (`[tag, bytes]`; tag 0 native, 1..3 Plutus V1..V3). */
export function scriptRefVersion(scriptRefHex: string | undefined): PlutusVersionOrNative | undefined {
  if (!scriptRefHex || scriptRefHex.length < 4) return undefined;
  const head = scriptRefHex.slice(0, 4).toLowerCase();
  if (!head.startsWith("82")) return undefined;
  switch (head.slice(2)) {
    case "00":
      return "native";
    case "01":
      return "V1";
    case "02":
      return "V2";
    case "03":
      return "V3";
    default:
      return undefined;
  }
}

/**
 * Resolved UTxOs of a record, keyed `<hash>#<ix>`, read from `record.validationContext.utxoSet`
 * (cquisitor-lib ValidationInputContext: `[{utxo: {input: {txHash, outputIndex}, output: {address,
 * amount[], dataHash, plutusData, scriptRef, scriptHash}}, isSpent}]`). Empty when the chain layer
 * has not attached a context yet.
 */
export function resolvedUtxosFromContext(record: Pick<TxRecord, "validationContext">): Map<string, ResolvedUtxo> {
  const map = new Map<string, ResolvedUtxo>();
  for (const entry of arr(record.validationContext?.utxoSet)) {
    const item = rec(entry);
    const utxo = rec(item.utxo);
    const input = rec(utxo.input);
    const output = rec(utxo.output);
    const hash = str(input.txHash)?.toLowerCase();
    const ix = typeof input.outputIndex === "number" ? input.outputIndex : Number.parseInt(String(input.outputIndex ?? ""), 10);
    if (!hash || !Number.isInteger(ix)) continue;
    const amount = arr(output.amount).map((a) => ({ unit: str(rec(a).unit) ?? "", quantity: str(rec(a).quantity) ?? "0" }));
    const address = str(output.address) ?? "";
    const scriptRefHex = str(output.scriptRef) ?? undefined;
    const row: ResolvedUtxo = {
      utxo: `${hash}#${ix}`,
      address,
      lovelace: amount.find((a) => a.unit === "lovelace" || a.unit === "")?.quantity,
      assets: amount.filter((a) => a.unit !== "lovelace" && a.unit !== ""),
      datum_hash: str(output.dataHash) ?? undefined,
      inline_datum_hex: str(output.plutusData) ?? undefined,
      ref_script_hash: str(output.scriptHash)?.toLowerCase() ?? undefined,
      script_ref_hex: scriptRefHex,
      ref_script_version: scriptRefVersion(scriptRefHex),
      spent: item.isSpent === true ? true : undefined,
      payment: addressCredentials(address)?.payment,
    };
    map.set(row.utxo, row);
  }
  return map;
}

/** A script of the inventory as tools show it: a reference script whose language the chain data does not say is "unknown", never a guess. */
export type ViewScript = Omit<ScriptSummary, "plutus_version"> & { plutus_version: PlutusVersionOrNative | "unknown" };

/**
 * Scripts the transaction references through resolved reference inputs / spent inputs, as
 * `ViewScript` rows (`source: 'reference <utxo>'`). Only UTxOs that carry a reference script.
 */
export function referenceScriptsOf(resolved: Map<string, ResolvedUtxo>, inputRefs: readonly string[]): ViewScript[] {
  const rows: ViewScript[] = [];
  for (const key of inputRefs) {
    const utxo = resolved.get(key);
    if (!utxo?.ref_script_hash) continue;
    rows.push({
      script_hash: utxo.ref_script_hash,
      plutus_version: utxo.ref_script_version ?? "unknown",
      source: `reference ${key}`,
      size_bytes: utxo.script_ref_hex ? refScriptSize(utxo.script_ref_hex) : undefined,
    });
  }
  return rows;
}

/**
 * Size of a reference script as every tool reports it (tx_load, tx_redeemer, script_decompile and
 * the ledger's per-byte fee): the inner script bytes, without the `82 0X` script_ref envelope and
 * without the bstr header of the library form. Native scripts have no bstr: envelope only.
 */
export function refScriptSize(scriptRefHex: string): number {
  const parsed = innerFromLibForm(scriptRefHex);
  if (parsed) return parsed.inner.length / 2;
  return Math.max(0, scriptRefHex.length / 2 - 2);
}

/**
 * Redeemer targets with the spend script hashes filled from the resolved inputs (payment
 * credential of the spent UTxO's address), and the Plutus version filled for every purpose whose script
 * hash is known and found in `versionByHash` (witness and resolved reference scripts: a mint / withdraw /
 * publish redeemer backed by a reference script has a version before any validation). Targets that
 * already carry a hash or a version keep it.
 */
export function withSpendScriptHashes(
  targets: readonly RedeemerTarget[],
  sortedInputRefs: readonly string[],
  resolved: Map<string, ResolvedUtxo>,
  versionByHash: ReadonlyMap<string, PlutusVersionOrNative>,
): RedeemerTarget[] {
  return targets.map((target) => {
    if (target.script_hash) {
      const known = target.plutus_version ? undefined : versionByHash.get(target.script_hash);
      return known ? { ...target, plutus_version: known } : target;
    }
    if (target.purpose !== "spend") return target;
    const key = sortedInputRefs[target.index];
    const utxo = key ? resolved.get(key) : undefined;
    const hash = utxo?.payment?.kind === "script" ? utxo.payment.hash : undefined;
    if (!hash) return target;
    const version = versionByHash.get(hash) ?? (utxo?.ref_script_hash === hash ? utxo.ref_script_version : undefined);
    return { ...target, script_hash: hash, ...(version ? { plutus_version: version } : {}) };
  });
}
