import { describe, expect, it } from "vitest";

import { keyCred, scriptCred } from "../../fixtures/synthetic/lib/address.js";
import { blake2b256 } from "../../fixtures/synthetic/lib/blake2b.js";
import { bytesToHex, hexToBytes } from "../../fixtures/synthetic/lib/bytes.js";
import { bytes, decode, toPlain, uint, encode } from "../../fixtures/synthetic/lib/cbor.js";
import { drepKey, poolKey, ccColdKey, ccHotKey } from "../../fixtures/synthetic/lib/keys.js";
import { paramSet, protocolParameters } from "../../fixtures/synthetic/lib/params.js";
import { constr, pInt, UNIT } from "../../fixtures/synthetic/lib/plutusData.js";
import { languageViewsBytes, scriptDataHash, scriptDataPreimage } from "../../fixtures/synthetic/lib/scriptData.js";
import { native, scriptCbor, scriptHash, scriptSize, nativeScriptBytes, deepNativeScriptBytes, hashScriptBytes } from "../../fixtures/synthetic/lib/script.js";
import {
  addressBytes,
  assemble,
  auxDataHashOf,
  compareAccounts,
  metadatumCbor,
  outputCbor,
  parseRef,
  refOf,
  resolveTarget,
  sortIns,
  txHashOfBytes,
  txin,
  type TxSpec,
} from "../../fixtures/synthetic/lib/tx.js";
import { cborToJson, decodeType } from "../../fixtures/synthetic/lib/validator.js";
import { alice, aliceAddr, aliceStakeAddr, bobAddr, h, scriptStakeAddress, succeeds } from "./world.js";

const plain = (spec: Partial<TxSpec> = {}): TxSpec => ({
  inputs: [txin(h("in"), 0)],
  outputs: [{ address: aliceAddr, value: { coin: 5_000_000n } }],
  fee: 200_000n,
  ...spec,
});

interface Node {
  type: string;
  position_info: { offset: number; length: number };
  struct_position_info?: { offset: number; length: number };
  values?: Array<Node & { key?: Node; value?: Node }>;
  oddities?: Array<{ kind: string }>;
  tag?: string;
  value?: Node;
}
const tree = (hex: string): Node => (cborToJson(hex) as unknown as { value: Node }).value;

describe("assemble: a transaction as bytes", () => {
  it("is [body, witness set, true, null] with the id = blake2b-256 of the body bytes", () => {
    const t = assemble(plain());
    expect(t.hex.startsWith("84a3")).toBe(true);
    expect(t.hex.endsWith("a0f5f6")).toBe(true);
    expect(t.txHash).toBe(bytesToHex(blake2b256(t.bodyBytes)));
    expect(txHashOfBytes(t.bytes)).toBe(t.txHash);
    expect(decodeType<{ transaction_hash: string }>(t.hex, "Transaction").transaction_hash).toBe(t.txHash);
    expect(t.size).toBe(t.bytes.length);
  });

  it("is_valid false, a witness-set hook and the tx hook", () => {
    const t = assemble(plain({ isValid: false }));
    expect(t.hex.endsWith("a0f4f6")).toBe(true);
    // the tx hook rewrites the finished array (here: one element more); the body hash was computed before it
    const wrapped = assemble(plain({ encoding: { onTx: (tx) => (tx.t === "array" ? { ...tx, items: [...tx.items, uint(1)] } : tx) } }));
    expect(wrapped.hex.startsWith("85")).toBe(true);
    expect(tree(wrapped.hex).values).toHaveLength(5);
    expect(wrapped.txHash).toBe(assemble(plain()).txHash);
  });

  it("is deterministic", () => {
    expect(assemble(plain()).hex).toBe(assemble(plain()).hex);
  });
});

describe("assemble: every field the Conway body has, decoded by the library", () => {
  const st = alice.stake;
  const poolHash = poolKey("test-pool").keyHashHex;
  const dk = drepKey("test-drep");
  const nat = native({ type: "sig", keyHash: alice.pay.keyHashHex });
  const policy = scriptHash(nat);
  const v2 = succeeds(2);
  const spec: TxSpec = {
    inputs: [txin(h("i2"), 1), txin(h("i1"), 0)],
    referenceInputs: [txin(h("r1"), 0)],
    outputs: [
      { address: aliceAddr, value: { coin: 5_000_000n, assets: { [policy]: { "41": 3n } } }, datumHash: h("dh") },
      { address: bobAddr, value: { coin: 6_000_000n }, inlineDatum: constr(0, [pInt(1)]), scriptRef: v2 },
    ],
    fee: 200_000n,
    ttl: 1000n,
    validityStart: 10n,
    certs: [
      { kind: "stakeReg", cred: keyCred(st) },
      { kind: "stakeReg", cred: keyCred(st), deposit: 2_000_000n },
      { kind: "stakeDelegate", cred: keyCred(st), pool: poolHash },
      { kind: "voteDelegate", cred: keyCred(st), drep: { kind: "abstain" } },
      { kind: "drepReg", cred: keyCred(dk), deposit: 500_000_000n, anchor: { url: "https://example.invalid/a.json", hash: h("anchor") } },
      { kind: "committeeAuth", cold: keyCred(ccColdKey("c")), hot: keyCred(ccHotKey("c")) },
      { kind: "poolRetire", pool: poolHash, epoch: 600 },
    ],
    withdrawals: [{ account: aliceStakeAddr, amount: 0n }],
    mint: [{ policy, assets: { "41": 3n, "42": -2n } }],
    aux: { metadata: [[674n, new Map([["msg", ["hi"]]])]] },
    collateral: [txin(h("c1"), 2)],
    collateralReturn: { address: aliceAddr, value: { coin: 3_000_000n } },
    totalCollateral: 300_000n,
    requiredSigners: [alice.pay.keyHashHex],
    networkId: 1,
    votes: [{ voter: { kind: "spo", hash: poolHash }, actions: [{ id: { txHash: h("ga"), index: 1 }, vote: 1, anchor: { url: "https://example.invalid/v.json", hash: h("va") } }] }],
    proposals: [
      {
        deposit: 100_000_000_000n,
        rewardAccount: aliceStakeAddr,
        anchor: { url: "https://example.invalid/p.json", hash: h("pa") },
        action: { type: "parameterChange", update: [[16, uint(170_000_000)]], policyHash: h("guard").slice(0, 56) },
      },
    ],
    treasuryValue: 123_456n,
    donation: 1_000_000n,
    signers: [alice.pay],
    encoding: { sets: true },
  };
  const t = assemble(spec);
  const dec = decodeType<{ transaction: { body: Record<string, any>; witness_set: Record<string, any>; auxiliary_data: any } }>(t.hex, "Transaction").transaction;

  it("reads as a Conway transaction", () => {
    const b = dec.body;
    expect(b.inputs.map((i: any) => [i.transaction_id, i.index])).toEqual(sortIns(spec.inputs).map((i) => [i.txHash, i.index]));
    expect(b.reference_inputs).toHaveLength(1);
    expect(b.fee).toBe("200000");
    expect(b.ttl).toBe("1000");
    expect(b.validity_start_interval).toBe("10");
    expect(b.network_id).toBe("Mainnet");
    expect(b.total_collateral).toBe("300000");
    expect(b.current_treasury_value).toBe("123456");
    expect(b.donation).toBe("1000000");
    expect(b.required_signers).toEqual([alice.pay.keyHashHex]);
    expect(b.collateral_return.amount.coin).toBe("3000000");
    expect(b.auxiliary_data_hash).toBe(auxDataHashOf(spec.aux!));
    expect(b.certs.map((c: object) => Object.keys(c)[0])).toEqual(["StakeRegistration", "StakeRegistration", "StakeDelegation", "VoteDelegation", "DRepRegistration", "CommitteeHotAuth", "PoolRetirement"]);
    expect(b.certs[1].StakeRegistration.coin).toBe("2000000");
    expect(Object.values(b.withdrawals)).toEqual(["0"]);
    expect(b.mint[0][1]).toEqual({ "41": "3", "42": "-2" });
    expect(b.voting_procedures[0].voter).toEqual({ StakingPool: poolHash });
    expect(b.voting_procedures[0].votes[0].voting_procedure.vote).toBe("Yes");
    expect(b.voting_proposals[0].deposit).toBe("100000000000");
    expect(b.voting_proposals[0].governance_action.ParameterChangeAction.protocol_param_updates.min_pool_cost).toBe("170000000");
    expect(b.voting_proposals[0].governance_action.ParameterChangeAction.policy_hash).toBe(h("guard").slice(0, 56));
  });

  it("outputs: legacy array with a datum hash, map form with an inline datum and a script reference", () => {
    const [o0, o1] = dec.body.outputs;
    expect(o0.plutus_data).toEqual({ DataHash: h("dh") });
    expect(o0.amount.multiasset[policy]).toEqual({ "41": "3" });
    expect(o1.plutus_data.Data).toBe('{"constructor":0,"fields":[{"int":1}]}');
    expect(o1.script_ref.PlutusScript.language).toBe("PlutusV2");
    const t0 = tree(t.hex);
    const outputs = t0.values![0]!.values!.find((e) => (e.key as Node).value === (1 as unknown as never))!.value!;
    expect(outputs.values![0]!.type).toBe("Array");
    expect(outputs.values![1]!.type).toBe("Map");
  });

  it("metadata and the aux data hash", () => {
    expect(Object.keys(dec.auxiliary_data.metadata)).toEqual(["674"]);
    expect(auxDataHashOf(spec.aux!)).toHaveLength(64);
    expect(() => metadatumCbor("x".repeat(65))).toThrow(/over 64 bytes/);
    expect(() => metadatumCbor(new Uint8Array(65))).toThrow(/over 64 bytes/);
    expect(toPlain(metadatumCbor(new Map<any, any>([[1, [2n, "a", Uint8Array.of(1)]]])))).toEqual({ map: [[1n, [2n, "a", "01"]]] });
  });

  it("vkey witness verifies against the body hash", () => {
    const w = dec.witness_set.vkeys[0];
    expect(w.signature).toHaveLength(128);
    expect(alice.pay.verify(hexToBytes(t.txHash), hexToBytes(w.signature))).toBe(true);
  });
});

describe("ledger ordering", () => {
  it("inputs are sorted by (tx id bytes, index); keepOrder keeps the given order", () => {
    const a = txin("ff".repeat(32), 0);
    const b = txin("00".repeat(31) + "01", 5);
    const c = txin("00".repeat(31) + "01", 2);
    expect(assemble(plain({ inputs: [a, b, c] })).inputs.map(refOf)).toEqual([c, b, a].map(refOf));
    expect(assemble(plain({ inputs: [a, b, c], encoding: { keepOrder: true } })).inputs.map(refOf)).toEqual([a, b, c].map(refOf));
    const dec = decodeType<{ transaction: { body: { inputs: Array<{ index: number }> } } }>(assemble(plain({ inputs: [a, b, c] })).hex, "Transaction");
    expect(dec.transaction.body.inputs.map((i) => i.index)).toEqual([2, 5, 0]);
  });

  it("mint policies by hash bytes, withdrawals with script credentials before key credentials, voters by kind", () => {
    const t = assemble(
      plain({
        mint: [
          { policy: "ff".repeat(28), assets: { "01": 1n } },
          { policy: "00".repeat(28), assets: { "01": 1n } },
        ],
        withdrawals: [
          { account: aliceStakeAddr, amount: 1n },
          { account: scriptStakeAddress("ee".repeat(28)), amount: 0n },
        ],
        votes: [
          { voter: { kind: "spo", hash: "11".repeat(28) }, actions: [{ id: { txHash: h("g"), index: 0 }, vote: 0 }] },
          { voter: { kind: "drep", cred: keyCred(alice.pay) }, actions: [{ id: { txHash: h("g"), index: 0 }, vote: 0 }] },
          { voter: { kind: "cc", cred: scriptCred("22".repeat(28)) }, actions: [{ id: { txHash: h("g"), index: 0 }, vote: 0 }] },
        ],
      }),
    );
    expect(t.mintPolicies).toEqual(["00".repeat(28), "ff".repeat(28)]);
    expect(t.withdrawalAccounts.map((a) => a[0])).toEqual([0xf1, 0xe1]);
    expect(t.voters.map((v) => v.kind)).toEqual(["cc", "drep", "spo"]);
    expect(compareAccounts(addressBytes(aliceStakeAddr), addressBytes(scriptStakeAddress("ee".repeat(28))))).toBeGreaterThan(0);
  });

  it("redeemer targets resolve to indices in that order; a target outside the transaction is an error", () => {
    const sc = succeeds(2);
    const policy = scriptHash(sc);
    const i1 = txin("aa".repeat(32), 0);
    const i2 = txin("11".repeat(32), 7);
    const spec = plain({
      inputs: [i1, i2],
      mint: [{ policy, assets: { "01": 1n } }],
      withdrawals: [{ account: scriptStakeAddress(policy), amount: 0n }],
      certs: [{ kind: "stakeDereg", cred: scriptCred(policy) }],
      proposals: [{ deposit: 1n, rewardAccount: aliceStakeAddr, anchor: { url: "x", hash: h("a") }, action: { type: "info" } }],
      votes: [{ voter: { kind: "drep", cred: scriptCred(policy) }, actions: [{ id: { txHash: h("g"), index: 0 }, vote: 1 }] }],
    });
    expect(resolveTarget(spec, { tag: "spend", input: i2 })).toEqual({ tagNumber: 0, index: 0 });
    expect(resolveTarget(spec, { tag: "spend", input: i1 })).toEqual({ tagNumber: 0, index: 1 });
    expect(resolveTarget(spec, { tag: "mint", policy })).toEqual({ tagNumber: 1, index: 0 });
    expect(resolveTarget(spec, { tag: "cert", index: 0 })).toEqual({ tagNumber: 2, index: 0 });
    expect(resolveTarget(spec, { tag: "reward", account: scriptStakeAddress(policy) })).toEqual({ tagNumber: 3, index: 0 });
    expect(resolveTarget(spec, { tag: "vote", voter: { kind: "drep", cred: scriptCred(policy) } })).toEqual({ tagNumber: 4, index: 0 });
    expect(resolveTarget(spec, { tag: "propose", index: 0 })).toEqual({ tagNumber: 5, index: 0 });
    expect(resolveTarget(spec, { tag: "raw", redeemerTag: 1, index: 9 })).toEqual({ tagNumber: 1, index: 9 });
    expect(() => resolveTarget(spec, { tag: "spend", input: txin("bb".repeat(32), 0) })).toThrow(/not an input/);
    expect(() => resolveTarget(spec, { tag: "mint", policy: "cc".repeat(28) })).toThrow(/does not mint/);
    expect(parseRef(refOf(i2))).toEqual(i2);
  });

  it("redeemers are written sorted by (tag, index); the library reads their indices back", () => {
    const sc = succeeds(2);
    const policy = scriptHash(sc);
    const i1 = txin("aa".repeat(32), 0);
    const i2 = txin("11".repeat(32), 7);
    const t = assemble(
      plain({
        inputs: [i1, i2],
        mint: [{ policy, assets: { "01": 1n } }],
        plutusScripts: [sc],
        redeemers: [
          { target: { tag: "mint", policy }, data: pInt(2), exUnits: { mem: 11, steps: 21 } },
          { target: { tag: "spend", input: i1 }, data: pInt(1), exUnits: { mem: 10, steps: 20 } },
        ],
      }),
      { params: protocolParameters("pv10") },
    );
    const dec = decodeType<{ transaction: { witness_set: { redeemers: Array<{ tag: string; index: string }> } } }>(t.hex, "Transaction").transaction.witness_set.redeemers;
    expect(dec.map((r) => [r.tag, r.index])).toEqual([["Spend", "1"], ["Mint", "0"]]);
  });
});

describe("encoding options", () => {
  const top = (hex: string) => tree(hex).values![0]!;
  const bodyValue = (hex: string, key: number) => top(hex).values!.find((e) => (e.key as Node).value === (key as never))!.value!;

  it("tag 258 on the set fields, per field or all; default none (witness datums excepted)", () => {
    const sc = succeeds(2);
    const spec = plain({
      referenceInputs: [txin(h("r"), 0)],
      collateral: [txin(h("c"), 0)],
      requiredSigners: [alice.pay.keyHashHex],
      certs: [{ kind: "stakeReg", cred: keyCred(alice.stake) }],
      plutusScripts: [sc],
      datums: [pInt(1)],
      redeemers: [{ target: { tag: "spend", input: txin(h("in"), 0) }, data: UNIT, exUnits: { mem: 1, steps: 1 } }],
      signers: [alice.pay],
    });
    const isTag = (n: Node) => n.type === "Tag" && n.tag === "Unassigned(258)";
    const none = assemble(spec, { params: protocolParameters("pv10") }).hex;
    for (const k of [0, 4, 13, 14, 18]) expect(isTag(bodyValue(none, k))).toBe(false);
    const witness = (hex: string, key: number) => tree(hex).values![1]!.values!.find((e) => (e.key as Node).value === (key as never))!.value!;
    expect(isTag(witness(none, 0))).toBe(false);
    expect(isTag(witness(none, 4))).toBe(true); // datums: tagged by default (the validator rebuilds the script data hash that way)
    const all = assemble({ ...spec, encoding: { sets: true } }, { params: protocolParameters("pv10") }).hex;
    for (const k of [0, 4, 13, 14, 18]) expect(isTag(bodyValue(all, k))).toBe(true);
    expect(isTag(witness(all, 0))).toBe(true);
    expect(isTag(witness(all, 6))).toBe(true);
    const some = assemble({ ...spec, encoding: { sets: { inputs: true, datums: false } } }, { params: protocolParameters("pv10") }).hex;
    expect(isTag(bodyValue(some, 0))).toBe(true);
    expect(isTag(bodyValue(some, 13))).toBe(false);
    expect(isTag(witness(some, 4))).toBe(false);
  });

  it("outputs: legacy and map form, forced", () => {
    const legacy = assemble(plain({ outputs: [{ address: aliceAddr, value: { coin: 1_000_000n }, form: "legacy" }, { address: aliceAddr, value: { coin: 1_000_000n }, form: "map" }] })).hex;
    const outs = bodyValue(legacy, 1);
    expect(outs.values![0]!.type).toBe("Array");
    expect(outs.values![1]!.type).toBe("Map");
    expect(() => outputCbor({ address: aliceAddr, value: { coin: 1n }, inlineDatum: UNIT, form: "legacy" })).toThrow(/legacy output/);
    expect(() => outputCbor({ address: aliceAddr, value: { coin: "min" } })).toThrow(/min/);
    expect(() => outputCbor({ address: aliceAddr, value: { coin: 1n }, datumHash: h("a"), inlineDatum: UNIT, form: "map" })).toThrow(/either/);
  });

  it("redeemers as the Conway map (default) or the legacy array", () => {
    const base = plain({ plutusScripts: [succeeds(2)], redeemers: [{ target: { tag: "spend", input: txin(h("in"), 0) }, data: UNIT, exUnits: { mem: 1, steps: 1 } }] });
    const witness = (hex: string) => tree(hex).values![1]!.values!.find((e) => (e.key as Node).value === (5 as never))!.value!;
    expect(witness(assemble(base, { params: protocolParameters("pv10") }).hex).type).toBe("Map");
    expect(witness(assemble({ ...base, encoding: { redeemers: "array" } }, { params: protocolParameters("pv10") }).hex).type).toBe("Array");
  });

  it("odd encodings the CBOR tests want: indefinite containers, forced widths, key order, extra keys", () => {
    const t = assemble(
      plain({
        encoding: {
          indefinite: { tx: true, body: true, outputs: true, inputs: true },
          widths: { fee: 8 },
          bodyKeyOrder: [2, 1, 0],
          onBody: (entries) => [...entries, [uint(99), uint(1)]],
        },
      }),
    );
    const root = tree(t.hex);
    expect(root.oddities?.map((o) => o.kind)).toContain("IndefiniteLength");
    const body = root.values![0]!;
    expect(body.oddities?.map((o) => o.kind)).toContain("IndefiniteLength");
    const keys = body.values!.filter((e) => e.key).map((e) => (e.key as Node).value);
    expect(keys).toEqual([2, 1, 0, 99]);
    expect(bodyValue(t.hex, 2).oddities?.map((o) => o.kind)).toEqual(["IntNotShortest"]);
    // the signature-relevant body hash is computed over the odd bytes
    expect(t.txHash).toBe(bytesToHex(blake2b256(t.bodyBytes)));
    expect(t.txHash).toBe(txHashOfBytes(t.bytes));
  });

  it("spans of the whole tx, body, every body key and value, the witness set, is_valid and aux (absolute offsets)", () => {
    const t = assemble(plain({ ttl: 5n }));
    const root = tree(t.hex);
    expect(t.spans.body).toEqual({ offset: 1, length: root.values![0]!.struct_position_info!.length });
    const lib = (n: Node) => (n.struct_position_info ?? n.position_info);
    const b = root.values![0]!;
    for (const [i, e] of b.values!.entries()) {
      const k = (e.key as Node).value as unknown as number;
      expect(t.spans[`body.key.${k}`]).toEqual({ offset: lib(e.key as Node).offset, length: lib(e.key as Node).length });
      expect(t.spans[`body.${k}`], `value ${i}`).toEqual({ offset: lib(e.value!).offset, length: lib(e.value!).length });
    }
    expect(t.spans.witnesses).toEqual({ offset: lib(root.values![1]!).offset, length: lib(root.values![1]!).length });
    expect(t.spans.is_valid).toEqual({ offset: t.size - 2, length: 1 });
    expect(t.spans.aux).toEqual({ offset: t.size - 1, length: 1 });
  });
});

describe("scripts", () => {
  it("hashes: blake2b-224(tag || script bytes); Plutus bytes are the single-wrapped program", () => {
    const v2 = succeeds(2);
    expect(scriptHash(v2)).toBe(hashScriptBytes(2, v2.bytes));
    expect(scriptHash(succeeds(1))).not.toBe(scriptHash(v2));
    expect(scriptSize(v2)).toBe(v2.bytes.length);
    const nat = native({ type: "atLeast", n: 2, scripts: [{ type: "sig", keyHash: "11".repeat(28) }, { type: "after", slot: 5 }, { type: "before", slot: 9 }] });
    expect(scriptHash(nat)).toBe(hashScriptBytes(0, nativeScriptBytes(nat.script)));
    const lib = decodeType<{ script_hash: string }>(bytesToHex(nativeScriptBytes(nat.script)), "NativeScript");
    expect(lib.script_hash).toBe(scriptHash(nat));
    const libPlutus = decodeType<{ script_hash: string }>(bytesToHex(v2.bytes), "PlutusScript", { plutus_script_version: 2 });
    expect(libPlutus.script_hash).toBe(scriptHash(v2));
    expect(bytesToHex(encode(scriptCbor(v2))).startsWith("8202")).toBe(true);
  });

  it("a deeply nested native script is built without recursion and rides in a transaction as raw bytes", () => {
    const deep = deepNativeScriptBytes(10_000, { type: "all", scripts: [] });
    expect(deep.length).toBe(3 * 10_000 + 3);
    expect(Array.from(deep.subarray(0, 3))).toEqual([0x82, 0x01, 0x81]);
    const t = assemble(plain({ rawNativeScripts: [deep] }));
    expect(t.witnessScriptHashes).toEqual([hashScriptBytes(0, deep)]);
    expect(t.hex).toContain(bytesToHex(deep));
    expect(t.spans["witness.1"]!.length).toBe(1 + deep.length); // array head + the script
  });
});

describe("script data hash", () => {
  const pp = protocolParameters("pv10");
  const redeemers = bytes("a0");
  const datums = bytes("d9010280");

  it("the language views: V2 / V3 as definite lists, V1 as a byte-wrapped indefinite list under key 4100, sorted shortest key first", () => {
    const v2 = bytesToHex(languageViewsBytes(pp, [2]));
    expect(v2.startsWith("a101" + "98af")).toBe(true); // key 1, array of 175
    const v3 = bytesToHex(languageViewsBytes(pp, [3]));
    expect(v3.startsWith("a102" + "990129")).toBe(true); // key 2, array of 297
    const v1 = bytesToHex(languageViewsBytes(pp, [1]));
    expect(v1.startsWith("a1" + "4100" + "59")).toBe(true);
    expect(v1.slice(12, 14)).toBe("9f"); // the bytes hold an indefinite list
    expect(v1.endsWith("ff")).toBe(true);
    const all = bytesToHex(languageViewsBytes(pp, [1, 3, 2, 2]));
    expect(all.startsWith("a3" + "01" + "98af")).toBe(true);
    expect(all.indexOf("4100")).toBeGreaterThan(all.indexOf("02990129"));
    expect(bytesToHex(languageViewsBytes(pp, []))).toBe("a0");
  });

  it("preimage = redeemers || datums || views; without datums the middle part is empty; without redeemers `a0 || datums || a0`", () => {
    const r = encode(decode("a0"));
    const views = languageViewsBytes(pp, [2]);
    const full = scriptDataPreimage({ redeemers: r, datums: encode(decode("d9010280")), languages: [2] }, pp);
    expect(bytesToHex(full)).toBe("a0" + "d9010280" + bytesToHex(views));
    expect(bytesToHex(scriptDataPreimage({ redeemers: r, languages: [2] }, pp))).toBe("a0" + bytesToHex(views));
    expect(bytesToHex(scriptDataPreimage({ datums: encode(decode("d9010280")), languages: [] }, pp))).toBe("a0" + "d9010280" + "a0");
    expect(() => scriptDataPreimage({ languages: [] }, pp)).toThrow(/no script data hash/);
    expect(scriptDataHash({ redeemers: r, languages: [2] }, pp)).toHaveLength(64);
    expect(redeemers.t).toBe("bytes");
    expect(datums.t).toBe("bytes");
  });

  it("a missing cost model is a clear error", () => {
    const noV3 = { ...pp, costModels: { plutusV2: pp.costModels.plutusV2 } };
    expect(() => languageViewsBytes(noV3, [3])).toThrow(/PlutusV3 cost model/);
  });

  it("the parameter sets are the public constants: pv10 has 166 / 175 / 297 cost-model entries, pv11 more", () => {
    const a = paramSet("pv10").protocolParameters;
    expect([a.costModels.plutusV1!.length, a.costModels.plutusV2!.length, a.costModels.plutusV3!.length]).toEqual([166, 175, 297]);
    expect(a.protocolVersion).toEqual([10, 0]);
    const b = paramSet("pv11").protocolParameters;
    expect(b.protocolVersion).toEqual([11, 0]);
    expect(paramSet("pv11").koiosEpochParams.protocol_major).toBe(11);
    // copies: a scenario may tweak its set without touching the next one
    const c = paramSet("pv10").protocolParameters;
    c.minFeeConstantB = 1;
    expect(paramSet("pv10").protocolParameters.minFeeConstantB).not.toBe(1);
  });
});

describe("misc builder behaviour", () => {
  it("the same input twice is the caller's problem; a missing redeemer target throws at assemble", () => {
    expect(() =>
      assemble(plain({ plutusScripts: [succeeds(2)], redeemers: [{ target: { tag: "spend", input: txin(h("elsewhere"), 0) }, data: UNIT, exUnits: { mem: 1, steps: 1 } }] }), { params: protocolParameters("pv10") }),
    ).toThrow(/not an input/);
  });

  it("explicit script data hash overrides, null omits", () => {
    const base = plain({ plutusScripts: [succeeds(2)], redeemers: [{ target: { tag: "spend", input: txin(h("in"), 0) }, data: UNIT, exUnits: { mem: 1, steps: 1 } }] });
    const forced = assemble({ ...base, scriptDataHash: "ab".repeat(32) }, { params: protocolParameters("pv10") });
    expect(forced.scriptDataHash).toBe("ab".repeat(32));
    const omitted = assemble({ ...base, scriptDataHash: null }, { params: protocolParameters("pv10") });
    expect(omitted.scriptDataHash).toBeUndefined();
    const auto = assemble(base, { params: protocolParameters("pv10") });
    expect(auto.scriptDataHash).toHaveLength(64);
    expect(auto.languages).toEqual([]); // the script is not needed by a derivable target: no UTxO lookup was given
  });

  it("derives the languages from the scripts the redeemers need (witness scripts and reference scripts)", () => {
    const sc = succeeds(1);
    const policy = scriptHash(sc);
    const t = assemble(
      plain({ mint: [{ policy, assets: { "01": 1n } }], plutusScripts: [sc, succeeds(3)], redeemers: [{ target: { tag: "mint", policy }, data: UNIT, exUnits: { mem: 1, steps: 1 } }] }),
      { params: protocolParameters("pv10") },
    );
    expect(t.languages).toEqual([1]); // the V3 witness script is not needed by any redeemer
  });
});
