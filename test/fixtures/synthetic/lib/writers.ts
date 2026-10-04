// Writers: one chain context / transaction, in every format the tests load.
//
//   txText(tx)                  bare tx hex (.tx)
//   debuggerContext(...)        de-uplc DebuggerContext JSON (`utxos`, `protocolParams`, `network`, `transaction`), with its real-world quirks
//   bundleV1(...)               cardano-debug bundle v1 (what bundle_export writes and tx_load reads)
//   evalFixture(...)            the raw `validate_transaction_js` result of a transaction (the raw validator answer, with the script bytes)
//   koios*Row / koiosCacheFiles the provider-cache snapshot (Koios row shapes, cache directory layout)
//
// Every text writer sorts object keys (safe-stable-stringify) and ends with a newline, so a rebuild is byte-identical.

import type { ProtocolParameters } from "@cardananium/cquisitor-lib";
import stringify from "safe-stable-stringify";

import { assetFingerprint, govActionIdBech32, parseAddress, rewardAddress, type Address } from "./address.js";
import { blake2b256 } from "./blake2b.js";
import { bytesToHex, utf8 } from "./bytes.js";
import { type ChainContext, type Network, toValidationInputContext, type Utxo, addressText } from "./context.js";
import { type ParamSet } from "./params.js";
import { decodePlutusData, plutusDataToKoiosJson } from "./plutusData.js";
import { scriptBody, scriptCbor, scriptHash, scriptSize, scriptTypeName } from "./script.js";
import { datumBytes, txHashOfBytes, type BuiltTx } from "./tx.js";
import { sortedAssets } from "./value.js";
import type { ValidationResult } from "./validator.js";
import { encode } from "./cbor.js";

// ---------------------------------------------------------------- text

/** Sorted-key JSON with a trailing newline; bigint as bare integers. */
export function jsonText(value: unknown, indent: number | null = 2): string {
  const text = indent === null ? stringify(value) : stringify(value, null, indent);
  if (text === undefined) throw new Error("value did not serialise");
  return `${text}\n`;
}

/** Bare transaction hex. `newline: true` appends one (the tests trim). */
export function txText(tx: BuiltTx | string, newline = false): string {
  const hex = typeof tx === "string" ? tx : tx.hex;
  return newline ? `${hex}\n` : hex;
}

/** The handle the server gives a loaded transaction: `tx_<network>_<first 12 hex characters of the hash>` (what tests call TX_ID). */
export function txHandle(network: Network, txHash: string): string {
  return `tx_${network}_${txHash.slice(0, 12)}`;
}

/** An artificial 32-byte (or `bytes`) id: blake2b of a fixed phrase and a label, traceable to the scenario that named it. */
export function fakeHash(label: string, bytes = 32): string {
  const digest = blake2b256(utf8(`cardano-debug-mcp synthetic fixture id / ${label}`));
  if (bytes === 32) return bytesToHex(digest);
  return bytesToHex(blake2b256(utf8(`cardano-debug-mcp synthetic fixture id / ${label} / ${bytes}`))).slice(0, bytes * 2);
}

// ---------------------------------------------------------------- DebuggerContext

export interface DebuggerContextOptions {
  tx: BuiltTx | string;
  ctx: ChainContext;
  /** The UTxOs to list, in this order (default: `ctx.utxos`). */
  utxos?: Utxo[];
  /**
   * The quirks real de-uplc dumps have (default true): `minFeeA` / `minFeeB` swapped (a = constant, b = coefficient), `utxoCostPerWord: 0`
   * (so the importer falls back to 4310 per byte), no execution prices (the importer's mainnet defaults apply), amounts as strings,
   * `protocolVersion` as `{major, minor}`.
   */
  quirks?: boolean;
  /** Network written to the file (default: the context's). */
  network?: Network;
  /** Key order of the result: `utxos, protocolParams, network, transaction` (default) or `transaction, network, utxos, protocolParams`. */
  order?: "sample" | "transaction-first";
}

function debuggerUtxo(u: Utxo): Record<string, unknown> {
  const unitText = (policy: string, name: string) => `${policy}.${name}`;
  const assets: Record<string, string> = {};
  for (const [p, names] of sortedAssets(u.value.assets)) for (const [n, q] of names) assets[unitText(p, n)] = q.toString();
  const value: Record<string, unknown> = { lovelace: u.value.coin.toString() };
  if (Object.keys(assets).length > 0) value.assets = assets;
  const out: Record<string, unknown> = {
    txHash: u.ref.txHash,
    outputIndex: u.ref.index,
    address: addressText(u.address),
    value,
    datumHash: u.datumHash ?? null,
  };
  if (u.inlineDatum !== undefined) out.inlineDatum = bytesToHex(datumBytes(u.inlineDatum));
  out.referenceScript = u.scriptRef ? { type: u.scriptRef.kind === "native" ? "NativeScript" : `PlutusV${u.scriptRef.version}`, script: bytesToHex(scriptBody(u.scriptRef)) } : null;
  return out;
}

export function debuggerProtocolParams(params: ProtocolParameters, quirks = true): Record<string, unknown> {
  const a = BigInt(params.minFeeCoefficientA);
  const b = BigInt(params.minFeeConstantB);
  const pp: Record<string, unknown> = {
    minFeeA: Number(quirks ? b : a),
    minFeeB: Number(quirks ? a : b),
    maxTxSize: params.maxTransactionSize,
    maxValSize: String(params.maxValueSize),
    keyDeposit: String(params.stakeKeyDeposit),
    poolDeposit: String(params.stakePoolDeposit),
    minPoolCost: String(params.minPoolCost),
    utxoCostPerWord: quirks ? 0 : Number(params.adaPerUtxoByte),
    maxTxExMem: String(params.maxTxExecutionUnits.mem),
    maxTxExSteps: String(params.maxTxExecutionUnits.steps),
    maxBlockExMem: String(params.maxBlockExecutionUnits.mem),
    maxBlockExSteps: String(params.maxBlockExecutionUnits.steps),
    maxCollateralInputs: params.maxCollateralInputs,
    costModels: { PlutusV1: params.costModels.plutusV1, PlutusV2: params.costModels.plutusV2, PlutusV3: params.costModels.plutusV3 },
    protocolVersion: { major: params.protocolVersion[0], minor: params.protocolVersion[1] },
  };
  if (!quirks) {
    pp.priceMem = Number(params.executionPrices.memPrice.numerator) / Number(params.executionPrices.memPrice.denominator);
    pp.priceStep = Number(params.executionPrices.stepPrice.numerator) / Number(params.executionPrices.stepPrice.denominator);
    pp.coinsPerUtxoSize = Number(params.adaPerUtxoByte);
  }
  return pp;
}

export function debuggerContext(opts: DebuggerContextOptions): Record<string, unknown> {
  const quirks = opts.quirks ?? true;
  const parts = {
    utxos: (opts.utxos ?? opts.ctx.utxos).map(debuggerUtxo),
    protocolParams: debuggerProtocolParams(opts.ctx.params, quirks),
    network: opts.network ?? opts.ctx.network,
    transaction: typeof opts.tx === "string" ? opts.tx : opts.tx.hex,
  };
  return opts.order === "transaction-first" ? { transaction: parts.transaction, network: parts.network, utxos: parts.utxos, protocolParams: parts.protocolParams } : parts;
}

/** DebuggerContext as file text (insertion order kept: it is the documented key order). */
export function debuggerContextFile(opts: DebuggerContextOptions): string {
  return `${JSON.stringify(debuggerContext(opts), null, 2)}\n`;
}

// ---------------------------------------------------------------- bundle v1

export interface BundleOptions {
  tx: BuiltTx | string;
  ctx: ChainContext;
  /** ISO time or null (unknown, the default: nothing is captured at build time). */
  capturedAt?: string | null;
  origin?: string;
  /** Provider rows (Koios shapes) the bundle carries. */
  providerRows?: Record<string, unknown>;
  /** A stored validation result (wire form). */
  validationResult?: ValidationResult | Record<string, unknown>;
  missingUtxos?: string[];
  providerWarnings?: string[];
  defaultsApplied?: string[];
  refScripts?: Record<string, unknown>;
  onChain?: { slot: string; epoch: number; block_height: number | null; is_valid: boolean; source?: string; tx_bytes?: string };
}

export function bundleV1(opts: BundleOptions): Record<string, unknown> {
  const hex = typeof opts.tx === "string" ? opts.tx : opts.tx.hex;
  const txHash = typeof opts.tx === "string" ? txHashOfBytes(opts.tx) : opts.tx.txHash;
  const bundle: Record<string, unknown> = {
    cardano_debug_bundle: 1,
    network: opts.ctx.network,
    tx_hash: txHash,
    tx_cbor: hex,
    captured_at: opts.capturedAt ?? null,
    slot: opts.ctx.slot.toString(),
    protocol_major: Number(opts.ctx.params.protocolVersion[0]),
    validation_input_context: toValidationInputContext(opts.ctx),
  };
  if (opts.origin !== undefined) bundle.origin = opts.origin;
  if (opts.providerRows) bundle.provider_rows = opts.providerRows;
  if (opts.validationResult) bundle.validation_result = opts.validationResult;
  if (opts.missingUtxos) bundle.missing_utxos = opts.missingUtxos;
  if (opts.providerWarnings) bundle.provider_warnings = opts.providerWarnings;
  if (opts.defaultsApplied) bundle.defaults_applied = opts.defaultsApplied;
  if (opts.refScripts) bundle.ref_scripts = opts.refScripts;
  if (opts.onChain) bundle.on_chain = opts.onChain;
  return bundle;
}

/** Bundle JSON text exactly as `encodeBundle` writes it: sorted keys, bare integers, one-space indent. */
export function bundleFile(opts: BundleOptions): string {
  return jsonText(bundleV1(opts), 1);
}

/** A bundle `ref_scripts` record for a UTxO with a reference script (Koios-verified form). */
export function refScriptRecord(u: Utxo, source: "provider" | "derived" = "derived"): Record<string, unknown> {
  const s = u.scriptRef;
  if (!s) throw new Error("the UTxO carries no reference script");
  const inner = bytesToHex(scriptBody(s));
  return {
    script_hash: scriptHash(s),
    plutus_version: s.kind === "native" ? "native" : `V${s.version}`,
    inner,
    lib_form: bytesToHex(encode(scriptCbor(s))),
    verified: source === "provider",
    hash_source: source,
    utxo: `${u.ref.txHash}#${u.ref.index}`,
    size_bytes: scriptSize(s),
  };
}

// ---------------------------------------------------------------- raw validator result

/** Keys of an eval result that are kept (the lib's `script_context` JSON string is left out unless `keepScriptContext`). */
const EVAL_KEYS = ["tag", "index", "provided_ex_units", "calculated_ex_units", "logs", "success", "error", "script_context_bytes", "script_bytes", "plutus_version", "redeemer_bytes", "datum_bytes"];

export function evalFixture(opts: { tx: BuiltTx | string; ctx: ChainContext; result: ValidationResult; source: string; keepScriptContext?: boolean }): Record<string, unknown> {
  const pp = opts.ctx.params;
  const cms = pp.costModels;
  return {
    _source: opts.source,
    network: opts.ctx.network,
    tx_hex: typeof opts.tx === "string" ? opts.tx : opts.tx.hex,
    protocol_parameters: { protocolVersion: pp.protocolVersion, costModels: { plutusV1: cms.plutusV1, plutusV2: cms.plutusV2, plutusV3: cms.plutusV3 } },
    eval_redeemer_results: opts.result.eval_redeemer_results.map((r) => {
      if (opts.keepScriptContext) return r;
      const o: Record<string, unknown> = {};
      for (const k of EVAL_KEYS) if (k in r) o[k] = r[k];
      return o;
    }),
  };
}

// ---------------------------------------------------------------- Koios rows and the provider-cache snapshot

/** Shelley-era epoch of a slot (the arithmetic the validator and the server use: mainnet epochs are 432000 slots from slot 4492800 = epoch 208). */
export function epochOfSlot(network: Network, slot: bigint | number): number {
  const s = Number(slot);
  const era = { mainnet: { start: 4_492_800, epoch: 208, length: 432_000 }, preprod: { start: 86_400, epoch: 4, length: 432_000 }, preview: { start: 0, epoch: 0, length: 86_400 } }[network];
  return era.epoch + Math.floor((s - era.start) / era.length);
}

/** Unix seconds of a slot (one slot per second after the Shelley start). */
export function unixTimeOfSlot(network: Network, slot: bigint | number): number {
  const era = { mainnet: { slot: 4_492_800, time: 1_596_059_091 }, preprod: { slot: 86_400, time: 1_655_769_600 }, preview: { slot: 0, time: 1_666_656_000 } }[network];
  return era.time + Number(slot) - era.slot;
}

/** Inclusion facts of a transaction included at `slot` in block `label` (artificial block hash and height, real epoch / time arithmetic). */
export function inclusionAt(network: Network, slot: bigint | number, label: string, o: { blockHeight?: number; validContract?: boolean } = {}): InclusionFacts {
  return {
    blockHash: fakeHash(`block ${label}`),
    blockHeight: o.blockHeight ?? Math.floor(Number(slot) / 20),
    epoch: epochOfSlot(network, slot),
    absoluteSlot: Number(slot),
    timestamp: unixTimeOfSlot(network, slot),
    validContract: o.validContract ?? true,
  };
}

/** UTxO row facts derived from inclusion facts: the UTxO was created `slotsBefore` slots earlier (default 2000). */
export function chainFactsAt(network: Network, slot: bigint | number, slotsBefore = 2000): ChainFacts {
  const at = Number(slot) - slotsBefore;
  return { network, epoch: epochOfSlot(network, at), blockHeight: Math.floor(at / 20), blockTime: unixTimeOfSlot(network, at) };
}

export interface ChainFacts {
  network: Network;
  /** epoch / block height / block time (unix seconds) of the UTxO's creation unless the UTxO says otherwise */
  epoch: number;
  blockHeight: number;
  blockTime: number;
}

export function koiosUtxoRow(u: Utxo, facts: ChainFacts): Record<string, unknown> {
  const addr = typeof u.address === "string" || u.address instanceof Uint8Array ? tryParse(u.address) : u.address;
  const stake: Address | undefined = addr?.stake ? rewardAddress(addr.network, addr.stake) : undefined;
  const assets = sortedAssets(u.value.assets).flatMap(([p, names]) =>
    names.map(([n, q]) => ({ decimals: 0, quantity: q.toString(), policy_id: p, asset_name: n, fingerprint: assetFingerprint(p, n) })),
  );
  const row: Record<string, unknown> = {
    tx_hash: u.ref.txHash,
    tx_index: u.ref.index,
    address: addressText(u.address),
    value: u.value.coin.toString(),
    stake_address: stake ? stake.bech32 : null,
    payment_cred: addr?.payment ? bytesToHex(addr.payment.hash) : null,
    epoch_no: u.epoch ?? facts.epoch,
    block_height: u.blockHeight ?? facts.blockHeight,
    block_time: u.blockTime ?? facts.blockTime,
    datum_hash: u.datumHash ?? null,
    inline_datum: u.inlineDatum === undefined ? null : { bytes: bytesToHex(datumBytes(u.inlineDatum)), value: plutusDataToKoiosJson(decodePlutusData(datumBytes(u.inlineDatum))) },
    reference_script: u.scriptRef
      ? { hash: scriptHash(u.scriptRef), size: scriptSize(u.scriptRef), type: scriptTypeName(u.scriptRef), bytes: bytesToHex(scriptBody(u.scriptRef)), value: null }
      : null,
    asset_list: assets,
    is_spent: u.isSpent ?? false,
  };
  return row;
}

function tryParse(a: string | Uint8Array): Address | undefined {
  try {
    return parseAddress(typeof a === "string" ? a : a);
  } catch {
    return undefined;
  }
}

export interface InclusionFacts {
  blockHash: string;
  blockHeight: number;
  epoch: number;
  absoluteSlot: number;
  /** unix seconds */
  timestamp: number;
  validContract?: boolean;
}

export function koiosTxRow(tx: BuiltTx | { txHash: string; hex: string }, facts: InclusionFacts): Record<string, unknown> {
  return {
    tx_hash: tx.txHash,
    block_hash: facts.blockHash,
    block_height: facts.blockHeight,
    epoch_no: facts.epoch,
    absolute_slot: facts.absoluteSlot,
    tx_timestamp: facts.timestamp,
    cbor: tx.hex,
    valid_contract: facts.validContract ?? true,
  };
}

/** The Koios `epoch_params` row of a parameter set for an artificial epoch (nonce and block hash derived from the epoch). */
export function koiosEpochParamsRow(set: ParamSet, epoch: number): Record<string, unknown> {
  return { epoch_no: epoch, ...set.koiosEpochParams, extra_entropy: null, nonce: fakeHash(`epoch ${epoch} nonce`), block_hash: fakeHash(`epoch ${epoch} first block`) };
}

export function koiosTotalsRow(epoch: number, overrides: Record<string, string> = {}): Record<string, unknown> {
  return {
    epoch_no: epoch,
    circulation: "30000000000000000",
    treasury: "1500000000000000",
    reward: "700000000000000",
    supply: "36000000000000000",
    reserves: "6000000000000000",
    fees: "50000000000",
    deposits_stake: "4000000000000",
    deposits_drep: "400000000000",
    deposits_proposal: "100000000000",
    treasury_donation: "0",
    treasury_withdrawal: "0",
    reserves_withdrawal: "0",
    ...overrides,
  };
}

export function koiosAccountRow(stakeAddress: string, o: { registered?: boolean; pool?: string | null; drep?: string | null; balance?: bigint; rewards?: bigint; deposit?: bigint } = {}): Record<string, unknown> {
  const balance = (o.balance ?? 0n).toString();
  return {
    stake_address: stakeAddress,
    status: o.registered === false ? "not registered" : "registered",
    delegated_pool: o.pool ?? null,
    delegated_drep: o.drep ?? null,
    total_balance: balance,
    utxo: balance,
    rewards: (o.rewards ?? 0n).toString(),
    withdrawals: "0",
    rewards_available: (o.rewards ?? 0n).toString(),
    deposit: (o.deposit ?? 2_000_000n).toString(),
    reserves: "0",
    treasury: "0",
    proposal_refund: "0",
  };
}

export interface ProposalRowInput {
  txHash: string;
  index: number;
  type: "ParameterChange" | "HardForkInitiation" | "TreasuryWithdrawals" | "NoConfidence" | "NewCommittee" | "NewConstitution" | "InfoAction";
  /** stake address (bech32) the deposit is returned to */
  returnAddress: string;
  proposedEpoch: number;
  /** Koios `param_proposal`: snake_case parameter names (`max_tx_ex_mem`, `min_pool_cost`, ...) -> values */
  paramProposal?: Record<string, unknown> | null;
  expiration?: number | null;
  ratifiedEpoch?: number | null;
  enactedEpoch?: number | null;
  droppedEpoch?: number | null;
  expiredEpoch?: number | null;
  deposit?: string;
  blockTime?: number;
  anchorUrl?: string;
  anchorHash?: string;
  previousProposalId?: string | null;
  description?: unknown;
}

/** A Koios `proposal_list` row (what `provider_rows.proposals` carries); `proposal_id` is the CIP-129 bech32 id. */
export function koiosProposalRow(o: ProposalRowInput): Record<string, unknown> {
  return {
    block_time: o.blockTime ?? 1_700_000_000,
    deposit: o.deposit ?? "100000000000",
    dropped_epoch: o.droppedEpoch ?? null,
    enacted_epoch: o.enactedEpoch ?? null,
    expiration: o.expiration ?? null,
    expired_epoch: o.expiredEpoch ?? null,
    meta_comment: null,
    meta_hash: o.anchorHash ?? fakeHash(`proposal anchor ${o.txHash}#${o.index}`),
    meta_is_valid: true,
    meta_json: null,
    meta_language: "en-us",
    meta_url: o.anchorUrl ?? "ipfs://synthetic-proposal-anchor",
    param_proposal: o.paramProposal ?? null,
    previous_gov_action_proposal_id: o.previousProposalId ?? null,
    proposal_description: o.description ?? { tag: o.type, contents: [] },
    proposal_id: govActionIdBech32(o.txHash, o.index),
    proposal_index: o.index,
    proposal_tx_hash: o.txHash,
    proposal_type: o.type,
    proposed_epoch: o.proposedEpoch,
    ratified_epoch: o.ratifiedEpoch ?? null,
    return_address: o.returnAddress,
    withdrawal: [],
  };
}

export interface CacheMember {
  ccColdHex: string;
  ccHotHex: string | null;
  ccColdId: string;
  ccHotId: string | null;
  hasScript?: boolean;
  status?: "authorized" | "not_authorized" | "resigned";
  expirationEpoch: number;
}

export function koiosCommitteeRow(o: { proposalTxHash: string; proposalId: string; quorum: [number, number]; members: CacheMember[] }): Record<string, unknown> {
  return {
    proposal_id: o.proposalId,
    proposal_tx_hash: o.proposalTxHash,
    proposal_index: 0,
    quorum_numerator: o.quorum[0],
    quorum_denominator: o.quorum[1],
    members: o.members.map((m) => ({
      status: m.status ?? "authorized",
      cc_hot_id: m.ccHotId,
      cc_cold_id: m.ccColdId,
      cc_hot_hex: m.ccHotHex,
      cc_cold_hex: m.ccColdHex,
      expiration_epoch: m.expirationEpoch,
      cc_hot_has_script: m.ccHotHex === null ? null : (m.hasScript ?? false),
      cc_cold_has_script: m.hasScript ?? false,
    })),
  };
}

/** Provider-cache file layout, as `Record<relative path, text>`: pass the pieces a scenario wants cached. */
export interface CacheSnapshotInput {
  network: Network;
  tx?: Record<string, unknown>;
  utxos?: Record<string, unknown>[];
  epochParams?: Array<{ epoch: number; row: Record<string, unknown> }>;
  accounts?: Array<{ key: string; row: Record<string, unknown> }>;
  committee?: Record<string, unknown>;
  constitution?: { anchorUrl: string; anchorDataHash: string; guardrailScriptHash: string | null } | null;
  totals?: Array<{ epoch: number; row: Record<string, unknown> }>;
  pools?: Array<{ key: string; row: Record<string, unknown> }>;
  dreps?: Array<{ key: string; row: Record<string, unknown> }>;
}

export function koiosCacheFiles(input: CacheSnapshotInput): Record<string, string> {
  const net = input.network;
  const files: Record<string, string> = {};
  const put = (path: string, value: unknown) => {
    files[path] = jsonText(value, 2);
  };
  if (input.tx) put(`tx/${net}/koios/${String(input.tx.tx_hash)}.json`, input.tx);
  for (const row of input.utxos ?? []) put(`utxo/${net}/koios/${String(row.tx_hash)}_${String(row.tx_index)}.json`, row);
  for (const { epoch, row } of input.epochParams ?? []) put(`epoch_params/${net}/koios/${epoch}.json`, [row]);
  for (const { key, row } of input.accounts ?? []) put(`rows/${net}/koios/account_info/${key}.json`, row);
  for (const { key, row } of input.pools ?? []) put(`rows/${net}/koios/pool_info/${key}.json`, row);
  for (const { key, row } of input.dreps ?? []) put(`rows/${net}/koios/drep_info/${key}.json`, row);
  if (input.committee) put(`rows/${net}/koios/committee_info/current.json`, [input.committee]);
  if (input.constitution !== undefined) put(`rows/${net}/koios/constitution/current.json`, { constitution: input.constitution });
  for (const { epoch, row } of input.totals ?? []) put(`rows/${net}/koios/totals/${epoch}.json`, [row]);
  return files;
}

