// Provider HTTP policy beyond the basics (http.test.ts): the response body is under the attempt's timeout,
// a rate limit is shared by every request to the host, parallelism per host is bounded, and a wait for a
// cooldown or a free slot ends with the caller's cancellation. Stub servers listen on 127.0.0.1 port 0.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createPolicyFetch, ProviderAbortedError, ProviderHttpError, providerEndpoints, runWithRequestScope, type FetchLike } from "../../../src/chain/http.js";

const KOIOS = "https://api.koios.rest/api/v1/tip";
const quiet = () => undefined;

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function stub(handler: (req: IncomingMessage, res: ServerResponse, n: number) => void): Promise<{ endpoints: ReturnType<typeof providerEndpoints>; count: () => number }> {
  let n = 0;
  const server = createServer((req, res) => handler(req, res, ++n));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { endpoints: providerEndpoints({ CARDANO_DEBUG_KOIOS_URL_MAINNET: `http://127.0.0.1:${port}/api/v1` }), count: () => n };
}

describe("the response body is covered by the attempt timeout", () => {
  it("a provider that stalls after the headers is a timeout (ProviderHttpError naming the budget), not a hang", async () => {
    const { endpoints } = await stub((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("[");
    });
    const policy = createPolicyFetch({ endpoints, policy: { timeoutMs: 150, retries: 0 }, log: quiet });
    const started = Date.now();
    const error = await policy(KOIOS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as ProviderHttpError).message).toContain("request exceeded 150 ms");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("retries a stalled body and serves the next answer", async () => {
    const { endpoints, count } = await stub((_req, res, n) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (n === 1) res.write("[");
      else res.end('[{"ok":true}]');
    });
    const policy = createPolicyFetch({ endpoints, policy: { timeoutMs: 150, retries: 1, baseBackoffMs: 1 }, log: quiet });
    const response = await policy(KOIOS);
    expect(await response.json()).toEqual([{ ok: true }]);
    expect(count()).toBe(2);
  });

  it("keeps status, headers and the error body of a non-retryable answer (a 401 is the caller's to read)", async () => {
    const { endpoints, count } = await stub((_req, res) => {
      res.writeHead(401, { "content-type": "application/json", "x-note": "bad key" });
      res.end('{"error":"unauthorized"}');
    });
    const policy = createPolicyFetch({ endpoints, log: quiet });
    const response = await policy(KOIOS);
    expect(response.status).toBe(401);
    expect(response.headers.get("x-note")).toBe("bad key");
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(count()).toBe(1);
  });

  it("a body that is cancelled by the caller's signal ends the call as cancelled", async () => {
    const { endpoints } = await stub((_req, res) => {
      res.writeHead(200);
      res.write("[");
    });
    const controller = new AbortController();
    const policy = createPolicyFetch({ endpoints, policy: { timeoutMs: 10_000, retries: 2 }, log: quiet });
    setTimeout(() => controller.abort(), 60);
    const started = Date.now();
    await expect(runWithRequestScope({ signal: controller.signal }, () => policy(KOIOS))).rejects.toBeInstanceOf(ProviderAbortedError);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

type Script = Array<() => Response>;
const answer = (code: number, headers: Record<string, string> = {}) => () => new Response("x", { status: code, headers });

function scripted(script: Script): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (input) => {
    calls.push(String(input));
    const next = script.shift();
    if (!next) throw new Error("scripted fetch: out of answers");
    return next();
  };
  return { fetch, calls };
}

describe("a rate limit is shared by every request to the host", () => {
  const endpoints = providerEndpoints({});

  it("a request queued behind a 429 waits the cooldown it did not cause", async () => {
    let clock = 1_000_000;
    const waits: number[] = [];
    const { fetch, calls } = scripted([answer(429, { "retry-after": "2" }), answer(200), answer(200), answer(200)]);
    const policy = createPolicyFetch({
      endpoints,
      fetchImpl: fetch,
      policy: { maxConcurrent: 1, retries: 3, baseBackoffMs: 1 },
      sleep: async (ms) => void (waits.push(ms), (clock += ms)),
      now: () => clock,
      log: quiet,
    });
    const results = await Promise.all([policy(KOIOS), policy(KOIOS + "?a"), policy(KOIOS + "?b")]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(calls).toHaveLength(4); // one 429, then each request once more: no request was sent into the cooldown
    expect(waits).toEqual([2000]); // slept once for all three
  });

  it("a Retry-After beyond the cap fails fast with the status and retryAfterS, and so does the next request", async () => {
    let clock = 5_000_000;
    const { fetch, calls } = scripted([answer(429, { "retry-after": "120" }), answer(200)]);
    const policy = createPolicyFetch({ endpoints, fetchImpl: fetch, sleep: async (ms) => void (clock += ms), now: () => clock, log: quiet });
    const first = await policy(KOIOS).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(ProviderHttpError);
    expect(first).toMatchObject({ status: 429, retryAfterS: 120, attempts: 1 });
    const second = await policy(KOIOS).catch((e: unknown) => e);
    expect(second).toMatchObject({ status: 429, retryAfterS: 120 });
    expect(calls).toHaveLength(1); // nothing was sent while the host asked for silence
    clock += 70_000; // 50 s left: short enough to wait for
    expect((await policy(KOIOS)).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("does not wait minutes in total: the cooldown waits of one call share the cap", async () => {
    let clock = 0;
    const { fetch } = scripted([answer(429, { "retry-after": "40" }), answer(429, { "retry-after": "40" }), answer(200)]);
    const policy = createPolicyFetch({ endpoints, fetchImpl: fetch, sleep: async (ms) => void (clock += ms), now: () => clock, log: quiet });
    const error = await policy(KOIOS).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ProviderHttpError", status: 429 });
    expect(clock).toBeLessThanOrEqual(60_000);
  });

  it("a 429 without Retry-After backs off and advises nothing it does not know", async () => {
    let clock = 0;
    const { fetch, calls } = scripted([answer(429), answer(429), answer(429), answer(429)]);
    const policy = createPolicyFetch({ endpoints, fetchImpl: fetch, policy: { retries: 3, baseBackoffMs: 10, maxBackoffMs: 20 }, sleep: async (ms) => void (clock += ms), now: () => clock, log: quiet });
    const error = (await policy(KOIOS).catch((e: unknown) => e)) as ProviderHttpError;
    expect(calls).toHaveLength(4);
    expect(error).toMatchObject({ status: 429, attempts: 4 });
    expect(error.retryAfterS).toBeUndefined();
  });

  it("records whether credentials were sent", async () => {
    const { fetch } = scripted([answer(500), answer(500)]);
    const policy = createPolicyFetch({ endpoints, fetchImpl: fetch, policy: { retries: 0 }, log: quiet });
    const anonymous = (await policy(KOIOS).catch((e: unknown) => e)) as ProviderHttpError;
    const keyed = (await policy(KOIOS, { headers: { Authorization: "Bearer k" } }).catch((e: unknown) => e)) as ProviderHttpError;
    expect([anonymous.authenticated, keyed.authenticated]).toEqual([false, true]);
  });
});

describe("parallelism and cancellation", () => {
  const endpoints = providerEndpoints({});

  it("keeps at most maxConcurrent requests per host in flight and finishes them all", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl: FetchLike = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight--;
      return new Response("ok", { status: 200 });
    };
    const policy = createPolicyFetch({ endpoints, fetchImpl, policy: { maxConcurrent: 3 }, log: quiet });
    const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => policy(`${KOIOS}?n=${i}`)));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(peak).toBe(3);
  });

  it("another host is not held back by a full one", async () => {
    const release: Array<() => void> = [];
    const fetchImpl: FetchLike = (input) =>
      String(input).includes("preprod")
        ? Promise.resolve(new Response("ok"))
        : new Promise((resolve) => release.push(() => resolve(new Response("ok"))));
    const policy = createPolicyFetch({ endpoints, fetchImpl, policy: { maxConcurrent: 1 }, log: quiet });
    const held = policy(KOIOS);
    const queued = policy(KOIOS + "?q");
    const other = await policy("https://preprod.koios.rest/api/v1/tip");
    expect(other.status).toBe(200);
    release.shift()!();
    await held;
    await new Promise((resolve) => setTimeout(resolve, 10)); // the queued call takes over the slot
    release.shift()!();
    await queued;
  });

  it("a call waiting for a free slot leaves the queue when its signal aborts", async () => {
    let started = 0;
    const fetchImpl: FetchLike = (_input, init) => {
      started++;
      // never answers, but a real fetch rejects when its signal aborts
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    };
    const policy = createPolicyFetch({ endpoints, fetchImpl, policy: { maxConcurrent: 1, timeoutMs: 60_000 }, log: quiet });
    const holder = new AbortController();
    const hold = runWithRequestScope({ signal: holder.signal }, () => policy(KOIOS)).catch((e: unknown) => e);
    const waiter = new AbortController();
    const queued = runWithRequestScope({ signal: waiter.signal }, () => policy(KOIOS + "?q"));
    setTimeout(() => waiter.abort(), 30);
    await expect(queued).rejects.toBeInstanceOf(ProviderAbortedError);
    expect(started).toBe(1); // the queued request never reached the network
    holder.abort();
    expect(await hold).toBeInstanceOf(ProviderAbortedError);
  });

  it("a wait for a cooldown ends when the caller cancels (no 60 s sleep after cancellation)", async () => {
    const { fetch } = scripted([answer(429, { "retry-after": "30" }), answer(200)]);
    const policy = createPolicyFetch({ endpoints, fetchImpl: fetch, log: quiet }); // real timers
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const started = Date.now();
    await expect(runWithRequestScope({ signal: controller.signal }, () => policy(KOIOS))).rejects.toBeInstanceOf(ProviderAbortedError);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
