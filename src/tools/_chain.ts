// Helpers shared by the chain-backed tools (tx_load, tx_validate, tx_redeemer, tx_add_witnesses,
// bundle_export): the tx_load summary shape, resource links, the request signal.

import { capturedAtIso, chainStateOf, ensureChainService, type ChainService, type RefScriptRecord } from "../chain/index.js";
import { onChainView } from "../chain/validate.js";
import type { AppContext } from "../context.js";
import type { TxRecord } from "../store/txStore.js";
import { missingUtxosView, resourceLink, truncateArray, type ResourceLink } from "./_shared.js";
import { txResources } from "./tx_inspect.js";

export const SUMMARY_ROWS = 32;

/** The tool handler's second argument, as far as this layer needs it. */
export interface HandlerExtra {
  mcpReq?: { signal?: AbortSignal; _meta?: { progressToken?: string | number }; notify?: (n: { method: string; params: Record<string, unknown> }) => Promise<void> };
}

export function signalOf(extra: unknown): AbortSignal | undefined {
  const signal = (extra as HandlerExtra | undefined)?.mcpReq?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/** Send `notifications/progress` when the client asked for it; never throws. */
export async function progress(extra: unknown, message: string, value: number, total?: number): Promise<void> {
  const req = (extra as HandlerExtra | undefined)?.mcpReq;
  const token = req?._meta?.progressToken;
  if (token === undefined || !req?.notify) return;
  try {
    await req.notify({ method: "notifications/progress", params: { progressToken: token, progress: value, ...(total !== undefined ? { total } : {}), message } });
  } catch {
    // progress is best effort
  }
}

export function chain(ctx: AppContext): ChainService {
  return ensureChainService(ctx);
}

/** Resource links of a loaded transaction: decoded.json, cbor, plus bundle / validation / necessary when present. */
export function chainResources(record: TxRecord): ResourceLink[] {
  const links = txResources(record);
  const state = chainStateOf(record);
  if (state?.context) {
    links.push(resourceLink(`cardano-debug://tx/${record.txId}/bundle.json`, `${record.txId} bundle`, "application/json", "Offline bundle (tx + chain context + validation)"));
    links.push(resourceLink(`cardano-debug://tx/${record.txId}/necessary.json`, `${record.txId} necessary`, "application/json", "UTxOs / accounts / pools the validation needs"));
  }
  if (record.validation) {
    links.push(resourceLink(`cardano-debug://tx/${record.txId}/validation.json`, `${record.txId} validation`, "application/json", "Full ValidationResult without byte fields"));
  }
  return links;
}

type Json = Record<string, unknown>;

/** Suffix for a reference script row: nothing when verified, otherwise how its hash is known. */
export function refScriptLabel(ref: RefScriptRecord): string {
  if (ref.verified) return "";
  return ref.hash_source === "derived" ? " (hash derived from bytes)" : " (UNVERIFIED: hash mismatch)";
}

function rec(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}
function count(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === "object") return Object.keys(value as Json).length;
  return 0;
}
function str(value: unknown): string | null {
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "bigint" ? String(value) : null;
}

/** Seconds since the chain state was captured, and what a cached state at the tip of a pending transaction means. */
function ageView(record: TxRecord, state: NonNullable<ReturnType<typeof chainStateOf>>): Json {
  if (state.capturedAt === null || !Number.isFinite(state.capturedAt)) return { age_s: null };
  const age = Math.max(0, Math.round((Date.now() - state.capturedAt) / 1000));
  // A transaction that is not on chain is judged at the tip as it was captured; a cached state keeps that tip and the spent flags.
  if (state.status === "cached" && !record.onChain && age >= 60) {
    return { age_s: age, stale_hint: `the tip (slot ${state.slot ?? "?"}) and UTxO spent flags are ${age} s old; refresh=true re-fetches the current ones` };
  }
  return { age_s: age };
}

/** The compact tx_load answer; lists are capped at 32 rows with a count of the rest. */
export function loadSummary(record: TxRecord): Json {
  const body = record.decoded.transaction.body;
  const ws = record.decoded.transaction.witness_set;
  const state = chainStateOf(record);
  const redeemers = truncateArray(
    record.redeemerTargets.map((r) => ({
      ref: r.ref,
      witness_index: r.witness_index,
      script_hash: r.script_hash,
      plutus_version: r.plutus_version,
      ex_units: { steps: r.ex_units.steps, mem: r.ex_units.mem },
      target: r.target,
    })),
    SUMMARY_ROWS,
  );
  const scriptRows = record.scripts.map((s) => ({ script_hash: s.script_hash, plutus_version: s.plutus_version, source: s.source, size_bytes: s.size_bytes }));
  for (const ref of Object.values(state?.refScripts ?? {})) {
    if (scriptRows.some((s) => s.script_hash === ref.script_hash)) continue;
    scriptRows.push({ script_hash: ref.script_hash, plutus_version: ref.plutus_version, source: `reference ${ref.utxo}${refScriptLabel(ref)}`, size_bytes: ref.size_bytes });
  }
  const scripts = truncateArray(scriptRows, SUMMARY_ROWS);
  return {
    tx_id: record.txId,
    tx_hash: record.txHash,
    network: record.network,
    source: record.source,
    protocol_major: state?.protocolMajor ?? null,
    slot: state?.slot?.toString() ?? null,
    size_bytes: record.sizeBytes,
    fee: str(body.fee),
    validity: { start: str(body.validity_start_interval), end: str(body.ttl) },
    is_valid_flag: record.decoded.transaction.is_valid,
    ...(record.onChain ? { on_chain: onChainView(record.onChain, record.txHex) } : {}),
    counts: {
      inputs: count(body.inputs),
      reference_inputs: count(body.reference_inputs),
      collateral: count(body.collateral),
      outputs: count(body.outputs),
      mint_policies: count(body.mint),
      certs: count(body.certs),
      withdrawals: count(body.withdrawals),
      votes: count(body.voting_procedures),
      proposals: count(body.voting_proposals),
      redeemers: count(ws.redeemers),
      witness_scripts: count(ws.plutus_scripts) + count(ws.native_scripts),
      datums: count(rec(ws.plutus_data).elems),
      vkey_witnesses: count(ws.vkeys),
    },
    redeemers: redeemers.items,
    ...(redeemers.truncated_count ? { redeemers_more: redeemers.truncated_count } : {}),
    scripts: scripts.items,
    ...(scripts.truncated_count ? { scripts_more: scripts.truncated_count } : {}),
    context: state
      ? {
          status: state.status,
          origin: state.origin,
          provider: state.provider ?? null,
          captured_at: capturedAtIso(state),
          ...ageView(record, state),
          utxos_resolved: state.context?.utxoSet.length ?? 0,
          utxos_needed: state.necessary?.utxos.length ?? null,
        }
      : { status: "unavailable", origin: "bytes only", captured_at: null },
    validated: Boolean(record.validation),
    ...missingUtxosView(state?.missingUtxos),
    provider_warnings: state?.providerWarnings ?? [],
    defaults_applied: state?.defaultsApplied ?? [],
  };
}
