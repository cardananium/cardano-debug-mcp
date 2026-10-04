// TxStore: everything the server knows about one loaded transaction, keyed by the deterministic
// handle `tx_<network>_<first 12 hex of the tx hash>`. Bounded LRU (32) with an idle TTL (2 h).
// After a restart an unknown handle is rebuilt from the disk cache (the bundle the chain layer wrote,
// else the fetched tx row) by the chain layer's recall hook; `lookupTxRecord` in tx/record.ts.

import type { ExtractedHashes } from "@cardananium/cquisitor-lib";

import type { Network } from "../config.js";
import type { EvalRedeemerResultWire, NecessaryInputData, ValidationResultWire } from "../lib.js";
import type { Purpose } from "../vocab/purpose.js";

export const TX_ID_PATTERN = /^tx_(mainnet|preprod|preview)_([0-9a-f]{12})$/;

export function makeTxId(network: Network, txHash: string): string {
  return `tx_${network}_${txHash.toLowerCase().slice(0, 12)}`;
}

/**
 * The canonical handle of what a caller typed: trimmed, lower-cased, and `tx_<net>_<full 64-hex hash>` cut to
 * the 12-hex handle. Anything that is not handle-shaped comes back trimmed and otherwise untouched.
 */
export function normalizeTxId(text: string): string {
  const trimmed = text.trim();
  const m = /^tx_(mainnet|preprod|preview)_([0-9a-f]{12}(?:[0-9a-f]{52})?)$/i.exec(trimmed);
  return m ? `tx_${m[1]!.toLowerCase()}_${m[2]!.toLowerCase().slice(0, 12)}` : trimmed;
}

/** A 64-hex transaction hash (what the caller typed where a `tx_id` handle or transaction bytes belong). */
export function isTxHash(text: string): boolean {
  return /^(0x)?[0-9a-f]{64}$/i.test(text.trim());
}

export function parseTxId(txId: string): { network: Network; hashPrefix: string } | undefined {
  const match = TX_ID_PATTERN.exec(normalizeTxId(txId));
  if (!match) return undefined;
  return { network: match[1] as Network, hashPrefix: match[2]! };
}

export type PlutusVersionOrNative = "V1" | "V2" | "V3" | "native";

/** One redeemer of the transaction and what it points at (from the decoded tx alone). */
export interface RedeemerTarget {
  /** Canonical `<purpose>:<index>`. */
  ref: string;
  purpose: Purpose;
  index: number;
  /** Position in the witness-set redeemer array. */
  witness_index: number;
  /** `input <hash>#<ix>` | `policy <hash>` | `stake <bech32>` | `cert #n` | `vote <voter>` | `proposal #n`. */
  target: string;
  /** Known without chain context for mint / withdraw / (script) cert; spend needs the resolved input. */
  script_hash?: string;
  plutus_version?: PlutusVersionOrNative;
  ex_units: { mem: string; steps: string };
}

/** One script the transaction carries or references, from the decoded tx alone. */
export interface ScriptSummary {
  script_hash: string;
  plutus_version: PlutusVersionOrNative;
  /** `witness` | `reference <tx>#<ix>` (output of THIS tx carrying it) | `output <n>` */
  source: string;
  size_bytes?: number;
  /** Hex of the script bytes when carried by this tx (witness or inline). Never inlined in tool output. */
  hex?: string;
}

/**
 * Where a transaction sits on chain (known when it was fetched by hash). A context built for an
 * on-chain tx is reconstructed at this point: inclusion slot, that epoch's parameters, its own
 * inputs unspent.
 */
export interface OnChainInfo {
  /** Inclusion slot, decimal string. */
  slot: string;
  epoch: number;
  block_height: number | null;
  block_hash?: string;
  /** The ledger's is_valid for the tx (false = phase 2 failed on chain and the collateral was taken); null when unknown. */
  is_valid: boolean | null;
  /** Where the facts come from (`koios tx_cbor row`, `blockfrost /txs`, `bundle`). */
  source: string;
  /**
   * Content key (`bytesKey`) of the exact bytes the ledger included. A record of the same body with
   * other bytes (witnesses, redeemers, ex-units) replays at this inclusion point too, but the ledger
   * never judged those bytes, so its verdict (accepted / is_valid) does not carry over.
   */
  tx_bytes?: string;
}

export interface StoredValidation {
  /** ValidationResult with the byte-heavy fields of every EvalRedeemerResult moved to `redeemers`. */
  result: Omit<ValidationResultWire, "eval_redeemer_results">;
  /** Full EvalRedeemerResult per redeemer (incl. script_context / bytes / logs), keyed by canonical ref. */
  redeemers: Map<string, EvalRedeemerResultWire>;
  /** When the validation ran. */
  at: number;
  /** Wall-clock the lib took. */
  elapsedMs: number;
  /** Which phases ran. */
  phases: "both" | "phase1";
}

export interface TxRecord {
  txId: string;
  txHash: string;
  network: Network;
  /** Raw transaction CBOR hex. */
  txHex: string;
  sizeBytes: number;
  /** Where the bytes came from. */
  source: "cbor" | "provider" | "bundle" | "cache";
  /** Set when the provider says the tx is already on chain (tx_load by tx_hash, or a bundle that recorded it). */
  onChain?: OnChainInfo;
  createdAt: number;
  lastUsedAt: number;

  /** CSL-style JSON of `decode_specific_type(txHex, 'Transaction')`, wire-normalised (`{transaction_hash, transaction: {body, witness_set, is_valid, auxiliary_data}}`). */
  decoded: DecodedTransaction;
  hashes: ExtractedHashes;
  redeemerTargets: RedeemerTarget[];
  scripts: ScriptSummary[];

  // ---- filled by the chain layer (tx_load / tx_validate) ----
  protocolMajor?: number;
  /** Chain tip slot at load time, decimal string. */
  slot?: string;
  necessary?: NecessaryInputData;
  /** ValidationInputContext exactly as handed to `validate_transaction_js` (bigint-preserving object form). */
  validationContext?: Record<string, unknown>;
  /** Provider rows (Koios/Blockfrost utxo_info, epoch params, …) as fetched, for bundle export. */
  providerRows?: Record<string, unknown>;
  /** `<hash>#<ix>` of inputs the provider could not resolve. */
  missingUtxos?: string[];
  providerWarnings?: string[];
  defaultsApplied?: string[];
  /** Where the bundle was written on disk, when it was. */
  bundlePath?: string;
  validation?: StoredValidation;
  /** Free slot for other modules (engine parts cache, decompile status, …). */
  extra: Record<string, unknown>;
}

/** The decoded transaction; shapes are the CSL JSON the lib emits, kept loose on purpose. */
export interface DecodedTransaction {
  transaction_hash: string;
  transaction: {
    body: Record<string, unknown>;
    witness_set: Record<string, unknown>;
    is_valid: boolean;
    auxiliary_data: Record<string, unknown> | null;
  };
  [key: string]: unknown;
}

export interface TxStoreOptions {
  /** Max records; the least recently used is evicted beyond it. Default 32. */
  max?: number;
  /** Idle TTL. Default 2 h. */
  ttlMs?: number;
  now?: () => number;
  onEvict?: (record: TxRecord, reason: "lru" | "ttl" | "explicit") => void;
}

export class TxStore {
  private readonly records = new Map<string, TxRecord>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onEvict: TxStoreOptions["onEvict"];

  constructor(options: TxStoreOptions = {}) {
    this.max = options.max ?? 32;
    this.ttlMs = options.ttlMs ?? 2 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.onEvict = options.onEvict;
  }

  get size(): number {
    return this.records.size;
  }

  /** Insert or replace. Marks the record used; evicts LRU records beyond `max`. Returns the stored record. */
  put(record: TxRecord): TxRecord {
    record.lastUsedAt = this.now();
    // Re-insert so Map order == recency.
    this.records.delete(record.txId);
    this.records.set(record.txId, record);
    while (this.records.size > this.max) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      const victim = this.records.get(oldest)!;
      this.records.delete(oldest);
      this.onEvict?.(victim, "lru");
    }
    return record;
  }

  /** Fetch and mark used. Expired records are dropped and reported as missing. */
  get(txId: string): TxRecord | undefined {
    const record = this.records.get(txId);
    if (!record) return undefined;
    if (this.isExpired(record)) {
      this.records.delete(txId);
      this.onEvict?.(record, "ttl");
      return undefined;
    }
    this.touch(txId);
    return record;
  }

  /** Fetch without touching recency (expired records still count as missing). */
  peek(txId: string): TxRecord | undefined {
    const record = this.records.get(txId);
    if (!record || this.isExpired(record)) return undefined;
    return record;
  }

  has(txId: string): boolean {
    return this.peek(txId) !== undefined;
  }

  /** Mark used (moves to MRU). */
  touch(txId: string): boolean {
    const record = this.records.get(txId);
    if (!record) return false;
    record.lastUsedAt = this.now();
    this.records.delete(txId);
    this.records.set(txId, record);
    return true;
  }

  evict(txId: string): boolean {
    const record = this.records.get(txId);
    if (!record) return false;
    this.records.delete(txId);
    this.onEvict?.(record, "explicit");
    return true;
  }

  /** Drop expired records; returns how many. */
  sweep(): number {
    let dropped = 0;
    for (const [id, record] of this.records) {
      if (this.isExpired(record)) {
        this.records.delete(id);
        this.onEvict?.(record, "ttl");
        dropped++;
      }
    }
    return dropped;
  }

  /** Records, most recently used first. */
  list(): TxRecord[] {
    return Array.from(this.records.values()).reverse();
  }

  clear(): void {
    this.records.clear();
  }

  private isExpired(record: TxRecord): boolean {
    return this.now() - record.lastUsedAt > this.ttlMs;
  }
}
