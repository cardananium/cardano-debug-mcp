// Deterministic ed25519 keys named by a label: the seed is blake2b-256 of a fixed phrase, so every key (and every
// hash, address and signature built from it) is reproducible and traceable to a name in a scenario file, never to
// a real wallet. Signing uses node's crypto (ed25519 signatures are deterministic).

import { createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify, type KeyObject } from "node:crypto";

import { blake2b224, blake2b256 } from "./blake2b.js";
import { bytesToHex, concat, utf8 } from "./bytes.js";
import { array, bytes as cbytes, type Cbor } from "./cbor.js";

export type KeyRole = "payment" | "stake" | "drep" | "pool" | "cc-cold" | "cc-hot" | "vrf" | "other";

export interface KeyPair {
  /** Label the key was derived from (`role/name`). */
  readonly label: string;
  readonly role: KeyRole;
  readonly seed: Uint8Array;
  readonly publicKey: Uint8Array;
  /** blake2b-224 of the public key (28 bytes), the key hash used in addresses, certificates and required signers. */
  readonly keyHash: Uint8Array;
  readonly keyHashHex: string;
  sign(message: Uint8Array): Uint8Array;
  verify(message: Uint8Array, signature: Uint8Array): boolean;
}

const PKCS8_PREFIX = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20);
const SEED_PHRASE = "cardano-debug-mcp synthetic fixture key";

const cache = new Map<string, KeyPair>();

class Ed25519Key implements KeyPair {
  readonly publicKey: Uint8Array;
  readonly keyHash: Uint8Array;
  readonly keyHashHex: string;
  private readonly priv: KeyObject;
  private readonly pub: KeyObject;

  constructor(
    readonly label: string,
    readonly role: KeyRole,
    readonly seed: Uint8Array,
  ) {
    this.priv = createPrivateKey({ key: Buffer.from(concat(PKCS8_PREFIX, seed)), format: "der", type: "pkcs8" });
    this.pub = createPublicKey(this.priv);
    this.publicKey = new Uint8Array(this.pub.export({ format: "der", type: "spki" }).subarray(-32));
    this.keyHash = blake2b224(this.publicKey);
    this.keyHashHex = bytesToHex(this.keyHash);
  }

  sign(message: Uint8Array): Uint8Array {
    return new Uint8Array(nodeSign(null, Buffer.from(message), this.priv));
  }

  verify(message: Uint8Array, signature: Uint8Array): boolean {
    return nodeVerify(null, Buffer.from(message), this.pub, Buffer.from(signature));
  }
}

/** The key named `name` in `role` (same name + role = same key, in every run on every machine). */
export function keyPair(role: KeyRole, name: string): KeyPair {
  const label = `${role}/${name}`;
  let key = cache.get(label);
  if (!key) {
    key = new Ed25519Key(label, role, blake2b256(utf8(`${SEED_PHRASE} / ${label}`)));
    cache.set(label, key);
  }
  return key;
}

export const paymentKey = (name: string): KeyPair => keyPair("payment", name);
export const stakeKey = (name: string): KeyPair => keyPair("stake", name);
export const drepKey = (name: string): KeyPair => keyPair("drep", name);
export const poolKey = (name: string): KeyPair => keyPair("pool", name);
export const ccColdKey = (name: string): KeyPair => keyPair("cc-cold", name);
export const ccHotKey = (name: string): KeyPair => keyPair("cc-hot", name);

/** A vkey witness `[vkey, signature]` over the transaction body hash. */
export function vkeyWitness(key: KeyPair, bodyHash: Uint8Array): { key: KeyPair; vkey: Uint8Array; signature: Uint8Array; cbor: Cbor } {
  const signature = key.sign(bodyHash);
  return { key, vkey: key.publicKey, signature, cbor: array([cbytes(key.publicKey), cbytes(signature)]) };
}

/** A well-formed 64-byte placeholder signature (right size for fee estimation before the body is final). */
export const DUMMY_SIGNATURE = new Uint8Array(64);
