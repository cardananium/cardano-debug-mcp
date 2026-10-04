// S4: an on-chain ParameterChange proposal guarded by the constitution's guardrails script (Plutus V3). The proposal's policy_hash is
// the hash of the artificial `guardrails` script, the witness set carries that script, and the redeemer is `VotingProposal 0` with
// data `Map []` (the redeemer the guardrails handler expects). Declared ex-units equal the calculated ones (verdict `exact`) and the
// transaction validates with zero diagnostics at its inclusion slot.
//
// The fixture is a bundle v1 as the server's own export writes it for a transaction loaded by hash: validation_input_context
// (account, active govAction, lastEnacted, constitution, treasury, slot, PV10 parameters), `on_chain`, `defaults_applied`, no
// validation_result.

import { createHash } from "node:crypto";

import type { Scenario } from "../lib/toolkit.js";
import type { ChainContext } from "../lib/context.js";

/** When the bundle claims to have been exported (a fixed, artificial time: nothing here reads the clock). */
const CAPTURED_AT = "2026-03-01T09:00:00.000Z";

export const scenario: Scenario = {
  name: "s04",
  description: "A fully valid V3 ParameterChange proposal whose guardrails script runs under redeemer propose:0 (bundle v1, on chain).",
  build(tk) {
    const { address, keys, fit, context, writers, params, scripts, plutusData, cbor } = tk;
    const net = "mainnet" as const;

    // the proposer: one key pays for everything and receives the change; its stake credential is the proposal's return account
    const proposer = keys.paymentKey("s04-proposer");
    const proposerStake = keys.stakeKey("s04-proposer");
    const proposerAddr = address.baseAddress(net, address.keyCred(proposer), address.keyCred(proposerStake));
    const returnAccount = address.rewardAddress(net, address.keyCred(proposerStake));

    // the constitution's guardrails script is one of ours (Aiken, Plutus V3)
    const guardrails = scripts.registryScript("guardrails");
    const guardrailsHash = scripts.registryHash("guardrails");

    const slot = 160_120_000n;
    const pp = params.protocolParameters("pv10");
    const deposit = BigInt(pp.governanceActionDeposit);

    // the deposit comes from a large input; a second, small one is both an input and the collateral
    const bigInput = context.utxo({ ref: `${writers.fakeHash("s04 deposit funding utxo")}#0`, address: proposerAddr, coin: deposit + 25_000_000n });
    const smallInput = context.utxo({ ref: `${writers.fakeHash("s04 collateral utxo")}#1`, address: proposerAddr, coin: 12_000_000n });

    // governance state: one active ParameterChange (the new proposal builds on it) and the last enacted one
    const activeId = writers.fakeHash("s04 active parameter change action");
    const enactedId = writers.fakeHash("s04 last enacted parameter change action");
    const ctx: ChainContext = {
      network: net,
      params: pp,
      slot,
      utxos: [bigInput, smallInput],
      accounts: [context.accountContext({ cred: address.keyCred(proposerStake), pool: address.poolIdBech32(keys.poolKey("s04-delegate-pool")), balance: 0 })],
      // the exporter that wrote this bundle knows which parameters the active action changes
      govActions: [context.govActionContext(activeId, 0, "parameterChangeAction", { changedParameters: ["max_tx_size"] })],
      lastEnacted: [context.govActionContext(enactedId, 0, "parameterChangeAction")],
      constitution: { guardrailScriptHash: guardrailsHash },
      treasury: 1_500_000_000_000_000n,
    };

    const { uint, array } = cbor;
    const spec = {
      inputs: [bigInput.ref, smallInput.ref],
      collateral: [smallInput.ref],
      outputs: [{ address: proposerAddr, value: { coin: "min" as const }, change: true }],
      validityStart: slot - 500n,
      ttl: slot + 7_200n,
      proposals: [
        {
          deposit,
          rewardAccount: returnAccount,
          action: {
            type: "parameterChange" as const,
            prev: { txHash: activeId, index: 0 },
            // max transaction size (key 3) and max transaction execution units (key 20): inside the guardrails' bounds
            update: [
              [3, uint(18_432)],
              [20, array([uint(14_000_000), uint(9_500_000_000)])],
            ] as Array<[number, ReturnType<typeof uint>]>,
            policyHash: guardrailsHash,
          },
          anchor: { url: "https://example.invalid/synthetic/s04-parameter-change", hash: writers.fakeHash("s04 proposal anchor document") },
        },
      ],
      plutusScripts: [guardrails],
      // `VotingProposal 0` (the library's name for redeemer tag 5), data `Map []`; the units are replaced by the calculated ones
      redeemers: [{ target: { tag: "propose" as const, index: 0 }, data: plutusData.pMap([]), exUnits: { mem: 1n, steps: 1n } }],
    };
    const fitted = fit.fit(spec, { ctx, keys: [proposer], exUnits: "exact", collateral: { total: 5_000_000n }, expect: "valid" });
    const built = fitted.tx;
    const v = fitted.validation;
    if (v.errors.length + v.warnings.length + v.phase2_errors.length + v.phase2_warnings.length !== 0) {
      throw new Error(`s04: the proposal must validate with zero diagnostics, got ${JSON.stringify({ e: v.errors, w: v.warnings, p2e: v.phase2_errors, p2w: v.phase2_warnings }).slice(0, 800)}`);
    }
    const redeemer = built.redeemers[0]!;
    const result = v.eval_redeemer_results[0]!;
    if (!result.success || String(result.plutus_version) !== "V3") throw new Error("s04: the guardrails script must run (V3) and succeed");

    // inclusion facts as the server's bundle export records them for a transaction loaded by hash
    const at = writers.inclusionAt(net, slot, "s04");
    const hexBytesKey = createHash("sha256").update(built.hex.toLowerCase()).digest("hex").slice(0, 16);
    const onChain = { slot: slot.toString(), epoch: at.epoch, block_height: at.blockHeight, is_valid: true, source: "koios tx_cbor row", block_hash: at.blockHash, tx_bytes: hexBytesKey };
    const defaults = [
      `slot=${slot}: the transaction is on chain (epoch ${at.epoch}, block ${at.blockHeight}), so it is validated at its inclusion slot, not at the current tip`,
      `protocolParameters = epoch ${at.epoch} parameters (the inclusion epoch), not the current ones`,
      `utxoSet[*].isSpent=false: the 2 inputs / collateral / reference inputs were unspent when the tx was included (the provider reports 2 of them spent now)`,
      `treasuryValue = the provider's treasury total for epoch ${at.epoch}`,
      `reward accounts (balances, registration, delegation), governance actions, constitution: the provider's CURRENT state, not the state at slot ${slot} (no historical view exists); withdrawal amounts, registrations and deposits may be judged against today's values`,
    ];

    const exUnits = { mem: redeemer.exUnits.mem, steps: redeemer.exUnits.steps };
    return {
      files: { "s04.propose.bundle.json": writers.bundleFile({ tx: built, ctx, origin: "koios", capturedAt: CAPTURED_AT, defaultsApplied: defaults, onChain }) },
      manifest: {
        "s04.txHash": built.txHash,
        "s04.txId": writers.txHandle(net, built.txHash),
        "s04.size": built.size,
        "s04.network": net,
        "s04.fee": fitted.spec.fee!,
        "s04.slot": slot,
        "s04.epoch": at.epoch,
        "s04.blockHeight": at.blockHeight,
        "s04.protocolMajor": Number(pp.protocolVersion[0]),
        "s04.bundleFile": "s04.propose.bundle.json",
        "s04.guardrailsHash": guardrailsHash,
        "s04.guardrailsSize": tk.script.scriptSize(guardrails),
        "s04.plutusVersion": "V3",
        // the one redeemer of the transaction, as tx_load lists it
        "s04.redeemer": {
          ref: "propose:0",
          purpose: "propose",
          index: 0,
          witnessIndex: 0,
          target: "proposal #0",
          scriptHash: guardrailsHash,
          plutusVersion: "V3",
          exUnits: { mem: exUnits.mem.toString(), steps: exUnits.steps.toString() },
          verdict: "exact",
        },
        "s04.exUnits": exUnits,
        "s04.proposalPolicyHash": guardrailsHash,
        "s04.activeActionTxHash": activeId,
        "s04.lastEnactedActionTxHash": enactedId,
        "s04.deposit": deposit,
        "s04.treasury": ctx.treasury!,
        "s04.returnAccount": returnAccount.bech32,
        "s04.signerKeyHash": proposer.keyHashHex,
        "s04.inputs": ctx.utxos.map((u) => `${u.ref.txHash}#${u.ref.index}`),
        "s04.defaultsApplied": defaults,
      },
    };
  },
};
