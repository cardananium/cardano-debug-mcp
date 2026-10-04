// The S6 fixture cache (artificial provider rows keyed per provider) replays an on-chain transaction at its inclusion
// point without a single provider request: the in-process twin of test/e2e/onchain.e2e.test.ts, which needs a build.
import { cpSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixturePath, fxInt, fxStr } from "../../helpers/fixtures.js";
import { json, makeContext, startStub, tempDir, type Stub, type TestContext } from "./serviceHarness.js";
import { txLoad } from "../../../src/tools/tx_load.js";
import { txValidate } from "../../../src/tools/tx_validate.js";

const TX_HASH = fxStr("s06.txHash");
const TX_ID = fxStr("s06.txId");
const SLOT = fxStr("s06.slot");
const EPOCH = fxInt("s06.epoch");

type Json = Record<string, any>;

describe("fixture cache -> on-chain replay (no network)", () => {
  let stub: Stub;
  let t: TestContext;
  let saved: string | undefined;

  beforeAll(async () => {
    stub = await startStub((_req, res) => json(res, [], 404));
    saved = process.env.CARDANO_DEBUG_KOIOS_URL_MAINNET;
    process.env.CARDANO_DEBUG_KOIOS_URL_MAINNET = `${stub.url}/api/v1`;
    const cacheDir = tempDir("cdm-onchain-unit-");
    cpSync(fixturePath(fxStr("s06.cacheDir")), cacheDir, { recursive: true }); // fresh mtimes: row TTLs count from them
    t = makeContext({ CARDANO_DEBUG_CACHE_DIR: cacheDir });
  });

  afterAll(async () => {
    await t.shutdown(); // uninstalls the provider fetch the chain service installed
    if (saved === undefined) delete process.env.CARDANO_DEBUG_KOIOS_URL_MAINNET;
    else process.env.CARDANO_DEBUG_KOIOS_URL_MAINNET = saved;
    await stub.close();
  });

  it("tx_load(tx_hash) builds the context at the inclusion slot from the cached rows alone", async () => {
    const load = await txLoad(t.ctx, { tx_hash: TX_HASH, network: "mainnet" });
    expect(load.isError, JSON.stringify(load.structuredContent)).toBeFalsy();
    const s = load.structuredContent as Json;
    expect(s.tx_id).toBe(TX_ID);
    expect(s.on_chain).toMatchObject({ slot: SLOT, epoch: EPOCH, is_valid: true });
    expect(s.context).toMatchObject({ status: "fetched", provider: "koios" });
    expect(s.missing_utxos).toEqual([]);
    expect(stub.requests, "every provider row must come from the fixture cache").toEqual([]);
  });

  it("tx_validate: valid at the inclusion point; the verdict is cached for exactly this context", async () => {
    const result = await txValidate(t.ctx, { tx_id: TX_ID });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    expect((result.structuredContent as Json).verdict).toBe("valid");
    expect(stub.requests).toEqual([]);
    const names = await t.ctx.services.chain!.cache.list("validation/mainnet");
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(new RegExp(`^${TX_HASH}\\.[0-9a-f]{16}\\.[0-9a-f]{16}\\.json$`));
    expect(await t.ctx.services.chain!.cache.list("epoch_params/mainnet/koios")).toContain(`${EPOCH}.json`);
  });

  it("a second server over the same cache recalls the handle and restores the verdict without a request", async () => {
    const second = makeContext({ CARDANO_DEBUG_CACHE_DIR: t.cacheDir, CARDANO_DEBUG_OFFLINE: "1" });
    // the second service finds the record in the cache (a bundle written by the first, with the validation in it)
    const { ensureChainService } = await import("../../../src/chain/index.js");
    const service = ensureChainService(second.ctx);
    const record = await service.recall(TX_ID);
    expect(record?.txId).toBe(TX_ID);
    expect(record?.onChain).toMatchObject({ slot: SLOT });
    expect(record?.validation).toBeDefined();
    await second.shutdown();
  });
});
