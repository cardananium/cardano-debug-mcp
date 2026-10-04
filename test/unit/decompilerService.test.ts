// DecompilerService in-flight sharing and the session source rules of script_decompile. The worker
// host is stubbed (no wasm): what is tested is how many `decompile` calls reach it and what each
// caller is told.
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/config.js";
import type { AppContext } from "../../src/context.js";
import { resolveScript } from "../../src/decompiler/resolve.js";
import { DecompilerService, type DecompileOutcome } from "../../src/decompiler/service.js";
import type { BuiltOptions } from "../../src/decompiler/options.js";
import { SessionRegistry } from "../../src/store/sessionRegistry.js";
import { WorkerAbortedError, WorkerTimeoutError } from "../../src/workers/rpc.js";

function builtOptions(hash: string, layer = "Decompiled"): BuiltOptions {
  return { hash, layer, json: `{"h":"${hash}"}`, versionToken: null, purposeToken: null, bag: {}, echo: {} } as unknown as BuiltOptions;
}

interface Pending {
  args: unknown[];
  signal: AbortSignal | undefined;
  resolve: (value: { text: string; elapsed_ms: number }) => void;
  reject: (error: unknown) => void;
}

/** A service whose host.call is a list of pending calls the test settles by hand. */
function stubbedService(options: Record<string, BuiltOptions> = {}) {
  const service = new DecompilerService(loadConfig({}));
  const pending: Pending[] = [];
  const calls = vi.spyOn(service.host, "call").mockImplementation(((method: string, args: unknown[], callOptions?: { signal?: AbortSignal }) => {
    expect(method).toBe("decompile");
    return new Promise((resolve, reject) => {
      pending.push({ args, signal: callOptions?.signal, resolve: resolve as Pending["resolve"], reject });
      callOptions?.signal?.addEventListener("abort", () => reject(new WorkerAbortedError()), { once: true });
    });
  }) as unknown as typeof service.host.call);
  // The option catalogue needs the real worker; the key is all the service looks at.
  vi.spyOn(service, "buildOptions").mockImplementation(async (request) => options[(request.user as { tag?: string } | undefined)?.tag ?? "default"] ?? builtOptions("o1"));
  return { service, pending, calls };
}

const request = (extra: Record<string, unknown> = {}) => ({ scriptHex: "4501010033aa", scriptHash: "ab".repeat(28), view: "pseudocode" as const, ...extra });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const services: DecompilerService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.dispose()));
});

describe("DecompilerService: identical parallel requests share one run", () => {
  it("runs dehosk once for two parallel requests; the joiner is told cached, later calls hit the cache", async () => {
    const { service, pending, calls } = stubbedService();
    services.push(service);
    const first = service.decompile(request());
    const second = service.decompile(request());
    await tick();
    expect(pending).toHaveLength(1);
    pending[0]!.resolve({ text: "// Info: x\nvalidator {\n}\n", elapsed_ms: 1_500 });
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(a.ok && a.cached).toBe(false);
    expect(b.ok && b.cached).toBe(true);
    expect(a.ok && b.ok && a.entry.key === b.entry.key).toBe(true);
    const third = await service.decompile(request());
    expect(third.ok && third.cached).toBe(true);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("a timeout is burned once: parallel callers share the failure, later ones see the marker, refresh retries", async () => {
    const { service, pending, calls } = stubbedService();
    services.push(service);
    const first = service.decompile(request());
    const second = service.decompile(request());
    await tick();
    expect(pending).toHaveLength(1);
    pending[0]!.reject(new WorkerTimeoutError("The decompile call exceeded 120000 ms.", 120_000));
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toHaveBeenCalledTimes(1);
    for (const outcome of [a, b] as DecompileOutcome[]) {
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.code).toBe("decompile_failed");
    }
    expect(!a.ok && a.code === "decompile_failed" && !b.ok && b.code === "decompile_failed" && a.marker === b.marker).toBe(true);
    const later = await service.decompile(request());
    expect(!later.ok && later.code).toBe("decompile_failed");
    expect(calls).toHaveBeenCalledTimes(1);
    const retry = service.decompile(request({ refresh: true }));
    await tick();
    expect(calls).toHaveBeenCalledTimes(2);
    pending[1]!.resolve({ text: "validator {\n}\n", elapsed_ms: 5 });
    const done = await retry;
    expect(done.ok && done.cached).toBe(false);
  });

  it("different options or scripts are separate runs", async () => {
    const { service, pending, calls } = stubbedService({ default: builtOptions("o1"), other: builtOptions("o2") });
    services.push(service);
    const runs = [
      service.decompile(request()),
      service.decompile(request({ user: { tag: "other" } })),
      service.decompile(request({ scriptHash: "cd".repeat(28) })),
    ];
    await tick();
    expect(calls).toHaveBeenCalledTimes(3);
    for (const p of pending) p.resolve({ text: "x", elapsed_ms: 1 });
    expect((await Promise.all(runs)).every((o) => o.ok && !o.cached)).toBe(true);
  });

  it("one caller cancelling does not cancel the shared run; the last one leaving does", async () => {
    const { service, pending, calls } = stubbedService();
    services.push(service);
    const abortA = new AbortController();
    const a = service.decompile(request({ signal: abortA.signal }));
    const b = service.decompile(request());
    await tick();
    abortA.abort();
    await expect(a).rejects.toBeInstanceOf(WorkerAbortedError);
    expect(pending[0]!.signal?.aborted).toBe(false);
    pending[0]!.resolve({ text: "validator {\n}\n", elapsed_ms: 2 });
    const done = await b;
    expect(done.ok && done.cached).toBe(true); // b waited on the run a started

    // A lone caller that cancels aborts the worker call, and the next request starts a fresh run.
    const abortC = new AbortController();
    const c = service.decompile(request({ scriptHash: "ee".repeat(28), signal: abortC.signal }));
    await tick();
    abortC.abort();
    await expect(c).rejects.toBeInstanceOf(WorkerAbortedError);
    expect(pending[1]!.signal?.aborted).toBe(true);
    const d = service.decompile(request({ scriptHash: "ee".repeat(28) }));
    await tick();
    expect(calls).toHaveBeenCalledTimes(3);
    pending[2]!.resolve({ text: "ok", elapsed_ms: 1 });
    expect((await d).ok).toBe(true);
  });

  it("an already aborted signal never leaves a run behind", async () => {
    const { service, calls } = stubbedService();
    services.push(service);
    const abort = new AbortController();
    abort.abort();
    await expect(service.decompile(request({ signal: abort.signal }))).rejects.toBeInstanceOf(WorkerAbortedError);
    await tick();
    expect(calls).not.toHaveBeenCalled();
  });
});

describe("resolveScript(dbg_id): sessions opened from UPLC text", () => {
  const registry = new SessionRegistry({ sweepIntervalMs: 60_000 });
  const ctx = { sessions: registry } as unknown as AppContext;
  afterEach(() => registry.closeAll("shutdown"));

  async function noBytes(init: Parameters<SessionRegistry["create"]>[0]) {
    const { record } = registry.create(init);
    const found = await resolveScript(ctx, { dbg_id: record.dbgId });
    expect(found.ok).toBe(false);
    return { dbgId: record.dbgId, body: found.ok ? {} : (found.result.structuredContent as Record<string, unknown>) };
  }

  it("a parts session (debug_open(script='(program …', context=…)) answers no_script_bytes, not a hex error", async () => {
    const { dbgId, body } = await noBytes({ mode: "parts", language: "V3", partsConfig: { script: "(program 1.1.0 (lam ctx (con integer 1)))", language: "v3", context: "d87980" } });
    expect(body).toMatchObject({ code: "no_script_bytes", mode: "parts", dbg_id: dbgId, argument: "script" });
    expect(body.message).toMatch(/UPLC source text/);
    expect(body.message).toMatch(/Pass the compiled script/);
    expect(body.next).toEqual(expect.arrayContaining([expect.stringContaining("script_decompile(script=")]));
  });

  it("a program session from text keeps answering no_script_bytes; a configuration with no script says so", async () => {
    const program = await noBytes({ mode: "program", language: "V3", partsConfig: { program: "(program 1.1.0 (con integer 1))", language: "v3" } });
    expect(program.body).toMatchObject({ code: "no_script_bytes", mode: "program" });
    expect(program.body.message).toMatch(/UPLC source text/);
    const bare = await noBytes({ mode: "parts", language: "V3", partsConfig: { language: "v3" } });
    expect(bare.body.message).toMatch(/without compiled script bytes/);
  });

  it("leading whitespace before the parenthesis still counts as text", async () => {
    const { body } = await noBytes({ mode: "parts", language: "V2", partsConfig: { script: "\n  (program 1.0.0 (con unit ()))", language: "v2" } });
    expect(body.code).toBe("no_script_bytes");
  });
});
