import { describe, expect, it, vi } from "vitest";

import { SessionLimitError, SessionRegistry, expiredHandleError, sessionLimitError } from "../../src/store/sessionRegistry.js";
import { makeTxId, parseTxId, TxStore, type TxRecord } from "../../src/store/txStore.js";
import { fxStr } from "../helpers/fixtures.js";

function record(txId: string, now: number): TxRecord {
  return {
    txId,
    txHash: "ab".repeat(32),
    network: "mainnet",
    txHex: "84a0",
    sizeBytes: 2,
    source: "cbor",
    createdAt: now,
    lastUsedAt: now,
    decoded: { transaction_hash: "ab".repeat(32), transaction: { body: {}, witness_set: {}, is_valid: true, auxiliary_data: null } },
    hashes: {
      witness_native_script_hashes: [],
      witness_plutus_scripts: [],
      witness_datum_hashes: [],
      output_inline_scripts: [],
      output_inline_datum_hashes: [],
      output_datum_hashes: [],
    },
    redeemerTargets: [],
    scripts: [],
    extra: {},
  };
}

describe("TxStore", () => {
  it("makes and parses ids", () => {
    const hash = fxStr("s08.txHash");
    const id = makeTxId("preprod", hash.toUpperCase());
    expect(id).toBe(`tx_preprod_${hash.slice(0, 12)}`);
    expect(parseTxId(id)).toEqual({ network: "preprod", hashPrefix: hash.slice(0, 12) });
    expect(parseTxId("dbg_x")).toBeUndefined();
  });
  it("evicts LRU beyond max and expires by TTL", () => {
    let now = 1_000_000;
    const evicted: string[] = [];
    const store = new TxStore({ max: 2, ttlMs: 100, now: () => now, onEvict: (r, reason) => evicted.push(`${r.txId}:${reason}`) });
    store.put(record("tx_mainnet_000000000001", now));
    now += 1;
    store.put(record("tx_mainnet_000000000002", now));
    now += 1;
    expect(store.get("tx_mainnet_000000000001")).toBeDefined(); // touch -> becomes MRU
    store.put(record("tx_mainnet_000000000003", now));
    expect(store.size).toBe(2);
    expect(evicted).toEqual(["tx_mainnet_000000000002:lru"]);
    expect(store.list().map((r) => r.txId)).toEqual(["tx_mainnet_000000000003", "tx_mainnet_000000000001"]);
    now += 200;
    expect(store.get("tx_mainnet_000000000001")).toBeUndefined();
    expect(evicted).toContain("tx_mainnet_000000000001:ttl");
    expect(store.sweep()).toBe(1);
    expect(store.size).toBe(0);
    expect(store.evict("missing")).toBe(false);
  });
});

describe("SessionRegistry", () => {
  it("creates dbg ids, evicts LRU at max, expires idle and absolute", () => {
    let now = 5_000_000;
    const events: string[] = [];
    const registry = new SessionRegistry({
      max: 2,
      idleTtlMs: 1_000,
      absoluteTtlMs: 10_000,
      now: () => now,
      onEvict: (r, reason) => events.push(`${r.dbgId}:${reason}`),
    });
    const a = registry.create({ mode: "program", language: "V3", partsConfig: { program: "(program 1.1.0 (con integer 1))" } }).record;
    expect(a.dbgId).toMatch(/^dbg_[0-9a-f-]{36}$/);
    now += 10;
    const b = registry.create({ mode: "program", language: "V3", partsConfig: {} }).record;
    now += 10;
    expect(registry.get(a.dbgId)).toBe(a);
    const third = registry.create({ mode: "program", language: "V3", partsConfig: {} });
    expect(third.evicted?.dbgId).toBe(b.dbgId);
    expect(events).toEqual([`${b.dbgId}:lru`]);
    expect(registry.size).toBe(2);
    now += 1_500;
    expect(registry.get(a.dbgId)).toBeUndefined();
    expect(events).toContain(`${a.dbgId}:idle`);
    const c = third.record;
    registry.touch(c.dbgId);
    now += 20_000;
    expect(registry.sweep().map((r) => r.dbgId)).toEqual([c.dbgId]);
    expect(events).toContain(`${c.dbgId}:absolute`);
    expect(registry.size).toBe(0);
  });
  it("never evicts a busy session: the oldest idle one goes, and a full set of busy sessions is a session_limit", () => {
    let now = 1_000_000;
    const events: string[] = [];
    const registry = new SessionRegistry({ max: 2, now: () => now, onEvict: (r, reason) => events.push(`${r.dbgId}:${reason}`) });
    const a = registry.create({ mode: "program", language: "V3", partsConfig: {} }).record;
    now += 10;
    const b = registry.create({ mode: "program", language: "V3", partsConfig: {} }).record;
    now += 10;
    // `a` is the LRU but has a debug_run in flight: `b` is evicted instead.
    const leaseA = registry.acquire(a.dbgId);
    expect(leaseA.ok).toBe(true);
    const third = registry.create({ mode: "program", language: "V3", partsConfig: {} });
    expect(third.evicted?.dbgId).toBe(b.dbgId);
    expect(events).toEqual([`${b.dbgId}:lru`]);
    expect(registry.peek(a.dbgId)).toBe(a);
    // Every slot busy: no eviction, a typed error the tool turns into `session_limit`.
    const leaseC = registry.acquire(third.record.dbgId);
    expect(leaseC.ok).toBe(true);
    let thrown: unknown;
    try {
      registry.create({ mode: "program", language: "V3", partsConfig: {} });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SessionLimitError);
    expect((thrown as SessionLimitError).data).toEqual({ code: "session_limit", max: 2, busy: [a.dbgId, third.record.dbgId] });
    expect(registry.size).toBe(2);
    const result = sessionLimitError(thrown as SessionLimitError);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "session_limit", max_sessions: 2, busy_sessions: [a.dbgId, third.record.dbgId], recreate_with: "debug_open" });
    // Once a command returns, creation evicts again.
    if (leaseA.ok) leaseA.release();
    const fourth = registry.create({ mode: "program", language: "V3", partsConfig: {} });
    expect(fourth.evicted?.dbgId).toBe(a.dbgId);
    if (leaseC.ok) leaseC.release();
  });
  it("disposes the worker on close", () => {
    const registry = new SessionRegistry();
    const dispose = vi.fn(() => Promise.resolve());
    const { record } = registry.create({
      mode: "program",
      language: "V3",
      partsConfig: {},
      worker: { dispose } as unknown as NonNullable<import("../../src/store/sessionRegistry.js").SessionRecord["worker"]>,
    });
    expect(registry.close(record.dbgId)).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(registry.close(record.dbgId)).toBe(false);
  });
  it("expiredHandleError shape", () => {
    const result = expiredHandleError("dbg_x", "debug_open");
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("expired_handle");
    expect(result.structuredContent.recreate_with).toBe("debug_open");
    const first = result.content[0]!;
    expect(JSON.parse(first.type === "text" ? first.text : "{}")).toEqual(result.structuredContent);
  });
});
