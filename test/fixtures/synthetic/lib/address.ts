// Addresses and the other bech32 identifiers (CIP-5 / CIP-19 / CIP-129 / CIP-14), mainnet and testnet.
// Base, enterprise and reward addresses (no pointer addresses), plus a Byron-looking base58 address for the one
// test that wants a non-bech32 address. Everything is built from credentials, so a name in a scenario gives the
// same address in every run.

import { bech32 } from "bech32";

import { blake2b160 } from "./blake2b.js";
import { bytesToHex, concat, hexToBytes, toBytes } from "./bytes.js";
import { array, bytes as cbytes, encode, map as cmap, tag, uint } from "./cbor.js";
import { blake2b224 } from "./blake2b.js";
import type { KeyPair } from "./keys.js";

export type NetworkName = "mainnet" | "testnet";

export interface Credential {
  kind: "key" | "script";
  /** 28 bytes */
  hash: Uint8Array;
}

export const keyCred = (key: KeyPair | Uint8Array | string): Credential => ({ kind: "key", hash: hashOf(key) });
export const scriptCred = (hash: Uint8Array | string): Credential => ({ kind: "script", hash: toBytes(hash) });

function hashOf(key: KeyPair | Uint8Array | string): Uint8Array {
  const h = typeof key === "string" ? hexToBytes(key) : key instanceof Uint8Array ? key : key.keyHash;
  if (h.length !== 28) throw new Error(`a credential hash is 28 bytes (got ${h.length})`);
  return h;
}

export const networkId = (net: NetworkName): number => (net === "mainnet" ? 1 : 0);

export interface Address {
  bytes: Uint8Array;
  hex: string;
  bech32: string;
  network: NetworkName;
  kind: "base" | "enterprise" | "reward" | "byron";
  payment?: Credential;
  stake?: Credential;
}

function toBech32(hrp: string, data: Uint8Array): string {
  return bech32.encode(hrp, bech32.toWords(data), 1023);
}

function make(net: NetworkName, kind: Address["kind"], header: number, parts: Uint8Array[], payment?: Credential, stake?: Credential): Address {
  const bytes = concat([header], ...parts);
  const hrp = kind === "reward" ? (net === "mainnet" ? "stake" : "stake_test") : net === "mainnet" ? "addr" : "addr_test";
  return { bytes, hex: bytesToHex(bytes), bech32: toBech32(hrp, bytes), network: net, kind, payment, stake };
}

/** Base address: payment credential + stake credential (headers 0x0_ key/key, 0x1_ script/key, 0x2_ key/script, 0x3_ script/script). */
export function baseAddress(net: NetworkName, payment: Credential, stake: Credential): Address {
  const type = (payment.kind === "script" ? 1 : 0) + (stake.kind === "script" ? 2 : 0);
  return make(net, "base", (type << 4) | networkId(net), [payment.hash, stake.hash], payment, stake);
}

/** Enterprise address (headers 0x6_ key, 0x7_ script). */
export function enterpriseAddress(net: NetworkName, payment: Credential): Address {
  return make(net, "enterprise", ((payment.kind === "script" ? 7 : 6) << 4) | networkId(net), [payment.hash], payment);
}

/** Reward (stake) address (headers 0xe_ key, 0xf_ script). */
export function rewardAddress(net: NetworkName, stake: Credential): Address {
  return make(net, "reward", ((stake.kind === "script" ? 15 : 14) << 4) | networkId(net), [stake.hash], undefined, stake);
}

/** Parse bech32 / hex / bytes of a Shelley address back into its parts. */
export function parseAddress(input: string | Uint8Array): Address {
  let data: Uint8Array;
  if (typeof input === "string") {
    if (/^(addr|stake)/.test(input)) data = new Uint8Array(bech32.fromWords(bech32.decode(input, 1023).words));
    else data = hexToBytes(input);
  } else data = input;
  const header = data[0]!;
  const type = header >> 4;
  const net: NetworkName = (header & 0x0f) === 1 ? "mainnet" : "testnet";
  const cred = (kind: "key" | "script", at: number): Credential => ({ kind, hash: data.slice(at, at + 28) });
  if (type <= 3) {
    return baseAddress(net, cred(type & 1 ? "script" : "key", 1), cred(type & 2 ? "script" : "key", 29));
  }
  if (type === 6 || type === 7) return enterpriseAddress(net, cred(type === 7 ? "script" : "key", 1));
  if (type === 14 || type === 15) return rewardAddress(net, cred(type === 15 ? "script" : "key", 1));
  throw new Error(`unsupported address type ${type}`);
}

// ---------------------------------------------------------------- Byron (base58)

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(data: Uint8Array): string {
  let n = 0n;
  for (const b of data) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of data) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const ch of text) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error(`not base58: ${ch}`);
    n = n * 58n + BigInt(i);
  }
  const hex = n === 0n ? "" : n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0");
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  return concat(new Uint8Array(zeros), hexToBytes(hex));
}

let crcTable: Uint32Array | undefined;
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of data) crc = crcTable[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A Byron-era address of an artificial root (base58 text, `Ae2...` on mainnet): `[#6.24(bytes .cbor [root, {}, 0]), crc32]`.
 * `label` seeds the 28-byte root, so the same label always gives the same text.
 */
export function byronAddress(label: string, net: NetworkName = "mainnet"): { text: string; bytes: Uint8Array } {
  const root = blake2b224(new TextEncoder().encode(`synthetic byron address / ${label}`));
  const attributes = net === "mainnet" ? cmap([]) : cmap([[uint(2), cbytes(encode(uint(42)))]]);
  const payload = encode(array([cbytes(root), attributes, uint(0)]));
  const bytes = encode(array([tag(24, cbytes(payload)), uint(crc32(payload))]));
  return { text: base58Encode(bytes), bytes };
}

// ---------------------------------------------------------------- other bech32 identifiers

/** Pool id (CIP-5 `pool1...`) of a 28-byte pool key hash. */
export function poolIdBech32(hash: KeyPair | Uint8Array | string): string {
  return toBech32("pool", hashOf(hash));
}

/** DRep id. CIP-129 (default): header 0x22 key / 0x23 script + hash. CIP-105: the bare 28-byte hash with prefix `drep` / `drep_script`. */
export function drepIdBech32(cred: Credential, style: "cip129" | "cip105" = "cip129"): string {
  if (style === "cip105") return toBech32(cred.kind === "key" ? "drep" : "drep_script", cred.hash);
  return toBech32("drep", concat([cred.kind === "key" ? 0x22 : 0x23], cred.hash));
}

/** Constitutional committee cold credential id (CIP-129: header 0x12 key / 0x13 script). */
export function ccColdBech32(cred: Credential): string {
  return toBech32("cc_cold", concat([cred.kind === "key" ? 0x12 : 0x13], cred.hash));
}

/** Constitutional committee hot credential id (CIP-129: header 0x02 key / 0x03 script). */
export function ccHotBech32(cred: Credential): string {
  return toBech32("cc_hot", concat([cred.kind === "key" ? 0x02 : 0x03], cred.hash));
}

/** Governance action id (CIP-129): the transaction id followed by the one-byte index. */
export function govActionIdBech32(txHash: string | Uint8Array, index: number): string {
  const h = toBytes(txHash);
  if (index < 0 || index > 255) throw new Error("gov action index must fit one byte for CIP-129");
  return toBech32("gov_action", concat(h, [index]));
}

/** CIP-14 asset fingerprint (`asset1...`): blake2b-160 of policy id + asset name. */
export function assetFingerprint(policyHex: string, assetNameHex: string): string {
  return toBech32("asset", blake2b160(concat(hexToBytes(policyHex), hexToBytes(assetNameHex))));
}
