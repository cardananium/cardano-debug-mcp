// Chain context of a scenario: the UTxO set, protocol parameters, slot and governance state the validator reads
// (cquisitor-lib's ValidationInputContext), built from artificial pieces.
//
// `utxo()` makes the UTxOs a transaction spends or references; `produced()` turns an earlier built transaction's
// outputs into UTxOs, so a scenario can chain transactions. Order matters to some tests (DebuggerContext positions):
// `ChainContext.utxos` keeps the order given.

import type {
  AccountInputContext,
  CommitteeInputContext,
  DrepInputContext,
  GovActionInputContext,
  PoolInputContext,
  ProtocolParameters,
  UtxoInputContext,
  ValidationInputContext,
} from "@cardananium/cquisitor-lib";
import stringify from "safe-stable-stringify";

import { base58Encode, drepIdBech32, parseAddress, poolIdBech32, rewardAddress, type Credential } from "./address.js";
import { bytesToHex, hexToBytes } from "./bytes.js";
import { encode } from "./cbor.js";
import { type Script, scriptCbor, scriptHash } from "./script.js";
import { type AddressLike, type BuiltTx, type DatumData, type TxIn, type TxOut, datumBytes, txin } from "./tx.js";
import { type Assets, toAmountList, type Value } from "./value.js";

export type Network = "mainnet" | "preprod" | "preview";

export interface Utxo {
  ref: TxIn;
  address: AddressLike;
  value: Value;
  datumHash?: string;
  inlineDatum?: DatumData;
  scriptRef?: Script;
  isSpent?: boolean;
  /** Inclusion facts the Koios row writer reports (defaults come from the context). */
  epoch?: number;
  blockHeight?: number;
  blockTime?: number;
}

export interface ChainContext {
  network: Network;
  params: ProtocolParameters;
  slot: bigint;
  utxos: Utxo[];
  accounts?: AccountInputContext[];
  dreps?: DrepInputContext[];
  pools?: PoolInputContext[];
  govActions?: GovActionInputContext[];
  lastEnacted?: GovActionInputContext[];
  committee?: CommitteeInputContext[];
  potentialCommittee?: CommitteeInputContext[];
  treasury?: bigint;
  constitution?: { guardrailScriptHash: string | null } | null;
}

export interface UtxoInit {
  ref: string | TxIn;
  address: AddressLike;
  coin: bigint | number;
  assets?: Assets;
  datumHash?: string;
  inlineDatum?: DatumData;
  scriptRef?: Script;
  isSpent?: boolean;
}

export function utxo(init: UtxoInit): Utxo {
  const ref = typeof init.ref === "string" ? parseRefText(init.ref) : init.ref;
  return {
    ref,
    address: init.address,
    value: { coin: BigInt(init.coin), assets: init.assets ?? {} },
    ...(init.datumHash ? { datumHash: init.datumHash } : {}),
    ...(init.inlineDatum !== undefined ? { inlineDatum: init.inlineDatum } : {}),
    ...(init.scriptRef ? { scriptRef: init.scriptRef } : {}),
    ...(init.isSpent !== undefined ? { isSpent: init.isSpent } : {}),
  };
}

function parseRefText(ref: string): TxIn {
  const [h, i] = ref.split("#");
  if (!h || i === undefined) throw new Error(`bad utxo ref ${ref}`);
  return txin(h, Number(i));
}

/** The UTxOs a built transaction creates (resolved coins required). */
export function produced(tx: BuiltTx): Utxo[] {
  return tx.spec.outputs.map((o, index) => outputToUtxo(o, txin(tx.txHash, index)));
}

export function outputToUtxo(o: TxOut, ref: TxIn): Utxo {
  if (o.value.coin === "min") throw new Error("output coin is still 'min'");
  return utxo({
    ref,
    address: o.address,
    coin: o.value.coin,
    assets: o.value.assets,
    datumHash: o.datumHash,
    inlineDatum: o.inlineDatum,
    scriptRef: o.scriptRef,
  });
}

export function findUtxo(ctx: ChainContext, ref: TxIn): Utxo | undefined {
  return ctx.utxos.find((u) => u.ref.txHash === ref.txHash && u.ref.index === ref.index);
}

/** What the builder needs from a context (address + reference script of an input). */
export function envOf(ctx: ChainContext): { params: ProtocolParameters; utxo: (i: TxIn) => Utxo | undefined } {
  return { params: ctx.params, utxo: (i) => findUtxo(ctx, i) };
}

/** The address text the validator expects: bech32 for Shelley addresses, base58 for Byron ones (raw bytes with header 0x8_). */
export function addressText(a: AddressLike): string {
  if (typeof a === "string") return a;
  if (a instanceof Uint8Array) return a[0]! >> 4 === 8 ? base58Encode(a) : parseAddress(a).bech32;
  return a.bech32;
}

export function utxoInputContext(u: Utxo): UtxoInputContext {
  const inline = u.inlineDatum === undefined ? null : bytesToHex(datumBytes(u.inlineDatum));
  return {
    utxo: {
      input: { txHash: u.ref.txHash, outputIndex: u.ref.index },
      output: {
        address: addressText(u.address),
        amount: toAmountList(u.value),
        dataHash: u.datumHash ?? null,
        plutusData: inline,
        scriptRef: u.scriptRef ? bytesToHex(encodeScriptCbor(u.scriptRef)) : null,
        scriptHash: u.scriptRef ? scriptHash(u.scriptRef) : null,
      },
    },
    isSpent: u.isSpent ?? false,
  };
}

const encodeScriptCbor = (s: Script): Uint8Array => encode(scriptCbor(s));

/** The ValidationInputContext cquisitor-lib's `validate_transaction_js` reads. */
export function toValidationInputContext(ctx: ChainContext): ValidationInputContext {
  return {
    utxoSet: ctx.utxos.map(utxoInputContext),
    protocolParameters: ctx.params,
    slot: ctx.slot,
    accountContexts: ctx.accounts ?? [],
    drepContexts: ctx.dreps ?? [],
    poolContexts: ctx.pools ?? [],
    govActionContexts: ctx.govActions ?? [],
    lastEnactedGovAction: ctx.lastEnacted ?? [],
    currentCommitteeMembers: ctx.committee ?? [],
    potentialCommitteeMembers: ctx.potentialCommittee ?? [],
    treasuryValue: ctx.treasury ?? 0n,
    networkType: ctx.network,
    constitution: ctx.constitution ?? null,
  };
}

/** The JSON text the validator reads: bigint as bare integers, keys sorted. */
export function contextJson(ctx: ChainContext | ValidationInputContext): string {
  const value = "utxoSet" in ctx ? ctx : toValidationInputContext(ctx);
  const text = stringify(value);
  if (text === undefined) throw new Error("context did not serialise");
  return text;
}

// ---------------------------------------------------------------- governance / account state builders

/** A registered stake account (`stake1...` text from the credential). */
export function accountContext(o: {
  cred: Credential;
  network?: "mainnet" | "testnet";
  registered?: boolean;
  deposit?: number | null;
  drep?: string | null;
  pool?: string | null;
  balance?: number | null;
}): AccountInputContext {
  return {
    bech32Address: rewardAddress(o.network ?? "mainnet", o.cred).bech32,
    isRegistered: o.registered ?? true,
    payedDeposit: o.deposit === undefined ? 2_000_000 : o.deposit,
    delegatedToDrep: o.drep ?? null,
    delegatedToPool: o.pool ?? null,
    balance: o.balance === undefined ? 0 : o.balance,
  };
}

export function drepContext(cred: Credential, o: { registered?: boolean; deposit?: number | null } = {}): DrepInputContext {
  return { bech32Drep: drepIdBech32(cred), isRegistered: o.registered ?? true, payedDeposit: o.deposit === undefined ? 500_000_000 : o.deposit };
}

export function poolContext(poolHash: string, o: { registered?: boolean; retirementEpoch?: number | null } = {}): PoolInputContext {
  return { poolId: poolHash, isRegistered: o.registered ?? true, retirementEpoch: o.retirementEpoch ?? null };
}

export type GovActionKind = GovActionInputContext["actionType"];

export function govActionContext(txHash: string, index: number, actionType: GovActionKind, o: { isActive?: boolean; changedParameters?: string[] } = {}): GovActionInputContext {
  return {
    actionId: { txHash: Array.from(hexToBytes(txHash)), index },
    actionType,
    isActive: o.isActive ?? true,
    ...(o.changedParameters ? { changedParameters: o.changedParameters } : {}),
  };
}

export function committeeMember(cold: Credential, hot: Credential | null, o: { resigned?: boolean } = {}): CommitteeInputContext {
  const lc = (c: Credential) => (c.kind === "key" ? { keyHash: Array.from(c.hash) } : { scriptHash: Array.from(c.hash) });
  return { committeeMemberCold: lc(cold), committeeMemberHot: hot ? lc(hot) : null, isResigned: o.resigned ?? false };
}
