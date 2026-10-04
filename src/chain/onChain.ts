// Transactions that are already on chain. A tx fetched by hash is on chain by construction; validating
// it against the current tip would mark its own inputs spent (BadInputsUTxO), put the tip outside
// its validity interval and use today's cost models (ScriptDataHashMismatch, ex-unit drift). So its
// context is reconstructed at the inclusion point instead:
//   - slot = the inclusion slot (the tip the fetch pipeline sees is replaced);
//   - protocol parameters and treasury = those of the inclusion epoch;
//   - the tx's own inputs, collateral and reference inputs are unspent (they had to be, for the
//     ledger to include it).
// What cannot be reconstructed from the providers (account balances, registrations, governance
// state at that slot) stays current and is named in defaults_applied.

import { createHash } from "node:crypto";

import type { BlockchainDataClient, GovActionRef, AssetMetadata } from "@cardananium/cquisitor-lib/chain/koiosClient";
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

import type { Network } from "../config.js";
import type { NecessaryInputData } from "../lib.js";
import type { OnChainInfo } from "../store/txStore.js";
import type { ProviderName } from "./http.js";
import type { ProviderRows } from "./providers.js";

type Json = Record<string, unknown>;

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "True") return true;
  if (value === "false" || value === "False") return false;
  return null;
}

/** Short content key of the full transaction bytes (validation results are per bytes, not per body). */
export function bytesKey(txHex: string): string {
  return createHash("sha256").update(txHex.toLowerCase()).digest("hex").slice(0, 16);
}

/** Inclusion facts about the tx whose included bytes are `txHex` (the provider's tx row / the bundle's tx_cbor). */
export function withIncludedBytes(info: OnChainInfo, txHex: string): OnChainInfo {
  return { ...info, tx_bytes: bytesKey(txHex) };
}

/**
 * Whether `txHex` are the bytes the ledger included: false for the same body with other witnesses /
 * redeemers / ex-units; undefined when the inclusion facts do not say which bytes were included.
 */
export function isIncludedBytes(info: OnChainInfo, txHex: string): boolean | undefined {
  return info.tx_bytes === undefined ? undefined : info.tx_bytes === bytesKey(txHex);
}

/** Shelley-era epoch of a slot (Byron epochs are 21600 slots; every later epoch the network's epoch length). */
export function epochOfSlot(network: Network, slot: bigint | number): number {
  const s = Number(slot);
  const shelley: Record<Network, { startSlot: number; startEpoch: number; length: number }> = {
    mainnet: { startSlot: 4_492_800, startEpoch: 208, length: 432_000 },
    preprod: { startSlot: 86_400, startEpoch: 4, length: 432_000 },
    preview: { startSlot: 0, startEpoch: 0, length: 86_400 },
  };
  const era = shelley[network];
  if (s < era.startSlot) return Math.floor(s / 21_600);
  return era.startEpoch + Math.floor((s - era.startSlot) / era.length);
}

/** Inclusion facts from a Koios `tx_cbor` row (it carries epoch_no, absolute_slot, block_height, valid_contract). */
export function inclusionFromKoiosRow(row: KoiosTxCborResponse | Json | undefined): OnChainInfo | undefined {
  if (!row) return undefined;
  const r = row as Json;
  const slot = num(r.absolute_slot);
  const epoch = num(r.epoch_no);
  if (slot === undefined || epoch === undefined) return undefined;
  const info: OnChainInfo = { slot: String(slot), epoch, block_height: num(r.block_height) ?? null, is_valid: bool(r.valid_contract), source: "koios tx_cbor row" };
  if (typeof r.block_hash === "string" && r.block_hash) info.block_hash = r.block_hash.toLowerCase();
  return info;
}

/** Inclusion facts from a Blockfrost `/txs/{hash}` answer (no epoch field: derived from the slot). */
export function inclusionFromBlockfrostTx(network: Network, tx: Json | undefined): OnChainInfo | undefined {
  if (!tx) return undefined;
  const slot = num(tx.slot);
  if (slot === undefined) return undefined;
  const info: OnChainInfo = { slot: String(slot), epoch: epochOfSlot(network, slot), block_height: num(tx.block_height) ?? null, is_valid: bool(tx.valid_contract), source: "blockfrost /txs" };
  if (typeof tx.block === "string" && tx.block) info.block_hash = tx.block.toLowerCase();
  return info;
}

/** The inclusion facts, validated (a bundle or cache may carry anything). */
export function parseOnChainInfo(value: unknown): OnChainInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Json;
  const slot = typeof r.slot === "string" || typeof r.slot === "number" || typeof r.slot === "bigint" ? String(r.slot) : undefined;
  const epoch = num(r.epoch);
  if (!slot || !/^\d+$/.test(slot) || epoch === undefined) return undefined;
  const info: OnChainInfo = { slot, epoch, block_height: num(r.block_height) ?? null, is_valid: bool(r.is_valid), source: typeof r.source === "string" ? r.source : "bundle" };
  if (typeof r.block_hash === "string" && r.block_hash) info.block_hash = r.block_hash;
  if (typeof r.tx_bytes === "string" && /^[0-9a-f]{16}$/.test(r.tx_bytes)) info.tx_bytes = r.tx_bytes;
  return info;
}

export function sameInclusion(a: OnChainInfo | undefined, b: OnChainInfo | undefined): boolean {
  return Boolean(a && b && a.slot === b.slot && a.epoch === b.epoch);
}

/**
 * A BlockchainDataClient that answers as of the inclusion point: the tip is the inclusion slot and
 * "latest" epoch parameters / totals are those of the inclusion epoch. Everything else is delegated.
 */
export class InclusionClient implements BlockchainDataClient {
  /** What had to fall back to the current state (named in defaults_applied by the caller). */
  readonly fallbacks: string[] = [];

  constructor(
    private readonly inner: BlockchainDataClient & { rows?: ProviderRows },
    private readonly at: OnChainInfo,
  ) {}

  async getTip(): Promise<KoiosTip[]> {
    const tip: KoiosTip = {
      hash: this.at.block_hash ?? "",
      epoch_no: this.at.epoch,
      abs_slot: Number(this.at.slot),
      epoch_slot: 0,
      block_height: this.at.block_height ?? 0,
      block_time: 0,
    };
    if (this.inner.rows) this.inner.rows.tip = tip;
    return [tip];
  }

  async getTotals(epochNo?: number): Promise<KoiosTotals[]> {
    const rows = await this.inner.getTotals(epochNo ?? this.at.epoch);
    if (rows.length > 0 || epochNo !== undefined) return rows;
    this.fallbacks.push(`treasuryValue = the CURRENT treasury (the provider has no totals row for epoch ${this.at.epoch})`);
    return this.inner.getTotals();
  }

  async getEpochParams(epochNo?: number): Promise<KoiosEpochParams[]> {
    const rows = await this.inner.getEpochParams(epochNo ?? this.at.epoch);
    if (rows.length > 0 || epochNo !== undefined) return rows;
    this.fallbacks.push(`protocolParameters = the CURRENT epoch's (the provider has no parameters for epoch ${this.at.epoch}): cost models and fees may differ from what the ledger used`);
    return this.inner.getEpochParams();
  }

  getUtxoInfo(utxoRefs: string[]): Promise<KoiosUtxoInfo[]> {
    return this.inner.getUtxoInfo(utxoRefs);
  }
  getAccountInfo(stakeAddresses: string[]): Promise<KoiosAccountInfo[]> {
    return this.inner.getAccountInfo(stakeAddresses);
  }
  getPoolInfo(poolIds: string[]): Promise<KoiosPoolInfo[]> {
    return this.inner.getPoolInfo(poolIds);
  }
  getDrepInfo(drepIds: string[]): Promise<KoiosDrepInfo[]> {
    return this.inner.getDrepInfo(drepIds);
  }
  getCommitteeInfo(): Promise<KoiosCommitteeInfo> {
    return this.inner.getCommitteeInfo();
  }
  getConstitution(): Promise<KoiosConstitution | null> {
    return this.inner.getConstitution();
  }
  getProposalsByRefs(refs: GovActionRef[]): Promise<KoiosProposal[]> {
    return this.inner.getProposalsByRefs(refs);
  }
  getLastEnactedProposals(proposalTypes: string[]): Promise<KoiosProposal[]> {
    return this.inner.getLastEnactedProposals(proposalTypes);
  }
  getTxCbor(txHashes: string[]): Promise<KoiosTxCborResponse[]> {
    return this.inner.getTxCbor(txHashes);
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

/**
 * The defaults_applied lines of an at-inclusion context: what was reconstructed and what could not
 * be (current provider state standing in for the state at the inclusion slot).
 */
export function inclusionDefaults(at: OnChainInfo, provider: ProviderName, necessary: NecessaryInputData, utxoSpentNow: number, utxoTotal: number, hasProposals: boolean): string[] {
  const out = [
    `slot=${at.slot}: the transaction is on chain (epoch ${at.epoch}${at.block_height !== null ? `, block ${at.block_height}` : ""}), so it is validated at its inclusion slot, not at the current tip`,
    `protocolParameters = epoch ${at.epoch} parameters (the inclusion epoch), not the current ones`,
    `utxoSet[*].isSpent=false: the ${utxoTotal} inputs / collateral / reference inputs were unspent when the tx was included (the provider reports ${utxoSpentNow} of them spent now)`,
  ];
  out.push(
    provider === "koios"
      ? `treasuryValue = the provider's treasury total for epoch ${at.epoch}`
      : "treasuryValue = the CURRENT treasury (Blockfrost has no per-epoch totals)",
  );
  const current: string[] = [];
  if (necessary.accounts.length > 0) current.push("reward accounts (balances, registration, delegation)");
  if (necessary.pools.length > 0) current.push("pools");
  if (necessary.dReps.length > 0) current.push("DReps");
  if (necessary.govActions.length > 0 || necessary.lastEnactedGovAction.length > 0) current.push("governance actions");
  if (necessary.committeeMembersCold.length > 0 || necessary.committeeMembersHot.length > 0) current.push("committee");
  if (hasProposals) current.push("constitution");
  if (current.length > 0) {
    out.push(
      `${current.join(", ")}: the provider's CURRENT state, not the state at slot ${at.slot} (no historical view exists); withdrawal amounts, registrations and deposits may be judged against today's values`,
    );
  }
  return out;
}
