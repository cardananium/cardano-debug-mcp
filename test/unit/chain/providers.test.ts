// Provider selection, the error taxonomy of provider answers, and provider-keyed rows (a Blockfrost row is
// never served to a Koios load): selectProvider, createCoreClient, CachingClient, ChainService.fetchTxCbor.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BlockchainDataClient } from "@cardananium/cquisitor-lib/chain/koiosClient";
import type { KoiosTxCborResponse, KoiosUtxoInfo } from "@cardananium/cquisitor-lib/chain/koiosTypes";

import { DiskCache, MemoryTtlCache } from "../../../src/chain/cache.js";
import { installProviderFetch, ProviderAbortedError, ProviderHttpError, ProviderOfflineError, providerEndpoints } from "../../../src/chain/http.js";
import { ChainService } from "../../../src/chain/index.js";
import { CachingClient, createCoreClient, providerStatusOf, rowNamespace, selectProvider } from "../../../src/chain/providers.js";
import { loadConfig } from "../../../src/config.js";
import { ToolInputError } from "../../../src/tools/_shared.js";
import { providerFailure } from "../../../src/tools/tx_load.js";
import { json, makeContext, startStub, tempDir, type Stub } from "./serviceHarness.js";

const HASH = "ab".repeat(32);

describe("selectProvider", () => {
  it("defaults to koios, anonymous with a warning, and keeps keys out of the answer's text", () => {
    const anonymous = selectProvider(loadConfig({}), "mainnet");
    expect(anonymous).toMatchObject({ provider: "koios", apiKey: undefined });
    expect(anonymous.warnings.join(" ")).toMatch(/anonymously/);
    const keyed = selectProvider(loadConfig({ KOIOS_API_KEY: "secret" }), "mainnet");
    expect(keyed).toMatchObject({ provider: "koios", apiKey: "secret", warnings: [] });
  });

  it("an explicit request beats CARDANO_DEBUG_PROVIDER; blockfrost needs the project id of THAT network", () => {
    const config = loadConfig({ CARDANO_DEBUG_PROVIDER: "blockfrost", BLOCKFROST_PROJECT_ID_MAINNET: "bfMain", KOIOS_API_KEY: "k" });
    expect(selectProvider(config, "mainnet")).toMatchObject({ provider: "blockfrost", apiKey: "bfMain" });
    expect(selectProvider(config, "mainnet", "koios")).toMatchObject({ provider: "koios", apiKey: "k" });
    const error = (() => {
      try {
        selectProvider(config, "preprod");
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as ToolInputError).argument).toBe("provider");
    expect((error as ToolInputError).message).toContain("BLOCKFROST_PROJECT_ID_PREPROD");
  });

  it("a provider name that is neither is refused", () => {
    expect(() => selectProvider(loadConfig({}), "mainnet", "ogmios")).toThrow(/koios or blockfrost/);
  });

  it("CARDANO_DEBUG_PROVIDER spelled with capitals still selects blockfrost", () => {
    const config = loadConfig({ CARDANO_DEBUG_PROVIDER: "Blockfrost", BLOCKFROST_PROJECT_ID_MAINNET: "x" });
    expect(selectProvider(config, "mainnet").provider).toBe("blockfrost");
  });
});

describe("providerFailure: every way a provider says no is a recoverable answer with a next step", () => {
  const http = (status: number | undefined, extra: Partial<ConstructorParameters<typeof ProviderHttpError>[1]> = {}) =>
    new ProviderHttpError(`koios (mainnet) request failed: ${status ?? "network"}`, { provider: "koios", network: "mainnet", url: "u", status, attempts: 4, ...extra });
  const payload = (error: unknown) => providerFailure(error)!.structuredContent as Record<string, any>;

  it("401 / 403 -> auth_failed, naming the key to fix and the ways around it", () => {
    for (const status of [401, 403]) {
      const p = payload(http(status, { authenticated: true }));
      expect(p).toMatchObject({ code: "auth_failed", provider: "koios", network: "mainnet", status });
      expect(p.message).toContain("KOIOS_API_KEY was rejected");
      expect(p.next.join(" ")).toMatch(/provider=blockfrost/);
      expect(p.next.join(" ")).toMatch(/tx_load\(bundle=/);
    }
    const bf = payload(new ProviderHttpError("blockfrost x", { provider: "blockfrost", network: "preprod", url: "u", status: 403, attempts: 1 }));
    expect(bf.message).toContain("BLOCKFROST_PROJECT_ID_PREPROD");
    expect(bf.next.join(" ")).toMatch(/provider=koios/);
  });

  it("a core client's plain 'API error: 401' (Error with no class) maps the same way", () => {
    const p = payload(new Error("Koios API error: 401 Unauthorized"));
    expect(p).toMatchObject({ code: "auth_failed", provider: "koios", status: 401 });
    expect(p.message).toContain("Koios API error: 401 Unauthorized");
    expect(payload(new Error("Blockfrost API error: 402 Payment Required — usage exceeded"))).toMatchObject({ code: "rate_limited", provider: "blockfrost", status: 402 });
    expect(payload(new Error("Koios API error: 404 Not Found"))).toMatchObject({ code: "provider_error", status: 404 });
    expect(payload(new Error("Koios API error: 413 Payload Too Large"))).toMatchObject({ code: "provider_error", status: 413 });
    expect(providerStatusOf(new Error("something else entirely"))).toBeUndefined();
    expect(providerFailure(new Error("boom"))).toBeUndefined();
  });

  it("429: advice depends on whether a key was sent and on the provider; retry_after_s is the provider's", () => {
    const anonymous = payload(http(429, { authenticated: false, retryAfterS: 30 }));
    expect(anonymous).toMatchObject({ code: "rate_limited", retry_after_s: 30 });
    expect(anonymous.message).toContain("set KOIOS_API_KEY");
    expect(anonymous.message).toContain("wait 30 s");
    expect(anonymous.message).toMatch(/Koios API key \(koios\.rest\)/); // the public Koios is limited: a key lifts it ...
    expect(anonymous.message).toMatch(/Blockfrost project id \(blockfrost\.io\), set BLOCKFROST_PROJECT_ID_MAINNET and use provider=blockfrost/); // ... and so does Blockfrost

    const keyed = payload(http(429, { authenticated: true }));
    expect(keyed.message).not.toContain("set KOIOS_API_KEY");
    expect(keyed.message).toMatch(/KOIOS_API_KEY's plan/);
    expect(keyed.message).toMatch(/Blockfrost project id/);
    expect(keyed.retry_after_s).toBeUndefined();

    const bf = payload(new ProviderHttpError("blockfrost x", { provider: "blockfrost", network: "mainnet", url: "u", status: 429, attempts: 4 }));
    expect(bf.message).toMatch(/Blockfrost project's rate limit/);
    expect(bf.message).toMatch(/set KOIOS_API_KEY in the server environment and use provider=koios/);
  });

  it("5xx and network failures stay provider_error; offline and cancellation keep their codes", () => {
    expect(payload(http(503))).toMatchObject({ code: "provider_error", status: 503, attempts: 4 });
    expect(payload(http(undefined))).toMatchObject({ code: "provider_error" });
    // a busy public Koios (no key sent) points at the keys; a keyed one does not
    const busy = payload(http(503, { authenticated: false }));
    expect(busy.message).toMatch(/public Koios API can be overloaded or throttled/);
    expect(JSON.stringify(busy.next)).toMatch(/Koios API key \(koios\.rest\).*Blockfrost project id/);
    expect(payload(http(503, { authenticated: true })).message).not.toMatch(/public Koios API/);
    expect(payload(new ProviderOfflineError("https://api.koios.rest/x"))).toMatchObject({ code: "offline" });
    expect(payload(new ProviderAbortedError("https://api.koios.rest/x"))).toMatchObject({ code: "cancelled" });
    expect(providerFailure(http(500), { tx_hash: HASH })!.structuredContent).toMatchObject({ tx_hash: HASH });
  });
});

describe("rows are cached per provider", () => {
  function row(hash: string, extra: Record<string, unknown>): KoiosTxCborResponse {
    return { tx_hash: hash, block_hash: "", block_height: 0, cbor: "84a0", ...extra } as KoiosTxCborResponse;
  }

  it("a Blockfrost row is never served to a Koios load, nor the other way round (tx, utxo and epoch rows)", async () => {
    const cache = new DiskCache({ root: tempDir(), log: () => undefined });
    const calls: string[] = [];
    const fake = (name: string): BlockchainDataClient =>
      ({
        async getTxCbor(hashes: string[]) {
          calls.push(`${name}:tx`);
          return hashes.map((h) => row(h, name === "koios" ? { absolute_slot: 99, epoch_no: 5, block_hash: "bb" } : {}));
        },
        async getUtxoInfo(refs: string[]) {
          calls.push(`${name}:utxo`);
          return refs.map((r) => ({ tx_hash: r.split("#")[0]!, tx_index: Number(r.split("#")[1]), address: name, value: "1" }) as unknown as KoiosUtxoInfo);
        },
        async getEpochParams() {
          calls.push(`${name}:params`);
          return [{ epoch_no: name === "koios" ? 500 : 501 }] as never;
        },
      }) as unknown as BlockchainDataClient;
    const client = (name: "koios" | "blockfrost") => new CachingClient(fake(name), { network: "mainnet", provider: name, cache, memory: new MemoryTtlCache() });

    await client("blockfrost").getTxCbor([HASH]);
    const koios = client("koios");
    const rows = await koios.getTxCbor([HASH]);
    expect((rows[0] as unknown as Record<string, unknown>).absolute_slot).toBe(99); // fetched from Koios, not the slotless Blockfrost row
    expect(calls).toEqual(["blockfrost:tx", "koios:tx"]);
    expect(koios.rows.cache_hits).toEqual([]);

    await client("koios").getUtxoInfo([`${HASH}#0`]);
    expect((await client("blockfrost").getUtxoInfo([`${HASH}#0`]))[0]!.address).toBe("blockfrost");
    await client("koios").getEpochParams();
    expect((await client("blockfrost").getEpochParams())[0]!.epoch_no).toBe(501);

    // each provider hits its own rows the second time
    const again = client("koios");
    await again.getTxCbor([HASH]);
    expect(again.rows.cache_hits).toEqual([`${rowNamespace("tx", "mainnet", "koios")}:1/1`]);
    expect(await cache.list("tx/mainnet/koios")).toEqual([`${HASH}.json`]);
    expect(await cache.list("tx/mainnet/blockfrost")).toEqual([`${HASH}.json`]);
  });
});

describe("over HTTP: status errors and tx rows by provider", () => {
  let koios: Stub;
  let blockfrost: Stub;
  let uninstall: () => void;
  let service: ChainService;
  let mode: { koiosStatus: number | undefined } = { koiosStatus: undefined };
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    koios = await startStub((req, res, body) => {
      if (mode.koiosStatus) return json(res, { error: "no" }, mode.koiosStatus);
      if (req.url === "/api/v1/tx_cbor") {
        const hashes = (JSON.parse(body) as { _tx_hashes: string[] })._tx_hashes;
        return json(res, hashes.filter((h) => h === HASH).map((h) => ({ tx_hash: h, block_hash: "bb", block_height: 7, epoch_no: 500, absolute_slot: 123456, cbor: "84a0f5f6" })));
      }
      json(res, []);
    });
    blockfrost = await startStub((req, res) => {
      if (req.url === `/api/v0/txs/${HASH}/cbor`) return json(res, { cbor: "84a0f5f6" });
      if (req.url === `/api/v0/txs/${HASH}`) return json(res, { slot: 123456, block: "bb", block_height: 7, valid_contract: true });
      json(res, { error: "not found" }, 404);
    });
    for (const [name, value] of [
      ["CARDANO_DEBUG_KOIOS_URL_MAINNET", `${koios.url}/api/v1`],
      ["CARDANO_DEBUG_BLOCKFROST_URL_MAINNET", `${blockfrost.url}/api/v0`],
    ] as const) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
    const t = makeContext({ BLOCKFROST_PROJECT_ID_MAINNET: "bfProject", KOIOS_API_KEY: "kk" });
    service = new ChainService(t.ctx);
    uninstall = installProviderFetch({ endpoints: providerEndpoints(), policy: { retries: 0, timeoutMs: 5000 }, log: () => undefined });
  });

  afterAll(async () => {
    uninstall?.();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await koios?.close();
    await blockfrost?.close();
  });

  it("a status the core client throws as plain text reaches the caller as a ProviderHttpError with the status and the key's presence", async () => {
    mode = { koiosStatus: 401 };
    const withKey = createCoreClient(selectProvider(loadConfig({ KOIOS_API_KEY: "kk" }), "mainnet"), "mainnet");
    const error = (await withKey.getTip().catch((e: unknown) => e)) as ProviderHttpError;
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ provider: "koios", network: "mainnet", status: 401, authenticated: true });
    const anonymous = createCoreClient(selectProvider(loadConfig({}), "mainnet"), "mainnet");
    expect(await anonymous.getTip().catch((e: unknown) => e)).toMatchObject({ status: 401, authenticated: false });
    mode = { koiosStatus: undefined };
  });

  it("fetchTxCbor keeps Koios and Blockfrost rows apart and finds the inclusion either way", async () => {
    const viaBlockfrost = await service.fetchTxCbor(HASH, "mainnet", { provider: "blockfrost" });
    expect(viaBlockfrost).toMatchObject({ source: "provider", provider: "blockfrost", txHex: "84a0f5f6" });
    expect(viaBlockfrost.inclusion).toMatchObject({ slot: "123456", source: "blockfrost /txs" });

    const koiosBefore = koios.requests.length;
    const viaKoios = await service.fetchTxCbor(HASH, "mainnet", { provider: "koios" });
    expect(viaKoios).toMatchObject({ source: "provider", provider: "koios" }); // not the Blockfrost row from the cache
    expect(koios.requests.length).toBe(koiosBefore + 1);
    expect(viaKoios.inclusion).toMatchObject({ slot: "123456", epoch: 500, source: "koios tx_cbor row" });

    const koiosAgain = await service.fetchTxCbor(HASH, "mainnet", { provider: "koios" });
    expect(koiosAgain.source).toBe("cache");
    expect(koiosAgain.inclusion).toMatchObject({ slot: "123456", epoch: 500 });
    expect((await service.fetchTxCbor(HASH, "mainnet", { provider: "blockfrost" })).source).toBe("cache");
    expect(koios.requests.length).toBe(koiosBefore + 1);
  });

  it("an unknown hash says what to check next", async () => {
    const error = (await service.fetchTxCbor("cd".repeat(32), "mainnet", { provider: "koios" }).catch((e: unknown) => e)) as ToolInputError;
    expect(error).toBeInstanceOf(ToolInputError);
    expect(error.argument).toBe("tx_hash");
    expect(error.message).toMatch(/not found on mainnet via koios/);
    expect(error.message).toMatch(/try mainnet, preprod and preview/);
    expect(error.message).toMatch(/pass tx_cbor instead/);
  });
});
