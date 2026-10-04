import { describe, expect, it } from "vitest";

import {
  assetFingerprint,
  base58Decode,
  base58Encode,
  baseAddress,
  byronAddress,
  ccColdBech32,
  ccHotBech32,
  crc32,
  drepIdBech32,
  enterpriseAddress,
  govActionIdBech32,
  keyCred,
  parseAddress,
  poolIdBech32,
  rewardAddress,
  scriptCred,
} from "../../fixtures/synthetic/lib/address.js";
import { bytesToHex, utf8 } from "../../fixtures/synthetic/lib/bytes.js";
import { ccColdKey, ccHotKey, drepKey, keyPair, paymentKey, poolKey, stakeKey, vkeyWitness } from "../../fixtures/synthetic/lib/keys.js";
import { blake2b224 } from "../../fixtures/synthetic/lib/blake2b.js";
import { decodeType, wasm } from "../../fixtures/synthetic/lib/validator.js";

describe("keys", () => {
  it("are deterministic per role and name, distinct across both", () => {
    expect(paymentKey("alice").keyHashHex).toBe(paymentKey("alice").keyHashHex);
    expect(paymentKey("alice").keyHashHex).not.toBe(paymentKey("bob").keyHashHex);
    expect(paymentKey("alice").keyHashHex).not.toBe(stakeKey("alice").keyHashHex);
    expect(new Set([paymentKey("x"), stakeKey("x"), drepKey("x"), poolKey("x"), ccColdKey("x"), ccHotKey("x")].map((k) => k.keyHashHex)).size).toBe(6);
    expect(paymentKey("alice").label).toBe("payment/alice");
    expect(keyPair("payment", "alice")).toBe(paymentKey("alice"));
  });

  it("key hash = blake2b-224 of the 32-byte public key", () => {
    const k = paymentKey("alice");
    expect(k.publicKey).toHaveLength(32);
    expect(k.keyHash).toEqual(blake2b224(k.publicKey));
    expect(k.keyHashHex).toHaveLength(56);
  });

  it("signs (deterministically) and verifies; a flipped bit fails", () => {
    const k = paymentKey("alice");
    const msg = utf8("a message");
    const sig = k.sign(msg);
    expect(sig).toHaveLength(64);
    expect(k.sign(msg)).toEqual(sig);
    expect(k.verify(msg, sig)).toBe(true);
    expect(k.verify(utf8("another message"), sig)).toBe(false);
    expect(paymentKey("bob").verify(msg, sig)).toBe(false);
  });

  it("vkey witnesses are [vkey, signature] over the body hash", () => {
    const k = paymentKey("alice");
    const hash = new Uint8Array(32).fill(7);
    const w = vkeyWitness(k, hash);
    expect(w.vkey).toEqual(k.publicKey);
    expect(k.verify(hash, w.signature)).toBe(true);
  });
});

describe("addresses", () => {
  const pay = paymentKey("alice");
  const stake = stakeKey("alice");

  it("base / enterprise / reward addresses, mainnet and testnet, key and script credentials", () => {
    const base = baseAddress("mainnet", keyCred(pay), keyCred(stake));
    expect(base.bech32.startsWith("addr1q")).toBe(true);
    expect(base.bytes).toHaveLength(57);
    expect(base.bytes[0]).toBe(0x01);
    expect(baseAddress("testnet", keyCred(pay), keyCred(stake)).bech32.startsWith("addr_test1q")).toBe(true);
    expect(baseAddress("mainnet", scriptCred(pay.keyHash), keyCred(stake)).bytes[0]).toBe(0x11);
    expect(baseAddress("mainnet", keyCred(pay), scriptCred(stake.keyHash)).bytes[0]).toBe(0x21);
    expect(baseAddress("mainnet", scriptCred(pay.keyHash), scriptCred(stake.keyHash)).bytes[0]).toBe(0x31);
    const ent = enterpriseAddress("mainnet", scriptCred(pay.keyHash));
    expect(ent.bytes).toHaveLength(29);
    expect(ent.bytes[0]).toBe(0x71);
    expect(ent.bech32.startsWith("addr1w")).toBe(true);
    expect(enterpriseAddress("mainnet", keyCred(pay)).bytes[0]).toBe(0x61);
    const rew = rewardAddress("mainnet", keyCred(stake));
    expect(rew.bytes[0]).toBe(0xe1);
    expect(rew.bech32.startsWith("stake1u")).toBe(true);
    expect(rewardAddress("mainnet", scriptCred(stake.keyHash)).bytes[0]).toBe(0xf1);
    expect(rewardAddress("testnet", keyCred(stake)).bech32.startsWith("stake_test1u")).toBe(true);
  });

  it("parseAddress is the inverse (bech32, hex, bytes)", () => {
    const base = baseAddress("mainnet", scriptCred(pay.keyHash), keyCred(stake));
    for (const input of [base.bech32, base.hex, base.bytes]) {
      const parsed = parseAddress(input);
      expect(parsed.bech32).toBe(base.bech32);
      expect(parsed.payment?.kind).toBe("script");
      expect(parsed.stake?.kind).toBe("key");
    }
    expect(parseAddress(rewardAddress("testnet", keyCred(stake)).bech32).network).toBe("testnet");
  });

  it("the library reads our addresses back to the same credentials", () => {
    const base = baseAddress("mainnet", keyCred(pay), scriptCred(stake.keyHash));
    const lib = decodeType<{ address_type: string; details: { network_id: number; payment_cred: { type: string; credential: string }; staking_cred: { type: string; credential: string } } }>(base.bech32, "Address");
    expect(lib.address_type).toBe("Base");
    expect(lib.details.network_id).toBe(1);
    expect(lib.details.payment_cred).toEqual({ type: "KeyHash", credential: pay.keyHashHex });
    expect(lib.details.staking_cred).toEqual({ type: "ScriptHash", credential: stake.keyHashHex });
    const rew = rewardAddress("testnet", keyCred(stake));
    expect(decodeType<{ address_type: string }>(rew.bech32, "Address").address_type).toBe("Reward");
  });

  it("a Byron-looking base58 address: stable text, valid checksum, readable by the library", () => {
    const a = byronAddress("test");
    expect(byronAddress("test").text).toBe(a.text);
    expect(byronAddress("other").text).not.toBe(a.text);
    expect(a.text.startsWith("Ae2")).toBe(true);
    expect(base58Decode(a.text)).toEqual(a.bytes);
    expect(decodeType<{ address_type: string }>(a.text, "Address").address_type).toBe("Byron");
    expect(wasm().get_possible_types_for_input(a.text)).toContain("Address");
  });

  it("base58 and crc32 basics", () => {
    expect(base58Encode(Uint8Array.of(0, 0, 1))).toBe("112");
    expect(base58Decode("112")).toEqual(Uint8Array.of(0, 0, 1));
    expect(base58Encode(utf8("Hello World!"))).toBe("2NEpo7TZRRrLZSi2U");
    expect(crc32(utf8("123456789"))).toBe(0xcbf43926);
  });
});

describe("other bech32 identifiers", () => {
  const h = paymentKey("alice").keyHash;
  const hex = bytesToHex(h);

  it("pool id, drep id (CIP-129 and CIP-105), committee ids, governance action id", () => {
    expect(poolIdBech32(h).startsWith("pool1")).toBe(true);
    expect(poolIdBech32(h)).toHaveLength(56);
    expect(drepIdBech32(keyCred(h))).toHaveLength(58);
    expect(drepIdBech32(keyCred(h)).startsWith("drep1")).toBe(true);
    expect(drepIdBech32(scriptCred(h), "cip105").startsWith("drep_script1")).toBe(true);
    expect(drepIdBech32(keyCred(h), "cip105")).toHaveLength(56);
    expect(ccColdBech32(keyCred(h))).toHaveLength(61);
    expect(ccHotBech32(scriptCred(h))).toHaveLength(60);
    expect(govActionIdBech32(hex.repeat(2).slice(0, 64), 3)).toHaveLength(70);
    expect(govActionIdBech32(hex.repeat(2).slice(0, 64), 3).startsWith("gov_action1")).toBe(true);
  });

  it("CIP-14 asset fingerprint (published vector)", () => {
    // CIP-14 test vector: policy 7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373, empty asset name
    expect(assetFingerprint("7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373", "")).toBe("asset1rjklcrnsdzqp65wjgrg55sy9723kw09mlgvlc3");
    expect(assetFingerprint("7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373", "504154415445")).toBe("asset13n25uv0yaf5kus35fm2k86cqy60z58d9xmde92");
  });
});
