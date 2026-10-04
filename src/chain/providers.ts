// Providers: pick Koios / Blockfrost from config + request, build the core client, and wrap it in a
// caching client that (a) serves rows from the memory/disk cache with the TTLs of the design and
// (b) records every row it saw, so bundles carry the provider evidence (`provider_rows`).

import { BlockfrostClient } from "@cardananium/cquisitor-lib/chain/blockfrostClient";
import { KoiosClient, type BlockchainDataClient, type GovActionRef, type AssetMetadata } from "@cardananium/cquisitor-lib/chain/koiosClient";
import type {
  KoiosAccountInfo,
  KoiosCommitteeInfo,
  KoiosConstitution,
  KoiosDrepInfo,
  KoiosEpochParams,
  KoiosPoolInfo,
  KoiosProposal,
  KoiosTip,
  KoiosTotals,
  KoiosTxCborResponse,
  KoiosUtxoInfo,
} from "@cardananium/cquisitor-lib/chain/koiosTypes";

import type { Network, ServerConfig } from "../config.js";
import { ToolInputError } from "../tools/_shared.js";
import { DiskCache, MemoryTtlCache, TTL } from "./cache.js";
import { ProviderAbortedError, ProviderHttpError, ProviderOfflineError, type ProviderName } from "./http.js";

export interface ProviderSelection {
  provider: ProviderName;
  apiKey: string | undefined;
  warnings: string[];
}

/** Resolve the provider for a call: explicit request > `CARDANO_DEBUG_PROVIDER` > koios. Keys only from env. */
export function selectProvider(config: ServerConfig, network: Network, requested?: string): ProviderSelection {
  const name = requested ?? config.defaultProvider;
  if (name !== "koios" && name !== "blockfrost") throw new ToolInputError(`provider must be koios or blockfrost (got ${JSON.stringify(requested)})`, "provider");
  if (name === "blockfrost") {
    const key = config.blockfrostProjectIds[network];
    if (!key) {
      throw new ToolInputError(`Blockfrost was requested but BLOCKFROST_PROJECT_ID_${network.toUpperCase()} is not set in the server environment; use provider=koios or set the variable.`, "provider");
    }
    return { provider: "blockfrost", apiKey: key, warnings: ["Blockfrost has no constitution endpoint: the guardrails-script check is skipped."] };
  }
  const warnings = config.koiosApiKey ? [] : ["Koios is used anonymously (KOIOS_API_KEY not set): public rate limits apply and large transactions may hit 429; if that is not enough, get a Koios API key (KOIOS_API_KEY) or a Blockfrost project id (BLOCKFROST_PROJECT_ID_<NETWORK> with provider=blockfrost)."];
  return { provider: "koios", apiKey: config.koiosApiKey, warnings };
}

export function createCoreClient(selection: ProviderSelection, network: Network): BlockchainDataClient {
  const core = selection.provider === "blockfrost" ? new BlockfrostClient({ network, apiKey: selection.apiKey! }) : new KoiosClient({ network, apiKey: selection.apiKey });
  return withStatusErrors(core, selection, network);
}

/** `Koios API error: 401 Unauthorized` / `Blockfrost API error: 402 …`: the core clients throw plain Errors for any non-2xx answer. */
export function providerStatusOf(error: unknown): { provider: ProviderName; status: number } | undefined {
  if (!(error instanceof Error)) return undefined;
  const m = /\b(Koios|Blockfrost) API error: (\d{3})\b/i.exec(error.message);
  return m ? { provider: m[1]!.toLowerCase() as ProviderName, status: Number(m[2]) } : undefined;
}

/**
 * The core clients' status errors as `ProviderHttpError`s (with the status, and whether a key was sent),
 * so every layer above sees one error type for "the provider answered no".
 */
function withStatusErrors(client: BlockchainDataClient, selection: ProviderSelection, network: Network): BlockchainDataClient {
  return new Proxy(client, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (typeof member !== "function") return member;
      return async (...args: unknown[]) => {
        try {
          return await (member as (...a: unknown[]) => unknown).apply(target, args);
        } catch (error) {
          if (error instanceof ProviderHttpError || error instanceof ProviderOfflineError || error instanceof ProviderAbortedError) throw error;
          const status = providerStatusOf(error);
          if (!status) throw error;
          throw new ProviderHttpError((error as Error).message, {
            provider: status.provider,
            network,
            url: "",
            status: status.status,
            attempts: 1,
            authenticated: Boolean(selection.apiKey),
            cause: error,
          });
        }
      };
    },
  });
}

/** Disk-cache namespace of a provider row kind: rows of the two providers are never mixed (their shapes differ). */
export function rowNamespace(kind: "tx" | "utxo" | "epoch_params", network: Network, provider: ProviderName): string {
  return `${kind}/${network}/${provider}`;
}

/** Rows as the provider returned them, keyed by endpoint. Everything is JSON (no bigint). */
export interface ProviderRows {
  provider: ProviderName;
  network: Network;
  tip?: KoiosTip;
  totals?: KoiosTotals;
  epoch_params?: KoiosEpochParams;
  utxo_info: KoiosUtxoInfo[];
  account_info: KoiosAccountInfo[];
  pool_info: KoiosPoolInfo[];
  drep_info: KoiosDrepInfo[];
  committee_info?: KoiosCommitteeInfo | null;
  constitution?: KoiosConstitution | null;
  proposals: KoiosProposal[];
  tx_cbor: KoiosTxCborResponse[];
  /** Which endpoints were answered from the cache (memory or disk). */
  cache_hits: string[];
}

export function emptyProviderRows(provider: ProviderName, network: Network): ProviderRows {
  return { provider, network, utxo_info: [], account_info: [], pool_info: [], drep_info: [], proposals: [], tx_cbor: [], cache_hits: [] };
}

export interface CachingClientOptions {
  network: Network;
  provider: ProviderName;
  cache: DiskCache;
  memory: MemoryTtlCache;
  /** Skip cache reads (writes still happen). */
  refresh?: boolean;
}

/**
 * BlockchainDataClient with the design's cache policy in front of a core client. The tip and the
 * latest totals are never cached by this client (a stale slot would move OutsideValidityInterval; the
 * chain service's context cache, which does hold a tip, is short-lived for a transaction that is not on
 * chain); utxo rows 10 min, latest epoch params 1 h, account/pool/drep/committee/constitution/proposal
 * rows 5 min; tx CBOR and the params / totals of a named past epoch forever. Every row is cached under
 * its provider: Koios and Blockfrost rows of one kind have different content.
 */
export class CachingClient implements BlockchainDataClient {
  readonly rows: ProviderRows;
  private readonly inner: BlockchainDataClient;
  private readonly cache: DiskCache;
  private readonly memory: MemoryTtlCache;
  private readonly network: Network;
  private readonly provider: ProviderName;
  private readonly refresh: boolean;

  constructor(inner: BlockchainDataClient, options: CachingClientOptions) {
    this.inner = inner;
    this.cache = options.cache;
    this.memory = options.memory;
    this.network = options.network;
    this.provider = options.provider;
    this.refresh = options.refresh ?? false;
    this.rows = emptyProviderRows(options.provider, options.network);
  }

  // ---- cache plumbing ----

  private async cached<T>(namespace: string, key: string, ttlMs: number): Promise<T | undefined> {
    if (this.refresh) return undefined;
    const memKey = `${namespace}/${key}`;
    const mem = this.memory.get(memKey) as T | undefined;
    if (mem !== undefined) return mem;
    const disk = await this.cache.getJson<T>(namespace, key, ttlMs);
    if (disk !== undefined) this.memory.set(memKey, disk, ttlMs);
    return disk;
  }

  private async store<T>(namespace: string, key: string, ttlMs: number, value: T): Promise<void> {
    this.memory.set(`${namespace}/${key}`, value, ttlMs);
    await this.cache.setJson(namespace, key, value);
  }

  private rowsNs(kind: string): string {
    return `rows/${this.network}/${this.provider}/${kind}`;
  }

  private hit(what: string): void {
    this.rows.cache_hits.push(what);
  }

  /** Per-key rows: serve hits from the cache, fetch the misses in one call, store each row. */
  private async perKey<T>(namespace: string, ttlMs: number, keys: string[], fetch: (misses: string[]) => Promise<T[]>, keyOf: (row: T) => string): Promise<T[]> {
    const out = new Map<string, T>();
    const misses: string[] = [];
    for (const key of keys) {
      const row = await this.cached<T>(namespace, `${key}.json`, ttlMs);
      if (row !== undefined) out.set(key, row);
      else misses.push(key);
    }
    if (out.size > 0) this.hit(`${namespace}:${out.size}/${keys.length}`);
    if (misses.length > 0) {
      const fetched = await fetch(misses);
      for (const row of fetched) {
        const key = keyOf(row);
        out.set(key, row);
        await this.store(namespace, `${key}.json`, ttlMs, row);
      }
    }
    // Preserve request order; rows the provider did not return are simply absent.
    const result: T[] = [];
    for (const key of keys) {
      const row = out.get(key);
      if (row !== undefined) result.push(row);
    }
    return result;
  }

  // ---- BlockchainDataClient ----

  async getTip(): Promise<KoiosTip[]> {
    const tip = await this.inner.getTip();
    this.rows.tip = tip[0];
    return tip;
  }

  async getTotals(epochNo?: number): Promise<KoiosTotals[]> {
    // The totals of a named epoch are history: cached forever. The latest totals are never cached.
    const ns = this.rowsNs("totals");
    const key = `${epochNo}.json`;
    let totals = epochNo === undefined ? undefined : await this.cached<KoiosTotals[]>(ns, key, TTL.forever);
    if (totals) this.hit("totals");
    else {
      totals = await this.inner.getTotals(epochNo);
      if (epochNo !== undefined && totals.length > 0 && Number(totals[0]?.epoch_no) === epochNo) await this.store(ns, key, TTL.forever, totals);
    }
    this.rows.totals = totals[0];
    return totals;
  }

  async getUtxoInfo(utxoRefs: string[]): Promise<KoiosUtxoInfo[]> {
    const unique = Array.from(new Set(utxoRefs.map((r) => r.toLowerCase())));
    const rows = await this.perKey<KoiosUtxoInfo>(
      rowNamespace("utxo", this.network, this.provider),
      TTL.utxoRows,
      unique,
      (misses) => this.inner.getUtxoInfo(misses),
      (row) => `${row.tx_hash.toLowerCase()}#${row.tx_index}`,
    );
    this.rows.utxo_info.push(...rows.filter((r) => !this.rows.utxo_info.some((x) => x.tx_hash === r.tx_hash && x.tx_index === r.tx_index)));
    return rows;
  }

  async getAccountInfo(stakeAddresses: string[]): Promise<KoiosAccountInfo[]> {
    // Koios normalises addresses in its answer, so the request key is remembered per call (one address at a time in the core).
    if (stakeAddresses.length === 1) {
      const key = stakeAddresses[0]!;
      const rows = await this.perKey<KoiosAccountInfo>(this.rowsNs("account_info"), TTL.providerRows, [key], (m) => this.inner.getAccountInfo(m), () => key);
      this.rows.account_info.push(...rows);
      return rows;
    }
    const rows = await this.inner.getAccountInfo(stakeAddresses);
    this.rows.account_info.push(...rows);
    return rows;
  }

  async getPoolInfo(poolIds: string[]): Promise<KoiosPoolInfo[]> {
    const rows = await this.perKey<KoiosPoolInfo>(this.rowsNs("pool_info"), TTL.providerRows, poolIds, (m) => this.inner.getPoolInfo(m), (row) => row.pool_id_bech32);
    this.rows.pool_info.push(...rows);
    return rows;
  }

  async getDrepInfo(drepIds: string[]): Promise<KoiosDrepInfo[]> {
    const rows = await this.perKey<KoiosDrepInfo>(this.rowsNs("drep_info"), TTL.providerRows, drepIds, (m) => this.inner.getDrepInfo(m), (row) => row.drep_id);
    this.rows.drep_info.push(...rows);
    return rows;
  }

  async getCommitteeInfo(): Promise<KoiosCommitteeInfo> {
    const ns = this.rowsNs("committee_info");
    let info = await this.cached<KoiosCommitteeInfo>(ns, "current.json", TTL.providerRows);
    if (info) this.hit("committee_info");
    else {
      info = await this.inner.getCommitteeInfo();
      await this.store(ns, "current.json", TTL.providerRows, info);
    }
    this.rows.committee_info = info;
    return info;
  }

  async getConstitution(): Promise<KoiosConstitution | null> {
    const ns = this.rowsNs("constitution");
    let value = await this.cached<{ constitution: KoiosConstitution | null }>(ns, "current.json", TTL.providerRows);
    if (value) this.hit("constitution");
    else {
      value = { constitution: await this.inner.getConstitution() };
      await this.store(ns, "current.json", TTL.providerRows, value);
    }
    this.rows.constitution = value.constitution;
    return value.constitution;
  }

  async getProposalsByRefs(refs: GovActionRef[]): Promise<KoiosProposal[]> {
    if (refs.length === 0) return [];
    const rows = await this.inner.getProposalsByRefs(refs);
    this.rows.proposals.push(...rows);
    return rows;
  }

  async getLastEnactedProposals(proposalTypes: string[]): Promise<KoiosProposal[]> {
    if (proposalTypes.length === 0) return [];
    const ns = this.rowsNs("last_enacted");
    const key = `${proposalTypes.slice().sort().join(",")}.json`;
    let rows = await this.cached<KoiosProposal[]>(ns, key, TTL.providerRows);
    if (rows) this.hit("last_enacted");
    else {
      rows = await this.inner.getLastEnactedProposals(proposalTypes);
      await this.store(ns, key, TTL.providerRows, rows);
    }
    this.rows.proposals.push(...rows);
    return rows;
  }

  async getEpochParams(epochNo?: number): Promise<KoiosEpochParams[]> {
    const ns = rowNamespace("epoch_params", this.network, this.provider);
    const key = epochNo === undefined ? "latest.json" : `${epochNo}.json`;
    let rows = await this.cached<KoiosEpochParams[]>(ns, key, epochNo === undefined ? TTL.epochParams : TTL.forever);
    if (rows) this.hit("epoch_params");
    else {
      rows = await this.inner.getEpochParams(epochNo);
      if (rows.length > 0) await this.store(ns, key, TTL.epochParams, rows);
    }
    this.rows.epoch_params = rows[0];
    return rows;
  }

  async getTxCbor(txHashes: string[]): Promise<KoiosTxCborResponse[]> {
    const rows = await this.perKey<KoiosTxCborResponse>(
      rowNamespace("tx", this.network, this.provider),
      TTL.forever,
      txHashes.map((h) => h.toLowerCase()),
      (misses) => this.inner.getTxCbor(misses),
      (row) => row.tx_hash.toLowerCase(),
    );
    this.rows.tx_cbor.push(...rows);
    return rows;
  }

  submitTransaction(txHex: string): Promise<string> {
    return this.inner.submitTransaction(txHex);
  }

  getAssetInfo(units: string[]): Promise<AssetMetadata[]> {
    return this.inner.getAssetInfo(units);
  }

  getPoolDatum(unit: string): Promise<unknown | null> {
    return this.inner.getPoolDatum(unit);
  }

  getDatumByHash(hash: string): Promise<unknown | null> {
    return this.inner.getDatumByHash(hash);
  }
}
