// ChainService over a real in-process library and a temp cache directory: which verdict is restored for
// which context, what an imported bundle may write, parallel calls, pending-tx contexts, recall after a restart.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { importContext, slotNow } from "../../../src/chain/bundle.js";
import { chainStateOf, setChainState } from "../../../src/chain/state.js";
import { emptyProviderRows } from "../../../src/chain/providers.js";
import { OfflineContextError } from "../../../src/chain/http.js";
import { ChainService } from "../../../src/chain/index.js";
import { stringifyBareIntegers } from "../../../src/chain/contextCodec.js";
import { ToolInputError } from "../../../src/tools/_shared.js";
import type { TxRecord } from "../../../src/store/txStore.js";
import { buildTxRecord } from "../../../src/tx/record.js";
import { WorkerAbortedError } from "../../../src/workers/rpc.js";
import { fxInt, fxStr } from "../../helpers/fixtures.js";
import { CountingLib, makeContext, SAMPLE_CONTEXT, SAMPLE_HASH, SAMPLE_ID, SAMPLE_TX } from "./serviceHarness.js";

type Json = Record<string, any>;

/** Inclusion facts of the artificial on-chain transaction of scenario S6 (any plausible `on_chain` block would do). */
const ON_CHAIN_SLOT = fxStr("s06.slot");
const ON_CHAIN_EPOCH = fxInt("s06.epoch");

/** A service and a record loaded from the DebuggerContext sample (an imported context: status "bundle"). */
async function sample(env: NodeJS.ProcessEnv = { CARDANO_DEBUG_OFFLINE: "1" }) {
  const t = makeContext(env);
  const service = new ChainService(t.ctx);
  const { record } = await service.loadFromBundleArgument(SAMPLE_CONTEXT, {});
  return { ...t, service, record };
}

async function freshRecord(lib: CountingLib): Promise<TxRecord> {
  return buildTxRecord(lib, { tx: SAMPLE_TX, network: "mainnet" });
}

/** The record's context posing as a live one under another slot. */
function liveLike(record: TxRecord, slotDelta = 0n): void {
  const state = chainStateOf(record)!;
  const context = { ...state.context!, slot: BigInt(String(state.context!.slot)) + slotDelta } as typeof state.context;
  setChainState(record, { ...state, status: "fetched", context, slot: BigInt(String(context!.slot)) });
}

describe("a verdict is restored only for the context it was computed on", () => {
  it("a context imported from a bundle leaves no verdict in the live cache", async () => {
    const { service, record } = await sample();
    await service.validate(record);
    expect(record.validation).toBeDefined();
    expect(await service.cache.list("validation/mainnet")).toEqual([]);
  });

  it("a live context caches its verdict under bytes AND context; another context does not get it", async () => {
    const { service, record, lib, ctx } = await sample();
    liveLike(record);
    await service.validate(record, { refresh: true });
    const names = await service.cache.list("validation/mainnet");
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(new RegExp(`^${SAMPLE_HASH}\\.[0-9a-f]{16}\\.[0-9a-f]{16}\\.json$`));

    const restore = (r: TxRecord) => (service as unknown as { restoreValidation(r: TxRecord): Promise<void> }).restoreValidation(r);

    const sameContext = await freshRecord(lib);
    setChainState(sameContext, { ...chainStateOf(record)! });
    await restore(sameContext);
    expect(sameContext.validation?.redeemers.size).toBe(2);

    // the tip moved (the context was fetched again an hour later, or built by a bundle at another slot)
    const otherContext = await freshRecord(lib);
    setChainState(otherContext, { ...chainStateOf(record)! });
    liveLike(otherContext, 5n);
    await restore(otherContext);
    expect(otherContext.validation).toBeUndefined();

    // other bytes of the same body (a witness added) do not get it either
    const otherBytes = await freshRecord(lib);
    otherBytes.txHex = otherBytes.txHex + "00";
    setChainState(otherBytes, { ...chainStateOf(record)! });
    await restore(otherBytes);
    expect(otherBytes.validation).toBeUndefined();
    void ctx;
  });
});

describe("what tx_load(bundle=…) may write", () => {
  it("never replaces the bundle a live load wrote; the imported context gets its own file", async () => {
    const { service, record, cacheDir } = await sample();
    liveLike(record);
    const live = await service.writeBundle(record); // what a live load leaves
    const canonical = await service.cache.getText("bundles/mainnet", `${SAMPLE_HASH}.json`);
    expect(canonical).toBe(live.text);

    const edited = JSON.parse(live.text) as Json;
    edited.validation_input_context.slot = Number(edited.validation_input_context.slot) + 5;
    delete edited.validation_result;
    await service.loadFromBundleArgument(JSON.stringify(edited), {});

    expect(await service.cache.getText("bundles/mainnet", `${SAMPLE_HASH}.json`)).toBe(canonical); // untouched
    const imported = await service.cache.getText("bundles/mainnet", `${SAMPLE_HASH}.imported.json`);
    expect(JSON.parse(imported!).validation_input_context.slot).toBe(edited.validation_input_context.slot);
    expect(path.dirname(service.cache.pathOf("bundles/mainnet", "x"))).toBe(path.join(cacheDir, "bundles", "mainnet"));
  });

  it("an explicit export (writeBundle without `auto`) writes bundles/<net>/<hash>.json and keeps the previous path when a write fails", async () => {
    const { service, record } = await sample();
    const written = await service.writeBundle(record);
    expect(written.path).toMatch(new RegExp(`bundles/mainnet/${SAMPLE_HASH}\\.json$`));
    expect(record.bundlePath).toBe(written.path);
    // a cache that cannot be written to: the answer has no path, the record keeps the one it had
    const broken = (service as unknown as { cache: { setText: () => Promise<undefined> } }).cache;
    broken.setText = async () => undefined;
    const failed = await service.writeBundle(record);
    expect(failed.path).toBeUndefined();
    expect(record.bundlePath).toBe(written.path);
  });

  it("loading a bundle onto a record with the same bytes carries on_chain and the new bundle path with it", async () => {
    const { service, record } = await sample();
    expect(record.onChain).toBeUndefined();
    const text = (await service.writeBundle(record)).text;
    const bundle = JSON.parse(text) as Json;
    bundle.on_chain = { slot: ON_CHAIN_SLOT, epoch: ON_CHAIN_EPOCH, block_height: fxInt("s06.blockHeight"), is_valid: true, source: "test" };
    const { record: again } = await service.loadFromBundleArgument(JSON.stringify(bundle), {});
    expect(again).toBe(record); // the handle is kept
    expect(again.onChain).toMatchObject({ slot: ON_CHAIN_SLOT, epoch: ON_CHAIN_EPOCH, is_valid: true });
    expect(again.bundlePath).toMatch(/\.imported\.json$/);
    // and the other way round: a bundle that says nothing about inclusion does not leave a stale one behind
    delete bundle.on_chain;
    const { record: third } = await service.loadFromBundleArgument(JSON.stringify(bundle), {});
    expect(third.onChain).toBeUndefined();
  });
});

describe("the bundle argument", () => {
  const lib = new CountingLib();

  it("warns when network= overrides the one the source declares", async () => {
    const conflicting = await importContext(lib, SAMPLE_CONTEXT, { network: "preprod" });
    expect(conflicting.network).toBe("preprod");
    expect(conflicting.providerWarnings[0]).toMatch(/network=preprod was passed but the source says mainnet/);
    const agreeing = await importContext(lib, SAMPLE_CONTEXT, { network: "mainnet" });
    expect(agreeing.providerWarnings.some((w) => w.includes("was passed but"))).toBe(false);
    const none = await importContext(lib, SAMPLE_CONTEXT, {});
    expect(none.providerWarnings.some((w) => w.includes("was passed but"))).toBe(false);
  });

  it("invalid JSON is a bundle error that says so", async () => {
    const error = await importContext(lib, '{"cardano_debug_bundle": 1, "tx_cbor": "84a0', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as ToolInputError).argument).toBe("bundle");
    expect((error as ToolInputError).message).toMatch(/not valid JSON/);
    const plain = await importContext(lib, '{"a": ', {}).catch((e: unknown) => e);
    expect(plain).toBeInstanceOf(ToolInputError);
    expect((plain as ToolInputError).message).toMatch(/not valid JSON/);
  });

  it("a missing, unreadable and non-file path are all bundle errors", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cdm-bundle-arg-"));
    const missing = await importContext(lib, path.join(dir, "nope.json"), {}).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(ToolInputError);
    expect((missing as ToolInputError).argument).toBe("bundle");
    expect((missing as ToolInputError).message).toMatch(/existing file/);
    expect((missing as ToolInputError).message).toContain("working directory");

    const directory = await importContext(lib, dir, {}).catch((e: unknown) => e);
    expect(directory).toBeInstanceOf(ToolInputError);
    expect((directory as ToolInputError).message).toMatch(/not a file/);

    if (process.getuid?.() !== 0) {
      const locked = path.join(dir, "locked.json");
      writeFileSync(locked, "{}");
      chmodSync(locked, 0o000);
      const unreadable = await importContext(lib, locked, {}).catch((e: unknown) => e);
      expect(unreadable).toBeInstanceOf(ToolInputError);
      expect((unreadable as ToolInputError).argument).toBe("bundle");
      expect((unreadable as ToolInputError).message).toMatch(/cannot be read \(EACCES\)/);
    }
  });
});

describe("parallel calls on one record share one run", () => {
  it("three tx_validate-style calls run the evaluator once", async () => {
    const { service, record, lib } = await sample();
    const before = lib.count("validate_transaction_js");
    const results = await Promise.all([service.validate(record), service.validate(record), service.validate(record)]);
    expect(lib.count("validate_transaction_js") - before).toBe(1);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
    // a refresh is a new run, and the finished flight is gone
    await service.validate(record, { refresh: true });
    expect(lib.count("validate_transaction_js") - before).toBe(2);
  });

  it("a caller that joined a run outlives the cancellation of the caller that started it", async () => {
    const { service, record, lib } = await sample();
    const before = lib.count("validate_transaction_js");
    lib.before = async (fn, count, options) => {
      if (fn !== "validate_transaction_js" || count - before !== 1) return;
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (options.signal?.aborted) throw new WorkerAbortedError();
    };
    const controller = new AbortController();
    const first = service.validate(record, { signal: controller.signal });
    const firstResult = first.catch((e: unknown) => e);
    const second = service.validate(record, {});
    setTimeout(() => controller.abort(), 20);
    expect(await firstResult).toBeInstanceOf(WorkerAbortedError);
    const stored = await second;
    expect(stored.redeemers.size).toBe(2);
    expect(lib.count("validate_transaction_js") - before).toBe(2);
  });

  it("a refresh that replaces the chain state while the evaluator runs does not leave the old verdict behind", async () => {
    const { service, record, lib } = await sample();
    const before = lib.count("validate_transaction_js");
    lib.before = async (fn, count) => {
      if (fn !== "validate_transaction_js" || count - before !== 1) return;
      await new Promise((resolve) => setTimeout(resolve, 60));
    };
    const running = service.validate(record);
    setTimeout(() => {
      const state = chainStateOf(record)!;
      setChainState(record, { ...state, context: { ...state.context! } });
    }, 15);
    const stored = await running;
    expect(lib.count("validate_transaction_js") - before).toBe(2); // validated again on the new context
    expect(record.validation).toBe(stored);
  });

  it("three parallel context loads read the cache once", async () => {
    const { service, record, lib, ctx } = await sample();
    liveLike(record);
    await service.writeBundle(record); // the offline fallback serves this
    const fresh = await freshRecord(lib);
    ctx.txStore.put(fresh);
    const before = lib.count("get_necessary_data_list_js");
    const results = await Promise.all([service.loadContext(fresh), service.loadContext(fresh), service.loadContext(fresh)]);
    expect(results.map((r) => r.source)).toEqual(["bundle", "bundle", "bundle"]);
    expect(lib.count("get_necessary_data_list_js") - before).toBe(1);
    expect(chainStateOf(fresh)?.status).toBe("cached"); // the disk cache's copy of the live context
  });
});

describe("a context built for a transaction that is not on chain goes stale", () => {
  /** Put a context of the sample into the context cache of a fresh record; returns the record and the key. */
  async function cached(opts: { cachedSlot?: bigint; ttl?: bigint; start?: bigint; onChain?: boolean; ageMs?: number }) {
    const donor = await sample(); // its context is the one cached; the service under test has an empty cache otherwise
    const state = chainStateOf(donor.record)!;
    const { ctx, lib } = makeContext({ CARDANO_DEBUG_OFFLINE: "1" });
    const service = new ChainService(ctx);
    const fresh = await freshRecord(lib);
    const body = fresh.decoded.transaction.body as Json;
    body.ttl = opts.ttl === undefined ? undefined : opts.ttl.toString();
    body.validity_start_interval = opts.start === undefined ? undefined : opts.start.toString();
    if (opts.onChain) fresh.onChain = { slot: ON_CHAIN_SLOT, epoch: ON_CHAIN_EPOCH, block_height: 1, is_valid: true, source: "test" };
    const key = (service as unknown as { contextKey(r: TxRecord, p: string): { ns: string; key: string } }).contextKey(fresh, "koios");
    const live = {
      provider: "koios",
      necessary: state.necessary,
      fetched: state.fetched ?? {},
      context: state.context,
      providerRows: emptyProviderRows("koios", "mainnet"),
      missingUtxos: [],
      providerWarnings: [],
      defaultsApplied: [],
      refScripts: state.refScripts,
      slot: opts.cachedSlot ?? slotNow("mainnet"),
      protocolMajor: state.protocolMajor,
      capturedAt: Date.now(),
      ...(opts.onChain ? { onChain: fresh.onChain } : {}),
    };
    await service.cache.setJson(key.ns, key.key, live);
    if (opts.ageMs) {
      const when = new Date(Date.now() - opts.ageMs);
      utimesSync(service.cache.pathOf(key.ns, key.key), when, when);
    }
    return { service, fresh, key, ctx };
  }

  it("is served from the context cache while it is fresh and the validity interval has not been crossed", async () => {
    const now = slotNow("mainnet");
    const { service, fresh } = await cached({ ttl: now + 10_000n });
    const loaded = await service.loadContext(fresh);
    expect(loaded.source).toBe("cache");
    expect(loaded.state.status).toBe("cached");
  });

  it("is dropped after 10 minutes (it keeps a tip and spent flags); one on chain keeps its hour", async () => {
    const pending = await cached({ ageMs: 11 * 60 * 1000 });
    await expect(pending.service.loadContext(pending.fresh)).rejects.toBeInstanceOf(OfflineContextError); // offline: nothing else to serve
    const onChain = await cached({ onChain: true, ageMs: 11 * 60 * 1000 });
    expect((await onChain.service.loadContext(onChain.fresh)).source).toBe("cache");
    const expired = await cached({ onChain: true, ageMs: 61 * 60 * 1000 });
    await expect(expired.service.loadContext(expired.fresh)).rejects.toBeInstanceOf(OfflineContextError);
  });

  it("is dropped when the slot has passed the ttl or the validity start since it was cached", async () => {
    const now = slotNow("mainnet");
    const expiredTtl = await cached({ cachedSlot: now - 500n, ttl: now - 100n });
    await expect(expiredTtl.service.loadContext(expiredTtl.fresh)).rejects.toBeInstanceOf(OfflineContextError);
    expect(await expiredTtl.service.cache.getText(expiredTtl.key.ns, expiredTtl.key.key)).toBeUndefined();

    const startedSince = await cached({ cachedSlot: now - 500n, start: now - 100n });
    await expect(startedSince.service.loadContext(startedSince.fresh)).rejects.toBeInstanceOf(OfflineContextError);

    // the interval was already open (or still closed) when it was cached: nothing changed since
    const stillOpen = await cached({ cachedSlot: now - 500n, start: now - 1_000n, ttl: now + 10_000n });
    expect((await stillOpen.service.loadContext(stillOpen.fresh)).source).toBe("cache");
  });

  it("offline with nothing cached is an offline error (not invalid_argument for tx_id); a bundle in the cache is served instead", async () => {
    const { ctx, lib } = makeContext({ CARDANO_DEBUG_OFFLINE: "1" });
    const service = new ChainService(ctx);
    const fresh = await freshRecord(lib);
    const error = await service.loadContext(fresh).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OfflineContextError);
    expect((error as Error).message).toMatch(/tx_load\(bundle=/);
    // the copy written for an imported context is what the offline fallback finds, and says it is an imported one
    await service.loadFromBundleArgument(SAMPLE_CONTEXT, {});
    const again = await freshRecord(lib);
    const loaded = await service.loadContext(again);
    expect(loaded.source).toBe("bundle");
    expect(loaded.state.status).toBe("bundle");
  });
});

describe("recall after a restart", () => {
  it("rebuilds a live context from its bundle as a cached state, for any spelling of the handle", async () => {
    const first = await sample();
    liveLike(first.record);
    await first.service.writeBundle(first.record);

    const t = makeContext({ CARDANO_DEBUG_OFFLINE: "1", CARDANO_DEBUG_CACHE_DIR: first.cacheDir });
    const service = new ChainService(t.ctx);
    const record = await service.recall(SAMPLE_ID.toUpperCase());
    expect(record?.txId).toBe(SAMPLE_ID);
    const state = chainStateOf(record!)!;
    expect(state.status).toBe("cached");
    expect(state.origin).toMatch(/restored after a restart/);
    expect(record!.source).toBe("cache");
    expect(t.ctx.txStore.get(SAMPLE_ID)).toBe(record);
  });

  it("rebuilds an imported context as an imported one (it must not pass for a live copy)", async () => {
    const first = await sample();
    expect(await first.service.cache.list("bundles/mainnet")).toEqual([`${SAMPLE_HASH}.imported.json`]);
    const t = makeContext({ CARDANO_DEBUG_OFFLINE: "1", CARDANO_DEBUG_CACHE_DIR: first.cacheDir });
    const record = await new ChainService(t.ctx).recall(SAMPLE_ID);
    expect(chainStateOf(record!)?.status).toBe("bundle");
    expect(record!.source).toBe("bundle");
  });

  it("falls back to the tx row: per provider (with its slot) and the flat directory older versions wrote", async () => {
    const row = { tx_hash: SAMPLE_HASH, block_hash: "bb", block_height: 9, epoch_no: 500, absolute_slot: 123456, cbor: SAMPLE_TX };

    const koios = makeContext({ CARDANO_DEBUG_OFFLINE: "1" });
    await new ChainService(koios.ctx).cache.setJson("tx/mainnet/koios", `${SAMPLE_HASH}.json`, row);
    const fromKoios = await new ChainService(koios.ctx).recall(SAMPLE_ID);
    expect(fromKoios?.onChain).toMatchObject({ slot: "123456", epoch: 500 });

    // a Blockfrost row has no slot: the inclusion cached beside it supplies it
    const blockfrost = makeContext({ CARDANO_DEBUG_OFFLINE: "1" });
    const bfService = new ChainService(blockfrost.ctx);
    await bfService.cache.setJson("tx/mainnet/blockfrost", `${SAMPLE_HASH}.json`, { tx_hash: SAMPLE_HASH, block_hash: "", block_height: 0, cbor: SAMPLE_TX });
    expect((await new ChainService(blockfrost.ctx).recall(SAMPLE_ID))?.onChain).toBeUndefined();
    await bfService.cache.setJson("inclusion/mainnet", `${SAMPLE_HASH}.json`, { slot: "777", epoch: 501, block_height: 5, is_valid: true, source: "blockfrost /txs" });
    expect((await new ChainService(blockfrost.ctx).recall(SAMPLE_ID))?.onChain).toMatchObject({ slot: "777", epoch: 501 });

    const flat = makeContext({ CARDANO_DEBUG_OFFLINE: "1" });
    const flatDir = path.join(flat.cacheDir, "tx", "mainnet");
    mkdirSync(flatDir, { recursive: true });
    writeFileSync(path.join(flatDir, `${SAMPLE_HASH}.json`), JSON.stringify({ tx_hash: SAMPLE_HASH, cbor: SAMPLE_TX }));
    const legacy = await new ChainService(flat.ctx).recall(SAMPLE_ID);
    expect(legacy?.txHash).toBe(SAMPLE_HASH);
    expect(legacy?.onChain).toBeUndefined();
  });

  it("knows nothing about a handle the cache has never seen, or a malformed one", async () => {
    const t = makeContext({ CARDANO_DEBUG_OFFLINE: "1" });
    const service = new ChainService(t.ctx);
    expect(await service.recall("tx_mainnet_000000000000")).toBeUndefined();
    expect(await service.recall("not a handle")).toBeUndefined();
    void stringifyBareIntegers;
  });
});
