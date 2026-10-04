// S11: a datum-hash lock (the shape of an order placed at a script address): one input, output 0 to a script address with a datum
// hash, a change output that carries one native asset, aux metadata (label 674), one witness datum (the datum the hash commits
// to, supplied alongside), one vkey witness, no redeemers, no collateral. Valid under the real validator.
//
// It also owns the small set of identifiers the unit tests of the data views need as "an address, a script hash, a datum hash,
// an asset unit, a Byron address": all artificial, all in the manifest (`s11.scriptAddress`, `s11.makerAddress`, ...).

import type { ChainContext } from "../lib/context.js";
import type { Scenario } from "../lib/toolkit.js";

export const scenario: Scenario = {
  name: "s11",
  description: "Datum-hash lock at an order script address: output 0 with a datum hash, change with one asset, one witness datum, one vkey.",
  build(tk) {
    const { address, keys, fit, context, writers, params, script, scripts, bytes, plutusData } = tk;
    const { constr, pBytes, pInt } = plutusData;
    const net = "mainnet" as const;

    const maker = keys.paymentKey("s11-maker");
    const makerStake = keys.stakeKey("s11-maker");
    const makerAddr = address.baseAddress(net, address.keyCred(maker), address.keyCred(makerStake));
    const makerReward = address.rewardAddress(net, address.keyCred(makerStake));

    // the order script address: the artificial order book validator (V2), an enterprise script address
    const orderHash = scripts.registryHash("order_fixed");
    const orderAddr = address.enterpriseAddress(net, address.scriptCred(orderHash));

    // the asset the maker holds: a one-signature native policy, a stable-coin-like name
    const issuer = keys.paymentKey("s11-issuer");
    const policy = script.scriptHash(script.native({ type: "sig", keyHash: issuer.keyHashHex }));
    const assetName = bytes.utf8Hex("SYNUSD");
    const unit = `${policy}${assetName}`;

    // the order datum (the shape order_fixed reads): maker address, sold policy + asset, unit price, quantity, expiry (POSIX ms), memo
    const datum = constr(0, [
      constr(0, [constr(0, [pBytes(maker.keyHashHex)]), constr(0, [constr(0, [constr(0, [pBytes(makerStake.keyHashHex)])])])]),
      pBytes(policy),
      pBytes(assetName),
      pInt(2_500_000),
      pInt(40_000),
      pInt(1_900_000_000_000),
      pBytes(bytes.utf8Hex("synthetic order")),
    ]);
    const datumHash = plutusData.datumHash(datum);

    const slot = 150_300_000n;
    const funds = context.utxo({ ref: `${writers.fakeHash("s11 maker funds")}#1`, address: makerAddr, coin: 90_000_000n, assets: { [policy]: { [assetName]: 100_000n } } });
    const ctx: ChainContext = { network: net, params: params.protocolParameters("pv10"), slot, utxos: [funds] };

    const fitted = fit.fit(
      {
        inputs: [funds.ref],
        outputs: [
          { address: orderAddr, value: { coin: 12_000_000n }, datumHash },
          { address: makerAddr, value: { coin: "min" }, change: true },
        ],
        datums: [datum],
        ttl: slot + 7_200n,
        aux: { metadata: [[674n, new Map([["msg", ["Synthetic order", "datum-hash lock"]]])]] },
      },
      { ctx, keys: [maker] },
    );
    const built = fitted.tx;
    const coinOf = (i: number) => String(fitted.spec.outputs[i]!.value.coin);

    return {
      files: { "datum-lock.tx": writers.txText(built, true) },
      manifest: {
        "s11.txHash": built.txHash,
        "s11.txId": writers.txHandle(net, built.txHash),
        "s11.size": built.size,
        "s11.fee": fitted.spec.fee!,
        "s11.network": net,
        "s11.slot": slot,
        "s11.ttl": fitted.spec.ttl!,
        "s11.inputs": [{ txHash: funds.ref.txHash, index: funds.ref.index }],
        "s11.outputCount": 2,
        "s11.vkeyCount": 1,
        "s11.datumCount": 1,
        "s11.hasRedeemers": false,
        "s11.hasCollateral": false,
        "s11.metadataLabel": 674,
        // the identifiers the data-view tests reuse
        "s11.scriptAddress": orderAddr.bech32,
        "s11.scriptAddressHex": orderAddr.hex,
        "s11.scriptHash": orderHash,
        "s11.makerAddress": makerAddr.bech32,
        "s11.makerAddressHex": makerAddr.hex,
        "s11.makerPaymentKeyHash": maker.keyHashHex,
        "s11.makerStakeKeyHash": makerStake.keyHashHex,
        "s11.makerStakeAddress": makerReward.bech32,
        "s11.datumHash": datumHash,
        "s11.datumHex": plutusData.encodePlutusDataHex(datum),
        "s11.policyId": policy,
        "s11.assetNameHex": assetName,
        "s11.assetName": "SYNUSD",
        "s11.unit": unit,
        "s11.lockCoin": coinOf(0),
        "s11.changeCoin": coinOf(1),
        "s11.byronAddress": address.byronAddress("s11 legacy wallet").text,
      },
    };
  },
};
