// S8: a marketplace-style purchase that spends one script input with a Plutus V2 script delivered by a REFERENCE input.
// Two inputs (index 0 key-owned, index 1 the listing at the `lock_spend` script address, so the redeemer is Spend 1 with data
// `Constr 1 []`), two outputs (output 1, the change, carries a CIP-68 style user token and most of the money), ttl + validity
// start, a metadata map, one reference input that holds the V2 script (that UTxO is not part of the transaction: the transaction
// only points at it), collateral with a return output and a total, one required signer, three vkey witnesses (buyer, collateral
// owner, signer) and one witness datum (the one the listing's datum hash commits to). Redeemers in the Conway map form.
//
// Besides the bytes, the scenario writes the provider rows (`lock-spend.provider-rows.json`) a Koios-like service would answer
// with for this transaction as an ON-CHAIN transaction (its tx row, the four UTxOs it consumes or references, the epoch's parameters
// and totals): test/helpers/koiosStub.ts serves them over HTTP.

import type { ChainContext } from "../lib/context.js";
import type { Scenario } from "../lib/toolkit.js";

export const scenario: Scenario = {
  name: "s08",
  description: "V2 reference-script spend `Constr 1 []` (Spend 1) with a witness datum, 3 vkeys, ttl + validity start, metadata; plus the Koios rows of it as an on-chain transaction.",
  build(tk) {
    const { address, keys, fit, context, writers, params, script, scripts, bytes, plutusData } = tk;
    const { constr, pBytes, pInt } = plutusData;
    const net = "mainnet" as const;

    const buyer = keys.paymentKey("s08-buyer");
    const buyerStake = keys.stakeKey("s08-buyer");
    const buyerAddr = address.baseAddress(net, address.keyCred(buyer), address.keyCred(buyerStake));
    const seller = keys.paymentKey("s08-seller");
    const sellerAddr = address.baseAddress(net, address.keyCred(seller), address.keyCred(keys.stakeKey("s08-seller")));
    const collateralOwner = keys.paymentKey("s08-collateral");
    const collateralAddr = address.enterpriseAddress(net, address.keyCred(collateralOwner));
    const signer = keys.paymentKey("s08-signer");
    const holderKey = keys.paymentKey("s08-holder");
    const holderAddr = address.enterpriseAddress(net, address.keyCred(holderKey));

    const lock = scripts.registryScript("lock_spend");
    const lockHash = scripts.registryHash("lock_spend");
    const lockAddr = address.enterpriseAddress(net, address.scriptCred(lockHash));

    // the listed token: a CIP-68 user token (label 222) of a one-signature policy
    const policy = script.scriptHash(script.native({ type: "sig", keyHash: keys.paymentKey("s08-policy").keyHashHex }));
    const assetName = `000de140${bytes.utf8Hex("SYNART01")}`;
    const price = 60_000_000n;
    const datum = constr(0, [pBytes(seller.keyHashHex), pInt(price), pBytes(policy), pBytes(assetName)]);

    // the listing must sort second among the inputs: Spend 1
    const [lowHash, highHash] = [writers.fakeHash("s08 buyer funds"), writers.fakeHash("s08 listing")].sort();
    const slot = 150_150_000n;
    const funds = context.utxo({ ref: `${lowHash}#1`, address: buyerAddr, coin: 700_000_000n });
    const listing = context.utxo({ ref: `${highHash}#0`, address: lockAddr, coin: 15_000_000n, assets: { [policy]: { [assetName]: 1n } }, datumHash: plutusData.datumHash(datum) });
    const collateral = context.utxo({ ref: `${writers.fakeHash("s08 collateral")}#2`, address: collateralAddr, coin: 8_000_000n });
    const holder = context.utxo({ ref: `${writers.fakeHash("s08 script holder")}#0`, address: holderAddr, coin: 20_000_000n, scriptRef: lock });
    const ctx: ChainContext = { network: net, params: params.protocolParameters("pv10"), slot, utxos: [listing, funds, collateral, holder] };

    const fitted = fit.fit(
      {
        inputs: [funds.ref, listing.ref],
        referenceInputs: [holder.ref],
        outputs: [
          { address: sellerAddr, value: { coin: price } },
          { address: buyerAddr, value: { coin: "min" }, change: true },
        ],
        collateral: [collateral.ref],
        requiredSigners: [signer.keyHashHex],
        datums: [datum],
        validityStart: slot - 1_000n,
        ttl: slot + 5_000n,
        aux: {
          metadata: [
            [674n, new Map([["msg", ["Synthetic listing", "purchase through a reference script", "script input spent with Constr 1", "datum supplied in the witness set"]]])],
            [1337n, new Map<string, string | bigint>([["market", "synthetic marketplace"], ["listing", 1n], ["currency", "ADA"], ["royalty", "none"], ["fee_bps", 200n], ["channel", "direct"], ["version", "1"]])],
          ],
        },
        redeemers: [{ target: { tag: "spend", input: listing.ref }, data: constr(1, []), exUnits: { mem: 1n, steps: 1n } }],
      },
      { ctx, keys: [buyer, collateralOwner, signer] },
    );
    const built = fitted.tx;
    const spend = built.redeemers[0]!;
    if (spend.tagNumber !== 0 || spend.index !== 1) throw new Error("s08: the redeemer is not Spend 1");
    const ref = (u: { ref: { txHash: string; index: number } }) => `${u.ref.txHash}#${u.ref.index}`;
    const coinOf = (i: number) => String(fitted.spec.outputs[i]!.value.coin);

    // the chain as a provider shows it after inclusion at `slot`
    const at = writers.inclusionAt(net, slot, "s08");
    const facts = writers.chainFactsAt(net, slot);
    const pp = params.paramSet("pv10");
    const rows = {
      network: net,
      tx: writers.koiosTxRow(built, at),
      // the inputs and the collateral are spent by this very transaction: the rows say so, as a provider would
      utxos: ctx.utxos.map((u) => writers.koiosUtxoRow({ ...u, isSpent: u !== holder }, facts)),
      epoch_params: writers.koiosEpochParamsRow(pp, at.epoch),
      totals: writers.koiosTotalsRow(at.epoch),
    };

    return {
      files: {
        "lock-spend.tx": writers.txText(built, true),
        "lock-spend.provider-rows.json": writers.jsonText(rows, 1),
      },
      manifest: {
        "s08.txHash": built.txHash,
        "s08.txId": writers.txHandle(net, built.txHash),
        "s08.size": built.size,
        "s08.fee": fitted.spec.fee!,
        "s08.network": net,
        "s08.slot": slot,
        "s08.epoch": at.epoch,
        "s08.blockHeight": at.blockHeight,
        "s08.blockHash": at.blockHash,
        "s08.validityStart": fitted.spec.validityStart!,
        "s08.ttl": fitted.spec.ttl!,
        "s08.inputs": built.inputs.map((i) => ({ txHash: i.txHash, index: i.index })),
        "s08.spendInput": ref(listing),
        "s08.referenceInput": ref(holder),
        "s08.referenceInputPrefix": holder.ref.txHash.slice(0, 8),
        "s08.collateralInput": ref(collateral),
        "s08.outputCount": 2,
        "s08.out0Coin": coinOf(0),
        "s08.out1Coin": coinOf(1),
        "s08.out1Asset": { policy, nameHex: assetName, quantity: "1" },
        "s08.vkeyCount": 3,
        "s08.datumCount": 1,
        "s08.metadataLabels": [674, 1337],
        "s08.redeemer": { ref: "spend:1", tag: "spend", index: spend.index, mem: spend.exUnits.mem, steps: spend.exUnits.steps, constructor: "1" },
        "s08.scriptHash": lockHash,
        "s08.scriptVersion": "V2",
        "s08.scriptSize": lock.bytes.length,
        "s08.scriptAddress": lockAddr.bech32,
        "s08.datumHash": plutusData.datumHash(datum),
        "s08.utxoCount": ctx.utxos.length,
        "s08.requiredSigner": signer.keyHashHex,
        "s08.providerRows": "lock-spend.provider-rows.json",
      },
    };
  },
};
