// The Conway transaction builder: a plain `TxSpec` (what the transaction says) goes in, a `BuiltTx` (exact bytes,
// tx id, byte spans, resolved redeemer indices) comes out. Byte-exact and canonical by default; any odd encoding the
// CBOR tests want (plain arrays vs tag 258 per field, legacy vs map outputs, array vs map redeemers, indefinite
// containers, forced integer widths, reordered or extra body keys) is an option or a hook, never a post-hoc edit.
//
// Redeemers name their target (`{tag: "spend", input}`, `{tag: "mint", policy}` ...) and get their index from the
// ledger's ordering of inputs / policies / withdrawals / voters, so a scenario never counts positions by hand.
// Fees, balancing, ex-units and the script data hash are `fit.ts`'s job; here they are plain fields.

import type { ProtocolParameters } from "@cardananium/cquisitor-lib";

import { blake2b256 } from "./blake2b.js";
import { type Address, type Credential, parseAddress } from "./address.js";
import { bytesToHex, compareBytes, hexToBytes, toBytes } from "./bytes.js";
import {
  array,
  bool,
  bytes as cbytes,
  encode,
  encodeWithSpans,
  int,
  itemEnd,
  mark,
  map as cmap,
  NULL,
  raw,
  sortedMap,
  tag,
  text,
  TRUE,
  uint,
  type Cbor,
  type CMap,
  type Span,
  type Width,
} from "./cbor.js";
import { type PlutusData, plutusDataToCbor, encodePlutusData } from "./plutusData.js";
import { vkeyWitness, type KeyPair } from "./keys.js";
import { type PlutusVersion, type Script, hashScriptBytes, nativeScriptCbor, scriptCbor, scriptHash, type NativeScript, type PlutusScript } from "./script.js";
import { scriptDataHash as computeScriptDataHash } from "./scriptData.js";
import { type Assets, sortedAssets, type Value } from "./value.js";

// ---------------------------------------------------------------- spec types

export interface TxIn {
  txHash: string;
  index: number;
}

export const txin = (txHash: string, index: number): TxIn => ({ txHash: txHash.toLowerCase(), index });
export const refOf = (i: TxIn): string => `${i.txHash}#${i.index}`;
export const sameIn = (a: TxIn, b: TxIn): boolean => a.txHash === b.txHash && a.index === b.index;
export function parseRef(ref: string): TxIn {
  const [h, i] = ref.split("#");
  return txin(h!, Number(i));
}

/** A Shelley address object, bech32 / hex text, or raw address bytes (Byron). */
export type AddressLike = Address | string | Uint8Array;

export function addressBytes(a: AddressLike): Uint8Array {
  if (typeof a === "string") return parseAddress(a).bytes;
  if (a instanceof Uint8Array) return a;
  return a.bytes;
}

export type DatumData = PlutusData | Uint8Array | string;

export interface TxOut {
  address: AddressLike;
  /** `coin: "min"` is resolved to the minimum UTxO value by `fit` / `resolveMinCoins`. */
  value: { coin: bigint | "min"; assets?: Assets };
  datumHash?: string;
  inlineDatum?: DatumData;
  scriptRef?: Script;
  /** `legacy` = `[address, value, datum_hash?]`; `map` = post-Alonzo map. Default: map when an inline datum or script ref is present, else legacy. */
  form?: "legacy" | "map";
  /** `fit` puts the balancing amount here (exactly one output may be the change output). */
  change?: boolean;
  /** Free text for scenario code; not encoded. */
  label?: string;
}

export interface Anchor {
  url: string;
  /** 32-byte hash, hex */
  hash: string;
}

export type DRep = { kind: "key"; hash: string } | { kind: "script"; hash: string } | { kind: "abstain" } | { kind: "noConfidence" };

export type Cert =
  | { kind: "stakeReg"; cred: Credential; deposit?: bigint }
  | { kind: "stakeDereg"; cred: Credential; deposit?: bigint }
  | { kind: "stakeDelegate"; cred: Credential; pool: string }
  | { kind: "poolRetire"; pool: string; epoch: number }
  | { kind: "voteDelegate"; cred: Credential; drep: DRep }
  | { kind: "stakeVoteDelegate"; cred: Credential; pool: string; drep: DRep }
  | { kind: "stakeRegDelegate"; cred: Credential; pool: string; deposit: bigint }
  | { kind: "voteRegDelegate"; cred: Credential; drep: DRep; deposit: bigint }
  | { kind: "stakeVoteRegDelegate"; cred: Credential; pool: string; drep: DRep; deposit: bigint }
  | { kind: "committeeAuth"; cold: Credential; hot: Credential }
  | { kind: "committeeResign"; cold: Credential; anchor?: Anchor | null }
  | { kind: "drepReg"; cred: Credential; deposit: bigint; anchor?: Anchor | null }
  | { kind: "drepDereg"; cred: Credential; deposit: bigint }
  | { kind: "drepUpdate"; cred: Credential; anchor?: Anchor | null }
  | { kind: "raw"; cbor: Cbor };

export interface Withdrawal {
  account: AddressLike;
  amount: bigint;
}

export interface MintEntry {
  policy: string;
  /** asset name (hex) -> signed quantity */
  assets: Record<string, bigint>;
}

export type Voter = { kind: "cc"; cred: Credential } | { kind: "drep"; cred: Credential } | { kind: "spo"; hash: string };

export interface GovActionId {
  txHash: string;
  index: number;
}

export interface VoteEntry {
  voter: Voter;
  actions: Array<{ id: GovActionId; vote: 0 | 1 | 2; anchor?: Anchor | null }>;
}

export type GovAction =
  | { type: "parameterChange"; prev?: GovActionId | null; update: Array<[number, Cbor]>; policyHash?: string | null }
  | { type: "hardFork"; prev?: GovActionId | null; version: [number, number] }
  | { type: "treasuryWithdrawals"; withdrawals: Array<{ account: AddressLike; amount: bigint }>; policyHash?: string | null }
  | { type: "noConfidence"; prev?: GovActionId | null }
  | { type: "updateCommittee"; prev?: GovActionId | null; remove: Credential[]; add: Array<{ cred: Credential; epoch: number }>; threshold: [number, number] }
  | { type: "newConstitution"; prev?: GovActionId | null; anchor: Anchor; policyHash?: string | null }
  | { type: "info" };

export interface Proposal {
  deposit: bigint;
  rewardAccount: AddressLike;
  action: GovAction;
  anchor: Anchor;
}

/** What a redeemer is aimed at; the index is resolved from the ledger's ordering. */
export type RedeemerTarget =
  | { tag: "spend"; input: TxIn }
  | { tag: "mint"; policy: string }
  | { tag: "cert"; index: number }
  | { tag: "reward"; account: AddressLike }
  | { tag: "vote"; voter: Voter }
  | { tag: "propose"; index: number }
  /** Aim by raw tag number / index (a deliberately wrong or out-of-range target). */
  | { tag: "raw"; redeemerTag: number; index: number };

export interface ExUnits {
  mem: bigint | number;
  steps: bigint | number;
}

export interface RedeemerSpec {
  target: RedeemerTarget;
  data: DatumData;
  exUnits: ExUnits;
}

export type Metadatum = bigint | number | string | Uint8Array | Metadatum[] | Map<Metadatum, Metadatum>;

export interface AuxData {
  metadata?: Array<[bigint | number, Metadatum]>;
  nativeScripts?: NativeScript[];
  plutusScripts?: PlutusScript[];
  /** `shelley` = bare metadata map; `array` = `[metadata, scripts]`; `map` = tag 259. Default: shelley without scripts, map with. */
  format?: "shelley" | "array" | "map";
}

export type SetField = "inputs" | "collateral" | "referenceInputs" | "requiredSigners" | "certs" | "proposals" | "vkeys" | "nativeScripts" | "v1" | "v2" | "v3" | "datums";

export interface EncodingOptions {
  /** Tag 258 on the set fields: all (true), none (false) or per field. Default: only the witness datums (see `setOn`). */
  sets?: boolean | Partial<Record<SetField, boolean>>;
  /** Redeemers as the Conway map (default) or the legacy array. */
  redeemers?: "map" | "array";
  /** Keep the order of inputs / mint policies / withdrawals / voters as given instead of the ledger's (breaks redeemer indices; for odd-encoding tests). */
  keepOrder?: boolean;
  /** Indefinite-length containers: the whole tx array, body map, witness map, outputs array, inputs array, datums array. */
  indefinite?: Partial<Record<"tx" | "body" | "witnessSet" | "outputs" | "inputs" | "datums" | "redeemers" | "vkeys", boolean>>;
  /** Forced integer head widths. */
  widths?: Partial<Record<"fee" | "ttl" | "validityStart" | "treasury" | "donation" | "totalCollateral", Width>>;
  /** Body map key order (numeric keys); keys not listed follow ascending. */
  bodyKeyOrder?: number[];
  /** Extra / replacement body entries applied last (before encoding and signing). */
  onBody?: (entries: Array<[Cbor, Cbor]>) => Array<[Cbor, Cbor]>;
  onWitnessSet?: (entries: Array<[Cbor, Cbor]>) => Array<[Cbor, Cbor]>;
  /** Rewrite the finished `[body, witnesses, is_valid, aux]` item (body hash and signatures are computed before this hook). */
  onTx?: (tx: Cbor) => Cbor;
}

export interface TxSpec {
  inputs: TxIn[];
  referenceInputs?: TxIn[];
  outputs: TxOut[];
  fee?: bigint;
  ttl?: bigint;
  validityStart?: bigint;
  certs?: Cert[];
  withdrawals?: Withdrawal[];
  mint?: MintEntry[];
  aux?: AuxData;
  collateral?: TxIn[];
  collateralReturn?: TxOut;
  totalCollateral?: bigint;
  requiredSigners?: string[];
  /** `network_id` field of the body (0 / 1). */
  networkId?: 0 | 1;
  votes?: VoteEntry[];
  proposals?: Proposal[];
  treasuryValue?: bigint;
  donation?: bigint;

  // witnesses
  /** Keys that sign the body (one vkey witness each, in this order). */
  signers?: KeyPair[];
  /** Extra vkey witnesses as given, `[vkey, signature]` bytes (wrong signatures, foreign keys ...). */
  extraVkeyWitnesses?: Array<[Uint8Array, Uint8Array]>;
  nativeScripts?: NativeScript[];
  /** Pre-encoded native scripts (CBOR bytes), e.g. `deepNativeScriptBytes(10_000, ...)` that the recursive builder cannot encode. */
  rawNativeScripts?: Uint8Array[];
  plutusScripts?: PlutusScript[];
  datums?: DatumData[];
  redeemers?: RedeemerSpec[];
  isValid?: boolean;
  /** `auto` (default): computed when there are redeemers / datums and parameters were given; a hex string forces it; `null` omits it. */
  scriptDataHash?: "auto" | string | null;
  /** Languages in the language views (default: derived from the scripts the redeemers need). */
  languages?: PlutusVersion[];
  /** Encode the aux data hash even when the aux data is absent (explicit hex), for mismatch tests. */
  auxDataHash?: string;

  encoding?: EncodingOptions;
}

// ---------------------------------------------------------------- environment

/** What a resolved UTxO looks like to the builder (full definition in context.ts). */
export interface UtxoLike {
  address: AddressLike;
  scriptRef?: Script;
}

export interface AssembleEnv {
  /** Needed for the script data hash (cost models). */
  params?: ProtocolParameters;
  /** Lookup of spent / reference inputs (addresses and reference scripts) for the language derivation. */
  utxo?: (input: TxIn) => UtxoLike | undefined;
}

export interface ResolvedRedeemer {
  tagNumber: number;
  index: number;
  target: RedeemerTarget;
  dataBytes: Uint8Array;
  exUnits: { mem: bigint; steps: bigint };
}

export interface BuiltTx {
  spec: TxSpec;
  bytes: Uint8Array;
  hex: string;
  /** blake2b-256 of the body bytes (hex). */
  txHash: string;
  bodyBytes: Uint8Array;
  witnessSetBytes: Uint8Array;
  /** Absolute byte spans: `tx`, `body`, `body.key.N`, `body.N`, `witnesses`, `witness.N`, `witness.redeemers.i`, `is_valid`, `aux`. */
  spans: Record<string, Span>;
  size: number;
  /** Inputs in ledger order (the order spend redeemer indices count in). */
  inputs: TxIn[];
  mintPolicies: string[];
  withdrawalAccounts: Uint8Array[];
  voters: Voter[];
  redeemers: ResolvedRedeemer[];
  languages: PlutusVersion[];
  scriptDataHash?: string;
  auxDataHash?: string;
  /** Script hashes of every script the transaction carries in its witness set. */
  witnessScriptHashes: string[];
}

// ---------------------------------------------------------------- ordering (ledger Ord)

export const compareIns = (a: TxIn, b: TxIn): number => compareBytes(hexToBytes(a.txHash), hexToBytes(b.txHash)) || a.index - b.index;

export function sortIns(ins: readonly TxIn[]): TxIn[] {
  return [...ins].sort(compareIns);
}

/** Ledger order of reward accounts: network, then credential with scripts before keys, then hash. */
export function compareAccounts(a: Uint8Array, b: Uint8Array): number {
  const net = (a[0]! & 0x0f) - (b[0]! & 0x0f);
  if (net !== 0) return net;
  const kind = (x: Uint8Array) => (x[0]! & 0x10 ? 0 : 1); // header bit 4: script
  const k = kind(a) - kind(b);
  if (k !== 0) return k;
  return compareBytes(a.subarray(1), b.subarray(1));
}

function voterGroup(v: Voter): number {
  return v.kind === "cc" ? 0 : v.kind === "drep" ? 1 : 2;
}

export function compareVoters(a: Voter, b: Voter): number {
  const g = voterGroup(a) - voterGroup(b);
  if (g !== 0) return g;
  if (a.kind === "spo" && b.kind === "spo") return compareBytes(hexToBytes(a.hash), hexToBytes(b.hash));
  const ca = (a as { cred: Credential }).cred;
  const cb = (b as { cred: Credential }).cred;
  const k = (ca.kind === "script" ? 0 : 1) - (cb.kind === "script" ? 0 : 1);
  return k !== 0 ? k : compareBytes(ca.hash, cb.hash);
}

export function voterCbor(v: Voter): Cbor {
  if (v.kind === "spo") return array([uint(4), cbytes(v.hash)]);
  const base = v.kind === "cc" ? 0 : 2;
  return array([uint(base + (v.cred.kind === "script" ? 1 : 0)), cbytes(v.cred.hash)]);
}

// ---------------------------------------------------------------- pieces

/**
 * Tag 258 on a set field. Default: none, except the witness datums, which the validator only accepts with the tag
 * (it rebuilds the script data hash with `#6.258([* datum])` whatever the bytes say); `sets: {datums: false}` forces a plain array.
 */
const setOn = (enc: EncodingOptions | undefined, field: SetField): boolean => {
  const s = enc?.sets;
  if (s === undefined) return field === "datums";
  if (typeof s === "boolean") return s;
  return s[field] ?? field === "datums";
};

function setItem(items: Cbor[], tagged: boolean, indefinite = false): Cbor {
  const arr = array(items, { indefinite });
  return tagged ? tag(258, arr) : arr;
}

export function credentialCbor(c: Credential): Cbor {
  return array([uint(c.kind === "script" ? 1 : 0), cbytes(c.hash)]);
}

function drepCbor(d: DRep): Cbor {
  switch (d.kind) {
    case "key":
      return array([uint(0), cbytes(d.hash)]);
    case "script":
      return array([uint(1), cbytes(d.hash)]);
    case "abstain":
      return array([uint(2)]);
    case "noConfidence":
      return array([uint(3)]);
  }
}

export function anchorCbor(a: Anchor | null | undefined): Cbor {
  return a ? array([text(a.url), cbytes(a.hash)]) : NULL;
}

export function certCbor(c: Cert): Cbor {
  const n = (x: number) => uint(x);
  switch (c.kind) {
    case "stakeReg":
      return c.deposit === undefined ? array([n(0), credentialCbor(c.cred)]) : array([n(7), credentialCbor(c.cred), uint(c.deposit)]);
    case "stakeDereg":
      return c.deposit === undefined ? array([n(1), credentialCbor(c.cred)]) : array([n(8), credentialCbor(c.cred), uint(c.deposit)]);
    case "stakeDelegate":
      return array([n(2), credentialCbor(c.cred), cbytes(c.pool)]);
    case "poolRetire":
      return array([n(4), cbytes(c.pool), uint(c.epoch)]);
    case "voteDelegate":
      return array([n(9), credentialCbor(c.cred), drepCbor(c.drep)]);
    case "stakeVoteDelegate":
      return array([n(10), credentialCbor(c.cred), cbytes(c.pool), drepCbor(c.drep)]);
    case "stakeRegDelegate":
      return array([n(11), credentialCbor(c.cred), cbytes(c.pool), uint(c.deposit)]);
    case "voteRegDelegate":
      return array([n(12), credentialCbor(c.cred), drepCbor(c.drep), uint(c.deposit)]);
    case "stakeVoteRegDelegate":
      return array([n(13), credentialCbor(c.cred), cbytes(c.pool), drepCbor(c.drep), uint(c.deposit)]);
    case "committeeAuth":
      return array([n(14), credentialCbor(c.cold), credentialCbor(c.hot)]);
    case "committeeResign":
      return array([n(15), credentialCbor(c.cold), anchorCbor(c.anchor)]);
    case "drepReg":
      return array([n(16), credentialCbor(c.cred), uint(c.deposit), anchorCbor(c.anchor)]);
    case "drepDereg":
      return array([n(17), credentialCbor(c.cred), uint(c.deposit)]);
    case "drepUpdate":
      return array([n(18), credentialCbor(c.cred), anchorCbor(c.anchor)]);
    case "raw":
      return c.cbor;
  }
}

/** The credential a certificate needs a witness for (script certificates need a redeemer). */
export function certWitnessCredential(c: Cert): Credential | undefined {
  switch (c.kind) {
    case "stakeDereg":
    case "stakeDelegate":
    case "voteDelegate":
    case "stakeVoteDelegate":
    case "stakeRegDelegate":
    case "voteRegDelegate":
    case "stakeVoteRegDelegate":
    case "drepDereg":
    case "drepUpdate":
      return c.cred;
    case "stakeReg":
      return c.deposit === undefined ? undefined : c.cred;
    case "poolRetire":
      return { kind: "key", hash: hexToBytes(c.pool) };
    case "committeeAuth":
    case "committeeResign":
      return "cold" in c ? c.cold : undefined;
    case "drepReg":
      return c.cred;
    default:
      return undefined;
  }
}

export function datumBytes(d: DatumData): Uint8Array {
  if (typeof d === "string") return hexToBytes(d);
  if (d instanceof Uint8Array) return d;
  return encodePlutusData(d);
}

function datumCbor(d: DatumData): Cbor {
  return typeof d === "object" && !(d instanceof Uint8Array) ? plutusDataToCbor(d) : raw(datumBytes(d));
}

export function multiassetCbor(assets: Assets | undefined, signed = false): CMap {
  const entries = sortedAssets(assets).map(
    ([p, names]) => [cbytes(p), cmap(names.map(([n, q]) => [cbytes(n), signed ? int(q) : uint(q)] as [Cbor, Cbor]))] as [Cbor, Cbor],
  );
  return cmap(entries);
}

export function valueCbor(coin: bigint, assets?: Assets): Cbor {
  const hasAny = sortedAssets(assets).length > 0;
  return hasAny ? array([uint(coin), multiasset(assets)]) : uint(coin);
}

const multiasset = (a: Assets | undefined): CMap => multiassetCbor(a);

/** Encode an output in its chosen form (coin must be resolved). */
export function outputCbor(out: TxOut): Cbor {
  if (out.value.coin === "min") throw new Error("output coin is still 'min': resolve it with resolveMinCoins / fit first");
  const coin = out.value.coin;
  const addr = cbytes(addressBytes(out.address));
  const hasInline = out.inlineDatum !== undefined;
  const form = out.form ?? (hasInline || out.scriptRef ? "map" : "legacy");
  if (form === "legacy") {
    if (hasInline || out.scriptRef) throw new Error("a legacy output cannot carry an inline datum or a script reference");
    const items: Cbor[] = [addr, valueCbor(coin, out.value.assets)];
    if (out.datumHash) items.push(cbytes(out.datumHash));
    return array(items);
  }
  const entries: Array<[Cbor, Cbor]> = [
    [uint(0), addr],
    [uint(1), valueCbor(coin, out.value.assets)],
  ];
  if (out.datumHash && hasInline) throw new Error("an output has either a datum hash or an inline datum");
  if (out.datumHash) entries.push([uint(2), array([uint(0), cbytes(out.datumHash)])]);
  if (hasInline) entries.push([uint(2), array([uint(1), tag(24, cbytes(datumBytes(out.inlineDatum!)))])]);
  if (out.scriptRef) entries.push([uint(3), tag(24, cbytes(encode(scriptCbor(out.scriptRef))))]);
  return cmap(entries);
}

export function metadatumCbor(m: Metadatum, path = "metadatum"): Cbor {
  if (typeof m === "number" || typeof m === "bigint") return int(m);
  if (typeof m === "string") {
    if (new TextEncoder().encode(m).length > 64) throw new Error(`${path}: metadatum text is over 64 bytes`);
    return text(m);
  }
  if (m instanceof Uint8Array) {
    if (m.length > 64) throw new Error(`${path}: metadatum bytes are over 64 bytes`);
    return cbytes(m);
  }
  if (Array.isArray(m)) return array(m.map((x, i) => metadatumCbor(x, `${path}[${i}]`)));
  return cmap(Array.from(m.entries()).map(([k, v]) => [metadatumCbor(k, `${path}.key`), metadatumCbor(v, `${path}.value`)] as [Cbor, Cbor]));
}

function metadataMapCbor(meta: Array<[bigint | number, Metadatum]>): Cbor {
  const sorted = [...meta].sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : BigInt(a[0]) > BigInt(b[0]) ? 1 : 0));
  return cmap(sorted.map(([label, v]) => [uint(label), metadatumCbor(v, `metadata[${label}]`)] as [Cbor, Cbor]));
}

export function auxDataCbor(aux: AuxData): Cbor {
  const meta = aux.metadata ?? [];
  const hasScripts = (aux.nativeScripts?.length ?? 0) + (aux.plutusScripts?.length ?? 0) > 0;
  const format = aux.format ?? (hasScripts ? "map" : "shelley");
  if (format === "shelley") return metadataMapCbor(meta);
  if (format === "array") return array([metadataMapCbor(meta), array((aux.nativeScripts ?? []).map(nativeScriptCbor))]);
  const entries: Array<[Cbor, Cbor]> = [];
  if (meta.length > 0) entries.push([uint(0), metadataMapCbor(meta)]);
  if (aux.nativeScripts?.length) entries.push([uint(1), array(aux.nativeScripts.map(nativeScriptCbor))]);
  for (const v of [1, 2, 3] as const) {
    const list = (aux.plutusScripts ?? []).filter((s) => s.version === v);
    if (list.length > 0) entries.push([uint(v + 1), array(list.map((s) => cbytes(s.bytes)))]);
  }
  return tag(259, cmap(entries));
}

export function auxDataHashOf(aux: AuxData): string {
  return bytesToHex(blake2b256(encode(auxDataCbor(aux))));
}

function govActionIdCbor(id: GovActionId | null | undefined): Cbor {
  return id ? array([cbytes(id.txHash), uint(id.index)]) : NULL;
}

function govActionCbor(a: GovAction): Cbor {
  switch (a.type) {
    case "parameterChange":
      return array([uint(0), govActionIdCbor(a.prev), sortedMap(a.update.map(([k, v]) => [uint(k), v] as [Cbor, Cbor])), a.policyHash ? cbytes(a.policyHash) : NULL]);
    case "hardFork":
      return array([uint(1), govActionIdCbor(a.prev), array([uint(a.version[0]), uint(a.version[1])])]);
    case "treasuryWithdrawals": {
      const sorted = [...a.withdrawals].sort((x, y) => compareAccounts(addressBytes(x.account), addressBytes(y.account)));
      return array([uint(2), cmap(sorted.map((w) => [cbytes(addressBytes(w.account)), uint(w.amount)] as [Cbor, Cbor])), a.policyHash ? cbytes(a.policyHash) : NULL]);
    }
    case "noConfidence":
      return array([uint(3), govActionIdCbor(a.prev)]);
    case "updateCommittee":
      return array([
        uint(4),
        govActionIdCbor(a.prev),
        array(a.remove.map(credentialCbor)),
        cmap(a.add.map((x) => [credentialCbor(x.cred), uint(x.epoch)] as [Cbor, Cbor])),
        tag(30, array([uint(a.threshold[0]), uint(a.threshold[1])])),
      ]);
    case "newConstitution":
      return array([uint(5), govActionIdCbor(a.prev), array([anchorCbor(a.anchor), a.policyHash ? cbytes(a.policyHash) : NULL])]);
    case "info":
      return array([uint(6)]);
  }
}

export function proposalCbor(p: Proposal): Cbor {
  return array([uint(p.deposit), cbytes(addressBytes(p.rewardAccount)), govActionCbor(p.action), anchorCbor(p.anchor)]);
}

const REDEEMER_TAG = { spend: 0, mint: 1, cert: 2, reward: 3, vote: 4, propose: 5 } as const;

// ---------------------------------------------------------------- assemble

function pushIf(entries: Array<[Cbor, Cbor]>, key: number, value: Cbor | undefined, label = true): void {
  if (value === undefined) return;
  entries.push([label ? mark(`body.key.${key}`, uint(key)) : uint(key), label ? mark(`body.${key}`, value) : value]);
}

/** Ledger-ordered views of a spec (the order redeemer indices count in). */
export function orderedViews(spec: TxSpec): { inputs: TxIn[]; policies: string[]; withdrawals: Withdrawal[]; voters: VoteEntry[] } {
  const keep = spec.encoding?.keepOrder === true;
  return {
    inputs: keep ? [...spec.inputs] : sortIns(spec.inputs),
    policies: keep ? (spec.mint ?? []).map((m) => m.policy) : (spec.mint ?? []).map((m) => m.policy).sort((a, b) => compareBytes(hexToBytes(a), hexToBytes(b))),
    withdrawals: keep ? [...(spec.withdrawals ?? [])] : [...(spec.withdrawals ?? [])].sort((a, b) => compareAccounts(addressBytes(a.account), addressBytes(b.account))),
    voters: keep ? [...(spec.votes ?? [])] : [...(spec.votes ?? [])].sort((a, b) => compareVoters(a.voter, b.voter)),
  };
}

/** Index of a redeemer target in the ledger's ordering (throws when the target is not part of the transaction). */
export function resolveTarget(spec: TxSpec, target: RedeemerTarget): { tagNumber: number; index: number } {
  const views = orderedViews(spec);
  switch (target.tag) {
    case "spend": {
      const i = views.inputs.findIndex((x) => sameIn(x, target.input));
      if (i < 0) throw new Error(`spend redeemer targets ${refOf(target.input)}, which is not an input of the transaction`);
      return { tagNumber: 0, index: i };
    }
    case "mint": {
      const i = views.policies.indexOf(target.policy.toLowerCase());
      if (i < 0) throw new Error(`mint redeemer targets policy ${target.policy}, which the transaction does not mint`);
      return { tagNumber: 1, index: i };
    }
    case "cert":
      return { tagNumber: 2, index: target.index };
    case "reward": {
      const bytes = addressBytes(target.account);
      const i = views.withdrawals.findIndex((w) => compareBytes(addressBytes(w.account), bytes) === 0);
      if (i < 0) throw new Error(`reward redeemer targets ${bytesToHex(bytes)}, which the transaction does not withdraw from`);
      return { tagNumber: 3, index: i };
    }
    case "vote": {
      const i = views.voters.findIndex((v) => compareVoters(v.voter, target.voter) === 0);
      if (i < 0) throw new Error("vote redeemer targets a voter that does not vote in the transaction");
      return { tagNumber: 4, index: i };
    }
    case "propose":
      return { tagNumber: 5, index: target.index };
    case "raw":
      return { tagNumber: target.redeemerTag, index: target.index };
  }
}

/** Hashes of the scripts the redeemers need (derivable ones): spend via the input's address, mint, reward, cert, vote, propose. */
function neededHashes(spec: TxSpec, env: AssembleEnv): Set<string> {
  const need = new Set<string>();
  for (const r of spec.redeemers ?? []) {
    const t = r.target;
    switch (t.tag) {
      case "spend": {
        const u = env.utxo?.(t.input);
        if (u) {
          const a = parseAddress(addressBytes(u.address));
          if (a.payment?.kind === "script") need.add(bytesToHex(a.payment.hash));
        }
        break;
      }
      case "mint":
        need.add(t.policy.toLowerCase());
        break;
      case "reward": {
        const a = parseAddress(addressBytes(t.account));
        if (a.stake?.kind === "script") need.add(bytesToHex(a.stake.hash));
        break;
      }
      case "cert": {
        const c = spec.certs?.[t.index];
        const cred = c ? certWitnessCredential(c) : undefined;
        if (cred?.kind === "script") need.add(bytesToHex(cred.hash));
        break;
      }
      case "vote":
        if (t.voter.kind !== "spo" && t.voter.cred.kind === "script") need.add(bytesToHex(t.voter.cred.hash));
        break;
      case "propose": {
        const p = spec.proposals?.[t.index];
        const hash = p && "policyHash" in p.action ? p.action.policyHash : undefined;
        if (hash) need.add(hash.toLowerCase());
        break;
      }
      default:
        break;
    }
  }
  return need;
}

function deriveLanguages(spec: TxSpec, env: AssembleEnv): PlutusVersion[] {
  if (spec.languages) return [...spec.languages];
  const need = neededHashes(spec, env);
  const found = new Set<PlutusVersion>();
  const consider = (s: Script | undefined) => {
    if (s && s.kind === "plutus" && need.has(scriptHash(s))) found.add(s.version);
  };
  for (const s of spec.plutusScripts ?? []) consider(s);
  for (const i of [...(spec.referenceInputs ?? []), ...spec.inputs]) consider(env.utxo?.(i)?.scriptRef);
  return Array.from(found).sort();
}

export function assemble(spec: TxSpec, env: AssembleEnv = {}): BuiltTx {
  const enc = spec.encoding;
  const views = orderedViews(spec);
  const ind = (k: keyof NonNullable<EncodingOptions["indefinite"]>): boolean => enc?.indefinite?.[k] === true;

  // ---- redeemers and datums (their exact bytes feed the script data hash)
  const resolved: ResolvedRedeemer[] = (spec.redeemers ?? []).map((r) => {
    const { tagNumber, index } = resolveTarget(spec, r.target);
    return { tagNumber, index, target: r.target, dataBytes: datumBytes(r.data), exUnits: { mem: BigInt(r.exUnits.mem), steps: BigInt(r.exUnits.steps) } };
  });
  const sortedRedeemers = [...resolved].sort((a, b) => a.tagNumber - b.tagNumber || a.index - b.index);
  const redeemersItem: Cbor | undefined =
    sortedRedeemers.length === 0
      ? undefined
      : (enc?.redeemers ?? "map") === "map"
        ? cmap(
            sortedRedeemers.map(
              (r, i) =>
                [array([uint(r.tagNumber), uint(r.index)]), mark(`witness.redeemers.${i}`, array([raw(r.dataBytes), array([uint(r.exUnits.mem), uint(r.exUnits.steps)])]))] as [Cbor, Cbor],
            ),
            { indefinite: ind("redeemers") },
          )
        : array(
            sortedRedeemers.map((r, i) => mark(`witness.redeemers.${i}`, array([uint(r.tagNumber), uint(r.index), raw(r.dataBytes), array([uint(r.exUnits.mem), uint(r.exUnits.steps)])]))),
            { indefinite: ind("redeemers") },
          );
  const datumsItem: Cbor | undefined = spec.datums?.length ? setItem(spec.datums.map(datumCbor), setOn(enc, "datums"), ind("datums")) : undefined;

  const languages = deriveLanguages(spec, env);
  let scriptDataHash: string | undefined;
  if (spec.scriptDataHash === null) scriptDataHash = undefined;
  else if (typeof spec.scriptDataHash === "string" && spec.scriptDataHash !== "auto") scriptDataHash = spec.scriptDataHash;
  else if ((redeemersItem || datumsItem) && env.params) {
    scriptDataHash = computeScriptDataHash(
      { redeemers: redeemersItem ? encode(redeemersItem) : undefined, datums: datumsItem ? encode(datumsItem) : undefined, languages },
      env.params,
    );
  }

  // ---- aux data
  let auxItem: Cbor | undefined;
  let auxDataHash: string | undefined = spec.auxDataHash;
  if (spec.aux) {
    auxItem = auxDataCbor(spec.aux);
    auxDataHash ??= bytesToHex(blake2b256(encode(auxItem)));
  }

  // ---- body
  const entries: Array<[Cbor, Cbor]> = [];
  const fee = spec.fee ?? 0n;
  pushIf(entries, 0, setItem(views.inputs.map((i) => array([cbytes(i.txHash), uint(i.index)])), setOn(enc, "inputs"), ind("inputs")));
  pushIf(entries, 1, array(spec.outputs.map((o) => outputCbor(o)), { indefinite: ind("outputs") }));
  pushIf(entries, 2, uint(fee, enc?.widths?.fee));
  if (spec.ttl !== undefined) pushIf(entries, 3, uint(spec.ttl, enc?.widths?.ttl));
  if (spec.certs?.length) pushIf(entries, 4, setItem(spec.certs.map(certCbor), setOn(enc, "certs")));
  if (spec.withdrawals?.length) pushIf(entries, 5, cmap(views.withdrawals.map((w) => [cbytes(addressBytes(w.account)), uint(w.amount)] as [Cbor, Cbor])));
  if (auxDataHash) pushIf(entries, 7, cbytes(auxDataHash));
  if (spec.validityStart !== undefined) pushIf(entries, 8, uint(spec.validityStart, enc?.widths?.validityStart));
  if (spec.mint?.length) {
    const byPolicy = new Map(spec.mint.map((m) => [m.policy.toLowerCase(), m]));
    pushIf(
      entries,
      9,
      cmap(
        views.policies.map((p) => {
          const m = byPolicy.get(p)!;
          const names = Object.keys(m.assets).sort((a, b) => compareBytes(hexToBytes(a), hexToBytes(b)));
          return [cbytes(p), cmap(names.map((n) => [cbytes(n), int(m.assets[n]!)] as [Cbor, Cbor]))] as [Cbor, Cbor];
        }),
      ),
    );
  }
  if (scriptDataHash) pushIf(entries, 11, cbytes(scriptDataHash));
  if (spec.collateral?.length) pushIf(entries, 13, setItem(spec.collateral.map((i) => array([cbytes(i.txHash), uint(i.index)])), setOn(enc, "collateral")));
  if (spec.requiredSigners?.length) pushIf(entries, 14, setItem(spec.requiredSigners.map((h) => cbytes(h)), setOn(enc, "requiredSigners")));
  if (spec.networkId !== undefined) pushIf(entries, 15, uint(spec.networkId));
  if (spec.collateralReturn) pushIf(entries, 16, outputCbor(spec.collateralReturn));
  if (spec.totalCollateral !== undefined) pushIf(entries, 17, uint(spec.totalCollateral, enc?.widths?.totalCollateral));
  if (spec.referenceInputs?.length) pushIf(entries, 18, setItem(sortIns(spec.referenceInputs).map((i) => array([cbytes(i.txHash), uint(i.index)])), setOn(enc, "referenceInputs")));
  if (spec.votes?.length) {
    pushIf(
      entries,
      19,
      cmap(
        views.voters.map((v) => {
          const actions = [...v.actions].sort((a, b) => compareBytes(hexToBytes(a.id.txHash), hexToBytes(b.id.txHash)) || a.id.index - b.id.index);
          return [
            voterCbor(v.voter),
            cmap(actions.map((a) => [array([cbytes(a.id.txHash), uint(a.id.index)]), array([uint(a.vote), anchorCbor(a.anchor)])] as [Cbor, Cbor])),
          ] as [Cbor, Cbor];
        }),
      ),
    );
  }
  if (spec.proposals?.length) pushIf(entries, 20, setItem(spec.proposals.map(proposalCbor), setOn(enc, "proposals")));
  if (spec.treasuryValue !== undefined) pushIf(entries, 21, uint(spec.treasuryValue, enc?.widths?.treasury));
  if (spec.donation !== undefined) pushIf(entries, 22, uint(spec.donation, enc?.widths?.donation));

  let bodyEntries = entries;
  if (enc?.bodyKeyOrder) {
    const rank = (k: Cbor): number => {
      const inner = k.t === "mark" ? k.v : k;
      const n = inner.t === "uint" ? Number(inner.v) : 1e9;
      const i = enc.bodyKeyOrder!.indexOf(n);
      return i >= 0 ? i - 1000 : n;
    };
    bodyEntries = [...entries].sort((a, b) => rank(a[0]) - rank(b[0]));
  }
  if (enc?.onBody) bodyEntries = enc.onBody(bodyEntries);
  const bodyItem = cmap(bodyEntries, { indefinite: ind("body") });
  const bodyBytes = encode(bodyItem);
  const txHash = bytesToHex(blake2b256(bodyBytes));

  // ---- witness set
  const w: Array<[Cbor, Cbor]> = [];
  const wp = (key: number, v: Cbor) => w.push([uint(key), mark(`witness.${key}`, v)]);
  const signers = spec.signers ?? [];
  const vkeys: Cbor[] = signers.map((k) => vkeyWitness(k, hexToBytes(txHash)).cbor);
  for (const [vk, sig] of spec.extraVkeyWitnesses ?? []) vkeys.push(array([cbytes(vk), cbytes(sig)]));
  if (vkeys.length) wp(0, setItem(vkeys, setOn(enc, "vkeys"), ind("vkeys")));
  if (spec.nativeScripts?.length || spec.rawNativeScripts?.length)
    wp(1, setItem([...(spec.nativeScripts ?? []).map(nativeScriptCbor), ...(spec.rawNativeScripts ?? []).map((b) => raw(b))], setOn(enc, "nativeScripts")));
  const plutusOf = (v: PlutusVersion) => (spec.plutusScripts ?? []).filter((s) => s.version === v);
  if (plutusOf(1).length) wp(3, setItem(plutusOf(1).map((s) => cbytes(s.bytes)), setOn(enc, "v1")));
  if (datumsItem) wp(4, datumsItem);
  if (redeemersItem) wp(5, redeemersItem);
  if (plutusOf(2).length) wp(6, setItem(plutusOf(2).map((s) => cbytes(s.bytes)), setOn(enc, "v2")));
  if (plutusOf(3).length) wp(7, setItem(plutusOf(3).map((s) => cbytes(s.bytes)), setOn(enc, "v3")));
  const witnessEntries = enc?.onWitnessSet ? enc.onWitnessSet(w) : w;
  const witnessItem = cmap(witnessEntries, { indefinite: ind("witnessSet") });

  let txItem: Cbor = array(
    [mark("body", bodyItem), mark("witnesses", witnessItem), mark("is_valid", spec.isValid === false ? bool(false) : TRUE), mark("aux", auxItem ?? NULL)],
    { indefinite: ind("tx") },
  );
  if (enc?.onTx) txItem = enc.onTx(txItem);
  const { bytes, spans } = encodeWithSpans(txItem);

  const witnessScriptHashes = [
    ...(spec.nativeScripts ?? []).map((s) => scriptHash({ kind: "native", script: s })),
    ...(spec.rawNativeScripts ?? []).map((b) => hashScriptBytes(0, b)),
    ...(spec.plutusScripts ?? []).map((s) => scriptHash(s)),
  ];
  return {
    spec,
    bytes,
    hex: bytesToHex(bytes),
    txHash,
    bodyBytes,
    witnessSetBytes: encode(witnessItem),
    spans,
    size: bytes.length,
    inputs: views.inputs,
    mintPolicies: views.policies,
    withdrawalAccounts: views.withdrawals.map((x) => addressBytes(x.account)),
    voters: views.voters.map((v) => v.voter),
    redeemers: sortedRedeemers,
    languages,
    scriptDataHash,
    auxDataHash,
    witnessScriptHashes,
  };
}

/** Transaction id of tx bytes: blake2b-256 of the body item as it sits in the bytes (the first element of the tx array). */
export function txHashOfBytes(txBytes: Uint8Array | string): string {
  const b = toBytes(txBytes);
  const bodyStart = 1; // the tx array head is one byte (definite 4 or indefinite)
  return bytesToHex(blake2b256(b.subarray(bodyStart, itemEnd(b, bodyStart))));
}
