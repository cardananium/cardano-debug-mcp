import { mkdtempSync, readdirSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { BlockchainDataClient } from "@cardananium/cquisitor-lib/chain/koiosClient";
import type { KoiosEpochParams, KoiosTxCborResponse, KoiosUtxoInfo } from "@cardananium/cquisitor-lib/chain/koiosTypes";

import { DiskCache, MemoryTtlCache, safeKey, TTL } from "../../../src/chain/cache.js";
import { CachingClient } from "../../../src/chain/providers.js";

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), "cdm-cache-"));
}

describe("MemoryTtlCache", () => {
  it("expires and bounds entries", () => {
    let now = 1000;
    const cache = new MemoryTtlCache<number>(2, () => now);
    cache.set("a", 1, 100);
    cache.set("b", 2, TTL.forever);
    expect(cache.get("a")).toBe(1);
    now += 101;
    expect(cache.get("a")).toBeUndefined();
    cache.set("c", 3, 100);
    cache.set("d", 4, 100);
    expect(cache.size).toBe(2);
    expect(cache.get("b")).toBeUndefined(); // evicted as the oldest
  });
});

describe("DiskCache", () => {
  it("stores text / JSON with bigint, honours TTL by mtime and sanitises keys", async () => {
    const root = tmp();
    let now = Date.now();
    const cache = new DiskCache({ root, now: () => now, log: () => undefined });
    expect(safeKey("ab#1/../x")).toBe("ab_1_.._x");
    await cache.setJson("utxo/mainnet", "ab#1.json", { slot: 18446744073709551615n, n: 1 });
    expect(await cache.getJson("utxo/mainnet", "ab#1.json", TTL.utxoRows)).toEqual({ slot: 18446744073709551615n, n: 1 });
    expect(cache.pathOf("utxo/mainnet", "ab#1.json")).toBe(path.join(root, "utxo", "mainnet", "ab_1.json"));
    now += TTL.utxoRows + 5_000;
    expect(await cache.getJson("utxo/mainnet", "ab#1.json", TTL.utxoRows)).toBeUndefined();
    expect(await cache.getJson("utxo/mainnet", "ab#1.json", TTL.forever)).toBeDefined();
    await cache.delete("utxo/mainnet", "ab#1.json");
    expect(await cache.getText("utxo/mainnet", "ab#1.json")).toBeUndefined();
    expect(await cache.getText("nope", "x")).toBeUndefined();
  });

  it("evicts the least recently modified files when over budget, bundles last", async () => {
    const root = tmp();
    const cache = new DiskCache({ root, maxBytes: 300, log: () => undefined });
    const old = new Date(Date.now() - 100_000);
    await cache.setText("bundles/mainnet", "b.json", "x".repeat(100));
    utimesSync(cache.pathOf("bundles/mainnet", "b.json"), old, old);
    await cache.setText("tx/mainnet", "a.json", "y".repeat(100));
    utimesSync(cache.pathOf("tx/mainnet", "a.json"), old, old);
    await cache.setText("tx/mainnet", "c.json", "z".repeat(150)); // 350 > 300 -> evict oldest non-bundle first
    expect(await cache.getText("tx/mainnet", "a.json")).toBeUndefined();
    expect(await cache.getText("bundles/mainnet", "b.json")).toBeDefined();
    expect(await cache.getText("tx/mainnet", "c.json")).toBeDefined();
    const stats = await cache.stats();
    expect(stats.files).toBe(2);
    expect(readdirSync(path.join(root, "tx", "mainnet"))).toEqual(["c.json"]);
  });
});

function utxoRow(hash: string, ix: number): KoiosUtxoInfo {
  return {
    tx_hash: hash,
    tx_index: ix,
    address: "addr1",
    value: "1",
    stake_address: null,
    payment_cred: null,
    epoch_no: 1,
    block_height: 1,
    block_time: 1,
    datum_hash: null,
    inline_datum: null,
    reference_script: null,
    asset_list: null,
    is_spent: false,
  };
}

class FakeClient implements Partial<BlockchainDataClient> {
  utxoCalls: string[][] = [];
  epochCalls = 0;
  txCalls: string[][] = [];
  async getUtxoInfo(refs: string[]): Promise<KoiosUtxoInfo[]> {
    this.utxoCalls.push(refs);
    return refs.filter((r) => !r.startsWith("ff")).map((r) => utxoRow(r.split("#")[0]!, Number(r.split("#")[1])));
  }
  async getEpochParams(): Promise<KoiosEpochParams[]> {
    this.epochCalls++;
    return [{ epoch_no: 500, protocol_major: 11 } as KoiosEpochParams];
  }
  async getTxCbor(hashes: string[]): Promise<KoiosTxCborResponse[]> {
    this.txCalls.push(hashes);
    return hashes.map((h) => ({ tx_hash: h, block_hash: "b", block_height: 1, cbor: "84a0" }));
  }
}

describe("CachingClient", () => {
  it("serves per-row utxo hits from the cache, fetches misses once, records rows and cache hits", async () => {
    const root = tmp();
    const cache = new DiskCache({ root, log: () => undefined });
    const memory = new MemoryTtlCache();
    const fake = new FakeClient();
    const a = "aa".repeat(32);
    const b = "bb".repeat(32);
    const client = new CachingClient(fake as unknown as BlockchainDataClient, { network: "mainnet", provider: "koios", cache, memory });
    const rows = await client.getUtxoInfo([`${a}#0`, `${b}#1`, `ff${"00".repeat(31)}#2`]);
    expect(rows.map((r) => `${r.tx_hash}#${r.tx_index}`)).toEqual([`${a}#0`, `${b}#1`]);
    expect(fake.utxoCalls).toEqual([[`${a}#0`, `${b}#1`, `ff${"00".repeat(31)}#2`]]);
    expect(client.rows.utxo_info).toHaveLength(2);

    const second = new CachingClient(fake as unknown as BlockchainDataClient, { network: "mainnet", provider: "koios", cache, memory: new MemoryTtlCache() });
    const again = await second.getUtxoInfo([`${a}#0`, `${b}#1`, `${a}#5`]);
    expect(again).toHaveLength(3);
    expect(fake.utxoCalls[1]).toEqual([`${a}#5`]); // only the miss
    expect(second.rows.cache_hits[0]).toBe("utxo/mainnet/koios:2/3");

    expect((await client.getEpochParams())[0]!.epoch_no).toBe(500);
    expect((await second.getEpochParams())[0]!.epoch_no).toBe(500);
    expect(fake.epochCalls).toBe(1);
    expect(second.rows.epoch_params?.protocol_major).toBe(11);

    await client.getTxCbor([a]);
    await second.getTxCbor([a]);
    expect(fake.txCalls).toEqual([[a]]);

    const refreshing = new CachingClient(fake as unknown as BlockchainDataClient, { network: "mainnet", provider: "koios", cache, memory, refresh: true });
    await refreshing.getEpochParams();
    expect(fake.epochCalls).toBe(2);
  });
});
