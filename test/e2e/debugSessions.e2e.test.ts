// Debugger-core behaviours over stdio against dist/server.js: one-call failure state (stop_before),
// the k-th visit, parallel calls on one session, a failed open that costs no session, reopen, honest
// answers about a lost / evicted handle, and a deep call stack that must not take the session down.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { McpTestClient } from "../mcpClient.js";

type Json = Record<string, any>;

const TRACE_PROGRAM = '(program 1.0.0 [[(force (builtin trace)) (con string "hello")] [(lam x [(builtin addInteger) x (con integer 1)]) (con integer 41)]])';
const EXPLICIT_ERROR = "(program 1.0.0 [(lam fee (force [[[(force (builtin ifThenElse)) [[(builtin lessThanInteger) fee] (con integer 2000000)]] (delay (error))] (delay (con unit ()))])) (con integer 1900000)])";
const BUILTIN_ERROR = "(program 1.0.0 [(lam f [[(builtin addInteger) [f (con integer 5)]] [f (con integer 0)]]) (lam y [[(builtin divideInteger) (con integer 10)] y])])";
const NEXT = "[ [ self self ] [ [ (builtin subtractInteger) n ] (con integer 1) ] ]";
function loop(n: number): string {
  const body = `(lam self (lam n (force [ [ [ (force (builtin ifThenElse)) [ [ (builtin equalsInteger) n ] (con integer 0) ] ] (delay (con unit ())) ] (delay ${NEXT}) ])))`;
  return `(program 1.0.0 [ [ (lam f [ f f ]) ${body} ] (con integer ${n}) ])`;
}
/** Non-tail recursion `1 + f (n - 1)`: about two stack frames per level. */
function deepRecursion(n: number): string {
  const body = `(lam self (lam n (force [ [ [ (force (builtin ifThenElse)) [ [ (builtin equalsInteger) n ] (con integer 0) ] ] (delay (con integer 0)) ] (delay [ [ (builtin addInteger) (con integer 1) ] [ [ self self ] [ [ (builtin subtractInteger) n ] (con integer 1) ] ] ]) ])))`;
  return `(program 1.0.0 [ [ (lam f [ f f ]) ${body} ] (con integer ${n}) ])`;
}

describe("debugger core over stdio", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    client = await McpTestClient.start({ env: { CARDANO_DEBUG_CACHE_DIR: mkdtempSync(path.join(os.tmpdir(), "cdm-debug-sessions-")), CARDANO_DEBUG_OFFLINE: "1", CARDANO_DEBUG_SESSION_MAX: "2" } });
  });

  afterAll(async () => {
    if (client) {
      await client.close();
      expect(client.nonJsonStdout).toEqual([]);
    }
  });

  async function open(script: string, extra: Json = {}): Promise<Json> {
    const opened = await client.callTool<Json>("debug_open", { script, plutus_version: "V2", ...extra });
    expect(opened.isError, JSON.stringify(opened.structuredContent)).toBeFalsy();
    return opened.structuredContent!;
  }

  it("until='error' + stop_before: the state before the failure, with the environment or the value in hand, in one reply", async () => {
    const explicit = await open(EXPLICIT_ERROR);
    const e1 = await client.callTool<Json>("debug_run", { dbg_id: explicit.dbg_id, until: "error", stop_before: true });
    expect(e1.isError).toBeFalsy();
    const a = e1.structuredContent!;
    expect(a.stopped.kind).toBe("error");
    expect(a.status).toBe("ready");
    expect(a.position).toMatchObject({ kind: "Error", machine_state: "Compute" });
    expect(a.error_at).toMatchObject({ machine_state: "Error", term_id: a.position.term_id });
    expect(a.failure).toBe("explicit");
    expect(a.env.items).toEqual([expect.objectContaining({ name: "fee", summary: "1900000" })]);
    expect(a).not.toHaveProperty("rewind");
    // the failing transition is the next one
    const next = await client.callTool<Json>("debug_run", { dbg_id: explicit.dbg_id, until: "steps", steps: 1 });
    expect(next.structuredContent!.stopped.kind).toBe("error");

    const builtin = await open(BUILTIN_ERROR);
    const e2 = await client.callTool<Json>("debug_run", { dbg_id: builtin.dbg_id, until: "error", stop_before: true });
    const b = e2.structuredContent!;
    expect(b.position.machine_state).toBe("Return");
    expect(b.failure).toBe("builtin");
    expect(b.error_message).toMatch(/divide By Zero/);
    expect(b.value).toEqual({ type: "Con:Integer", summary: "0", ref: "state.value" });
    expect(b.frames[0]).toMatchObject({ kind: "FrameAwaitArg", detail: expect.stringMatching(/builtin divideInteger \(1\/2 args/) });

    // the plain error run's `rewind` advertises the one-call form and stays short
    const plain = await client.callTool<Json>("debug_run", { dbg_id: builtin.dbg_id, until: "error", restart: true });
    expect(plain.structuredContent!.rewind.stop_before).toEqual({ until: "error", stop_before: true, restart: true });
    expect(String(plain.structuredContent!.rewind.note).length).toBeLessThan(450);
    await client.callTool<Json>("debug_close", { dbg_id: "all" });
  });

  it("hit=N stops at the N-th visit and an invalid combination moves nothing", async () => {
    const s = await open(loop(5));
    const third = await client.callTool<Json>("debug_run", { dbg_id: s.dbg_id, until: "builtin", builtin: "subtractInteger", hit: 3 });
    expect(third.structuredContent!.stopped).toMatchObject({ kind: "builtin", detail: expect.stringContaining("(visit 3)") });
    const steps = third.structuredContent!.steps_total;
    const bad = await client.callTool<Json>("debug_run", { dbg_id: s.dbg_id, until: "term", term_id: 9999, restart: true });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toMatchObject({ code: "invalid_argument", argument: "term_id" });
    const still = await client.callTool<Json>("debug_inspect", { dbg_id: s.dbg_id, what: "budget" });
    expect(still.structuredContent!.steps_total).toBe(steps);
    const badHit = await client.callTool<Json>("debug_run", { dbg_id: s.dbg_id, until: "done", hit: 2 });
    expect(badHit.structuredContent).toMatchObject({ code: "invalid_argument", argument: "hit" });
    await client.callTool<Json>("debug_close", { dbg_id: "all" });
  });

  it("parallel calls on one session all complete", async () => {
    const s = await open(TRACE_PROGRAM);
    await client.callTool<Json>("debug_run", { dbg_id: s.dbg_id, until: "builtin", builtin: "addInteger" });
    const results = await Promise.all([
      client.callTool<Json>("debug_inspect", { dbg_id: s.dbg_id, what: "frames" }),
      client.callTool<Json>("debug_inspect", { dbg_id: s.dbg_id, what: "budget" }),
      client.callTool<Json>("debug_source", { dbg_id: s.dbg_id, radius: 2 }),
      client.callTool<Json>("script_locate", { dbg_id: s.dbg_id, term_id: 4 }),
    ]);
    expect(results.map((r) => r.isError ?? false), JSON.stringify(results.map((r) => r.structuredContent?.code))).toEqual([false, false, false, false]);
    // none of these replies lists resources again
    for (const r of results) expect(r.structuredContent).not.toHaveProperty("resources");
    await client.callTool<Json>("debug_close", { dbg_id: "all" });
  });

  it("a failed debug_open costs no session; an evicted handle says why and reopen=<dbg_id> rebuilds it", async () => {
    const a = await open(TRACE_PROGRAM);
    const b = await open(loop(3));
    const failed = await client.callTool<Json>("debug_open", { script: "00", plutus_version: "V2" });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent!.code).toBe("invalid_argument");
    // both sessions survived the failed open
    for (const id of [a.dbg_id, b.dbg_id]) {
      const alive = await client.callTool<Json>("debug_inspect", { dbg_id: id, what: "budget" });
      expect(alive.isError, id).toBeFalsy();
    }
    // a successful third open evicts the least recently used one (a: b was touched last), and names it
    const c = await client.callTool<Json>("debug_open", { script: EXPLICIT_ERROR, plutus_version: "V2" });
    expect(c.structuredContent!.evicted).toMatchObject({ dbg_id: a.dbg_id, reason: "lru" });
    const gone = await client.callTool<Json>("debug_run", { dbg_id: a.dbg_id, until: "done" });
    expect(gone.structuredContent).toMatchObject({ code: "expired_handle", recreate_with: "debug_open", reason: "lru", reopen_with: { reopen: a.dbg_id } });
    expect(String(gone.structuredContent!.message)).toMatch(/evicted at .* to make room for a newer session/);
    const again = await client.callTool<Json>("debug_open", { reopen: a.dbg_id });
    expect(again.isError, JSON.stringify(again.structuredContent)).toBeFalsy();
    expect(again.structuredContent).toMatchObject({ mode: "program", reopened_from: a.dbg_id });
    const run = await client.callTool<Json>("debug_run", { dbg_id: again.structuredContent!.dbg_id, until: "done" });
    expect(run.structuredContent!.traces.total).toBe(1);
    await client.callTool<Json>("debug_close", { dbg_id: "all" });
  });

  it("a busy answer names the running command", async () => {
    const s = await open("(program 1.0.0 [(lam f [f f]) (lam f [f f])])");
    const run = client.callTool<Json>("debug_run", { dbg_id: s.dbg_id, until: "done", timeout_ms: 3_000, max_steps: 50_000_000 }, 20_000);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const busy = await client.callTool<Json>("debug_inspect", { dbg_id: s.dbg_id, what: "budget" });
    expect(busy.structuredContent).toMatchObject({ code: "busy", running: "debug_run" });
    expect(busy.structuredContent!.since_ms).toBeGreaterThan(100);
    await run;
    await client.callTool<Json>("debug_close", { dbg_id: s.dbg_id });
  });

  it("traces emitted in an early chunk are reported by the run that spans several chunks", async () => {
    // ~4.3M transitions in two or more 2 s chunks: "start" is emitted in the first one, "end" in the last.
    const body = '(lam self (lam n (force [ [ [ (force (builtin ifThenElse)) [ [ (builtin equalsInteger) n ] (con integer 0) ] ] (delay [ [ (force (builtin trace)) (con string "end") ] (con unit ()) ]) ] (delay [ [ self self ] [ [ (builtin subtractInteger) n ] (con integer 1) ] ]) ])))';
    const program = `(program 1.0.0 [ (lam _ [ [ (lam f [ f f ]) ${body} ] (con integer 100000) ]) [ [ (force (builtin trace)) (con string "start") ] (con unit ()) ] ])`;
    const s = await open(program);
    const run = await client.callTool<Json>("debug_run", { dbg_id: s.dbg_id, until: "done", timeout_ms: 60_000, max_steps: 50_000_000 }, 90_000);
    expect(run.isError, JSON.stringify(run.structuredContent)).toBeFalsy();
    expect(run.structuredContent!.chunks).toBeGreaterThanOrEqual(2);
    expect(run.structuredContent!.traces).toMatchObject({ total: 2, new: ["start", "end"] });
    await client.callTool<Json>("debug_close", { dbg_id: s.dbg_id });
  }, 120_000);

  it("a deep non-tail recursion does not cost the session: a cut run reports frames as unknown, and the session answers afterwards", async () => {
    const s = await open(deepRecursion(8_000));
    const cut = await client.callTool<Json>("debug_run", { dbg_id: s.dbg_id, until: "done", max_steps: 100_000 }, 60_000);
    expect(cut.isError, JSON.stringify(cut.structuredContent)).toBeFalsy();
    expect(cut.structuredContent!.stopped).toMatchObject({ kind: "limit" });
    expect(cut.structuredContent!.frames_total).toBe("unknown");
    expect(cut.structuredContent!.frames_note).toMatch(/debug_inspect\(what='frames'\)/);
    const budget = await client.callTool<Json>("debug_inspect", { dbg_id: s.dbg_id, what: "budget" });
    expect(budget.isError).toBeFalsy();
    const done = await client.callTool<Json>("debug_run", { dbg_id: s.dbg_id, until: "done" }, 60_000);
    expect(done.structuredContent!.status).toBe("done");
    await client.callTool<Json>("debug_close", { dbg_id: s.dbg_id });
  }, 120_000);
});
