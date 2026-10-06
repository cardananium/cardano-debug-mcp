// Validator locations vs the decoded transaction: every location form the validator emits resolves to a place that exists
// in the real decoded JSON (so cquisitor can mark it), and governance action ids read as CIP-129 with an explorer link.
import { beforeAll, describe, expect, it } from "vitest";

import { govActionIdBech32, govActionUrl, readableActionIds, readableActionIdValues } from "../../src/chain/govId.js";
import { summarizeDiagnostics } from "../../src/chain/validate.js";
import { buildTxRecord } from "../../src/tx/record.js";
import type { TxRecord } from "../../src/store/txStore.js";
import { diagnosticAnnotations, type IndexedDiagnostic } from "../../src/ui/autoAnnotations.js";
import { txTargetResolver } from "../../src/ui/targets.js";
import { jsonPathOf, pathExists, resolveLocation } from "../../src/ui/txPaths.js";
import { toolkit as tk } from "../fixtures/synthetic/lib/toolkit.js";
import { readTx } from "../helpers/fixtures.js";
import { inProcessLib } from "../helpers/inProcessLib.js";

const { address, keys, tx, writers, scripts, script: scriptLib } = tk;

/** A transaction that has every field the validator points into, all artificial. */
function richTx(): string {
  const net = "mainnet" as const;
  const owner = keys.paymentKey("paths-owner");
  const stake = keys.stakeKey("paths-owner");
  const second = keys.stakeKey("paths-owner-2");
  const addr = address.baseAddress(net, address.keyCred(owner), address.keyCred(stake));
  const pool = keys.poolKey("paths-pool");
  const drep = keys.drepKey("paths-drep");
  const native = scripts.registryNative("all_empty");
  const h = (label: string) => writers.fakeHash(`paths ${label}`);
  return tx.assemble({
    inputs: [tx.txin(h("input a"), 0), tx.txin(h("input b"), 1)],
    referenceInputs: [tx.txin(h("reference a"), 0), tx.txin(h("reference b"), 3)],
    collateral: [tx.txin(h("collateral"), 0)],
    outputs: [{ address: addr, value: { coin: 5_000_000n } }, { address: addr, value: { coin: 6_000_000n } }],
    fee: 200_000n,
    certs: [
      { kind: "stakeReg", cred: address.keyCred(stake), deposit: 2_000_000n },
      { kind: "stakeDelegate", cred: address.keyCred(stake), pool: pool.keyHashHex },
    ],
    withdrawals: [
      { account: address.rewardAddress(net, address.keyCred(stake)), amount: 10n },
      { account: address.rewardAddress(net, address.keyCred(second)), amount: 20n },
    ],
    mint: [{ policy: scriptLib.scriptHash(native), assets: { "": 1n } }],
    requiredSigners: [owner.keyHashHex],
    votes: [
      { voter: { kind: "drep", cred: address.keyCred(drep) }, actions: [{ id: { txHash: h("action a"), index: 0 }, vote: 1 }, { id: { txHash: h("action b"), index: 1 }, vote: 0 }] },
      { voter: { kind: "spo", hash: pool.keyHashHex }, actions: [{ id: { txHash: h("action c"), index: 0 }, vote: 2 }] },
    ],
    signers: [owner],
    nativeScripts: [native.script],
  } as never).hex;
}

describe("validator locations resolve in the decoded transaction", () => {
  let rich: TxRecord;
  let redeemers: TxRecord;
  let scriptsTx: TxRecord;

  beforeAll(async () => {
    const lib = inProcessLib();
    rich = await buildTxRecord(lib, { tx: richTx(), network: "mainnet" });
    redeemers = await buildTxRecord(lib, { tx: readTx("multi-redeemer.tx"), network: "mainnet" });
    scriptsTx = await buildTxRecord(lib, { tx: readTx("pool-mint.tx"), network: "mainnet" });
  });

  it("jsonPathOf: the validator's spellings become the decoded JSON's", () => {
    expect(jsonPathOf("transaction.inputs.3")).toBe("transaction.body.inputs.3");
    expect(jsonPathOf("transaction.reference_inputs.0")).toBe("transaction.body.reference_inputs.0");
    expect(jsonPathOf("transaction.body.voting_procedures.1.2")).toBe("transaction.body.voting_procedures.1.votes.2");
    expect(jsonPathOf("transaction.body.voting_procedures.1")).toBe("transaction.body.voting_procedures.1");
    expect(jsonPathOf("transaction.witness_set.plutus_data.4")).toBe("transaction.witness_set.plutus_data.elems.4");
    expect(jsonPathOf("transaction.body.fee")).toBe("transaction.body.fee");
  });

  // [record, the location the validator emits, where the annotation lands]
  const forms: Array<[() => TxRecord, string, string]> = [
    [() => rich, "transaction.body.inputs.1", "transaction.body.inputs.1"],
    [() => rich, "transaction.inputs.1", "transaction.body.inputs.1"],
    [() => rich, "transaction.reference_inputs.1", "transaction.body.reference_inputs.1"],
    [() => rich, "transaction.body.reference_inputs.0", "transaction.body.reference_inputs.0"],
    [() => rich, "transaction.body.collateral.0", "transaction.body.collateral.0"],
    [() => rich, "transaction.body.mint.0", "transaction.body.mint.0"],
    [() => rich, "transaction.body.certs.1", "transaction.body.certs.1"],
    [() => rich, "transaction.body.voting_procedures.0", "transaction.body.voting_procedures.0"],
    [() => rich, "transaction.body.voting_procedures.0.1", "transaction.body.voting_procedures.0.votes.1"],
    [() => rich, "transaction.body.voting_procedures.1.0", "transaction.body.voting_procedures.1.votes.0"],
    [() => rich, "transaction.body.required_signers.0", "transaction.body.required_signers.0"],
    [() => rich, "transaction.witness_set.vkeys.0", "transaction.witness_set.vkeys.0"],
    [() => rich, "transaction.witness_set.native_scripts.0", "transaction.witness_set.native_scripts.0"],
    // withdrawals sit in an object keyed by reward account: the section is the closest place that exists
    [() => rich, "transaction.body.withdrawals.1", "transaction.body.withdrawals"],
    [() => redeemers, "transaction.witness_set.redeemers.2", "transaction.witness_set.redeemers.2"],
    [() => redeemers, "transaction.witness_set.plutus_data.0", "transaction.witness_set.plutus_data.elems.0"],
    [() => scriptsTx, "transaction.witness_set.plutus_scripts.1", "transaction.witness_set.plutus_scripts.1"],
    // beyond the end, or a field the transaction does not have: the enclosing place
    [() => rich, "transaction.body.outputs.9", "transaction.body.outputs"],
    [() => rich, "transaction.body.outputs.1.amount.coin", "transaction.body.outputs.1.amount.coin"],
    [() => rich, "transaction.body.voting_proposals.0", "transaction.body"],
    [() => rich, "transaction.body.collateral_return.address", "transaction.body"],
    [() => redeemers, "transaction.body.collateral_return.address", "transaction.body.collateral_return.address"],
  ];
  it.each(forms)("%#: %s", (record, location, expected) => {
    const decoded = record().decoded;
    const path = resolveLocation(decoded, location);
    expect(path).toBe(expected);
    expect(pathExists(decoded, path!)).toBe(true);
  });

  it("generated annotations carry the decoded JSON's path; a place the transaction lacks leaves only the diagnostic row", () => {
    const diagnostic = (index: number, locations: string[], message: string, hint?: string): IndexedDiagnostic => ({ index, name: "SomeError", message, locations, hint, severity: "error" });
    const annotations = diagnosticAnnotations(
      [diagnostic(0, ["transaction.body.voting_procedures.0.1"], "short message", "do this"), diagnostic(1, ["transaction.nowhere.0"], "x")],
      rich.decoded,
    );
    expect(annotations.map((a) => a.target)).toEqual([
      { kind: "diagnostic", index: 0 },
      { kind: "tx_path", path: "transaction.body.voting_procedures.0.votes.1" },
      { kind: "diagnostic", index: 1 },
    ]);
  });

  it("generated annotations only point: the error's name, severity and place, no hint (the app shows the message and hint itself)", () => {
    const [row, place] = diagnosticAnnotations(
      [{ index: 0, name: "DisallowedVoters", message: "long message", locations: ["transaction.body.voting_procedures.0.0"], hint: "stake pools may not vote on this action", severity: "error" }],
      rich.decoded,
    );
    expect(row).toEqual({ target: { kind: "diagnostic", index: 0 }, label: "DisallowedVoters", severity: "error" });
    expect(place).toEqual({ target: { kind: "tx_path", path: "transaction.body.voting_procedures.0.votes.0" }, label: "DisallowedVoters", severity: "error" });
  });

  it("a caller's tx_path in the validator's spelling is accepted and rewritten; one that does not exist is dropped with what does", () => {
    const check = txTargetResolver(rich, []);
    expect(check({ kind: "tx_path", path: "transaction.body.voting_procedures.0.1" }, 0)).toEqual({ target: { kind: "tx_path", path: "transaction.body.voting_procedures.0.votes.1" } });
    expect(check({ kind: "tx_path", path: "transaction.inputs.0" }, 0)).toEqual({ target: { kind: "tx_path", path: "transaction.body.inputs.0" } });
    expect(check({ kind: "tx_path", path: "transaction.body.fee" }, 0)).toBeUndefined();
    expect(check({ kind: "tx_path", path: "transaction.body.voting_procedures.0.9" }, 0)).toMatchObject({ drop: expect.stringContaining("is not in the decoded transaction") });
  });

  it("a governance error reads as ids, not byte lists, in the summary and in the data", () => {
    const hash = "39b20e86e99b84e032e15e5006c483bdd13e457e96ba6f0302339c59046f9c6e";
    const bytes = Array.from(Buffer.from(hash, "hex"));
    const id = govActionIdBech32(hash, 0)!;
    const raw = {
      error: { DisallowedVoters: { disallowed_pairs: [[{ stakingPoolKeyHash: "47" }, { txHash: bytes, index: 0 }]] } },
      error_message: `Voters not allowed: [(StakingPoolKeyHash("47"), GovernanceActionId { tx_hash: [${bytes.join(", ")}], index: 0 })]`,
      locations: ["transaction.body.voting_procedures.0.0"],
      hint: "stake pools may not vote on this action",
    };
    const [item] = summarizeDiagnostics([raw], "error", rich).items;
    expect(item!.message).toContain(`[${id}](https://cardanoscan.io/govAction/${id})`);
    expect(item!.message).not.toContain("tx_hash");
    expect(JSON.stringify(item!.data)).toContain(id);
    expect(JSON.stringify(item!.data)).not.toContain("txHash");
  });

  it("no decoded transaction: the translated path is passed on unchecked; a place the transaction does not have: no path", () => {
    expect(resolveLocation(undefined, "transaction.inputs.0")).toBe("transaction.body.inputs.0");
    expect(resolveLocation(rich.decoded, "transaction.nowhere.0")).toBeUndefined();
    expect(resolveLocation(rich.decoded, "elsewhere.0")).toBeUndefined();
  });
});

describe("governance action ids", () => {
  const txHash = "39b20e86e99b84e032e15e5006c483bdd13e457e96ba6f0302339c59046f9c6e";
  const bytes = Array.from(Buffer.from(txHash, "hex"));
  const id = "gov_action18xeqaphfnwzwqvhptegqd3yrhhgnu3t7j6ax7qczxww9jpr0n3hqqfer9wd";

  it("CIP-129: the transaction id and the one-byte index in bech32", () => {
    expect(govActionIdBech32(txHash, 0)).toBe(id);
    expect(govActionIdBech32(bytes, 0)).toBe(id);
    expect(govActionIdBech32(txHash, 17)).not.toBe(id);
    expect(govActionIdBech32(txHash, 256)).toBeUndefined();
    expect(govActionIdBech32("abcd", 0)).toBeUndefined();
    // the CIP's own examples
    expect(govActionIdBech32("00".repeat(32), 17)).toBe("gov_action1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpzklpgpf");
    expect(govActionIdBech32("11".repeat(32), 0)).toBe("gov_action1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsq6dmejn");
  });

  it("Cardanoscan page per network", () => {
    expect(govActionUrl(id, "mainnet")).toBe(`https://cardanoscan.io/govAction/${id}`);
    expect(govActionUrl(id, "preprod")).toBe(`https://preprod.cardanoscan.io/govAction/${id}`);
    expect(govActionUrl(id, "preview")).toBe(`https://preview.cardanoscan.io/govAction/${id}`);
  });

  it("the validator's debug text becomes the id (a markdown link with a network, bare without)", () => {
    const raw = `Voters not allowed: [(StakingPoolKeyHash("47"), GovernanceActionId { tx_hash: [${bytes.join(", ")}], index: 0 })]`;
    expect(readableActionIds(raw)).toBe(`Voters not allowed: [(StakingPoolKeyHash("47"), ${id})]`);
    const linked = readableActionIds(raw, "preview");
    expect(linked).toContain(`[${id}](https://preview.cardanoscan.io/govAction/${id})`);
    // a list that is not 32 bytes stays as it was
    expect(readableActionIds("GovernanceActionId { tx_hash: [1, 2], index: 0 }")).toBe("GovernanceActionId { tx_hash: [1, 2], index: 0 }");
  });

  it("the validator's value shape { txHash: [32 bytes], index } becomes the id; transaction inputs and other values stay", () => {
    const value = { disallowed_pairs: [[{ stakingPoolKeyHash: "47" }, { txHash: bytes, index: 0 }]], input: { txHash: txHash, index: 0 }, count: 2, note: "x" };
    expect(readableActionIdValues(value)).toEqual({ disallowed_pairs: [[{ stakingPoolKeyHash: "47" }, id]], input: { txHash: txHash, index: 0 }, count: 2, note: "x" });
  });
});
