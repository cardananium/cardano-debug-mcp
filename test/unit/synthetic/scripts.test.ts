// The artificial Plutus scripts (test/fixtures/synthetic/{aiken-v2,aiken-v3,uplc}, registry scripts.json):
// registry consistency (hashes, flat bytes, sizes and the shapes the other tests pin), the decompiler's view of every
// script, and the documented success / failure behaviour of each one through the de-uplc engine on hand-built
// ScriptContexts. Nothing here compiles Aiken unless AIKEN_V2 and AIKEN_V3 are set (the last test then recompiles
// everything and compares with the committed files).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import * as decompilerWasm from "@cardananium/de-uplc-decompiler-wasm";
import * as engine from "@cardananium/de-uplc-engine-wasm";
import { beforeAll, describe, expect, it } from "vitest";

import { CatalogueIndex, parseCatalogue } from "../../../src/decompiler/catalogue.js";
import { buildDecompileOptions } from "../../../src/decompiler/options.js";
import { unwrapScriptHex } from "../../../src/decompiler/scriptBytes.js";
import { EngineSession } from "../../../src/engine/session-core.js";
import type { RunReport } from "../../../src/engine/protocol.js";
import { readWasm } from "../../../src/wasm-assets.js";
import {
  compileAll,
  EXPECTED_COMPILERS,
  loadRegistry,
  measureScript,
  nativeCatalogue,
  operatorKeyHash,
  renderRegistry,
  SEED_INDEX,
  SEED_PHRASE,
  seedTxId,
  SYNTHETIC_DIR,
  unwrapSingle,
  type PlutusVersion,
  type RegistryScript,
} from "../../fixtures/synthetic/compile.js";
import { blake2b224, blake2b256 } from "../../fixtures/synthetic/lib/blake2b.js";
import { bytesToHex, concat, hexToBytes, utf8 } from "../../fixtures/synthetic/lib/bytes.js";
import { paymentKey } from "../../fixtures/synthetic/lib/keys.js";
import { registryNative, registryScript } from "../../fixtures/synthetic/lib/scripts.js";
import { scriptHash as toolkitScriptHash } from "../../fixtures/synthetic/lib/script.js";
import { addressData, constr, credentialData, encode, pBytes, pInt, pList, pMap, v2Context, v3Context, type InputSpec, type PlutusData, type TxSpec } from "./scriptContexts.js";

const registry = loadRegistry();
const scripts = registry.scripts;
const VERSION_BYTE: Record<PlutusVersion, number> = { V1: 1, V2: 2, V3: 3 };

// ---------------------------------------------------------------------------------------------------------------------
// registry

describe("scripts.json: registry consistency", () => {
  it("lists the documented scripts under stable names", () => {
    expect(Object.keys(scripts).sort()).toEqual(
      ["burn_mint", "guardrails", "lock_spend", "loop_v2", "order_fixed", "order_spend", "pool_mint_a", "pool_mint_b", "reward_ok", "spend_v3", "tiny", "tiny_v3", "v1_dummy"].sort(),
    );
    for (const [name, script] of Object.entries(scripts)) {
      expect(script.name).toBe(name);
      expect(script.purposes.length).toBeGreaterThan(0);
      expect(["V1", "V2", "V3"]).toContain(script.plutusVersion);
    }
    expect(registry.toolchain.aikenV3).toContain(EXPECTED_COMPILERS.v3);
    expect(registry.toolchain.aikenV2).toContain(EXPECTED_COMPILERS.v2);
  });

  it("every hash is blake2b-224(version byte || single-CBOR script bytes); the flat bytes are inside; no two scripts share a hash", () => {
    const seen = new Map<string, string>();
    for (const script of Object.values(scripts)) {
      const bytes = hexToBytes(script.cborHex);
      expect(bytesToHex(blake2b224(concat([VERSION_BYTE[script.plutusVersion]], bytes))), script.name).toBe(script.hash);
      expect(script.hash).toMatch(/^[0-9a-f]{56}$/);
      const { flat, canonical } = unwrapSingle(script.cborHex);
      expect(canonical, script.name).toBe(true);
      expect(bytesToHex(flat)).toBe(script.flatHex);
      expect(script.sizeBytes).toBe(bytes.length);
      expect(script.flatBytes).toBe(flat.length);
      // flat header: Plutus core version 1.0.0 for V1 / V2, 1.1.0 for V3
      expect(script.flatHex.startsWith(script.plutusVersion === "V3" ? "010100" : "010000"), script.name).toBe(true);
      expect(seen.get(script.hash), `${script.name} duplicates ${seen.get(script.hash)}`).toBeUndefined();
      seen.set(script.hash, script.name);
      // the toolkit's loader agrees (it re-hashes the bytes)
      expect(toolkitScriptHash(registryScript(script.name))).toBe(script.hash);
    }
    for (const native of registry.native) {
      expect(seen.get(native.hash), `native ${native.name}`).toBeUndefined();
      seen.set(native.hash, native.name);
    }
  });

  it("the tool's own script reader sees the same bytes, wrapping and size (single-wrapped, 0x59 header from 256 bytes)", () => {
    for (const script of Object.values(scripts)) {
      const read = unwrapScriptHex(script.cborHex);
      expect(read.wrapping, script.name).toBe("single");
      expect(read.flatHex).toBe(script.flatHex);
      expect(read.sizeBytes).toBe(script.sizeBytes);
      expect(script.cborHex.startsWith(script.sizeBytes >= 256 ? "59" : "58") || script.sizeBytes < 24 + 1, script.name).toBe(true);
    }
  });

  it("the size targets other tests rely on", () => {
    const s = scripts;
    // order_spend: the big parameterised V2 spend validator (decompiler / debugger tests)
    expect(s.order_spend!.termCount).toBeGreaterThan(1000);
    expect(s.order_spend!.uplcLines).toBeGreaterThan(400);
    expect(s.order_spend!.debuggerListingLines).toBeGreaterThan(600);
    expect(s.order_spend!.pseudocodeLines).toBeGreaterThanOrEqual(200);
    expect(s.order_spend!.handlerLine).toBe("spend(datum, redeemer, script_context) {");
    expect(s.order_fixed!.pseudocodeLines).toBeGreaterThanOrEqual(200);
    expect(s.order_fixed!.firstNote).toMatch(/^Outer Apply chain/);
    expect(s.order_spend!.firstNote).toMatch(/^Applied compile-time params/);
    expect(s.order_spend!.params.map((p) => p.name)).toEqual(["operator", "fee_numerator"]);
    // pool mints: >= 256 bytes (0x59 header), decompile to mint(
    for (const name of ["pool_mint_a", "pool_mint_b"]) {
      expect(s[name]!.sizeBytes, name).toBeGreaterThan(256);
      expect(s[name]!.cborHex.startsWith("59"), name).toBe(true);
      expect(s[name]!.purposes).toEqual(["mint"]);
      expect(s[name]!.handlerLine, name).toMatch(/^mint\(/);
    }
    expect(s.pool_mint_a!.hash).not.toBe(s.pool_mint_b!.hash);
    // guardrails: 1.5 - 2.5 KB, propose handler
    expect(s.guardrails!.sizeBytes).toBeGreaterThanOrEqual(1500);
    expect(s.guardrails!.sizeBytes).toBeLessThanOrEqual(2500);
    expect(s.guardrails!.purposes).toEqual(["propose", "vote", "publish"]);
    expect(s.guardrails!.handlerLine).toMatch(/^propose\(/);
    // small scripts
    expect(s.lock_spend!.sizeBytes).toBeGreaterThanOrEqual(600);
    expect(s.lock_spend!.sizeBytes).toBeLessThanOrEqual(1500);
    expect(s.tiny!.sizeBytes).toBeLessThanOrEqual(32);
    expect(s.loop_v2!.sizeBytes).toBeLessThanOrEqual(16);
    expect(s.burn_mint!.sizeBytes).toBeGreaterThan(256);
    expect(s.v1_dummy!.plutusVersion).toBe("V1");
    expect(s.tiny_v3!.plutusVersion).toBe("V3");
  });

  it("parameters are inside the compiled bytes; the named keys are the ones the registry says", () => {
    const operator = paymentKey("script-operator");
    expect(operatorKeyHash()).toBe(operator.keyHashHex);
    expect(registry.keys.operator).toMatchObject({ label: "payment/script-operator", keyHash: operator.keyHashHex });
    for (const script of Object.values(scripts)) {
      for (const param of script.params) expect(script.flatHex, `${script.name}.${param.name}`).toContain(param.cbor);
    }
    const byName = (script: RegistryScript, name: string) => script.params.find((p) => p.name === name)!;
    expect(byName(scripts.order_spend!, "operator").value).toBe(operator.keyHashHex);
    expect(byName(scripts.order_spend!, "fee_numerator").value).toBe(30);
    expect(byName(scripts.burn_mint!, "admin").value).toBe(operator.keyHashHex);
    expect(byName(scripts.pool_mint_a!, "owner").value).toBe(operator.keyHashHex);
    expect(byName(scripts.pool_mint_a!, "reference_holder").value).toBe(scripts.spend_v3!.hash);
    expect(byName(scripts.pool_mint_b!, "seed").value).toEqual({ transactionId: bytesToHex(blake2b256(utf8(SEED_PHRASE))), outputIndex: SEED_INDEX });
    expect(seedTxId()).toBe(bytesToHex(blake2b256(utf8(SEED_PHRASE))));
    // order_fixed has the same operator compiled in as a constant: the constant in the source is the named key's hash
    const fixedSource = readFileSync(path.join(SYNTHETIC_DIR, "aiken-v2", "validators", "order_fixed.ak"), "utf8");
    expect(fixedSource).toContain(`#"${operator.keyHashHex}"`);
    expect(scripts.order_fixed!.params).toEqual([]);
    expect(scripts.order_fixed!.flatHex).toContain(operator.keyHashHex);
  });

  it("unparameterised scripts are exactly the committed blueprint's compiledCode; applied ones are not", () => {
    const blueprints = {
      "aiken-v2": JSON.parse(readFileSync(path.join(SYNTHETIC_DIR, "aiken-v2", "plutus.json"), "utf8")) as { preamble: { compiler: { version: string }; plutusVersion: string }; validators: Array<{ title: string; compiledCode: string; hash: string }> },
      "aiken-v3": JSON.parse(readFileSync(path.join(SYNTHETIC_DIR, "aiken-v3", "plutus.json"), "utf8")) as { preamble: { compiler: { version: string }; plutusVersion: string }; validators: Array<{ title: string; compiledCode: string; hash: string }> },
    };
    expect(blueprints["aiken-v2"].preamble).toMatchObject({ plutusVersion: "v2", compiler: { version: registry.toolchain.aikenV2.replace(/^aiken /, "") } });
    expect(blueprints["aiken-v3"].preamble).toMatchObject({ plutusVersion: "v3", compiler: { version: registry.toolchain.aikenV3.replace(/^aiken /, "") } });
    for (const script of Object.values(scripts).filter((s) => s.kind === "aiken")) {
      const project = script.source.startsWith("aiken-v2") ? "aiken-v2" : "aiken-v3";
      const entry = blueprints[project].validators.find((v) => v.title === script.blueprint);
      expect(entry, script.name).toBeDefined();
      expect(script.plutusVersion).toBe(project === "aiken-v2" ? "V2" : "V3");
      if (script.params.length === 0) {
        expect(entry!.compiledCode).toBe(script.cborHex);
        expect(entry!.hash).toBe(script.hash);
      } else {
        expect(entry!.compiledCode, script.name).not.toBe(script.cborHex);
        expect(script.sizeBytes).toBeGreaterThan(entry!.compiledCode.length / 2);
      }
      expect(existsSync(path.join(SYNTHETIC_DIR, script.source)), script.source).toBe(true);
    }
    for (const script of Object.values(scripts).filter((s) => s.kind === "uplc")) {
      expect(existsSync(path.join(SYNTHETIC_DIR, script.source)), script.source).toBe(true);
    }
  });

  it("the native-script catalogue: structure, cbor, hashes and the toolkit loader", () => {
    expect(registry.native).toEqual(JSON.parse(JSON.stringify(nativeCatalogue())));
    const byName = new Map(registry.native.map((n) => [n.name, n]));
    expect([...byName.keys()]).toEqual(["all_empty", "any_empty", "sig_operator", "after_slot_1000", "before_slot_1000", "operator_and_window", "multisig_3_of_6"]);
    expect(byName.get("all_empty")!.cborHex).toBe("820180");
    expect(byName.get("any_empty")!.cborHex).toBe("820280");
    expect(byName.get("sig_operator")!.cborHex).toBe(`8200581c${paymentKey("script-operator").keyHashHex}`);
    expect(byName.get("after_slot_1000")!.cborHex).toBe("82041903e8");
    expect(byName.get("before_slot_1000")!.cborHex).toBe("82051903e8");
    const multisig = byName.get("multisig_3_of_6")!;
    expect(multisig.sizeBytes).toBe(196);
    expect(multisig.cborHex.startsWith("83030386")).toBe(true);
    expect(multisig.json).toMatchObject({ type: "atLeast", n: 3 });
    expect(multisig.cliJson).toMatchObject({ type: "atLeast", required: 3 });
    for (const native of registry.native) {
      expect(bytesToHex(blake2b224(concat([0], hexToBytes(native.cborHex)))), native.name).toBe(native.hash);
      expect(native.sizeBytes).toBe(native.cborHex.length / 2);
      expect(registryNative(native.name).kind).toBe("native");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the engine and the decompiler

let catalogue: CatalogueIndex;

beforeAll(() => {
  engine.initSync({ module: readWasm("de_uplc_bg.wasm") });
  decompilerWasm.initSync({ module: readWasm("de_uplc_decompiler_wasm_bg.wasm") });
  catalogue = new CatalogueIndex(parseCatalogue(decompilerWasm.options_catalogue()));
});

/** Number of term nodes in dehosk's textual UPLC (an independent decode of the flat bytes: not the engine's term index). */
function countTermsInText(text: string): number {
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const word = () => {
    skipSpace();
    const start = i;
    while (i < text.length && !/[\s()[\]]/.test(text[i]!)) i++;
    return text.slice(start, i);
  };
  const skipBalanced = () => {
    // at the first character after a `(con` keyword: advance past the matching `)` (strings may hold brackets)
    let depth = 1;
    while (i < text.length && depth > 0) {
      const c = text[i]!;
      if (c === '"') {
        i++;
        while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      } else if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      i++;
    }
  };
  const term = (): number => {
    skipSpace();
    const c = text[i]!;
    if (c === "[") {
      i++;
      let count = term();
      let args = 0;
      for (;;) {
        skipSpace();
        if (text[i] === "]") break;
        count += term();
        args++;
      }
      i++;
      return count + args;
    }
    if (c === "(") {
      i++;
      const keyword = word();
      let count = 1;
      if (keyword === "con") {
        skipBalanced();
        return count;
      }
      if (keyword === "lam") {
        word();
        count += term();
      } else if (keyword === "builtin") {
        word();
      } else if (keyword === "constr") {
        word();
        for (;;) {
          skipSpace();
          if (text[i] === ")") break;
          count += term();
        }
      } else if (keyword === "force" || keyword === "delay") {
        count += term();
      } else if (keyword === "case") {
        for (;;) {
          skipSpace();
          if (text[i] === ")") break;
          count += term();
        }
      } else if (keyword !== "error") {
        throw new Error(`unknown term keyword ${keyword}`);
      }
      skipSpace();
      if (text[i] !== ")") throw new Error(`expected ) at ${i}: ${text.slice(i, i + 30)}`);
      i++;
      return count;
    }
    word();
    return 1;
  };
  skipSpace();
  if (text.slice(i, i + 8) !== "(program") throw new Error("not a program");
  i += 8;
  word();
  const total = term();
  skipSpace();
  if (text[i] !== ")") throw new Error("program not closed");
  return total;
}

describe("engine and decompiler view of every script", () => {
  it("the term count and the debugger listing are the registry's; dehosk's UPLC text has as many terms (two independent decodes)", () => {
    for (const script of Object.values(scripts)) {
      const session = EngineSession.openProgram(engine, script.cborHex, script.plutusVersion);
      try {
        expect(session.script.count, script.name).toBe(script.termCount);
        expect(session.script.lines.length, script.name).toBe(script.debuggerListingLines);
      } finally {
        session.free();
      }
      const options = buildDecompileOptions(catalogue, { view: "uplc", scriptVersion: script.plutusVersion });
      const text = decompilerWasm.decompile_uplc(script.cborHex, options.json);
      expect(countTermsInText(text), script.name).toBe(script.termCount);
    }
  });

  it("every script decompiles; the handler shape, first note and line counts are as recorded", () => {
    const expectedHandler: Record<string, RegExp> = {
      order_spend: /^spend\(datum, redeemer, script_context\) \{$/,
      order_fixed: /^spend\(datum, redeemer, script_context\) \{$/,
      lock_spend: /^spend\(datum, redeemer, script_context\) \{$/,
      burn_mint: /^mint\(redeemer, script_context\) \{$/,
      reward_ok: /^withdraw\(redeemer, script_context\) \{$/,
      pool_mint_a: /^mint\(script_context: ScriptContext\) \{$/,
      pool_mint_b: /^mint\(script_context: ScriptContext\) \{$/,
      guardrails: /^propose\(script_context: ScriptContext\) \{$/,
      spend_v3: /^spend\(script_context: ScriptContext\) \{$/,
    };
    for (const script of Object.values(scripts)) {
      const measured = measureScript(script.cborHex, script.plutusVersion, script.purposes[0]!);
      expect(measured.termCount, script.name).toBe(script.termCount);
      expect(measured.pseudocodeLines, script.name).toBe(script.pseudocodeLines);
      expect(measured.uplcLines, script.name).toBe(script.uplcLines);
      expect(measured.firstNote, script.name).toBe(script.firstNote);
      if (expectedHandler[script.name]) expect(measured.handlerLine, script.name).toMatch(expectedHandler[script.name]!);
    }
    const { text } = pseudocodeOf(scripts.order_spend!);
    expect(text).toMatch(/spend\(datum, redeemer, script_context\)/);
    expect(pseudocodeOf(scripts.guardrails!).text).toMatch(/propose\(script_context: ScriptContext\)/);
    expect(pseudocodeOf(scripts.pool_mint_a!).text).toMatch(/mint\(script_context: ScriptContext\)/);
  });

  function pseudocodeOf(script: RegistryScript): { text: string } {
    const options = buildDecompileOptions(catalogue, { view: "pseudocode", scriptVersion: script.plutusVersion, purpose: script.purposes[0] });
    return { text: decompilerWasm.decompile_uplc(script.cborHex, options.json) };
  }

  it("the applied parameters show up in the decompiler's header", () => {
    const text = pseudocodeOf(scripts.order_spend!).text;
    expect(text).toContain("Applied compile-time params");
    expect(text).toContain("181e"); // fee_numerator = 30
    expect(text).toContain(scripts.order_spend!.params[0]!.value as string); // the operator key hash
    expect(pseudocodeOf(scripts.order_fixed!).text.split("\n")[0]).toMatch(/^\/\/ Outer Apply chain/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// behaviour on hand-built contexts

interface Outcome {
  ok: boolean;
  /** `error` text of the failed run ('' when it succeeded). */
  detail: string;
  traces: string[];
  stopped: string;
  steps: number;
  cpu: bigint;
  mem: bigint;
}

function runScript(name: string, args: { datum?: string; redeemer?: string; context: string }, over: { max_steps?: number } = {}): Outcome {
  const script = scripts[name]!;
  const session = EngineSession.openParts(engine, {
    script: script.cborHex,
    language: script.plutusVersion.toLowerCase(),
    context: args.context,
    ...(args.redeemer !== undefined ? { redeemer: args.redeemer } : {}),
    ...(args.datum !== undefined ? { datum: args.datum } : {}),
  });
  try {
    const report: RunReport = session.run({
      until: "done",
      max_steps: over.max_steps ?? 5_000_000,
      deadline_at: Date.now() + 30_000,
      breakpoints: { term_ids: [], uplc_lines: [] },
      skip_first: false,
      context_lines: 1,
      frames: 0,
      max_new_traces: 50,
    });
    return {
      ok: report.status === "done",
      detail: report.stopped.kind === "error" ? String(report.stopped.detail) : "",
      traces: report.traces.new,
      stopped: report.stopped.kind,
      steps: report.steps_total,
      cpu: BigInt(report.budget.cpu_spent),
      mem: BigInt(report.budget.mem_spent),
    };
  } finally {
    session.free();
  }
}

const operator = paymentKey("script-operator").keyHashHex;
const stranger = paymentKey("script-stranger").keyHashHex;
const maker = paymentKey("script-maker").keyHashHex;
const sellPolicy = "bb".repeat(28);
const sellAsset = "4f524445";
const nothing = constr(1, []);

describe("order_spend / order_fixed (V2, order-book rules of aiken-v2/lib/order_book.ak)", () => {
  const orderScript = "44".repeat(28);
  const own = { txId: "11".repeat(32), index: 0 };
  const datum = (quantity: number, over: { unitPrice?: number } = {}): PlutusData =>
    constr(0, [addressData({ key: maker }), pBytes(sellPolicy), pBytes(sellAsset), pInt(over.unitPrice ?? 2_000_000), pInt(quantity), pInt(1_000_000), pBytes("6d656d6f")]);
  const orderInput = (quantity: number): InputSpec => ({
    ...own,
    output: { address: { script: orderScript }, value: { lovelace: 2_000_000, assets: [{ policy: sellPolicy, name: sellAsset, quantity }] }, datum: { inline: datum(quantity) } },
  });
  const context = (tx: TxSpec, quantity = 5) => v2Context({ inputs: [orderInput(quantity)], fee: 200_000, ...tx }, { spending: own });
  const cancel = encode(constr(0, []));
  const fill = (amount: number, payoutIndex: number) => encode(constr(1, [pInt(amount), pInt(payoutIndex)]));
  const reprice = (price: number) => encode(constr(2, [pInt(price)]));
  const pay = (key: string, lovelace: number) => ({ address: { key }, value: { lovelace } });
  const continuing = (quantity: number, over: { unitPrice?: number } = {}) => ({
    address: { script: orderScript },
    value: { lovelace: 2_000_000, assets: [{ policy: sellPolicy, name: sellAsset, quantity }] },
    datum: { inline: datum(quantity, over) },
  });

  for (const name of ["order_spend", "order_fixed"]) {
    describe(name, () => {
      const run = (redeemer: string, tx: TxSpec, quantity = 5, datumData: PlutusData = datum(quantity)) => runScript(name, { datum: encode(datumData), redeemer, context: context(tx, quantity) });

      it("Cancel: the maker or the operator signs; a stranger does not", () => {
        expect(run(cancel, { signatories: [maker] }).ok).toBe(true);
        expect(run(cancel, { signatories: [operator] }).ok).toBe(true);
        const refused = run(cancel, { signatories: [stranger] });
        expect(refused.ok).toBe(false);
        expect(run(cancel, {}).ok).toBe(false);
      });

      it("Fill: the whole order, a partial fill with a continuing output, and the ways to get it wrong", () => {
        // 5 units at 2 ada = 10 ada, 30 bps fee = 30,000 lovelace to the operator
        const whole = { validTo: 900_000, outputs: [pay(maker, 9_970_000), pay(operator, 30_000)] };
        expect(run(fill(5, 0), whole).ok).toBe(true);
        // 2 of 5 units: 4 ada, fee 12,000, three units stay in the order with the datum's quantity reduced
        const partial = { validTo: 900_000, outputs: [pay(maker, 3_988_000), pay(operator, 12_000), continuing(3)] };
        expect(run(fill(2, 0), partial).ok).toBe(true);
        expect(run(fill(2, 0), { ...partial, outputs: [pay(maker, 3_988_000), pay(operator, 12_000), continuing(4)] }).ok).toBe(false);
        expect(run(fill(2, 0), { ...partial, outputs: [pay(maker, 3_988_000), pay(operator, 12_000)] }).ok).toBe(false);
        expect(run(fill(5, 0), { ...whole, outputs: [pay(maker, 9_000_000), pay(operator, 30_000)] }).ok).toBe(false); // maker underpaid
        expect(run(fill(5, 0), { ...whole, outputs: [pay(maker, 9_970_000)] }).ok).toBe(false); // no operator fee
        expect(run(fill(5, 0), { ...whole, validTo: 1_000_001 }).ok).toBe(false); // after expiry
        expect(run(fill(5, 0), { ...whole, validTo: undefined }).ok).toBe(false); // no upper bound
        expect(run(fill(6, 0), { ...whole, outputs: [pay(maker, 11_970_000), pay(operator, 30_000)] }).ok).toBe(false); // more than the order holds
        expect(run(fill(5, 0), { ...whole, mint: { assets: [{ policy: sellPolicy, name: sellAsset, quantity: 1 }] } }).ok).toBe(false); // minting the sold token
        expect(run(fill(5, 0), { ...whole, mint: { assets: [{ policy: sellPolicy, name: sellAsset, quantity: -1 }] } }).ok).toBe(true); // burning it is fine
      });

      it("Reprice: the maker signs and the new datum carries the new price", () => {
        const ok = { signatories: [maker], outputs: [continuing(5, { unitPrice: 3_000_000 })] };
        expect(run(reprice(3_000_000), ok).ok).toBe(true);
        expect(run(reprice(3_000_000), { ...ok, signatories: [operator] }).ok).toBe(false);
        expect(run(reprice(3_000_000), { ...ok, outputs: [continuing(5)] }).ok).toBe(false);
      });

      it("a datum that is not a constructor (a list) fails with a builtin failure on unConstrData", () => {
        const failed = run(cancel, { signatories: [maker] }, 5, pList([pInt(1), pInt(2)]));
        expect(failed.ok).toBe(false);
        expect(failed.stopped).toBe("error");
        expect(failed.detail).toMatch(/UnConstrData/);
        // a constructor with the wrong number of fields is not a datum either
        expect(run(cancel, { signatories: [maker] }, 5, constr(0, [pInt(1)])).ok).toBe(false);
      });

      it("runs in a few thousand steps (about 20 M cpu / 70 k mem on Cancel)", () => {
        const done = run(cancel, { signatories: [operator] });
        expect(done.steps).toBeGreaterThan(500);
        expect(done.steps).toBeLessThan(5_000);
        expect(done.cpu).toBeGreaterThan(5_000_000n);
        expect(done.cpu).toBeLessThan(60_000_000n);
      });
    });
  }
});

describe("burn_mint (V2 minting policy)", () => {
  const policy = scripts.burn_mint!.hash;
  const name = "4d454c44";
  const context = (quantity: number, signatories: string[] = []) => v2Context({ mint: { assets: [{ policy, name, quantity }] }, signatories }, { minting: policy });
  const run = (redeemer: PlutusData, quantity: number, signatories?: string[]) => runScript("burn_mint", { redeemer: encode(redeemer), context: context(quantity, signatories) });

  it("Burn passes with negative quantities and no signature, fails with a positive one", () => {
    expect(run(constr(1, []), -15_000_000_000_000).ok).toBe(true);
    expect(run(constr(1, []), 15).ok).toBe(false);
    expect(runScript("burn_mint", { redeemer: encode(constr(1, [])), context: v2Context({ signatories: [] }, { minting: policy }) }).ok).toBe(false); // nothing of the policy in the mint field
  });

  it("MintTokens needs the admin, the right name and a quantity within the cap", () => {
    expect(run(constr(0, [pBytes(name)]), 500, [operator]).ok).toBe(true);
    expect(run(constr(0, [pBytes(name)]), 500, []).ok).toBe(false);
    expect(run(constr(0, [pBytes(name)]), 1_000_000_000_000_001, [operator]).ok).toBe(false);
    expect(run(constr(0, [pBytes("6f74686572")]), 500, [operator]).ok).toBe(false);
  });
});

describe("reward_ok and lock_spend (small V2 validators)", () => {
  const script = "44".repeat(28);
  const own = { txId: "11".repeat(32), index: 0 };
  const lockedInput = (address: { script: string } | { key: string }, lovelace: number): InputSpec => ({ ...own, output: { address, value: { lovelace } } });

  it("reward_ok: Constr 0 passes, Constr 1 fails with its trace, anything else fails", () => {
    const context = v2Context({}, { rewarding: { script } });
    expect(runScript("reward_ok", { redeemer: encode(constr(0, [])), context }).ok).toBe(true);
    const denied = runScript("reward_ok", { redeemer: encode(constr(1, [])), context });
    expect(denied.ok).toBe(false);
    expect(denied.traces).toEqual(["reward_ok: denied"]);
    expect(runScript("reward_ok", { redeemer: encode(constr(5, [])), context }).ok).toBe(false);
    expect(runScript("reward_ok", { redeemer: encode(pInt(0)), context }).ok).toBe(false);
  });

  it("lock_spend: Unlock passes (and traces), Refund fails with its trace, Batch and Sweep follow their rules", () => {
    const datum = encode(pInt(1));
    const ctx = (tx: TxSpec) => v2Context({ inputs: [lockedInput({ script }, 5_000_000)], fee: 200_000, ...tx }, { spending: own });
    const unlock = runScript("lock_spend", { datum, redeemer: encode(constr(1, [])), context: ctx({}) });
    expect(unlock.ok).toBe(true);
    expect(unlock.traces).toEqual(["lock_spend: unlocking"]);
    const refund = runScript("lock_spend", { datum, redeemer: encode(constr(0, [])), context: ctx({}) });
    expect(refund.ok).toBe(false);
    expect(refund.traces).toEqual(["lock_spend: refund is disabled"]);
    expect(runScript("lock_spend", { datum, redeemer: encode(constr(9, [])), context: ctx({}) }).ok).toBe(false);
    // unlocking an input that is not among the inputs
    expect(runScript("lock_spend", { datum, redeemer: encode(constr(1, [])), context: v2Context({ inputs: [] }, { spending: own }) }).ok).toBe(false);
    // Batch: two of the three inputs sit at the script
    const three = { inputs: [lockedInput({ script }, 1_000_000), { txId: "22".repeat(32), index: 1, output: { address: { script }, value: { lovelace: 1_000_000 } } }, { txId: "33".repeat(32), index: 0, output: { address: { key: maker }, value: { lovelace: 1_000_000 } } }] };
    expect(runScript("lock_spend", { datum, redeemer: encode(constr(2, [pInt(2)])), context: ctx(three) }).ok).toBe(true);
    const mismatch = runScript("lock_spend", { datum, redeemer: encode(constr(2, [pInt(3)])), context: ctx(three) });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.traces).toEqual(["lock_spend: batch size mismatch"]);
    // Sweep: output 0 to a key address with the input's lovelace minus the fee
    expect(runScript("lock_spend", { datum, redeemer: encode(constr(3, [pInt(0)])), context: ctx({ outputs: [{ address: { key: maker }, value: { lovelace: 4_800_000 } }] }) }).ok).toBe(true);
    expect(runScript("lock_spend", { datum, redeemer: encode(constr(3, [pInt(0)])), context: ctx({ outputs: [{ address: { key: maker }, value: { lovelace: 4_000_000 } }] }) }).ok).toBe(false);
    expect(runScript("lock_spend", { datum, redeemer: encode(constr(3, [pInt(0)])), context: ctx({ outputs: [{ address: { script }, value: { lovelace: 4_800_000 } }] }) }).ok).toBe(false);
  });
});

describe("hand-written UPLC", () => {
  const context = v2Context({}, { minting: "aa".repeat(28) });

  it("tiny and v1_dummy succeed, whatever the arguments", () => {
    for (const name of ["tiny", "v1_dummy"]) {
      expect(runScript(name, { datum: encode(pInt(1)), redeemer: encode(pInt(2)), context }).ok, name).toBe(true);
      expect(runScript(name, { redeemer: encode(pInt(2)), context }).ok, `${name} with two arguments`).toBe(true);
    }
    expect(runScript("tiny_v3", { context: v3Context({}, constr(0, []), { minting: "aa".repeat(28) }) }).ok).toBe(true);
  });

  it("loop_v2 never finishes: it stops at the step limit with the budget growing", () => {
    const outcome = runScript("loop_v2", { datum: encode(pInt(1)), redeemer: encode(pInt(2)), context }, { max_steps: 10_000 });
    expect(outcome.ok).toBe(false);
    expect(outcome.stopped).toBe("limit");
    expect(outcome.steps).toBe(10_000);
    expect(outcome.cpu).toBeGreaterThan(50_000_000n);
    // with two arguments (mint / withdraw) it loops too: it never consumes its first argument without looping
    expect(runScript("loop_v2", { redeemer: encode(pInt(2)), context }, { max_steps: 2_000 }).stopped).toBe("limit");
  });
});

describe("V3 scripts", () => {
  const nothingData = nothing;
  const just = (x: PlutusData) => constr(0, [x]);

  describe("guardrails", () => {
    const guard = scripts.guardrails!.hash;
    const proposal = (changes: Array<[number, PlutusData]>): PlutusData =>
      constr(0, [pInt(100_000_000_000), credentialData({ key: "11".repeat(28) }), constr(0, [nothingData, pMap(changes.map(([k, v]) => [pInt(k), v] as [PlutusData, PlutusData])), just(pBytes(guard))])]);
    const propose = (changes: Array<[number, PlutusData]>, redeemer: PlutusData = pMap([])) => {
      const p = proposal(changes);
      return runScript("guardrails", { context: v3Context({ proposals: [p] }, redeemer, { proposing: { index: 0, proposal: p } }) });
    };
    const units = (memory: number, cpu: number) => pList([pInt(memory), pInt(cpu)]);
    const price = (numerator: number, denominator: number) => pList([pInt(numerator), pInt(denominator)]);

    it("propose: an empty ParameterChange with the redeemer `Map []` passes", () => {
      const outcome = propose([]);
      expect(outcome.ok).toBe(true);
      expect(outcome.traces).toEqual([]);
    });

    it("propose: changed parameters inside their bounds pass, one outside fails", () => {
      expect(propose([[3, pInt(16_384)], [17, pInt(4_310)], [23, pInt(150)]]).ok).toBe(true);
      expect(propose([[20, units(14_000_000, 10_000_000_000)], [21, units(62_000_000, 20_000_000_000)], [19, pList([price(577, 10_000), price(721, 10_000_000)])]]).ok).toBe(true);
      expect(propose([[0, pInt(101)]]).ok).toBe(false);
      expect(propose([[23, pInt(50)]]).ok).toBe(false);
      expect(propose([[20, units(41_000_000, 10_000_000_000)]]).ok).toBe(false);
      expect(propose([[3, pInt(16_384)], [23, pInt(500)]]).ok).toBe(false);
    });

    it("propose: a redeemer that is not a map fails with a builtin failure on unMapData", () => {
      const outcome = propose([], constr(0, []));
      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toMatch(/UnMapData/);
    });

    it("propose: treasury withdrawals up to the cap pass; other actions fail", () => {
      const withdrawal = (amounts: number[]): PlutusData =>
        constr(0, [pInt(100_000_000_000), credentialData({ key: "11".repeat(28) }), constr(2, [pMap(amounts.map((a) => [credentialData({ key: "22".repeat(28) }), pInt(a)] as [PlutusData, PlutusData])), nothingData])]);
      const run = (p: PlutusData) => runScript("guardrails", { context: v3Context({ proposals: [p] }, pMap([]), { proposing: { index: 0, proposal: p } }) });
      expect(run(withdrawal([5_000_000_000, 1_000_000])).ok).toBe(true);
      expect(run(withdrawal([10_000_000_000_001])).ok).toBe(false);
      expect(run(withdrawal([5_000_000_000, 0])).ok).toBe(false);
      expect(run(constr(0, [pInt(100_000_000_000), credentialData({ key: "11".repeat(28) }), constr(6, [])])).ok).toBe(false); // an info action
    });

    it("vote: needs a signer; a pool must sign itself; others need Constr 0", () => {
      const drep = constr(1, [constr(1, [pBytes("33".repeat(28))])]);
      const vote = (redeemer: PlutusData, voter: PlutusData, signatories: string[]) => runScript("guardrails", { context: v3Context({ signatories }, redeemer, { voting: voter }) });
      expect(vote(constr(0, []), drep, [operator]).ok).toBe(true);
      expect(vote(constr(1, []), drep, [operator]).ok).toBe(false);
      expect(vote(constr(0, []), drep, []).ok).toBe(false);
      const pool = constr(2, [pBytes("55".repeat(28))]);
      expect(vote(constr(1, []), pool, ["55".repeat(28)]).ok).toBe(true);
      expect(vote(constr(0, []), pool, [operator]).ok).toBe(false);
    });
  });

  describe("pool_mint_a (CIP-68 pair) and pool_mint_b (one-shot NFT)", () => {
    const policyA = scripts.pool_mint_a!.hash;
    const holder = scripts.spend_v3!.hash;
    const suffix = "506f6f6c";
    const referenceName = `000643b0${suffix}`;
    const userName = `000de140${suffix}`;
    const metadata = (version = 1, withImage = true): PlutusData =>
      constr(0, [pMap([[pBytes("6e616d65"), pBytes("506f6f6c")], ...(withImage ? [[pBytes("696d616765"), pBytes("697066733a2f2f78")] as [PlutusData, PlutusData]] : [])]), pInt(version), pInt(0)]);
    const mintPair = (opts: { signers?: string[]; datum?: PlutusData; holderHash?: string; extra?: boolean } = {}) =>
      runScript("pool_mint_a", {
        context: v3Context(
          {
            mint: { assets: [{ policy: policyA, name: referenceName, quantity: 1 }, { policy: policyA, name: userName, quantity: 1 }, ...(opts.extra ? [{ policy: policyA, name: "6578", quantity: 1 }] : [])] },
            signatories: opts.signers ?? [operator],
            outputs: [{ address: { script: opts.holderHash ?? holder }, value: { lovelace: 2_000_000, assets: [{ policy: policyA, name: referenceName, quantity: 1 }] }, datum: { inline: opts.datum ?? metadata() } }],
          },
          constr(0, [pBytes(suffix), pInt(0)]),
          { minting: policyA },
        ),
      });

    it("MintPair: owner signs, the reference token goes to spend_v3 with a CIP-68 datum", () => {
      expect(mintPair().ok).toBe(true);
      expect(mintPair({ signers: [] }).ok).toBe(false);
      expect(mintPair({ datum: metadata(2) }).ok).toBe(false);
      expect(mintPair({ datum: metadata(1, false) }).ok).toBe(false);
      expect(mintPair({ holderHash: "44".repeat(28) }).ok).toBe(false);
      expect(mintPair({ extra: true }).ok).toBe(false);
    });

    it("BurnPair: owner signs and both tokens are burned", () => {
      const burn = (signers: string[], names: string[]) =>
        runScript("pool_mint_a", { context: v3Context({ mint: { assets: names.map((name) => ({ policy: policyA, name, quantity: -1 })) }, signatories: signers }, constr(1, [pBytes(suffix)]), { minting: policyA }) });
      expect(burn([operator], [referenceName, userName]).ok).toBe(true);
      expect(burn([], [referenceName, userName]).ok).toBe(false);
      expect(burn([operator], [userName]).ok).toBe(false);
    });

    it("pool_mint_b: MintNft spends the seed output and mints exactly one token; BurnNft needs negative quantities", () => {
      const policyB = scripts.pool_mint_b!.hash;
      const seed = scripts.pool_mint_b!.params[0]!.value as { transactionId: string; outputIndex: number };
      const seedInput: InputSpec = { txId: seed.transactionId, index: seed.outputIndex, output: { address: { key: maker }, value: { lovelace: 5_000_000 } } };
      const mint = (inputs: InputSpec[], quantity: number) =>
        runScript("pool_mint_b", { context: v3Context({ inputs, mint: { assets: [{ policy: policyB, name: "4e4654", quantity }] } }, constr(0, [pBytes("4e4654")]), { minting: policyB }) });
      expect(mint([seedInput], 1).ok).toBe(true);
      expect(mint([], 1).ok).toBe(false);
      expect(mint([seedInput], 2).ok).toBe(false);
      const burn = (quantity: number) => runScript("pool_mint_b", { context: v3Context({ mint: { assets: [{ policy: policyB, name: "4e4654", quantity }] } }, constr(1, []), { minting: policyB }) });
      expect(burn(-1).ok).toBe(true);
      expect(burn(1).ok).toBe(false);
    });
  });

  describe("spend_v3 (time-lock vault)", () => {
    const own = { txId: "11".repeat(32), index: 0 };
    const vault = constr(0, [pBytes(operator), pInt(1_000)]);
    const vaultInput = (datum: { inline: PlutusData } | { hash: string }): InputSpec => ({ ...own, output: { address: { script: scripts.spend_v3!.hash }, value: { lovelace: 5_000_000 }, datum } });
    const run = (redeemer: PlutusData, opts: { signers?: string[]; validFrom?: number; datum?: { inline: PlutusData } | { hash: string }; scriptDatum?: PlutusData | undefined } = {}) =>
      runScript("spend_v3", {
        context: v3Context(
          { inputs: [vaultInput(opts.datum ?? { inline: vault })], signatories: opts.signers ?? [operator], validFrom: opts.validFrom ?? 2_000 },
          redeemer,
          { spending: { ...own, ...("scriptDatum" in opts ? (opts.scriptDatum ? { datum: opts.scriptDatum } : {}) : { datum: vault }) } },
        ),
      });

    it("Withdraw: owner signs, validity starts at or after unlock_after, inline datum", () => {
      expect(run(constr(0, [])).ok).toBe(true);
      expect(run(constr(0, []), { validFrom: 999 }).ok).toBe(false);
      expect(run(constr(0, []), { signers: [stranger] }).ok).toBe(false);
      expect(run(constr(0, []), { datum: { hash: "55".repeat(32) } }).ok).toBe(false);
      expect(run(constr(0, []), { scriptDatum: undefined }).ok).toBe(false);
    });

    it("Extend fails with its trace", () => {
      const outcome = run(constr(1, []));
      expect(outcome.ok).toBe(false);
      expect(outcome.traces).toEqual(["spend_v3: extend is not supported"]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// reproducibility (needs the two compilers)

const aikenV2 = process.env.AIKEN_V2;
const aikenV3 = process.env.AIKEN_V3 ?? (aikenV2 ? "aiken" : undefined);

describe.skipIf(!aikenV2 || !aikenV3)("fixtures:compile reproduces the committed scripts", () => {
  it("recompiling gives byte-identical scripts.json and plutus.json files (AIKEN_V2 and AIKEN_V3 set)", () => {
    const before = {
      registry: readFileSync(path.join(SYNTHETIC_DIR, "scripts.json"), "utf8"),
      v2: readFileSync(path.join(SYNTHETIC_DIR, "aiken-v2", "plutus.json"), "utf8"),
      v3: readFileSync(path.join(SYNTHETIC_DIR, "aiken-v3", "plutus.json"), "utf8"),
    };
    const fresh = compileAll({ aikenV2: aikenV2!, aikenV3: aikenV3! });
    expect(renderRegistry(fresh)).toBe(before.registry);
    expect(readFileSync(path.join(SYNTHETIC_DIR, "aiken-v2", "plutus.json"), "utf8")).toBe(before.v2);
    expect(readFileSync(path.join(SYNTHETIC_DIR, "aiken-v3", "plutus.json"), "utf8")).toBe(before.v3);
  }, 300_000);
});
