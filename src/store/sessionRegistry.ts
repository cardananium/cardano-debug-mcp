// SessionRegistry: live step-debugging sessions, `dbg_<uuidv4>` -> record with its own worker.
// Bounded (8, LRU), idle TTL 30 min, absolute TTL 4 h, swept every 60 s. Sessions never survive a
// restart (the engine cannot serialise a CEK machine); the record keeps `partsConfig` so that
// `debug_open(reopen=<dbg_id>)` recreates one cheaply, and a small ring of tombstones remembers why
// a handle is gone (evicted, expired, closed, lost with which cause) for the next call that uses it.

import { randomUUID } from "node:crypto";

import type { EnginePosition } from "../engine/protocol.js";
import type { SessionClient } from "../engine/service.js";
import { fail, type ToolResult } from "../tools/_shared.js";
import { txHashHint } from "../tx/record.js";
import type { Purpose } from "../vocab/purpose.js";
import type { WorkerHost } from "../workers/host.js";
import { isTxHash } from "./txStore.js";

export const DBG_ID_PATTERN = /^dbg_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SessionMode = "tx" | "parts" | "program";
export type PlutusLanguage = "V1" | "V2" | "V3";

/** Why a session's worker was lost, as far as the host could tell. */
export type LossCause = "wasm_trap" | "out_of_memory" | "hard_timeout" | "worker_crash" | "aborted" | "unknown";

/** Cause of a loss from the host's reason / detail text (`fatal_error: RuntimeError: …`, `timeout: run exceeded 9 s`, …). */
export function classifyLoss(reason: string | undefined): LossCause {
  const text = reason ?? "";
  if (/out of memory|memory limit|heap/i.test(text)) return "out_of_memory";
  if (/wasm trap|fatal_error|RuntimeError|unreachable|out of bounds|call stack/i.test(text)) return "wasm_trap";
  if (/timeout|did not answer within|exceeded \d/i.test(text)) return "hard_timeout";
  if (/abort/i.test(text)) return "aborted";
  if (/worker_exit|worker_error|exit code|crash|ready_timeout/i.test(text)) return "worker_crash";
  return "unknown";
}

/** Persistent breakpoints: normalised term ids and 1-based lines of the canonical UPLC listing. */
export interface SessionBreakpoints {
  termIds: number[];
  uplcLines: number[];
}

export interface SessionRecord {
  dbgId: string;
  createdAt: number;
  lastUsedAt: number;
  /** Absolute deadline (createdAt + absoluteTtlMs). */
  expiresAt: number;

  /** The session's own worker (engine wasm instance). `null` until the engine layer attaches one. */
  worker: WorkerHost | null;
  /** Typed facade over `worker` (engine layer). */
  client: SessionClient | null;
  mode: SessionMode;
  txId?: string;
  /** Canonical redeemer ref when `mode === 'tx'`. */
  redeemer?: string;
  scriptHash?: string;
  language: PlutusLanguage;
  purpose?: Purpose;
  protocolVersion?: number;
  /** Exact engine `PartsConfig` (or `{program, language}`), kept to reopen a lost session. */
  partsConfig: Record<string, unknown>;
  breakpoints: SessionBreakpoints;
  /** How many engine log lines have already been reported to the model. */
  logsOffset: number;
  /** Last non-negative term id seen (the engine answers -1 in Return state). */
  lastTermId: number;
  totalSteps: number;
  memoryBytes: number;
  /** A wasm trap poisoned the instance; every call answers `session_lost`. */
  poisoned: boolean;
  /** Worker terminated (timeout / crash); `partsConfig` still allows a reopen. */
  lost: boolean;
  /** Why it was lost (see `lostReason` for the host's own words). */
  lostCause?: LossCause;
  /** Commands in flight; the worker serialises them, `busy` is `leases > 0` (such a session is never evicted). */
  leases: number;
  /** A command is in flight. */
  busy: boolean;
  /** A long command (debug_run / debug_profile) is in flight: others are refused with `busy` instead of queued. */
  running?: { tool: string; since: number };
  /**
   * Term id of the failure the last run that ended in an error stopped at (an explicit `(error)`
   * term), `null` when it failed without a term of its own (builtin / machine error). Set by
   * debug_run, kept through rewinds, inspections and later runs; a new session starts without one.
   */
  errorTermId?: number | null;
  /**
   * The last term computed before that failure (`position.last_term_id`): for a builtin / machine
   * error, where `errorTermId` is null, the nearest term to blame (it may have run many times).
   */
  errorLastTermId?: number | null;
  /** Engine `get_version()` at the last observation (decimal string). */
  version?: string;

  // ---- engine layer (debug_open fills these) ----
  network?: string;
  termCount?: number;
  termIdBase?: number;
  uplcLines?: number;
  hasContext?: boolean;
  costModelSource?: string;
  /** Declared ex-units (`[cpu, mem]` semantics) when the session has a limit. */
  declaredExUnits?: { cpu: string; mem: string };
  /** What the validator computed for this redeemer (tx mode): the `parity` reference. */
  calculatedExUnits?: { steps: string; mem: string };
  lastPosition?: EnginePosition;
  lastStatus?: "ready" | "done" | "error";
  /** Why the worker was lost, when it was. */
  lostReason?: string;
  notes: string[];
  /** Free slot for the engine layer (TermIndex handles, pause bookkeeping, …). */
  extra: Record<string, unknown>;
}

export type SessionInit = Partial<Omit<SessionRecord, "createdAt" | "lastUsedAt" | "expiresAt">> &
  Pick<SessionRecord, "mode" | "language" | "partsConfig">;

/** Result of `acquire`: the record is now leased and must be `release`d. */
export type SessionLease =
  | { ok: true; record: SessionRecord; release: () => void }
  | { ok: false; reason: "missing" | "busy" | "lost"; running?: { tool: string; since_ms: number } };

export interface AcquireOptions {
  /** The command, for the `busy` answer other calls get while it runs. */
  tool?: string;
  /** A long command (debug_run / debug_profile): exclusive, and refuses everything else while it runs. */
  long?: boolean;
}

export type SessionEvictReason = "lru" | "idle" | "absolute" | "closed" | "shutdown";

export interface SessionRegistryOptions {
  /** Max live sessions; opening one more evicts the least recently used. Default 8. */
  max?: number;
  /** Idle TTL. Default 30 min. */
  idleTtlMs?: number;
  /** Absolute TTL. Default 4 h. */
  absoluteTtlMs?: number;
  /** Sweeper period. Default 60 s. */
  sweepIntervalMs?: number;
  now?: () => number;
  /** Called for every removal, after the worker was told to dispose. */
  onEvict?: (record: SessionRecord, reason: SessionEvictReason) => void;
}

/** Thrown by `create` when the registry is full and every session is executing a command. */
export class SessionLimitError extends Error {
  readonly data: { code: "session_limit"; max: number; busy: string[] };
  constructor(max: number, busy: string[]) {
    super(`${max} debug sessions are open and all of them are executing a command; wait for one to return or debug_close one, then retry`);
    this.name = "SessionLimitError";
    this.data = { code: "session_limit", max, busy };
  }
}

/** What `debug_open(reopen=<dbg_id>)` needs to rebuild a session without the caller resending its inputs. */
export type SessionReopen = Pick<SessionRecord, "mode" | "language" | "partsConfig" | "txId" | "redeemer" | "purpose" | "protocolVersion" | "network" | "costModelSource" | "calculatedExUnits" | "notes">;

/** Why a handle no longer answers. */
export interface Tombstone {
  dbgId: string;
  cause: SessionEvictReason | LossCause;
  /** Extra words for the cause (the registry size, the host's loss detail). */
  detail?: string;
  at: number;
  mode: SessionMode;
  txId?: string;
  redeemer?: string;
  lastKnown?: { steps_total: number; position?: { term_id: number | null; uplc_line: number | null; machine_state: string } };
  /** Absent when the session's config was too large to keep. */
  reopen?: SessionReopen;
}

const TOMBSTONE_MAX = 32;
/** Config kept for a reopen is dropped above this size (a big ScriptContext is cheap to resend, not to hold 32 times). */
const TOMBSTONE_CONFIG_MAX_CHARS = 512 * 1024;
/**
 * Process-wide ring (dbg ids are unique across registries): `expiredHandleError` is a plain function
 * every tool calls with just an id, and answers from here.
 */
const tombstones = new Map<string, Tombstone>();

function remember(tombstone: Tombstone): void {
  tombstones.delete(tombstone.dbgId);
  tombstones.set(tombstone.dbgId, tombstone);
  while (tombstones.size > TOMBSTONE_MAX) tombstones.delete(tombstones.keys().next().value as string);
}

/** Forget every tombstone (tests, a fresh context). */
export function clearTombstones(): void {
  tombstones.clear();
}

export function tombstoneOf(dbgId: string): Tombstone | undefined {
  return tombstones.get(dbgId);
}

function reopenSnapshot(record: SessionRecord): SessionReopen | undefined {
  let size = 0;
  try {
    size = JSON.stringify(record.partsConfig).length;
  } catch {
    return undefined;
  }
  if (size > TOMBSTONE_CONFIG_MAX_CHARS) return undefined;
  const { mode, language, partsConfig, txId, redeemer, purpose, protocolVersion, network, costModelSource, calculatedExUnits, notes } = record;
  return { mode, language, partsConfig, txId, redeemer, purpose, protocolVersion, network, costModelSource, calculatedExUnits, notes };
}

function lastKnownOf(record: Pick<SessionRecord, "totalSteps" | "lastPosition">): Tombstone["lastKnown"] {
  const position = record.lastPosition;
  return {
    steps_total: record.totalSteps,
    ...(position ? { position: { term_id: position.term_id, uplc_line: position.uplc_line, machine_state: position.machine_state } } : {}),
  };
}

export class SessionRegistry {
  private readonly records = new Map<string, SessionRecord>();
  private readonly max: number;
  private readonly idleTtlMs: number;
  private readonly absoluteTtlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private readonly onEvict: SessionRegistryOptions["onEvict"];
  private sweeper: ReturnType<typeof setInterval> | null = null;
  /** Callers of `acquireWait` parked until a session's next release. */
  private readonly releaseWaiters = new Map<string, Array<() => void>>();

  constructor(options: SessionRegistryOptions = {}) {
    this.max = options.max ?? 8;
    this.idleTtlMs = options.idleTtlMs ?? 30 * 60 * 1000;
    this.absoluteTtlMs = options.absoluteTtlMs ?? 4 * 60 * 60 * 1000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60 * 1000;
    this.now = options.now ?? Date.now;
    this.onEvict = options.onEvict;
  }

  get size(): number {
    return this.records.size;
  }

  get limits(): { max: number; idleTtlMs: number; absoluteTtlMs: number } {
    return { max: this.max, idleTtlMs: this.idleTtlMs, absoluteTtlMs: this.absoluteTtlMs };
  }

  newId(): string {
    return `dbg_${randomUUID()}`;
  }

  /**
   * Who makes room for a new session: a lost / poisoned one first (nothing to lose, even with a call
   * still failing on it), else the least recently used session with no command in flight. A session
   * with a command in flight is never evicted: its worker would die mid-call.
   */
  private pickVictim(): string | undefined {
    let lru: string | undefined;
    for (const [id, record] of this.records) {
      if (record.lost || record.poisoned || record.client?.lost) return id;
      if (!record.busy && lru === undefined) lru = id;
    }
    return lru;
  }

  /** Throws `SessionLimitError` when no slot could be freed for a new session (checked before the expensive open). */
  assertRoom(): void {
    if (this.records.size >= this.max && this.pickVictim() === undefined) throw new SessionLimitError(this.max, Array.from(this.records.keys()));
  }

  /**
   * Register a session. When the registry is full a dead session, else the least recently used IDLE
   * one, is evicted (its worker disposed) and returned as `evicted` so the tool can name it in its
   * answer; when every session is executing a command a `SessionLimitError` is thrown. Callers
   * register a session once it opened, so a failed open evicts nothing.
   */
  create(init: SessionInit): { record: SessionRecord; evicted?: SessionRecord } {
    const now = this.now();
    let evicted: SessionRecord | undefined;
    while (this.records.size >= this.max) {
      const victim = this.pickVictim();
      if (victim === undefined) throw new SessionLimitError(this.max, Array.from(this.records.keys()));
      evicted = this.remove(victim, "lru") ?? evicted;
    }
    const record: SessionRecord = {
      worker: null,
      client: null,
      notes: [],
      breakpoints: { termIds: [], uplcLines: [] },
      logsOffset: 0,
      lastTermId: -1,
      totalSteps: 0,
      memoryBytes: 0,
      poisoned: false,
      lost: false,
      leases: 0,
      busy: false,
      extra: {},
      ...init,
      dbgId: init.dbgId ?? this.newId(),
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + this.absoluteTtlMs,
    };
    this.records.set(record.dbgId, record);
    tombstones.delete(record.dbgId);
    return evicted ? { record, evicted } : { record };
  }

  /** Fetch and mark used; expired sessions are closed and reported as missing. */
  get(dbgId: string): SessionRecord | undefined {
    const record = this.records.get(dbgId);
    if (!record) return undefined;
    const reason = this.expiryReason(record);
    if (reason) {
      this.remove(dbgId, reason);
      return undefined;
    }
    this.touch(dbgId);
    return record;
  }

  peek(dbgId: string): SessionRecord | undefined {
    const record = this.records.get(dbgId);
    if (!record || this.expiryReason(record)) return undefined;
    return record;
  }

  touch(dbgId: string): boolean {
    const record = this.records.get(dbgId);
    if (!record) return false;
    record.lastUsedAt = this.now();
    this.records.delete(dbgId);
    this.records.set(dbgId, record);
    return true;
  }

  /** Close one session: dispose its worker and forget it. */
  close(dbgId: string, reason: SessionEvictReason = "closed"): boolean {
    return this.remove(dbgId, reason) !== undefined;
  }

  /**
   * What `debug_open(reopen=<dbg_id>)` rebuilds from: the live record (a lost one keeps its config),
   * else the tombstone of an evicted / expired / closed one.
   */
  reopenSource(dbgId: string): SessionReopen | undefined {
    const record = this.records.get(dbgId);
    if (record) return reopenSnapshot(record);
    return tombstones.get(dbgId)?.reopen;
  }

  /**
   * Take a lease on the session. The worker runs one call at a time (its host queues the rest), so
   * short commands may overlap: they simply queue behind each other. A long command (debug_run /
   * debug_profile) is exclusive: while one runs everything else answers `busy` (with what runs and
   * for how long), and it cannot start while others are in flight (`acquireWait` waits for those).
   * Lost / poisoned sessions are refused so tools give one consistent answer.
   */
  acquire(dbgId: string, options: AcquireOptions = {}): SessionLease {
    const record = this.get(dbgId);
    if (!record) return { ok: false, reason: "missing" };
    if (record.lost || record.poisoned || record.client?.lost) {
      record.lost = true;
      return { ok: false, reason: "lost" };
    }
    if (record.running) return { ok: false, reason: "busy", running: { tool: record.running.tool, since_ms: Math.max(0, this.now() - record.running.since) } };
    if (options.long && record.leases > 0) return { ok: false, reason: "busy" };
    record.leases++;
    record.busy = true;
    if (options.long) record.running = { tool: options.tool ?? "command", since: this.now() };
    let released = false;
    return {
      ok: true,
      record,
      release: () => {
        if (released) return;
        released = true;
        record.leases = Math.max(0, record.leases - 1);
        record.busy = record.leases > 0;
        if (options.long) record.running = undefined;
        this.touch(record.dbgId);
        const waiters = this.releaseWaiters.get(record.dbgId);
        if (waiters) {
          this.releaseWaiters.delete(record.dbgId);
          for (const wake of waiters) wake();
        }
      },
    };
  }

  /**
   * `acquire` that waits (up to `waitMs`) while other SHORT commands are in flight, so a batch of
   * parallel calls on one session all complete. A long command in flight is never waited for.
   */
  async acquireWait(dbgId: string, options: AcquireOptions = {}, waitMs = 4_000): Promise<SessionLease> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const lease = this.acquire(dbgId, options);
      if (lease.ok || lease.reason !== "busy" || lease.running) return lease;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return lease;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, remaining);
        const waiters = this.releaseWaiters.get(dbgId) ?? [];
        waiters.push(done);
        this.releaseWaiters.set(dbgId, waiters);
        function done(): void {
          clearTimeout(timer);
          resolve();
        }
      });
    }
  }

  /** Mark a session as lost (worker terminated); the record stays so `debug_open` can name the reopen. */
  markLost(dbgId: string, reason: string, cause?: LossCause): void {
    const record = this.records.get(dbgId);
    if (!record) return;
    record.lost = true;
    record.lostReason = reason;
    record.lostCause = cause ?? classifyLoss(reason);
    record.running = undefined;
  }

  /** Sessions, most recently used first. */
  list(): SessionRecord[] {
    return Array.from(this.records.values()).reverse();
  }

  /** Close every expired session; returns them. */
  sweep(): SessionRecord[] {
    const closed: SessionRecord[] = [];
    for (const [id, record] of Array.from(this.records)) {
      const reason = this.expiryReason(record);
      if (reason) {
        const removed = this.remove(id, reason);
        if (removed) closed.push(removed);
      }
    }
    return closed;
  }

  startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      try {
        this.sweep();
      } catch (error) {
        console.error("[cardano-debug] session sweeper failed:", error);
      }
    }, this.sweepIntervalMs);
    this.sweeper.unref();
  }

  stopSweeper(): void {
    if (!this.sweeper) return;
    clearInterval(this.sweeper);
    this.sweeper = null;
  }

  /** Close everything (SIGINT / dispose). */
  closeAll(reason: SessionEvictReason = "shutdown"): void {
    this.stopSweeper();
    for (const id of Array.from(this.records.keys())) this.remove(id, reason);
  }

  private expiryReason(record: SessionRecord): SessionEvictReason | null {
    const now = this.now();
    if (now >= record.expiresAt) return "absolute";
    if (now - record.lastUsedAt > this.idleTtlMs) return "idle";
    return null;
  }

  private remove(dbgId: string, reason: SessionEvictReason): SessionRecord | undefined {
    const record = this.records.get(dbgId);
    if (!record) return undefined;
    this.records.delete(dbgId);
    if (reason !== "shutdown") {
      // A lost session keeps its loss cause: that is the answer to "why is my handle gone".
      const tombstone: Tombstone = {
        dbgId,
        cause: record.lost ? (record.lostCause ?? classifyLoss(record.lostReason)) : reason,
        at: this.now(),
        mode: record.mode,
        lastKnown: lastKnownOf(record),
        ...(record.lost && record.lostReason ? { detail: record.lostReason } : reason === "lru" ? { detail: `the registry keeps ${this.max} sessions` } : {}),
        ...(record.txId ? { txId: record.txId } : {}),
        ...(record.redeemer ? { redeemer: record.redeemer } : {}),
      };
      const reopen = reopenSnapshot(record);
      if (reopen) tombstone.reopen = reopen;
      remember(tombstone);
    }
    if (record.client) {
      void record.client.close().catch(() => undefined);
    } else if (record.worker) {
      void record.worker.dispose().catch(() => undefined);
    }
    try {
      this.onEvict?.(record, reason);
    } catch (error) {
      console.error("[cardano-debug] onEvict handler threw:", error);
    }
    return record;
  }
}

// ---------- answers for a handle that cannot be used ----------

function iso(at: number): string {
  return new Date(at).toISOString();
}

/** The call that rebuilds a session, in the words the model should type. */
function reopenCall(id: string, info: { mode?: SessionMode; txId?: string; redeemer?: string; reopen?: boolean }): string {
  if (info.mode === "tx" && info.txId && info.redeemer) return `debug_open(tx_id=${JSON.stringify(info.txId)}, redeemer=${JSON.stringify(info.redeemer)})`;
  if (info.reopen) return `debug_open(reopen=${JSON.stringify(id)})`;
  return "debug_open with the same arguments";
}

function lastKnownText(last: Tombstone["lastKnown"]): string {
  if (!last) return "";
  const p = last.position;
  const where = p ? `, ${p.machine_state}${p.term_id !== null ? ` at term ${p.term_id}` : ""}${p.uplc_line !== null ? ` (line ${p.uplc_line})` : ""}` : "";
  return `Last completed state: step ${last.steps_total.toLocaleString("en-US")}${where}. `;
}

/** The cause as a clause (`it was evicted …`), without the closing period. */
function whyGone(t: Tombstone, idleTtlMin: number): string {
  switch (t.cause) {
    case "lru":
      return `it was evicted at ${iso(t.at)} to make room for a newer session (${t.detail ?? "the registry is bounded"}; the least recently used idle one goes)`;
    case "idle":
      return `it expired at ${iso(t.at)} after ${idleTtlMin} minutes without a command`;
    case "absolute":
      return `it reached its absolute lifetime at ${iso(t.at)}`;
    case "closed":
      return `it was closed (debug_close) at ${iso(t.at)}`;
    case "shutdown":
      return `the server shut down at ${iso(t.at)}`;
    default:
      return `its worker was lost (${lossClause(t.cause, t.detail)}) and the session was removed at ${iso(t.at)}`;
  }
}

/**
 * The `isError` tool result for an unknown / expired handle. Never a protocol error: the model reads
 * the text and calls `recreate_with` again. For a debug session it says why the handle is gone when
 * the server remembers (evicted, idle, closed, lost with which cause) and how to reopen it.
 */
export function expiredHandleError(
  id: string,
  recreateWith: "tx_load" | "debug_open",
  extra: Record<string, unknown> = {},
): ToolResult {
  if (recreateWith === "tx_load") {
    // A 64-hex hash typed where a handle belongs: say what it is and how to load it.
    const hashed = isTxHash(id);
    return fail({
      code: "expired_handle",
      message: hashed ? txHashHint(id, "tx_id") : `Unknown or expired transaction handle ${JSON.stringify(id)}. Call tx_load again with the same arguments to recreate it (cheap), then retry.`,
      handle: id,
      recreate_with: recreateWith,
      ...(hashed ? { argument: "tx_id" } : {}),
      ...extra,
    });
  }
  const t = tombstones.get(id);
  if (!t) {
    return fail({
      code: "expired_handle",
      message: `Unknown debug session handle ${JSON.stringify(id)}: this server process never opened it, or it was forgotten (a restart, or more than ${TOMBSTONE_MAX} sessions ago). Open a new one with debug_open (cheap), then retry.`,
      handle: id,
      recreate_with: recreateWith,
      ...extra,
    });
  }
  const reopen = reopenCall(id, { mode: t.mode, txId: t.txId, redeemer: t.redeemer, reopen: t.reopen !== undefined });
  return fail({
    code: "expired_handle",
    message: `Debug session ${id} is gone: ${whyGone(t, 30)}. ${lastKnownText(t.lastKnown)}Reopen it with ${reopen} (cheap), then run again.`,
    handle: id,
    recreate_with: recreateWith,
    reason: t.cause,
    at: iso(t.at),
    ...(t.lastKnown ? { last_known: t.lastKnown } : {}),
    ...(t.reopen ? { reopen_with: { reopen: id } } : {}),
    ...(t.txId ? { tx_id: t.txId } : {}),
    ...(t.redeemer ? { redeemer: t.redeemer } : {}),
    ...extra,
  });
}

/** `isError` result when no session slot can be freed (every open session is busy). */
export function sessionLimitError(error: SessionLimitError): ToolResult {
  return fail({
    code: "session_limit",
    message: error.message,
    max_sessions: error.data.max,
    busy_sessions: error.data.busy,
    recreate_with: "debug_open",
  });
}

/**
 * `isError` result for a session refused while a long command (debug_run / debug_profile) runs on it:
 * what runs and for how long, so the model neither guesses nor retries blindly.
 */
export function busySessionError(dbgId: string, running?: { tool: string; since_ms: number }): ToolResult {
  const doing = running ? `is running ${running.tool} (for ${(running.since_ms / 1000).toFixed(1)} s)` : "is executing another command";
  return fail({
    code: "busy",
    message: `Session ${dbgId} ${doing}; commands on one session are serialised. Wait for it to return${running ? ` (a smaller timeout_ms / max_steps bounds a run)` : ""}, then retry.`,
    handle: dbgId,
    ...(running ? { running: running.tool, since_ms: running.since_ms } : {}),
  });
}

/** The loss cause as a clause, with the host's detail when it has one. */
function lossClause(cause: LossCause | SessionEvictReason, detail: string | undefined): string {
  const more = detail ? `: ${detail.length > 240 ? `${detail.slice(0, 240)}…` : detail}` : "";
  switch (cause) {
    case "wasm_trap":
      return /call stack|RangeError/i.test(detail ?? "")
        ? `the engine overflowed its stack, typically reading the frames of a very deep call stack${more}`
        : `the wasm engine trapped${more}`;
    case "out_of_memory":
      return `the worker ran out of memory${more}`;
    case "hard_timeout":
      return `the worker stopped answering and was killed${more}`;
    case "worker_crash":
      return `the worker exited unexpectedly${more}`;
    case "aborted":
      return `the call was cancelled while the worker was busy and the worker was terminated${more}`;
    default:
      return detail ? detail : "its worker terminated";
  }
}

function lossAdvice(cause: LossCause, steps: number): string {
  const before = steps > 0 ? ` that stops before step ${steps.toLocaleString("en-US")}` : "";
  switch (cause) {
    case "wasm_trap":
      return `The engine fails the same way on the same steps, so a plain retry traps again: after reopening, run in bounded steps (debug_run steps / max_steps${before}) and avoid reading frames on a deep call stack.`;
    case "hard_timeout":
      return `The run loop polls for cancellation every 512 steps, so the worker was stuck inside one engine call (a very deep stack read with frames, or one huge builtin), not stepping slowly: after reopening, bound the run (max_steps${before}, timeout_ms).`;
    case "out_of_memory":
      return `After reopening, run in bounded steps (max_steps${before}); the worker heap limit is CARDANO_DEBUG_WORKER_HEAP_MB.`;
    case "worker_crash":
      return "Reopening is cheap; if it crashes again at the same point, report the script and the steps.";
    default:
      return "";
  }
}

/** `isError` result for a session whose worker was terminated (hard timeout, trap, crash). */
export function lostSessionError(
  record: Pick<SessionRecord, "dbgId" | "lostReason" | "mode" | "txId" | "redeemer"> & Partial<Pick<SessionRecord, "lostCause" | "totalSteps" | "lastPosition" | "partsConfig">>,
): ToolResult {
  const cause = record.lostCause ?? classifyLoss(record.lostReason);
  const reopen = reopenCall(record.dbgId, { mode: record.mode, txId: record.txId, redeemer: record.redeemer, reopen: record.partsConfig !== undefined });
  const last = record.totalSteps !== undefined ? lastKnownOf({ totalSteps: record.totalSteps, lastPosition: record.lastPosition }) : undefined;
  const advice = lossAdvice(cause, record.totalSteps ?? 0);
  return fail({
    code: "session_lost",
    message: `Session ${record.dbgId} was lost: ${lossClause(cause, record.lostReason)}. ${lastKnownText(last)}${advice ? `${advice} ` : ""}Its position cannot be recovered; reopen it with ${reopen} (cheap).`,
    handle: record.dbgId,
    cause,
    recreate_with: "debug_open",
    ...(last ? { last_known: last } : {}),
    ...(record.partsConfig !== undefined ? { reopen_with: { reopen: record.dbgId } } : {}),
    ...(record.txId ? { tx_id: record.txId } : {}),
    ...(record.redeemer ? { redeemer: record.redeemer } : {}),
  });
}
