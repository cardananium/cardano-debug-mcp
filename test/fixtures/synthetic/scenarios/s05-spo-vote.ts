// S5: a stake pool operator votes Yes (with an anchor) on a ParameterChange governance action, in a bundle v1 whose context predates
// `changedParameters`: the governance action context names no parameters, and only the provider's proposal row (`param_proposal`)
// says which ones the action changes. They are exactly the four execution-unit limits, which sit in the ledger's security group,
// so a stake pool may vote on the action; with no names (or other names) the validator answers DisallowedVoters.
//
// The transaction is shaped like a pool operator's wallet transaction: 11 key inputs (all spent by it: isSpent true in the stored
// context), one output, a reward withdrawal whose amount is wrong (WrongRequestedWithdrawalAmount), 3 vkey witnesses (the payment
// key, the stake key and the pool key). The bundle stores the verdict the validator gave on exactly that context, which includes
// DisallowedVoters; importing the bundle fills the names from the row and drops the stale verdict.

import type { Scenario } from "../lib/toolkit.js";
import type { ChainContext } from "../lib/context.js";

/** When the bundle claims to have been exported (a fixed, artificial time: nothing here reads the clock). */
const CAPTURED_AT = "2026-03-01T09:30:00.000Z";

export const SECURITY_GROUP_PARAMETERS = ["max_block_ex_mem", "max_block_ex_steps", "max_tx_ex_mem", "max_tx_ex_steps"] as const;
/** Parameters outside the security group: a stake pool voter is DisallowedVoters on an action that changes any of these. */
export const OTHER_PARAMETERS = ["min_pool_cost", "drep_deposit"] as const;

export const scenario: Scenario = {
  name: "s05",
  description: "A stake pool vote on a ParameterChange of the security group (bundle v1: no changedParameters in the context, a provider row, a stale DisallowedVoters verdict).",
  build(tk) {
    const { address, keys, fit, context, writers, params, scripts, validator } = tk;
    const net = "mainnet" as const;

    // identities
    const operator = keys.paymentKey("s05-operator");
    const operatorStake = keys.stakeKey("s05-operator");
    const pool = keys.poolKey("s05-pool");
    const operatorAddr = address.baseAddress(net, address.keyCred(operator), address.keyCred(operatorStake));
    const rewardAccount = address.rewardAddress(net, address.keyCred(operatorStake));
    const drep = keys.drepKey("s05-delegate-drep");
    const poolIdHex = pool.keyHashHex;

    const guardrailsHash = scripts.registryHash("guardrails");
    const slot = 190_080_000n;
    const pp = params.protocolParameters("pv11");
    const epoch = writers.epochOfSlot(net, slot);

    // eleven key inputs at the operator's address, every one of them spent by this very transaction
    const coins = [1_200_000_000n, 450_000_000n, 300_000_000n, 275_000_000n, 150_000_000n, 90_000_000n, 60_000_000n, 42_000_000n, 25_000_000n, 12_000_000n, 8_000_000n];
    const utxos = coins.map((coin, i) =>
      context.utxo({ ref: `${writers.fakeHash(`s05 operator utxo ${i}`)}#${[18, 15, 2, 7, 0, 4, 9, 1, 3, 11, 5][i]}`, address: operatorAddr, coin, isSpent: true }),
    );

    // the action voted on (proposed earlier by someone else) and the withdrawal the operator gets wrong
    const actionTx = writers.fakeHash("s05 parameter change action transaction");
    const accountBalance = 4_200_000_000;
    const requested = 9_300_000_000n;
    const ctx: ChainContext = {
      network: net,
      params: pp,
      slot,
      utxos,
      accounts: [context.accountContext({ cred: address.keyCred(operatorStake), drep: address.drepIdBech32(address.keyCred(drep)), pool: address.poolIdBech32(pool), balance: accountBalance })],
      pools: [context.poolContext(poolIdHex)],
      // no `changedParameters`: this context was exported before gov-action contexts carried them
      govActions: [context.govActionContext(actionTx, 0, "parameterChangeAction")],
      constitution: { guardrailScriptHash: guardrailsHash },
      treasury: 1_380_000_000_000_000n,
    };

    const fitted = fit.fit(
      {
        inputs: utxos.map((u) => u.ref),
        outputs: [{ address: operatorAddr, value: { coin: "min" }, change: true }],
        withdrawals: [{ account: rewardAccount, amount: requested }],
        votes: [
          {
            voter: { kind: "spo", hash: poolIdHex },
            actions: [{ id: { txHash: actionTx, index: 0 }, vote: 1, anchor: { url: "https://example.invalid/synthetic/s05-vote-rationale", hash: writers.fakeHash("s05 vote rationale document") } }],
          },
        ],
        ttl: slot + 7_200n,
      },
      { ctx, keys: [operator, operatorStake, pool], expect: "any" },
    );
    const built = fitted.tx;

    // the verdict stored in the bundle: what the validator says about this very context
    const stored = validator.validate(built.hex, ctx);
    const kinds = stored.errors.map((e) => validator.errorKind(e));
    for (const required of ["DisallowedVoters", "WrongRequestedWithdrawalAmount", "BadInputsUTxO"]) {
      if (!kinds.includes(required)) throw new Error(`s05: the stored verdict must contain ${required}, got [${kinds.join(", ")}]`);
    }
    // ... and the same transaction on a context that names the security-group parameters is not DisallowedVoters
    const named = structuredClone(ctx);
    named.govActions = [context.govActionContext(actionTx, 0, "parameterChangeAction", { changedParameters: [...SECURITY_GROUP_PARAMETERS] })];
    const withNames = validator.validate(built.hex, named).errors.map((e) => validator.errorKind(e));
    if (withNames.includes("DisallowedVoters")) throw new Error("s05: the security-group names must make the vote allowed");
    const other = structuredClone(ctx);
    other.govActions = [context.govActionContext(actionTx, 0, "parameterChangeAction", { changedParameters: [...OTHER_PARAMETERS] })];
    if (!validator.validate(built.hex, other).errors.map((e) => validator.errorKind(e)).includes("DisallowedVoters")) throw new Error("s05: other parameter names must be DisallowedVoters");

    // the provider's proposal row (Koios `proposal_list`): param_proposal changes exactly the four limits
    const proposalRow = writers.koiosProposalRow({
      txHash: actionTx,
      index: 0,
      type: "ParameterChange",
      returnAddress: address.rewardAddress(net, address.keyCred(keys.stakeKey("s05-proposer"))).bech32,
      proposedEpoch: epoch - 8,
      expiration: epoch - 1,
      ratifiedEpoch: epoch - 1,
      enactedEpoch: epoch,
      paramProposal: { max_block_ex_mem: 76_000_000, max_block_ex_steps: 21_000_000_000, max_tx_ex_mem: 15_500_000, max_tx_ex_steps: 10_500_000_000 },
      anchorUrl: "https://example.invalid/synthetic/s05-parameter-change",
      anchorHash: writers.fakeHash("s05 parameter change anchor document"),
      description: {
        tag: "ParameterChange",
        contents: [
          { govActionIx: 0, txId: writers.fakeHash("s05 previous parameter change action transaction") },
          { maxBlockExecutionUnits: { memory: 76_000_000, steps: 21_000_000_000 }, maxTxExecutionUnits: { memory: 15_500_000, steps: 10_500_000_000 } },
          guardrailsHash,
        ],
      },
    });
    const providerRows = { provider: "koios", network: net, utxo_info: [], account_info: [], pool_info: [], drep_info: [], proposals: [proposalRow], tx_cbor: [], cache_hits: [] };

    return {
      files: { "s05.spo-vote.bundle.json": writers.bundleFile({ tx: built, ctx, origin: "koios", capturedAt: CAPTURED_AT, providerRows, validationResult: stored }) },
      manifest: {
        "s05.txHash": built.txHash,
        "s05.txId": writers.txHandle(net, built.txHash),
        "s05.size": built.size,
        "s05.network": net,
        "s05.fee": fitted.spec.fee!,
        "s05.slot": slot,
        "s05.epoch": epoch,
        "s05.protocolMajor": Number(pp.protocolVersion[0]),
        "s05.bundleFile": "s05.spo-vote.bundle.json",
        "s05.inputCount": utxos.length,
        "s05.vkeyCount": 3,
        "s05.outputCount": 1,
        "s05.voterPoolHash": poolIdHex,
        "s05.voterPoolId": address.poolIdBech32(pool),
        "s05.vote": "Yes",
        "s05.govActionTxHash": actionTx,
        "s05.govActionIndex": 0,
        "s05.govActionId": address.govActionIdBech32(actionTx, 0),
        "s05.guardrailsHash": guardrailsHash,
        "s05.treasury": ctx.treasury!,
        "s05.withdrawal": { account: rewardAccount.bech32, requested, expected: accountBalance },
        "s05.securityParameters": [...SECURITY_GROUP_PARAMETERS],
        "s05.otherParameters": [...OTHER_PARAMETERS],
        "s05.storedErrors": kinds,
        "s05.storedErrorCount": kinds.length,
        "s05.errorsWithNames": withNames,
      },
    };
  },
};
