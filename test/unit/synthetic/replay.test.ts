// The provider-cache writers, proved end to end: a synthetic on-chain transaction is replayed at its inclusion point
// from rows alone (the Koios stub answers 404 and counts requests; none may arrive).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { json, makeContext, startStub, tempDir, type Stub, type TestContext } from "../chain/serviceHarness.js";
import { txLoad } from "../../../src/tools/tx_load.js";
import { txValidate } from "../../../src/tools/tx_validate.js";
import { drepIdBech32, keyCred, rewardAddress, scriptCred } from "../../fixtures/synthetic/lib/address.js";
import { utxo, type ChainContext } from "../../fixtures/synthetic/lib/context.js";
import { fit } from "../../fixtures/synthetic/lib/fit.js";
import { drepKey } from "../../fixtures/synthetic/lib/keys.js";
import { paramSet } from "../../fixtures/synthetic/lib/params.js";
import { constr, datumHash, pInt, UNIT } from "../../fixtures/synthetic/lib/plutusData.js";
import { scriptHash } from "../../fixtures/synthetic/lib/script.js";
import { txin } from "../../fixtures/synthetic/lib/tx.js";
import {
  chainFactsAt,
  epochOfSlot,
  inclusionAt,
  koiosAccountRow,
  koiosCacheFiles,
  koiosEpochParamsRow,
  koiosTotalsRow,
  koiosTxRow,
  koiosUtxoRow,
  unixTimeOfSlot,
} from "../../fixtures/synthetic/lib/writers.js";
import { alice, aliceAddr, bobAddr, h, scriptAddress, scriptStakeAddress, succeeds } from "./world.js";

type Json = Record<string, any>;

describe("synthetic provider-cache snapshot replays an on-chain transaction offline", () => {
  const slot = 150_000_000n;
  const net = "mainnet" as const;
  const at = inclusionAt(net, slot, "replay");

  // the chain at the inclusion slot
  const lockScript = succeeds(2);
  const rewardScript = succeeds(2);
  const datum = constr(0, [pInt(7)]);
  const locked = utxo({ ref: `${h("replay locked")}#0`, address: scriptAddress(scriptHash(lockScript)), coin: 12_000_000n, datumHash: datumHash(datum) });
  const refHolder = utxo({ ref: `${h("replay ref")}#1`, address: bobAddr, coin: 20_000_000n, scriptRef: rewardScript });
  const funds = utxo({ ref: `${h("replay funds")}#2`, address: aliceAddr, coin: 150_000_000n });
  const collateral = utxo({ ref: `${h("replay collateral")}#0`, address: aliceAddr, coin: 25_000_000n });
  const rewardAccount = rewardAddress(net, scriptCred(scriptHash(rewardScript)));
  const keyAccount = rewardAddress(net, keyCred(alice.stake));
  const dk = drepKey("replay-drep");
  const params = paramSet("pv10");

  const ctx: ChainContext = {
    network: net,
    params: params.protocolParameters,
    slot,
    utxos: [locked, refHolder, funds, collateral],
    accounts: [
      { bech32Address: rewardAccount.bech32, isRegistered: true, payedDeposit: 2_000_000, delegatedToDrep: null, delegatedToPool: null, balance: 0 },
      { bech32Address: keyAccount.bech32, isRegistered: true, payedDeposit: 2_000_000, delegatedToDrep: drepIdBech32(keyCred(dk)), delegatedToPool: null, balance: 0 },
    ],
  };
  const fitted = fit(
    {
      inputs: [locked.ref, funds.ref],
      referenceInputs: [refHolder.ref],
      outputs: [{ address: aliceAddr, value: { coin: "min" }, change: true }],
      collateral: [collateral.ref],
      withdrawals: [{ account: rewardAccount, amount: 0n }],
      datums: [datum],
      plutusScripts: [lockScript],
      requiredSigners: [alice.pay.keyHashHex],
      validityStart: slot - 500n,
      ttl: slot + 500n,
      redeemers: [
        { target: { tag: "spend", input: locked.ref }, data: UNIT, exUnits: { mem: 1n, steps: 1n } },
        { target: { tag: "reward", account: rewardAccount }, data: UNIT, exUnits: { mem: 1n, steps: 1n } },
      ],
    },
    { ctx, keys: [alice.pay] },
  );

  let stub: Stub;
  let t: TestContext;
  let saved: string | undefined;
  const cacheRoot = tempDir("cdm-synthetic-cache-");

  beforeAll(async () => {
    expect(fitted.validation.errors).toEqual([]);
    const facts = chainFactsAt(net, slot);
    const files = koiosCacheFiles({
      network: net,
      tx: koiosTxRow(fitted.tx, at),
      // the inputs and the collateral are spent by this very transaction: their rows say so (the server treats them as unspent at the inclusion point)
      utxos: ctx.utxos.map((u) => koiosUtxoRow({ ...u, isSpent: u !== refHolder }, facts)),
      epochParams: [{ epoch: at.epoch, row: koiosEpochParamsRow(params, at.epoch) }],
      totals: [{ epoch: at.epoch, row: koiosTotalsRow(at.epoch) }],
      accounts: [
        { key: rewardAccount.bech32, row: koiosAccountRow(rewardAccount.bech32, { deposit: 2_000_000n }) },
      ],
      committee: { proposal_id: "x", proposal_tx_hash: h("committee"), proposal_index: 0, quorum_numerator: 2, quorum_denominator: 3, members: [] },
      constitution: { anchorUrl: "ipfs://synthetic", anchorDataHash: h("constitution anchor"), guardrailScriptHash: null },
    });
    for (const [rel, text] of Object.entries(files)) {
      const target = path.join(cacheRoot, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    stub = await startStub((_req, res) => json(res, [], 404));
    saved = process.env.CARDANO_DEBUG_KOIOS_URL_MAINNET;
    process.env.CARDANO_DEBUG_KOIOS_URL_MAINNET = `${stub.url}/api/v1`;
    t = makeContext({ CARDANO_DEBUG_CACHE_DIR: cacheRoot });
  });

  afterAll(async () => {
    await t?.shutdown();
    if (saved === undefined) delete process.env.CARDANO_DEBUG_KOIOS_URL_MAINNET;
    else process.env.CARDANO_DEBUG_KOIOS_URL_MAINNET = saved;
    await stub?.close();
  });

  it("slot arithmetic matches the server's", () => {
    expect(epochOfSlot(net, 150_000_000)).toBe(at.epoch);
    expect(unixTimeOfSlot(net, 4_492_800)).toBe(1_596_059_091);
  });

  it("tx_load(tx_hash) rebuilds the context from the rows alone", async () => {
    const load = await txLoad(t.ctx, { tx_hash: fitted.tx.txHash, network: net });
    expect(load.isError, JSON.stringify(load.structuredContent)).toBeFalsy();
    const s = load.structuredContent as Json;
    expect(s.tx_id).toBe(`tx_mainnet_${fitted.tx.txHash.slice(0, 12)}`);
    expect(s.on_chain).toMatchObject({ slot: String(slot), epoch: at.epoch, is_valid: true });
    expect(s.missing_utxos).toEqual([]);
    expect(stub.requests, "every row must come from the cache").toEqual([]);
  });

  it("tx_validate: valid at the inclusion point, with the script results the fit computed", async () => {
    const result = await txValidate(t.ctx, { tx_id: `tx_mainnet_${fitted.tx.txHash.slice(0, 12)}` });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    const s = result.structuredContent as Json;
    expect(s.verdict, JSON.stringify(s).slice(0, 2000)).toBe("valid");
    expect(stub.requests).toEqual([]);
  });
});
