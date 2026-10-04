// Offline bundles and other importable contexts.
//
// Bundle v1 (what bundle_export writes and tx_load reads back, on any machine, without network):
//   { cardano_debug_bundle: 1, network, tx_hash, tx_cbor, captured_at (null = unknown), slot, protocol_major,
//     validation_input_context (cquisitor-lib shape, bare integers), provider_rows, validation_result?,
//     missing_utxos?, provider_warnings?, defaults_applied?, ref_scripts?,
//     on_chain? {slot, epoch, block_height, is_valid, tx_bytes = bytesKey of the bytes the ledger included} }
//
// tx_load(bundle=…) also accepts:
//   - a de-uplc DebuggerContext {transaction, network, utxos[], protocolParams} (the shape of
//     de-uplc-web's sample test-tx.json) — converted with documented defaults for what it lacks;
//   - a cquisitor share link (`…#transaction-validator?v=1&e=j|b&d=…`, or the same as a bare hash
//     fragment) — decoded with the core share parser (brotli via the node compressor).
// The argument may be the JSON / URL text itself or a path to a file holding it.

import { existsSync, readFileSync, statSync } from "node:fs";

import type { ValidationInputContext } from "@cardananium/cquisitor-lib";
import { parseHash, parseValidatorShare } from "@cardananium/cquisitor-lib/share/parser";
import { buildValidationContext, type FetchedValidationData } from "@cardananium/cquisitor-lib/chain/transactionValidation";
import type { KoiosUtxoInfo } from "@cardananium/cquisitor-lib/chain/koiosTypes";

import { isNetwork, type Network } from "../config.js";
import type { LibApi, ValidationResultWire } from "../lib.js";
import { ToolInputError } from "../tools/_shared.js";
import { parseJsonBigintSafe } from "../vocab/json.js";
import { completeChangedParameters, normalizeValidationInputContext, slotOf, stringifyBareIntegers, toBigint, toInt, ContextShapeError } from "./contextCodec.js";
import { applyRefScripts } from "./fetchContext.js";
import { parseOnChainInfo, withIncludedBytes } from "./onChain.js";
import { emptyProviderRows, type ProviderRows } from "./providers.js";
import { canonicalizeRefScript, refScriptType, scriptHashOf } from "./refScript.js";
import type { OnChainInfo, RefScriptRecord } from "./state.js";

export const BUNDLE_VERSION = 1 as const;

export interface BundleV1 {
  cardano_debug_bundle: typeof BUNDLE_VERSION;
  network: Network;
  tx_hash: string;
  tx_cbor: string;
  /** ISO-8601 time the chain state was captured; null when the source it was built from carried none. */
  captured_at: string | null;
  /** Slot used for validation (decimal string). */
  slot: string;
  protocol_major: number;
  validation_input_context: ValidationInputContext;
  provider_rows?: ProviderRows;
  /** Full ValidationResult in wire form (eval results include the byte fields, so debug_open works offline). */
  validation_result?: ValidationResultWire;
  missing_utxos?: string[];
  provider_warnings?: string[];
  defaults_applied?: string[];
  ref_scripts?: Record<string, RefScriptRecord>;
  /** Free-form provenance (`koios`, `de-uplc DebuggerContext`, …). */
  origin?: string;
  /** The tx is on chain; the context was reconstructed at this inclusion point. */
  on_chain?: OnChainInfo;
}

/** Bundle JSON text: bigint fields as bare integers (the cquisitor-lib schema), keys sorted, 1-space indent. */
export function encodeBundle(bundle: BundleV1): string {
  return stringifyBareIntegers(bundle, 1);
}

// ---------- imported context (common result of every importer) ----------

export type ImportKind = "bundle" | "de_uplc_context" | "cquisitor_share";

export interface ImportedContext {
  kind: ImportKind;
  network: Network;
  /** The network the source itself declares, when it declares a valid one (`network` is the caller's override when given). */
  sourceNetwork?: Network;
  txHex: string;
  txHash?: string;
  context: ValidationInputContext;
  fetched?: FetchedValidationData;
  providerRows?: ProviderRows;
  validation?: ValidationResultWire;
  refScripts: Record<string, RefScriptRecord>;
  missingUtxos: string[];
  providerWarnings: string[];
  defaultsApplied: string[];
  capturedAt?: number;
  slot: bigint;
  protocolMajor: number;
  origin: string;
  onChain?: OnChainInfo;
}

export interface ImportHints {
  /** Overrides / supplies the network when the source has none. */
  network?: Network;
  /** Validity interval of the transaction (from the decoded body), used to pick a plausible slot for sources without a tip. */
  validity?: { start?: bigint; end?: bigint };
  /** Path the text was read from (for provenance). */
  path?: string;
}

type Json = Record<string, unknown>;

/**
 * Largest bundle text accepted (file or inline). Bundles the server writes stay far below this
 * (a validation result with every script's bytes is a few MB); the cap keeps the main thread's
 * synchronous read + JSON parse bounded.
 */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

function assertBundleSize(bytes: number, what: string): void {
  if (bytes > MAX_BUNDLE_BYTES) {
    throw new ToolInputError(`${what} is ${(bytes / (1024 * 1024)).toFixed(1)} MB, over the ${MAX_BUNDLE_BYTES / (1024 * 1024)} MB bundle limit`, "bundle");
  }
}

/** Read the `bundle` argument: a path to a file, or the text itself. Relative paths resolve against the server's working directory. */
export function readBundleArgument(input: string): { text: string; path?: string } {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new ToolInputError("bundle is empty", "bundle");
  assertBundleSize(trimmed.length, "bundle text");
  const looksLikeText = trimmed.startsWith("{") || trimmed.startsWith("#") || /^https?:\/\//i.test(trimmed);
  if (!looksLikeText && trimmed.length < 4096 && !trimmed.includes("\n")) {
    let stat: ReturnType<typeof statSync> | undefined;
    try {
      stat = existsSync(trimmed) ? statSync(trimmed) : undefined;
    } catch (error) {
      throw new ToolInputError(`bundle path ${trimmed} exists but cannot be examined (${fsReason(error)})`, "bundle");
    }
    if (stat?.isFile()) {
      assertBundleSize(stat.size, `bundle file ${trimmed}`);
      try {
        return { text: readFileSync(trimmed, "utf8"), path: trimmed };
      } catch (error) {
        throw new ToolInputError(`bundle file ${trimmed} exists but cannot be read (${fsReason(error)})`, "bundle");
      }
    }
    if (stat) throw new ToolInputError(`bundle path ${trimmed} is not a file (a directory?); pass the bundle file, its JSON text or a share link`, "bundle");
    if (!trimmed.includes("transaction-validator")) {
      throw new ToolInputError(
        `bundle is neither JSON, a cquisitor share link nor an existing file (${trimmed.slice(0, 80)}); a relative path resolves against the server's working directory ${process.cwd()}, so pass an absolute path`,
        "bundle",
      );
    }
  }
  return { text: trimmed };
}

function fsReason(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.message : String(error);
}

/** JSON text -> value, or a `bundle` argument error that says the text is not JSON. */
function parseBundleJson(text: string, what: string): unknown {
  try {
    return parseJsonBigintSafe(text);
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && /JSON|Unexpected (token|end)/i.test(error.message))) {
      throw new ToolInputError(`bundle is not valid JSON (${what}): ${error.message.slice(0, 200)}. A truncated or hand-edited file is the usual cause; bundle_export writes a complete one.`, "bundle");
    }
    throw error;
  }
}

/** Classify the text before parsing it. */
export function detectImportKind(text: string): ImportKind | undefined {
  const t = text.trim();
  if (t.includes("transaction-validator") && (t.startsWith("#") || /^https?:\/\//i.test(t) || t.startsWith("transaction-validator"))) return "cquisitor_share";
  if (!t.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t.length > 200_000 ? t.slice(0, 200_000) + "…" : t) as unknown;
  } catch {
    // Large documents: sniff the keys textually.
    if (/"cardano_debug_bundle"\s*:/.test(t)) return "bundle";
    if (/"transaction"\s*:/.test(t) && /"utxos"\s*:/.test(t)) return "de_uplc_context";
    if (/"ctx_v"\s*:/.test(t)) return "cquisitor_share";
    return undefined;
  }
  const r = parsed as Json;
  if (r.cardano_debug_bundle !== undefined) return "bundle";
  if (typeof r.transaction === "string" && Array.isArray(r.utxos)) return "de_uplc_context";
  if (r.ctx_v !== undefined && typeof r.cbor === "string") return "cquisitor_share";
  return undefined;
}

/** Import any accepted source. */
export async function importContext(lib: LibApi, input: string, hints: ImportHints = {}): Promise<ImportedContext> {
  const { text, path } = readBundleArgument(input);
  const kind = detectImportKind(text);
  const withPath = { ...hints, path: path ?? hints.path };
  const imported = await importKind(lib, kind, text, withPath);
  if (hints.network && imported.sourceNetwork && imported.sourceNetwork !== hints.network) {
    imported.providerWarnings.unshift(
      `network=${hints.network} was passed but the source says ${imported.sourceNetwork}: the argument wins, so this is ${hints.network} (tx_id tx_${hints.network}_…) holding ${imported.sourceNetwork} data; omit network to keep the source's.`,
    );
  }
  return imported;
}

async function importKind(lib: LibApi, kind: ImportKind | undefined, text: string, withPath: ImportHints): Promise<ImportedContext> {
  switch (kind) {
    case "bundle":
      return importBundle(text, withPath);
    case "de_uplc_context":
      return importDeUplcContext(lib, parseBundleJson(text, "DebuggerContext"), withPath);
    case "cquisitor_share":
      return importCquisitorShare(lib, text, withPath);
    default:
      if (text.trim().startsWith("{")) parseBundleJson(text, "the bundle argument"); // JSON that does not parse: say so
      throw new ToolInputError(
        "bundle must be a cardano-debug bundle ({cardano_debug_bundle:1, …}), a de-uplc DebuggerContext ({transaction, network, utxos, protocolParams}) or a cquisitor share link (#transaction-validator?v=1&e=…&d=…), as text or a file path.",
        "bundle",
      );
  }
}

// ---------- bundle v1 ----------

export function importBundle(text: string, hints: ImportHints = {}): ImportedContext {
  const raw = parseBundleJson(text, "cardano-debug bundle") as Json;
  if (raw.cardano_debug_bundle !== 1 && raw.cardano_debug_bundle !== "1") {
    throw new ToolInputError(`unsupported bundle version ${JSON.stringify(raw.cardano_debug_bundle)} (this server reads cardano_debug_bundle: 1)`, "bundle");
  }
  const network = hints.network ?? raw.network;
  if (!isNetwork(network)) throw new ToolInputError("bundle has no valid network; pass network=mainnet|preprod|preview", "network");
  const txHex = typeof raw.tx_cbor === "string" ? raw.tx_cbor.toLowerCase() : undefined;
  if (!txHex) throw new ToolInputError("bundle.tx_cbor is missing", "bundle");
  let context: ValidationInputContext;
  try {
    context = normalizeValidationInputContext(raw.validation_input_context, network);
  } catch (error) {
    if (error instanceof ContextShapeError) throw new ToolInputError(`bundle.validation_input_context is malformed: ${error.message}`, "bundle");
    throw error;
  }
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  let validation = raw.validation_result && typeof raw.validation_result === "object" ? (raw.validation_result as ValidationResultWire) : undefined;
  const providerRows = raw.provider_rows && typeof raw.provider_rows === "object" ? (raw.provider_rows as ProviderRows) : undefined;
  const defaultsApplied = strings(raw.defaults_applied);
  const changed = completeChangedParameters(context, Array.isArray(providerRows?.proposals) ? providerRows.proposals : undefined);
  if (changed.filled.length > 0 && validation) {
    // The stored verdict was computed without the names just filled in (stake-pool votes on the action read as disallowed).
    validation = undefined;
    changed.filled.push("validation_result dropped: it was computed without these changedParameters; tx_validate runs the validation again");
  }
  for (const line of [...changed.filled, ...changed.unknown]) if (!defaultsApplied.includes(line)) defaultsApplied.push(line);
  return {
    kind: "bundle",
    network,
    ...(isNetwork(raw.network) ? { sourceNetwork: raw.network } : {}),
    txHex,
    txHash: typeof raw.tx_hash === "string" ? raw.tx_hash.toLowerCase() : undefined,
    context,
    providerRows,
    validation,
    refScripts: raw.ref_scripts && typeof raw.ref_scripts === "object" ? (raw.ref_scripts as Record<string, RefScriptRecord>) : {},
    missingUtxos: strings(raw.missing_utxos),
    providerWarnings: strings(raw.provider_warnings),
    defaultsApplied,
    capturedAt: typeof raw.captured_at === "string" ? Date.parse(raw.captured_at) || undefined : undefined,
    slot: slotOf(context),
    protocolMajor: Number(context.protocolParameters.protocolVersion[0]),
    origin: hints.path ? `bundle ${hints.path}` : "bundle (inline)",
    ...onChainOfBundle(raw.on_chain, txHex),
  };
}

/**
 * The bundle's `on_chain`. `tx_bytes` names the bytes the ledger included; a bundle that predates the
 * field describes its own tx_cbor (only bytes fetched by hash were ever marked on chain).
 */
function onChainOfBundle(raw: unknown, txHex: string): { onChain?: OnChainInfo } {
  const parsed = parseOnChainInfo(raw);
  if (!parsed) return {};
  return { onChain: parsed.tx_bytes ? parsed : withIncludedBytes(parsed, txHex) };
}

// ---------- de-uplc DebuggerContext ----------

/** Shape of de-uplc-web's DebuggerContext (packages/core/src/common.ts); loosely typed on purpose. */
interface DeUplcUtxo {
  txHash: string;
  outputIndex: number;
  address: string;
  value: { lovelace: string | number; assets?: Record<string, string | number> };
  datumHash?: string | null;
  inlineDatum?: string | null;
  referenceScript?: { type: string; script: string } | null;
}

const MAINNET_EXECUTION_PRICES = { memPrice: { numerator: 577n, denominator: 10_000n }, stepPrice: { numerator: 721n, denominator: 10_000_000n } };

/** Current-slot estimate per network (post-Shelley: one slot per second). */
export function slotNow(network: Network, now: Date = new Date()): bigint {
  const anchors: Record<Network, { zeroSlot: number; zeroTimeSec: number }> = {
    mainnet: { zeroSlot: 4_492_800, zeroTimeSec: 1_596_059_091 },
    preprod: { zeroSlot: 86_400, zeroTimeSec: 1_655_769_600 },
    preview: { zeroSlot: 0, zeroTimeSec: 1_666_656_000 },
  };
  const { zeroSlot, zeroTimeSec } = anchors[network];
  return BigInt(zeroSlot + Math.floor(now.getTime() / 1000) - zeroTimeSec);
}

/** A slot inside the tx validity interval when the source has no tip; otherwise "now". */
export function chooseSlot(network: Network, validity: ImportHints["validity"], defaults: string[]): bigint {
  const now = slotNow(network);
  const start = validity?.start;
  const end = validity?.end;
  if (start !== undefined && end !== undefined && start < end) {
    const inside = now >= start && now < end ? now : start + (end - start) / 2n;
    defaults.push(`slot=${inside} (source carries no chain tip; chosen inside the transaction's validity interval [${start}, ${end}))`);
    return inside;
  }
  if (start !== undefined) {
    const chosen = now > start ? now : start;
    defaults.push(`slot=${chosen} (source carries no chain tip; at or after validity_start ${start})`);
    return chosen;
  }
  if (end !== undefined) {
    const chosen = now < end ? now : end - 1n;
    defaults.push(`slot=${chosen} (source carries no chain tip; before ttl ${end})`);
    return chosen;
  }
  defaults.push(`slot=${now} (source carries no chain tip; estimated from the wall clock)`);
  return now;
}

export async function importDeUplcContext(lib: LibApi, raw: unknown, hints: ImportHints = {}): Promise<ImportedContext> {
  const r = raw as Json;
  const network = hints.network ?? r.network;
  if (!isNetwork(network)) throw new ToolInputError("DebuggerContext has no valid network; pass network=mainnet|preprod|preview", "network");
  const txHex = typeof r.transaction === "string" ? r.transaction.trim().toLowerCase() : undefined;
  if (!txHex) throw new ToolInputError("DebuggerContext.transaction (tx CBOR hex) is missing", "bundle");
  const defaults: string[] = [];
  const warnings: string[] = [];
  const refScripts: Record<string, RefScriptRecord> = {};

  const utxos = Array.isArray(r.utxos) ? (r.utxos as DeUplcUtxo[]) : [];
  const utxoSet = [];
  for (const [i, u] of utxos.entries()) {
    const path = `utxos[${i}]`;
    if (!u || typeof u.txHash !== "string" || typeof u.address !== "string") throw new ToolInputError(`DebuggerContext.${path} is malformed`, "bundle");
    const amount = [{ unit: "lovelace", quantity: toBigint(u.value?.lovelace ?? 0, `${path}.value.lovelace`).toString() }];
    for (const [unit, qty] of Object.entries(u.value?.assets ?? {})) {
      amount.push({ unit: unit.replace(".", "").toLowerCase(), quantity: toBigint(qty, `${path}.value.assets`).toString() });
    }
    let scriptRef: string | null = null;
    let scriptHash: string | null = null;
    if (u.referenceScript?.script) {
      const type = refScriptType(u.referenceScript.type);
      if (!type) {
        warnings.push(`script_unverified: ${u.txHash}#${u.outputIndex} reference script has unknown type ${JSON.stringify(u.referenceScript.type)}; dropped`);
      } else {
        const canonical = canonicalizeRefScript(u.referenceScript.script, type);
        scriptRef = canonical.lib_form;
        try {
          scriptHash = await scriptHashOf(lib, canonical.inner, canonical);
          refScripts[scriptHash] = {
            script_hash: scriptHash,
            plutus_version: canonical.kind === "native" ? "native" : canonical.plutus_version!,
            inner: canonical.inner,
            lib_form: canonical.lib_form,
            verified: false,
            hash_source: "derived",
            utxo: `${u.txHash.toLowerCase()}#${u.outputIndex}`,
            size_bytes: canonical.inner.length / 2,
            note: "hash derived from the bytes (a DebuggerContext carries no reference_script.hash to verify against)",
          };
        } catch (error) {
          warnings.push(`script_unverified: ${u.txHash}#${u.outputIndex} ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    utxoSet.push({
      utxo: {
        input: { txHash: u.txHash.toLowerCase(), outputIndex: toInt(u.outputIndex, `${path}.outputIndex`) },
        output: { address: u.address, amount, dataHash: u.datumHash ?? null, plutusData: u.inlineDatum ?? null, scriptRef, scriptHash },
      },
      isSpent: false,
    });
  }
  if (utxos.length > 0) defaults.push("utxoSet[*].isSpent=false (a DebuggerContext does not say whether inputs are spent)");

  const pp = (r.protocolParams ?? {}) as Json;
  const protocolParameters = protocolParamsFromDeUplc(pp, defaults);
  const slot = chooseSlot(network, hints.validity, defaults);
  defaults.push("treasuryValue=0, accountContexts/poolContexts/drepContexts/govActionContexts/committee=[] , constitution=null (not part of a DebuggerContext; withdrawals, certificates and governance validate against empty chain state)");

  const context = normalizeValidationInputContext(
    {
      utxoSet,
      protocolParameters,
      slot,
      accountContexts: [],
      drepContexts: [],
      poolContexts: [],
      govActionContexts: [],
      lastEnactedGovAction: [],
      currentCommitteeMembers: [],
      potentialCommitteeMembers: [],
      treasuryValue: 0n,
      networkType: network,
      constitution: null,
    },
    network,
  );
  return {
    kind: "de_uplc_context",
    network,
    ...(isNetwork(r.network) ? { sourceNetwork: r.network } : {}),
    txHex,
    context,
    refScripts,
    missingUtxos: [],
    providerWarnings: warnings,
    defaultsApplied: defaults,
    slot,
    protocolMajor: Number(protocolParameters.protocolVersion[0]),
    origin: hints.path ? `de-uplc DebuggerContext ${hints.path}` : "de-uplc DebuggerContext (inline)",
  };
}

function pick(pp: Json, ...keys: string[]): unknown {
  for (const k of keys) if (pp[k] !== undefined && pp[k] !== null) return pp[k];
  return undefined;
}

function bigOr(pp: Json, defaults: string[], fallback: bigint, ...keys: string[]): bigint {
  const v = pick(pp, ...keys);
  if (v === undefined) {
    defaults.push(`protocolParameters.${keys[0]}=${fallback} (not in DebuggerContext.protocolParams)`);
    return fallback;
  }
  return toBigint(v, `protocolParams.${keys[0]}`);
}

function intOr(pp: Json, defaults: string[], fallback: number, ...keys: string[]): number {
  const v = pick(pp, ...keys);
  if (v === undefined) {
    defaults.push(`protocolParameters.${keys[0]}=${fallback} (not in DebuggerContext.protocolParams)`);
    return fallback;
  }
  return toInt(v, `protocolParams.${keys[0]}`);
}

function priceOr(pp: Json, defaults: string[], fallback: { numerator: bigint; denominator: bigint }, key: string): { numerator: bigint; denominator: bigint } {
  const v = pick(pp, key);
  if (typeof v !== "number" || !Number.isFinite(v)) {
    defaults.push(`protocolParameters.executionPrices.${key}=${fallback.numerator}/${fallback.denominator} (not in DebuggerContext.protocolParams; mainnet value)`);
    return fallback;
  }
  const denominator = 10_000_000_000n;
  let numerator = BigInt(Math.round(v * Number(denominator)));
  let d = denominator;
  const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
  const g = gcd(numerator, d);
  numerator /= g;
  d /= g;
  return { numerator, denominator: d };
}

/**
 * `adaPerUtxoByte` (Babbage `coinsPerUtxoSize`). de-uplc's koios-client fills `utxoCostPerWord`
 * with `coins_per_utxo_size || 0`, so 0 means "unknown" rather than a value, and a positive
 * `utxoCostPerWord` is normally that per-byte figure (a genuine Alonzo per-word value would be
 * 8x too large); the per-byte keys win and the fallback is named in the defaults list.
 */
function adaPerUtxoByteFromDeUplc(pp: Json, defaults: string[]): bigint {
  const positive = (key: string): bigint | undefined => {
    const v = pp[key];
    if (v === undefined || v === null) return undefined;
    const n = toBigint(v, `protocolParams.${key}`);
    return n > 0n ? n : undefined;
  };
  const perByte = positive("coinsPerUtxoSize") ?? positive("coins_per_utxo_size");
  if (perByte !== undefined) return perByte;
  const perWord = positive("utxoCostPerWord");
  if (perWord !== undefined) {
    defaults.push(`protocolParameters.adaPerUtxoByte=${perWord} read from DebuggerContext.protocolParams.utxoCostPerWord as a per-byte value (no coinsPerUtxoSize)`);
    return perWord;
  }
  defaults.push("protocolParameters.adaPerUtxoByte=4310 (not in DebuggerContext.protocolParams: coinsPerUtxoSize absent and utxoCostPerWord 0 / absent)");
  return 4_310n;
}

/** de-uplc `ProtocolParameters` -> cquisitor-lib `ProtocolParameters`, every substitution listed. */
export function protocolParamsFromDeUplc(pp: Json, defaults: string[]) {
  // de-uplc's koios-client fills minFeeA from cardano-cli's txFeeFixed (the constant) and minFeeB from
  // txFeePerByte (the coefficient) when those names are present, so the pair may arrive swapped
  // relative to the ledger's a (per byte) / b (constant). The coefficient is the smaller number.
  let a = bigOr(pp, defaults, 44n, "minFeeA", "min_fee_a");
  let b = bigOr(pp, defaults, 155_381n, "minFeeB", "min_fee_b");
  if (a > b) {
    [a, b] = [b, a];
    defaults.push(`protocolParameters.minFeeCoefficientA/minFeeConstantB swapped from minFeeA/minFeeB (${b}/${a}): the coefficient is the smaller value`);
  }
  const pv = pp.protocolVersion as Json | unknown[] | undefined;
  let major: number;
  let minor: number;
  if (Array.isArray(pv)) {
    major = toInt(pv[0], "protocolParams.protocolVersion[0]");
    minor = toInt(pv[1] ?? 0, "protocolParams.protocolVersion[1]");
  } else if (pv && typeof pv === "object") {
    major = toInt((pv as Json).major, "protocolParams.protocolVersion.major");
    minor = toInt((pv as Json).minor ?? 0, "protocolParams.protocolVersion.minor");
  } else {
    throw new ToolInputError("DebuggerContext.protocolParams.protocolVersion is required (the protocol major decides evaluation semantics)", "bundle");
  }
  const costModelsRaw = (pp.costModels ?? {}) as Json;
  const list = (v: unknown): number[] | undefined => (Array.isArray(v) ? v.map((x, i) => toInt(x, `protocolParams.costModels[${i}]`)) : v && typeof v === "object" ? Object.values(v as Json).map((x, i) => toInt(x, `protocolParams.costModels[${i}]`)) : undefined);
  const costModels: Record<string, number[]> = {};
  const v1 = list(costModelsRaw.PlutusV1 ?? costModelsRaw.plutusV1);
  const v2 = list(costModelsRaw.PlutusV2 ?? costModelsRaw.plutusV2);
  const v3 = list(costModelsRaw.PlutusV3 ?? costModelsRaw.plutusV3);
  if (v1) costModels.plutusV1 = v1;
  if (v2) costModels.plutusV2 = v2;
  if (v3) costModels.plutusV3 = v3;
  if (!v1 && !v2 && !v3) defaults.push("protocolParameters.costModels={} (DebuggerContext has no costModels; phase 2 will report CostModelNotFound)");
  const memPrice = priceOr(pp, defaults, MAINNET_EXECUTION_PRICES.memPrice, "priceMem");
  const stepPrice = priceOr(pp, defaults, MAINNET_EXECUTION_PRICES.stepPrice, "priceStep");
  return {
    minFeeCoefficientA: a,
    minFeeConstantB: b,
    maxBlockBodySize: intOr(pp, defaults, 90_112, "maxBlockSize", "max_block_size"),
    maxTransactionSize: intOr(pp, defaults, 16_384, "maxTxSize", "max_tx_size"),
    maxBlockHeaderSize: intOr(pp, defaults, 1_100, "maxBhSize", "max_bh_size"),
    stakeKeyDeposit: bigOr(pp, defaults, 2_000_000n, "keyDeposit", "key_deposit"),
    stakePoolDeposit: bigOr(pp, defaults, 500_000_000n, "poolDeposit", "pool_deposit"),
    maxEpochForPoolRetirement: intOr(pp, defaults, 18, "maxEpoch", "max_epoch"),
    protocolVersion: [major, minor] as [number, number],
    minPoolCost: bigOr(pp, defaults, 170_000_000n, "minPoolCost", "min_pool_cost"),
    adaPerUtxoByte: adaPerUtxoByteFromDeUplc(pp, defaults),
    costModels,
    executionPrices: { memPrice, stepPrice },
    maxTxExecutionUnits: { mem: bigOr(pp, defaults, 14_000_000n, "maxTxExMem", "max_tx_ex_mem"), steps: bigOr(pp, defaults, 10_000_000_000n, "maxTxExSteps", "max_tx_ex_steps") },
    maxBlockExecutionUnits: { mem: bigOr(pp, defaults, 62_000_000n, "maxBlockExMem", "max_block_ex_mem"), steps: bigOr(pp, defaults, 20_000_000_000n, "maxBlockExSteps", "max_block_ex_steps") },
    maxValueSize: intOr(pp, defaults, 5_000, "maxValSize", "max_val_size"),
    collateralPercentage: intOr(pp, defaults, 150, "collateralPercent", "collateral_percent"),
    maxCollateralInputs: intOr(pp, defaults, 3, "maxCollateralInputs", "max_collateral_inputs"),
    governanceActionDeposit: bigOr(pp, defaults, 100_000_000_000n, "govActionDeposit", "gov_action_deposit"),
    drepDeposit: bigOr(pp, defaults, 500_000_000n, "drepDeposit", "drep_deposit"),
    referenceScriptCostPerByte: { numerator: bigOr(pp, defaults, 15n, "minFeeRefScriptCostPerByte", "min_fee_ref_script_cost_per_byte"), denominator: 1n },
  };
}

// ---------- cquisitor share link ----------

export async function importCquisitorShare(lib: LibApi, text: string, hints: ImportHints = {}): Promise<ImportedContext> {
  let fragment = text.trim();
  const hashIndex = fragment.indexOf("#");
  if (hashIndex >= 0) fragment = fragment.slice(hashIndex);
  else if (fragment.startsWith("{")) {
    // A bare ValidatorRichPayloadV1 object.
    const payload = parseBundleJson(fragment, "share payload") as Json;
    return fromRichPayload(lib, payload.cbor, payload.net, payload.ctx, payload.capturedAt, hints);
  } else fragment = `#${fragment}`;
  const parsedHash = parseHash(fragment);
  if (parsedHash.tab !== "transaction-validator") {
    throw new ToolInputError(`share link tab is ${parsedHash.invalidHash ?? parsedHash.tab ?? "unknown"}; only #transaction-validator links carry a transaction`, "bundle");
  }
  const share = await parseValidatorShare(parsedHash.params);
  if (share.parseError) throw new ToolInputError(`share link payload could not be decoded: ${share.parseError}`, "bundle");
  if (share.futureVersion) throw new ToolInputError("share link uses a newer format version than this server understands", "bundle");
  if (!share.cbor) throw new ToolInputError("share link carries no transaction CBOR", "bundle");
  if (share.ctxIncompatible) throw new ToolInputError("share link context schema version is not supported by this server", "bundle");
  return fromRichPayload(lib, share.cbor, share.net, share.ctx, share.capturedAt, hints);
}

async function fromRichPayload(lib: LibApi, cbor: unknown, net: unknown, ctx: unknown, capturedAt: unknown, hints: ImportHints): Promise<ImportedContext> {
  const network = hints.network ?? net;
  if (!isNetwork(network)) throw new ToolInputError("share link has no valid network; pass network=mainnet|preprod|preview", "network");
  if (typeof cbor !== "string") throw new ToolInputError("share payload has no transaction CBOR", "bundle");
  if (!ctx || typeof ctx !== "object") {
    throw new ToolInputError("share link carries the transaction but no fetched context (minimal link); use tx_load(tx_cbor=…, network=…) to fetch it from a provider", "bundle");
  }
  const fetched = ctx as FetchedValidationData;
  const warnings: string[] = [];
  const context = normalizeValidationInputContext(buildValidationContext(fetched, network), network);
  const rows: KoiosUtxoInfo[] = Array.isArray(fetched.utxoInfos) ? fetched.utxoInfos : [];
  const refScripts = await applyRefScripts(lib, context.utxoSet, rows, warnings);
  const providerRows = emptyProviderRows("koios", network);
  providerRows.utxo_info = rows;
  // A share link carries no proposal rows: a ParameterChange without changedParameters stays so, and says what that means.
  const { unknown } = completeChangedParameters(context, undefined);
  return {
    kind: "cquisitor_share",
    network,
    ...(isNetwork(net) ? { sourceNetwork: net } : {}),
    txHex: cbor.toLowerCase(),
    context,
    fetched,
    providerRows,
    refScripts,
    missingUtxos: [],
    providerWarnings: warnings,
    defaultsApplied: unknown,
    capturedAt: typeof capturedAt === "number" ? capturedAt : undefined,
    slot: slotOf(context),
    protocolMajor: Number(context.protocolParameters.protocolVersion[0]),
    origin: hints.path ? `cquisitor share link ${hints.path}` : "cquisitor share link",
  };
}
