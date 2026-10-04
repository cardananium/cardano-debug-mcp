// User-facing decompile options → dehosk wire bag (`DecompileOptionsDto`).
//
// Preset = the wasm-DTO defaults (the catalogue's `defaults`: decode_church_to_native=true,
// expect_or_fail=true, stub ADTs off, applied_kind Compile — what the de-uplc-web decompiler tab
// sends). On top: script_version / validator_shape.purpose / output_layer from the tool's own
// arguments, then the documented user subset, then `raw` (validated against the catalogue).

import { createHash } from "node:crypto";

import { dehoskPurposeFromPurpose, type Purpose } from "../vocab/purpose.js";
import { CatalogueIndex, getAtPath, setAtPath, type OptionsBag } from "./catalogue.js";
import type { PlutusVersion } from "./scriptBytes.js";

export type DecompileView = "pseudocode" | "uplc" | "uplc_canonical";
export const DECOMPILE_VIEWS: readonly DecompileView[] = ["pseudocode", "uplc", "uplc_canonical"];

/** Wire tokens of `output_layer` per view (verified against the catalogue at build time). */
const VIEW_LAYER: Record<DecompileView, string> = {
  pseudocode: "Decompiled",
  uplc: "Uplc",
  uplc_canonical: "UplcCanonical",
};

export function layerOfView(view: DecompileView): string {
  return VIEW_LAYER[view];
}

/** The documented user subset. Everything else goes through `raw`. */
export interface UserDecompileOptions {
  strip_all_traces?: boolean;
  strip_plutustx_traces?: boolean;
  decode_church_to_native?: boolean;
  expect_or_fail?: boolean;
  synthesize_stub_adts?: boolean;
  safe_mode?: boolean;
  compilable_data_access?: boolean;
  /** `auto` | `always` | `never` (case-insensitive). */
  split_purposes?: string;
  /** `auto` | `compile` | `runtime` | a non-negative integer (= `{runtime_count: n}`). */
  applied_kind?: string | number;
  /** Any catalogue option by its wire path, deep-merged last. Validated against the catalogue. */
  raw?: Record<string, unknown>;
}

export interface BuildOptionsInput {
  view: DecompileView;
  /** Certain version (given by the caller / the tx / the session). Undefined = let dehosk auto-detect. */
  scriptVersion?: PlutusVersion;
  purpose?: Purpose;
  user?: UserDecompileOptions;
}

export interface BuiltOptions {
  /** The complete wire bag handed to `decompile_uplc`. */
  bag: OptionsBag;
  /** JSON text of `bag` with sorted keys (what is hashed and sent). */
  json: string;
  /** First 16 hex of sha256(json): cache key component. */
  hash: string;
  /** Compact echo for the tool answer: top-level scalars + validator_shape + pass groups that differ from the defaults. */
  echo: Record<string, unknown>;
  /** Wire token of the output layer. */
  layer: string;
  /** Wire purpose token passed, if any. */
  purposeToken: string | null;
  /** Wire version token passed, if any. */
  versionToken: string | null;
}

export class OptionsError extends Error {
  readonly argument: string;
  constructor(message: string, argument = "options") {
    super(message);
    this.name = "OptionsError";
    this.argument = argument;
  }
}

const SIMPLE_TOGGLES = [
  "strip_all_traces",
  "strip_plutustx_traces",
  "decode_church_to_native",
  "expect_or_fail",
  "synthesize_stub_adts",
  "safe_mode",
  "compilable_data_access",
] as const;

/** Wire purpose token for a canonical purpose, checked against the catalogue (`Publish` is accepted by the DTO as an alias of `Certificate`). */
export function purposeToken(index: CatalogueIndex, purpose: Purpose): string {
  const dehosk = dehoskPurposeFromPurpose(purpose); // spend | mint | withdraw | certificate | vote | propose
  const token = index.matchToken(["validator_shape", "purpose"], dehosk) ?? index.matchToken(["validator_shape", "purpose"], purpose);
  if (!token) {
    throw new OptionsError(`The decompiler has no purpose token for '${purpose}' (catalogue offers ${index.tokens(["validator_shape", "purpose"]).join("|")}).`, "purpose");
  }
  return token;
}

export function versionToken(index: CatalogueIndex, version: PlutusVersion): string {
  const token = index.matchToken(["script_version"], `Plutus${version}`) ?? index.matchToken(["script_version"], version);
  if (!token) throw new OptionsError(`The decompiler has no script_version token for ${version} (catalogue offers ${index.tokens(["script_version"]).join("|")}).`, "plutus_version");
  return token;
}

/** Build the wire bag. Throws `OptionsError` (→ invalid_argument) on any unknown name or token. */
export function buildDecompileOptions(index: CatalogueIndex, input: BuildOptionsInput): BuiltOptions {
  let bag: OptionsBag = index.defaults;

  const layer = index.matchToken(["output_layer"], VIEW_LAYER[input.view]);
  if (!layer) throw new OptionsError(`The decompiler has no output layer for view '${input.view}' (catalogue offers ${index.tokens(["output_layer"]).join("|")}).`, "view");
  bag = setAtPath(bag, ["output_layer"], layer);

  let version: string | null = null;
  if (input.scriptVersion) {
    version = versionToken(index, input.scriptVersion);
    bag = setAtPath(bag, ["script_version"], version);
  }
  let purpose: string | null = null;
  if (input.purpose) {
    purpose = purposeToken(index, input.purpose);
    bag = setAtPath(bag, ["validator_shape", "purpose"], purpose);
  }

  const user = input.user ?? {};
  for (const name of SIMPLE_TOGGLES) {
    const value = user[name];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new OptionsError(`options.${name} takes true|false (got ${JSON.stringify(value)}).`, `options.${name}`);
    if (!index.has([name])) throw new OptionsError(`The decompiler build has no option '${name}'.`, `options.${name}`);
    bag = setAtPath(bag, [name], value);
  }
  if (user.split_purposes !== undefined) {
    const token = index.matchToken(["validator_shape", "split_purposes"], String(user.split_purposes));
    if (!token) throw new OptionsError(`options.split_purposes must be one of ${index.tokens(["validator_shape", "split_purposes"]).map((t) => t.toLowerCase()).join("|")} (got ${JSON.stringify(user.split_purposes)}).`, "options.split_purposes");
    bag = setAtPath(bag, ["validator_shape", "split_purposes"], token);
  }
  if (user.applied_kind !== undefined) {
    bag = setAtPath(bag, ["validator_shape", "applied_kind"], appliedKindValue(index, user.applied_kind));
  }
  if (user.raw !== undefined) {
    if (user.raw === null || typeof user.raw !== "object" || Array.isArray(user.raw)) throw new OptionsError("options.raw must be an object of catalogue options.", "options.raw");
    const merged = deepMerge(bag, user.raw as OptionsBag);
    const errors = index.validateBag(merged);
    if (errors.length > 0) {
      throw new OptionsError(`options.raw rejected: ${errors.join("; ")}. Known option paths: ${index.paths().join(", ")}.`, "options.raw");
    }
    bag = merged;
    // `raw` may have overridden the layer / version / purpose; report what is really sent.
    const rawLayer = getAtPath(bag, ["output_layer"]);
    if (typeof rawLayer === "string" && rawLayer !== layer) {
      throw new OptionsError("options.raw.output_layer conflicts with `view`; choose the layer with `view` (pseudocode | uplc | uplc_canonical).", "options.raw");
    }
    version = (getAtPath(bag, ["script_version"]) as string | null | undefined) ?? null;
    purpose = (getAtPath(bag, ["validator_shape", "purpose"]) as string | null | undefined) ?? null;
  }

  const json = stableStringify(bag);
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 16);
  return { bag, json, hash, echo: echoOf(index, bag), layer, purposeToken: purpose, versionToken: version };
}

function appliedKindValue(index: CatalogueIndex, value: string | number): unknown {
  const option = index.option(["validator_shape", "applied_kind"]);
  if (!option || option.kind.type !== "choice") throw new OptionsError("The decompiler build has no validator_shape.applied_kind option.", "options.applied_kind");
  const payloadChoice = option.kind.choices.find((c) => c.payload);
  if (typeof value === "number") {
    if (!payloadChoice?.payload) throw new OptionsError("options.applied_kind does not accept a count in this decompiler build.", "options.applied_kind");
    if (!Number.isInteger(value) || value < payloadChoice.payload.min) throw new OptionsError(`options.applied_kind count must be an integer >= ${payloadChoice.payload.min}.`, "options.applied_kind");
    return { [payloadChoice.payload.key]: value };
  }
  const token = index.matchToken(["validator_shape", "applied_kind"], value);
  if (!token || token === payloadChoice?.value) {
    const keywords = option.kind.choices.filter((c) => !c.payload).map((c) => c.value.toLowerCase());
    throw new OptionsError(`options.applied_kind must be one of ${keywords.join("|")} or an integer count of pre-applied runtime args (got ${JSON.stringify(value)}).`, "options.applied_kind");
  }
  return token;
}

function deepMerge(base: OptionsBag, patch: OptionsBag): OptionsBag {
  const out: OptionsBag = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value) && current !== null && typeof current === "object" && !Array.isArray(current)) {
      out[key] = deepMerge(current as OptionsBag, value as OptionsBag);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** JSON with object keys sorted at every level (stable across builds and processes). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** Top-level scalars and validator_shape verbatim; nested pass groups only where they differ from the defaults. */
function echoOf(index: CatalogueIndex, bag: OptionsBag): Record<string, unknown> {
  const defaults = index.defaults;
  const echo: Record<string, unknown> = {};
  const overridden: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (value === null || typeof value !== "object" || key === "validator_shape") {
      echo[key] = value;
      continue;
    }
    const group = value as Record<string, unknown>;
    const defaultGroup = (defaults[key] ?? {}) as Record<string, unknown>;
    const diff: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(group)) if (defaultGroup[k] !== v) diff[k] = v;
    if (Object.keys(diff).length > 0) overridden[key] = diff;
  }
  if (Object.keys(overridden).length > 0) echo.passes_overridden = overridden;
  return echo;
}
