// ChainState: what the chain layer knows about one loaded transaction, kept on
// `TxRecord.extra.chain` (typed through the accessors below) and mirrored into the typed
// TxRecord fields the skeleton pre-declared (validationContext, necessary, slot, protocolMajor,
// missingUtxos, providerWarnings, defaultsApplied, providerRows, bundlePath).
//
// Everything debug_open needs is here or on `record.validation`: per redeemer the full
// EvalRedeemerResult (bytes, logs, context) in `record.validation.redeemers`, the exact
// ProtocolParameters the validator used in `state.context.protocolParameters` (`engineParamsOf`
// gives `protocol_version = protocolVersion[0]` and the flat `cost_models` per language), and the
// canonical reference-script bytes per script hash in `state.refScripts`.

import type { ValidationInputContext } from "@cardananium/cquisitor-lib";
import type { FetchedValidationData } from "@cardananium/cquisitor-lib/chain/transactionValidation";

import type { Network } from "../config.js";
import type { NecessaryInputData } from "../lib.js";
import type { OnChainInfo, TxRecord } from "../store/txStore.js";
import { engineParamsOf, type EngineParams } from "./contextCodec.js";
import type { ProviderName } from "./http.js";
import type { ProviderRows } from "./providers.js";
import type { PlutusVersion } from "./refScript.js";

export type { OnChainInfo } from "../store/txStore.js";

export type ContextStatus = "fetched" | "cached" | "bundle" | "unavailable";

export interface RefScriptRecord {
  script_hash: string;
  plutus_version: PlutusVersion | "native";
  /** Canonical inner (bstr(flat) for Plutus, native CBOR for native). Engine form. */
  inner: string;
  /** `82 0X bstr(inner)` — what the validator context carries. */
  lib_form: string;
  /** blake2b-224(tag ‖ inner) matched the provider's hash. */
  verified: boolean;
  /** `provider`: the hash came from the row and was checked; `derived`: computed from the bytes (nothing to check against). */
  hash_source: "provider" | "derived";
  /** Where it was found: `<tx_hash>#<ix>` of the UTxO. */
  utxo: string;
  size_bytes: number;
  note?: string;
}

export interface RedeemerScriptInfo {
  script_hash: string;
  plutus_version: PlutusVersion;
}


export interface ChainState {
  status: ContextStatus;
  network: Network;
  provider?: ProviderName;
  /** Human-readable origin: `koios`, `bundle <path>`, `de-uplc DebuggerContext`, `cquisitor share link`, `disk cache`. */
  origin: string;
  /** When the chain state was captured (ms epoch); null when the source does not say (a DebuggerContext, a share link or bundle without a capture time). */
  capturedAt: number | null;
  /** Set when the context was reconstructed at the tx's inclusion point instead of the current tip. */
  onChain?: OnChainInfo;
  necessary?: NecessaryInputData;
  /** Exact cquisitor-lib shape; bigint fields are bigint. */
  context?: ValidationInputContext;
  /** Core FetchedValidationData (for share links / bundles); absent for imported bundles that carry only the context. */
  fetched?: FetchedValidationData;
  providerRows?: ProviderRows;
  missingUtxos: string[];
  providerWarnings: string[];
  defaultsApplied: string[];
  /** Canonical reference scripts by script hash. */
  refScripts: Record<string, RefScriptRecord>;
  /** Script identity per canonical redeemer ref, computed from the eval results. */
  scriptHashes: Record<string, RedeemerScriptInfo>;
  slot?: bigint;
  protocolMajor?: number;
  /** Set when the last validation attempt overran its budget. */
  timedOut?: { timeout_ms: number; at: number };
  lastError?: string;
}

export function chainStateOf(record: TxRecord): ChainState | undefined {
  const state = record.extra.chain;
  return state && typeof state === "object" ? (state as ChainState) : undefined;
}

/** Attach `state` to the record and mirror it into the typed TxRecord fields. */
export function setChainState(record: TxRecord, state: ChainState): ChainState {
  record.extra.chain = state;
  record.necessary = state.necessary;
  record.validationContext = state.context as unknown as Record<string, unknown> | undefined;
  record.providerRows = state.providerRows as unknown as Record<string, unknown> | undefined;
  record.missingUtxos = state.missingUtxos;
  record.providerWarnings = state.providerWarnings;
  record.defaultsApplied = state.defaultsApplied;
  record.slot = state.slot !== undefined ? state.slot.toString() : undefined;
  record.protocolMajor = state.protocolMajor;
  return state;
}

/** `captured_at` as shown to the model: ISO time, or null when the source carried no capture time. */
export function capturedAtIso(state: Pick<ChainState, "capturedAt">): string | null {
  return state.capturedAt === null || !Number.isFinite(state.capturedAt) ? null : new Date(state.capturedAt).toISOString();
}

/**
 * Give `to` (same body, other bytes: different witnesses) the chain state of `from`. The context
 * depends on the body only; the validation, a timeout marker and the last error belong to the old
 * bytes and are dropped. Spend script hashes resolved from the inputs are carried per ref.
 */
export function carryChainState(from: TxRecord, to: TxRecord): void {
  const state = chainStateOf(from);
  if (!state) return;
  const carried: ChainState = { ...state, missingUtxos: [...state.missingUtxos], providerWarnings: [...state.providerWarnings], defaultsApplied: [...state.defaultsApplied], scriptHashes: { ...state.scriptHashes } };
  delete carried.timedOut;
  delete carried.lastError;
  setChainState(to, carried);
  if (from.onChain && !to.onChain) to.onChain = from.onChain;
  const previous = new Map(from.redeemerTargets.map((t) => [t.ref, t]));
  for (const target of to.redeemerTargets) {
    const old = previous.get(target.ref);
    if (!old) continue;
    if (!target.script_hash && old.script_hash) target.script_hash = old.script_hash;
    if (!target.plutus_version && old.plutus_version) target.plutus_version = old.plutus_version;
  }
  to.validation = undefined;
}

/** A state with nothing in it: no capture time (nothing was captured), every state built from a source overrides the rest. */
export function emptyChainState(network: Network, origin: string): ChainState {
  return {
    status: "unavailable",
    network,
    origin,
    capturedAt: null,
    missingUtxos: [],
    providerWarnings: [],
    defaultsApplied: [],
    refScripts: {},
    scriptHashes: {},
  };
}

/** `protocol_version` + flat cost models for the engine, from the very parameters the validator used. */
export function engineParamsOfRecord(record: TxRecord): EngineParams | undefined {
  const context = chainStateOf(record)?.context;
  return context ? engineParamsOf(context.protocolParameters) : undefined;
}

export function hasCompleteContext(record: TxRecord): boolean {
  const state = chainStateOf(record);
  return Boolean(state?.context) && (state?.missingUtxos.length ?? 0) === 0;
}
