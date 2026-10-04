// Hand-built Plutus ScriptContexts (V2 and V3) for running the artificial scripts without a transaction: the same Plutus
// Data the ledger passes, assembled from plain TypeScript values. Used by scripts.test.ts to check every script's
// documented success and failure behaviour through the de-uplc engine. Not a transaction builder (that is the toolkit
// under test/fixtures/synthetic/lib): nothing here is hashed, signed or balanced.

import { constr, encodePlutusDataHex, pBytes, pInt, pList, pMap, type PlutusData } from "../../fixtures/synthetic/lib/plutusData.js";

export type Hex = string;
export type CredentialSpec = { key: Hex } | { script: Hex };

export interface ValueSpec {
  lovelace?: bigint | number;
  assets?: Array<{ policy: Hex; name: Hex; quantity: bigint | number }>;
}

export type DatumSpec = { none: true } | { hash: Hex } | { inline: PlutusData };

export interface OutputSpec {
  address: CredentialSpec;
  stake?: CredentialSpec;
  value: ValueSpec;
  datum?: DatumSpec;
  referenceScript?: Hex;
}

export interface InputSpec {
  txId: Hex;
  index: number;
  output: OutputSpec;
}

export interface TxSpec {
  inputs?: InputSpec[];
  referenceInputs?: InputSpec[];
  outputs?: OutputSpec[];
  fee?: bigint | number;
  mint?: ValueSpec;
  /** Required signers (key hashes). */
  signatories?: Hex[];
  /** Validity range in POSIX milliseconds; omitted = unbounded on that side. */
  validFrom?: number;
  validTo?: number;
  txId?: Hex;
  withdrawals?: Array<[CredentialSpec, bigint | number]>;
  /** V3 only: proposal procedures and votes are taken as ready Plutus Data. */
  proposals?: PlutusData[];
  votes?: Array<[PlutusData, Array<[PlutusData, PlutusData]>]>;
}

const FALSE = constr(0, []);
const TRUE = constr(1, []);
const just = (x: PlutusData): PlutusData => constr(0, [x]);
const nothing = constr(1, []);

export const credentialData = (c: CredentialSpec): PlutusData => ("key" in c ? constr(0, [pBytes(c.key)]) : constr(1, [pBytes(c.script)]));

export function addressData(payment: CredentialSpec, stake?: CredentialSpec): PlutusData {
  return constr(0, [credentialData(payment), stake ? just(constr(0, [credentialData(stake)])) : nothing]);
}

function bytesCompare(a: Hex, b: Hex): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A multi-asset Value: a map policy -> (map asset name -> quantity), ada under the empty policy, ascending. */
export function valueData(value: ValueSpec, options: { zeroAda?: boolean } = {}): PlutusData {
  const byPolicy = new Map<Hex, Map<Hex, bigint>>();
  const lovelace = value.lovelace === undefined ? (options.zeroAda ? 0n : undefined) : BigInt(value.lovelace);
  if (lovelace !== undefined) byPolicy.set("", new Map([["", lovelace]]));
  for (const asset of value.assets ?? []) {
    const names = byPolicy.get(asset.policy) ?? new Map<Hex, bigint>();
    names.set(asset.name, (names.get(asset.name) ?? 0n) + BigInt(asset.quantity));
    byPolicy.set(asset.policy, names);
  }
  const policies = [...byPolicy.keys()].sort(bytesCompare);
  return pMap(
    policies.map((policy) => [
      pBytes(policy),
      pMap(
        [...byPolicy.get(policy)!.entries()]
          .sort(([a], [b]) => bytesCompare(a, b))
          .map(([name, quantity]) => [pBytes(name), pInt(quantity)] as [PlutusData, PlutusData]),
      ),
    ]),
  );
}

function datumData(datum: DatumSpec | undefined): PlutusData {
  if (!datum || "none" in datum) return constr(0, []);
  if ("hash" in datum) return constr(1, [pBytes(datum.hash)]);
  return constr(2, [datum.inline]);
}

export function outputData(output: OutputSpec): PlutusData {
  return constr(0, [addressData(output.address, output.stake), valueData(output.value), datumData(output.datum), output.referenceScript ? just(pBytes(output.referenceScript)) : nothing]);
}

/** The output reference: V2 wraps the transaction id in a constructor, V3 uses the bare bytes. */
export function outRefData(txId: Hex, index: number, version: "V2" | "V3"): PlutusData {
  return constr(0, [version === "V2" ? constr(0, [pBytes(txId)]) : pBytes(txId), pInt(index)]);
}

const inputData = (input: InputSpec, version: "V2" | "V3"): PlutusData => constr(0, [outRefData(input.txId, input.index, version), outputData(input.output)]);

function intervalData(from: number | undefined, to: number | undefined): PlutusData {
  const lower = from === undefined ? constr(0, []) : constr(1, [pInt(from)]);
  const upper = to === undefined ? constr(2, []) : constr(1, [pInt(to)]);
  return constr(0, [constr(0, [lower, TRUE]), constr(0, [upper, TRUE])]);
}

const DEFAULT_TX_ID = "99".repeat(32);

function txInfoData(version: "V2" | "V3", tx: TxSpec): PlutusData {
  const common = [
    pList((tx.inputs ?? []).map((i) => inputData(i, version))),
    pList((tx.referenceInputs ?? []).map((i) => inputData(i, version))),
    pList((tx.outputs ?? []).map(outputData)),
  ];
  const withdrawals = pMap((tx.withdrawals ?? []).map(([cred, amount]) => [version === "V2" ? constr(0, [credentialData(cred)]) : credentialData(cred), pInt(amount)] as [PlutusData, PlutusData]));
  const range = intervalData(tx.validFrom, tx.validTo);
  const signatories = pList((tx.signatories ?? []).map((s) => pBytes(s)));
  const txId = tx.txId ?? DEFAULT_TX_ID;
  if (version === "V2") {
    return constr(0, [...common, valueData({ lovelace: tx.fee ?? 0 }), valueData(tx.mint ?? {}, { zeroAda: true }), pList([]), withdrawals, range, signatories, pMap([]), pMap([]), constr(0, [pBytes(txId)])]);
  }
  return constr(0, [
    ...common,
    pInt(tx.fee ?? 0),
    valueData(tx.mint ?? {}),
    pList([]),
    withdrawals,
    range,
    signatories,
    pMap([]),
    pMap([]),
    pBytes(txId),
    pMap((tx.votes ?? []).map(([voter, votes]) => [voter, pMap(votes)] as [PlutusData, PlutusData])),
    pList(tx.proposals ?? []),
    nothing,
    nothing,
  ]);
}

export type V2Purpose =
  | { minting: Hex }
  | { spending: { txId: Hex; index: number } }
  | { rewarding: CredentialSpec };

/** Plutus V2 ScriptContext, CBOR hex. */
export function v2Context(tx: TxSpec, purpose: V2Purpose): string {
  const purposeData =
    "minting" in purpose
      ? constr(0, [pBytes(purpose.minting)])
      : "spending" in purpose
        ? constr(1, [outRefData(purpose.spending.txId, purpose.spending.index, "V2")])
        : constr(2, [constr(0, [credentialData(purpose.rewarding)])]);
  return encodePlutusDataHex(constr(0, [txInfoData("V2", tx), purposeData]));
}

export type V3Info =
  | { minting: Hex }
  | { spending: { txId: Hex; index: number; datum?: PlutusData } }
  | { rewarding: CredentialSpec }
  | { voting: PlutusData }
  | { proposing: { index: number; proposal: PlutusData } };

/** Plutus V3 ScriptContext (transaction info, redeemer, script info), CBOR hex. */
export function v3Context(tx: TxSpec, redeemer: PlutusData, info: V3Info): string {
  let infoData: PlutusData;
  if ("minting" in info) infoData = constr(0, [pBytes(info.minting)]);
  else if ("spending" in info) infoData = constr(1, [outRefData(info.spending.txId, info.spending.index, "V3"), info.spending.datum ? just(info.spending.datum) : nothing]);
  else if ("rewarding" in info) infoData = constr(2, [credentialData(info.rewarding)]);
  else if ("voting" in info) infoData = constr(4, [info.voting]);
  else infoData = constr(5, [pInt(info.proposing.index), info.proposing.proposal]);
  return encodePlutusDataHex(constr(0, [txInfoData("V3", tx), redeemer, infoData]));
}

export const encode = encodePlutusDataHex;
export { constr, pBytes, pInt, pList, pMap };
export type { PlutusData };
export const BOOL = { FALSE, TRUE };
