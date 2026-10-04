// Redeemer targets from the decoded witness set: the library's decoder spells the propose tag
// `VotingProposal` (its validation results say `Propose`); both must land on purpose `propose`, and
// a tag the server does not know must fail loudly instead of being read as a spend.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { DecodedTransaction } from "../../src/store/txStore.js";
import { buildTxRecord, redeemerTargetsOf } from "../../src/tx/record.js";
import { fixturePath, fx, fxStr } from "../helpers/fixtures.js";
import { inProcessLib } from "../helpers/inProcessLib.js";

/** Scenario S4: a ParameterChange proposal whose guardrails script (V3, in the witness set) runs under redeemer propose:0. */
const PROPOSE_BUNDLE = fixturePath(fxStr("s04.bundleFile"));
const GUARDRAILS = fxStr("s04.guardrailsHash");

function decodedWith(redeemer: Record<string, unknown>, body: Record<string, unknown> = {}): DecodedTransaction {
  return { transaction_hash: "00".repeat(32), transaction: { body: { inputs: [], outputs: [], fee: "0", ...body }, witness_set: { redeemers: [redeemer] } } } as unknown as DecodedTransaction;
}

describe("redeemer targets from the decoded witness tag", () => {
  it("a proposal redeemer (decoded tag VotingProposal) is propose:<index>, aimed at the proposal and its guardrails script", async () => {
    const bundle = JSON.parse(readFileSync(PROPOSE_BUNDLE, "utf8")) as { tx_cbor: string };
    const record = await buildTxRecord(inProcessLib(), { tx: bundle.tx_cbor, network: "mainnet" });
    expect((record.decoded.transaction.witness_set.redeemers as Array<{ tag: string }>)[0]!.tag).toBe("VotingProposal");
    expect(record.redeemerTargets).toEqual([
      {
        ref: "propose:0",
        purpose: "propose",
        index: 0,
        witness_index: 0,
        target: "proposal #0",
        script_hash: GUARDRAILS,
        plutus_version: "V3",
        // the units the transaction declares (and the validator calculates): a fixture number, read from the manifest
        ex_units: fx<{ mem: string; steps: string }>("s04.exUnits"),
      },
    ]);
  });

  it("the proposal's policy_hash is the script hash of a synthetic proposal too; a proposal without one leaves it unset", () => {
    const withPolicy = decodedWith(
      { tag: "VotingProposal", index: "0", data: "{}", ex_units: { mem: "1", steps: "2" } },
      { voting_proposals: [{ governance_action: { TreasuryWithdrawalsAction: { withdrawals: {}, policy_hash: GUARDRAILS.toUpperCase() } } }] },
    );
    expect(redeemerTargetsOf(withPolicy, [])[0]).toMatchObject({ ref: "propose:0", target: "proposal #0", script_hash: GUARDRAILS });
    const info = decodedWith({ tag: "VotingProposal", index: "0", data: "{}", ex_units: { mem: "1", steps: "2" } }, { voting_proposals: [{ governance_action: { InfoAction: {} } }] });
    expect(redeemerTargetsOf(info, [])[0]!.script_hash).toBeUndefined();
  });

  it("an unknown or missing tag is an error naming the witness, never a spend", () => {
    expect(() => redeemerTargetsOf(decodedWith({ tag: "Frobnicate", index: "0", data: "{}", ex_units: { mem: "1", steps: "1" } }), [])).toThrow(
      /^redeemer witness 0: unknown cquisitor-lib redeemer tag "Frobnicate" \(known: Spend, Mint, Reward, Cert, Vote, Propose, VotingProposal\)$/,
    );
    expect(() => redeemerTargetsOf(decodedWith({ index: "0", data: "{}", ex_units: { mem: "1", steps: "1" } }), [])).toThrow(/^redeemer witness 0: the decoded transaction gives no tag \(undefined\)/);
    // the known spellings map to their refs
    for (const [tag, ref] of [
      ["Spend", "spend:0"],
      ["Mint", "mint:0"],
      ["Cert", "publish:0"],
      ["Reward", "withdraw:0"],
      ["Vote", "vote:0"],
      ["Propose", "propose:0"],
      ["VotingProposal", "propose:0"],
    ] as const) {
      expect(redeemerTargetsOf(decodedWith({ tag, index: "0", data: "{}", ex_units: { mem: "1", steps: "1" } }), [])[0]!.ref, tag).toBe(ref);
    }
  });
});
