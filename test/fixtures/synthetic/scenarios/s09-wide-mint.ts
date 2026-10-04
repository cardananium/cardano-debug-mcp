// S9: a wide transaction: 26 outputs (25 script-address outputs with large inline datums, one change output), a mint of 25 assets
// under one native policy, CIP-25 style metadata (label 721) for the 25 tokens, two reference inputs, one required signer and
// one vkey witness. It is about 13 KB, close to the size limit; the tests use it to see how the tools cut and page a document
// that is far over the character budget. Valid under the real validator (no scripts run).

import type { ChainContext } from "../lib/context.js";
import type { Scenario } from "../lib/toolkit.js";

const ASSET_COUNT = 25;

export const scenario: Scenario = {
  name: "s09",
  description: "26 outputs (25 with big inline datums), 25 assets minted under one native policy, 721 metadata, 2 reference inputs.",
  build(tk) {
    const { address, keys, fit, context, writers, params, script, bytes, plutusData, scripts } = tk;
    const { constr, pBytes, pInt, pList } = plutusData;
    const net = "mainnet" as const;

    const minter = keys.paymentKey("s09-minter");
    const minterStake = keys.stakeKey("s09-minter");
    const minterAddr = address.baseAddress(net, address.keyCred(minter), address.keyCred(minterStake));
    const vaultAddr = address.enterpriseAddress(net, address.scriptCred(scripts.registryHash("lock_spend")));
    const policyScript = script.native({ type: "sig", keyHash: minter.keyHashHex });
    const policy = script.scriptHash(policyScript);
    const borrowerHash = keys.paymentKey("s09-borrower").keyHashHex;
    const feedHash = keys.paymentKey("s09-price-feed").keyHashHex;

    const names = Array.from({ length: ASSET_COUNT }, (_, i) => `SynLoan${String(i + 1).padStart(3, "0")}`);
    const nameHex = names.map((n) => bytes.utf8Hex(n));

    // a loan-request shaped datum (all artificial): parties, collateral and loan legs, schedule, price-feed reference, terms hash
    const datumFor = (i: number) =>
      constr(0, [
        pBytes(borrowerHash),
        constr(0, [pBytes(policy), pBytes(nameHex[i]!), pInt(1)]),
        constr(0, [pBytes(feedHash), pBytes(bytes.utf8Hex("SYNUSD")), pInt(2_500_000 + 1_000 * i)]),
        constr(0, [pBytes(feedHash), pBytes(bytes.utf8Hex("SYNEUR")), pInt(40_000_000 - 17 * i)]),
        pInt(1_900_000_000_000 + 86_400_000 * i),
        pInt(30 + i),
        pList(Array.from({ length: 5 }, (_, k) => pInt(1_000_000 * (k + 1) + i))),
        pBytes(writers.fakeHash(`s09 terms ${i}`)),
        constr(0, [pBytes(bytes.utf8Hex(`synthetic loan ${i + 1}`))]),
      ]);

    const slot = 150_450_000n;
    const funds = context.utxo({ ref: `${writers.fakeHash("s09 funds")}#0`, address: minterAddr, coin: 400_000_000n });
    const refs = [
      context.utxo({ ref: `${writers.fakeHash("s09 reference one")}#0`, address: minterAddr, coin: 3_000_000n, inlineDatum: constr(0, [pInt(1)]) }),
      context.utxo({ ref: `${writers.fakeHash("s09 reference two")}#1`, address: minterAddr, coin: 3_000_000n, inlineDatum: constr(0, [pInt(2)]) }),
    ];
    const ctx: ChainContext = { network: net, params: params.protocolParameters("pv10"), slot, utxos: [funds, ...refs] };

    const metadata = new Map(
      names.map((n, i) => [
        n,
        new Map<string, string | string[]>([
          ["name", `Synthetic loan ${i + 1}`],
          ["image", [`ipfs://synthetic-fixture/${n.toLowerCase()}`, "/image.png"]],
          ["mediaType", "image/png"],
          ["description", ["An artificial token of the cardano-debug-mcp fixtures.", `Position ${i + 1} of ${ASSET_COUNT}.`]],
        ]),
      ]),
    );

    const fitted = fit.fit(
      {
        inputs: [funds.ref],
        referenceInputs: refs.map((r) => r.ref),
        outputs: [
          ...names.map((_, i) => ({ address: vaultAddr, value: { coin: "min" as const, assets: { [policy]: { [nameHex[i]!]: 1n } } }, inlineDatum: datumFor(i) })),
          { address: minterAddr, value: { coin: "min" as const }, change: true },
        ],
        mint: [{ policy, assets: Object.fromEntries(nameHex.map((n) => [n, 1n])) }],
        nativeScripts: [policyScript.script],
        requiredSigners: [minter.keyHashHex],
        ttl: slot + 7_200n,
        aux: { metadata: [[721n, new Map([[policy, metadata]])]] },
      },
      { ctx, keys: [minter] },
    );
    const built = fitted.tx;
    const datumSizes = fitted.spec.outputs.slice(0, ASSET_COUNT).map((o) => plutusData.encodePlutusData(o.inlineDatum as ReturnType<typeof datumFor>).length);

    return {
      files: { "wide-mint.tx": writers.txText(built, true) },
      manifest: {
        "s09.txHash": built.txHash,
        "s09.txId": writers.txHandle(net, built.txHash),
        "s09.size": built.size,
        "s09.fee": fitted.spec.fee!,
        "s09.network": net,
        "s09.slot": slot,
        "s09.outputCount": ASSET_COUNT + 1,
        "s09.datumOutputCount": ASSET_COUNT,
        "s09.mintedAssetCount": ASSET_COUNT,
        "s09.mintPolicy": policy,
        "s09.referenceInputs": refs.map((r) => `${r.ref.txHash}#${r.ref.index}`),
        "s09.vkeyCount": 1,
        "s09.metadataLabel": 721,
        "s09.datumBytes": { min: Math.min(...datumSizes), max: Math.max(...datumSizes) },
      },
    };
  },
};
