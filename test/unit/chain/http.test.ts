import { describe, expect, it } from "vitest";

import {
  createPolicyFetch,
  matchProviderUrl,
  ProviderAbortedError,
  ProviderHttpError,
  ProviderOfflineError,
  providerEndpoints,
  runWithRequestScope,
  type FetchLike,
} from "../../../src/chain/http.js";

const KOIOS = "https://api.koios.rest/api/v1/tip";

function fakeFetch(script: Array<() => Response | Error>): { fetch: FetchLike; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    const next = script.shift();
    if (!next) throw new Error("fake fetch: no more responses");
    const answer = next();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetch, calls };
}

const status = (code: number, headers: Record<string, string> = {}) => () => new Response("x", { status: code, headers });
const networkError = () => () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
const noSleep = async () => undefined;
const quiet = () => undefined;

describe("providerEndpoints / matchProviderUrl", () => {
  it("applies env overrides and rewrites default base URLs", () => {
    const endpoints = providerEndpoints({ CARDANO_DEBUG_KOIOS_URL_PREPROD: "http://localhost:8080/api/v1/", CARDANO_DEBUG_BLOCKFROST_URL_MAINNET: "http://bf.local" });
    expect(endpoints.koios.preprod).toBe("http://localhost:8080/api/v1");
    expect(endpoints.koios.mainnet).toBe("https://api.koios.rest/api/v1");
    expect(matchProviderUrl("https://preprod.koios.rest/api/v1/utxo_info", endpoints)).toEqual({ provider: "koios", network: "preprod", url: "http://localhost:8080/api/v1/utxo_info" });
    expect(matchProviderUrl("https://cardano-mainnet.blockfrost.io/api/v0/blocks/latest", endpoints)).toEqual({ provider: "blockfrost", network: "mainnet", url: "http://bf.local/blocks/latest" });
    expect(matchProviderUrl("http://localhost:8080/api/v1/tip", endpoints)?.network).toBe("preprod");
    expect(matchProviderUrl("https://example.com/", endpoints)).toBeUndefined();
  });
});

describe("createPolicyFetch", () => {
  const endpoints = providerEndpoints({});

  it("passes non-provider URLs through untouched", async () => {
    const { fetch, calls } = fakeFetch([status(200)]);
    const policy = createPolicyFetch({ endpoints, fetchImpl: fetch, sleep: noSleep, log: quiet });
    const res = await policy("https://example.com/x");
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe("https://example.com/x");
  });

  it("retries 429 / 5xx / network errors / timeouts with backoff and then succeeds", async () => {
    const waits: number[] = [];
    let clock = 1_000_000; // the fake sleep moves it, like real time
    const { fetch, calls } = fakeFetch([status(429, { "retry-after": "2" }), status(503), networkError(), status(200)]);
    const policy = createPolicyFetch({ endpoints, fetchImpl: fetch, policy: { retries: 3, baseBackoffMs: 10, maxBackoffMs: 50 }, sleep: async (ms) => void (waits.push(ms), (clock += ms)), now: () => clock, log: quiet });
    const res = await policy(KOIOS, { method: "GET" });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(4);
    expect(waits[0]).toBe(2000); // Retry-After 2 s is honoured (up to maxRetryAfterMs), not clipped to the backoff ceiling
    expect(waits.length).toBe(3);
    expect(calls.every((c) => c.init?.signal instanceof AbortSignal)).toBe(true);
  });

  it("gives up after the retries with a ProviderHttpError carrying the status", async () => {
    const { fetch, calls } = fakeFetch([status(500), status(502), status(503), status(504)]);
    const policy = createPolicyFetch({ endpoints, fetchImpl: fetch, policy: { retries: 3, baseBackoffMs: 1 }, sleep: noSleep, log: quiet });
    await expect(policy(KOIOS)).rejects.toMatchObject({ name: "ProviderHttpError", status: 504, attempts: 4, provider: "koios", network: "mainnet" });
    expect(calls).toHaveLength(4);
  });

  it("does not retry 4xx other than 429/408", async () => {
    const { fetch, calls } = fakeFetch([status(404)]);
    const policy = createPolicyFetch({ endpoints, fetchImpl: fetch, sleep: noSleep, log: quiet });
    expect((await policy(KOIOS)).status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("times out one attempt and retries it", async () => {
    let attempt = 0;
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise((resolve, reject) => {
        attempt++;
        if (attempt === 1) init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        else resolve(new Response("ok", { status: 200 }));
      });
    const policy = createPolicyFetch({ endpoints, fetchImpl, policy: { timeoutMs: 20, retries: 1, baseBackoffMs: 1 }, sleep: noSleep, log: quiet });
    const res = await policy(KOIOS);
    expect(res.status).toBe(200);
    expect(attempt).toBe(2);
  });

  it("honours the request-scope AbortSignal", async () => {
    const controller = new AbortController();
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        setTimeout(() => controller.abort(), 5);
      });
    const policy = createPolicyFetch({ endpoints, fetchImpl, sleep: noSleep, log: quiet });
    await expect(runWithRequestScope({ signal: controller.signal }, () => policy(KOIOS))).rejects.toBeInstanceOf(ProviderAbortedError);
    const already = new AbortController();
    already.abort();
    await expect(runWithRequestScope({ signal: already.signal }, () => policy(KOIOS))).rejects.toBeInstanceOf(ProviderAbortedError);
  });

  it("refuses provider requests when offline", async () => {
    const { fetch, calls } = fakeFetch([status(200)]);
    const policy = createPolicyFetch({ endpoints, fetchImpl: fetch, offline: true, sleep: noSleep, log: quiet });
    await expect(policy(KOIOS)).rejects.toBeInstanceOf(ProviderOfflineError);
    expect(calls).toHaveLength(0);
    expect((await policy("https://example.com/")).status).toBe(200);
  });

  it("ProviderHttpError keeps the cause of a network failure", async () => {
    const { fetch } = fakeFetch([networkError(), networkError()]);
    const policy = createPolicyFetch({ endpoints, fetchImpl: fetch, policy: { retries: 1, baseBackoffMs: 1 }, sleep: noSleep, log: quiet });
    const error = await policy(KOIOS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as ProviderHttpError).message).toContain("fetch failed");
  });
});
