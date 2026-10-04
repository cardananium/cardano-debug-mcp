// debug_open / debug_run / debug_inspect / debug_profile against stub session clients: no worker, no
// engine, so every branch of the tool layer (registration order, notes, chunking, leasing) is
// exercised in milliseconds.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import type { AppContext } from "../../src/context.js";
import { wrapCborBytes } from "../../src/decompiler/scriptBytes.js";
import type { PositionReport, RunReport, RunSpec, SessionSummary } from "../../src/engine/protocol.js";
import type { SessionClient } from "../../src/engine/service.js";
import type { EvalRedeemerResultWire } from "../../src/lib.js";
import { clearTombstones, SessionRegistry } from "../../src/store/sessionRegistry.js";
import { TxStore, type TxRecord } from "../../src/store/txStore.js";
import { debugInspect } from "../../src/tools/debug_inspect.js";
import { debugOpen, type DebugOpenArgs } from "../../src/tools/debug_open.js";
import { debugProfile } from "../../src/tools/debug_profile.js";
import { debugRun, type DebugRunArgs } from "../../src/tools/debug_run.js";
import { WorkerCallError } from "../../src/workers/rpc.js";
import { fxStr, readFixtureJson, readFixtureText } from "../helpers/fixtures.js";

type Json = Record<string, any>;
type Fn = (...args: any[]) => unknown;

// The artificial S1 transaction: the raw validator result and its V2 spend script (single-CBOR-wrapped).
const fixture = readFixtureJson<{ protocol_parameters: { protocolVersion: [number, number] }; eval_redeemer_results: EvalRedeemerResultWire[] }>(fxStr("s01.evalFile"));
const spend = fixture.eval_redeemer_results.find((r) => r.tag === "Spend")!;
const SAMPLE_SINGLE = readFixtureText(fxStr("s01.spendScriptFile")).trim().toLowerCase();

const position = { term_id: 1, raw_term_id: 101, kind: "Var", uplc_line: 2, machine_state: "Compute" as const, last_term_id: 1 };

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    script_hash: null,
    language: "V3",
    purpose: null,
    plutus_core_version: "1.1.0",
    term_count: 13,
    term_id_base: 100,
    uplc_lines: 20,
    longest_uplc_line: 30,
    declared_ex_units: null,
    has_script_context: false,
    position,
    budget: { cpu_spent: "0", mem_spent: "0", over_budget: false },
    version: "0",
    uplc_window: { total_lines: 20, line_from: 1, line_to: 3, dedent: 0, lines: [], text: "1> [" },
    ...over,
  };
}

function report(over: Partial<RunReport> = {}): RunReport {
  return {
    stopped: { kind: "done", detail: "the script completed" },
    steps_this_call: 10,
    steps_total: 10,
    status: "done",
    position: { ...position, machine_state: "Done" },
    uplc_window: { total_lines: 20, line_from: 1, line_to: 3, dedent: 0, lines: [], text: "1> [" },
    frames: [],
    frames_total: 0,
    budget: { cpu_spent: "100", mem_spent: "10", over_budget: false },
    traces: { total: 0, new: [], new_total: 0 },
    version: "1",
    ...over,
  };
}

interface Fake {
  client: SessionClient;
  calls: Array<{ method: string; args: unknown[] }>;
  closed: () => number;
}

function fake(over: Record<string, Fn> = {}): Fake {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let closes = 0;
  const base: Record<string, Fn> = {
    openProgram: async () => summary(),
    openParts: async () => summary({ has_script_context: true }),
    run: async () => report(),
    position: async () => ({ position, uplc_window: { total_lines: 20, line_from: 1, line_to: 3, dedent: 0, lines: [], text: "1> [" }, frames: [], frames_total: 0, budget: { cpu_spent: "0", mem_spent: "0", over_budget: false }, version: "1", status: "ready", steps_total: 0 }) as PositionReport,
    inspect: async () => ({ total: 0, items: [] }),
    locate: async () => ({ uplc: { line: 1, excerpt: [] }, term_id: 0 }),
    profile: async () => ({ outcome: "done", totals: { steps: "1", cpu: "1", mem: "1", startup_cpu: "0", startup_mem: "0", over_budget: false }, hot_terms: [], hot_lines: [], builtins: [], step_kinds: [], timeline: [], traces: { total: 0, dropped: 0, items: [] }, terms_executed: 0, report_chars: 10, elapsed_ms: 1 }),
  };
  const client = new Proxy(
    {},
    {
      get(_t, prop) {
        const name = String(prop);
        if (name === "lost") return false;
        if (name === "host") return { dispose: async () => undefined, stats: () => ({}) };
        if (name === "close") return async () => void closes++;
        const impl = over[name] ?? base[name];
        if (!impl) return undefined;
        return (...args: unknown[]) => {
          calls.push({ method: name, args });
          return impl(...args);
        };
      },
    },
  ) as unknown as SessionClient;
  return { client, calls, closed: () => closes };
}

function ctxWith(opts: { max?: number; clients?: () => SessionClient } = {}): AppContext {
  const registry = new SessionRegistry({ max: opts.max, sweepIntervalMs: 60_000 });
  const engine = { newClient: () => (opts.clients ? opts.clients() : fake().client) };
  return {
    config: loadConfig({}),
    lib: {} as AppContext["lib"],
    txStore: new TxStore(),
    sessions: registry,
    startedAt: Date.now(),
    services: { engine } as unknown as AppContext["services"],
    onShutdown: () => undefined,
    shutdown: async () => undefined,
  };
}

function sessionWith(ctx: AppContext, client: SessionClient, over: Record<string, unknown> = {}) {
  return ctx.sessions.create({ mode: "program", language: "V3", partsConfig: { program: "(program 1.1.0 (con integer 1))", language: "v3" }, client, termCount: 13, uplcLines: 20, hasContext: false, lastStatus: "ready", ...over } as never).record;
}

function sc(result: { structuredContent: Json }): Json {
  return result.structuredContent;
}

beforeEach(() => clearTombstones());
afterEach(() => clearTombstones());

describe("debug_open: registration happens after the open", () => {
  it("a failed open evicts nothing, says why, and leaves no worker behind", async () => {
    const f = fake({
      openProgram: async () => {
        throw new Error("Program is neither UPLC text nor valid hex");
      },
    });
    const ctx = ctxWith({ max: 2, clients: () => f.client });
    const a = sessionWith(ctx, fake().client);
    const b = sessionWith(ctx, fake().client);
    const result = await debugOpen(ctx, { script: "00" } as DebugOpenArgs, undefined);
    expect(result.isError).toBe(true);
    expect(sc(result)).toMatchObject({ code: "invalid_argument" });
    expect(String(sc(result).message)).toMatch(/engine could not open the session/);
    expect(ctx.sessions.size).toBe(2);
    expect(ctx.sessions.peek(a.dbgId)).toBeDefined();
    expect(ctx.sessions.peek(b.dbgId)).toBeDefined();
    expect(f.closed()).toBe(1);
  });

  it("an open that succeeds at the limit evicts the least recently used idle session and names it", async () => {
    const ctx = ctxWith({ max: 2 });
    const a = sessionWith(ctx, fake().client);
    const b = sessionWith(ctx, fake().client);
    ctx.sessions.touch(a.dbgId);
    const result = await debugOpen(ctx, { script: TRACE_PROGRAM } as DebugOpenArgs, undefined);
    expect(result.isError).toBeFalsy();
    expect(sc(result).evicted).toMatchObject({ dbg_id: b.dbgId, reason: "lru" });
    expect(ctx.sessions.size).toBe(2);
    expect(ctx.sessions.peek(a.dbgId)).toBeDefined();
  });

  it("prefers a lost session as the victim", async () => {
    const ctx = ctxWith({ max: 2 });
    const healthy = sessionWith(ctx, fake().client);
    const lost = sessionWith(ctx, fake().client);
    ctx.sessions.markLost(lost.dbgId, "timeout: run exceeded 9 s");
    const result = await debugOpen(ctx, { script: TRACE_PROGRAM } as DebugOpenArgs, undefined);
    expect(sc(result).evicted).toMatchObject({ dbg_id: lost.dbgId, reason: "lost" });
    expect(ctx.sessions.peek(healthy.dbgId)).toBeDefined();
  });

  it("when every session is executing a command it answers session_limit without spawning a worker", async () => {
    let spawned = 0;
    const ctx = ctxWith({ max: 1, clients: () => (spawned++, fake().client) });
    const a = sessionWith(ctx, fake().client);
    const lease = ctx.sessions.acquire(a.dbgId);
    const result = await debugOpen(ctx, { script: TRACE_PROGRAM } as DebugOpenArgs, undefined);
    expect(sc(result)).toMatchObject({ code: "session_limit" });
    expect(spawned).toBe(0);
    if (lease.ok) lease.release();
  });

  it("announces the session's resources once, through the `resources` list (and no other tool does)", async () => {
    const ctx = ctxWith();
    const result = await debugOpen(ctx, { script: TRACE_PROGRAM } as DebugOpenArgs, undefined);
    const id = sc(result).dbg_id;
    expect(sc(result).resources.map((r: Json) => r.uri)).toEqual([`cardano-debug://session/${id}/uplc.txt`, `cardano-debug://session/${id}/state.json`, `cardano-debug://session/${id}/traces.txt`]);
    expect(result.content.every((c) => c.type === "text")).toBe(true);
  });
});

const TRACE_PROGRAM = '(program 1.0.0 [[(force (builtin trace)) (con string "hello")] [(lam x [(builtin addInteger) x (con integer 1)]) (con integer 41)]])';

describe("debug_open: what it reports and says about its arguments", () => {
  it("program-only: the effective protocol, the default language, and the ignored protocol_major", async () => {
    const ctx = ctxWith();
    const plain = sc(await debugOpen(ctx, { script: TRACE_PROGRAM } as DebugOpenArgs, undefined));
    expect(plain).toMatchObject({ mode: "program", protocol_major: 11, protocol_major_source: "engine_default", cost_model_source: "engine_default" });
    expect(plain.notes).toEqual(expect.arrayContaining(["plutus_version not given: V3 assumed"]));
    const given = sc(await debugOpen(ctx, { script: TRACE_PROGRAM, plutus_version: "V2", protocol_major: 9 } as DebugOpenArgs, undefined));
    expect(given.protocol_major).toBe(11);
    expect(given.notes.join("\n")).toMatch(/ignored: protocol_major.*always runs with the engine's protocol 11/);
  });

  it("parts: a supplied protocol_major is reported as supplied, an absent one as the engine's 11; redeemer without tx_id is called out", async () => {
    const ctx = ctxWith();
    const args = { script: SAMPLE_SINGLE, plutus_version: "V2", context: "d87980", redeemer_data: "d87980" };
    const dflt = sc(await debugOpen(ctx, args as DebugOpenArgs, undefined));
    expect(dflt).toMatchObject({ mode: "parts", protocol_major: 11, protocol_major_source: "engine_default" });
    const given = sc(await debugOpen(ctx, { ...args, protocol_major: 9 } as DebugOpenArgs, undefined));
    expect(given).toMatchObject({ protocol_major: 9, protocol_major_source: "supplied" });
    const ref = sc(await debugOpen(ctx, { ...args, redeemer: "spend:0" } as DebugOpenArgs, undefined));
    expect(ref.notes.join("\n")).toMatch(/ignored: redeemer \(a transaction redeemer ref such as spend:0; it needs tx_id\)/);
  });

  it("script_decompile is promised only for a session with compiled bytes", async () => {
    const ctx = ctxWith();
    const hex = sc(await debugOpen(ctx, { script: SAMPLE_SINGLE, plutus_version: "V2" } as DebugOpenArgs, undefined));
    expect(hex.docs_hint).toMatch(/script_decompile\(dbg_id\) gives/);
    const text = sc(await debugOpen(ctx, { script: TRACE_PROGRAM } as DebugOpenArgs, undefined));
    expect(text.docs_hint).toMatch(/opened from UPLC text: script_decompile\(dbg_id\) answers no_script_bytes, pass the compiled script bytes via script/);
    expect(text.docs_hint).not.toMatch(/script_decompile\(dbg_id\) gives/);
    // parts mode from UPLC text keeps the text as `script`: same answer
    const parts = sc(await debugOpen(ctx, { script: TRACE_PROGRAM, plutus_version: "V2", context: "d87980" } as DebugOpenArgs, undefined));
    expect(parts.mode).toBe("parts");
    expect(parts.docs_hint).toMatch(/opened from UPLC text/);
  });
});

describe("debug_open: script in other wrappings", () => {
  const double = wrapCborBytes(SAMPLE_SINGLE);
  const forms: Array<[string, string]> = [
    ["cardano-cli envelope", JSON.stringify({ type: "PlutusScriptV2", description: "", cborHex: double })],
    ["base64", Buffer.from(SAMPLE_SINGLE, "hex").toString("base64")],
    ["ScriptRef", `8202${double}`],
  ];
  for (const [label, script] of forms) {
    it(`${label}: read as the script's own bytes, the stated version taken, a note says so`, async () => {
      const opened: string[] = [];
      const f = fake({
        openProgram: async (source: string) => {
          opened.push(source);
          return summary({ language: "V2" });
        },
      });
      const ctx = ctxWith({ clients: () => f.client });
      const result = sc(await debugOpen(ctx, { script } as DebugOpenArgs, undefined));
      expect(result.mode).toBe("program");
      expect(opened).toEqual([SAMPLE_SINGLE]);
      expect(result.notes.join("\n")).toMatch(/script given as/);
      if (label !== "base64") expect(result.notes.join("\n")).toMatch(/plutus_version taken from the script's wrapping: V2/);
    });
  }

  it("plain hex passes through untouched, uppercase and 0x included", async () => {
    const opened: string[] = [];
    const ctx = ctxWith({ clients: () => fake({ openProgram: async (s: string) => (opened.push(s), summary()) }).client });
    await debugOpen(ctx, { script: `0x${SAMPLE_SINGLE.toUpperCase()}`, plutus_version: "V2" } as DebugOpenArgs, undefined);
    expect(opened).toEqual([SAMPLE_SINGLE]);
  });

  it("an unreadable wrapping names the argument and what is accepted", async () => {
    const ctx = ctxWith();
    const result = await debugOpen(ctx, { script: '{"type":"PlutusScriptV2"}' } as DebugOpenArgs, undefined);
    expect(result.isError).toBe(true);
    expect(sc(result)).toMatchObject({ code: "invalid_argument", argument: "script" });
    expect(String(sc(result).message)).toMatch(/UPLC text.*base64.*cardano-cli envelope.*ScriptRef/);
  });

  it("a stated version that disagrees with plutus_version is said, and plutus_version wins", async () => {
    const ctx = ctxWith();
    const result = sc(await debugOpen(ctx, { script: forms[0]![1], plutus_version: "V3" } as DebugOpenArgs, undefined));
    expect(result.notes.join("\n")).toMatch(/plutus_version V3 was given although the script's wrapping states V2; V3 is used/);
  });
});

function txRecord(targets: number): TxRecord {
  const refs = Array.from({ length: targets }, (_, index) => ({ ref: `spend:${index}`, purpose: "spend" as const, index, witness_index: index, target: `input ${"ab".repeat(32)}#${index}`, ex_units: { mem: "1", steps: "1" } }));
  return {
    txId: "tx_mainnet_abababababab",
    txHash: "ab".repeat(32),
    network: "mainnet",
    txHex: "84a0",
    sizeBytes: 2,
    source: "cbor",
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    decoded: { transaction_hash: "ab".repeat(32), transaction: { body: {}, witness_set: {}, is_valid: true, auxiliary_data: null } },
    hashes: { witness_native_script_hashes: [], witness_plutus_scripts: [], witness_datum_hashes: [], output_inline_scripts: [], output_inline_datum_hashes: [], output_datum_hashes: [] },
    redeemerTargets: refs,
    scripts: [],
    extra: {},
    validation: { result: {} as never, redeemers: new Map(refs.map((r) => [r.ref, spend])), at: Date.now(), elapsedMs: 1, phases: "both" },
    validationContext: { protocolParameters: fixture.protocol_parameters } as never,
  } as unknown as TxRecord;
}

describe("debug_open: tx mode", () => {
  it("one redeemer: tx_id alone is enough; the arguments that tx mode ignores are listed", async () => {
    const ctx = ctxWith();
    const record = txRecord(1);
    ctx.txStore.put(record);
    const result = sc(await debugOpen(ctx, { tx_id: record.txId, script: "00", context: "d87980", cost_models: [1, 2] } as DebugOpenArgs, undefined));
    expect(result).toMatchObject({ mode: "tx", tx_id: record.txId, redeemer: "spend:0", cost_model_source: "protocol_params" });
    expect(result.notes.join("\n")).toMatch(/redeemer not given: spend:0 is the only redeemer/);
    expect(result.notes.join("\n")).toMatch(/ignored in tx mode .*: script, context, cost_models/);
  });

  it("several redeemers: the error lists them", async () => {
    const ctx = ctxWith();
    const record = txRecord(3);
    ctx.txStore.put(record);
    const result = await debugOpen(ctx, { tx_id: record.txId } as DebugOpenArgs, undefined);
    expect(result.isError).toBe(true);
    expect(sc(result)).toMatchObject({ code: "invalid_argument", argument: "redeemer", tx_id: record.txId });
    expect(String(sc(result).message)).toMatch(/3 redeemers: spend:0 \(input [0-9a-f]+#0\), spend:1/);
    expect(sc(result).redeemers.map((r: Json) => r.ref)).toEqual(["spend:0", "spend:1", "spend:2"]);
  });

  it("an unknown tx_id is an expired handle for tx_load", async () => {
    const result = await debugOpen(ctxWith(), { tx_id: "tx_mainnet_000000000000" } as DebugOpenArgs, undefined);
    expect(sc(result)).toMatchObject({ code: "expired_handle", recreate_with: "tx_load" });
  });
});

describe("debug_open(reopen=<dbg_id>)", () => {
  it("rebuilds an evicted parts session from its kept inputs, with nothing resent", async () => {
    const configs: unknown[] = [];
    const ctx = ctxWith({ max: 1, clients: () => fake({ openParts: async (config: unknown) => (configs.push(config), summary({ has_script_context: true })) }).client });
    const args = { script: SAMPLE_SINGLE, plutus_version: "V2", context: "d87980", redeemer_data: "d87980", cost_models: Array.from({ length: 175 }, (_, i) => i + 1), protocol_major: 9, ex_units: { steps: 100, mem: 200 } } as DebugOpenArgs;
    const first = sc(await debugOpen(ctx, args, undefined));
    await debugOpen(ctx, { script: TRACE_PROGRAM } as DebugOpenArgs, undefined); // evicts it
    const gone = await debugRun(ctx, { dbg_id: first.dbg_id, until: "done" } as DebugRunArgs, undefined);
    expect(sc(gone)).toMatchObject({ code: "expired_handle", reason: "lru", reopen_with: { reopen: first.dbg_id } });
    const again = sc(await debugOpen(ctx, { reopen: first.dbg_id } as DebugOpenArgs, undefined));
    expect(again).toMatchObject({ mode: "parts", reopened_from: first.dbg_id, protocol_major: 9, protocol_major_source: "supplied", cost_model_source: "supplied", applied: ["redeemer", "context"] });
    expect(again.dbg_id).not.toBe(first.dbg_id);
    expect(configs).toHaveLength(2);
    expect(configs[1]).toEqual(configs[0]);
    expect(again.notes[0]).toMatch(/reopened from dbg_/);
  });

  it("reopens a program session and a tx session (validator result and ids carried over); other arguments are called out as ignored", async () => {
    const ctx = ctxWith({ max: 8 });
    const program = sc(await debugOpen(ctx, { script: TRACE_PROGRAM, plutus_version: "V2" } as DebugOpenArgs, undefined));
    ctx.sessions.close(program.dbg_id);
    const reopened = sc(await debugOpen(ctx, { reopen: program.dbg_id, script: "00" } as DebugOpenArgs, undefined));
    expect(reopened).toMatchObject({ mode: "program", plutus_version: "V3" === reopened.plutus_version ? "V3" : "V2" });
    expect(reopened.notes.join("\n")).toMatch(/ignored with reopen: script/);

    const record = txRecord(1);
    ctx.txStore.put(record);
    const tx = sc(await debugOpen(ctx, { tx_id: record.txId } as DebugOpenArgs, undefined));
    ctx.sessions.close(tx.dbg_id);
    ctx.txStore.evict(record.txId); // even the transaction is gone: the kept config is enough
    const back = sc(await debugOpen(ctx, { reopen: tx.dbg_id } as DebugOpenArgs, undefined));
    expect(back).toMatchObject({ mode: "tx", tx_id: record.txId, redeemer: "spend:0", validator_calculated_ex_units: tx.validator_calculated_ex_units, protocol_major_source: "protocol_params" });
  });

  it("an id the server no longer keeps, and a malformed one, are answered", async () => {
    const ctx = ctxWith();
    const unknown = await debugOpen(ctx, { reopen: "dbg_00000000-0000-0000-0000-000000000000" } as DebugOpenArgs, undefined);
    expect(sc(unknown)).toMatchObject({ code: "expired_handle", recreate_with: "debug_open" });
    expect(String(sc(unknown).note)).toMatch(/pass them again/);
    const bad = await debugOpen(ctx, { reopen: "nope" } as DebugOpenArgs, undefined);
    expect(sc(bad)).toMatchObject({ code: "invalid_argument", argument: "reopen" });
  });
});

describe("debug_run", () => {
  it("keeps the traces of every chunk, not only the last one's", async () => {
    let call = 0;
    const f = fake({
      run: async () => {
        call++;
        return call === 1
          ? report({ stopped: { kind: "limit", detail: "x", reason: "deadline" }, status: "ready", traces: { total: 1, new: ["start"], new_total: 1 } })
          : call === 2
            ? report({ stopped: { kind: "limit", detail: "x", reason: "deadline" }, status: "ready", traces: { total: 2, new: ["middle"], new_total: 1 } })
            : report({ traces: { total: 3, new: ["end"], new_total: 1 } });
      },
    });
    const ctx = ctxWith();
    const record = sessionWith(ctx, f.client);
    const result = sc(await debugRun(ctx, { dbg_id: record.dbgId, until: "done" } as DebugRunArgs, undefined));
    expect(result.chunks).toBe(3);
    expect(result.traces).toEqual({ total: 3, new: ["start", "middle", "end"] });
    expect(record.logsOffset).toBe(3);
  });

  it("caps the shown traces at 10 and counts all of them", async () => {
    let call = 0;
    const lines = (from: number, n: number) => Array.from({ length: n }, (_, i) => `t${from + i}`);
    const f = fake({
      run: async () => {
        call++;
        return call === 1
          ? report({ stopped: { kind: "limit", detail: "x", reason: "deadline" }, status: "ready", traces: { total: 8, new: lines(0, 8), new_total: 8 } })
          : report({ traces: { total: 16, new: lines(8, 8), new_total: 8 } });
      },
    });
    const ctx = ctxWith();
    const record = sessionWith(ctx, f.client);
    const result = sc(await debugRun(ctx, { dbg_id: record.dbgId, until: "done" } as DebugRunArgs, undefined));
    expect(result.traces.new).toEqual(lines(0, 10));
    expect(result.traces).toMatchObject({ total: 16, new_total: 16 });
    expect(String(result.traces.note)).toMatch(/more new traces than shown/);
  });

  it("a call the worker refuses changes nothing: no breakpoints stored, restart travelled inside the spec, reset never called", async () => {
    const specs: RunSpec[] = [];
    const f = fake({
      run: async (spec: RunSpec) => {
        specs.push(spec);
        throw new WorkerCallError({ name: "EngineInputError", message: "term_id 99 is not a node of this script (0..12)", fatal: false, data: { code: "invalid_argument", argument: "term_id" } });
      },
    });
    const ctx = ctxWith();
    const record = sessionWith(ctx, f.client);
    const result = await debugRun(ctx, { dbg_id: record.dbgId, until: "term", term_id: 99, restart: true, breakpoints: { term_ids: [3] }, clear_breakpoints: true } as DebugRunArgs, undefined);
    expect(result.isError).toBe(true);
    expect(sc(result)).toMatchObject({ code: "invalid_argument", argument: "term_id" });
    expect(specs[0]).toMatchObject({ restart: true, breakpoints: { term_ids: [3], uplc_lines: [] } });
    expect(f.calls.map((c) => c.method)).toEqual(["run"]);
    expect(record.breakpoints).toEqual({ termIds: [], uplcLines: [] });
    expect(record.lastStatus).toBe("ready");
    // an accepted call stores them
    const okFake = fake();
    const record2 = sessionWith(ctx, okFake.client, { breakpoints: { termIds: [1], uplcLines: [] } });
    await debugRun(ctx, { dbg_id: record2.dbgId, until: "done", breakpoints: { term_ids: [3], uplc_lines: [] } } as DebugRunArgs, undefined);
    expect(record2.breakpoints).toEqual({ termIds: [1, 3], uplcLines: [] });
  });

  it("restart goes with the first chunk only", async () => {
    const specs: RunSpec[] = [];
    let call = 0;
    const f = fake({
      run: async (spec: RunSpec) => {
        specs.push(spec);
        return ++call === 1 ? report({ stopped: { kind: "limit", detail: "x", reason: "deadline" }, status: "ready" }) : report();
      },
    });
    const ctx = ctxWith();
    const record = sessionWith(ctx, f.client);
    await debugRun(ctx, { dbg_id: record.dbgId, until: "done", restart: true } as DebugRunArgs, undefined);
    expect(specs.map((s) => s.restart)).toEqual([true, false]);
    expect(specs.map((s) => s.skip_first)).toEqual([false, false]);
  });

  it("passes hit and stop_before on, and an error stop records the failing term for the UI hand-off", async () => {
    const specs: RunSpec[] = [];
    const errorAt = { ...position, term_id: 7, kind: "Error", machine_state: "Error" as const };
    const f = fake({
      run: async (spec: RunSpec) => {
        specs.push(spec);
        return report({
          stopped: { kind: "error", detail: "the script fails on the next transition (x)" },
          status: "ready",
          error_message: "the validator crashed",
          error_at: errorAt,
          position: { ...position, term_id: 7, kind: "Error", machine_state: "Compute" },
          at_failure: { env: { total: 1, items: [{ index: 0, name: "x", debruijn: 1, type: "Con:Integer", summary: "1", ref: "env.values.0", binder_term_id: 5, binder_uplc_line: 6 }] } },
        });
      },
    });
    const ctx = ctxWith();
    const record = sessionWith(ctx, f.client);
    const result = sc(await debugRun(ctx, { dbg_id: record.dbgId, until: "error", stop_before: true, hit: 2 } as DebugRunArgs, undefined));
    expect(specs[0]).toMatchObject({ until: "error", stop_before: true, hit: 2 });
    expect(result.error_at).toMatchObject({ term_id: 7, machine_state: "Error" });
    expect(result.failure).toBe("explicit");
    expect(result.env).toEqual({ total: 1, items: [{ index: 0, name: "x", debruijn: 1, type: "Con:Integer", summary: "1", ref: "env.values.0" }] });
    expect(result).not.toHaveProperty("rewind");
    expect(record.errorTermId).toBe(7);
    expect(record.lastStatus).toBe("ready");
  });

  it("errorTermId: set at the failing term, kept through later runs, null when the failure has no term of its own", async () => {
    let next: RunReport = report();
    const f = fake({ run: async () => next });
    const ctx = ctxWith();
    const record = sessionWith(ctx, f.client);
    expect(record.errorTermId).toBeUndefined();
    next = report({ stopped: { kind: "error", detail: "x" }, status: "error", error_message: "divide By Zero", position: { ...position, term_id: null, machine_state: "Error" } });
    const builtin = sc(await debugRun(ctx, { dbg_id: record.dbgId, until: "error" } as DebugRunArgs, undefined));
    expect(builtin.rewind.stop_before).toEqual({ until: "error", stop_before: true, restart: true });
    expect(record.errorTermId).toBeNull();
    expect(record.errorLastTermId).toBe(1); // the last term computed before it failed
    next = report({ stopped: { kind: "error", detail: "x" }, status: "error", error_message: "crashed", position: { ...position, term_id: 4, machine_state: "Error" } });
    await debugRun(ctx, { dbg_id: record.dbgId, until: "error", restart: true } as DebugRunArgs, undefined);
    expect(record.errorTermId).toBe(4);
    next = report({ stopped: { kind: "steps", detail: "1 step executed" }, status: "ready", position: { ...position, term_id: 9 } });
    await debugRun(ctx, { dbg_id: record.dbgId, until: "steps", steps: 1, restart: true } as DebugRunArgs, undefined);
    expect(record.errorTermId).toBe(4); // survives rewinds and later runs
    // a failure without a term does not erase a known one
    next = report({ stopped: { kind: "error", detail: "x" }, status: "error", error_message: "divide By Zero", position: { ...position, term_id: null, machine_state: "Error" } });
    await debugRun(ctx, { dbg_id: record.dbgId, until: "error" } as DebugRunArgs, undefined);
    expect(record.errorTermId).toBe(4);
  });

  it("frames the worker did not read are 'unknown' with its note, not an empty list that looks like an empty stack", async () => {
    const f = fake({ run: async () => report({ stopped: { kind: "limit", detail: "x", reason: "max_steps" }, status: "ready", frames_total: "unknown", frames_note: "frames not read: …" }) });
    const ctx = ctxWith();
    const record = sessionWith(ctx, f.client);
    const result = sc(await debugRun(ctx, { dbg_id: record.dbgId, until: "done" } as DebugRunArgs, undefined));
    expect(result).toMatchObject({ frames: [], frames_total: "unknown", frames_note: "frames not read: …" });
  });

  it("carries no resource links", async () => {
    const ctx = ctxWith();
    const record = sessionWith(ctx, fake().client);
    const result = await debugRun(ctx, { dbg_id: record.dbgId, until: "done" } as DebugRunArgs, undefined);
    expect(result.content.map((c) => c.type)).toEqual(["text"]);
    expect(sc(result)).not.toHaveProperty("resources");
  });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("parallel calls on one session", () => {
  it("a batch of short commands all complete (they queue in the worker, none is refused)", async () => {
    let inFlight = 0;
    let peak = 0;
    const f = fake({
      inspect: async () => {
        peak = Math.max(peak, ++inFlight);
        await wait(30);
        inFlight--;
        return { total: 0, items: [] };
      },
    });
    const ctx = ctxWith();
    const record = sessionWith(ctx, f.client);
    const results = await Promise.all([1, 2, 3, 4].map(() => debugInspect(ctx, { dbg_id: record.dbgId, what: "budget" } as never)));
    expect(results.map((r) => r.isError ?? false)).toEqual([false, false, false, false]);
    expect(peak).toBeGreaterThan(1);
    expect(record.busy).toBe(false);
    expect(record.leases).toBe(0);
  });

  it("while a debug_run runs, others get busy with what runs and for how long; a run waits for short commands", async () => {
    const f = fake({
      run: async () => {
        await wait(150);
        return report();
      },
      inspect: async () => {
        await wait(60);
        return { total: 0, items: [] };
      },
    });
    const ctx = ctxWith();
    const record = sessionWith(ctx, f.client);
    const run = debugRun(ctx, { dbg_id: record.dbgId, until: "done" } as DebugRunArgs, undefined);
    await wait(40);
    const refused = await debugInspect(ctx, { dbg_id: record.dbgId, what: "budget" } as never);
    expect(refused.isError).toBe(true);
    expect(sc(refused)).toMatchObject({ code: "busy", running: "debug_run" });
    expect(sc(refused).since_ms).toBeGreaterThanOrEqual(30);
    expect(String(sc(refused).message)).toMatch(/is running debug_run \(for \d/);
    expect((await run).isError).toBeFalsy();
    // the other way round: a short command in flight, the run waits for it
    const short = debugInspect(ctx, { dbg_id: record.dbgId, what: "budget" } as never);
    const afterShort = debugRun(ctx, { dbg_id: record.dbgId, until: "done" } as DebugRunArgs, undefined);
    const [shortResult, runResult] = await Promise.all([short, afterShort]);
    expect(shortResult.isError).toBeFalsy();
    expect(runResult.isError).toBeFalsy();
  });

  it("the lease is released when the run throws", async () => {
    const f = fake({
      run: async () => {
        throw new Error("boom");
      },
    });
    const ctx = ctxWith();
    const record = sessionWith(ctx, f.client);
    const result = await debugRun(ctx, { dbg_id: record.dbgId, until: "done" } as DebugRunArgs, undefined);
    expect(result.isError).toBe(true);
    expect(record.busy).toBe(false);
    expect(record.running).toBeUndefined();
  });
});

describe("debug_inspect", () => {
  it("what='term' takes term_id as a parameter; position hands the breakpoint term ids to the worker", async () => {
    const f = fake({ inspect: async (_what: string, options: Json) => ({ term_id: options.term_id ?? null, uplc_text: "x" }) });
    const ctx = ctxWith();
    const record = sessionWith(ctx, f.client, { breakpoints: { termIds: [4], uplcLines: [9] } });
    const term = sc(await debugInspect(ctx, { dbg_id: record.dbgId, what: "term", term_id: 5 } as never));
    expect(term.term_id).toBe(5);
    expect(f.calls.find((c) => c.method === "inspect")!.args[1]).toMatchObject({ term_id: 5 });
    await debugInspect(ctx, { dbg_id: record.dbgId, what: "position" } as never);
    expect(f.calls.find((c) => c.method === "position")!.args).toEqual([6, 6, [9], [4]]);
    const noTerm = f.calls.length;
    await debugInspect(ctx, { dbg_id: record.dbgId, what: "frames" } as never);
    expect(f.calls.length).toBe(noTerm + 1);
  });

  it("an unreadable stack in a position report is 'unknown' with the note; replies carry no links", async () => {
    const f = fake({
      position: async () => ({ position, uplc_window: { total_lines: 1, line_from: 1, line_to: 1, dedent: 0, lines: [], text: "1> x" }, frames: [], frames_total: "unknown", frames_note: "frames not read: …", budget: { cpu_spent: "0", mem_spent: "0", over_budget: false }, version: "1", status: "ready", steps_total: 5000 }),
    });
    const ctx = ctxWith();
    const record = sessionWith(ctx, f.client);
    const result = await debugInspect(ctx, { dbg_id: record.dbgId, what: "position" } as never);
    expect(sc(result)).toMatchObject({ frames_total: "unknown", frames_note: "frames not read: …" });
    expect(result.content.map((c) => c.type)).toEqual(["text"]);
  });

  it("a trap while inspecting loses the session with its cause, and the next call says so", async () => {
    const f = fake({
      inspect: async () => {
        throw new WorkerCallError({ name: "RangeError", message: "Maximum call stack size exceeded", fatal: true });
      },
    });
    const ctx = ctxWith();
    const record = sessionWith(ctx, f.client, { totalSteps: 120_000 });
    const first = await debugInspect(ctx, { dbg_id: record.dbgId, what: "frames" } as never);
    expect(sc(first)).toMatchObject({ code: "session_lost", cause: "wasm_trap", last_known: { steps_total: 120_000 } });
    const second = await debugInspect(ctx, { dbg_id: record.dbgId, what: "budget" } as never);
    expect(sc(second)).toMatchObject({ code: "session_lost", cause: "wasm_trap" });
  });
});

describe("debug_profile", () => {
  it("announces profile.json once per session", async () => {
    const ctx = ctxWith();
    const record = sessionWith(ctx, fake().client);
    const first = await debugProfile(ctx, { dbg_id: record.dbgId } as never, undefined);
    expect(sc(first).resources.map((r: Json) => r.uri)).toEqual([`cardano-debug://session/${record.dbgId}/profile.json`]);
    const second = await debugProfile(ctx, { dbg_id: record.dbgId } as never, undefined);
    expect(sc(second)).not.toHaveProperty("resources");
  });

  it("is a long command: a second profile or run while it runs is refused as busy", async () => {
    const f = fake({
      profile: async () => {
        await wait(120);
        return { outcome: "done", totals: { steps: "1", cpu: "1", mem: "1", startup_cpu: "0", startup_mem: "0", over_budget: false }, hot_terms: [], hot_lines: [], builtins: [], step_kinds: [], timeline: [], traces: { total: 0, dropped: 0, items: [] }, terms_executed: 0, report_chars: 1, elapsed_ms: 1 };
      },
    });
    const ctx = ctxWith();
    const record = sessionWith(ctx, f.client);
    const profile = debugProfile(ctx, { dbg_id: record.dbgId } as never, undefined);
    await wait(30);
    const run = await debugRun(ctx, { dbg_id: record.dbgId, until: "done" } as DebugRunArgs, undefined);
    expect(sc(run)).toMatchObject({ code: "busy", running: "debug_profile" });
    expect((await profile).isError).toBeFalsy();
  });
});
