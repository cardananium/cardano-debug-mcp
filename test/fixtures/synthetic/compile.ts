// Driver of `npm run fixtures:compile`: compiles the artificial Plutus scripts and writes the registry
// test/fixtures/synthetic/scripts.json.
//
//   AIKEN_V3=~/.cargo/bin/aiken AIKEN_V2=/path/to/aiken-1.0.29-alpha npm run fixtures:compile
//
// What it does, in order:
//   1. checks the two compilers (AIKEN_V3 must be v1.1.21, AIKEN_V2 v1.0.29-alpha), runs `aiken build` and `aiken check`
//      (the Aiken unit tests of every validator) in aiken-v3/ and aiken-v2/, which rewrites their plutus.json;
//   2. applies the compile-time parameters (`aiken blueprint apply`, one parameter per call, first parameter first);
//   3. encodes the hand-written UPLC (uplc/*.uplc) with `aiken uplc encode`;
//   4. hashes every script (blake2b-224 of version byte || single-CBOR bytes) and cross-checks Aiken's own hash;
//   5. measures every script (UPLC term count and listing lines through the de-uplc engine, pseudocode / UPLC lines
//      through the dehosk decompiler, both in-process) and builds the native-script catalogue;
//   6. writes scripts.json (stable key order, nothing time-dependent: two runs give identical bytes).
//
// `fixtures:build` and the tests never run Aiken: they read the committed plutus.json files and scripts.json.
// Everything here is artificial: the keys are the named fixture keys of lib/keys.ts, the "seed" output reference is
// derived from a fixed phrase, no value comes from a chain.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as decompilerWasm from "@cardananium/de-uplc-decompiler-wasm";
import * as engineWasm from "@cardananium/de-uplc-engine-wasm";

import { CatalogueIndex, parseCatalogue } from "../../../src/decompiler/catalogue.js";
import { buildDecompileOptions } from "../../../src/decompiler/options.js";
import { EngineSession } from "../../../src/engine/session-core.js";
import type { Purpose } from "../../../src/vocab/purpose.js";
import { readWasm } from "../../../src/wasm-assets.js";
import { blake2b224, blake2b256 } from "./lib/blake2b.js";
import { bytesToHex, concat, hexToBytes, utf8 } from "./lib/bytes.js";
import { array, bytes as cborBytes, type Cbor, decode as cborDecode, encode as cborEncode, uint as cborUint } from "./lib/cbor.js";
import { paymentKey } from "./lib/keys.js";
import { constr, encodePlutusDataHex, pBytes, pInt } from "./lib/plutusData.js";

export const SYNTHETIC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY_PATH = path.join(SYNTHETIC_DIR, "scripts.json");

export const EXPECTED_COMPILERS = { v3: "v1.1.21", v2: "v1.0.29-alpha" } as const;
/** Same flags for both compilers: keep the traces the validators write themselves, add none of the compiler's own (a failed `expect` stays a bare builtin failure). */
const BUILD_FLAGS = ["-t", "verbose", "-f", "user-defined"];

export type PlutusVersion = "V1" | "V2" | "V3";
export type Purposes = Purpose[];
const VERSION_BYTE: Record<PlutusVersion, number> = { V1: 1, V2: 2, V3: 3 };

// ---------------------------------------------------------------------------------------------------------------------
// The artificial parameters

/** The one named key behind every key-hash parameter: payment/script-operator (see lib/keys.ts). */
export const OPERATOR_KEY = { role: "payment", name: "script-operator" } as const;
/** Owners of the six keys of the native 3-of-6 script: payment/native-signer-1 .. 6. */
export const NATIVE_SIGNER_NAMES = [1, 2, 3, 4, 5, 6].map((n) => `native-signer-${n}`);
export const FEE_NUMERATOR = 30;
export const MAX_SUPPLY = 1_000_000_000_000_000n;
/** Seed output reference of pool_mint_b: any UTxO set that contains this output lets the one-shot policy mint. */
export const SEED_PHRASE = "cardano-debug-mcp synthetic fixture seed output / pool_mint_b";
export const SEED_INDEX = 0;

export function operatorKeyHash(): string {
  return paymentKey(OPERATOR_KEY.name).keyHashHex;
}

export function seedTxId(): string {
  return bytesToHex(blake2b256(utf8(SEED_PHRASE)));
}

interface ParamSpec {
  name: string;
  type: string;
  /** Plutus Data, CBOR hex: what `aiken blueprint apply` receives. */
  cbor: string;
  /** Human readable value (hex for bytes). */
  value: string | number | { transactionId: string; outputIndex: number };
  note: string;
}

const byteParam = (name: string, hex: string, note: string): ParamSpec => ({ name, type: "ByteArray", cbor: encodePlutusDataHex(pBytes(hex)), value: hex, note });
const intParam = (name: string, value: number | bigint, note: string): ParamSpec => ({ name, type: "Int", cbor: encodePlutusDataHex(pInt(value)), value: Number(value), note });

// ---------------------------------------------------------------------------------------------------------------------
// What gets built

interface AikenSource {
  kind: "aiken";
  name: string;
  project: "aiken-v2" | "aiken-v3";
  /** Blueprint module (file name under validators/) and validator name as `aiken blueprint apply -m -v` take them. */
  module: string;
  validator: string;
  /** Blueprint entry whose compiledCode is the script. */
  title: string;
  plutusVersion: PlutusVersion;
  purposes: Purposes;
  source: string;
  /** Parameters in application order; `built` holds the scripts compiled before this one (pool_mint_a needs the hash of spend_v3). */
  params: (built: Map<string, BuiltScript>) => ParamSpec[];
  notes: string;
}

interface UplcSource {
  kind: "uplc";
  name: string;
  plutusVersion: PlutusVersion;
  purposes: Purposes;
  source: string;
  notes: string;
}

type Source = AikenSource | UplcSource;

const noParams = (): ParamSpec[] => [];

export const SOURCES: Source[] = [
  // ---- Plutus V2 (Aiken v1.0.29-alpha, stdlib 1.9.0)
  {
    kind: "aiken",
    name: "order_spend",
    project: "aiken-v2",
    module: "order_spend",
    validator: "spend",
    title: "order_spend.spend",
    plutusVersion: "V2",
    purposes: ["spend"],
    source: "aiken-v2/validators/order_spend.ak",
    params: () => [
      byteParam("operator", operatorKeyHash(), "payment key hash of the named key payment/script-operator"),
      intParam("fee_numerator", FEE_NUMERATOR, "protocol fee in basis points"),
    ],
    notes:
      "Large parameterised order-book spend validator (rules in aiken-v2/lib/order_book.ak). Redeemers Cancel = Constr 0 [], Fill = Constr 1 [amount, payout_index], Reprice = Constr 2 [new_unit_price]. " +
      "Datum Constr 0 [maker address, sell_policy, sell_asset, unit_price, quantity, expires_at, memo]; a list datum fails with a MachineError (unConstrData). " +
      "The decompiler's first note is 'Applied compile-time params' (two applied `con data` parameters); use order_fixed for the 'Outer Apply chain' note.",
  },
  {
    kind: "aiken",
    name: "order_fixed",
    project: "aiken-v2",
    module: "order_fixed",
    validator: "spend",
    title: "order_fixed.spend",
    plutusVersion: "V2",
    purposes: ["spend"],
    source: "aiken-v2/validators/order_fixed.ak",
    params: noParams,
    notes:
      "Same logic, redeemers and datum as order_spend, with the operator key hash (payment/script-operator) and the fee (30 bps) compiled in as constants: no applied parameters, so the first decompiler note is 'Outer Apply chain — no compile-time params'.",
  },
  {
    kind: "aiken",
    name: "burn_mint",
    project: "aiken-v2",
    module: "burn_mint",
    validator: "mint",
    title: "burn_mint.mint",
    plutusVersion: "V2",
    purposes: ["mint"],
    source: "aiken-v2/validators/burn_mint.ak",
    params: () => [
      byteParam("admin", operatorKeyHash(), "payment key hash of the named key payment/script-operator"),
      intParam("max_supply", MAX_SUPPLY, "largest quantity one transaction may mint per asset name"),
    ],
    notes:
      "Parameterised V2 minting policy. Redeemer Burn = Constr 1 [] passes when every quantity of the policy in tx.mint is negative (needs no signature and ignores any datum); " +
      "MintTokens = Constr 0 [asset_name] needs the admin as required signer, exactly one minted entry with that name and 0 < quantity <= max_supply.",
  },
  {
    kind: "aiken",
    name: "reward_ok",
    project: "aiken-v2",
    module: "reward_ok",
    validator: "withdraw",
    title: "reward_ok.withdraw",
    plutusVersion: "V2",
    purposes: ["withdraw", "publish"],
    source: "aiken-v2/validators/reward_ok.ak",
    params: noParams,
    notes: "V2 staking validator for zero withdrawals / script stake certificates. Redeemer Constr 0 [] passes; Constr 1 [] fails with the trace 'reward_ok: denied'; any other shape fails with a MachineError.",
  },
  {
    kind: "aiken",
    name: "lock_spend",
    project: "aiken-v2",
    module: "lock_spend",
    validator: "spend",
    title: "lock_spend.spend",
    plutusVersion: "V2",
    purposes: ["spend"],
    source: "aiken-v2/validators/lock_spend.ak",
    params: noParams,
    notes:
      "Small V2 spend validator (reference-script friendly). Redeemer Unlock = Constr 1 [] passes when the spent input is among the inputs; Refund = Constr 0 [] fails with the trace 'lock_spend: refund is disabled'; " +
      "Batch = Constr 2 [n] passes when exactly n inputs sit at the same script address; Sweep = Constr 3 [i] passes when output i goes to a key address with the input's lovelace minus the fee. The datum can be any Data.",
  },
  // ---- Plutus V3 (Aiken v1.1.21, stdlib v3.0.0)
  {
    kind: "aiken",
    name: "spend_v3",
    project: "aiken-v3",
    module: "spend_v3",
    validator: "spend_v3",
    title: "spend_v3.spend_v3.spend",
    plutusVersion: "V3",
    purposes: ["spend"],
    source: "aiken-v3/validators/spend_v3.ak",
    params: noParams,
    notes:
      "Small V3 time-lock vault. Needs an inline datum Constr 0 [owner key hash, unlock_after] that equals the spent output's inline datum. Withdraw = Constr 0 [] needs the owner as required signer and a validity range starting at or after unlock_after; " +
      "Extend = Constr 1 [] fails with the trace 'spend_v3: extend is not supported'. Its hash is the reference_holder parameter of pool_mint_a.",
  },
  {
    kind: "aiken",
    name: "pool_mint_a",
    project: "aiken-v3",
    module: "pool_mint_a",
    validator: "pool_mint_a",
    title: "pool_mint_a.pool_mint_a.mint",
    plutusVersion: "V3",
    purposes: ["mint"],
    source: "aiken-v3/validators/pool_mint_a.ak",
    params: (built) => {
      const holder = built.get("spend_v3");
      if (!holder) throw new Error("pool_mint_a needs spend_v3 to be built first");
      return [
        byteParam("owner", operatorKeyHash(), "payment key hash of the named key payment/script-operator"),
        byteParam("reference_holder", holder.hash, "script hash of spend_v3: the reference token goes to this script address"),
      ];
    },
    notes:
      "CIP-68 style pair policy. MintPair = Constr 0 [name, reference_output_index]: owner is a required signer; tx.mint under this policy is exactly {000643b0++name: 1, 000de140++name: 1}; output i holds the reference token at the spend_v3 script address with an inline datum Constr 0 [metadata map with byte keys 'name' and 'image', version 1, extra]. " +
      "BurnPair = Constr 1 [name]: owner signs, both tokens burned (-1 each).",
  },
  {
    kind: "aiken",
    name: "pool_mint_b",
    project: "aiken-v3",
    module: "pool_mint_b",
    validator: "pool_mint_b",
    title: "pool_mint_b.pool_mint_b.mint",
    plutusVersion: "V3",
    purposes: ["mint"],
    source: "aiken-v3/validators/pool_mint_b.ak",
    params: () => [
      {
        name: "seed",
        type: "OutputReference",
        cbor: encodePlutusDataHex(constr(0, [pBytes(seedTxId()), pInt(SEED_INDEX)])),
        value: { transactionId: seedTxId(), outputIndex: SEED_INDEX },
        note: `blake2b-256 of the phrase "${SEED_PHRASE}", output index ${SEED_INDEX}: a UTxO set must contain this output (and the transaction spend it) for MintNft to pass`,
      },
    ],
    notes: "One-shot NFT policy. MintNft = Constr 0 [name]: the seed output is spent and tx.mint under the policy is exactly {name: 1}. BurnNft = Constr 1 []: every quantity of the policy is negative.",
  },
  {
    kind: "aiken",
    name: "guardrails",
    project: "aiken-v3",
    module: "guardrails",
    validator: "guardrails",
    title: "guardrails.guardrails.propose",
    plutusVersion: "V3",
    purposes: ["propose", "vote", "publish"],
    source: "aiken-v3/validators/guardrails.ak",
    params: noParams,
    notes:
      "Constitution-guardrails shape, one script with three handlers (propose / vote / publish share one hash). propose: redeemer must be a Plutus map (normally `Map []`); a ParameterChange passes when every changed parameter is inside the bounds listed in the source header (an empty change passes), " +
      "a TreasuryWithdrawal passes up to 10,000,000 ada, anything else fails. vote: needs a required signer; a pool voter must itself sign, any other voter needs redeemer Constr 0 []. publish: DRep registration with a deposit of at least 100 ada, or a DRep update.",
  },
  // ---- hand-written UPLC
  {
    kind: "uplc",
    name: "tiny",
    plutusVersion: "V2",
    purposes: ["spend", "mint", "withdraw", "publish"],
    source: "uplc/tiny.uplc",
    notes: "Always succeeds: \\datum redeemer context -> unit (the 3-argument V2 spend form; with fewer arguments it returns a function, which V1/V2 accept as success). A few bytes, no logic.",
  },
  {
    kind: "uplc",
    name: "tiny_v3",
    plutusVersion: "V3",
    purposes: ["spend", "mint", "withdraw", "publish", "vote", "propose"],
    source: "uplc/tiny_v3.uplc",
    notes: "Always succeeds: \\context -> unit (the V3 form, UPLC 1.1.0).",
  },
  {
    kind: "uplc",
    name: "v1_dummy",
    plutusVersion: "V1",
    purposes: ["spend", "mint", "withdraw", "publish"],
    source: "uplc/v1_dummy.uplc",
    notes: "A Plutus V1 validator that succeeds (a delayed ifThenElse on 1 == 1); the V1 twin of a V2 program differs only by the hash prefix, this one is a distinct program.",
  },
  {
    kind: "uplc",
    name: "loop_v2",
    plutusVersion: "V2",
    purposes: ["spend", "mint", "withdraw", "publish"],
    source: "uplc/loop_v2.uplc",
    notes: "Never terminates: the omega combinator (\\x -> x x) (\\x -> x x). For the timeout / step-limit tests.",
  },
];

// ---------------------------------------------------------------------------------------------------------------------
// Native scripts

export interface NativeEntry {
  name: string;
  /** The toolkit's `NativeScript` form (lib/script.ts): sig {keyHash}, all / any {scripts}, atLeast {n, scripts}, after / before {slot}. */
  json: unknown;
  /** The cardano-cli JSON form (`atLeast` carries `required` instead of `n`). */
  cliJson: unknown;
  /** CBOR of the native script (the ledger's `native_script`), hex */
  cborHex: string;
  /** blake2b-224(0x00 || cbor) */
  hash: string;
  sizeBytes: number;
  notes: string;
}

type Native = { t: "sig"; key: string } | { t: "all" | "any"; of: Native[] } | { t: "atLeast"; n: number; of: Native[] } | { t: "after" | "before"; slot: number };

function nativeJson(n: Native, cli: boolean): unknown {
  switch (n.t) {
    case "sig":
      return { type: "sig", keyHash: n.key };
    case "all":
    case "any":
      return { type: n.t, scripts: n.of.map((child) => nativeJson(child, cli)) };
    case "atLeast":
      return cli ? { type: "atLeast", required: n.n, scripts: n.of.map((child) => nativeJson(child, cli)) } : { type: "atLeast", n: n.n, scripts: n.of.map((child) => nativeJson(child, cli)) };
    case "after":
    case "before":
      return { type: n.t, slot: n.slot };
  }
}

function nativeCbor(n: Native): Cbor {
  switch (n.t) {
    case "sig":
      return array([cborUint(0), cborBytes(n.key)]);
    case "all":
      return array([cborUint(1), array(n.of.map(nativeCbor))]);
    case "any":
      return array([cborUint(2), array(n.of.map(nativeCbor))]);
    case "atLeast":
      return array([cborUint(3), cborUint(n.n), array(n.of.map(nativeCbor))]);
    case "after":
      return array([cborUint(4), cborUint(n.slot)]);
    case "before":
      return array([cborUint(5), cborUint(n.slot)]);
  }
}

export function nativeCatalogue(): NativeEntry[] {
  const operator: Native = { t: "sig", key: operatorKeyHash() };
  const signers: Native[] = NATIVE_SIGNER_NAMES.map((name) => ({ t: "sig", key: paymentKey(name).keyHashHex }));
  const defs: Array<{ name: string; script: Native; notes: string }> = [
    { name: "all_empty", script: { t: "all", of: [] }, notes: "ScriptAll []: valid in every transaction (no signature, no time condition). 3 bytes." },
    { name: "any_empty", script: { t: "any", of: [] }, notes: "ScriptAny []: never valid (an empty any-script cannot be satisfied)." },
    { name: "sig_operator", script: operator, notes: "ScriptPubkey of the named key payment/script-operator: valid when that key signs." },
    { name: "after_slot_1000", script: { t: "after", slot: 1000 }, notes: "InvalidBefore 1000: valid from slot 1000 on (the transaction's validity start must be >= 1000)." },
    { name: "before_slot_1000", script: { t: "before", slot: 1000 }, notes: "InvalidHereafter 1000: valid before slot 1000 (the transaction's ttl must be <= 1000)." },
    { name: "operator_and_window", script: { t: "all", of: [operator, { t: "after", slot: 1000 }, { t: "before", slot: 2_000_000_000 }] }, notes: "All of: the operator's signature, validity start >= 1000, ttl <= 2,000,000,000." },
    {
      name: "multisig_3_of_6",
      script: { t: "atLeast", n: 3, of: signers },
      notes: `ScriptNOfK 3 of the six keys payment/${NATIVE_SIGNER_NAMES.join(", payment/")} (in this order): valid when any three of them sign. About 200 bytes.`,
    },
  ];
  return defs.map(({ name, script, notes }) => {
    const bytes = cborEncode(nativeCbor(script));
    return { name, json: nativeJson(script, false), cliJson: nativeJson(script, true), cborHex: bytesToHex(bytes), hash: bytesToHex(blake2b224(concat([0], bytes))), sizeBytes: bytes.length, notes };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Running the compilers

export interface Toolchain {
  aikenV3: string;
  aikenV2: string;
}

function run(bin: string, args: string[], cwd: string, what: string): { stdout: string; stderr: string } {
  const result = spawnSync(bin, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`${what}: cannot run ${bin}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${what} failed (exit ${result.status}) in ${cwd}\n${result.stdout}${result.stderr}\n` +
        "Note: aiken v1.1.21 prints NO error text when its output is not a terminal; re-run the same command in a terminal (or under `script`) to see the compiler message.",
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function versionOf(bin: string, label: string, expected: string): string {
  const { stdout } = run(bin, ["--version"], SYNTHETIC_DIR, `${label} --version`);
  const line = stdout.trim();
  if (!line.includes(expected)) {
    throw new Error(`${label} must be aiken ${expected}, got "${line}" (${bin}). v1.1.21: cargo install aiken --version 1.1.21; v1.0.29-alpha: https://github.com/aiken-lang/aiken/releases/download/v1.0.29-alpha/aiken-aarch64-apple-darwin.tar.gz`);
  }
  return line;
}

interface BlueprintEntry {
  title: string;
  compiledCode: string;
  hash: string;
  parameters?: Array<{ title: string }>;
}
interface Blueprint {
  preamble: { compiler: { version: string }; plutusVersion: string };
  validators: BlueprintEntry[];
}

function readBlueprint(file: string): Blueprint {
  return JSON.parse(readFileSync(file, "utf8")) as Blueprint;
}

function entryOf(blueprint: Blueprint, title: string, where: string): BlueprintEntry {
  const entry = blueprint.validators.find((v) => v.title === title);
  if (!entry) throw new Error(`${where}: no validator "${title}" (has ${blueprint.validators.map((v) => v.title).join(", ")})`);
  return entry;
}

/** Applies `params` (first parameter first) to the blueprint entry and returns the resulting entry. */
function applyParams(source: AikenSource, params: ParamSpec[], bins: { v2: string; v3: string }): BlueprintEntry {
  const projectDir = path.join(SYNTHETIC_DIR, source.project);
  const work = path.join(projectDir, "build", "apply", source.name);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const blueprintPath = path.join(projectDir, "plutus.json");
  if (params.length === 0) return entryOf(readBlueprint(blueprintPath), source.title, blueprintPath);

  let current = blueprintPath;
  if (source.project === "aiken-v3") {
    params.forEach((param, i) => {
      const out = path.join("build", "apply", source.name, `step-${i + 1}.json`);
      run(bins.v3, ["blueprint", "apply", "-i", current, "-m", source.module, "-v", source.validator, param.cbor, "-o", out], projectDir, `apply ${source.name}.${param.name}`);
      current = path.join(projectDir, out);
    });
    return entryOf(readBlueprint(current), source.title, current);
  }
  // v1.0.29-alpha has no `-i`: it reads plutus.json of its working directory.
  copyFileSync(path.join(projectDir, "aiken.toml"), path.join(work, "aiken.toml"));
  copyFileSync(blueprintPath, path.join(work, "plutus.json"));
  params.forEach((param, i) => {
    const out = `step-${i + 1}.json`;
    run(bins.v2, ["blueprint", "apply", "-m", source.module, "-v", source.validator, param.cbor, "-o", out], work, `apply ${source.name}.${param.name}`);
    copyFileSync(path.join(work, out), path.join(work, "plutus.json"));
  });
  return entryOf(readBlueprint(path.join(work, "plutus.json")), source.title, work);
}

// ---------------------------------------------------------------------------------------------------------------------
// Hashing, unwrapping, measuring

/** The CBOR byte string around a flat program (what the ledger hashes and what plutus.json calls compiledCode). */
export function unwrapSingle(cborHex: string): { flat: Uint8Array; canonical: boolean } {
  const bytes = hexToBytes(cborHex);
  const item = cborDecode(bytes);
  if (item.t !== "bytes") throw new Error("a script must be one CBOR byte string");
  return { flat: item.v, canonical: bytesToHex(cborEncode(cborBytes(item.v))) === cborHex.toLowerCase() };
}

export function scriptHash(version: PlutusVersion, cborHex: string): string {
  return bytesToHex(blake2b224(concat([VERSION_BYTE[version]], hexToBytes(cborHex))));
}

export interface Measurement {
  termCount: number;
  /** Lines of the canonical UPLC listing the debugger shows (resource uplc.txt, 400-line windows). */
  debuggerListingLines: number;
  /** Lines of script_decompile view=pseudocode (header notes included); null when no purpose applies. */
  pseudocodeLines: number;
  /** Lines of script_decompile view=uplc. */
  uplcLines: number;
  /** Deepest indentation, in columns, of the pseudocode (header lines excluded). */
  pseudocodeMaxIndent: number;
  /** First note of the pseudocode header ('' when none). */
  firstNote: string;
  /** Whether the pseudocode text has a `<purpose>(` handler line (spend( / mint( / propose( ...). */
  handlerLine: string;
}

let wasmReady = false;
let catalogue: CatalogueIndex | undefined;

function initWasm(): CatalogueIndex {
  if (!wasmReady) {
    engineWasm.initSync({ module: readWasm("de_uplc_bg.wasm") });
    decompilerWasm.initSync({ module: readWasm("de_uplc_decompiler_wasm_bg.wasm") });
    catalogue = new CatalogueIndex(parseCatalogue(decompilerWasm.options_catalogue()));
    wasmReady = true;
  }
  return catalogue!;
}

/** Counts exactly what the tools report for the script (the debugger's term index and dehosk's two text views). */
export function measureScript(cborHex: string, version: PlutusVersion, purpose: Purpose): Measurement {
  const index = initWasm();
  const session = EngineSession.openProgram(engineWasm, cborHex, version);
  let termCount: number;
  let debuggerListingLines: number;
  try {
    termCount = session.script.count;
    debuggerListingLines = session.script.lines.length;
  } finally {
    session.free();
  }
  const pseudo = buildDecompileOptions(index, { view: "pseudocode", scriptVersion: version, purpose });
  const text = decompilerWasm.decompile_uplc(cborHex, pseudo.json);
  const uplc = buildDecompileOptions(index, { view: "uplc", scriptVersion: version });
  const uplcText = decompilerWasm.decompile_uplc(cborHex, uplc.json);
  const lines = text.split("\n");
  const body = lines.filter((l) => !l.startsWith("//"));
  const indents = body.filter((l) => l.trim() !== "").map((l) => l.length - l.trimStart().length);
  const note = lines.find((l) => l.startsWith("//")) ?? "";
  const handler = lines.find((l) => /^\s+\w+\(.*\)\s*\{\s*$/.test(l)) ?? "";
  return {
    termCount,
    debuggerListingLines,
    pseudocodeLines: trimTrailingBlank(lines).length,
    uplcLines: trimTrailingBlank(uplcText.split("\n")).length,
    pseudocodeMaxIndent: indents.length > 0 ? Math.max(...indents) : 0,
    firstNote: note.replace(/^\/\/\s*/, ""),
    handlerLine: handler.trim(),
  };
}

function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  return lines.slice(0, end);
}

// ---------------------------------------------------------------------------------------------------------------------
// The registry

export interface RegistryScript {
  name: string;
  plutusVersion: PlutusVersion;
  purposes: Purposes;
  kind: "aiken" | "uplc";
  source: string;
  /** Blueprint title (aiken scripts). */
  blueprint?: string;
  /** Parameters applied with `aiken blueprint apply`, in application order. */
  params: ParamSpec[];
  /** Single CBOR byte string around the flat program: the form the ledger hashes (59xxxx... for >= 256 bytes). */
  cborHex: string;
  flatHex: string;
  /** blake2b-224(version byte || cbor bytes), 28-byte hex. */
  hash: string;
  /** Length of cborHex in bytes. */
  sizeBytes: number;
  flatBytes: number;
  termCount: number;
  debuggerListingLines: number;
  pseudocodeLines: number;
  uplcLines: number;
  pseudocodeMaxIndent: number;
  firstNote: string;
  handlerLine: string;
  notes: string;
}

export interface Registry {
  schema: 1;
  generatedBy: string;
  toolchain: { aikenV3: string; aikenV2: string; stdlibV3: string; stdlibV2: string; traceFlags: string };
  keys: Record<string, { label: string; keyHash: string; note: string }>;
  scripts: Record<string, RegistryScript>;
  native: NativeEntry[];
}

export interface BuiltScript {
  hash: string;
  cborHex: string;
}

function stdlibVersion(project: string): string {
  const toml = readFileSync(path.join(SYNTHETIC_DIR, project, "aiken.toml"), "utf8");
  const match = /name = "aiken-lang\/stdlib"\s*\nversion = "([^"]+)"/.exec(toml);
  if (!match) throw new Error(`no stdlib dependency in ${project}/aiken.toml`);
  return match[1]!;
}

function encodeUplc(source: UplcSource, bin: string): string {
  const file = path.join(SYNTHETIC_DIR, source.source);
  const { stdout } = run(bin, ["uplc", "encode", file, "--hex", "--cbor"], SYNTHETIC_DIR, `encode ${source.source}`);
  const hex = stdout.trim();
  if (!/^[0-9a-f]+$/.test(hex)) throw new Error(`unexpected output of aiken uplc encode for ${source.source}: ${hex.slice(0, 80)}`);
  return hex;
}

export interface CompileOptions {
  aikenV3: string;
  aikenV2: string;
  /** Skip `aiken check` (the Aiken unit tests). */
  skipCheck?: boolean;
}

export function compileAll(options: CompileOptions): Registry {
  const v3 = versionOf(options.aikenV3, "AIKEN_V3", EXPECTED_COMPILERS.v3);
  const v2 = versionOf(options.aikenV2, "AIKEN_V2", EXPECTED_COMPILERS.v2);
  const bins = { v2: options.aikenV2, v3: options.aikenV3 };

  for (const [project, bin] of [["aiken-v3", bins.v3], ["aiken-v2", bins.v2]] as const) {
    const cwd = path.join(SYNTHETIC_DIR, project);
    console.log(`[compile] ${project}: aiken build ${BUILD_FLAGS.join(" ")}`);
    run(bin, ["build", ...BUILD_FLAGS], cwd, `${project} build`);
    if (!options.skipCheck) {
      console.log(`[compile] ${project}: aiken check`);
      run(bin, ["check"], cwd, `${project} check`);
    }
  }

  const built = new Map<string, BuiltScript>();
  const scripts: Record<string, RegistryScript> = {};
  for (const source of SOURCES) {
    let cborHex: string;
    let params: ParamSpec[] = [];
    let blueprint: string | undefined;
    let aikenHash: string | undefined;
    if (source.kind === "aiken") {
      params = source.params(built);
      const entry = applyParams(source, params, bins);
      cborHex = entry.compiledCode;
      aikenHash = entry.hash;
      blueprint = source.title;
      const remaining = entry.parameters?.length ?? 0;
      if (remaining !== 0) throw new Error(`${source.name}: ${remaining} parameter(s) left unapplied`);
    } else {
      cborHex = encodeUplc(source, bins.v3);
    }
    const { flat, canonical } = unwrapSingle(cborHex);
    if (!canonical) throw new Error(`${source.name}: compiledCode is not a canonical definite-length CBOR byte string`);
    const hash = scriptHash(source.plutusVersion, cborHex);
    if (aikenHash !== undefined && aikenHash !== hash) throw new Error(`${source.name}: Aiken says hash ${aikenHash}, blake2b-224(version || cbor) is ${hash}`);
    const measured = measureScript(cborHex, source.plutusVersion, source.purposes[0]!);
    built.set(source.name, { hash, cborHex });
    scripts[source.name] = {
      name: source.name,
      plutusVersion: source.plutusVersion,
      purposes: source.purposes,
      kind: source.kind,
      source: source.source,
      ...(blueprint ? { blueprint } : {}),
      params,
      cborHex,
      flatHex: bytesToHex(flat),
      hash,
      sizeBytes: cborHex.length / 2,
      flatBytes: flat.length,
      termCount: measured.termCount,
      debuggerListingLines: measured.debuggerListingLines,
      pseudocodeLines: measured.pseudocodeLines,
      uplcLines: measured.uplcLines,
      pseudocodeMaxIndent: measured.pseudocodeMaxIndent,
      firstNote: measured.firstNote,
      handlerLine: measured.handlerLine,
      notes: source.notes,
    };
    console.log(`[compile] ${source.name}: ${scripts[source.name]!.sizeBytes} B, hash ${hash}`);
  }

  const operator = paymentKey(OPERATOR_KEY.name);
  const keys: Registry["keys"] = {
    operator: {
      label: operator.label,
      keyHash: operator.keyHashHex,
      note: "the key behind every key-hash parameter (order_spend operator, burn_mint admin, pool_mint_a owner) and the sig_operator native script; make it a required signer / a vkey witness with paymentKey('script-operator')",
    },
  };
  NATIVE_SIGNER_NAMES.forEach((name, i) => {
    const key = paymentKey(name);
    keys[`nativeSigner${i + 1}`] = { label: key.label, keyHash: key.keyHashHex, note: "one of the six keys of the native script multisig_3_of_6" };
  });

  return {
    schema: 1,
    generatedBy: "test/fixtures/synthetic/compile.ts (npm run fixtures:compile)",
    toolchain: { aikenV3: v3, aikenV2: v2, stdlibV3: stdlibVersion("aiken-v3"), stdlibV2: stdlibVersion("aiken-v2"), traceFlags: BUILD_FLAGS.join(" ") },
    keys,
    scripts,
    native: nativeCatalogue(),
  };
}

export function renderRegistry(registry: Registry): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

export function loadRegistry(): Registry {
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as Registry;
}

function main(): void {
  const aikenV3 = process.env.AIKEN_V3 ?? "aiken";
  const aikenV2 = process.env.AIKEN_V2;
  if (!aikenV2) {
    throw new Error("set AIKEN_V2 to the aiken v1.0.29-alpha binary (https://github.com/aiken-lang/aiken/releases/download/v1.0.29-alpha/aiken-aarch64-apple-darwin.tar.gz) and AIKEN_V3 to aiken v1.1.21");
  }
  if (!existsSync(path.join(SYNTHETIC_DIR, "aiken-v3", "aiken.toml"))) throw new Error("run from the repository: aiken-v3/aiken.toml not found");
  const registry = compileAll({ aikenV3, aikenV2, skipCheck: process.argv.includes("--skip-check") });
  const text = renderRegistry(registry);
  writeFileSync(REGISTRY_PATH, text);
  console.log(`[compile] wrote ${path.relative(process.cwd(), REGISTRY_PATH)} (${Object.keys(registry.scripts).length} scripts, ${registry.native.length} native scripts)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
