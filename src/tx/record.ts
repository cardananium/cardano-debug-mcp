// Build a TxRecord from raw transaction bytes with the library alone (no chain context):
// decoded CSL JSON, extracted hashes, redeemer -> target map, script inventory.
// The chain layer (tx_load) adds UTxO resolution, protocol params and validation on top.

import { bech32 } from "bech32";
import type { ExtractedHashes, PlutusScript } from "@cardananium/cquisitor-lib";

import { isNetwork, type Network } from "../config.js";
import type { LibApi } from "../lib.js";
import { carryChainState } from "../chain/state.js";
import type { AppContext } from "../context.js";
import { expiredHandleError } from "../store/sessionRegistry.js";
import {
  isTxHash,
  makeTxId,
  normalizeTxId,
  type DecodedTransaction,
  type PlutusVersionOrNative,
  type RedeemerTarget,
  type ScriptSummary,
  type TxRecord,
} from "../store/txStore.js";
import { isNestingRefusal, normalizeBytesInput, ToolInputError, TxDecodeError, type ToolResult } from "../tools/_shared.js";
import { WorkerCallError } from "../workers/rpc.js";
import { parseJsonBigintSafe } from "../vocab/json.js";
import { LIB_REDEEMER_TAGS, purposeFromLibTag, type Purpose } from "../vocab/purpose.js";

export interface BuildTxRecordInput {
  /** Transaction bytes as hex, base64 or cardano-cli envelope. */
  tx: string;
  network: Network;
  source?: TxRecord["source"];
}

/** The message for a transaction hash given where a handle or transaction bytes belong. */
export function txHashHint(hash: string, argument: "tx_cbor" | "tx_id"): string {
  const h = hash.trim().toLowerCase().replace(/^0x/, "");
  return `${argument} is a 64-hex transaction HASH (${h.slice(0, 12)}…), not ${argument === "tx_id" ? "a handle" : "transaction bytes"}: load it with tx_load(tx_hash="${h}", network=mainnet|preprod|preview)${argument === "tx_id" ? ", then pass the tx_id that call returns" : " (add tx_cbor only when you hold the bytes)"}.`;
}

/** Hex of the transaction bytes; throws `ToolInputError` for anything that is not bytes. */
export function normalizeTxHex(input: string): string {
  if (isTxHash(input)) throw new ToolInputError(txHashHint(input, "tx_cbor"), "tx_cbor");
  const { value, kind } = normalizeBytesInput(input);
  if (kind === "text" || kind === "bech32") {
    throw new ToolInputError("tx_cbor must be the transaction CBOR as hex, base64 or a cardano-cli JSON envelope", "tx_cbor");
  }
  if (value.length < 8) throw new ToolInputError("tx_cbor is too short to be a transaction", "tx_cbor");
  return value;
}

/**
 * Guess the network from the addresses in the outputs: `addr1`/`stake1` -> mainnet, `addr_test1`
 * -> preprod (preview is indistinguishable; the caller should pass `network` when it matters).
 */
export function inferNetwork(decoded: DecodedTransaction): { network: Network; certain: boolean } | undefined {
  const outputs = decoded.transaction.body.outputs;
  if (!Array.isArray(outputs)) return undefined;
  for (const output of outputs) {
    const address = (output as { address?: unknown }).address;
    if (typeof address !== "string") continue;
    if (address.startsWith("addr_test1") || address.startsWith("stake_test1")) return { network: "preprod", certain: false };
    if (address.startsWith("addr1") || address.startsWith("stake1")) return { network: "mainnet", certain: true };
  }
  return undefined;
}

export async function buildTxRecord(lib: LibApi, input: BuildTxRecordInput): Promise<TxRecord> {
  const txHex = normalizeTxHex(input.tx);
  const argument = input.source === "provider" ? "tx_hash" : input.source === "bundle" ? "bundle" : "tx_cbor";
  let decoded: DecodedTransaction;
  try {
    decoded = await lib.decodeType<DecodedTransaction>(txHex, "Transaction");
  } catch (error) {
    // A non-fatal library error here means the bytes are not a transaction (wrong type, truncated,
    // trailing bytes, wrong era…; the library checks CBOR well-formedness before the typed decoder):
    // answer decode_failed with the next calls instead of a bare lib_error. A nesting refusal is no
    // verdict on the bytes: it stays a WorkerCallError, which failFromError answers as `unexamined`.
    if (error instanceof WorkerCallError && !error.fatal && !isNestingRefusal(error.message)) throw new TxDecodeError(error.message, txHex.length / 2, argument);
    throw error;
  }
  if (!decoded || typeof decoded !== "object" || typeof decoded.transaction_hash !== "string") {
    throw new TxDecodeError("the decoder returned no transaction_hash", txHex.length / 2, argument);
  }
  const hashes = await lib.extractHashes(txHex);
  const now = Date.now();
  const scripts = scriptInventory(decoded, hashes);
  const redeemerTargets = redeemerTargetsOf(decoded, scripts);
  return {
    txId: makeTxId(input.network, decoded.transaction_hash),
    txHash: decoded.transaction_hash,
    network: input.network,
    txHex,
    sizeBytes: txHex.length / 2,
    source: input.source ?? "cbor",
    createdAt: now,
    lastUsedAt: now,
    decoded,
    hashes,
    redeemerTargets,
    scripts,
    extra: {},
  };
}

// ---------- helpers over the CSL JSON ----------

type Json = Record<string, unknown>;

/**
 * A decoded Plutus script's hex. The decoder writes every Plutus script (witness set, auxiliary
 * data, script reference) as the library's `PlutusScript`, `{ bytes, language }`; `undefined`
 * when the value is not one.
 */
export function plutusScriptHex(script: unknown): string | undefined {
  const { bytes, language } = asRecord(script) as Partial<Record<keyof PlutusScript, unknown>>;
  return typeof bytes === "string" && typeof language === "string" ? bytes : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

export interface InputRef {
  tx_hash: string;
  output_index: number;
}

export function inputRefOf(value: unknown): InputRef | undefined {
  const rec = asRecord(value);
  const hash = rec.transaction_id;
  const index = rec.index;
  if (typeof hash !== "string") return undefined;
  const ix = typeof index === "number" ? index : typeof index === "string" ? Number.parseInt(index, 10) : NaN;
  if (!Number.isInteger(ix)) return undefined;
  return { tx_hash: hash.toLowerCase(), output_index: ix };
}

export function formatInputRef(ref: InputRef): string {
  return `${ref.tx_hash}#${ref.output_index}`;
}

function compareInputs(a: InputRef, b: InputRef): number {
  if (a.tx_hash !== b.tx_hash) return a.tx_hash < b.tx_hash ? -1 : 1;
  return a.output_index - b.output_index;
}

/** Inputs in ledger order (the order spend redeemer indices refer to). */
export function sortedInputs(decoded: DecodedTransaction): InputRef[] {
  return asArray(decoded.transaction.body.inputs)
    .map(inputRefOf)
    .filter((x): x is InputRef => x !== undefined)
    .sort(compareInputs);
}

/** Mint policies in ledger order. The CSL JSON mint is `[[policy, {asset: qty}], …]`. */
export function sortedMintPolicies(decoded: DecodedTransaction): string[] {
  const mint = asArray(decoded.transaction.body.mint);
  const policies = mint
    .map((entry) => (Array.isArray(entry) ? entry[0] : undefined))
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.toLowerCase());
  return Array.from(new Set(policies)).sort();
}

export interface RewardAccount {
  bech32: string;
  hex: string;
  scriptHash?: string;
}

export function decodeRewardAccount(address: string): RewardAccount | undefined {
  try {
    const { words } = bech32.decode(address, 200);
    const bytes = Buffer.from(bech32.fromWords(words));
    const hex = bytes.toString("hex");
    const header = bytes[0] ?? 0;
    const isScript = (header & 0xf0) === 0xf0;
    return { bech32: address, hex, scriptHash: isScript ? bytes.subarray(1, 29).toString("hex") : undefined };
  } catch {
    return undefined;
  }
}

/** Withdrawal reward accounts in ledger order (by bytes). */
export function sortedWithdrawals(decoded: DecodedTransaction): RewardAccount[] {
  const withdrawals = asRecord(decoded.transaction.body.withdrawals);
  return Object.keys(withdrawals)
    .map((key) => decodeRewardAccount(key) ?? { bech32: key, hex: key })
    .sort((a, b) => (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0));
}

/** Find a `{Script: hash}` credential in a cert / voter object (depth <= 3). */
function findScriptCredential(value: unknown, depth = 3): string | undefined {
  if (depth < 0 || value === null || typeof value !== "object") return undefined;
  const rec = value as Json;
  if (typeof rec.Script === "string" && Object.keys(rec).length === 1) return rec.Script.toLowerCase();
  for (const child of Object.values(rec)) {
    const found = findScriptCredential(child, depth - 1);
    if (found) return found;
  }
  return undefined;
}

/** `policy_hash` of a proposal's governance action (CSL JSON `{governance_action: {<Action>: {policy_hash}}}`). */
function proposalPolicyHash(proposal: unknown): string | undefined {
  const action = asRecord(asRecord(proposal).governance_action);
  for (const body of Object.values(action)) {
    const hash = asRecord(body).policy_hash;
    if (typeof hash === "string" && /^[0-9a-f]{56}$/i.test(hash)) return hash.toLowerCase();
  }
  return undefined;
}

function certKind(cert: unknown): string {
  const keys = Object.keys(asRecord(cert));
  return keys[0] ?? "unknown";
}

export function scriptInventory(decoded: DecodedTransaction, hashes: ExtractedHashes): ScriptSummary[] {
  const scripts: ScriptSummary[] = [];
  const witness = decoded.transaction.witness_set;
  const plutusHex = asArray(witness.plutus_scripts);
  hashes.witness_plutus_scripts.forEach((info, i) => {
    if (!info) return;
    const hex = plutusScriptHex(plutusHex[i]);
    scripts.push({
      script_hash: info.hash.toLowerCase(),
      plutus_version: info.version,
      source: "witness",
      size_bytes: hex ? hex.length / 2 : undefined,
      hex,
    });
  });
  hashes.witness_native_script_hashes.forEach((hash) => {
    if (!hash) return;
    scripts.push({ script_hash: hash.toLowerCase(), plutus_version: "native", source: "witness" });
  });
  const outputs = asArray(decoded.transaction.body.outputs);
  hashes.output_inline_scripts.forEach((info, i) => {
    if (!info) return;
    const version: PlutusVersionOrNative = info.script_type === "Native" ? "native" : info.script_type.Plutus;
    const ref = asRecord(asRecord(outputs[i]).script_ref);
    const hex = plutusScriptHex(ref.PlutusScript);
    scripts.push({
      script_hash: info.hash.toLowerCase(),
      plutus_version: version,
      source: `output ${i}`,
      size_bytes: hex ? hex.length / 2 : undefined,
      hex,
    });
  });
  return scripts;
}

function quantityString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return value.toString();
  return "0";
}

/** Redeemers of the witness set mapped to what they point at. */
export function redeemerTargetsOf(decoded: DecodedTransaction, scripts: ScriptSummary[]): RedeemerTarget[] {
  const redeemers = asArray(decoded.transaction.witness_set.redeemers);
  if (redeemers.length === 0) return [];
  const body = decoded.transaction.body;
  const inputs = sortedInputs(decoded);
  const policies = sortedMintPolicies(decoded);
  const withdrawals = sortedWithdrawals(decoded);
  const certs = asArray(body.certs);
  const votes = votersOf(body.voting_procedures);
  const proposals = asArray(body.voting_proposals);
  const versionByHash = new Map<string, PlutusVersionOrNative>();
  for (const s of scripts) versionByHash.set(s.script_hash, s.plutus_version);

  return redeemers.map((raw, witnessIndex) => {
    const rec = asRecord(raw);
    // A tag this server does not know is an error, never a guess: a wrong purpose points the
    // redeemer at the wrong target and loses its evaluation result.
    if (typeof rec.tag !== "string") throw new Error(`redeemer witness ${witnessIndex}: the decoded transaction gives no tag (${JSON.stringify(rec.tag)}); known tags: ${LIB_REDEEMER_TAGS.join(", ")}`);
    let purpose: Purpose;
    try {
      purpose = purposeFromLibTag(rec.tag);
    } catch (error) {
      throw new Error(`redeemer witness ${witnessIndex}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const index = typeof rec.index === "number" ? rec.index : Number.parseInt(String(rec.index ?? "0"), 10) || 0;
    const exUnits = asRecord(rec.ex_units);
    let target = `${purpose} #${index}`;
    let scriptHash: string | undefined;
    switch (purpose) {
      case "spend": {
        const input = inputs[index];
        target = input ? `input ${formatInputRef(input)}` : `input #${index} (out of range: ${inputs.length} inputs)`;
        break;
      }
      case "mint": {
        const policy = policies[index];
        target = policy ? `policy ${policy}` : `policy #${index} (out of range: ${policies.length} policies)`;
        scriptHash = policy;
        break;
      }
      case "withdraw": {
        const account = withdrawals[index];
        target = account ? `stake ${account.bech32}` : `withdrawal #${index} (out of range: ${withdrawals.length} withdrawals)`;
        scriptHash = account?.scriptHash;
        break;
      }
      case "publish": {
        const cert = certs[index];
        target = cert ? `cert #${index} (${certKind(cert)})` : `cert #${index} (out of range: ${certs.length} certs)`;
        scriptHash = findScriptCredential(cert);
        break;
      }
      case "vote": {
        const voter = votes[index];
        target = voter ? `vote ${voter.label}` : `vote #${index} (out of range: ${votes.length} voters)`;
        scriptHash = voter?.scriptHash;
        break;
      }
      case "propose": {
        target = proposals[index] ? `proposal #${index}` : `proposal #${index} (out of range: ${proposals.length} proposals)`;
        // The script run for a proposal is the guardrails script its action names (ParameterChange, TreasuryWithdrawals).
        scriptHash = proposalPolicyHash(proposals[index]);
        break;
      }
    }
    const targetInfo: RedeemerTarget = {
      ref: `${purpose}:${index}`,
      purpose,
      index,
      witness_index: witnessIndex,
      target,
      ex_units: { mem: quantityString(exUnits.mem), steps: quantityString(exUnits.steps) },
    };
    if (scriptHash) {
      targetInfo.script_hash = scriptHash;
      const version = versionByHash.get(scriptHash);
      if (version) targetInfo.plutus_version = version;
    }
    return targetInfo;
  });
}

interface VoterInfo {
  label: string;
  scriptHash?: string;
}

/** Voters of `voting_procedures` in the order the CSL JSON lists them (array of `[voter, …]` or object keyed by voter). */
function votersOf(value: unknown): VoterInfo[] {
  const entries: unknown[] = Array.isArray(value) ? value.map((e) => (Array.isArray(e) ? e[0] : asRecord(e).voter ?? e)) : Object.keys(asRecord(value));
  return entries.map((voter) => ({
    label: typeof voter === "string" ? voter : JSON.stringify(voter).slice(0, 120),
    scriptHash: findScriptCredential(voter),
  }));
}

// ---------- tool-facing resolution ----------

export interface TxInputArgs {
  tx_id?: string | undefined;
  tx_cbor?: string | undefined;
  network?: string | undefined;
}

export type TxResolution =
  | { ok: true; record: TxRecord; created: boolean; defaults_applied: string[] }
  | { ok: false; result: ToolResult };

/**
 * Resolve `{tx_id}` from the store, or `{tx_cbor (+ network)}` by decoding and storing a new
 * record. Missing `network` is inferred from output addresses (noted in `defaults_applied`).
 */
export async function resolveTxInput(ctx: AppContext, args: TxInputArgs): Promise<TxResolution> {
  const defaults: string[] = [];
  if (args.tx_id) {
    const record = await lookupTxRecord(ctx, args.tx_id);
    if (record) return { ok: true, record, created: false, defaults_applied: defaults };
    if (!args.tx_cbor) {
      if (isTxHash(args.tx_id)) throw new ToolInputError(txHashHint(args.tx_id, "tx_id"), "tx_id");
      return { ok: false, result: expiredHandleError(args.tx_id, "tx_load") };
    }
  }
  if (!args.tx_cbor) {
    throw new ToolInputError("Pass tx_id (from tx_load) or tx_cbor (transaction CBOR hex/base64).", "tx_id");
  }
  let network: Network | undefined;
  if (args.network !== undefined) {
    if (!isNetwork(args.network)) throw new ToolInputError(`network must be one of mainnet, preprod, preview (got ${JSON.stringify(args.network)})`, "network");
    network = args.network;
  }
  const txHex = normalizeTxHex(args.tx_cbor);
  const probe = await buildTxRecord(ctx.lib, { tx: txHex, network: network ?? "mainnet", source: "cbor" });
  if (!network) {
    const inferred = inferNetwork(probe.decoded);
    network = inferred?.network ?? "mainnet";
    defaults.push(`network=${network} (${inferred ? (inferred.certain ? "inferred from addresses" : "inferred from testnet addresses; pass network=preview if this is preview") : "no addresses to infer from; assumed"})`);
    if (network !== probe.network) {
      probe.network = network;
      probe.txId = makeTxId(network, probe.txHash);
    }
  }
  const existing = ctx.txStore.get(probe.txId);
  if (existing && existing.txHex === probe.txHex) return { ok: true, record: existing, created: false, defaults_applied: defaults };
  if (existing) {
    // Same body (same tx_id), other bytes (witnesses, redeemers, ex-units): the new bytes replace the
    // stored ones. The chain context depends on the body only and is kept; the verdict is not.
    carryChainState(existing, probe);
    probe.createdAt = existing.createdAt;
    defaults.push(`replaced the stored bytes of ${probe.txId} with the tx_cbor given (same body, different witness set); the previous verdict was dropped`);
  }
  ctx.txStore.put(probe);
  return { ok: true, record: probe, created: true, defaults_applied: defaults };
}

/**
 * The record of a tx_id: the store, else the disk cache (a restart or an evicted handle; the chain
 * layer's recall hook rebuilds it from the bundle / tx row it wrote). Undefined when neither knows it.
 */
export async function lookupTxRecord(ctx: AppContext, txId: string): Promise<TxRecord | undefined> {
  const id = normalizeTxId(txId);
  const record = ctx.txStore.get(id);
  if (record) return record;
  const recall = ctx.services.txRecall;
  return typeof recall === "function" ? recall(id) : undefined;
}

/** Parse the JSON-string PlutusData / metadata values the CSL JSON embeds; returns the string when it is not JSON. */
export function parseEmbeddedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return parseJsonBigintSafe(trimmed);
  } catch {
    return value;
  }
}
