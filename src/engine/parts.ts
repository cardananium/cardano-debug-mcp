// Building the engine's `PartsConfig`: from an `EvalRedeemerResult` the validator
// produced (tx mode — the SAME script / datum / redeemer / script-context bytes, cost model and
// protocol version), or from hand-supplied arguments (parts mode). Pure functions, no engine.
//
// Apply order the engine uses (debugger_engine.rs `new_session_from_parts`): datum -> redeemer ->
// context. V1/V2 spend takes all three, V1/V2 other purposes redeemer + context, V3 takes the
// context alone (its datum and redeemer live inside the ScriptContext). Handing a V3 script a
// separate redeemer would apply one argument too many, so this module never does.

import type { EvalRedeemerResultWire } from "../lib.js";
import { purposeFromLibTag, purposeLabel, type Purpose } from "../vocab/purpose.js";
import type { EngineLanguage, PartsConfig } from "./protocol.js";

export type CostModelSource = "protocol_params" | "supplied" | "engine_default";

export interface PartsMeta {
  language: EngineLanguage;
  purpose: Purpose | undefined;
  cost_model_source: CostModelSource;
  cost_model_length: number | undefined;
  protocol_major: number | undefined;
  declared_ex_units: { steps: string; mem: string } | undefined;
  /** What the validator computed (tx mode) — the `parity` reference. */
  calculated_ex_units?: { steps: string; mem: string };
  applied: Array<"datum" | "redeemer" | "context">;
  notes: string[];
}

export interface BuiltParts {
  config: PartsConfig;
  meta: PartsMeta;
}

export class PartsError extends Error {
  readonly argument: string | undefined;
  constructor(message: string, argument?: string) {
    super(message);
    this.name = "PartsError";
    this.argument = argument;
  }
}

const HEX = /^[0-9a-fA-F]*$/;

/** Lower-case hex without `0x` / whitespace; throws on anything else. */
export function cleanHex(value: string, argument: string): string {
  let text = value.trim().replace(/\s+/g, "");
  if (text.startsWith("0x") || text.startsWith("0X")) text = text.slice(2);
  if (text.length === 0) throw new PartsError(`${argument} is empty`, argument);
  if (text.length % 2 !== 0 || !HEX.test(text)) throw new PartsError(`${argument} must be CBOR hex (even length, 0-9a-f)`, argument);
  return text.toLowerCase();
}

export function parseLanguage(input: string | number | null | undefined, argument = "plutus_version"): EngineLanguage {
  if (input === null || input === undefined) throw new PartsError(`${argument} is required (V1 | V2 | V3)`, argument);
  const text = String(input).trim().toLowerCase().replace(/^plutus\s*/, "");
  if (text === "v1" || text === "1") return "V1";
  if (text === "v2" || text === "2") return "V2";
  if (text === "v3" || text === "3") return "V3";
  throw new PartsError(`${argument} ${JSON.stringify(input)} is not one of V1 | V2 | V3`, argument);
}

/** Engine spelling of the language ("v1" | "v2" | "v3"). */
export function engineLanguage(language: EngineLanguage): string {
  return language.toLowerCase();
}

function toSafeInteger(value: unknown, argument: string): number {
  let n: number;
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new PartsError(`${argument} ${value} does not fit a JSON number`, argument);
    }
    n = Number(value);
  } else if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    n = Number(value.trim());
  } else {
    throw new PartsError(`${argument} must be an integer (number or decimal string)`, argument);
  }
  if (!Number.isSafeInteger(n)) throw new PartsError(`${argument} ${String(value)} is not a safe integer`, argument);
  return n;
}

/** Flat cost-model list from any of the accepted spellings (numbers, decimal strings, bigints). */
export function normalizeCostModel(list: unknown, argument = "cost_models"): number[] {
  if (!Array.isArray(list)) throw new PartsError(`${argument} must be a flat array of integers`, argument);
  if (list.length === 0) throw new PartsError(`${argument} is empty`, argument);
  return list.map((v, i) => toSafeInteger(v, `${argument}[${i}]`));
}

/**
 * Fewest cost-model parameters the engine reads per language (the uplc cost model indexes them
 * unconditionally: V1 166, V2 175, V3 251; V3 lists of 297+ add the PV10 builtins). A shorter list
 * would crash the engine; a longer one is accepted.
 */
export const MIN_COST_MODEL_LENGTH: Record<EngineLanguage, number> = { V1: 166, V2: 175, V3: 251 };

export function checkCostModelLength(costModel: readonly number[], language: EngineLanguage, argument = "cost_models"): void {
  const need = MIN_COST_MODEL_LENGTH[language];
  if (costModel.length >= need) return;
  const fits = (Object.entries(MIN_COST_MODEL_LENGTH) as Array<[EngineLanguage, number]>).filter(([, n]) => costModel.length >= n).map(([l]) => l);
  throw new PartsError(
    `${argument} has ${costModel.length} parameters; Plutus ${language} needs at least ${need} (V1 166, V2 175, V3 251)` +
      (fits.length ? `. A list of this length fits ${fits.join("/")}: is plutus_version right, or is this another language's model?` : ""),
    argument,
  );
}

/** `[cpu, mem]` from `{steps, mem}` / `{cpu, mem}` / `[cpu, mem]`; both must be non-negative integers. */
export function normalizeExUnits(input: unknown, argument = "ex_units"): [number, number] {
  let cpu: unknown;
  let mem: unknown;
  if (Array.isArray(input)) {
    if (input.length !== 2) throw new PartsError(`${argument} must be [cpu, mem]`, argument);
    [cpu, mem] = input;
  } else if (input !== null && typeof input === "object") {
    const o = input as Record<string, unknown>;
    cpu = o.steps ?? o.cpu;
    mem = o.mem ?? o.memory;
  } else {
    throw new PartsError(`${argument} must be {steps, mem}`, argument);
  }
  const c = toSafeInteger(cpu, `${argument}.steps`);
  const m = toSafeInteger(mem, `${argument}.mem`);
  if (c < 0 || m < 0) throw new PartsError(`${argument} must be non-negative`, argument);
  return [c, m];
}

// ---------- protocol parameters (cquisitor-lib shape, de-uplc shape tolerated) ----------

type Json = Record<string, unknown>;

function rec(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

/**
 * The flat cost model of `language` from protocol parameters in either the cquisitor-lib shape
 * (`costModels.plutusV2`) or the de-uplc shape (`costModels.PlutusV2`). `undefined` when absent.
 */
export function costModelFor(protocolParams: unknown, language: EngineLanguage): number[] | undefined {
  const pp = rec(protocolParams);
  const models = rec(pp?.costModels ?? pp?.cost_models ?? pp?.costModelsRaw);
  if (!models) return undefined;
  const raw = models[`plutus${language}`] ?? models[`Plutus${language}`] ?? models[language] ?? models[language.toLowerCase()];
  if (raw === null || raw === undefined) return undefined;
  if (Array.isArray(raw)) return normalizeCostModel(raw, `costModels.plutus${language}`);
  // Named map (Blockfrost style) — the order is not the ledger's, so refuse rather than guess.
  throw new PartsError(`costModels.plutus${language} is a named map; a flat ordered list is required`, "cost_models");
}

/** `protocolVersion[0]` (lib) or `protocolVersion.major` (de-uplc). */
export function protocolMajorOf(protocolParams: unknown): number | undefined {
  const pp = rec(protocolParams);
  const pv = pp?.protocolVersion ?? pp?.protocol_version;
  if (Array.isArray(pv) && pv.length > 0) return toSafeInteger(pv[0], "protocolVersion[0]");
  const o = rec(pv);
  if (o && o.major !== undefined) return toSafeInteger(o.major, "protocolVersion.major");
  return undefined;
}

function exUnitsWire(v: { mem: number | string; steps: number | string } | null | undefined): { steps: string; mem: string } | undefined {
  if (!v) return undefined;
  return { steps: String(v.steps), mem: String(v.mem) };
}

/**
 * `PartsConfig` from what the validator applied. `protocolParams` is the `protocolParameters` of
 * the ValidationInputContext the validation ran with (cost model + protocol version of THIS tx);
 * when absent the engine's built-in cost model is used and the meta says so.
 */
export function partsFromEval(ev: EvalRedeemerResultWire, protocolParams?: unknown): BuiltParts {
  const notes: string[] = [];
  if (!ev.script_bytes) throw new PartsError("EvalRedeemerResult carries no script_bytes (the validator did not resolve the script)", "redeemer");
  const language = parseLanguage(ev.plutus_version ?? undefined, "plutus_version");
  const purpose = purposeFromLibTag(ev.tag);
  const config: PartsConfig = {
    script: cleanHex(ev.script_bytes, "script_bytes"),
    language: engineLanguage(language),
    purpose: purposeLabel(purpose),
  };
  const applied: PartsMeta["applied"] = [];
  if (!ev.script_context_bytes) throw new PartsError("EvalRedeemerResult carries no script_context_bytes", "redeemer");
  if (language === "V3") {
    if (ev.redeemer_bytes || ev.datum_bytes) notes.push("V3: redeemer and datum are inside the ScriptContext; only the context is applied.");
  } else {
    if (ev.datum_bytes) {
      config.datum = cleanHex(ev.datum_bytes, "datum_bytes");
      applied.push("datum");
    } else if (purpose === "spend") {
      notes.push("V1/V2 spend without datum_bytes: the script is applied to redeemer and context only.");
    }
    if (!ev.redeemer_bytes) throw new PartsError("EvalRedeemerResult carries no redeemer_bytes (required for V1/V2)", "redeemer");
    config.redeemer = cleanHex(ev.redeemer_bytes, "redeemer_bytes");
    applied.push("redeemer");
  }
  config.context = cleanHex(ev.script_context_bytes, "script_context_bytes");
  applied.push("context");

  let costModelSource: CostModelSource = "engine_default";
  let costModel: number[] | undefined;
  let protocolMajor: number | undefined;
  if (protocolParams !== undefined && protocolParams !== null) {
    costModel = costModelFor(protocolParams, language);
    if (costModel) checkCostModelLength(costModel, language, `costModels.plutus${language}`);
    protocolMajor = protocolMajorOf(protocolParams);
    if (costModel) {
      config.cost_models = costModel;
      costModelSource = "protocol_params";
    } else {
      notes.push(`protocol parameters carry no costModels.plutus${language}; the engine's built-in cost model is used.`);
    }
    if (protocolMajor !== undefined) config.protocol_version = protocolMajor;
  } else {
    notes.push("no protocol parameters: the engine's built-in cost model and default protocol version are used (ex-units may differ from the validator).");
  }
  const declared = exUnitsWire(ev.provided_ex_units);
  if (declared) config.ex_units = normalizeExUnits(ev.provided_ex_units, "provided_ex_units");

  return {
    config,
    meta: {
      language,
      purpose,
      cost_model_source: costModelSource,
      cost_model_length: costModel?.length,
      protocol_major: protocolMajor,
      declared_ex_units: declared,
      calculated_ex_units: exUnitsWire(ev.calculated_ex_units),
      applied,
      notes,
    },
  };
}

export interface PartsArgs {
  script: string;
  plutus_version?: string | number;
  context?: string;
  redeemer_data?: string;
  datum?: string;
  cost_models?: unknown;
  protocol_major?: number | string;
  ex_units?: unknown;
  purpose?: string;
  /** `protocolParameters` to take cost model / protocol version from when `cost_models` is not given. */
  protocol_params?: unknown;
}

/** Whether `script` is UPLC text (`(program …`) rather than hex. */
export function isUplcText(script: string): boolean {
  return script.trim().startsWith("(");
}

/** `PartsConfig` from hand-supplied parts. `plutus_version` defaults to V3 when nothing else says. */
export function partsFromArgs(args: PartsArgs): BuiltParts {
  const notes: string[] = [];
  if (!args.script || args.script.trim() === "") throw new PartsError("script is required", "script");
  const script = isUplcText(args.script) ? args.script.trim() : cleanHex(args.script, "script");
  let language: EngineLanguage;
  if (args.plutus_version === undefined || args.plutus_version === null || args.plutus_version === "") {
    language = "V3";
    notes.push("plutus_version not given: V3 assumed.");
  } else {
    language = parseLanguage(args.plutus_version);
  }
  const config: PartsConfig = { script, language: engineLanguage(language) };
  const applied: PartsMeta["applied"] = [];
  if (args.datum) {
    if (language === "V3") notes.push("V3 ignores a separate datum (it lives in the ScriptContext); datum not applied.");
    else {
      config.datum = cleanHex(args.datum, "datum");
      applied.push("datum");
    }
  }
  if (args.redeemer_data) {
    if (language === "V3") notes.push("V3 ignores a separate redeemer (it lives in the ScriptContext); redeemer_data not applied.");
    else {
      config.redeemer = cleanHex(args.redeemer_data, "redeemer_data");
      applied.push("redeemer");
    }
  }
  if (args.context) {
    const trimmed = args.context.trim();
    // The engine also accepts a named SerializableScriptContext JSON (leading `{`).
    config.context = trimmed.startsWith("{") ? trimmed : cleanHex(trimmed, "context");
    applied.push("context");
  }
  if (language !== "V3" && config.context && !config.redeemer) {
    notes.push("V1/V2 with a context but no redeemer_data: the validator would normally receive the redeemer first.");
  }

  let costModelSource: CostModelSource = "engine_default";
  let costModel: number[] | undefined;
  if (args.cost_models !== undefined && args.cost_models !== null) {
    costModel = normalizeCostModel(args.cost_models);
    costModelSource = "supplied";
  } else if (args.protocol_params !== undefined && args.protocol_params !== null) {
    costModel = costModelFor(args.protocol_params, language);
    if (costModel) costModelSource = "protocol_params";
  }
  if (costModel) checkCostModelLength(costModel, language, costModelSource === "supplied" ? "cost_models" : `costModels.plutus${language}`);
  if (costModel) config.cost_models = costModel;
  else notes.push("no cost_models: the engine's built-in cost model for the language is used.");

  let protocolMajor: number | undefined;
  if (args.protocol_major !== undefined && args.protocol_major !== null && args.protocol_major !== "") {
    protocolMajor = toSafeInteger(args.protocol_major, "protocol_major");
  } else if (args.protocol_params !== undefined && args.protocol_params !== null) {
    protocolMajor = protocolMajorOf(args.protocol_params);
  }
  if (protocolMajor !== undefined) config.protocol_version = protocolMajor;

  let declared: PartsMeta["declared_ex_units"];
  if (args.ex_units !== undefined && args.ex_units !== null) {
    const [cpu, mem] = normalizeExUnits(args.ex_units);
    config.ex_units = [cpu, mem];
    declared = { steps: String(cpu), mem: String(mem) };
  }
  const purposeText = args.purpose?.trim();
  if (purposeText) config.purpose = purposeText;

  return {
    config,
    meta: { language, purpose: undefined, cost_model_source: costModelSource, cost_model_length: costModel?.length, protocol_major: protocolMajor, declared_ex_units: declared, applied, notes },
  };
}

/** True when the arguments describe a bare program (nothing but the script and its language). */
export function isProgramOnly(args: PartsArgs): boolean {
  return !args.context && !args.redeemer_data && !args.datum && (args.cost_models === undefined || args.cost_models === null) && (args.ex_units === undefined || args.ex_units === null) && !args.purpose?.trim();
}
