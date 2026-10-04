// Provider HTTP policy. The core clients (KoiosClient / BlockfrostClient) call the global `fetch`
// with no injection point, so the policy is applied as a fetch wrapper that recognises provider
// URLs and leaves every other request untouched:
//
//   - endpoint override only from the environment (`CARDANO_DEBUG_KOIOS_URL_<NET>`,
//     `CARDANO_DEBUG_BLOCKFROST_URL_<NET>`), never from tool arguments;
//   - 30 s per request, response body included (a provider that stalls after the headers is a
//     timeout, not a hang), 3 retries with exponential backoff on 429 / 5xx / timeouts / network errors;
//   - rate limits are shared per provider host: a 429 (or a `Retry-After`) opens a cooldown that every
//     request to that host waits out (up to 60 s; a longer `Retry-After` fails fast with the status and
//     `retryAfterS`), and at most 4 requests to one host are in flight (the core fans a UTxO lookup out
//     in parallel chunks);
//   - cancellation from the tool call's AbortSignal, carried by AsyncLocalStorage so the core code
//     in between needs no plumbing (it also ends a wait for a cooldown or a free slot);
//   - `CARDANO_DEBUG_OFFLINE=1` refuses provider requests instead of reaching the network.

import { AsyncLocalStorage } from "node:async_hooks";

import { KOIOS_BASE_URLS } from "@cardananium/cquisitor-lib/chain/koiosTypes";

import { NETWORKS, type Network } from "../config.js";

export type ProviderName = "koios" | "blockfrost";

/** Default Blockfrost bases (the core keeps its table private; these mirror it). */
export const BLOCKFROST_DEFAULT_BASE_URLS: Record<Network, string> = {
  mainnet: "https://cardano-mainnet.blockfrost.io/api/v0",
  preprod: "https://cardano-preprod.blockfrost.io/api/v0",
  preview: "https://cardano-preview.blockfrost.io/api/v0",
};

export const KOIOS_DEFAULT_BASE_URLS: Record<Network, string> = {
  mainnet: KOIOS_BASE_URLS.mainnet,
  preprod: KOIOS_BASE_URLS.preprod,
  preview: KOIOS_BASE_URLS.preview,
};

export interface ProviderEndpoints {
  koios: Record<Network, string>;
  blockfrost: Record<Network, string>;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Effective base URLs: env overrides (`CARDANO_DEBUG_KOIOS_URL_MAINNET`, …) over the defaults. */
export function providerEndpoints(env: NodeJS.ProcessEnv = process.env): ProviderEndpoints {
  const koios = { ...KOIOS_DEFAULT_BASE_URLS };
  const blockfrost = { ...BLOCKFROST_DEFAULT_BASE_URLS };
  for (const network of NETWORKS) {
    const upper = network.toUpperCase();
    const k = env[`CARDANO_DEBUG_KOIOS_URL_${upper}`]?.trim();
    if (k) koios[network] = trimSlash(k);
    const b = env[`CARDANO_DEBUG_BLOCKFROST_URL_${upper}`]?.trim();
    if (b) blockfrost[network] = trimSlash(b);
  }
  return { koios, blockfrost };
}

export interface FetchPolicy {
  /** Per-attempt budget. Default 30 s. */
  timeoutMs: number;
  /** Retries after the first attempt. Default 3. */
  retries: number;
  /** First backoff; doubles per attempt. Default 500 ms. */
  baseBackoffMs: number;
  /** Backoff ceiling for the exponential backoff. Default 10 s. */
  maxBackoffMs: number;
  /** Longest `Retry-After` / cooldown that is waited out; a longer one fails fast with status 429. Default 60 s. */
  maxRetryAfterMs: number;
  /** Requests in flight per provider host. Default 4. */
  maxConcurrent: number;
}

export const DEFAULT_FETCH_POLICY: FetchPolicy = { timeoutMs: 30_000, retries: 3, baseBackoffMs: 500, maxBackoffMs: 10_000, maxRetryAfterMs: 60_000, maxConcurrent: 4 };

export class ProviderHttpError extends Error {
  readonly provider: ProviderName;
  readonly network: Network;
  readonly url: string;
  readonly status: number | undefined;
  readonly attempts: number;
  /** Seconds the provider asked to wait (a 429 / 503 `Retry-After`), when it did. */
  readonly retryAfterS: number | undefined;
  /** Whether the request carried credentials (Koios `Authorization`, Blockfrost `project_id`); undefined when unknown. */
  readonly authenticated: boolean | undefined;
  constructor(
    message: string,
    info: { provider: ProviderName; network: Network; url: string; status?: number; attempts: number; retryAfterS?: number; authenticated?: boolean; cause?: unknown },
  ) {
    super(message, info.cause !== undefined ? { cause: info.cause } : undefined);
    this.name = "ProviderHttpError";
    this.provider = info.provider;
    this.network = info.network;
    this.url = info.url;
    this.status = info.status;
    this.attempts = info.attempts;
    this.retryAfterS = info.retryAfterS;
    this.authenticated = info.authenticated;
  }
}

export class ProviderOfflineError extends Error {
  constructor(url: string, message?: string) {
    super(message ?? `CARDANO_DEBUG_OFFLINE=1: refusing network request to ${redact(url)}. Load the transaction from a bundle or unset the offline switch.`);
    this.name = "ProviderOfflineError";
  }
}

/** Offline mode and nothing in the cache to answer from (reported like any offline refusal: code `offline`). */
export class OfflineContextError extends ProviderOfflineError {
  constructor(message: string) {
    super("", message);
    this.name = "OfflineContextError";
  }
}

export class ProviderAbortedError extends Error {
  constructor(url: string) {
    super(`Provider request cancelled by the caller (${redact(url)})`);
    this.name = "ProviderAbortedError";
  }
}

/** A URL without query string (Koios filters can be long; keys never travel in URLs anyway). */
function redact(url: string): string {
  const q = url.indexOf("?");
  return q >= 0 ? url.slice(0, q) + "?…" : url;
}

// ---------- request scope (AbortSignal from the tool call) ----------

export interface RequestScope {
  signal?: AbortSignal;
  /** Free-form label for log lines (tool name + tx id). */
  label?: string;
}

const scopeStorage = new AsyncLocalStorage<RequestScope>();

/** Run `fn` with `scope` visible to every provider request it (transitively) makes. */
export function runWithRequestScope<T>(scope: RequestScope, fn: () => Promise<T>): Promise<T> {
  return scopeStorage.run(scope, fn);
}

export function currentRequestScope(): RequestScope | undefined {
  return scopeStorage.getStore();
}

// ---------- URL matching ----------

export interface ProviderMatch {
  provider: ProviderName;
  network: Network;
  /** The URL with the default base replaced by the configured endpoint. */
  url: string;
}

/** Recognise a provider URL by its default base and rewrite it to the configured endpoint. */
export function matchProviderUrl(url: string, endpoints: ProviderEndpoints): ProviderMatch | undefined {
  for (const network of NETWORKS) {
    const koiosDefault = KOIOS_DEFAULT_BASE_URLS[network];
    if (url.startsWith(koiosDefault)) return { provider: "koios", network, url: endpoints.koios[network] + url.slice(koiosDefault.length) };
    const bfDefault = BLOCKFROST_DEFAULT_BASE_URLS[network];
    if (url.startsWith(bfDefault)) return { provider: "blockfrost", network, url: endpoints.blockfrost[network] + url.slice(bfDefault.length) };
    // Already-rewritten URLs (a client constructed with an override base) match too.
    if (endpoints.koios[network] !== koiosDefault && url.startsWith(endpoints.koios[network])) return { provider: "koios", network, url };
    if (endpoints.blockfrost[network] !== bfDefault && url.startsWith(endpoints.blockfrost[network])) return { provider: "blockfrost", network, url };
  }
  return undefined;
}

// ---------- the policy fetch ----------

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PolicyFetchOptions {
  endpoints: ProviderEndpoints;
  policy?: Partial<FetchPolicy>;
  offline?: boolean;
  /** Underlying fetch (tests inject a fake). Default: the global fetch captured at creation. */
  fetchImpl?: FetchLike;
  /** Wait `ms`, ending early when `signal` aborts. Default: a timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Clock for cooldowns (ms epoch). Default Date.now. */
  now?: () => number;
  log?: (line: string) => void;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/** The `Retry-After` header in ms (seconds or an HTTP date); undefined when absent or unreadable. */
function retryAfterMs(response: Response, now: number): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number.parseFloat(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

class AttemptTimeout extends Error {
  constructor(ms: number) {
    super(`request exceeded ${ms} ms`);
    this.name = "AttemptTimeout";
  }
}

function hasCredentials(init: RequestInit | undefined): boolean | undefined {
  if (!init?.headers) return false;
  try {
    const headers = new Headers(init.headers);
    return headers.has("authorization") || headers.has("project_id");
  } catch {
    return undefined;
  }
}

/** Read the whole body while the attempt's timer and abort listener are still armed. */
async function bufferResponse(response: Response): Promise<Response> {
  if (response.body === null || response.status < 200 || response.status === 204 || response.status === 205 || response.status === 304) return response;
  const bytes = await response.arrayBuffer();
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Counting semaphore per key; a waiter leaves the queue when its signal aborts. */
class HostLimiter {
  private readonly hosts = new Map<string, { active: number; waiters: Array<() => void> }>();

  async acquire(key: string, max: number, signal: AbortSignal | undefined, onAbort: () => Error): Promise<() => void> {
    let host = this.hosts.get(key);
    if (!host) {
      host = { active: 0, waiters: [] };
      this.hosts.set(key, host);
    }
    const state = host;
    const release = (): void => {
      const next = state.waiters.shift();
      if (next) next();
      else state.active--;
    };
    if (state.active < max) {
      state.active++;
      return release;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = (): void => {
        signal?.removeEventListener("abort", aborted);
        resolve();
      };
      const aborted = (): void => {
        const at = state.waiters.indexOf(waiter);
        if (at >= 0) state.waiters.splice(at, 1);
        reject(onAbort());
      };
      if (signal?.aborted) return aborted();
      state.waiters.push(waiter);
      signal?.addEventListener("abort", aborted, { once: true });
    });
    return release; // the slot was handed over by the releasing request (active unchanged)
  }
}

/**
 * Build a fetch that applies the provider policy to provider URLs and passes everything else
 * through to `fetchImpl` unchanged.
 */
export function createPolicyFetch(options: PolicyFetchOptions): FetchLike {
  const base = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const policy: FetchPolicy = { ...DEFAULT_FETCH_POLICY, ...options.policy };
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.error(`[cardano-debug] chain: ${line}`));
  /** Per host: the time before which no request is sent (a 429 / Retry-After is shared by every caller). */
  const cooldowns = new Map<string, number>();
  const limiter = new HostLimiter();

  return async function policyFetch(input, init) {
    const original = urlOf(input);
    const match = matchProviderUrl(original, options.endpoints);
    if (!match) return base(input, init);
    if (options.offline) throw new ProviderOfflineError(match.url);

    const scope = currentRequestScope();
    const outer = scope?.signal;
    const url = match.url;
    const host = new URL(url).origin;
    const attempts = policy.retries + 1;
    const authenticated = hasCredentials(init);
    let lastError: unknown;
    let lastStatus: number | undefined;
    /** The last `Retry-After` the provider itself sent (a computed backoff is not advice to the caller). */
    let providerAsked: number | undefined;
    /** Time spent waiting out cooldowns by this call: capped like one `Retry-After`, so a call never sleeps for minutes. */
    let cooledMs = 0;

    const httpError = (message: string, attempt: number, status: number | undefined, retryAfter: number | undefined, cause?: unknown): ProviderHttpError =>
      new ProviderHttpError(message, {
        provider: match.provider,
        network: match.network,
        url,
        ...(status !== undefined ? { status } : {}),
        attempts: attempt,
        ...(retryAfter !== undefined ? { retryAfterS: Math.max(1, Math.ceil(retryAfter / 1000)) } : {}),
        ...(authenticated !== undefined ? { authenticated } : {}),
        cause,
      });
    const rateLimited = (waitMs: number, attempt: number): ProviderHttpError =>
      httpError(`${match.provider} (${match.network}) is rate limiting this server: it asks for ${Math.ceil(waitMs / 1000)} s of silence (HTTP 429) — ${redact(url)}`, attempt, 429, waitMs);
    const wait = async (ms: number): Promise<void> => {
      await sleep(ms, outer);
      if (outer?.aborted) throw new ProviderAbortedError(url);
    };

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (outer?.aborted) throw new ProviderAbortedError(url);
      const release = await limiter.acquire(host, policy.maxConcurrent, outer, () => new ProviderAbortedError(url));
      let pause = 0;
      try {
        // A cooldown opened by any request to this host (also one that ran while this call queued for its slot):
        // wait it out, or fail fast when it is too long.
        const remaining = (cooldowns.get(host) ?? 0) - now();
        if (remaining > policy.maxRetryAfterMs || (remaining > 0 && cooledMs + remaining > policy.maxRetryAfterMs)) throw rateLimited(remaining, attempt);
        if (remaining > 0) {
          cooledMs += remaining;
          log(`${match.provider}/${match.network} cooling down: waiting ${Math.ceil(remaining)} ms before ${redact(url)}`);
          await wait(remaining);
        }
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort(new AttemptTimeout(policy.timeoutMs));
        }, policy.timeoutMs);
        const onOuterAbort = () => controller.abort(outer?.reason);
        outer?.addEventListener("abort", onOuterAbort, { once: true });
        try {
          const response = await base(url, { ...init, signal: controller.signal });
          if (!isRetryableStatus(response.status)) return await bufferResponse(response);
          lastStatus = response.status;
          const asked = retryAfterMs(response, now());
          await response.body?.cancel().catch(() => undefined);
          if (response.status === 429 || asked !== undefined) {
            // One request learned the host's limit: everyone waits for it instead of retrying on their own.
            const cooldown = asked ?? backoff(policy, attempt);
            if (asked !== undefined) providerAsked = asked;
            cooldowns.set(host, Math.max(cooldowns.get(host) ?? 0, now() + cooldown));
            if (cooldown > policy.maxRetryAfterMs) throw rateLimited(cooldown, attempt + 1);
            if (attempt === attempts - 1) break;
            log(`${match.provider}/${match.network} ${response.status} on ${redact(url)}; retry ${attempt + 1}/${policy.retries} after ${Math.ceil(cooldown)} ms`);
          } else {
            if (attempt === attempts - 1) break;
            pause = backoff(policy, attempt);
            log(`${match.provider}/${match.network} ${response.status} on ${redact(url)}; retry ${attempt + 1}/${policy.retries} in ${pause} ms`);
          }
        } catch (error) {
          if (error instanceof ProviderHttpError) throw error;
          if (outer?.aborted) throw new ProviderAbortedError(url);
          lastError = error;
          const retryable = timedOut || isNetworkError(error);
          if (!retryable || attempt === attempts - 1) break;
          pause = backoff(policy, attempt);
          log(`${match.provider}/${match.network} ${timedOut ? "timeout" : "network error"} on ${redact(url)}; retry ${attempt + 1}/${policy.retries} in ${pause} ms`);
        } finally {
          clearTimeout(timer);
          outer?.removeEventListener("abort", onOuterAbort);
        }
      } finally {
        release();
      }
      if (pause > 0) await wait(pause);
    }
    const detail = lastStatus !== undefined ? `HTTP ${lastStatus}` : lastError instanceof Error ? lastError.message : String(lastError);
    throw httpError(`${match.provider} (${match.network}) request failed after ${attempts} attempts: ${detail} — ${redact(url)}`, attempts, lastStatus, providerAsked, lastError);
  };
}

function backoff(policy: FetchPolicy, attempt: number): number {
  const exp = policy.baseBackoffMs * 2 ** attempt;
  const jitter = Math.floor(Math.random() * Math.min(100, policy.baseBackoffMs));
  return Math.min(policy.maxBackoffMs, exp + jitter);
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof AttemptTimeout) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true; // our own timeout abort surfaced as AbortError
  if (error.name === "TypeError" && /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(error.message)) return true;
  const code = (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof code === "string" && /^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR)/.test(code);
}

// ---------- installation ----------

let installed: { restore: () => void } | null = null;

/**
 * Wrap the process-wide `fetch` once. Idempotent; returns the uninstaller. Only provider URLs are
 * affected (see `matchProviderUrl`).
 */
export function installProviderFetch(options: PolicyFetchOptions): () => void {
  if (installed) return installed.restore;
  const previous = globalThis.fetch;
  const wrapped = createPolicyFetch({ ...options, fetchImpl: options.fetchImpl ?? previous.bind(globalThis) });
  globalThis.fetch = wrapped as typeof fetch;
  installed = {
    restore: () => {
      if (globalThis.fetch === (wrapped as typeof fetch)) globalThis.fetch = previous;
      installed = null;
    },
  };
  return installed.restore;
}
