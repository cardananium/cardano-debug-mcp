// ChainService: the chain-data layer behind tx_load / tx_validate / tx_redeemer / tx_add_witnesses /
// bundle_export. Created once per process by `ensureChainService(ctx)` (first tool registration):
// installs the provider fetch policy, opens the disk cache, and attaches itself as
// `ctx.services.chain`. (The library itself — backend, compressor, logger — is configured by
// createAppContext.)

import { createHash } from "node:crypto";

import type { ValidationInputContext } from "@cardananium/cquisitor-lib";

import { log, type Network } from "../config.js";
import type { AppContext } from "../context.js";
import type { LibClient, ValidationResultWire } from "../lib.js";
import { providersOf } from "../providers.js";
import { normalizeTxId, parseTxId, type OnChainInfo, type StoredValidation, type TxRecord } from "../store/txStore.js";
import { buildTxRecord } from "../tx/record.js";
import { ToolInputError } from "../tools/_shared.js";
import { WorkerAbortedError } from "../workers/rpc.js";
import { chainResourceProviders } from "./artifacts.js";
import { encodeBundle, importBundle, importContext, slotNow, type BundleV1, type ImportedContext, type ImportHints } from "./bundle.js";
import { DiskCache, MemoryTtlCache, TTL } from "./cache.js";
import { completeChangedParameters, stringifyForLib } from "./contextCodec.js";
import { fetchLiveContext, fillSpendScriptHashes, type LiveContext } from "./fetchContext.js";
import {
  BLOCKFROST_DEFAULT_BASE_URLS,
  installProviderFetch,
  OfflineContextError,
  ProviderAbortedError,
  providerEndpoints,
  runWithRequestScope,
  type ProviderEndpoints,
  type ProviderName,
} from "./http.js";
import { bytesKey, inclusionFromBlockfrostTx, inclusionFromKoiosRow, parseOnChainInfo, withIncludedBytes } from "./onChain.js";
import { CachingClient, createCoreClient, rowNamespace, selectProvider } from "./providers.js";
import { fetchScriptByHash } from "./scriptLookup.js";
import { capturedAtIso, chainStateOf, emptyChainState, setChainState, type ChainState } from "./state.js";
import { attachValidation, joinValidation, runValidation, type RunValidationOptions } from "./validate.js";

declare module "../context.js" {
  interface AppServices {
    chain?: ChainService;
    /** Rebuild an unknown tx_id from the disk cache (see ChainService.recall). */
    txRecall?: (txId: string) => Promise<TxRecord | undefined>;
  }
}

export interface LoadContextOptions {
  provider?: string;
  refresh?: boolean;
  signal?: AbortSignal;
}

export interface LoadContextResult {
  state: ChainState;
  /** Where the context came from this time. */
  source: "provider" | "cache" | "bundle";
}

export interface ChainStats {
  offline: boolean;
  endpoints: ProviderEndpoints;
  cache_dir: string;
  memory_entries: number;
}

/** Bundle text + where it was written. */
export interface WrittenBundle {
  bundle: BundleV1;
  text: string;
  path: string | undefined;
  size_bytes: number;
}

/** A run (context load / validation) other callers of the same record can wait for instead of starting their own. */
interface Flight<T> {
  promise: Promise<T>;
  /** Started with refresh=true: it satisfies callers that did not ask for one, not the other way round. */
  refresh: boolean;
  /** What else must match for a caller to share the run (provider, timeout, phases). */
  signature: string;
}

/** Fingerprint of a context: the key of the verdict computed on it. */
function contextFingerprint(context: ValidationInputContext): string {
  return createHash("sha256").update(stringifyForLib(context)).digest("hex").slice(0, 16);
}

function isCancellation(error: unknown): boolean {
  return error instanceof ProviderAbortedError || error instanceof WorkerAbortedError;
}

function toSlot(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return BigInt(String(value));
  } catch {
    return undefined;
  }
}

export class ChainService {
  readonly cache: DiskCache;
  readonly memory = new MemoryTtlCache(2048);
  readonly endpoints: ProviderEndpoints;
  readonly offline: boolean;
  private readonly lib: LibClient;
  private readonly ctx: AppContext;
  private readonly loading = new WeakMap<TxRecord, Array<Flight<LoadContextResult>>>();
  private readonly validating = new WeakMap<TxRecord, Array<Flight<StoredValidation>>>();

  constructor(ctx: AppContext) {
    this.ctx = ctx;
    this.lib = ctx.lib;
    this.cache = new DiskCache({ root: ctx.config.cacheDir });
    this.endpoints = providerEndpoints();
    this.offline = Boolean(ctx.config.offline);
    // Leftovers of a write cut short by a hard kill: swept right after start-up, off the start-up path.
    setTimeout(() => this.cache.sweepStaleTmp(), 0).unref();
  }

  /** Share a running load / validation of `record` (same signature), else start `run`; a joined caller outlives the cancellation of the one that started it. */
  private async coalesce<T>(flights: WeakMap<TxRecord, Array<Flight<T>>>, record: TxRecord, signature: string, refresh: boolean, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    for (;;) {
      const running = flights.get(record)?.find((f) => f.signature === signature && (f.refresh || !refresh));
      if (!running) break;
      try {
        return await running.promise;
      } catch (error) {
        // The caller that started it was cancelled; that says nothing about this call.
        if (!isCancellation(error) || signal?.aborted) throw error;
      }
    }
    const flight: Flight<T> = { promise: run(), refresh, signature };
    flights.set(record, [...(flights.get(record) ?? []), flight]);
    try {
      return await flight.promise;
    } finally {
      const rest = (flights.get(record) ?? []).filter((f) => f !== flight);
      if (rest.length > 0) flights.set(record, rest);
      else flights.delete(record);
    }
  }

  // ---------- tx bytes by hash ----------

  /**
   * Transaction CBOR by hash: disk cache (forever) or the provider's tx_cbor endpoint. A tx the
   * provider knows by hash is on chain; `inclusion` says where (Koios rows carry it, Blockfrost needs
   * `/txs/{hash}`), undefined when that lookup failed (`inclusion_error` says why).
   */
  async fetchTxCbor(
    txHash: string,
    network: Network,
    options: LoadContextOptions = {},
  ): Promise<{ txHex: string; source: "cache" | "provider"; provider: ProviderName; inclusion?: OnChainInfo; inclusion_error?: string }> {
    const hash = txHash.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new ToolInputError("tx_hash must be 64 hex characters", "tx_hash");
    const selection = selectProvider(this.ctx.config, network, options.provider);
    const client = new CachingClient(createCoreClient(selection, network), {
      network,
      provider: selection.provider,
      cache: this.cache,
      memory: this.memory,
      refresh: options.refresh,
    });
    const rows = await runWithRequestScope({ signal: options.signal, label: `tx_cbor ${hash.slice(0, 12)}` }, () => client.getTxCbor([hash]));
    const cbor = rows[0]?.cbor;
    if (!cbor) {
      throw new ToolInputError(
        `Transaction ${hash} was not found on ${network} via ${selection.provider}. Check the network (a hash exists on one network only: try mainnet, preprod and preview), or pass tx_cbor instead when the transaction is not on chain yet.`,
        "tx_hash",
      );
    }
    const fromCache = client.rows.cache_hits.some((h) => h.startsWith(`${rowNamespace("tx", network, selection.provider)}:`));
    const out: { txHex: string; source: "cache" | "provider"; provider: ProviderName; inclusion?: OnChainInfo; inclusion_error?: string } = {
      txHex: cbor.toLowerCase(),
      source: fromCache ? "cache" : "provider",
      provider: selection.provider,
    };
    if (selection.provider === "koios") {
      out.inclusion = inclusionFromKoiosRow(rows[0]);
      if (!out.inclusion) out.inclusion_error = "the Koios tx_cbor row carries no epoch_no / absolute_slot";
    } else {
      try {
        out.inclusion = await this.blockfrostInclusion(hash, network, selection.apiKey!, options.signal);
        if (!out.inclusion) out.inclusion_error = "Blockfrost /txs/{hash} gave no slot";
      } catch (error) {
        out.inclusion_error = `Blockfrost /txs/{hash} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    // The inclusion facts are about these exact bytes (the tx row the provider returned).
    if (out.inclusion) out.inclusion = withIncludedBytes(out.inclusion, out.txHex);
    return out;
  }

  /** Blockfrost `/txs/{hash}` -> inclusion facts (cached forever: a block does not move). */
  private async blockfrostInclusion(hash: string, network: Network, apiKey: string, signal?: AbortSignal): Promise<OnChainInfo | undefined> {
    const ns = `inclusion/${network}`;
    const key = `${hash}.json`;
    const cached = parseOnChainInfo(await this.cache.getJson<unknown>(ns, key, TTL.forever));
    if (cached) return cached;
    const response = await runWithRequestScope({ signal, label: `tx ${hash.slice(0, 12)}` }, () =>
      fetch(`${BLOCKFROST_DEFAULT_BASE_URLS[network]}/txs/${hash}`, { headers: { project_id: apiKey } }),
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${response.status}`);
    }
    const info = inclusionFromBlockfrostTx(network, (await response.json()) as Record<string, unknown>);
    if (info) await this.cache.setJson(ns, key, info);
    return info;
  }

  // ---------- chain context ----------

  /** The context depends on the body (tx hash) and on whether it is rebuilt at the inclusion point. */
  private contextKey(record: TxRecord, provider: string): { ns: string; key: string } {
    return { ns: `context/${record.network}`, key: `${record.txHash}.${provider}${record.onChain ? `.at-${record.onChain.slot}` : ""}.json` };
  }

  /**
   * A verdict depends on the whole transaction (witnesses, redeemers, ex-units) AND on the context it was
   * computed on (slot, UTxO states, parameters): keyed by both. The provider / inclusion slot say nothing about
   * which context that was (a bundle, a refetch an hour later), so they are not part of it.
   */
  private validationKey(record: TxRecord): { ns: string; key: string } | undefined {
    const context = chainStateOf(record)?.context;
    if (!context) return undefined;
    return { ns: `validation/${record.network}`, key: `${record.txHash}.${bytesKey(record.txHex)}.${contextFingerprint(context)}.json` };
  }

  /** A context at the current tip goes stale when the slot passes the validity interval (the cached tip then judges it wrongly). */
  private validityCrossed(record: TxRecord, cachedSlot: bigint | undefined): boolean {
    if (cachedSlot === undefined) return false;
    const body = record.decoded.transaction.body;
    const start = toSlot(body.validity_start_interval);
    const end = toSlot(body.ttl);
    const now = slotNow(record.network);
    return (start !== undefined && cachedSlot < start && now >= start) || (end !== undefined && cachedSlot < end && now >= end);
  }

  private async cachedContext(record: TxRecord, ck: { ns: string; key: string }): Promise<LiveContext | undefined> {
    const cached = await this.cache.getJson<LiveContext>(ck.ns, ck.key, record.onChain ? TTL.context : TTL.pendingContext);
    if (!cached) return undefined;
    if (!cached.onChain && this.validityCrossed(record, toSlot(cached.slot))) {
      await this.cache.delete(ck.ns, ck.key);
      return undefined;
    }
    return cached;
  }

  /**
   * Attach a chain context to `record`: the context cache (60 min on chain, 10 min for a pending tx), else the
   * provider (unless offline), else the last bundle written for this tx. Throws when nothing is available.
   * Parallel calls for one record share one run.
   */
  loadContext(record: TxRecord, options: LoadContextOptions = {}): Promise<LoadContextResult> {
    return this.coalesce(this.loading, record, options.provider ?? "", Boolean(options.refresh), options.signal, () => this.loadContextOnce(record, options));
  }

  private async loadContextOnce(record: TxRecord, options: LoadContextOptions): Promise<LoadContextResult> {
    const selection = selectProvider(this.ctx.config, record.network, options.provider);
    const ck = this.contextKey(record, selection.provider);
    if (!options.refresh) {
      const cached = await this.cachedContext(record, ck);
      if (cached) {
        // A context cached before gov-action contexts carried changedParameters gets them from its own proposal rows.
        const { filled } = completeChangedParameters(cached.context, cached.providerRows?.proposals);
        if (filled.length > 0) cached.defaultsApplied = [...cached.defaultsApplied, ...filled];
        const state = this.stateFromLive(record, cached, "cached", `disk cache (${selection.provider}, captured ${new Date(cached.capturedAt).toISOString()}${cached.onChain ? `, at inclusion slot ${cached.onChain.slot}` : ""})`);
        // A cached verdict computed without those names is stale: validate again instead of restoring it.
        if (filled.length === 0) await this.restoreValidation(record);
        return { state, source: "cache" };
      }
    }
    if (this.offline) {
      const bundle = await this.readCachedBundle(record.network, record.txHash);
      if (bundle) {
        const imported = await importContext(this.lib, bundle.text, { network: record.network, path: bundle.path });
        const state = await this.attachImported(record, imported);
        if (!bundle.imported) {
          // The bundle the chain layer wrote for this tx is the disk cache's copy of its live context.
          state.status = "cached";
          state.origin = `disk cache (${imported.origin})`;
          record.source = "cache";
        }
        return { state, source: "bundle" };
      }
      throw new OfflineContextError(
        `CARDANO_DEBUG_OFFLINE is on and no cached context or bundle exists for ${record.txHash} on ${record.network}: load a bundle (tx_load(bundle=<file>)) or start the server without the offline switch.`,
      );
    }
    const live = await fetchLiveContext(
      { lib: this.lib, config: this.ctx.config, cache: this.cache, memory: this.memory, log: (line) => log.debug(this.ctx.config, line) },
      {
        txHex: record.txHex,
        network: record.network,
        provider: options.provider,
        refresh: options.refresh,
        signal: options.signal,
        atInclusion: record.onChain,
        hasProposals: hasEntries(record.decoded.transaction.body.voting_proposals),
      },
    );
    await this.cache.setJson(ck.ns, ck.key, live);
    const state = this.stateFromLive(record, live, "fetched", live.provider);
    if (options.refresh) record.validation = undefined;
    else await this.restoreValidation(record);
    await this.writeBundle(record, true, "auto").catch((error) => log.warn(`bundle not written: ${error instanceof Error ? error.message : String(error)}`));
    return { state, source: "provider" };
  }

  private stateFromLive(record: TxRecord, live: LiveContext, status: ChainState["status"], origin: string): ChainState {
    const state: ChainState = {
      ...emptyChainState(record.network, origin),
      status,
      provider: live.provider,
      capturedAt: live.capturedAt,
      necessary: live.necessary,
      context: live.context,
      fetched: live.fetched,
      providerRows: live.providerRows,
      missingUtxos: live.missingUtxos,
      providerWarnings: live.providerWarnings,
      defaultsApplied: live.defaultsApplied,
      refScripts: live.refScripts,
      slot: live.slot,
      protocolMajor: live.protocolMajor,
      ...(live.onChain ? { onChain: live.onChain } : {}),
    };
    setChainState(record, state);
    fillSpendScriptHashes(record, state);
    if (status === "fetched") record.source = "provider";
    else if (status === "cached") record.source = "cache";
    return state;
  }

  /** Attach an imported (bundle / DebuggerContext / share link) context. */
  async attachImported(record: TxRecord, imported: ImportedContext): Promise<ChainState> {
    const state: ChainState = {
      ...emptyChainState(record.network, imported.origin),
      status: "bundle",
      provider: imported.providerRows?.provider,
      // No capture time in the source (DebuggerContext, a share link or bundle without one): unknown, not "now".
      capturedAt: imported.capturedAt ?? null,
      ...(imported.onChain ? { onChain: imported.onChain } : {}),
      context: imported.context,
      fetched: imported.fetched,
      providerRows: imported.providerRows,
      missingUtxos: imported.missingUtxos,
      providerWarnings: imported.providerWarnings,
      defaultsApplied: imported.defaultsApplied,
      refScripts: imported.refScripts,
      slot: imported.slot,
      protocolMajor: imported.protocolMajor,
    };
    // Missing-UTxO detection against the transaction itself, so an incomplete bundle is reported, not thrown by the library.
    try {
      const necessary = await this.lib.necessaryData(record.txHex, record.network);
      state.necessary = necessary;
      const have = new Set(state.context!.utxoSet.map((u) => `${u.utxo.input.txHash.toLowerCase()}#${u.utxo.input.outputIndex}`));
      for (const ref of necessary.utxos) {
        const key = `${ref.txHash.toLowerCase()}#${ref.outputIndex}`;
        if (!have.has(key) && !state.missingUtxos.includes(key)) state.missingUtxos.push(key);
      }
    } catch (error) {
      state.providerWarnings.push(`could not compute the necessary-data list: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (imported.capturedAt === undefined && !state.defaultsApplied.some((d) => d.startsWith("captured_at=null"))) {
      state.defaultsApplied = [...state.defaultsApplied, "captured_at=null: the source carries no capture time, so the age of this chain state is unknown"];
    }
    setChainState(record, state);
    fillSpendScriptHashes(record, state);
    record.source = "bundle";
    if (imported.onChain && !record.onChain) record.onChain = imported.onChain;
    // A stored verdict belongs to the exact bytes it was computed for (same body, other witnesses = other verdict).
    if (imported.validation && imported.txHex.toLowerCase() === record.txHex.toLowerCase()) await attachValidation(this.lib, record, imported.validation);
    return state;
  }

  /** Import a bundle-like argument straight into a new record (tx_load bundle=…). */
  async loadFromBundleArgument(bundleArg: string, hints: ImportHints): Promise<{ record: TxRecord; imported: ImportedContext }> {
    const imported = await importContext(this.lib, bundleArg, hints);
    const record = await buildTxRecord(this.lib, { tx: imported.txHex, network: imported.network, source: "bundle" });
    if (imported.txHash && imported.txHash !== record.txHash) {
      imported.providerWarnings.push(`bundle.tx_hash ${imported.txHash} does not match the CBOR's hash ${record.txHash}; the CBOR wins`);
    }
    // Sources without a tip pick a slot from the validity interval — recompute now that the body is decoded.
    if (imported.kind === "de_uplc_context" && !hints.validity) {
      const body = record.decoded.transaction.body;
      const start = body.validity_start_interval !== undefined && body.validity_start_interval !== null ? BigInt(String(body.validity_start_interval)) : undefined;
      const end = body.ttl !== undefined && body.ttl !== null ? BigInt(String(body.ttl)) : undefined;
      if (start !== undefined || end !== undefined) {
        const again = await importContext(this.lib, bundleArg, { ...hints, validity: { start, end } });
        return { record: await this.finishImport(record, again), imported: again };
      }
    }
    return { record: await this.finishImport(record, imported), imported };
  }

  private async finishImport(record: TxRecord, imported: ImportedContext): Promise<TxRecord> {
    await this.attachImported(record, imported);
    const existing = this.ctx.txStore.get(record.txId);
    if (existing && existing.txHex === record.txHex) {
      // Keep the handle stable: replace the chain state on the stored record.
      existing.extra.chain = record.extra.chain;
      setChainState(existing, chainStateOf(record)!);
      existing.redeemerTargets = record.redeemerTargets;
      existing.validation = record.validation;
      // The facts that came with the context go with it: the same load as a fresh handle would give.
      existing.onChain = record.onChain;
      existing.source = "bundle";
      this.ctx.txStore.touch(existing.txId);
      await this.writeBundle(existing, true, "auto").catch(() => undefined);
      return existing;
    }
    this.ctx.txStore.put(record);
    await this.writeBundle(record, true, "auto").catch(() => undefined);
    return record;
  }

  // ---------- validation ----------

  /** Run (or reuse) the validation. `refresh` forces a new run. Parallel calls for one record share one run. */
  async validate(record: TxRecord, options: RunValidationOptions & { refresh?: boolean } = {}): Promise<StoredValidation> {
    if (record.validation && !options.refresh) return record.validation;
    return this.coalesce(this.validating, record, `${options.timeoutMs ?? ""}|${options.phases ?? "both"}`, Boolean(options.refresh), options.signal, () => this.validateOnce(record, options));
  }

  private async validateOnce(record: TxRecord, options: RunValidationOptions): Promise<StoredValidation> {
    for (let pass = 0; ; pass++) {
      const context = chainStateOf(record)?.context;
      const stored = await runValidation(this.lib, record, options);
      const now = chainStateOf(record)?.context;
      if (pass === 0 && now !== undefined && now !== context) {
        // A refresh replaced the chain state while the evaluator ran: this verdict belongs to the old context.
        if (record.validation === stored) record.validation = undefined;
        continue;
      }
      // A context imported from a bundle carries its verdict in the bundle; only live contexts get a verdict cache entry.
      const status = chainStateOf(record)?.status;
      const vk = status === "fetched" || status === "cached" ? this.validationKey(record) : undefined;
      if (vk) await this.cache.setJson(vk.ns, vk.key, joinValidation(stored));
      await this.writeBundle(record, true, "auto").catch(() => undefined);
      return stored;
    }
  }

  private async restoreValidation(record: TxRecord): Promise<void> {
    if (record.validation) return;
    const vk = this.validationKey(record);
    if (!vk) return;
    const cached = await this.cache.getJson<ValidationResultWire>(vk.ns, vk.key, TTL.context);
    if (cached && Array.isArray(cached.eval_redeemer_results)) await attachValidation(this.lib, record, cached);
  }

  // ---------- bundles ----------

  buildBundle(record: TxRecord, includeValidation = true): BundleV1 {
    const state = chainStateOf(record);
    if (!state?.context) throw new ToolInputError("The transaction has no chain context; tx_load it with a network (or from a bundle) before exporting.", "tx_id");
    const bundle: BundleV1 = {
      cardano_debug_bundle: 1,
      network: record.network,
      tx_hash: record.txHash,
      tx_cbor: record.txHex,
      captured_at: capturedAtIso(state),
      slot: (state.slot ?? state.context.slot).toString(),
      protocol_major: state.protocolMajor ?? Number(state.context.protocolParameters.protocolVersion[0]),
      validation_input_context: state.context,
      origin: state.origin,
    };
    if (state.providerRows) bundle.provider_rows = state.providerRows;
    if (includeValidation && record.validation) bundle.validation_result = joinValidation(record.validation);
    if (state.missingUtxos.length) bundle.missing_utxos = state.missingUtxos;
    if (state.providerWarnings.length) bundle.provider_warnings = state.providerWarnings;
    if (state.defaultsApplied.length) bundle.defaults_applied = state.defaultsApplied;
    if (Object.keys(state.refScripts).length) bundle.ref_scripts = state.refScripts;
    if (record.onChain) bundle.on_chain = record.onChain;
    return bundle;
  }

  /**
   * Encode and write the bundle of `record` to `bundles/<net>/<hash>.json` (what bundle_export reports); returns
   * the text too. `where: "auto"` is for the writes nobody asked for: a context imported from a bundle /
   * DebuggerContext / share link then goes to `<hash>.imported.json` instead, so it never replaces the copy of the
   * live context that later loads, recalls and the offline fallback serve.
   */
  async writeBundle(record: TxRecord, includeValidation = true, where: "canonical" | "auto" = "canonical"): Promise<WrittenBundle> {
    const bundle = this.buildBundle(record, includeValidation);
    const text = encodeBundle(bundle);
    const imported = where === "auto" && chainStateOf(record)?.status === "bundle";
    const path = await this.cache.setText(`bundles/${record.network}`, `${record.txHash}${imported ? ".imported" : ""}.json`, text);
    if (path !== undefined) record.bundlePath = path; // a failed write keeps the path of an earlier one
    return { bundle, text, path, size_bytes: Buffer.byteLength(text) };
  }

  /** The bundle the cache holds for a tx: the live one first, else the one written for an imported context. */
  async readCachedBundle(network: Network, txHash: string): Promise<{ text: string; imported: boolean; path: string } | undefined> {
    const ns = `bundles/${network}`;
    const hash = txHash.toLowerCase();
    for (const [key, imported] of [[`${hash}.json`, false], [`${hash}.imported.json`, true]] as const) {
      const text = await this.cache.getText(ns, key, TTL.forever);
      if (text !== undefined) return { text, imported, path: this.cache.pathOf(ns, key) };
    }
    return undefined;
  }

  async readBundleFromCache(network: Network, txHash: string): Promise<string | undefined> {
    return (await this.readCachedBundle(network, txHash))?.text;
  }

  // ---------- handles across restarts ----------

  /**
   * Rebuild the record of a tx_id the store does not hold (a restart, an evicted handle) from the
   * disk cache: the bundle the chain layer wrote for it (bytes + context + validation), else the tx
   * row fetched by hash (bytes + inclusion; the context is fetched again on demand). Undefined when
   * the cache knows no such tx (or the 12-hex prefix is ambiguous).
   */
  async recall(txId: string): Promise<TxRecord | undefined> {
    const id = normalizeTxId(txId);
    const parsed = parseTxId(id);
    if (!parsed) return undefined;
    const pending = this.recalling.get(id);
    if (pending) return pending;
    const job = this.recallUncached(parsed.network, parsed.hashPrefix).finally(() => this.recalling.delete(id));
    this.recalling.set(id, job);
    return job;
  }

  private readonly recalling = new Map<string, Promise<TxRecord | undefined>>();

  private async recallUncached(network: Network, prefix: string): Promise<TxRecord | undefined> {
    const hash = await this.findCachedHash(network, prefix);
    if (!hash) return undefined;
    try {
      const bundle = await this.readCachedBundle(network, hash);
      if (bundle) {
        const imported = importBundle(bundle.text, { network, path: bundle.path });
        const record = await buildTxRecord(this.lib, { tx: imported.txHex, network, source: "cache" });
        if (record.txHash !== hash) return undefined;
        const state = await this.attachImported(record, imported);
        state.origin = `disk cache (${imported.origin}), restored after a restart`;
        if (!bundle.imported) {
          state.status = "cached";
          record.source = "cache";
        }
        record.bundlePath = bundle.path;
        this.ctx.txStore.put(record);
        log.info(`chain: restored ${record.txId} from ${record.bundlePath}`);
        return record;
      }
      for (const ns of this.txRowNamespaces(network)) {
        const row = await this.cache.getJson<Record<string, unknown>>(ns, `${hash}.json`, TTL.forever);
        if (!row || typeof row.cbor !== "string") continue;
        const record = await buildTxRecord(this.lib, { tx: row.cbor, network, source: "cache" });
        if (record.txHash !== hash) return undefined;
        // Koios rows carry the slot; for a Blockfrost row it was fetched separately and cached on its own.
        const inclusion = inclusionFromKoiosRow(row) ?? parseOnChainInfo(await this.cache.getJson<unknown>(`inclusion/${network}`, `${hash}.json`, TTL.forever));
        if (inclusion) record.onChain = withIncludedBytes(inclusion, record.txHex);
        this.ctx.txStore.put(record);
        log.info(`chain: restored ${record.txId} (bytes only) from the tx cache`);
        return record;
      }
    } catch (error) {
      log.warn(`chain: could not restore ${network} ${prefix}… from the disk cache: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }

  /** Where tx rows may sit: per provider, and the flat directory older versions wrote (any provider's rows). */
  private txRowNamespaces(network: Network): string[] {
    return [rowNamespace("tx", network, "koios"), rowNamespace("tx", network, "blockfrost"), `tx/${network}`];
  }

  /** The one full tx hash with this 12-hex prefix among the cached bundles / tx rows of `network`. */
  private async findCachedHash(network: Network, prefix: string): Promise<string | undefined> {
    const found = new Set<string>();
    for (const ns of [`bundles/${network}`, ...this.txRowNamespaces(network)]) {
      for (const name of await this.cache.list(ns)) {
        const m = /^([0-9a-f]{64})(?:\.imported)?\.json$/.exec(name);
        if (m && m[1]!.startsWith(prefix)) found.add(m[1]!);
      }
    }
    return found.size === 1 ? Array.from(found)[0] : undefined;
  }

  async stats(): Promise<ChainStats & { disk: Awaited<ReturnType<DiskCache["stats"]>> }> {
    return { offline: this.offline, endpoints: this.endpoints, cache_dir: this.cache.root, memory_entries: this.memory.size, disk: await this.cache.stats() };
  }
}

export { bytesKey } from "./onChain.js";

function hasEntries(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && typeof value === "object" && Object.keys(value as Record<string, unknown>).length > 0;
}

/** Create (once) and return the chain service; safe to call from every tool's `register`. */
export function ensureChainService(ctx: AppContext): ChainService {
  if (ctx.services.chain) return ctx.services.chain;
  const service = new ChainService(ctx);
  const uninstall = installProviderFetch({
    endpoints: service.endpoints,
    offline: service.offline,
    log: (line) => log.info(`chain: ${line}`),
  });
  ctx.onShutdown(() => uninstall());
  ctx.services.chain = service;
  ctx.services.txRecall = (txId: string) => service.recall(txId);
  providersOf(ctx).register(chainResourceProviders(service, ctx));
  // Script bytes by hash for script_decompile {script_hash, network} (decompiler layer hook).
  ctx.services.scriptSource = {
    fetchScriptByHash: (network, hash, options) => fetchScriptByHash(service, ctx, network, hash, options),
  };
  if (service.offline) log.info("chain: offline (CARDANO_DEBUG_OFFLINE) — provider requests are refused; bundles and the disk cache still work");
  return service;
}

export { capturedAtIso, carryChainState, chainStateOf, setChainState, engineParamsOfRecord, hasCompleteContext } from "./state.js";
export type { ChainState, OnChainInfo, RefScriptRecord, RedeemerScriptInfo } from "./state.js";
export { engineParamsOf, normalizeValidationInputContext, stringifyForLib } from "./contextCodec.js";
export type { EngineParams } from "./contextCodec.js";
export { verdictOf, validationSummary, redeemerSummary, exUnitsSummary, refOfEval, SEMANTICS } from "./validate.js";
export type { Verdict } from "./validate.js";
export { encodeBundle, importContext } from "./bundle.js";
export { fetchScriptByHash } from "./scriptLookup.js";
export type { BundleV1, ImportedContext } from "./bundle.js";
