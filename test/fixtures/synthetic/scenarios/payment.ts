// payment: a plain signed ADA payment with one native asset riding along, valid under the real validator.
// It proves the toolkit end to end (builder -> fit -> validator -> every writer) and is the template a scenario starts from.

import type { ChainContext } from "../lib/context.js";
import type { Scenario } from "../lib/toolkit.js";

export const scenario: Scenario = {
  name: "payment",
  description: "A plain signed payment of ADA + one native asset (fully valid): the toolkit's end-to-end proof and the starting template for scenarios.",
  build(tk) {
    const { address, keys, fit, context, writers, params, script, bytes } = tk;
    const net = "mainnet" as const;

    // identities (named, so every hash below is reproducible)
    const sender = keys.paymentKey("payment-sender");
    const senderStake = keys.stakeKey("payment-sender");
    const recipient = keys.paymentKey("payment-recipient");
    const recipientStake = keys.stakeKey("payment-recipient");
    const senderAddr = address.baseAddress(net, address.keyCred(sender), address.keyCred(senderStake));
    const recipientAddr = address.baseAddress(net, address.keyCred(recipient), address.keyCred(recipientStake));

    // an asset of a native-script policy that already sits in the sender's UTxO
    const policy = script.scriptHash(script.native({ type: "sig", keyHash: keys.paymentKey("payment-policy").keyHashHex }));
    const assetName = bytes.utf8Hex("SYNTHETIC");

    const pp = params.protocolParameters("pv10");
    const funding = context.utxo({ ref: `${writers.fakeHash("payment funding utxo")}#0`, address: senderAddr, coin: 120_000_000n, assets: { [policy]: { [assetName]: 25n } } });
    const spare = context.utxo({ ref: `${writers.fakeHash("payment spare utxo")}#3`, address: senderAddr, coin: 8_000_000n });
    const ctx: ChainContext = { network: net, params: pp, slot: 150_000_000n, utxos: [funding, spare] };

    const fitted = fit.fit(
      {
        inputs: [funding.ref],
        outputs: [
          { address: recipientAddr, value: { coin: "min", assets: { [policy]: { [assetName]: 10n } } } },
          { address: senderAddr, value: { coin: "min" }, change: true },
        ],
        ttl: ctx.slot + 7_200n,
        aux: { metadata: [[674n, new Map([["msg", ["Synthetic payment", "cardano-debug-mcp fixture"]]])]] },
        encoding: { sets: { inputs: true, vkeys: true } },
      },
      { ctx, keys: [sender] },
    );
    const built = fitted.tx;
    const coinOf = (i: number) => String(fitted.spec.outputs[i]!.value.coin);

    return {
      files: {
        "payment.tx": writers.txText(built, true),
        "payment.debugger-context.json": writers.debuggerContextFile({ tx: built, ctx }),
        "payment.bundle.json": writers.bundleFile({ tx: built, ctx, origin: "synthetic payment scenario" }),
      },
      manifest: {
        "payment.txHash": built.txHash,
        "payment.txId": writers.txHandle(net, built.txHash),
        "payment.size": built.size,
        "payment.fee": fitted.spec.fee!,
        "payment.network": net,
        "payment.slot": ctx.slot,
        "payment.ttl": fitted.spec.ttl!,
        "payment.inputs": [{ txHash: funding.ref.txHash, index: funding.ref.index }],
        "payment.utxos": ctx.utxos.map((u) => `${u.ref.txHash}#${u.ref.index}`),
        "payment.senderAddress": senderAddr.bech32,
        "payment.recipientAddress": recipientAddr.bech32,
        "payment.signerKeyHash": sender.keyHashHex,
        "payment.policyId": policy,
        "payment.assetNameHex": assetName,
        "payment.recipientCoin": coinOf(0),
        "payment.changeCoin": coinOf(1),
        "payment.vkeyCount": 1,
        "payment.metadataLabel": 674,
      },
    };
  },
};
