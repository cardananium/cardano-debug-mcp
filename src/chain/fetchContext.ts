// The canonical chain pipeline: get_necessary_data_list_js -> provider rows (through the caching
// client and the core orchestration) -> post-processing that the browser code never had:
//   - missing-UTxO detection BEFORE validation (requested refs vs returned rows);
//   - reference-script canonicalization + hash verification on every row (`script_unverified`);
//   - the silent protocol-parameter defaults surfaced in `defaults_applied`;
//   - spend redeemers get their script hash from the resolved input address;
//   - a tx already on chain is reconstructed at its inclusion point (see onChain.ts).

import type { NecessaryInputData as LibNecessaryInputData, UtxoInputContext, ValidationInputContext } from "@cardananium/cquisitor-lib";
import type { KoiosUtxoInfo } from "@cardananium/cquisitor-lib/chain/koiosTypes";
import { buildValidationContext, fetchValidationData, type FetchedValidationData } from "@cardananium/cquisitor-lib/chain/transactionValidation";

import type { Network, ServerConfig } from "../config.js";
import type { LibApi, NecessaryInputData } from "../lib.js";
import type { OnChainInfo, TxRecord } from "../store/txStore.js";
import { resolvedUtxosFromContext, withSpendScriptHashes } from "../tx/dataView.js";
import { formatInputRef, sortedInputs } from "../tx/record.js";
import type { DiskCache, MemoryTtlCache } from "./cache.js";
import { completeChangedParameters, koiosEpochParamDefaults, normalizeValidationInputContext } from "./contextCodec.js";
import { runWithRequestScope, type ProviderName } from "./http.js";
import { inclusionDefaults, InclusionClient } from "./onChain.js";
import { CachingClient, createCoreClient, selectProvider, type ProviderRows } from "./providers.js";
import { canonicalizeRefScript, innerFromLibForm, refScriptType, scriptHashOf, verifyRefScript, type CanonicalRefScript } from "./refScript.js";
import type { ChainState, RefScriptRecord } from "./state.js";

export interface FetchDeps {
  lib: LibApi;
  config: ServerConfig;
  cache: DiskCache;
  memory: MemoryTtlCache;
  log?: (line: string) => void;
}

export interface FetchArgs {
  txHex: string;
  network: Network;
  provider?: string;
  refresh?: boolean;
  signal?: AbortSignal;
  /** The tx is on chain: build the context as of its inclusion (slot, epoch parameters, own inputs unspent). */
  atInclusion?: OnChainInfo;
  /** The body carries governance proposals (the constitution then matters). */
  hasProposals?: boolean;
}

export interface LiveContext {
  provider: ProviderName;
  necessary: NecessaryInputData;
  fetched: FetchedValidationData;
  context: ValidationInputContext;
  providerRows: ProviderRows;
  missingUtxos: string[];
  providerWarnings: string[];
  defaultsApplied: string[];
  refScripts: Record<string, RefScriptRecord>;
  slot: bigint;
  protocolMajor: number;
  capturedAt: number;
  /** Present when the context was reconstructed at the tx's inclusion point. */
  onChain?: OnChainInfo;
}

/** Fetch everything a validation needs from the provider (cache-aware). Throws provider errors. */
export async function fetchLiveContext(deps: FetchDeps, args: FetchArgs): Promise<LiveContext> {
  const necessary = await deps.lib.necessaryData(args.txHex, args.network, { signal: args.signal });
  const selection = selectProvider(deps.config, args.network, args.provider);
  const client = new CachingClient(createCoreClient(selection, args.network), {
    network: args.network,
    provider: selection.provider,
    cache: deps.cache,
    memory: deps.memory,
    refresh: args.refresh,
  });
  const started = Date.now();
  const source = args.atInclusion ? new InclusionClient(client, args.atInclusion) : client;
  const fetched = await runWithRequestScope({ signal: args.signal, label: `fetch ${args.network}` }, () =>
    fetchValidationData(necessary as unknown as LibNecessaryInputData, args.network, selection.apiKey, selection.provider, source),
  );
  deps.log?.(`context for ${args.network} fetched from ${selection.provider} in ${Date.now() - started} ms (${client.rows.cache_hits.length} cache hits)`);

  const providerWarnings = [...selection.warnings];
  const missingUtxos = missingUtxoRefs(necessary, fetched.utxoSet);
  const refScripts = await applyRefScripts(deps.lib, fetched.utxoSet, client.rows.utxo_info, providerWarnings);
  const defaultsApplied = koiosEpochParamDefaults(client.rows.epoch_params as unknown as Record<string, unknown> | undefined);
  if (args.atInclusion) {
    // Every UTxO the tx consumes or references was unspent when the ledger included it.
    let spentNow = 0;
    for (const entry of fetched.utxoSet) {
      if (entry.isSpent) spentNow++;
      entry.isSpent = false;
    }
    const fallbacks = source instanceof InclusionClient ? source.fallbacks : [];
    defaultsApplied.unshift(...inclusionDefaults(args.atInclusion, selection.provider, necessary, spentNow, fetched.utxoSet.length, args.hasProposals ?? false), ...fallbacks);
  }
  const context = normalizeValidationInputContext(buildValidationContext(fetched, args.network), args.network);
  // The library names a ParameterChange's parameters from the same rows; this only reports a row that names none.
  defaultsApplied.push(...completeChangedParameters(context, client.rows.proposals).unknown);
  return {
    provider: selection.provider,
    necessary,
    fetched,
    context,
    providerRows: client.rows,
    missingUtxos,
    providerWarnings,
    defaultsApplied,
    refScripts,
    slot: fetched.slot,
    protocolMajor: Number(fetched.protocolParameters.protocolVersion[0]),
    capturedAt: Date.now(),
    ...(args.atInclusion ? { onChain: args.atInclusion } : {}),
  };
}

/** `<hash>#<ix>` of every requested UTxO the provider did not return. */
export function missingUtxoRefs(necessary: NecessaryInputData, utxoSet: readonly UtxoInputContext[]): string[] {
  const have = new Set(utxoSet.map((u) => `${u.utxo.input.txHash.toLowerCase()}#${u.utxo.input.outputIndex}`));
  const missing: string[] = [];
  for (const ref of necessary.utxos) {
    const key = `${ref.txHash.toLowerCase()}#${ref.outputIndex}`;
    if (!have.has(key) && !missing.includes(key)) missing.push(key);
  }
  return missing;
}

/**
 * Canonicalise and verify every reference script in `utxoSet`, rewriting `scriptRef` to the
 * canonical lib form and `scriptHash` to the provider's hash. Rows whose hash cannot be matched
 * are kept but reported as `script_unverified` in `warnings`. Returns the scripts by hash.
 */
export async function applyRefScripts(lib: LibApi, utxoSet: UtxoInputContext[], rows: readonly KoiosUtxoInfo[], warnings: string[]): Promise<Record<string, RefScriptRecord>> {
  const byRef = new Map<string, KoiosUtxoInfo>();
  for (const row of rows) byRef.set(`${row.tx_hash.toLowerCase()}#${row.tx_index}`, row);
  const out: Record<string, RefScriptRecord> = {};
  for (const entry of utxoSet) {
    const output = entry.utxo.output;
    const key = `${entry.utxo.input.txHash.toLowerCase()}#${entry.utxo.input.outputIndex}`;
    const row = byRef.get(key);
    const rowScript = row?.reference_script ?? null;
    if (!rowScript && !output.scriptRef) continue;

    let canonical: CanonicalRefScript | undefined;
    const type = refScriptType(rowScript?.type);
    if (rowScript?.bytes && type) {
      canonical = canonicalizeRefScript(rowScript.bytes, type);
    } else if (output.scriptRef) {
      const parsed = innerFromLibForm(output.scriptRef);
      if (parsed) canonical = canonicalizeRefScript(parsed.inner, type ?? parsed.type);
    }
    if (!canonical) {
      warnings.push(`script_unverified: ${key} carries a reference script (${rowScript?.type ?? "unknown type"}) whose bytes could not be read; scripts resolved through it will fail with ScriptNotFound.`);
      continue;
    }
    const expected = rowScript?.hash ?? output.scriptHash ?? undefined;
    let verified = false;
    let hash = expected?.toLowerCase();
    let note: string | undefined;
    const hashSource: "provider" | "derived" = expected ? "provider" : "derived";
    if (expected) {
      const check = await verifyRefScript(lib, canonical, expected);
      verified = check.verified;
      if (!verified) {
        note = `hash mismatch: provider ${expected}, computed ${check.computed_hash ?? "n/a"}${check.alternative ? ` (alternative wrapping ${check.alternative.matched ? "matched" : "did not match"})` : ""}${check.error ? `; ${check.error}` : ""}`;
        warnings.push(`script_unverified: ${key} ${note}`);
      }
    } else {
      try {
        hash = await scriptHashOf(lib, canonical.inner, canonical);
        note = "hash derived from the bytes (the source carried none)";
      } catch (error) {
        note = `hash could not be computed: ${error instanceof Error ? error.message : String(error)}`;
        warnings.push(`script_unverified: ${key} ${note}`);
      }
    }
    output.scriptRef = canonical.lib_form;
    if (hash) output.scriptHash = hash;
    if (hash) {
      out[hash] = {
        script_hash: hash,
        plutus_version: canonical.kind === "native" ? "native" : canonical.plutus_version!,
        inner: canonical.inner,
        lib_form: canonical.lib_form,
        verified,
        hash_source: hashSource,
        utxo: key,
        size_bytes: canonical.inner.length / 2,
        ...(note ? { note } : {}),
      };
    }
  }
  return out;
}

/**
 * Fill `RedeemerTarget.script_hash` / `plutus_version` of spend redeemers from the resolved input
 * addresses (payment credential), with versions from the tx's own scripts and the reference scripts.
 */
export function fillSpendScriptHashes(record: TxRecord, state: ChainState): void {
  if (!state.context) return;
  const resolved = resolvedUtxosFromContext({ validationContext: state.context as unknown as Record<string, unknown> });
  const versionByHash = new Map<string, "V1" | "V2" | "V3" | "native">();
  for (const s of record.scripts) versionByHash.set(s.script_hash, s.plutus_version);
  for (const [hash, ref] of Object.entries(state.refScripts)) versionByHash.set(hash, ref.plutus_version);
  const sortedRefs = sortedInputs(record.decoded).map(formatInputRef);
  record.redeemerTargets = withSpendScriptHashes(record.redeemerTargets, sortedRefs, resolved, versionByHash);
}
