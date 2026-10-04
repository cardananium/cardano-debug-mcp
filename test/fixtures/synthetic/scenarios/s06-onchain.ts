// S6: one transaction "already on chain", as a provider-cache snapshot (Koios rows keyed per provider) the server replays at its
// inclusion point without a single request: tx_load(tx_hash) reads the tx row, the UTxO rows, the epoch parameters and totals of
// the inclusion epoch, the account / committee / constitution rows from the cache directory.
//
// The transaction is FULLY VALID at its inclusion slot under the real validator (protocol major 10): real signatures, fee >= minimum
// including the reference-script fee, balanced, collateral >= 150 %, a correct script data hash for the epoch's cost models, and
// the validity interval covers the slot. It runs two Plutus V2 spends and one zero-lovelace withdrawal from a script stake credential
// (a V2 reward validator); all three scripts are delivered by reference inputs, the datums are inline, one signer is required.
// At the current tip the same transaction is full of artefacts (its inputs are spent, its validity interval is over): that is
// what the replay exists to remove.
//
//   inputs         A  at the `lock_spend` script (inline datum, 3 assets)      spend, redeemer Unlock
//                  B  at the `tiny` script (inline datum, 1 asset)             spend
//                  K  a key input that is also the collateral
//   reference      R0 a datum holder (inline datum, 1 asset) and one UTxO per script: `lock_spend`, `tiny`, `reward_ok`
//   withdrawal     0 lovelace from the script stake address of `reward_ok`    reward, redeemer Allow

import type { ChainContext, Utxo } from "../lib/context.js";
import type { Scenario } from "../lib/toolkit.js";

export const CACHE_DIR = "onchain__synthetic_s06";

export const scenario: Scenario = {
  name: "s06",
  description: "An on-chain transaction (2 V2 spends + a zero withdrawal, scripts by reference inputs) as a Koios provider-cache snapshot; valid at its inclusion slot.",
  build(tk) {
    const { address, keys, fit, context, writers, params, scripts, script, plutusData, bytes } = tk;
    const { constr, pBytes, pInt, pList } = plutusData;
    const net = "mainnet" as const;

    // ---------------------------------------------------------------- identities and scripts
    const trader = keys.paymentKey("s06-trader");
    const traderStake = keys.stakeKey("s06-trader");
    const traderAddr = address.baseAddress(net, address.keyCred(trader), address.keyCred(traderStake));
    const holder = keys.paymentKey("s06-reference-holder");
    const holderAddr = address.baseAddress(net, address.keyCred(holder), address.keyCred(keys.stakeKey("s06-reference-holder")));

    const lockSpend = scripts.registryScript("lock_spend");
    const tiny = scripts.registryScript("tiny");
    const rewardOk = scripts.registryScript("reward_ok");
    const lockHash = scripts.registryHash("lock_spend");
    const tinyHash = scripts.registryHash("tiny");
    const rewardHash = scripts.registryHash("reward_ok");
    const lockAddr = address.baseAddress(net, address.scriptCred(lockHash), address.keyCred(traderStake));
    const tinyAddr = address.baseAddress(net, address.scriptCred(tinyHash), address.keyCred(traderStake));
    const rewardAccount = address.rewardAddress(net, address.scriptCred(rewardHash));

    // tokens of artificial native-script policies
    const policyOf = (name: string) => script.scriptHash(script.native({ type: "sig", keyHash: keys.paymentKey(name).keyHashHex }));
    const tokenA = policyOf("s06-token-a");
    const tokenB = policyOf("s06-token-b");
    const unitName = (text: string) => bytes.utf8Hex(text);
    const longName = writers.fakeHash("s06 long asset name"); // a 32-byte asset name

    // ---------------------------------------------------------------- the chain point
    const slot = 163_450_000n;
    const pp = params.protocolParameters("pv10");
    const inclusion = writers.inclusionAt(net, slot, "s06");
    const epoch = inclusion.epoch;
    const createdWith = (slotsBefore: number) => {
      const f = writers.chainFactsAt(net, slot, slotsBefore);
      return { epoch: f.epoch, blockHeight: f.blockHeight, blockTime: f.blockTime };
    };

    // ---------------------------------------------------------------- UTxOs
    const datumA = constr(0, [constr(0, [pBytes(trader.keyHashHex)]), pInt(25_000_000), pList([pInt(1), pInt(2), pInt(3)]), pBytes(unitName("order-a"))]);
    const datumA2 = constr(0, [constr(0, [pBytes(trader.keyHashHex)]), pInt(24_000_000), pList([pInt(1), pInt(2), pInt(3)]), pBytes(unitName("order-a"))]);
    const datumB = constr(0, [pInt(7), pBytes(unitName("order-b")), constr(1, [])]);
    const datumRef = constr(0, [pList([constr(0, [pBytes(holder.keyHashHex)])]), constr(0, [pBytes(trader.keyHashHex)]), pInt(3), pInt(997), pInt(1_000)]);

    const inputA = context.utxo({
      ref: `${writers.fakeHash("s06 input A (lock_spend)")}#3`,
      address: lockAddr,
      coin: 36_000_000n,
      assets: { [tokenA]: { [unitName("SYNTH")]: 325_000_000n, [unitName("LOCK")]: 1n, [longName]: 9_000_000_000n } },
      inlineDatum: datumA,
    });
    const inputK = context.utxo({ ref: `${writers.fakeHash("s06 input K (key, collateral)")}#4`, address: traderAddr, coin: 200_000_000n });
    const inputB = context.utxo({ ref: `${writers.fakeHash("s06 input B (tiny)")}#0`, address: tinyAddr, coin: 12_000_000n, assets: { [tokenB]: { [unitName("PAIR")]: 1n } }, inlineDatum: datumB });
    const minCoin = (u: { address: Utxo["address"]; scriptRef?: Utxo["scriptRef"]; inlineDatum?: Utxo["inlineDatum"]; value: Utxo["value"] }) =>
      fit.minUtxoCoin({ address: u.address, value: { coin: "min", assets: u.value.assets }, scriptRef: u.scriptRef, inlineDatum: u.inlineDatum }, pp);
    const refOf = (label: string, extra: { scriptRef?: Utxo["scriptRef"]; inlineDatum?: Utxo["inlineDatum"]; assets?: Utxo["value"]["assets"]; address?: Utxo["address"] }, index: number, slotsBefore: number): Utxo => {
      const base = { address: extra.address ?? holderAddr, value: { coin: 0n, assets: extra.assets ?? {} }, scriptRef: extra.scriptRef, inlineDatum: extra.inlineDatum };
      return { ...context.utxo({ ref: `${writers.fakeHash(`s06 reference ${label}`)}#${index}`, address: base.address, coin: minCoin(base) + 1_000_000n, assets: extra.assets, scriptRef: extra.scriptRef, inlineDatum: extra.inlineDatum }), ...createdWith(slotsBefore) };
    };
    const refDatum = refOf("datum holder", { inlineDatum: datumRef, assets: { [tokenB]: { [unitName("ORACLE")]: 1n } }, address: address.enterpriseAddress(net, address.scriptCred(tinyHash)) }, 0, 2_500_000);
    const refLock = refOf("lock_spend", { scriptRef: lockSpend }, 0, 3_100_000);
    const refTiny = refOf("tiny", { scriptRef: tiny }, 1, 3_100_000);
    const refReward = refOf("reward_ok", { scriptRef: rewardOk }, 2, 3_100_000);

    // fit and validate on a context at the inclusion slot with every UTxO still unspent (what the server rebuilds)
    const ctx: ChainContext = {
      network: net,
      params: pp,
      slot,
      utxos: [inputA, inputK, inputB, refDatum, refLock, refTiny, refReward],
      accounts: [context.accountContext({ cred: address.scriptCred(rewardHash), registered: true, deposit: 2_000_000, balance: 0 })],
      constitution: { guardrailScriptHash: scripts.registryHash("guardrails") },
      treasury: 1_620_000_000_000_000n,
    };

    const fitted = fit.fit(
      {
        inputs: [inputA.ref, inputK.ref, inputB.ref],
        referenceInputs: [refDatum.ref, refLock.ref, refTiny.ref, refReward.ref],
        outputs: [
          { address: lockAddr, value: { coin: "min", assets: inputA.value.assets }, inlineDatum: datumA2 },
          { address: traderAddr, value: { coin: "min", assets: inputB.value.assets } },
          { address: traderAddr, value: { coin: "min" }, change: true },
        ],
        withdrawals: [{ account: rewardAccount, amount: 0n }],
        collateral: [inputK.ref],
        requiredSigners: [trader.keyHashHex],
        validityStart: slot - 35n,
        ttl: slot + 145n,
        aux: { metadata: [[674n, new Map([["msg", ["Synthetic batch settlement", "cardano-debug-mcp fixture"]]])]] },
        redeemers: [
          { target: { tag: "spend", input: inputA.ref }, data: constr(1, []), exUnits: { mem: 1n, steps: 1n } },
          { target: { tag: "spend", input: inputB.ref }, data: constr(0, []), exUnits: { mem: 1n, steps: 1n } },
          { target: { tag: "reward", account: rewardAccount }, data: constr(0, []), exUnits: { mem: 1n, steps: 1n } },
        ],
      },
      { ctx, keys: [trader], exUnits: fit.slack(0.06, 0.09), collateral: { total: 5_000_000n }, expect: "valid" },
    );
    const built = fitted.tx;
    const v = fitted.validation;
    // fully valid: no phase-1 error or warning, no phase-2 error; the only diagnostics are the declared-above-calculated budget warnings
    const kinds = (list: unknown[]) => list.map((w) => Object.keys((w as { warning?: object }).warning ?? {})[0]);
    if (v.errors.length !== 0 || v.warnings.length !== 0 || v.phase2_errors.length !== 0 || v.eval_redeemer_results.length !== 3 || !v.eval_redeemer_results.every((r) => r.success)) {
      throw new Error(`s06: the transaction must be fully valid, got ${JSON.stringify({ e: v.errors, w: v.warnings, p2e: v.phase2_errors }).slice(0, 800)}`);
    }
    if (kinds(v.phase2_warnings).some((k) => k !== "BudgetIsBiggerThanExpected")) throw new Error(`s06: unexpected phase-2 warnings ${JSON.stringify(v.phase2_warnings)}`);

    // ---------------------------------------------------------------- the Koios rows
    const spent = new Set([inputA.ref, inputK.ref, inputB.ref].map((r) => `${r.txHash}#${r.index}`));
    const rowOf = (u: Utxo): Record<string, unknown> => {
      const isSpent = spent.has(`${u.ref.txHash}#${u.ref.index}`);
      const withFacts: Utxo = { ...u, isSpent, ...(isSpent ? createdWith(35) : {}) };
      const row = writers.koiosUtxoRow(withFacts, writers.chainFactsAt(net, slot, 35));
      // Koios reports the hash of an inline datum next to it
      if (u.inlineDatum !== undefined) row.datum_hash = plutusData.datumHash(u.inlineDatum);
      return row;
    };

    const committeeMembers = Array.from({ length: 7 }, (_, i) => {
      const cold = address.keyCred(keys.ccColdKey(`s06-member-${i + 1}`));
      const hot = address.keyCred(keys.ccHotKey(`s06-member-${i + 1}`));
      return {
        ccColdHex: Buffer.from(cold.hash).toString("hex"),
        ccHotHex: Buffer.from(hot.hash).toString("hex"),
        ccColdId: address.ccColdBech32(cold),
        ccHotId: address.ccHotBech32(hot),
        expirationEpoch: epoch + 140 + 17 * i,
      };
    });
    const committeeAction = writers.fakeHash("s06 committee election action");
    const files = writers.koiosCacheFiles({
      network: net,
      tx: writers.koiosTxRow(built, inclusion),
      utxos: ctx.utxos.map(rowOf),
      epochParams: [{ epoch, row: writers.koiosEpochParamsRow(params.paramSet("pv10"), epoch) }],
      accounts: [{ key: rewardAccount.bech32, row: writers.koiosAccountRow(rewardAccount.bech32, { registered: true, rewards: 0n, balance: 6_400_000n }) }],
      committee: writers.koiosCommitteeRow({ proposalTxHash: committeeAction, proposalId: address.govActionIdBech32(committeeAction, 0), quorum: [2, 3], members: committeeMembers }),
      constitution: { anchorUrl: "https://example.invalid/synthetic/constitution", anchorDataHash: writers.fakeHash("s06 constitution document"), guardrailScriptHash: scripts.registryHash("guardrails") },
      totals: [{ epoch, row: writers.koiosTotalsRow(epoch, { treasury: (ctx.treasury ?? 0n).toString() }) }],
    });

    const redeemerRefs = built.redeemers.map((r) => `${["spend", "mint", "publish", "withdraw", "vote", "propose"][r.tagNumber]}:${r.index}`);
    const exUnitsOf = (ref: string) => {
      const r = built.redeemers[redeemerRefs.indexOf(ref)]!;
      return { mem: r.exUnits.mem, steps: r.exUnits.steps };
    };
    const calculated = (tag: string, index: number) => {
      const c = v.eval_redeemer_results.find((e) => e.tag === tag && e.index === index)!.calculated_ex_units!;
      return { mem: String(c.mem), steps: String(c.steps) };
    };
    const ref = (u: Utxo) => `${u.ref.txHash}#${u.ref.index}`;
    const prefixed: Record<string, string> = {};
    for (const [file, text] of Object.entries(files)) prefixed[`${CACHE_DIR}/${file}`] = text;

    return {
      files: prefixed,
      manifest: {
        "s06.cacheDir": CACHE_DIR,
        "s06.txHash": built.txHash,
        "s06.txId": writers.txHandle(net, built.txHash),
        "s06.txRowFile": `${CACHE_DIR}/tx/${net}/koios/${built.txHash}.json`,
        "s06.size": built.size,
        "s06.network": net,
        "s06.fee": fitted.spec.fee!,
        "s06.slot": slot,
        "s06.epoch": epoch,
        "s06.blockHeight": inclusion.blockHeight,
        "s06.blockHash": inclusion.blockHash,
        "s06.timestamp": inclusion.timestamp,
        "s06.validContract": true,
        "s06.protocolMajor": Number(pp.protocolVersion[0]),
        "s06.validity": { start: slot - 35n, end: slot + 145n },
        "s06.treasury": ctx.treasury!,
        "s06.signerKeyHash": trader.keyHashHex,
        "s06.vkeyCount": 1,
        // inputs / references (utxo rows of the snapshot: 7)
        "s06.inputs": [ref(inputA), ref(inputK), ref(inputB)],
        "s06.referenceInputs": [ref(refDatum), ref(refLock), ref(refTiny), ref(refReward)],
        "s06.utxoCount": ctx.utxos.length,
        "s06.collateral": { input: ref(inputK), total: fitted.spec.totalCollateral! },
        "s06.cacheFileCount": Object.keys(files).length,
        // scripts: delivered by reference inputs (none in the witness set)
        "s06.scripts": {
          spend: { hash: lockHash, plutusVersion: "V2", size: script.scriptSize(lockSpend), referenceInput: ref(refLock) },
          spend2: { hash: tinyHash, plutusVersion: "V2", size: script.scriptSize(tiny), referenceInput: ref(refTiny) },
          reward: { hash: rewardHash, plutusVersion: "V2", size: script.scriptSize(rewardOk), referenceInput: ref(refReward) },
        },
        "s06.rewardAccount": rewardAccount.bech32,
        "s06.redeemerRefs": redeemerRefs,
        // the redeemer the tests name: the zero withdrawal
        "s06.withdrawRef": "withdraw:0",
        "s06.withdrawExUnits": exUnitsOf("withdraw:0"),
        "s06.withdrawCalculated": calculated("Reward", 0),
        "s06.spendRefs": redeemerRefs.filter((r) => r.startsWith("spend:")),
        "s06.exUnits": Object.fromEntries(redeemerRefs.map((r) => [r, exUnitsOf(r)])),
        "s06.cachedEpochParamsFile": `epoch_params/${net}/koios/${epoch}.json`,
      },
    };
  },
};
