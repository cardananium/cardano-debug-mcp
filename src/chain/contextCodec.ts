// ValidationInputContext codec: bring a loosely typed context (bundle JSON with bare or boxed
// integers, a cquisitor share-link ctx, a hand-edited file) to the exact cquisitor-lib shape, and
// serialise it for the library (bigint as bare integers, the way serde reads u64).
//
// Only the fields the library declares as bigint are coerced to bigint; JSON numbers stay numbers;
// asset quantities stay strings. Anything structurally wrong throws `ContextShapeError` naming the
// path, so a broken bundle fails loudly at load instead of as a serde error inside the wasm.

import type {
  AccountInputContext,
  CommitteeInputContext,
  ConstitutionContext,
  CostModels,
  DrepInputContext,
  GovActionInputContext,
  GovernanceActionType,
  LocalCredential,
  PoolInputContext,
  ProtocolParameters,
  SubCoin,
  UtxoInputContext,
  ValidationInputContext,
} from "@cardananium/cquisitor-lib";
import type { KoiosProposal } from "@cardananium/cquisitor-lib/chain/koiosTypes";
import { changedParametersOf } from "@cardananium/cquisitor-lib/chain/transactionValidation";
import stringify from "safe-stable-stringify";

import type { Network } from "../config.js";

export class ContextShapeError extends Error {
  readonly path: string;
  constructor(path: string, problem: string) {
    super(`ValidationInputContext.${path}: ${problem}`);
    this.name = "ContextShapeError";
    this.path = path;
  }
}

type Json = Record<string, unknown>;

function rec(value: unknown, path: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ContextShapeError(path, "expected an object");
  return value as Json;
}

function arr(value: unknown, path: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ContextShapeError(path, "expected an array");
  return value;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ContextShapeError(path, "expected a string");
  return value;
}

function optStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function bool(value: unknown, path: string, fallback?: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined && fallback !== undefined) return fallback;
  throw new ContextShapeError(path, "expected a boolean");
}

const INTEGER_TEXT = /^-?\d+$/;

/** Read an integer-valued field as bigint: bigint, integer number, decimal string, `{"$bi"}` / serde box. */
export function toBigint(value: unknown, path: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new ContextShapeError(path, `expected an integer, got ${value}`);
    return BigInt(value);
  }
  if (typeof value === "string" && INTEGER_TEXT.test(value.trim())) return BigInt(value.trim());
  if (value !== null && typeof value === "object") {
    const box = value as Json;
    const inner = box.$bi ?? box["$serde_json::private::Number"];
    if (typeof inner === "string" && INTEGER_TEXT.test(inner)) return BigInt(inner);
  }
  throw new ContextShapeError(path, `expected an integer, got ${JSON.stringify(value)}`);
}

/** Read an integer-valued field as a JS number (must be safe). */
export function toInt(value: unknown, path: string): number {
  const big = toBigint(value, path);
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) throw new ContextShapeError(path, "integer does not fit a JS number");
  return Number(big);
}

function optInt(value: unknown, path: string): number | null {
  if (value === undefined || value === null) return null;
  return toInt(value, path);
}

function subCoin(value: unknown, path: string): SubCoin {
  const r = rec(value, path);
  return { numerator: toBigint(r.numerator, `${path}.numerator`), denominator: toBigint(r.denominator, `${path}.denominator`) };
}

function exUnits(value: unknown, path: string): { mem: bigint; steps: bigint } {
  const r = rec(value, path);
  return { mem: toBigint(r.mem, `${path}.mem`), steps: toBigint(r.steps, `${path}.steps`) };
}

function costModelArray(value: unknown, path: string): number[] | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map((v, i) => toInt(v, `${path}[${i}]`));
  if (typeof value === "object") return Object.values(value as Json).map((v, i) => toInt(v, `${path}[${i}]`));
  throw new ContextShapeError(path, "expected an array of integers");
}

export function normalizeCostModels(value: unknown, path: string): CostModels {
  const r = rec(value ?? {}, path);
  const out: CostModels = {};
  const v1 = costModelArray(r.plutusV1 ?? r.PlutusV1, `${path}.plutusV1`);
  const v2 = costModelArray(r.plutusV2 ?? r.PlutusV2, `${path}.plutusV2`);
  const v3 = costModelArray(r.plutusV3 ?? r.PlutusV3, `${path}.plutusV3`);
  if (v1) out.plutusV1 = v1;
  if (v2) out.plutusV2 = v2;
  if (v3) out.plutusV3 = v3;
  return out;
}

export function normalizeProtocolParameters(value: unknown, path = "protocolParameters"): ProtocolParameters {
  const r = rec(value, path);
  const pv = r.protocolVersion;
  let protocolVersion: [number, number];
  if (Array.isArray(pv) && pv.length >= 2) protocolVersion = [toInt(pv[0], `${path}.protocolVersion[0]`), toInt(pv[1], `${path}.protocolVersion[1]`)];
  else if (pv !== null && typeof pv === "object") {
    const o = pv as Json;
    protocolVersion = [toInt(o.major, `${path}.protocolVersion.major`), toInt(o.minor ?? 0, `${path}.protocolVersion.minor`)];
  } else throw new ContextShapeError(`${path}.protocolVersion`, "expected [major, minor]");
  return {
    minFeeCoefficientA: toBigint(r.minFeeCoefficientA, `${path}.minFeeCoefficientA`),
    minFeeConstantB: toBigint(r.minFeeConstantB, `${path}.minFeeConstantB`),
    maxBlockBodySize: toInt(r.maxBlockBodySize, `${path}.maxBlockBodySize`),
    maxTransactionSize: toInt(r.maxTransactionSize, `${path}.maxTransactionSize`),
    maxBlockHeaderSize: toInt(r.maxBlockHeaderSize, `${path}.maxBlockHeaderSize`),
    stakeKeyDeposit: toBigint(r.stakeKeyDeposit, `${path}.stakeKeyDeposit`),
    stakePoolDeposit: toBigint(r.stakePoolDeposit, `${path}.stakePoolDeposit`),
    maxEpochForPoolRetirement: toInt(r.maxEpochForPoolRetirement, `${path}.maxEpochForPoolRetirement`),
    protocolVersion,
    minPoolCost: toBigint(r.minPoolCost, `${path}.minPoolCost`),
    adaPerUtxoByte: toBigint(r.adaPerUtxoByte, `${path}.adaPerUtxoByte`),
    costModels: normalizeCostModels(r.costModels, `${path}.costModels`),
    executionPrices: (() => {
      const ep = rec(r.executionPrices, `${path}.executionPrices`);
      return { memPrice: subCoin(ep.memPrice, `${path}.executionPrices.memPrice`), stepPrice: subCoin(ep.stepPrice, `${path}.executionPrices.stepPrice`) };
    })(),
    maxTxExecutionUnits: exUnits(r.maxTxExecutionUnits, `${path}.maxTxExecutionUnits`),
    maxBlockExecutionUnits: exUnits(r.maxBlockExecutionUnits, `${path}.maxBlockExecutionUnits`),
    maxValueSize: toInt(r.maxValueSize, `${path}.maxValueSize`),
    collateralPercentage: toInt(r.collateralPercentage, `${path}.collateralPercentage`),
    maxCollateralInputs: toInt(r.maxCollateralInputs, `${path}.maxCollateralInputs`),
    governanceActionDeposit: toBigint(r.governanceActionDeposit, `${path}.governanceActionDeposit`),
    drepDeposit: toBigint(r.drepDeposit, `${path}.drepDeposit`),
    referenceScriptCostPerByte: subCoin(r.referenceScriptCostPerByte, `${path}.referenceScriptCostPerByte`),
  };
}

function utxoContext(value: unknown, path: string): UtxoInputContext {
  const r = rec(value, path);
  const utxo = rec(r.utxo, `${path}.utxo`);
  const input = rec(utxo.input, `${path}.utxo.input`);
  const output = rec(utxo.output, `${path}.utxo.output`);
  const amount = arr(output.amount, `${path}.utxo.output.amount`).map((a, i) => {
    const asset = rec(a, `${path}.utxo.output.amount[${i}]`);
    const quantity = asset.quantity;
    return {
      unit: str(asset.unit, `${path}.utxo.output.amount[${i}].unit`),
      quantity: typeof quantity === "string" ? quantity : toBigint(quantity, `${path}.utxo.output.amount[${i}].quantity`).toString(),
    };
  });
  return {
    utxo: {
      input: { txHash: str(input.txHash, `${path}.utxo.input.txHash`).toLowerCase(), outputIndex: toInt(input.outputIndex, `${path}.utxo.input.outputIndex`) },
      output: {
        address: str(output.address, `${path}.utxo.output.address`),
        amount,
        dataHash: optStr(output.dataHash),
        plutusData: optStr(output.plutusData),
        scriptRef: optStr(output.scriptRef),
        scriptHash: optStr(output.scriptHash),
      },
    },
    isSpent: bool(r.isSpent, `${path}.isSpent`, false),
  };
}

function account(value: unknown, path: string): AccountInputContext {
  const r = rec(value, path);
  return {
    bech32Address: str(r.bech32Address, `${path}.bech32Address`),
    isRegistered: bool(r.isRegistered, `${path}.isRegistered`, false),
    payedDeposit: optInt(r.payedDeposit, `${path}.payedDeposit`),
    delegatedToDrep: optStr(r.delegatedToDrep),
    delegatedToPool: optStr(r.delegatedToPool),
    balance: optInt(r.balance, `${path}.balance`),
  };
}

function drep(value: unknown, path: string): DrepInputContext {
  const r = rec(value, path);
  return { bech32Drep: str(r.bech32Drep, `${path}.bech32Drep`), isRegistered: bool(r.isRegistered, `${path}.isRegistered`, false), payedDeposit: optInt(r.payedDeposit, `${path}.payedDeposit`) };
}

function pool(value: unknown, path: string): PoolInputContext {
  const r = rec(value, path);
  return { poolId: str(r.poolId, `${path}.poolId`), isRegistered: bool(r.isRegistered, `${path}.isRegistered`, false), retirementEpoch: optInt(r.retirementEpoch, `${path}.retirementEpoch`) };
}

function credential(value: unknown, path: string): LocalCredential {
  const r = rec(value, path);
  if (Array.isArray(r.keyHash)) return { keyHash: r.keyHash.map((b, i) => toInt(b, `${path}.keyHash[${i}]`)) };
  if (Array.isArray(r.scriptHash)) return { scriptHash: r.scriptHash.map((b, i) => toInt(b, `${path}.scriptHash[${i}]`)) };
  throw new ContextShapeError(path, "expected {keyHash: bytes[]} or {scriptHash: bytes[]}");
}

const GOV_ACTION_TYPES: readonly GovernanceActionType[] = [
  "parameterChangeAction",
  "hardForkInitiationAction",
  "treasuryWithdrawalsAction",
  "noConfidenceAction",
  "updateCommitteeAction",
  "newConstitutionAction",
  "infoAction",
];

/** Parameter names (ledger, CDDL, db-sync / Koios, or the CDDL key as text); an integer key becomes its text. */
function changedParameters(value: unknown, path: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ContextShapeError(path, "expected an array of parameter names");
  return value.map((v, i) => (typeof v === "number" && Number.isInteger(v) ? String(v) : str(v, `${path}[${i}]`)));
}

function govAction(value: unknown, path: string): GovActionInputContext {
  const r = rec(value, path);
  const id = rec(r.actionId, `${path}.actionId`);
  const actionType = str(r.actionType, `${path}.actionType`);
  if (!GOV_ACTION_TYPES.includes(actionType as GovernanceActionType)) throw new ContextShapeError(`${path}.actionType`, `unknown ${actionType}`);
  const txHash = id.txHash;
  const bytes = Array.isArray(txHash)
    ? txHash.map((b, i) => toInt(b, `${path}.actionId.txHash[${i}]`))
    : typeof txHash === "string"
      ? Array.from(Buffer.from(txHash, "hex"))
      : (() => {
          throw new ContextShapeError(`${path}.actionId.txHash`, "expected bytes");
        })();
  // A ParameterChange's changed parameters decide whether a stake pool may vote on it.
  const changed = changedParameters(r.changedParameters, `${path}.changedParameters`);
  return {
    actionId: { txHash: bytes, index: toInt(id.index, `${path}.actionId.index`) },
    actionType: actionType as GovernanceActionType,
    isActive: bool(r.isActive, `${path}.isActive`, true),
    ...(changed ? { changedParameters: changed } : {}),
  };
}

/** What `completeChangedParameters` did to a context, as `defaults_applied` lines. */
export interface ChangedParametersReport {
  /** Contexts that got `changedParameters` from the provider's proposal row. */
  filled: string[];
  /** ParameterChange contexts that still have none (no row, or a row without `param_proposal`). */
  unknown: string[];
}

/**
 * Give every ParameterChange gov-action context without `changedParameters` the names from the
 * provider's proposal row (Koios `param_proposal`, which the library's Blockfrost client fills
 * too), matched by action id. Contexts written before the field was carried have the rows but not
 * the names, and without the names the library reports every stake-pool vote on the action as
 * DisallowedVoters. Mutates `context`.
 */
export function completeChangedParameters(context: ValidationInputContext, proposals: readonly KoiosProposal[] | undefined): ChangedParametersReport {
  const rows = new Map<string, KoiosProposal>();
  for (const row of proposals ?? []) {
    if (row && typeof row.proposal_tx_hash === "string") rows.set(`${row.proposal_tx_hash.toLowerCase()}#${row.proposal_index}`, row);
  }
  const report: ChangedParametersReport = { filled: [], unknown: [] };
  const visit = (list: GovActionInputContext[], name: string) =>
    list.forEach((entry, i) => {
      if (entry.actionType !== "parameterChangeAction" || (entry.changedParameters && entry.changedParameters.length > 0)) return;
      const id = `${Buffer.from(entry.actionId.txHash).toString("hex")}#${entry.actionId.index}`;
      const row = rows.get(id);
      const names = row ? changedParametersOf(row) : undefined;
      if (names && names.length > 0) {
        entry.changedParameters = names;
        report.filled.push(`${name}[${i}].changedParameters=[${names.join(", ")}] (read from the provider's proposal row ${id}; the context carried none)`);
      } else if (name === "govActionContexts") {
        report.unknown.push(`${name}[${i}] (ParameterChange ${id}) has no changedParameters (${row ? "its proposal row names no parameters" : "no proposal row"}): a stake-pool vote on it is reported as DisallowedVoters`);
      }
    });
  visit(context.govActionContexts, "govActionContexts");
  visit(context.lastEnactedGovAction, "lastEnactedGovAction");
  return report;
}

function committee(value: unknown, path: string): CommitteeInputContext {
  const r = rec(value, path);
  return {
    committeeMemberCold: credential(r.committeeMemberCold, `${path}.committeeMemberCold`),
    committeeMemberHot: r.committeeMemberHot === undefined || r.committeeMemberHot === null ? null : credential(r.committeeMemberHot, `${path}.committeeMemberHot`),
    isResigned: bool(r.isResigned, `${path}.isResigned`, false),
  };
}

function constitution(value: unknown): ConstitutionContext | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return null;
  const r = value as Json;
  return { guardrailScriptHash: optStr(r.guardrailScriptHash) };
}

/**
 * Exact cquisitor-lib ValidationInputContext from a loosely typed object. `network` overrides
 * `networkType` when given (bundles carry the network at the top level).
 */
export function normalizeValidationInputContext(value: unknown, network?: Network): ValidationInputContext {
  const r = rec(value, "");
  const networkType = network ?? r.networkType;
  if (networkType !== "mainnet" && networkType !== "preprod" && networkType !== "preview") throw new ContextShapeError("networkType", "expected mainnet | preprod | preview");
  return {
    utxoSet: arr(r.utxoSet, "utxoSet").map((u, i) => utxoContext(u, `utxoSet[${i}]`)),
    protocolParameters: normalizeProtocolParameters(r.protocolParameters),
    slot: toBigint(r.slot, "slot"),
    accountContexts: arr(r.accountContexts, "accountContexts").map((a, i) => account(a, `accountContexts[${i}]`)),
    drepContexts: arr(r.drepContexts, "drepContexts").map((d, i) => drep(d, `drepContexts[${i}]`)),
    poolContexts: arr(r.poolContexts, "poolContexts").map((p, i) => pool(p, `poolContexts[${i}]`)),
    govActionContexts: arr(r.govActionContexts, "govActionContexts").map((g, i) => govAction(g, `govActionContexts[${i}]`)),
    lastEnactedGovAction: arr(r.lastEnactedGovAction, "lastEnactedGovAction").map((g, i) => govAction(g, `lastEnactedGovAction[${i}]`)),
    currentCommitteeMembers: arr(r.currentCommitteeMembers, "currentCommitteeMembers").map((c, i) => committee(c, `currentCommitteeMembers[${i}]`)),
    potentialCommitteeMembers: arr(r.potentialCommitteeMembers, "potentialCommitteeMembers").map((c, i) => committee(c, `potentialCommitteeMembers[${i}]`)),
    treasuryValue: toBigint(r.treasuryValue ?? 0, "treasuryValue"),
    networkType,
    constitution: constitution(r.constitution),
  };
}

/** The context's slot as bigint (the library declares its u64 fields `number | bigint`; the codec always writes bigint). */
export function slotOf(context: ValidationInputContext): bigint {
  return BigInt(context.slot);
}

/** The JSON text `validate_transaction_js` reads: bigint as bare integers, keys sorted. */
export function stringifyForLib(context: ValidationInputContext): string {
  const text = stringify(context);
  if (text === undefined) throw new Error("ValidationInputContext did not serialise");
  return text;
}

/** Same encoding for any value with bigint fields (bundle files use it too). */
export function stringifyBareIntegers(value: unknown, indent?: number): string {
  const text = indent === undefined ? stringify(value) : stringify(value, null, indent);
  if (text === undefined) throw new Error("value did not serialise");
  return text;
}

// ---------- what the engine layer needs from the parameters ----------

export interface EngineParams {
  protocol_major: number;
  protocol_minor: number;
  cost_models: { V1?: number[]; V2?: number[]; V3?: number[] };
}

/** `protocolVersion[0]` and the three flat cost-model arrays, from the same object the validator used. */
export function engineParamsOf(params: ProtocolParameters): EngineParams {
  const [major, minor] = params.protocolVersion;
  const cost_models: EngineParams["cost_models"] = {};
  if (params.costModels.plutusV1) cost_models.V1 = params.costModels.plutusV1;
  if (params.costModels.plutusV2) cost_models.V2 = params.costModels.plutusV2;
  if (params.costModels.plutusV3) cost_models.V3 = params.costModels.plutusV3;
  return { protocol_major: Number(major), protocol_minor: Number(minor), cost_models };
}

// ---------- silent defaults of the Koios -> ProtocolParameters conversion ----------

/**
 * The core's `koiosParamsToProtocolParams` substitutes fixed values for null Koios fields. This
 * lists which ones fired for a given row, so they surface in `defaults_applied` instead of hiding.
 */
export function koiosEpochParamDefaults(row: Record<string, unknown> | undefined): string[] {
  if (!row) return ["protocol parameters: no epoch_params row (all defaults)"];
  const table: Array<[string, string]> = [
    ["min_fee_a", "44"],
    ["min_fee_b", "155381"],
    ["max_block_size", "90112"],
    ["max_tx_size", "16384"],
    ["max_bh_size", "1100"],
    ["key_deposit", "2000000"],
    ["pool_deposit", "500000000"],
    ["max_epoch", "18"],
    ["protocol_major", "9"],
    ["protocol_minor", "0"],
    ["min_pool_cost", "340000000"],
    ["coins_per_utxo_size", "4310"],
    ["price_mem", "0"],
    ["price_step", "0"],
    ["max_tx_ex_mem", "0"],
    ["max_tx_ex_steps", "0"],
    ["max_block_ex_mem", "0"],
    ["max_block_ex_steps", "0"],
    ["max_val_size", "5000"],
    ["collateral_percent", "150"],
    ["max_collateral_inputs", "3"],
    ["gov_action_deposit", "100000000000"],
    ["drep_deposit", "500000000"],
    ["min_fee_ref_script_cost_per_byte", "15"],
  ];
  const out: string[] = [];
  for (const [field, fallback] of table) {
    if (row[field] === null || row[field] === undefined) out.push(`protocolParameters.${field}=${fallback} (provider row had null)`);
  }
  const cm = row.cost_models as Record<string, unknown> | null | undefined;
  if (!cm) out.push("protocolParameters.costModels={} (provider row had no cost_models)");
  return out;
}
