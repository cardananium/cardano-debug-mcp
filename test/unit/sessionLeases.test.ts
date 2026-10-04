// Session leases (short commands overlap, long ones are exclusive), victim choice, tombstones and
// the wording of busy / expired / lost answers.
import { afterEach, describe, expect, it } from "vitest";

import type { AppContext } from "../../src/context.js";
import { registryBytesHex } from "../fixtures/synthetic/lib/scripts.js";
import {
  busySessionError,
  classifyLoss,
  clearTombstones,
  expiredHandleError,
  lostSessionError,
  SessionLimitError,
  SessionRegistry,
  tombstoneOf,
} from "../../src/store/sessionRegistry.js";
import { leaseSession, leaseSessionWait, lossOf, sessionErrorResult } from "../../src/tools/_debug.js";
import { WorkerCallError, WorkerTimeoutError, WorkerUnavailableError } from "../../src/workers/rpc.js";

const init = { mode: "program" as const, language: "V3" as const, partsConfig: { program: "(program 1.1.0 (con integer 1))", language: "v3" } };

afterEach(() => clearTombstones());

function ctxOf(registry: SessionRegistry): AppContext {
  return { sessions: registry } as unknown as AppContext;
}

describe("leases", () => {
  it("short commands overlap on one session; a long command is exclusive and says what runs and for how long", () => {
    let now = 1_000;
    const registry = new SessionRegistry({ now: () => now });
    const { record } = registry.create({ ...init, client: { lost: false, close: async () => undefined } as never });
    const a = registry.acquire(record.dbgId, { tool: "debug_inspect" });
    const b = registry.acquire(record.dbgId, { tool: "debug_source" });
    expect(a.ok && b.ok).toBe(true);
    expect(record.leases).toBe(2);
    expect(record.busy).toBe(true);
    // a long command cannot start while short ones are in flight, but it is not "running" either
    const early = registry.acquire(record.dbgId, { tool: "debug_run", long: true });
    expect(early).toEqual({ ok: false, reason: "busy" });
    if (a.ok) a.release();
    if (b.ok) b.release();
    expect(record.busy).toBe(false);
    const run = registry.acquire(record.dbgId, { tool: "debug_run", long: true });
    expect(run.ok).toBe(true);
    expect(record.running).toEqual({ tool: "debug_run", since: 1_000 });
    now += 2_500;
    expect(registry.acquire(record.dbgId, { tool: "debug_inspect" })).toEqual({ ok: false, reason: "busy", running: { tool: "debug_run", since_ms: 2_500 } });
    expect(registry.acquire(record.dbgId, { tool: "debug_profile", long: true })).toMatchObject({ ok: false, reason: "busy", running: { tool: "debug_run" } });
    if (run.ok) run.release();
    expect(record.running).toBeUndefined();
    expect(registry.acquire(record.dbgId).ok).toBe(true);
  });

  it("the busy answer names the command, its age and what to do", () => {
    const result = busySessionError("dbg_x", { tool: "debug_run", since_ms: 4_200 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "busy", handle: "dbg_x", running: "debug_run", since_ms: 4_200 });
    expect(String(result.structuredContent.message)).toMatch(/is running debug_run \(for 4\.2 s\).*timeout_ms/);
    expect(busySessionError("dbg_x").structuredContent).not.toHaveProperty("running");
  });

  it("acquireWait lets a long command wait for short ones to drain, but never waits for a long one", async () => {
    const registry = new SessionRegistry();
    const { record } = registry.create({ ...init, client: { lost: false, close: async () => undefined } as never });
    const short = registry.acquire(record.dbgId, { tool: "debug_inspect" });
    expect(short.ok).toBe(true);
    setTimeout(() => short.ok && short.release(), 40);
    const started = Date.now();
    const run = await registry.acquireWait(record.dbgId, { tool: "debug_run", long: true }, 2_000);
    expect(run.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_500);
    // a long command in flight: answered at once
    const t0 = Date.now();
    const second = await registry.acquireWait(record.dbgId, { tool: "debug_inspect" }, 2_000);
    expect(second).toMatchObject({ ok: false, reason: "busy", running: { tool: "debug_run" } });
    expect(Date.now() - t0).toBeLessThan(200);
    if (run.ok) run.release();
  });

  it("acquireWait gives up after its bound while short commands stay in flight", async () => {
    const registry = new SessionRegistry();
    const { record } = registry.create({ ...init, client: { lost: false, close: async () => undefined } as never });
    const short = registry.acquire(record.dbgId);
    expect(short.ok).toBe(true);
    const t0 = Date.now();
    const run = await registry.acquireWait(record.dbgId, { long: true }, 80);
    expect(run).toEqual({ ok: false, reason: "busy" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
    if (short.ok) short.release();
  });

  it("releasing counts as use: the session just served is no longer the LRU victim", () => {
    let now = 1;
    const registry = new SessionRegistry({ max: 2, now: () => now });
    const a = registry.create(init).record;
    now++;
    const b = registry.create(init).record;
    now++;
    const lease = registry.acquire(a.dbgId);
    now++;
    now++;
    if (lease.ok) lease.release(); // `a` was acquired first but released last
    expect(registry.list().map((r) => r.dbgId)).toEqual([a.dbgId, b.dbgId]);
    const third = registry.create(init);
    expect(third.evicted?.dbgId).toBe(b.dbgId);
  });
});

describe("who makes room", () => {
  it("a lost or poisoned session goes before a healthy older one, even with a call still failing on it", () => {
    const registry = new SessionRegistry({ max: 3 });
    const healthyOld = registry.create(init).record;
    const lost = registry.create(init).record;
    const busy = registry.create(init).record;
    registry.markLost(lost.dbgId, "fatal_error: RuntimeError: unreachable");
    const lease = registry.acquire(lost.dbgId);
    expect(lease).toMatchObject({ ok: false, reason: "lost" });
    const next = registry.create(init);
    expect(next.evicted?.dbgId).toBe(lost.dbgId);
    expect(registry.peek(healthyOld.dbgId)).toBeDefined();
    expect(registry.peek(busy.dbgId)).toBeDefined();
    const poisoned = registry.create(init).record;
    poisoned.poisoned = true;
    expect(registry.create(init).evicted?.dbgId).toBe(poisoned.dbgId);
  });

  it("assertRoom refuses before an expensive open when every session is executing a command, and not otherwise", () => {
    const registry = new SessionRegistry({ max: 2 });
    const a = registry.create(init).record;
    expect(() => registry.assertRoom()).not.toThrow();
    const b = registry.create(init).record;
    expect(() => registry.assertRoom()).not.toThrow(); // full, but both are idle: the LRU would go
    const la = registry.acquire(a.dbgId);
    const lb = registry.acquire(b.dbgId);
    expect(() => registry.assertRoom()).toThrow(SessionLimitError);
    if (la.ok) la.release();
    expect(() => registry.assertRoom()).not.toThrow();
    if (lb.ok) lb.release();
  });
});

describe("tombstones: why a handle is gone", () => {
  it("an evicted session is named with its reason, last position and the call that reopens it", () => {
    let now = Date.UTC(2026, 9, 4, 12, 0, 0);
    const registry = new SessionRegistry({ max: 1, now: () => now });
    const a = registry.create({ ...init, totalSteps: 1234, lastPosition: { term_id: 5, raw_term_id: 50, kind: "Apply", uplc_line: 9, machine_state: "Compute", last_term_id: 5 } }).record;
    now += 1000;
    registry.create(init);
    const result = expiredHandleError(a.dbgId, "debug_open");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "expired_handle", handle: a.dbgId, recreate_with: "debug_open", reason: "lru", reopen_with: { reopen: a.dbgId } });
    const message = String(result.structuredContent.message);
    expect(message).toMatch(/evicted at 2026-10-04T12:00:01.000Z to make room for a newer session/);
    expect(message).toMatch(/Last completed state: step 1,234, Compute at term 5 \(line 9\)/);
    expect(message).toContain(`debug_open(reopen="${a.dbgId}")`);
    expect(result.structuredContent.last_known).toMatchObject({ steps_total: 1234 });
  });

  it("idle expiry, absolute expiry and debug_close are told apart; a tx session names tx_id + redeemer", () => {
    let now = 1_000_000;
    const registry = new SessionRegistry({ idleTtlMs: 1_000, absoluteTtlMs: 5_000, now: () => now });
    const idle = registry.create(init).record;
    const tx = registry.create({ ...init, mode: "tx", txId: "tx_mainnet_aaaaaaaaaaaa", redeemer: "spend:2" }).record;
    const closed = registry.create(init).record;
    registry.close(closed.dbgId);
    expect(String(expiredHandleError(closed.dbgId, "debug_open").structuredContent.message)).toMatch(/was closed \(debug_close\)/);
    now += 1_500;
    expect(registry.get(idle.dbgId)).toBeUndefined();
    expect(String(expiredHandleError(idle.dbgId, "debug_open").structuredContent.message)).toMatch(/expired at .* after 30 minutes without a command/);
    expect(registry.get(tx.dbgId)).toBeUndefined();
    const text = String(expiredHandleError(tx.dbgId, "debug_open").structuredContent.message);
    expect(text).toContain('debug_open(tx_id="tx_mainnet_aaaaaaaaaaaa", redeemer="spend:2")');
    expect(expiredHandleError(tx.dbgId, "debug_open").structuredContent).toMatchObject({ tx_id: "tx_mainnet_aaaaaaaaaaaa", redeemer: "spend:2" });
  });

  it("a lost session that is later removed keeps its loss cause", () => {
    const registry = new SessionRegistry();
    const a = registry.create(init).record;
    registry.markLost(a.dbgId, "wasm trap: RangeError: Maximum call stack size exceeded", "wasm_trap");
    registry.close(a.dbgId);
    expect(tombstoneOf(a.dbgId)).toMatchObject({ cause: "wasm_trap" });
    const message = String(expiredHandleError(a.dbgId, "debug_open").structuredContent.message);
    expect(message).toMatch(/its worker was lost \(the engine overflowed its stack/);
  });

  it("reopenSource answers from the live (lost) record and from the tombstone; shutdown leaves none", () => {
    const registry = new SessionRegistry();
    const a = registry.create({ ...init, mode: "parts", partsConfig: { script: registryBytesHex("tiny"), language: "v2", context: "d87980" }, language: "V2" }).record;
    expect(registry.reopenSource(a.dbgId)).toMatchObject({ mode: "parts", language: "V2", partsConfig: { context: "d87980" } });
    registry.close(a.dbgId);
    expect(registry.reopenSource(a.dbgId)).toMatchObject({ partsConfig: { context: "d87980" } });
    const b = registry.create(init).record;
    registry.closeAll("shutdown");
    expect(tombstoneOf(b.dbgId)).toBeUndefined();
    expect(registry.reopenSource(b.dbgId)).toBeUndefined();
  });

  it("a config too large to keep is dropped from the tombstone (the handle still explains itself)", () => {
    const registry = new SessionRegistry();
    const a = registry.create({ ...init, partsConfig: { program: "x".repeat(600 * 1024), language: "v3" } }).record;
    registry.close(a.dbgId);
    expect(registry.reopenSource(a.dbgId)).toBeUndefined();
    const result = expiredHandleError(a.dbgId, "debug_open");
    expect(String(result.structuredContent.message)).toContain("debug_open with the same arguments");
    expect(result.structuredContent).not.toHaveProperty("reopen_with");
  });

  it("an id nobody remembers, and transactions, keep a plain answer", () => {
    const unknown = expiredHandleError("dbg_00000000-0000-0000-0000-000000000000", "debug_open");
    expect(unknown.structuredContent).toMatchObject({ code: "expired_handle", recreate_with: "debug_open" });
    expect(String(unknown.structuredContent.message)).toMatch(/never opened it, or it was forgotten/);
    const tx = expiredHandleError("tx_mainnet_000000000000", "tx_load");
    expect(tx.structuredContent).toMatchObject({ code: "expired_handle", recreate_with: "tx_load", handle: "tx_mainnet_000000000000" });
    expect(String(tx.structuredContent.message)).toMatch(/Unknown or expired transaction handle/);
    // a transaction HASH typed where a handle belongs is named as such
    const hash = "ab".repeat(32);
    const hashed = expiredHandleError(hash, "tx_load");
    expect(hashed.structuredContent).toMatchObject({ code: "expired_handle", recreate_with: "tx_load", argument: "tx_id" });
    expect(String(hashed.structuredContent.message)).toMatch(/64-hex transaction HASH.*tx_load\(tx_hash="abababababab/);
  });

  it("the ring is bounded", () => {
    const registry = new SessionRegistry({ max: 1000 });
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      const r = registry.create(init).record;
      ids.push(r.dbgId);
      registry.close(r.dbgId);
    }
    expect(tombstoneOf(ids[0]!)).toBeUndefined();
    expect(tombstoneOf(ids[39]!)).toBeDefined();
  });
});

describe("loss causes", () => {
  it("classifyLoss reads the host's reason text", () => {
    expect(classifyLoss("fatal_error: RuntimeError: unreachable")).toBe("wasm_trap");
    expect(classifyLoss("wasm trap: RangeError: Maximum call stack size exceeded")).toBe("wasm_trap");
    expect(classifyLoss("timeout: run exceeded 12 s")).toBe("hard_timeout");
    expect(classifyLoss("worker_error: Error: Worker terminated due to reaching memory limit: JS heap out of memory")).toBe("out_of_memory");
    expect(classifyLoss("worker_exit: exit code 1")).toBe("worker_crash");
    expect(classifyLoss("abort: run aborted by caller")).toBe("aborted");
    expect(classifyLoss(undefined)).toBe("unknown");
    expect(lossOf({ reason: "worker_error", lostGeneration: 0, newGeneration: -1, detail: "Error: heap out of memory" })).toEqual({ reason: "worker_error: Error: heap out of memory", cause: "out_of_memory" });
    expect(lossOf({ reason: "fatal_error", lostGeneration: 0, newGeneration: -1 }).cause).toBe("wasm_trap");
    expect(lossOf({ reason: "timeout", lostGeneration: 0, newGeneration: -1 }).cause).toBe("hard_timeout");
  });

  const record = { dbgId: "dbg_x", mode: "parts" as const, txId: undefined, redeemer: undefined, totalSteps: 9_000, partsConfig: {}, lastPosition: { term_id: 3, raw_term_id: 30, kind: "Var", uplc_line: 4, machine_state: "Compute" as const, last_term_id: 3 } };

  it("each cause says what happened, the last known state and what to do instead of retrying", () => {
    const trap = lostSessionError({ ...record, lostReason: "RangeError: Maximum call stack size exceeded", lostCause: "wasm_trap" });
    expect(trap.structuredContent).toMatchObject({ code: "session_lost", cause: "wasm_trap", handle: "dbg_x", reopen_with: { reopen: "dbg_x" }, last_known: { steps_total: 9_000 } });
    const trapText = String(trap.structuredContent.message);
    expect(trapText).toMatch(/engine overflowed its stack, typically reading the frames of a very deep call stack/);
    expect(trapText).toMatch(/Last completed state: step 9,000, Compute at term 3 \(line 4\)/);
    expect(trapText).toMatch(/a plain retry traps again.*bounded steps.*before step 9,000/);
    expect(trapText).toContain('debug_open(reopen="dbg_x")');

    const timeout = lostSessionError({ ...record, lostReason: "run did not answer within 12 s and the worker was terminated", lostCause: "hard_timeout" });
    const timeoutText = String(timeout.structuredContent.message);
    expect(timeoutText).toMatch(/run did not answer within 12 s/);
    expect(timeoutText).toMatch(/stuck inside one engine call.*not stepping slowly/);
    expect(timeoutText).not.toMatch(/too large|too complex/);

    expect(String(lostSessionError({ ...record, lostReason: "heap out of memory", lostCause: "out_of_memory" }).structuredContent.message)).toMatch(/ran out of memory.*CARDANO_DEBUG_WORKER_HEAP_MB/);
    expect(String(lostSessionError({ ...record, lostReason: "worker_exit: exit code 1; last worker stderr: boom", lostCause: "worker_crash" }).structuredContent.message)).toMatch(/exited unexpectedly: worker_exit: exit code 1; last worker stderr: boom/);
    // without a stated cause it is read from the reason
    expect(lostSessionError({ ...record, lostReason: "fatal_error: RuntimeError: unreachable" }).structuredContent.cause).toBe("wasm_trap");
  });

  it("sessionErrorResult marks the session lost with the right cause for a hard timeout, a trap and a dead worker", () => {
    const registry = new SessionRegistry();
    const ctx = ctxOf(registry);
    const make = () => registry.create({ ...init, totalSteps: 77 }).record;

    const a = make();
    const timeout = new WorkerTimeoutError("session: run did not answer within 9 s; the worker was terminated. x", 9_000, "run");
    const resultA = sessionErrorResult(ctx, a, timeout);
    expect(resultA.structuredContent).toMatchObject({ code: "session_lost", cause: "hard_timeout" });
    expect(String(resultA.structuredContent.message)).toMatch(/run did not answer within 9 s and the worker was terminated/);
    expect(a.lost).toBe(true);
    expect(a.lostCause).toBe("hard_timeout");

    const b = make();
    const trap = new WorkerCallError({ name: "RangeError", message: "Maximum call stack size exceeded", fatal: true });
    const resultB = sessionErrorResult(ctx, b, trap);
    expect(resultB.structuredContent).toMatchObject({ code: "session_lost", cause: "wasm_trap" });
    expect(String(resultB.structuredContent.message)).toMatch(/overflowed its stack/);

    const c = make();
    const dead = new WorkerUnavailableError("session: the worker was lost while running run (worker_exit: exit code 1; last worker stderr: thread panicked).");
    const resultC = sessionErrorResult(ctx, c, dead);
    expect(resultC.structuredContent).toMatchObject({ code: "session_lost", cause: "worker_crash" });
    expect(String(resultC.structuredContent.message)).toContain("thread panicked");

    // later calls on it get the same story from the lease
    const lease = leaseSession(ctx, a.dbgId);
    expect(lease.ok).toBe(false);
    if (!lease.ok) expect(lease.result.structuredContent).toMatchObject({ code: "session_lost", cause: "hard_timeout" });
  });
});

describe("leaseSession helpers", () => {
  it("answer busy with the running command, expired with the tombstone, and wait for short commands", async () => {
    const registry = new SessionRegistry({ max: 1 });
    const ctx = ctxOf(registry);
    const { record } = registry.create({ ...init, client: { lost: false, close: async () => undefined } as never });
    const long = await leaseSessionWait(ctx, record.dbgId, { tool: "debug_run", long: true });
    expect(long.ok).toBe(true);
    const refused = leaseSession(ctx, record.dbgId, { tool: "debug_inspect" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.result.structuredContent).toMatchObject({ code: "busy", running: "debug_run" });
    if (long.ok) long.release();
    const dbgId = record.dbgId;
    registry.create(init); // evicts it
    const gone = leaseSession(ctx, dbgId);
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.result.structuredContent).toMatchObject({ code: "expired_handle", reason: "lru" });
  });

  it("a record without a worker is session_lost, and its lease is returned", () => {
    const registry = new SessionRegistry();
    const { record } = registry.create(init);
    const lease = leaseSession(ctxOf(registry), record.dbgId);
    expect(lease.ok).toBe(false);
    expect(record.leases).toBe(0);
  });
});
