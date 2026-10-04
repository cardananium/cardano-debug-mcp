import { describe, expect, it } from "vitest";

import type { EvalRedeemerResultWire } from "../../../src/lib.js";
import { costModelFor, isProgramOnly, normalizeExUnits, parseLanguage, partsFromArgs, partsFromEval, PartsError, protocolMajorOf } from "../../../src/engine/parts.js";
import { fxBig, fxStr, readFixtureJson } from "../../helpers/fixtures.js";

interface Fixture {
  network: string;
  tx_hex: string;
  protocol_parameters: { protocolVersion: [number, number]; costModels: { plutusV1: number[]; plutusV2: number[]; plutusV3: number[] } };
  eval_redeemer_results: EvalRedeemerResultWire[];
}

// The raw validator result of the artificial S1 transaction; its ex-units are in the manifest (s01.spend.exUnits).
const fixture = readFixtureJson<Fixture>(fxStr("s01.evalFile"));
const spend = fixture.eval_redeemer_results.find((r) => r.tag === "Spend")!;
const mint = fixture.eval_redeemer_results.find((r) => r.tag === "Mint")!;
const declared = { steps: fxStr("s01.spend.exUnits.declared.steps"), mem: fxStr("s01.spend.exUnits.declared.mem") };
const calculated = { steps: fxStr("s01.spend.exUnits.calculated.steps"), mem: fxStr("s01.spend.exUnits.calculated.mem") };
const declaredPair = [Number(fxBig("s01.spend.exUnits.declared.steps")), Number(fxBig("s01.spend.exUnits.declared.mem"))];

describe("partsFromEval", () => {
  it("V2 spend: datum -> redeemer -> context, cost model + protocol version of the tx, declared ex-units as [cpu, mem]", () => {
    const { config, meta } = partsFromEval(spend, fixture.protocol_parameters);
    expect(config.script).toBe(spend.script_bytes);
    expect(config.language).toBe("v2");
    expect(config.datum).toBe(spend.datum_bytes);
    expect(config.redeemer).toBe(spend.redeemer_bytes);
    expect(config.context).toBe(spend.script_context_bytes);
    expect(config.cost_models).toHaveLength(175);
    expect(config.cost_models).toEqual(fixture.protocol_parameters.costModels.plutusV2);
    expect(config.protocol_version).toBe(10);
    expect(config.ex_units).toEqual(declaredPair);
    expect(config.purpose).toBe("Spending");
    expect(meta.applied).toEqual(["datum", "redeemer", "context"]);
    expect(meta.language).toBe("V2");
    expect(meta.purpose).toBe("spend");
    expect(meta.cost_model_source).toBe("protocol_params");
    expect(meta.declared_ex_units).toEqual(declared);
    expect(meta.calculated_ex_units).toEqual(calculated);
    expect(JSON.parse(JSON.stringify(config))).toEqual(config); // plain JSON for the engine
  });

  it("V2 mint: no datum", () => {
    const { config, meta } = partsFromEval(mint, fixture.protocol_parameters);
    expect(config.datum).toBeUndefined();
    expect(config.redeemer).toBe(mint.redeemer_bytes);
    expect(meta.applied).toEqual(["redeemer", "context"]);
    expect(meta.purpose).toBe("mint");
    expect(config.purpose).toBe("Minting");
  });

  it("V3: only the context is applied even when the lib reports redeemer/datum bytes", () => {
    const v3: EvalRedeemerResultWire = { ...spend, plutus_version: "V3", tag: "Reward", index: 0 };
    const { config, meta } = partsFromEval(v3, fixture.protocol_parameters);
    expect(config.language).toBe("v3");
    expect(config.datum).toBeUndefined();
    expect(config.redeemer).toBeUndefined();
    expect(config.context).toBe(spend.script_context_bytes);
    expect(config.cost_models).toHaveLength(297);
    expect(meta.applied).toEqual(["context"]);
    expect(meta.purpose).toBe("withdraw");
    expect(meta.notes.join(" ")).toMatch(/V3/);
  });

  it("without protocol parameters falls back to the engine default cost model and says so", () => {
    const { config, meta } = partsFromEval(spend);
    expect(config.cost_models).toBeUndefined();
    expect(config.protocol_version).toBeUndefined();
    expect(meta.cost_model_source).toBe("engine_default");
    expect(meta.notes.join(" ")).toMatch(/built-in cost model/);
  });

  it("accepts the de-uplc protocolParams shape (costModels.PlutusV2, protocolVersion.major)", () => {
    const pp = { costModels: { PlutusV2: fixture.protocol_parameters.costModels.plutusV2 }, protocolVersion: { major: 9, minor: 0 } };
    expect(costModelFor(pp, "V2")).toHaveLength(175);
    expect(costModelFor(pp, "V1")).toBeUndefined();
    expect(protocolMajorOf(pp)).toBe(9);
    const { config } = partsFromEval(spend, pp);
    expect(config.protocol_version).toBe(9);
  });

  it("wire decimal strings in the cost model / ex-units become numbers", () => {
    const pp = { costModels: { plutusV2: fixture.protocol_parameters.costModels.plutusV2.map(String) }, protocolVersion: ["10", "0"] };
    const ev: EvalRedeemerResultWire = { ...spend, provided_ex_units: declared };
    const { config } = partsFromEval(ev, pp);
    expect(config.cost_models?.[0]).toBe(fixture.protocol_parameters.costModels.plutusV2[0]);
    expect(config.ex_units).toEqual(declaredPair);
    expect(config.protocol_version).toBe(10);
  });

  it("refuses an EvalRedeemerResult without script bytes", () => {
    expect(() => partsFromEval({ ...spend, script_bytes: null })).toThrow(PartsError);
    expect(() => partsFromEval({ ...spend, script_context_bytes: null })).toThrow(/script_context_bytes/);
    expect(() => partsFromEval({ ...spend, redeemer_bytes: null })).toThrow(/redeemer_bytes/);
  });
});

describe("partsFromArgs", () => {
  it("builds a parts config from hand-supplied hex with {steps, mem} ex-units and string cost models", () => {
    const { config, meta } = partsFromArgs({
      script: " 0x" + spend.script_bytes!.toUpperCase() + " ",
      plutus_version: "v2",
      context: spend.script_context_bytes!,
      redeemer_data: spend.redeemer_bytes!,
      datum: spend.datum_bytes!,
      cost_models: fixture.protocol_parameters.costModels.plutusV2.map(String),
      protocol_major: "10",
      ex_units: { steps: declared.steps, mem: Number(declared.mem) },
      purpose: "spend",
    });
    expect(config.script).toBe(spend.script_bytes);
    expect(config.language).toBe("v2");
    expect(config.cost_models).toEqual(fixture.protocol_parameters.costModels.plutusV2);
    expect(config.protocol_version).toBe(10);
    expect(config.ex_units).toEqual(declaredPair);
    expect(config.purpose).toBe("spend");
    expect(meta.cost_model_source).toBe("supplied");
    expect(meta.applied).toEqual(["datum", "redeemer", "context"]);
    expect(meta.declared_ex_units).toEqual(declared);
  });

  it("takes the cost model from protocol_params when cost_models is absent", () => {
    const { config, meta } = partsFromArgs({ script: spend.script_bytes!, plutus_version: "V2", context: spend.script_context_bytes!, protocol_params: fixture.protocol_parameters });
    expect(config.cost_models).toHaveLength(175);
    expect(config.protocol_version).toBe(10);
    expect(meta.cost_model_source).toBe("protocol_params");
  });

  it("defaults to V3 and ignores a separate redeemer/datum for V3", () => {
    const { config, meta } = partsFromArgs({ script: "(program 1.1.0 (con integer 1))", context: "d87980", redeemer_data: "d87980" });
    expect(config.language).toBe("v3");
    expect(config.redeemer).toBeUndefined();
    expect(config.context).toBe("d87980");
    expect(meta.notes.join(" ")).toMatch(/V3 assumed/);
  });

  it("keeps UPLC text scripts verbatim and validates hex fields", () => {
    expect(partsFromArgs({ script: "(program 1.0.0 (con integer 1))", ex_units: [1, 2] }).config.script).toBe("(program 1.0.0 (con integer 1))");
    expect(() => partsFromArgs({ script: "zz", plutus_version: "V2", context: "00" })).toThrow(PartsError);
    expect(() => partsFromArgs({ script: "00", plutus_version: "V2", context: "0" })).toThrow(/context/);
    expect(() => partsFromArgs({ script: "00", plutus_version: "V4" })).toThrow(/plutus_version/);
    expect(() => partsFromArgs({ script: "00", plutus_version: "V2", ex_units: { steps: -1, mem: 2 } })).toThrow(/non-negative/);
    expect(() => partsFromArgs({ script: "00", plutus_version: "V2", cost_models: [1, "x"] })).toThrow(/cost_models\[1\]/);
  });

  it("isProgramOnly / parseLanguage / normalizeExUnits", () => {
    expect(isProgramOnly({ script: "00" })).toBe(true);
    expect(isProgramOnly({ script: "00", plutus_version: "V1" })).toBe(true);
    expect(isProgramOnly({ script: "00", ex_units: { steps: 1, mem: 1 } })).toBe(false);
    expect(isProgramOnly({ script: "00", purpose: " " })).toBe(true);
    expect(parseLanguage("PlutusV1")).toBe("V1");
    expect(parseLanguage(2)).toBe("V2");
    expect(parseLanguage("v3")).toBe("V3");
    expect(normalizeExUnits({ cpu: 5n, memory: "6" })).toEqual([5, 6]);
    expect(normalizeExUnits([7, 8])).toEqual([7, 8]);
  });
});

describe("cost model length", () => {
  it("a list shorter than the language needs is refused before the engine (which would trap), naming the expected count", () => {
    const v2 = fixture.protocol_parameters.costModels.plutusV2;
    expect(() => partsFromArgs({ script: spend.script_bytes!, plutus_version: "V3", context: "d87980", cost_models: [1, 2, 3] })).toThrow(PartsError);
    expect(() => partsFromArgs({ script: spend.script_bytes!, plutus_version: "V3", context: "d87980", cost_models: [1, 2, 3] })).toThrow(/3 parameters; Plutus V3 needs at least 251/);
    // a V2 model handed to a V3 script: the message points at the mix-up
    expect(() => partsFromArgs({ script: spend.script_bytes!, plutus_version: "V3", context: "d87980", cost_models: v2 })).toThrow(/175 parameters; Plutus V3 needs at least 251.*fits V1\/V2/);
    // exact and longer lists pass
    expect(partsFromArgs({ script: spend.script_bytes!, plutus_version: "V2", context: "d87980", cost_models: v2 }).config.cost_models).toHaveLength(175);
    expect(partsFromArgs({ script: spend.script_bytes!, plutus_version: "V1", context: "d87980", cost_models: v2 }).config.cost_models).toHaveLength(175);
  });
});
