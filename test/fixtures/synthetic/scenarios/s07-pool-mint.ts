// S7: two Plutus V3 minting scripts in one transaction, both carried in the witness set: `pool_mint_a` (a CIP-68 pair: reference
// token + user token) and `pool_mint_b` (a one-shot NFT whose seed input is spent). Array-form redeemers (Mint 0, Mint 1), tag 258 on
// the input set (body 0), the collateral set (body 13) and the vkey set (witness 0), two inputs (the NFT's seed and the funding
// input), three outputs that all carry an inline datum (output 0 is the CIP-68 reference datum, with a large image blob so the
// document is big), collateral with a return output and a total, one required signer and one vkey witness.
// Valid under the real validator and under the Conway CDDL; the tag-258 sets make it invalid under the Babbage CDDL (`$[0][0]`,
// `$[0][13]`, `$[1][0]`, and the V3 script key `$[1][7]`), which the diagnostics tests rely on.

import type { ChainContext } from "../lib/context.js";
import type { Scenario } from "../lib/toolkit.js";

/** Bytes of the pseudo-random `image` blob inside the reference datum (incompressible, like real embedded images). */
const IMAGE_BYTES = 4_096;

export const scenario: Scenario = {
  name: "s07",
  description: "Two V3 witness minting scripts (CIP-68 pair + one-shot NFT), array redeemers, tag-258 sets, inline-datum outputs, ~7 KB.",
  build(tk) {
    const { address, keys, fit, context, writers, params, scripts, bytes, plutusData, blake2b } = tk;
    const { constr, pBytes, pInt, pList, pMap } = plutusData;
    const net = "mainnet" as const;

    // the scripts' own parameters: the operator key and the seed output (see scripts.json)
    const operator = keys.paymentKey("script-operator");
    const operatorStake = keys.stakeKey("script-operator");
    const operatorAddr = address.baseAddress(net, address.keyCred(operator), address.keyCred(operatorStake));
    const recipient = keys.paymentKey("s07-recipient");
    const recipientAddr = address.baseAddress(net, address.keyCred(recipient), address.keyCred(keys.stakeKey("s07-recipient")));
    const registry = scripts.loadRegistry().scripts;
    const seed = registry.pool_mint_b!.params as unknown as Array<{ value: { transactionId: string; outputIndex: number } }>;
    const seedRef = seed[0]!.value;

    const scriptA = scripts.registryScript("pool_mint_a");
    const scriptB = scripts.registryScript("pool_mint_b");
    const hashA = scripts.registryHash("pool_mint_a");
    const hashB = scripts.registryHash("pool_mint_b");
    const holderHash = scripts.registryHash("spend_v3");
    const holderAddr = address.enterpriseAddress(net, address.scriptCred(holderHash));

    const suffix = bytes.utf8Hex("SynPool");
    const refName = `000643b0${suffix}`;
    const userName = `000de140${suffix}`;
    const nftName = bytes.utf8Hex("SynPoolNFT");

    // the CIP-68 reference datum: metadata map (name, image, description), version 1, extra data
    const image: Uint8Array[] = [];
    for (let i = 0, made = 0; made < IMAGE_BYTES; i++, made += 32) image.push(blake2b.blake2b256(bytes.utf8(`cardano-debug-mcp synthetic fixture image / s07 / ${i}`)));
    const blob = bytes.concat(...image).subarray(0, IMAGE_BYTES);
    const chunks = Array.from({ length: Math.ceil(IMAGE_BYTES / 64) }, (_, i) => pBytes(blob.subarray(i * 64, (i + 1) * 64)));
    const referenceDatum = constr(0, [
      pMap([
        [pBytes(bytes.utf8Hex("name")), pBytes(bytes.utf8Hex("Synthetic pool token"))],
        [pBytes(bytes.utf8Hex("image")), pList(chunks)],
        [pBytes(bytes.utf8Hex("description")), pBytes(bytes.utf8Hex("An artificial CIP-68 token of the cardano-debug-mcp fixtures"))],
      ]),
      pInt(1),
      constr(0, []),
    ]);
    const claimDatum = constr(0, [pBytes(bytes.utf8Hex("claim ticket")), pInt(1)]);
    const changeDatum = constr(1, [pBytes(bytes.utf8Hex("synthetic pool change"))]);

    const slot = 150_000_000n;
    const seedUtxo = context.utxo({ ref: `${seedRef.transactionId}#${seedRef.outputIndex}`, address: operatorAddr, coin: 25_000_000n });
    const funds = context.utxo({ ref: `${writers.fakeHash("s07 funds")}#2`, address: operatorAddr, coin: 300_000_000n });
    const collateral = context.utxo({ ref: `${writers.fakeHash("s07 collateral")}#0`, address: operatorAddr, coin: 40_000_000n });
    const ctx: ChainContext = { network: net, params: params.protocolParameters("pv10"), slot, utxos: [seedUtxo, funds, collateral] };

    const fitted = fit.fit(
      {
        inputs: [funds.ref, seedUtxo.ref],
        outputs: [
          { address: holderAddr, value: { coin: "min", assets: { [hashA]: { [refName]: 1n } } }, inlineDatum: referenceDatum },
          { address: recipientAddr, value: { coin: "min", assets: { [hashA]: { [userName]: 1n }, [hashB]: { [nftName]: 1n } } }, inlineDatum: claimDatum },
          { address: operatorAddr, value: { coin: "min" }, inlineDatum: changeDatum, change: true },
        ],
        mint: [
          { policy: hashA, assets: { [refName]: 1n, [userName]: 1n } },
          { policy: hashB, assets: { [nftName]: 1n } },
        ],
        collateral: [collateral.ref],
        requiredSigners: [operator.keyHashHex],
        plutusScripts: [scriptA, scriptB],
        redeemers: [
          { target: { tag: "mint", policy: hashA }, data: constr(0, [pBytes(suffix), pInt(0)]), exUnits: { mem: 1n, steps: 1n } },
          { target: { tag: "mint", policy: hashB }, data: constr(0, [pBytes(nftName)]), exUnits: { mem: 1n, steps: 1n } },
        ],
        encoding: { redeemers: "array", sets: { inputs: true, collateral: true, vkeys: true } },
      },
      { ctx, keys: [operator] },
    );
    const built = fitted.tx;
    if (built.mintPolicies[0] !== hashA || built.mintPolicies[1] !== hashB) throw new Error("s07: the policies are not in the order Mint 0 = pool_mint_a, Mint 1 = pool_mint_b");

    return {
      files: { "pool-mint.tx": writers.txText(built, true) },
      manifest: {
        "s07.txHash": built.txHash,
        "s07.txId": writers.txHandle(net, built.txHash),
        "s07.size": built.size,
        "s07.fee": fitted.spec.fee!,
        "s07.network": net,
        "s07.slot": slot,
        "s07.inputs": built.inputs.map((i) => ({ txHash: i.txHash, index: i.index })),
        "s07.outputCount": 3,
        "s07.inlineDatumOutputs": 3,
        "s07.vkeyCount": 1,
        "s07.mintPolicies": [hashA, hashB],
        "s07.redeemers": built.redeemers.map((r) => ({ ref: `mint:${r.index}`, index: r.index, mem: r.exUnits.mem, steps: r.exUnits.steps })),
        // the two witness scripts, in the order of the witness set
        "s07.scripts": [
          { name: "pool_mint_a", hash: hashA, size: scriptA.bytes.length, version: "V3" },
          { name: "pool_mint_b", hash: hashB, size: scriptB.bytes.length, version: "V3" },
        ],
        "s07.scriptCount": 2,
        "s07.referenceDatum": { outputIndex: 0, imageBytes: IMAGE_BYTES },
        "s07.refTokenName": refName,
        "s07.userTokenName": userName,
        "s07.nftName": nftName,
        "s07.holderAddress": holderAddr.bech32,
        // where the tag-258 sets and the witness set sit (the diagnostics tests point at them)
        "s07.spans": {
          body: built.spans.body,
          inputs: built.spans["body.0"],
          collateral: built.spans["body.13"],
          witnessSet: built.spans.witnesses,
          vkeys: built.spans["witness.0"],
          v3Scripts: built.spans["witness.7"],
          redeemers: built.spans["witness.5"],
        },
      },
    };
  },
};
