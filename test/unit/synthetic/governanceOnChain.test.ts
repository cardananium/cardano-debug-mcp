// Scenarios S4 (a guarded ParameterChange proposal), S5 (a stake pool vote on a security-group ParameterChange) and S6 (an on-chain
// transaction as a provider-cache snapshot), proved against the real validator: what each fixture promises, built from artificial
// keys, scripts and ids. The tests that consume them (redeemerTargets, bundle, onChain*, chain.e2e, onchain.e2e) read the same manifest.
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { ValidationInputContext } from "@cardananium/cquisitor-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bytesKey } from "../../../src/chain/onChain.js";
import { txLoad } from "../../../src/tools/tx_load.js";
import { txValidate } from "../../../src/tools/tx_validate.js";
import { blake2b224, blake2b256 } from "../../fixtures/synthetic/lib/blake2b.js";
import { hexToBytes } from "../../fixtures/synthetic/lib/bytes.js";
import { decodeType, errorKinds, validate } from "../../fixtures/synthetic/lib/validator.js";
import { txHashOfBytes } from "../../fixtures/synthetic/lib/tx.js";
import { fixturePath, fx, fxArr, fxBig, fxInt, fxNum, fxStr, manifest, readFixtureJson, readFixtureText } from "../../helpers/fixtures.js";
import { json, makeContext, startStub, tempDir, type Stub, type TestContext } from "../chain/serviceHarness.js";

type Json = Record<string, any>;

interface Bundle {
  cardano_debug_bundle: number;
  network: string;
  tx_hash: string;
  tx_cbor: string;
  captured_at: string | null;
  slot: string;
  protocol_major: number;
  validation_input_context: ValidationInputContext & { govActionContexts: Array<{ actionId: { txHash: number[]; index: number }; actionType: string; isActive: boolean; changedParameters?: string[] }> };
  provider_rows?: Json;
  validation_result?: { errors: Array<{ error: Record<string, unknown> }> };
  on_chain?: Json;
  defaults_applied?: string[];
}

const hex = (bytes: number[]) => Buffer.from(bytes).toString("hex");
const isAllHex = (text: string, length: number) => new RegExp(`^[0-9a-f]{${length}}$`).test(text);
const allDiagnostics = (r: ReturnType<typeof validate>) => r.errors.length + r.warnings.length + r.phase2_errors.length + r.phase2_warnings.length;

describe("S4: a ParameterChange proposal guarded by the artificial guardrails script", () => {
  const bundle = readFixtureJson<Bundle>(fxStr("s04.bundleFile"));
  const ctx = bundle.validation_input_context;
  const tx = decodeType<{ transaction: Json }>(bundle.tx_cbor, "Transaction").transaction;
  const guardrails = fxStr("s04.guardrailsHash");

  it("is a bundle v1 for an on-chain transaction: context, on_chain, defaults_applied, no stored verdict", () => {
    expect(bundle.cardano_debug_bundle).toBe(1);
    expect(bundle.network).toBe("mainnet");
    expect(bundle.tx_hash).toBe(fxStr("s04.txHash"));
    expect(txHashOfBytes(bundle.tx_cbor)).toBe(bundle.tx_hash);
    expect(fxStr("s04.txId")).toBe(`tx_mainnet_${bundle.tx_hash.slice(0, 12)}`);
    expect(bundle.validation_result).toBeUndefined();
    expect(bundle.slot).toBe(fxStr("s04.slot"));
    expect(bundle.protocol_major).toBe(10);
    expect(bundle.on_chain).toMatchObject({ slot: fxStr("s04.slot"), epoch: fxInt("s04.epoch"), block_height: fxInt("s04.blockHeight"), is_valid: true, source: "koios tx_cbor row" });
    expect(bundle.on_chain!.tx_bytes).toBe(bytesKey(bundle.tx_cbor));
    expect(isAllHex(bundle.on_chain!.block_hash, 64)).toBe(true);
    expect(bundle.defaults_applied!.length).toBeGreaterThanOrEqual(5);
    expect(bundle.defaults_applied![0]).toMatch(new RegExp(`^slot=${fxStr("s04.slot")}: the transaction is on chain`));
    // the context a proposal needs: the proposer's account, the active action it builds on, the last enacted one, the constitution, the treasury
    expect(ctx.accountContexts).toHaveLength(1);
    expect(ctx.accountContexts[0]!.bech32Address).toBe(fxStr("s04.returnAccount"));
    expect(ctx.govActionContexts).toHaveLength(1);
    expect(hex(ctx.govActionContexts[0]!.actionId.txHash)).toBe(fxStr("s04.activeActionTxHash"));
    expect(ctx.lastEnactedGovAction).toHaveLength(1);
    expect(hex(ctx.lastEnactedGovAction[0]!.actionId.txHash)).toBe(fxStr("s04.lastEnactedActionTxHash"));
    expect(ctx.constitution).toEqual({ guardrailScriptHash: guardrails });
    expect(BigInt(ctx.treasuryValue as unknown as number)).toBe(fxBig("s04.treasury"));
    expect(ctx.protocolParameters.protocolVersion[0]).toBe(10);
    expect(ctx.utxoSet).toHaveLength(2);
  });

  it("carries one proposal whose policy_hash is the guardrails script, one V3 witness script of that hash, redeemer `VotingProposal 0` with `Map []`", () => {
    expect(tx.body.voting_proposals).toHaveLength(1);
    const action = tx.body.voting_proposals[0].governance_action.ParameterChangeAction;
    expect(action.policy_hash).toBe(guardrails);
    expect(action.gov_action_id.transaction_id).toBe(fxStr("s04.activeActionTxHash"));
    // exactly one script in the witness set; the hash of a V3 script is blake2b-224 of 0x03 and its (single-wrapped) bytes
    expect(tx.witness_set.plutus_scripts).toHaveLength(1);
    const scriptBytes = hexToBytes(tx.witness_set.plutus_scripts[0].bytes);
    expect(Buffer.from(blake2b224(Buffer.concat([Buffer.from([3]), scriptBytes]))).toString("hex")).toBe(guardrails);
    expect(scriptBytes.length).toBe(fxInt("s04.guardrailsSize"));
    expect(tx.witness_set.native_scripts ?? []).toHaveLength(0);
    // redeemer tag 5 (the library says VotingProposal), index 0, data = the empty Plutus map
    expect(tx.witness_set.redeemers).toHaveLength(1);
    const redeemer = tx.witness_set.redeemers[0];
    expect(redeemer).toMatchObject({ tag: "VotingProposal", index: "0" });
    expect(JSON.parse(redeemer.data)).toEqual({ map: [] });
    expect(fxStr("s04.proposalPolicyHash")).toBe(guardrails);
    expect(tx.body.collateral).toHaveLength(1);
    expect(tx.body.collateral_return).toBeTruthy();
    expect(tx.witness_set.vkeys).toHaveLength(1);
  });

  it("validates with zero diagnostics, declared ex-units equal to the calculated ones", () => {
    const result = validate(bundle.tx_cbor, ctx);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.phase2_errors).toEqual([]);
    expect(result.phase2_warnings).toEqual([]);
    expect(allDiagnostics(result)).toBe(0);
    expect(result.eval_redeemer_results).toHaveLength(1);
    const run = result.eval_redeemer_results[0]!;
    expect(run).toMatchObject({ tag: "Propose", index: 0, success: true, plutus_version: "V3" });
    expect(String(run.provided_ex_units.mem)).toBe(String(run.calculated_ex_units!.mem));
    expect(String(run.provided_ex_units.steps)).toBe(String(run.calculated_ex_units!.steps));
    expect({ mem: String(run.provided_ex_units.mem), steps: String(run.provided_ex_units.steps) }).toEqual(fx("s04.exUnits"));
    // the redeemer data is the empty Plutus map
    expect(run.redeemer_bytes).toBe("a0");
  });
});

describe("S5: a stake pool vote on a security-group ParameterChange", () => {
  const bundle = readFixtureJson<Bundle>(fxStr("s05.bundleFile"));
  const ctx = bundle.validation_input_context;
  const tx = decodeType<{ transaction: Json }>(bundle.tx_cbor, "Transaction").transaction;
  const names = fxArr<string>("s05.securityParameters");

  it("the transaction: 11 key inputs, 1 output, a withdrawal, 3 vkey witnesses and one pool vote Yes with an anchor", () => {
    expect(bundle.tx_hash).toBe(fxStr("s05.txHash"));
    expect(txHashOfBytes(bundle.tx_cbor)).toBe(bundle.tx_hash);
    expect(tx.body.inputs).toHaveLength(fxInt("s05.inputCount"));
    expect(tx.body.outputs).toHaveLength(1);
    expect(tx.witness_set.vkeys).toHaveLength(fxInt("s05.vkeyCount"));
    expect(Object.values(tx.body.withdrawals)).toEqual([fxBig("s05.withdrawal.requested").toString()]);
    expect(tx.body.voting_procedures).toHaveLength(1);
    const voter = tx.body.voting_procedures[0];
    expect(voter.voter).toEqual({ StakingPool: fxStr("s05.voterPoolHash") });
    expect(voter.votes).toHaveLength(1);
    expect(voter.votes[0].action_id).toEqual({ transaction_id: fxStr("s05.govActionTxHash"), index: 0 });
    expect(voter.votes[0].voting_procedure.vote).toBe("Yes");
    expect(voter.votes[0].voting_procedure.anchor.anchor_url).toMatch(/^https:\/\/example\.invalid\//);
    expect(tx.witness_set.redeemers ?? []).toHaveLength(0);
  });

  it("the context predates changedParameters: one account, one pool, one parameterChangeAction without names, the artificial guardrails hash, PV11", () => {
    expect(bundle.protocol_major).toBe(11);
    expect(ctx.protocolParameters.protocolVersion[0]).toBe(11);
    expect(ctx.accountContexts).toHaveLength(1);
    expect(ctx.accountContexts[0]!.balance).toBe(fxNum("s05.withdrawal.expected"));
    expect(ctx.poolContexts).toEqual([{ poolId: fxStr("s05.voterPoolHash"), isRegistered: true, retirementEpoch: null }]);
    expect(ctx.govActionContexts).toHaveLength(1);
    expect(ctx.govActionContexts[0]).toMatchObject({ actionType: "parameterChangeAction", isActive: true });
    expect(ctx.govActionContexts[0]!.changedParameters).toBeUndefined();
    expect(hex(ctx.govActionContexts[0]!.actionId.txHash)).toBe(fxStr("s05.govActionTxHash"));
    expect(ctx.constitution).toEqual({ guardrailScriptHash: fxStr("s05.guardrailsHash") });
    expect(ctx.utxoSet).toHaveLength(11);
    expect(ctx.utxoSet.every((u) => u.isSpent)).toBe(true);
  });

  it("the provider's proposal row names exactly the four security-group execution-unit limits", () => {
    const rows = bundle.provider_rows!.proposals as Array<Json>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ proposal_type: "ParameterChange", proposal_tx_hash: fxStr("s05.govActionTxHash"), proposal_index: 0 });
    expect(Object.keys(rows[0]!.param_proposal).sort()).toEqual([...names].sort());
    expect(names).toEqual(["max_block_ex_mem", "max_block_ex_steps", "max_tx_ex_mem", "max_tx_ex_steps"]);
    expect(rows[0]!.proposal_id).toBe(fxStr("s05.govActionId"));
  });

  it("the stored verdict is what the validator says about that very context: it contains DisallowedVoters and the wrong withdrawal", () => {
    const stored = bundle.validation_result!;
    const fresh = validate(bundle.tx_cbor, ctx);
    expect(errorKinds(fresh)).toEqual(fxArr<string>("s05.storedErrors"));
    expect(stored.errors.map((e) => Object.keys(e.error)[0])).toEqual(errorKinds(fresh));
    expect(errorKinds(fresh)).toContain("DisallowedVoters");
    expect(errorKinds(fresh)).toContain("WrongRequestedWithdrawalAmount");
    expect(errorKinds(fresh).filter((k) => k === "BadInputsUTxO")).toHaveLength(11);
    expect(errorKinds(fresh)).toHaveLength(fxInt("s05.storedErrorCount"));
    const wrong = fresh.errors.find((e) => "WrongRequestedWithdrawalAmount" in (e.error as object))!.error as { WrongRequestedWithdrawalAmount: { expected_amount: number | string; requested_amount: number | string } };
    expect(String(wrong.WrongRequestedWithdrawalAmount.expected_amount)).toBe(String(fxNum("s05.withdrawal.expected")));
    expect(String(wrong.WrongRequestedWithdrawalAmount.requested_amount)).toBe(fxBig("s05.withdrawal.requested").toString());
  });

  it("with the security-group names the vote is allowed; with other names (min_pool_cost, drep_deposit) it is DisallowedVoters", () => {
    const named = structuredClone(ctx);
    named.govActionContexts[0]!.changedParameters = [...names];
    expect(errorKinds(validate(bundle.tx_cbor, named))).not.toContain("DisallowedVoters");
    expect(fxArr<string>("s05.errorsWithNames")).not.toContain("DisallowedVoters");
    const other = structuredClone(ctx);
    other.govActionContexts[0]!.changedParameters = fxArr<string>("s05.otherParameters");
    expect(fxArr<string>("s05.otherParameters")).toEqual(["min_pool_cost", "drep_deposit"]);
    expect(errorKinds(validate(bundle.tx_cbor, other))).toContain("DisallowedVoters");
  });
});

describe("S6: an on-chain transaction as a provider-cache snapshot", () => {
  const dir = fixturePath(fxStr("s06.cacheDir"));
  const readRow = <T = Json>(rel: string): T => JSON.parse(readFileSync(path.join(dir, rel), "utf8")) as T;
  const walk = (base: string): string[] =>
    readdirSync(base).flatMap((name) => {
      const full = path.join(base, name);
      return statSync(full).isDirectory() ? walk(full).map((f) => `${name}/${f}`) : [name];
    });
  const files = walk(dir).sort();
  const slot = Number(fxBig("s06.slot"));
  const epoch = fxInt("s06.epoch");
  const txRow = readRow(`tx/mainnet/koios/${fxStr("s06.txHash")}.json`);
  const refs = [...fxArr<string>("s06.inputs"), ...fxArr<string>("s06.referenceInputs")];
  const rowFile = (ref: string) => `utxo/mainnet/koios/${ref.replace("#", "_")}.json`;

  it("holds exactly the rows the server requests: the tx, the 7 UTxOs, the account, epoch params and totals of the epoch, committee and constitution", () => {
    expect(files).toEqual(
      [
        `tx/mainnet/koios/${fxStr("s06.txHash")}.json`,
        ...refs.map(rowFile),
        `epoch_params/mainnet/koios/${epoch}.json`,
        `rows/mainnet/koios/account_info/${fxStr("s06.rewardAccount")}.json`,
        "rows/mainnet/koios/committee_info/current.json",
        "rows/mainnet/koios/constitution/current.json",
        `rows/mainnet/koios/totals/${epoch}.json`,
      ].sort(),
    );
    expect(files).toHaveLength(fxInt("s06.cacheFileCount"));
    expect(fxInt("s06.utxoCount")).toBe(7);
    // every file is in the manifest's list of generated files
    const listed = fxArr<string>("_files");
    for (const f of files) expect(listed).toContain(`${fxStr("s06.cacheDir")}/${f}`);
  });

  it("the tx row is the included transaction: its hash is the body hash, the facts are the manifest's, valid_contract", () => {
    expect(txRow.tx_hash).toBe(fxStr("s06.txHash"));
    expect(txHashOfBytes(txRow.cbor)).toBe(txRow.tx_hash);
    expect(txRow).toMatchObject({ block_height: fxInt("s06.blockHeight"), epoch_no: epoch, absolute_slot: slot, tx_timestamp: fxInt("s06.timestamp"), valid_contract: true, block_hash: fxStr("s06.blockHash") });
    expect(fxStr("s06.txId")).toBe(`tx_mainnet_${txRow.tx_hash.slice(0, 12)}`);
    expect((txRow.cbor as string).length / 2).toBe(fxInt("s06.size"));
  });

  it("the transaction: 3 inputs, 4 reference inputs, scripts only by reference, 3 redeemers, a zero withdrawal, one signer, validity around the slot", () => {
    const tx = decodeType<{ transaction: Json }>(txRow.cbor, "Transaction").transaction;
    expect(tx.body.inputs).toHaveLength(3);
    expect(tx.body.reference_inputs).toHaveLength(4);
    expect(tx.body.collateral).toHaveLength(1);
    expect(tx.body.collateral_return).toBeTruthy();
    expect(BigInt(tx.body.total_collateral)).toBe(fxBig("s06.collateral.total"));
    expect(BigInt(tx.body.total_collateral) * 100n).toBeGreaterThanOrEqual(BigInt(tx.body.fee) * 150n);
    expect(Object.values(tx.body.withdrawals)).toEqual(["0"]);
    expect(Object.keys(tx.body.withdrawals)).toEqual([fxStr("s06.rewardAccount")]);
    expect(tx.body.required_signers).toEqual([fxStr("s06.signerKeyHash")]);
    expect(BigInt(tx.body.validity_start_interval)).toBeLessThan(BigInt(slot));
    expect(BigInt(tx.body.ttl)).toBeGreaterThan(BigInt(slot));
    expect(tx.witness_set.vkeys).toHaveLength(fxInt("s06.vkeyCount"));
    expect(tx.witness_set.redeemers).toHaveLength(3);
    // no script is in the witness set: all three come from reference inputs
    for (const key of ["plutus_scripts", "plutus_scripts_v1", "plutus_scripts_v2", "plutus_scripts_v3", "native_scripts"]) expect(tx.witness_set[key] ?? []).toHaveLength(0);
    expect(tx.witness_set.plutus_data ?? []).toHaveLength(0);
    expect(fxArr<string>("s06.redeemerRefs")).toEqual(["spend:1", "spend:2", "withdraw:0"]);
  });

  it("the UTxO rows: the three inputs are spent, the four reference inputs are not; the reference scripts are the registry's V2 scripts with inline datums on the inputs", () => {
    const spent = new Set(fxArr<string>("s06.inputs"));
    for (const ref of refs) {
      const row = readRow(rowFile(ref));
      expect(`${row.tx_hash}#${row.tx_index}`).toBe(ref);
      expect(row.is_spent, ref).toBe(spent.has(ref));
    }
    const scripts = fx<Record<string, { hash: string; plutusVersion: string; size: number; referenceInput: string }>>("s06.scripts");
    for (const s of Object.values(scripts)) {
      const row = readRow(rowFile(s.referenceInput));
      expect(row.reference_script).toMatchObject({ hash: s.hash, type: "plutusV2", size: s.size });
      expect(Buffer.from(blake2b224(Buffer.concat([Buffer.from([2]), hexToBytes(row.reference_script.bytes)]))).toString("hex")).toBe(s.hash);
    }
    // each spent script input has an inline datum (Koios also reports its hash, which is the blake2b-256 of the datum bytes)
    for (const ref of spent) {
      const row = readRow(rowFile(ref));
      if (row.payment_cred === fxStr("s06.signerKeyHash")) continue;
      expect(row.inline_datum.bytes).toMatch(/^d8799f|^d879/);
      expect(row.datum_hash).toBe(Buffer.from(blake2b256(hexToBytes(row.inline_datum.bytes))).toString("hex"));
    }
  });

  it("the epoch rows: parameters of protocol major 10 for the epoch, totals of the epoch, an account that is registered with no rewards", () => {
    const params = readRow<Json[]>(`epoch_params/mainnet/koios/${epoch}.json`);
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({ epoch_no: epoch, protocol_major: fxInt("s06.protocolMajor") });
    const totals = readRow<Json[]>(`rows/mainnet/koios/totals/${epoch}.json`);
    expect(totals[0]).toMatchObject({ epoch_no: epoch, treasury: fxBig("s06.treasury").toString() });
    const account = readRow(`rows/mainnet/koios/account_info/${fxStr("s06.rewardAccount")}.json`);
    expect(account).toMatchObject({ stake_address: fxStr("s06.rewardAccount"), status: "registered", rewards: "0" });
    expect(readRow<Json[]>("rows/mainnet/koios/committee_info/current.json")[0]!.members).toHaveLength(7);
    expect(readRow("rows/mainnet/koios/constitution/current.json").constitution.guardrailScriptHash).toBe(fxStr("s04.guardrailsHash"));
  });
});

describe("S6 replayed in process: fully valid at the inclusion slot, from the cache alone", () => {
  let stub: Stub;
  let t: TestContext;
  let saved: string | undefined;

  beforeAll(async () => {
    stub = await startStub((_req, res) => json(res, [], 404));
    saved = process.env.CARDANO_DEBUG_KOIOS_URL_MAINNET;
    process.env.CARDANO_DEBUG_KOIOS_URL_MAINNET = `${stub.url}/api/v1`;
    const cacheDir = tempDir("cdm-s06-unit-");
    cpSync(fixturePath(fxStr("s06.cacheDir")), cacheDir, { recursive: true });
    t = makeContext({ CARDANO_DEBUG_CACHE_DIR: cacheDir });
  });

  afterAll(async () => {
    await t.shutdown();
    if (saved === undefined) delete process.env.CARDANO_DEBUG_KOIOS_URL_MAINNET;
    else process.env.CARDANO_DEBUG_KOIOS_URL_MAINNET = saved;
    await stub.close();
  });

  it("tx_load: on chain at the manifest's point, 3 inputs / 4 reference inputs, three redeemers aimed at spends and the withdrawal", async () => {
    const load = await txLoad(t.ctx, { tx_hash: fxStr("s06.txHash"), network: "mainnet" });
    expect(load.isError, JSON.stringify(load.structuredContent)).toBeFalsy();
    const s = load.structuredContent as Json;
    expect(s.tx_id).toBe(fxStr("s06.txId"));
    expect(s.on_chain).toMatchObject({ slot: fxStr("s06.slot"), epoch: fxInt("s06.epoch"), block_height: fxInt("s06.blockHeight"), is_valid: true });
    expect(s.counts).toMatchObject({ inputs: 3, reference_inputs: 4, collateral: 1, outputs: 3, withdrawals: 1, redeemers: 3, witness_scripts: 0, vkey_witnesses: 1 });
    expect((s.redeemers as Json[]).map((r) => r.ref)).toEqual(fxArr<string>("s06.redeemerRefs"));
    expect((s.redeemers as Json[]).every((r) => r.plutus_version === "V2")).toBe(true);
    expect((s.redeemers as Json[]).map((r) => r.script_hash)).toEqual([fx("s06.scripts.spend2.hash"), fx("s06.scripts.spend.hash"), fx("s06.scripts.reward.hash")]);
    expect(s.missing_utxos).toEqual([]);
    expect(stub.requests).toEqual([]);
  });

  it("tx_validate: no phase-1 error or warning, no phase-2 error, every redeemer succeeds within its declared units, protocol major 10", async () => {
    const result = await txValidate(t.ctx, { tx_id: fxStr("s06.txId") });
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    const s = result.structuredContent as Json;
    expect(s.verdict).toBe("valid");
    expect(s.phase1.errors).toEqual([]);
    expect(s.phase1.warnings ?? []).toEqual([]);
    expect(s.phase2.errors).toEqual([]);
    const rows = s.phase2.redeemers as Json[];
    expect(rows.map((r) => r.ref)).toEqual(fxArr<string>("s06.redeemerRefs"));
    for (const row of rows) {
      expect(row.success, row.ref).toBe(true);
      expect(row.ex_units.verdict, row.ref).not.toBe("over_budget");
    }
    // the declared units of the withdrawal are the manifest's
    expect(rows.find((r) => r.ref === fxStr("s06.withdrawRef"))!.ex_units.declared).toEqual(fx("s06.withdrawExUnits"));
    expect(stub.requests).toEqual([]);
  });

  it("the cache directory is a real snapshot: nothing in it is the manifest itself", () => {
    expect(existsSync(path.join(fixturePath(fxStr("s06.cacheDir")), "manifest.json"))).toBe(false);
    expect(Object.keys(manifest()).filter((k) => k.startsWith("s06.")).length).toBeGreaterThan(20);
    expect(readFixtureText(fxStr("s06.txRowFile")).length).toBeGreaterThan(1000);
  });
});
