// The artificial scripts inside full transactions: built with the synthetic toolkit, fitted and run by the real validator
// (cquisitor-lib wasm, in-process), so the ScriptContext is the one the ledger encodes, not a hand-built one. One
// transaction per behaviour the scenario groups rely on; the numbers asserted are only success / failure, the logs and
// the error family, never an ex-unit figure.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ChainContext } from "../../fixtures/synthetic/lib/context.js";
import type { TxSpec } from "../../fixtures/synthetic/lib/tx.js";
import { toolkit as tk } from "../../fixtures/synthetic/lib/toolkit.js";
import { array, uint } from "../../fixtures/synthetic/lib/cbor.js";
import { SYNTHETIC_DIR } from "../../fixtures/synthetic/compile.js";

const { address, keys, fit, context, params, writers, plutusData, scripts } = tk;
const { constr, pBytes, pInt, pList, pMap } = plutusData;

const net = "mainnet" as const;
const pp = params.protocolParameters("pv10");
const registry = JSON.parse(readFileSync(path.join(SYNTHETIC_DIR, "scripts.json"), "utf8")) as { scripts: Record<string, { params: Array<{ name: string; value: unknown }> }> };

const alice = keys.paymentKey("validator-alice");
const aliceStake = keys.stakeKey("validator-alice");
const aliceAddr = address.baseAddress(net, address.keyCred(alice), address.keyCred(aliceStake));
const operator = keys.paymentKey("script-operator");
const maker = keys.paymentKey("script-maker");
const enterprise = (hash: string) => address.enterpriseAddress(net, address.scriptCred(hash));
const change = { address: aliceAddr, value: { coin: "min" as const }, change: true };
const exUnits = { mem: 1n, steps: 1n };

const utxo = (label: string, coin: bigint, index = 0, extra: Partial<Parameters<typeof context.utxo>[0]> = {}) =>
  context.utxo({ ref: `${writers.fakeHash(`scripts validator ${label}`)}#${index}`, address: aliceAddr, coin, ...extra });
const funding = utxo("funding", 1_000_000_000n);
const collateral = utxo("collateral", 20_000_000n, 1);
const chain = (utxos: ReturnType<typeof utxo>[], more: Partial<ChainContext> = {}): ChainContext => ({ network: net, params: pp, slot: 150_000_000n, utxos: [funding, collateral, ...utxos], ...more });

interface Outcome {
  /** phase-1 errors */
  errors: string[];
  /** one entry per redeemer, in ledger order */
  results: Array<{ tag: string; success: boolean; logs: string[]; error: string }>;
  size: number;
}

function run(spec: TxSpec, ctx: ChainContext): Outcome {
  const fitted = fit.fit(spec, { ctx, keys: [alice, operator, maker], expect: "any" });
  return {
    errors: fitted.validation.errors.map((e) => Object.keys(e.error)[0]!),
    results: fitted.validation.eval_redeemer_results.map((r) => ({ tag: r.tag, success: r.success, logs: r.logs, error: String(r.error ?? "") })),
    size: fitted.tx.size,
  };
}

const spendSpec = (input: ReturnType<typeof utxo>, scriptName: string, redeemer: ReturnType<typeof constr>, over: Partial<TxSpec> = {}): TxSpec => ({
  inputs: [funding.ref, input.ref],
  collateral: [collateral.ref],
  outputs: [change],
  plutusScripts: [scripts.registryScript(scriptName)],
  redeemers: [{ target: { tag: "spend", input: input.ref }, data: redeemer, exUnits }],
  ...over,
});

describe("V2 order book through the real validator", () => {
  const sellPolicy = "bb".repeat(28);
  const sellAsset = "4f524445";
  for (const name of ["order_spend", "order_fixed"]) {
    describe(name, () => {
      const hash = scripts.registryHash(name);
      const datum = (quantity: number, unitPrice = 400_000_000) =>
        constr(0, [constr(0, [constr(0, [pBytes(maker.keyHashHex)]), constr(1, [])]), pBytes(sellPolicy), pBytes(sellAsset), pInt(unitPrice), pInt(quantity), pInt(2_000_000_000_000), pBytes("6d656d6f")]);
      const order = utxo(`${name} order`, 5_000_000n, 0, { address: enterprise(hash), assets: { [sellPolicy]: { [sellAsset]: 1n } }, inlineDatum: datum(1) });
      const listDatum = utxo(`${name} list datum`, 5_000_000n, 0, { address: enterprise(hash), inlineDatum: pList([pInt(1)]) });
      const ctx = chain([order, listDatum]);

      it("Cancel passes with the operator as required signer and fails without a signer", () => {
        const ok = run(spendSpec(order, name, constr(0, []), { requiredSigners: [operator.keyHashHex] }), ctx);
        expect(ok.errors).toEqual([]);
        expect(ok.results).toMatchObject([{ tag: "Spend", success: true }]);
        const refused = run(spendSpec(order, name, constr(0, [])), ctx);
        expect(refused.results).toMatchObject([{ tag: "Spend", success: false }]);
      });

      it("Fill passes when the maker and the operator are paid, with a validity range that ends before expires_at", () => {
        // 1 unit at 400 ada: 400 ada, 30 bps fee = 1.2 ada (an output of its own, so it must be a valid output)
        const outputs = [
          { address: address.enterpriseAddress(net, address.keyCred(maker)), value: { coin: 398_800_000n } },
          { address: address.enterpriseAddress(net, address.keyCred(operator)), value: { coin: 1_200_000n } },
          { address: aliceAddr, value: { coin: "min" as const, assets: { [sellPolicy]: { [sellAsset]: 1n } } } },
          change,
        ];
        const ok = run(spendSpec(order, name, constr(1, [pInt(1), pInt(0)]), { outputs, ttl: 150_000_600n }), ctx);
        expect(ok.errors).toEqual([]);
        expect(ok.results).toMatchObject([{ tag: "Spend", success: true }]);
        const noBound = run(spendSpec(order, name, constr(1, [pInt(1), pInt(0)]), { outputs }), ctx);
        expect(noBound.results).toMatchObject([{ tag: "Spend", success: false }]);
      });

      it("a list datum fails with a builtin failure on unConstrData (a MachineError of the spend redeemer only)", () => {
        const failed = run(spendSpec(listDatum, name, constr(0, []), { requiredSigners: [operator.keyHashHex] }), ctx);
        expect(failed.results).toHaveLength(1);
        expect(failed.results[0]).toMatchObject({ tag: "Spend", success: false });
        expect(failed.results[0]!.error).toMatch(/failed to deserialise PlutusData using UnConstrData/);
      });
    });
  }
});

describe("the small V2 scripts through the real validator", () => {
  it("burn_mint Burn passes", () => {
    const policy = scripts.registryHash("burn_mint");
    const holding = utxo("burn holding", 5_000_000n, 0, { assets: { [policy]: { "4d454c44": 15_000_000_000_000n } } });
    const outcome = run(
      {
        inputs: [funding.ref, holding.ref],
        collateral: [collateral.ref],
        outputs: [change],
        mint: [{ policy, assets: { "4d454c44": -15_000_000_000_000n } }],
        plutusScripts: [scripts.registryScript("burn_mint")],
        redeemers: [{ target: { tag: "mint", policy }, data: constr(1, []), exUnits }],
      },
      chain([holding]),
    );
    expect(outcome.errors).toEqual([]);
    expect(outcome.results).toMatchObject([{ tag: "Mint", success: true }]);
  });

  it("reward_ok: a zero withdrawal with Constr 0 passes, Constr 1 fails with its trace", () => {
    const account = address.rewardAddress(net, address.scriptCred(scripts.registryHash("reward_ok")));
    const ctx = chain([], { accounts: [{ bech32Address: account.bech32, isRegistered: true, payedDeposit: 2_000_000, balance: 0 }] });
    const withdraw = (data: ReturnType<typeof constr>): TxSpec => ({
      inputs: [funding.ref],
      collateral: [collateral.ref],
      outputs: [change],
      withdrawals: [{ account, amount: 0n }],
      plutusScripts: [scripts.registryScript("reward_ok")],
      redeemers: [{ target: { tag: "reward", account }, data, exUnits }],
    });
    const ok = run(withdraw(constr(0, [])), ctx);
    expect(ok.errors).toEqual([]);
    expect(ok.results).toMatchObject([{ tag: "Reward", success: true }]);
    expect(run(withdraw(constr(1, [])), ctx).results).toMatchObject([{ tag: "Reward", success: false, logs: ["reward_ok: denied"] }]);
  });

  it("lock_spend: Unlock passes and logs, Refund fails with its trace; tiny passes; a V1 script cannot see an inline datum", () => {
    const lock = utxo("lock", 5_000_000n, 2, { address: enterprise(scripts.registryHash("lock_spend")), inlineDatum: constr(0, []) });
    const tiny = utxo("tiny", 5_000_000n, 0, { address: enterprise(scripts.registryHash("tiny")), inlineDatum: constr(0, []) });
    const v1 = utxo("v1", 5_000_000n, 0, { address: enterprise(scripts.registryHash("v1_dummy")), datumHash: plutusData.datumHash(constr(0, [])) });
    const ctx = chain([lock, tiny, v1]);
    const unlock = run(spendSpec(lock, "lock_spend", constr(1, [])), ctx);
    expect(unlock.errors).toEqual([]);
    expect(unlock.results).toMatchObject([{ success: true, logs: ["lock_spend: unlocking"] }]);
    expect(run(spendSpec(lock, "lock_spend", constr(0, [])), ctx).results).toMatchObject([{ success: false, logs: ["lock_spend: refund is disabled"] }]);
    const tinyRun = run(spendSpec(tiny, "tiny", constr(0, [])), ctx);
    expect(tinyRun.errors).toEqual([]);
    expect(tinyRun.results).toMatchObject([{ success: true }]);
    const v1Run = run(spendSpec(v1, "v1_dummy", constr(0, []), { datums: [constr(0, [])] }), ctx);
    expect(v1Run.errors).toEqual([]);
    expect(v1Run.results).toMatchObject([{ success: true }]);
  });
});

describe("the V3 scripts through the real validator", () => {
  it("pool_mint_a and pool_mint_b mint a CIP-68 pair and a one-shot NFT in one transaction", () => {
    const hashA = scripts.registryHash("pool_mint_a");
    const hashB = scripts.registryHash("pool_mint_b");
    const holder = scripts.registryHash("spend_v3");
    const seed = registry.scripts.pool_mint_b!.params[0]!.value as { transactionId: string; outputIndex: number };
    const seedUtxo = context.utxo({ ref: `${seed.transactionId}#${seed.outputIndex}`, address: aliceAddr, coin: 30_000_000n });
    const suffix = "506f6f6c";
    const refName = `000643b0${suffix}`;
    const userName = `000de140${suffix}`;
    const metadata = constr(0, [pMap([[pBytes("6e616d65"), pBytes("506f6f6c")], [pBytes("696d616765"), pBytes("697066733a2f2f78")]]), pInt(1), pInt(0)]);
    const mintSpec: TxSpec = {
      inputs: [funding.ref, seedUtxo.ref],
      collateral: [collateral.ref],
      requiredSigners: [operator.keyHashHex],
      mint: [
        { policy: hashA, assets: { [refName]: 1n, [userName]: 1n } },
        { policy: hashB, assets: { "4e4654": 1n } },
      ],
      outputs: [
        { address: enterprise(holder), value: { coin: "min", assets: { [hashA]: { [refName]: 1n } } }, inlineDatum: metadata },
        { address: aliceAddr, value: { coin: "min", assets: { [hashA]: { [userName]: 1n }, [hashB]: { "4e4654": 1n } } } },
        change,
      ],
      plutusScripts: [scripts.registryScript("pool_mint_a"), scripts.registryScript("pool_mint_b")],
      redeemers: [
        { target: { tag: "mint", policy: hashA }, data: constr(0, [pBytes(suffix), pInt(0)]), exUnits },
        { target: { tag: "mint", policy: hashB }, data: constr(0, [pBytes("4e4654")]), exUnits },
      ],
    };
    const ctx = chain([seedUtxo]);
    const ok = run(mintSpec, ctx);
    expect(ok.errors).toEqual([]);
    expect(ok.results.map((r) => [r.tag, r.success])).toEqual([["Mint", true], ["Mint", true]]);
    // the two policies are told apart: no owner signature breaks the CIP-68 pair only, no seed breaks the NFT only
    const unsigned = run({ ...mintSpec, requiredSigners: [] }, ctx);
    expect(unsigned.results.map((r) => r.success).sort()).toEqual([false, true]);
    const noSeed = run({ ...mintSpec, inputs: [funding.ref] }, ctx);
    expect(noSeed.results.map((r) => r.success).sort()).toEqual([false, true]);
  });

  it("spend_v3: Withdraw by the owner after unlock_after passes", () => {
    const vault = constr(0, [pBytes(operator.keyHashHex), pInt(1_000)]);
    const input = utxo("vault", 5_000_000n, 0, { address: enterprise(scripts.registryHash("spend_v3")), inlineDatum: vault });
    const outcome = run(spendSpec(input, "spend_v3", constr(0, []), { requiredSigners: [operator.keyHashHex], validityStart: 100_000_000n }), chain([input]));
    expect(outcome.errors).toEqual([]);
    expect(outcome.results).toMatchObject([{ tag: "Spend", success: true }]);
  });

  describe("guardrails (propose handler)", () => {
    const guardHash = scripts.registryHash("guardrails");
    const rewardAccount = address.rewardAddress(net, address.keyCred(alice));
    // a governance action costs a deposit of 100,000 ada
    const deposit = utxo("proposal deposit funding", 150_000_000_000n, 2);
    const ctx = chain([deposit], {
      accounts: [{ bech32Address: rewardAccount.bech32, isRegistered: true, payedDeposit: 2_000_000, balance: 0 }],
      constitution: { guardrailScriptHash: guardHash },
    });
    const propose = (update: Array<[number, ReturnType<typeof uint> | ReturnType<typeof array>]>, redeemer: ReturnType<typeof pMap> | ReturnType<typeof constr> = pMap([])): TxSpec => ({
      inputs: [deposit.ref],
      collateral: [collateral.ref],
      outputs: [change],
      proposals: [
        {
          deposit: 100_000_000_000n,
          rewardAccount,
          action: { type: "parameterChange", update, policyHash: guardHash },
          anchor: { url: "https://example.invalid/proposal", hash: writers.fakeHash("scripts validator proposal anchor") },
        },
      ],
      plutusScripts: [scripts.registryScript("guardrails")],
      redeemers: [{ target: { tag: "propose", index: 0 }, data: redeemer, exUnits }],
    });

    it("a ParameterChange inside the bounds passes with the redeemer `Map []`", () => {
      const ok = run(propose([[3, uint(16_384)], [17, uint(4_310)], [20, array([uint(14_000_000), uint(10_000_000_000)])]]), ctx);
      expect(ok.errors).toEqual([]);
      expect(ok.results).toMatchObject([{ tag: "Propose", success: true }]);
    });

    it("one parameter outside its bound, or a redeemer that is not a map, fails the script", () => {
      expect(run(propose([[23, uint(500)]]), ctx).results).toMatchObject([{ tag: "Propose", success: false }]);
      const notAMap = run(propose([[3, uint(16_384)]], constr(0, [])), ctx);
      expect(notAMap.results).toMatchObject([{ tag: "Propose", success: false }]);
      expect(notAMap.results[0]!.error).toMatch(/UnMapData/);
    });
  });
});
