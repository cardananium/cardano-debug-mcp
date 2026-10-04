import { describe, expect, it } from "vitest";

import {
  ContextShapeError,
  engineParamsOf,
  koiosEpochParamDefaults,
  normalizeProtocolParameters,
  normalizeValidationInputContext,
  stringifyForLib,
  toBigint,
  toInt,
} from "../../../src/chain/contextCodec.js";

const PARAMS = {
  minFeeCoefficientA: 44,
  minFeeConstantB: "155381",
  maxBlockBodySize: 90112,
  maxTransactionSize: 16384,
  maxBlockHeaderSize: 1100,
  stakeKeyDeposit: { $bi: "2000000" },
  stakePoolDeposit: { "$serde_json::private::Number": "500000000" },
  maxEpochForPoolRetirement: 18,
  protocolVersion: [10, 0],
  minPoolCost: 170000000n,
  adaPerUtxoByte: 4310,
  costModels: { PlutusV1: [1, 2, 3], plutusV2: { "0": 4, "1": 5 } },
  executionPrices: { memPrice: { numerator: 577, denominator: 10000 }, stepPrice: { numerator: "721", denominator: "10000000" } },
  maxTxExecutionUnits: { mem: 14000000, steps: "10000000000" },
  maxBlockExecutionUnits: { mem: 62000000, steps: 20000000000 },
  maxValueSize: 5000,
  collateralPercentage: 150,
  maxCollateralInputs: 3,
  governanceActionDeposit: "100000000000",
  drepDeposit: 500000000,
  referenceScriptCostPerByte: { numerator: 15, denominator: 1 },
};

describe("integer coercion", () => {
  it("accepts number, string, bigint and boxes", () => {
    expect(toBigint(5, "x")).toBe(5n);
    expect(toBigint("18446744073709551615", "x")).toBe(18446744073709551615n);
    expect(toBigint(7n, "x")).toBe(7n);
    expect(toBigint({ $bi: "9" }, "x")).toBe(9n);
    expect(toBigint({ "$serde_json::private::Number": "10" }, "x")).toBe(10n);
    expect(toInt("42", "x")).toBe(42);
    expect(() => toBigint(1.5, "slot")).toThrow(ContextShapeError);
    expect(() => toInt("99999999999999999999", "x")).toThrow(/does not fit/);
  });
});

describe("normalizeProtocolParameters", () => {
  it("brings every field to the library's types", () => {
    const pp = normalizeProtocolParameters(PARAMS);
    expect(pp.minFeeCoefficientA).toBe(44n);
    expect(pp.minFeeConstantB).toBe(155381n);
    expect(pp.stakeKeyDeposit).toBe(2000000n);
    expect(pp.stakePoolDeposit).toBe(500000000n);
    expect(pp.maxBlockBodySize).toBe(90112);
    expect(pp.protocolVersion).toEqual([10, 0]);
    expect(pp.costModels).toEqual({ plutusV1: [1, 2, 3], plutusV2: [4, 5] });
    expect(pp.executionPrices.stepPrice).toEqual({ numerator: 721n, denominator: 10000000n });
    expect(pp.maxTxExecutionUnits.steps).toBe(10000000000n);
  });

  it("accepts {major, minor} protocol versions and names the path of a broken field", () => {
    const pp = normalizeProtocolParameters({ ...PARAMS, protocolVersion: { major: 11, minor: 2 } });
    expect(pp.protocolVersion).toEqual([11, 2]);
    expect(() => normalizeProtocolParameters({ ...PARAMS, minPoolCost: "abc" })).toThrow(/protocolParameters\.minPoolCost/);
    expect(() => normalizeProtocolParameters({ ...PARAMS, executionPrices: null })).toThrow(/executionPrices/);
  });

  it("engineParamsOf gives protocol_version[0] and flat cost models", () => {
    const ep = engineParamsOf(normalizeProtocolParameters(PARAMS));
    expect(ep).toEqual({ protocol_major: 10, protocol_minor: 0, cost_models: { V1: [1, 2, 3], V2: [4, 5] } });
  });
});

describe("normalizeValidationInputContext", () => {
  const context = {
    utxoSet: [
      {
        utxo: {
          input: { txHash: "AB".repeat(32), outputIndex: "1" },
          output: { address: "addr1xyz", amount: [{ unit: "lovelace", quantity: 5000000 }, { unit: "abc.def", quantity: "1" }], dataHash: null, scriptRef: "8202" },
        },
      },
    ],
    protocolParameters: PARAMS,
    slot: "198000000",
    accountContexts: [{ bech32Address: "stake1u…", isRegistered: true, payedDeposit: "2000000" }],
    drepContexts: [],
    poolContexts: [{ poolId: "pool1…", isRegistered: false }],
    govActionContexts: [{ actionId: { txHash: "00".repeat(32), index: 0 }, actionType: "infoAction", isActive: true }],
    lastEnactedGovAction: [],
    currentCommitteeMembers: [{ committeeMemberCold: { keyHash: [1, 2] }, committeeMemberHot: null, isResigned: false }],
    potentialCommitteeMembers: [],
    treasuryValue: { $bi: "123" },
    networkType: "mainnet",
    constitution: { guardrailScriptHash: "aa" },
  };

  it("normalises a loosely typed context", () => {
    const ctx = normalizeValidationInputContext(context);
    expect(ctx.slot).toBe(198000000n);
    expect(ctx.treasuryValue).toBe(123n);
    expect(ctx.networkType).toBe("mainnet");
    expect(ctx.utxoSet[0]!.utxo.input).toEqual({ txHash: "ab".repeat(32), outputIndex: 1 });
    expect(ctx.utxoSet[0]!.utxo.output.amount).toEqual([
      { unit: "lovelace", quantity: "5000000" },
      { unit: "abc.def", quantity: "1" },
    ]);
    expect(ctx.utxoSet[0]!.isSpent).toBe(false);
    expect(ctx.accountContexts[0]!.payedDeposit).toBe(2000000);
    expect(ctx.govActionContexts[0]!.actionId.txHash).toHaveLength(32);
    expect(ctx.govActionContexts[0]!.actionId.index).toBe(0); // u32 in the library
    expect(ctx.constitution).toEqual({ guardrailScriptHash: "aa" });
  });

  it("network override wins and shape errors name the path", () => {
    expect(normalizeValidationInputContext(context, "preprod").networkType).toBe("preprod");
    expect(() => normalizeValidationInputContext({ ...context, utxoSet: [{ utxo: { input: {}, output: {} } }] })).toThrow(/utxoSet\[0\]\.utxo\.input\.txHash/);
    expect(() => normalizeValidationInputContext({ ...context, networkType: "testnet" })).toThrow(/networkType/);
  });

  it("stringifyForLib writes bare integers and no bigint artefacts", () => {
    const text = stringifyForLib(normalizeValidationInputContext(context));
    expect(text).toContain('"slot":198000000');
    expect(text).toContain('"treasuryValue":123');
    expect(text).toContain('"quantity":"5000000"');
    expect(text).not.toContain("$bi");
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

describe("koiosEpochParamDefaults", () => {
  it("lists the null fields the core substitutes", () => {
    const defaults = koiosEpochParamDefaults({ min_fee_a: 44, protocol_major: null, cost_models: null, max_tx_size: 16384 });
    expect(defaults.some((d) => d.startsWith("protocolParameters.protocol_major=9"))).toBe(true);
    expect(defaults.some((d) => d.includes("costModels={}"))).toBe(true);
    expect(defaults.some((d) => d.startsWith("protocolParameters.min_fee_a="))).toBe(false);
    expect(koiosEpochParamDefaults(undefined)).toHaveLength(1);
  });
});
