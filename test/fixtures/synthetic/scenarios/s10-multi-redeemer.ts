// S10: four redeemers in the Conway map form, one per purpose that matters: Spend 0, Spend 1, Mint 0, Reward 0.
// Three inputs (the two script inputs sort first, so they are indices 0 and 1), four outputs (one with a datum hash, one with an
// inline datum), a zero withdrawal from a script stake address, a burn of one token (mint -1), collateral with a return output,
// one required signer, four reference inputs (one per script, all Plutus V2), one vkey witness and two witness datums.
// Valid under the real validator, so it is also valid as a Conway `transaction` in the CDDL sense.

import type { ChainContext } from "../lib/context.js";
import type { Scenario } from "../lib/toolkit.js";

export const scenario: Scenario = {
  name: "s10",
  description: "Map-form redeemers with four entries (Spend 0, Spend 1, Mint 0, Reward 0): a zero script withdrawal, a burn, two witness datums, four reference inputs.",
  build(tk) {
    const { address, keys, fit, context, writers, params, scripts, bytes, plutusData } = tk;
    const { constr, pBytes, pInt } = plutusData;
    const net = "mainnet" as const;

    const owner = keys.paymentKey("s10-owner");
    const ownerStake = keys.stakeKey("s10-owner");
    const ownerAddr = address.baseAddress(net, address.keyCred(owner), address.keyCred(ownerStake));
    const holder = keys.paymentKey("s10-holder");
    const holderAddr = address.baseAddress(net, address.keyCred(holder), address.keyCred(keys.stakeKey("s10-holder")));
    const payee = keys.paymentKey("s10-payee");
    const payeeAddr = address.enterpriseAddress(net, address.keyCred(payee));

    const lock = scripts.registryScript("lock_spend");
    const tiny = scripts.registryScript("tiny");
    const burn = scripts.registryScript("burn_mint");
    const rewardOk = scripts.registryScript("reward_ok");
    const lockHash = scripts.registryHash("lock_spend");
    const tinyHash = scripts.registryHash("tiny");
    const burnHash = scripts.registryHash("burn_mint");
    const rewardHash = scripts.registryHash("reward_ok");
    const lockAddr = address.enterpriseAddress(net, address.scriptCred(lockHash));
    const tinyAddr = address.enterpriseAddress(net, address.scriptCred(tinyHash));
    const rewardAccount = address.rewardAddress(net, address.scriptCred(rewardHash));

    const tokenName = bytes.utf8Hex("SYNBURN");
    const datumA = constr(0, [pBytes(bytes.utf8Hex("reserve A")), pInt(1_000)]);
    const datumB = constr(0, [pBytes(bytes.utf8Hex("reserve B")), pInt(2_000)]);
    const datumHashOut = constr(0, [pBytes(bytes.utf8Hex("hashed state")), pInt(3)]);
    const datumInline = constr(0, [pBytes(bytes.utf8Hex("inline state")), pInt(4), pInt(5)]);

    // the two script inputs must sort before the key input, whatever the labels hash to
    const [refA, refB, refFunds] = [writers.fakeHash("s10 input one"), writers.fakeHash("s10 input two"), writers.fakeHash("s10 input three")].sort();
    const slot = 150_600_000n;
    const lockInput = context.utxo({ ref: `${refA}#0`, address: lockAddr, coin: 8_000_000n, datumHash: plutusData.datumHash(datumA) });
    const tinyInput = context.utxo({ ref: `${refB}#2`, address: tinyAddr, coin: 9_000_000n, datumHash: plutusData.datumHash(datumB) });
    const funds = context.utxo({ ref: `${refFunds}#1`, address: ownerAddr, coin: 140_000_000n, assets: { [burnHash]: { [tokenName]: 5n } } });
    const collateral = context.utxo({ ref: `${writers.fakeHash("s10 collateral")}#0`, address: ownerAddr, coin: 30_000_000n });
    const holders = [
      context.utxo({ ref: `${writers.fakeHash("s10 holder lock")}#0`, address: holderAddr, coin: 30_000_000n, scriptRef: lock }),
      context.utxo({ ref: `${writers.fakeHash("s10 holder tiny")}#0`, address: holderAddr, coin: 5_000_000n, scriptRef: tiny }),
      context.utxo({ ref: `${writers.fakeHash("s10 holder burn")}#1`, address: holderAddr, coin: 12_000_000n, scriptRef: burn }),
      context.utxo({ ref: `${writers.fakeHash("s10 holder reward")}#0`, address: holderAddr, coin: 5_000_000n, scriptRef: rewardOk }),
    ];
    const ctx: ChainContext = {
      network: net,
      params: params.protocolParameters("pv10"),
      slot,
      utxos: [lockInput, tinyInput, funds, collateral, ...holders],
      accounts: [{ bech32Address: rewardAccount.bech32, isRegistered: true, payedDeposit: 2_000_000, delegatedToDrep: null, delegatedToPool: null, balance: 0 }],
    };

    const fitted = fit.fit(
      {
        inputs: [funds.ref, lockInput.ref, tinyInput.ref],
        referenceInputs: holders.map((h) => h.ref),
        outputs: [
          { address: tinyAddr, value: { coin: "min" }, datumHash: plutusData.datumHash(datumHashOut) },
          { address: lockAddr, value: { coin: "min" }, inlineDatum: datumInline },
          { address: payeeAddr, value: { coin: 15_000_000n } },
          { address: ownerAddr, value: { coin: "min" }, change: true },
        ],
        mint: [{ policy: burnHash, assets: { [tokenName]: -1n } }],
        withdrawals: [{ account: rewardAccount, amount: 0n }],
        collateral: [collateral.ref],
        requiredSigners: [owner.keyHashHex],
        datums: [datumA, datumB],
        redeemers: [
          { target: { tag: "spend", input: lockInput.ref }, data: constr(1, []), exUnits: { mem: 1n, steps: 1n } },
          { target: { tag: "spend", input: tinyInput.ref }, data: constr(0, []), exUnits: { mem: 1n, steps: 1n } },
          { target: { tag: "mint", policy: burnHash }, data: constr(1, []), exUnits: { mem: 1n, steps: 1n } },
          { target: { tag: "reward", account: rewardAccount }, data: constr(0, []), exUnits: { mem: 1n, steps: 1n } },
        ],
      },
      { ctx, keys: [owner] },
    );
    const built = fitted.tx;
    if (built.redeemers.map((r) => `${r.tagNumber}:${r.index}`).join(",") !== "0:0,0:1,1:0,3:0") throw new Error("s10: the redeemers are not Spend 0, Spend 1, Mint 0, Reward 0");
    const redeemerRow = (i: number) => {
      const r = built.redeemers[i]!;
      return { tag: ["spend", "mint", "cert", "reward", "vote", "propose"][r.tagNumber], index: r.index, mem: r.exUnits.mem, steps: r.exUnits.steps };
    };
    const redeemersSpan = built.spans["witness.5"]!;

    return {
      files: { "multi-redeemer.tx": writers.txText(built, true) },
      manifest: {
        "s10.txHash": built.txHash,
        "s10.txId": writers.txHandle(net, built.txHash),
        "s10.size": built.size,
        "s10.fee": fitted.spec.fee!,
        "s10.network": net,
        "s10.slot": slot,
        "s10.inputs": built.inputs.map((i) => ({ txHash: i.txHash, index: i.index })),
        "s10.referenceInputs": holders.map((h) => `${h.ref.txHash}#${h.ref.index}`),
        "s10.outputCount": 4,
        "s10.vkeyCount": 1,
        "s10.datumCount": 2,
        "s10.redeemerCount": 4,
        "s10.redeemers": [0, 1, 2, 3].map(redeemerRow),
        "s10.redeemersSpan": redeemersSpan,
        "s10.scriptHashes": { lock: lockHash, tiny: tinyHash, burn: burnHash, reward: rewardHash },
        "s10.rewardAccount": rewardAccount.bech32,
        "s10.mintPolicy": burnHash,
        "s10.mintQuantity": "-1",
      },
    };
  },
};
