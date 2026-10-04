// Validator-in-the-loop fitting: take a TxSpec whose money and units are still open and make it exactly what a
// scenario wants, checked by the real validator.
//
//   const fitted = fit(spec, { ctx, keys: [alice, bob] });          // fully valid
//   const bad    = fit(spec, { ctx, keys, feeAdjust: -1n, expect: { errors: ["FeeTooSmallUTxO"] } });
//
// What `fit` settles, repeating until nothing moves (usually 3 rounds):
//   - output coins written as "min" (minimum UTxO value), the change output (`change: true`) = inputs + withdrawals + refunds
//     + mint - outputs - fee - deposits - donation, assets included;
//   - ex-units of every redeemer from the validator's phase 2 (`exUnits`: exact, a slack, or as declared);
//   - the fee: the validator's own `min_fee` (it counts the size of the tx minus one byte; reference-script tiers and the
//     execution-unit price are in it) plus `feeAdjust`;
//   - collateral: total collateral and the return output (assets and surplus back to the first collateral input's address);
//   - the script data hash (assemble computes it from the final redeemers / datums / cost models) and the vkey witnesses
//     (`spec.signers`, or the keys from `keys` the transaction needs).
// Then `expect` is checked against the validator's answer; a mismatch throws with the diagnostics.

import type { ProtocolParameters } from "@cardananium/cquisitor-lib";

import { type Credential, parseAddress } from "./address.js";
import { bytesToHex } from "./bytes.js";
import { type ChainContext, findUtxo, envOf, type Utxo } from "./context.js";
import { encode } from "./cbor.js";
import type { KeyPair } from "./keys.js";
import { scriptSize } from "./script.js";
import {
  assemble,
  addressBytes,
  certWitnessCredential,
  outputCbor,
  type BuiltTx,
  type Cert,
  type ResolvedRedeemer,
  type TxIn,
  type TxOut,
  type TxSpec,
  sortIns,
} from "./tx.js";
import { addValue, hasAssets, isNonNegative, subValue, sumValues, type Value, addAssets } from "./value.js";
import { errorKinds, validate, type ValidationResult } from "./validator.js";

export type ExUnitsMode =
  | "exact"
  | "declared"
  /** Choose the declared units from the calculated ones. */
  | ((calculated: { mem: bigint; steps: bigint }, redeemer: ResolvedRedeemer) => { mem: bigint; steps: bigint });

/** Declared = calculated * (1 + fraction), rounded up. */
export function slack(memFraction: number, stepsFraction: number): ExUnitsMode {
  const scale = (n: bigint, f: number) => n + BigInt(Math.ceil(Number(n) * f));
  return (c) => ({ mem: scale(c.mem, memFraction), steps: scale(c.steps, stepsFraction) });
}

export interface ExpectDiagnostics {
  /** Phase-1 error kinds, in order (`errors[].error` variant names). */
  errors?: string[];
  /** Phase-1 warning kinds, in order. */
  warnings?: string[];
  /** Number of phase-2 errors. */
  phase2Errors?: number;
  /** Phase-2 warning kinds, in order (`BudgetIsBiggerThanExpected` when declared units exceed the calculated ones). */
  phase2Warnings?: string[];
}

export interface FitOptions {
  ctx: ChainContext;
  /** Key book: the vkey witnesses are made from the keys whose hash the transaction needs (ignored when `spec.signers` is set). */
  keys?: KeyPair[];
  exUnits?: ExUnitsMode;
  /** Added to the validator's minimum fee (default 0: the exact minimum). */
  feeAdjust?: bigint;
  /** Fix the fee (no search). */
  fee?: bigint;
  /** Fill the change output (default: true when an output has `change: true`). */
  balance?: boolean;
  collateral?: {
    /** Where the collateral return goes (default: the address of the first collateral input). */
    returnTo?: TxOut["address"];
    /** `percent` (default): ceil(fee * collateralPercentage / 100); `all`: everything is taken (no return); or a fixed amount. */
    total?: "percent" | "all" | bigint;
    /** Leave field 17 out although a return exists. */
    omitTotal?: boolean;
    /** Do not add the return output. */
    omitReturn?: boolean;
    /** Leave `collateralReturn` and `totalCollateral` exactly as the spec has them. */
    manual?: boolean;
  };
  /** `valid` (default): no phase-1 / phase-2 error. `any`: no check. Or exact lists of diagnostic kinds. */
  expect?: "valid" | "any" | ExpectDiagnostics;
  /**
   * `false`: never call the validator (for a script that never terminates: phase 2 cannot be interrupted in-process).
   * The fee comes from `formulaMinFee`, the ex-units stay as declared, `expect` is ignored and the result's `validation` is empty.
   */
  validate?: boolean;
  maxRounds?: number;
}

export interface Fitted {
  tx: BuiltTx;
  spec: TxSpec;
  /** The validator's answer for the final bytes (empty, with `validated: false`, when `validate: false`). */
  validation: ValidationResult;
  validated: boolean;
  rounds: number;
}

// ---------------------------------------------------------------- money helpers

const bi = (n: number | bigint | string): bigint => BigInt(n);

/** Minimum lovelace of an output: (160 + encoded size) * coinsPerUtxoByte, settled on its own size. */
export function minUtxoCoin(out: TxOut, params: ProtocolParameters): bigint {
  let coin = 1_000_000n;
  for (let i = 0; i < 6; i++) {
    const size = BigInt(encode(outputCbor({ ...out, value: { coin, assets: out.value.assets } })).length);
    const next = (160n + size) * bi(params.adaPerUtxoByte);
    if (next === coin) return coin;
    coin = next;
  }
  return coin;
}

/** Fill every `coin: "min"` output (a plain value outputs the same object type, coins resolved). */
export function resolveMinCoins(spec: TxSpec, params: ProtocolParameters): TxSpec {
  const fix = (o: TxOut): TxOut => (o.value.coin === "min" && !o.change ? { ...o, value: { ...o.value, coin: minUtxoCoin(o, params) } } : o);
  return { ...spec, outputs: spec.outputs.map(fix), collateralReturn: spec.collateralReturn ? fix(spec.collateralReturn) : undefined };
}

/** Reference-script fee (Conway tiers: 15 per byte, x1.2 every 25 KiB), exact rational arithmetic then floor. */
export function referenceScriptFee(totalBytes: number, perByte: { numerator: number | bigint; denominator: number | bigint }): bigint {
  const tier = 25_600n;
  let remaining = bi(totalBytes);
  let priceNum = bi(perByte.numerator);
  let priceDen = bi(perByte.denominator);
  let accNum = 0n; // accumulated fee as a fraction over accDen
  let accDen = 1n;
  while (remaining >= tier) {
    // acc += tier * price
    accNum = accNum * priceDen + tier * priceNum * accDen;
    accDen = accDen * priceDen;
    priceNum *= 6n;
    priceDen *= 5n;
    remaining -= tier;
  }
  accNum = accNum * priceDen + remaining * priceNum * accDen;
  accDen = accDen * priceDen;
  return accNum / accDen;
}

/**
 * The validator counts the transaction as one byte shorter than its CBOR (verified against its own `min_fee` in
 * the unit tests): the fee it asks for is a * (size - 1) + b + the execution-unit price + the reference-script fee.
 */
export const VALIDATOR_SIZE_ADJUST = -1;

/** The minimum fee for a built transaction, from the protocol parameters (the validator's `min_fee` when it reports one wins in `fit`). */
export function formulaMinFee(tx: BuiltTx, ctx: ChainContext): bigint {
  const p = ctx.params;
  const size = BigInt(tx.size + VALIDATOR_SIZE_ADJUST);
  let mem = 0n;
  let steps = 0n;
  for (const r of tx.redeemers) {
    mem += r.exUnits.mem;
    steps += r.exUnits.steps;
  }
  const num = mem * bi(p.executionPrices.memPrice.numerator) * bi(p.executionPrices.stepPrice.denominator) + steps * bi(p.executionPrices.stepPrice.numerator) * bi(p.executionPrices.memPrice.denominator);
  const den = bi(p.executionPrices.memPrice.denominator) * bi(p.executionPrices.stepPrice.denominator);
  const exFee = (num + den - 1n) / den;
  return bi(p.minFeeCoefficientA) * size + bi(p.minFeeConstantB) + exFee + referenceScriptFee(referenceScriptBytes(tx.spec, ctx), p.referenceScriptCostPerByte);
}

/** Total size of reference scripts in spent and reference inputs (the quantity the reference-script fee counts). */
export function referenceScriptBytes(spec: TxSpec, ctx: ChainContext): number {
  let total = 0;
  for (const i of [...spec.inputs, ...(spec.referenceInputs ?? [])]) {
    const u = findUtxo(ctx, i);
    if (u?.scriptRef) total += scriptSize(u.scriptRef);
  }
  return total;
}

function depositsAndRefunds(certs: Cert[], params: ProtocolParameters): { deposits: bigint; refunds: bigint } {
  let deposits = 0n;
  let refunds = 0n;
  for (const c of certs) {
    switch (c.kind) {
      case "stakeReg":
        deposits += c.deposit ?? bi(params.stakeKeyDeposit);
        break;
      case "stakeDereg":
        refunds += c.deposit ?? bi(params.stakeKeyDeposit);
        break;
      case "stakeRegDelegate":
      case "voteRegDelegate":
      case "stakeVoteRegDelegate":
      case "drepReg":
        deposits += c.deposit;
        break;
      case "drepDereg":
        refunds += c.deposit;
        break;
      default:
        break;
    }
  }
  return { deposits, refunds };
}

// ---------------------------------------------------------------- signing keys

/** Key hashes the transaction needs a vkey witness for, derived from the context (inputs, collateral, signers, certificates, votes, withdrawals). */
export function neededKeyHashes(spec: TxSpec, ctx: ChainContext): string[] {
  const need = new Set<string>();
  const addCred = (c: Credential | undefined) => {
    if (c?.kind === "key") need.add(bytesToHex(c.hash));
  };
  for (const i of [...spec.inputs, ...(spec.collateral ?? [])]) {
    const u = findUtxo(ctx, i);
    if (u) addCred(parseAddress(addressBytes(u.address)).payment);
  }
  for (const h of spec.requiredSigners ?? []) need.add(h.toLowerCase());
  for (const w of spec.withdrawals ?? []) addCred(parseAddress(addressBytes(w.account)).stake);
  for (const c of spec.certs ?? []) addCred(certWitnessCredential(c));
  for (const v of spec.votes ?? []) {
    if (v.voter.kind === "spo") need.add(v.voter.hash.toLowerCase());
    else addCred(v.voter.cred);
  }
  return Array.from(need);
}

// ---------------------------------------------------------------- the loop

function exUnitsOfResult(res: ValidationResult, r: ResolvedRedeemer): { mem: bigint; steps: bigint } | undefined {
  const tagName = ["Spend", "Mint", "Cert", "Reward", "Vote", "Propose"][r.tagNumber];
  const hit = res.eval_redeemer_results.find((e) => e.tag === tagName && e.index === r.index);
  const c = hit?.calculated_ex_units;
  return c ? { mem: bi(c.mem), steps: bi(c.steps) } : undefined;
}

/** `min_fee` of a FeeTooSmallUTxO error or FeeIsBiggerThanMinFee warning (the validator prints none when the fee is within its tolerance). */
function reportedMinFee(res: ValidationResult): bigint | undefined {
  for (const e of res.errors) {
    const f = (e.error as Record<string, { min_fee?: number | string }>)?.FeeTooSmallUTxO;
    if (f?.min_fee !== undefined) return bi(f.min_fee);
  }
  for (const w of res.warnings) {
    const f = (w.warning as Record<string, { min_fee?: number | string }> | undefined)?.FeeIsBiggerThanMinFee;
    if (f?.min_fee !== undefined) return bi(f.min_fee);
  }
  return undefined;
}

function sumInputs(ctx: ChainContext, inputs: TxIn[]): Value {
  return sumValues(
    inputs.map((i) => {
      const u = findUtxo(ctx, i);
      if (!u) throw new Error(`fit: input ${i.txHash}#${i.index} is not in the chain context`);
      return u.value;
    }),
  );
}

function mintValue(spec: TxSpec): Value {
  const assets: Record<string, Record<string, bigint>> = {};
  for (const m of spec.mint ?? []) assets[m.policy.toLowerCase()] = { ...m.assets };
  return { coin: 0n, assets };
}

/** Everything fit settles in one round given the current fee and ex-units. */
function settle(spec: TxSpec, opts: FitOptions, fee: bigint): TxSpec {
  const { ctx } = opts;
  const params = ctx.params;
  let next: TxSpec = resolveMinCoins({ ...spec, fee }, params);

  // collateral
  if (next.collateral?.length && (next.redeemers?.length ?? 0) > 0 && opts.collateral?.manual !== true) {
    const options = opts.collateral ?? {};
    const held = sumInputs(ctx, next.collateral);
    const percent = bi(params.collateralPercentage);
    const required = (fee * percent + 99n) / 100n;
    const total = options.total === "all" ? held.coin : typeof options.total === "bigint" ? options.total : required;
    const first = findUtxo(ctx, sortIns(next.collateral)[0]!)!;
    const backAddress = options.returnTo ?? first.address;
    const surplus: Value = { coin: held.coin - total, assets: held.assets };
    const wantsReturn = hasAssets(surplus) || surplus.coin > 0n;
    if (wantsReturn && options.omitReturn !== true && options.total !== "all") {
      const ret: TxOut = { address: backAddress, value: { coin: surplus.coin, assets: surplus.assets } };
      const min = minUtxoCoin(ret, params);
      if (surplus.coin < min) {
        if (hasAssets(surplus)) throw new Error(`fit: the collateral surplus (${surplus.coin} lovelace) is below the minimum of the return output (${min}); add ADA to the collateral inputs`);
        next = { ...next, collateralReturn: undefined, totalCollateral: options.omitTotal ? undefined : held.coin };
      } else next = { ...next, collateralReturn: ret, totalCollateral: options.omitTotal ? undefined : total };
    } else {
      next = { ...next, collateralReturn: undefined, totalCollateral: options.omitTotal ? undefined : total };
    }
  }

  // change
  const changeIndex = next.outputs.findIndex((o) => o.change);
  const balance = opts.balance ?? changeIndex >= 0;
  if (balance) {
    if (changeIndex < 0) throw new Error("fit: balance requested but no output has change: true");
    if (next.outputs.filter((o) => o.change).length > 1) throw new Error("fit: more than one change output");
    const { deposits, refunds } = depositsAndRefunds(next.certs ?? [], params);
    const proposalDeposits = (next.proposals ?? []).reduce((a, p) => a + p.deposit, 0n);
    const withdrawn = (next.withdrawals ?? []).reduce((a, w) => a + w.amount, 0n);
    const consumed = addValue(addValue(sumInputs(ctx, next.inputs), { coin: withdrawn + refunds, assets: {} }), mintValue(next));
    const others = sumValues(
      next.outputs
        .filter((o) => !o.change)
        .map((o) => {
          if (o.value.coin === "min") throw new Error("unresolved min coin");
          return { coin: o.value.coin, assets: o.value.assets } as Value;
        }),
    );
    const spent = addValue(others, { coin: fee + deposits + proposalDeposits + (next.donation ?? 0n), assets: {} });
    const change = subValue(consumed, spent);
    if (!isNonNegative(change)) throw new Error(`fit: the inputs do not cover the outputs, fee and deposits (short by ${change.coin} lovelace${hasAssets(change) ? " and some assets" : ""})`);
    const out = next.outputs[changeIndex]!;
    const min = minUtxoCoin({ ...out, value: { coin: change.coin, assets: change.assets } }, params);
    if (change.coin < min) throw new Error(`fit: the change (${change.coin} lovelace) is below the minimum UTxO value (${min}); fund the inputs better`);
    const outputs = next.outputs.slice();
    outputs[changeIndex] = { ...out, value: { coin: change.coin, assets: addAssets(change.assets, undefined) } };
    next = { ...next, outputs };
  }

  // signers
  if (!spec.signers && opts.keys) {
    const book = new Map(opts.keys.map((k) => [k.keyHashHex, k]));
    const keys = neededKeyHashes(next, ctx).map((h) => {
      const k = book.get(h);
      if (!k) throw new Error(`fit: no key given for key hash ${h} (needed as a vkey witness)`);
      return k;
    });
    next = { ...next, signers: keys };
  }
  return next;
}

/** Round-one units: the validator's phase 2 evaluates with an unbounded budget, so any small number gets the calculated figures back. */
function provisionalExUnits(spec: TxSpec): TxSpec {
  return { ...spec, redeemers: spec.redeemers?.map((r) => ({ ...r, exUnits: { mem: 1_000_000n, steps: 500_000_000n } })) };
}

function checkExpect(res: ValidationResult, expect: FitOptions["expect"]): string | undefined {
  if (expect === "any") return undefined;
  const kinds = errorKinds(res);
  if (expect === undefined || expect === "valid") {
    if (kinds.length === 0 && res.phase2_errors.length === 0) return undefined;
    return `expected a valid transaction, got errors [${kinds.join(", ")}] and ${res.phase2_errors.length} phase-2 error(s): ${res.errors.map((e) => e.error_message).join(" | ")} ${JSON.stringify(res.phase2_errors).slice(0, 600)}`;
  }
  if (expect.errors && JSON.stringify(kinds) !== JSON.stringify(expect.errors)) return `expected errors [${expect.errors.join(", ")}], got [${kinds.join(", ")}]: ${res.errors.map((e) => e.error_message).join(" | ")}`;
  if (expect.warnings) {
    const w = res.warnings.map((x) => Object.keys((x.warning as object) ?? {})[0] ?? "unknown");
    if (JSON.stringify(w) !== JSON.stringify(expect.warnings)) return `expected warnings [${expect.warnings.join(", ")}], got [${w.join(", ")}]`;
  }
  if (expect.phase2Warnings) {
    const w = res.phase2_warnings.map((x) => Object.keys(((x as { warning?: object }).warning) ?? {})[0] ?? "unknown");
    if (JSON.stringify(w) !== JSON.stringify(expect.phase2Warnings)) return `expected phase-2 warnings [${expect.phase2Warnings.join(", ")}], got [${w.join(", ")}]`;
  }
  if (expect.phase2Errors !== undefined && res.phase2_errors.length !== expect.phase2Errors) return `expected ${expect.phase2Errors} phase-2 error(s), got ${res.phase2_errors.length}: ${JSON.stringify(res.phase2_errors).slice(0, 800)}`;
  return undefined;
}

const NOT_VALIDATED: ValidationResult = { errors: [], warnings: [], phase2_errors: [], phase2_warnings: [], eval_redeemer_results: [] };

export function fit(spec0: TxSpec, opts: FitOptions): Fitted {
  const { ctx } = opts;
  const env = envOf(ctx);
  const maxRounds = opts.maxRounds ?? 14;
  if (opts.validate === false) {
    let fee = opts.fee ?? spec0.fee ?? 250_000n;
    for (let round = 1; round <= maxRounds; round++) {
      const settled = settle(spec0, opts, fee);
      const tx = assemble(settled, env);
      const target = opts.fee !== undefined ? fee : formulaMinFee(tx, ctx) + (opts.feeAdjust ?? 0n);
      if (target === fee) return { tx, spec: settled, validation: NOT_VALIDATED, validated: false, rounds: round };
      fee = target;
    }
    throw new Error(`fit: did not settle in ${maxRounds} rounds (validate: false)`);
  }
  const mode: ExUnitsMode = opts.exUnits ?? "exact";
  const hasRedeemers = (spec0.redeemers?.length ?? 0) > 0;
  let spec: TxSpec = mode === "declared" || !hasRedeemers ? spec0 : provisionalExUnits(spec0);
  let fee = opts.fee ?? spec0.fee ?? 250_000n;
  let tx!: BuiltTx;
  let result!: ValidationResult;
  let settled: TxSpec = spec;
  for (let round = 1; round <= maxRounds; round++) {
    settled = settle(spec, opts, fee);
    tx = assemble(settled, env);
    result = validate(tx.hex, ctx);
    let moved = false;

    // ex-units
    if (mode !== "declared" && hasRedeemers) {
      const updated = (settled.redeemers ?? []).map((r) => {
        const resolved = tx.redeemers.find((x) => x.target === r.target);
        const calc = resolved ? exUnitsOfResult(result, resolved) : undefined;
        if (!resolved || !calc) return r;
        const want = mode === "exact" ? calc : mode(calc, resolved);
        if (bi(r.exUnits.mem) !== want.mem || bi(r.exUnits.steps) !== want.steps) moved = true;
        return { ...r, exUnits: want };
      });
      spec = { ...spec, redeemers: updated };
    }

    // fee: the validator's minimum for the size just built (its own diagnostic when it prints one, else the formula) plus the requested adjustment
    if (opts.fee === undefined) {
      const diag = reportedMinFee(result);
      const target = (diag ?? formulaMinFee(tx, ctx)) + (opts.feeAdjust ?? 0n);
      if (target !== fee) {
        fee = target;
        moved = true;
      }
    }

    if (!moved) {
      const problem = checkExpect(result, opts.expect);
      if (problem) throw new Error(`fit: ${problem}`);
      return { tx, spec: settled, validation: result, validated: true, rounds: round };
    }
  }
  throw new Error(`fit: did not settle in ${maxRounds} rounds (last diagnostics: ${errorKinds(result).join(", ") || "none"})`);
}

export type { Utxo };
