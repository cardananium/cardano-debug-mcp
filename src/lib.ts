// The server's view of @cardananium/cquisitor-lib.
//
// `LibApi` is the typed surface the tools use: every helper answers in the server's WIRE form
// (integers past 2^53 as decimal strings, serde boxes unboxed), so a result can go straight into
// a tool's structuredContent. `LibClient` is the process's one implementation: every call goes
// through the lib.worker WorkerHost (never in-process — a trap must not take the server down, and
// validate needs a watchdog). It also implements the library's own `LibBackend` and is registered
// with `configure({ backend })` (see context.ts), so the library's chain layer (fetchValidationData,
// BlockfrostClient) runs its wasm calls through the same worker, budgets and respawn logic.
//
// The library's own typed API (`decode`, `cborToJson`, …) answers `bigint` for large integers; the
// server keeps its wire form and parses the library's JSON text once with the library's exact parser.

import {
  answersInJsonText,
  parseJsonExact,
  type AddWitnessesReport,
  type CborValidationResult,
  type CddlOutlineEntry,
  type CddlReferencesResult,
  type CddlSymbolAtResult,
  type CddlValidationResult,
  type CheckSignaturesResult,
  type DecodingParams,
  type ExtractedHashes,
  type LibBackend,
  type LibCallOptions,
  type NetworkType,
  type PossibleTypesReport,
  type WasmFunctionName,
} from "@cardananium/cquisitor-lib";

import type { ServerConfig } from "./config.js";
import { toWireJson } from "./vocab/json.js";
import { resolveWorkerEntry, WorkerHost, type CallOptions, type RespawnInfo } from "./workers/host.js";

export type { LibCallOptions } from "@cardananium/cquisitor-lib";

/** A wasm function of the library, by its export name (`cbor_to_json`, `validate_transaction_js`, …). */
export type LibFunction = WasmFunctionName;

/** Options of a raw call: the library's (`signal`, `timeoutMs`) plus a per-call input cap override. */
export type LibRawCallOptions = LibCallOptions & Pick<CallOptions, "maxInputBytes">;

/** `get_necessary_data_list_js` answer (NecessaryInputData; see cquisitor-lib schemas/NecessaryInputData.schema.json). */
export interface NecessaryInputData {
  utxos: Array<{ txHash: string; outputIndex: number }>;
  accounts: string[];
  pools: string[];
  dReps: string[];
  govActions: unknown[];
  lastEnactedGovAction: unknown[];
  committeeMembersCold: string[];
  committeeMembersHot: string[];
  [key: string]: unknown;
}

/** `validate_transaction_js` answer, integers > 2^53 as decimal strings (see ValidationResult.schema.json). */
export interface ValidationResultWire {
  errors: unknown[];
  warnings: unknown[];
  phase2_errors: unknown[];
  phase2_warnings: unknown[];
  eval_redeemer_results: EvalRedeemerResultWire[];
  [key: string]: unknown;
}

export interface EvalRedeemerResultWire {
  tag: "Spend" | "Mint" | "Cert" | "Reward" | "Vote" | "Propose";
  index: number;
  provided_ex_units: { mem: number | string; steps: number | string };
  calculated_ex_units?: { mem: number | string; steps: number | string } | null;
  logs: string[];
  success: boolean;
  error?: string | null;
  /** PlutusData CBOR hex of the ScriptContext the validator built. */
  script_context_bytes?: string | null;
  /** JSON *string* `{script_context_version, tx_info: {V1|V2|V3: …}, purpose}`. */
  script_context?: string | null;
  script_bytes?: string | null;
  plutus_version?: "V1" | "V2" | "V3" | null;
  redeemer_bytes?: string | null;
  datum_bytes?: string | null;
  [key: string]: unknown;
}

/**
 * A raw library answer in the server's wire form: JSON-text answers parsed once, exactly, with
 * integers past 2^53 as decimal strings; JS-value answers deep-copied with bigint -> decimal string
 * and serde number boxes unboxed.
 */
export function wireAnswer<T = unknown>(fn: LibFunction, raw: unknown): T {
  if (answersInJsonText(fn)) {
    if (typeof raw !== "string") throw new Error(`The library answered ${fn} with something other than JSON text`);
    return parseJsonExact<T>(raw, { bigIntegers: "string" });
  }
  return toWireJson<T>(raw);
}

/** CDDL functions take a schema text next to the document, so their input cap is doubled. */
const CDDL_FUNCTIONS: ReadonlySet<LibFunction> = new Set<LibFunction>([
  "validate_cddl",
  "validate_cbor_against_cddl",
  "decode_cbor_against_cddl",
  "map_cbor_to_cddl",
  "cddl_outline",
  "cddl_references",
  "cddl_symbol_at",
  "cddl_format",
]);

/**
 * The typed library surface, answering in wire form. Abstract over the raw call so the server's
 * worker-backed client and the tests' in-process double share every helper.
 */
export abstract class LibApi implements LibBackend {
  /**
   * The library's answer exactly as the wasm returned it (`LibBackend` contract): JSON text for
   * the text-answering functions (`answersInJsonText`), the JS value — bigint, serde boxes and all —
   * for the rest. Rejects with an `Error` carrying the library's message when the function throws.
   */
  abstract callRaw<T = unknown>(fn: LibFunction, args: unknown[], options?: LibRawCallOptions): Promise<T>;

  /** Raw call, answer in wire form (`wireAnswer`). */
  async call<T = unknown>(fn: LibFunction, args: unknown[], options: LibRawCallOptions = {}): Promise<T> {
    return wireAnswer<T>(fn, await this.callRaw<unknown>(fn, args, options));
  }

  // ---------- typed helpers ----------

  /** `decode_specific_type(input, typeName, params)`; answer in wire form. */
  decodeType<T = unknown>(input: string, typeName: string, params: DecodingParams = {}, options?: LibCallOptions): Promise<T> {
    return this.call<T>("decode_specific_type", [input, typeName, params], options);
  }

  /** Sorted names of the ledger types `input` decodes as (hex, bech32 or base58 accepted); empty for malformed input. */
  possibleTypes(input: string, options?: LibCallOptions): Promise<string[]> {
    return this.call<string[]>("get_possible_types_for_input", [input], options);
  }

  /**
   * `possibleTypes` with the types not tried: `{types}`, plus `unexamined: {kind: 'nesting_too_deep',
   * limit, depth?, message, types}` whenever reading the input as some type nests past the typed
   * decoders' bound (native-script levels not counted; an implementation limit, not a finding).
   * `types` may still be non-empty then: the skipped ones are `unexamined.types`.
   */
  possibleTypesReport(input: string, options?: LibCallOptions): Promise<PossibleTypesReport> {
    return this.call<PossibleTypesReport>("get_possible_types_report", [input], options);
  }

  decodableTypes(options?: LibCallOptions): Promise<string[]> {
    return this.call<string[]>("get_decodable_types", [], options);
  }

  /** Positional CBOR tree with byte offsets and encoding oddities (`cbor_to_json`). */
  cborToJson<T = unknown>(hex: string, options?: LibCallOptions): Promise<T> {
    return this.call<T>("cbor_to_json", [hex], options);
  }

  /** `decode_cbor_against_cddl(hex, cddl, rule)`: CDDL-shaped JSON. */
  decodeAgainstCddl<T = unknown>(hex: string, cddl: string, rule: string, options?: LibCallOptions): Promise<T> {
    return this.call<T>("decode_cbor_against_cddl", [hex, cddl, rule], options);
  }

  /** `validate_cbor_against_cddl(hex, cddl, rule)`: `{valid: true} | {valid: false, error: CborValidationErrorInfo}`. */
  validateAgainstCddl<T = CborValidationResult>(hex: string, cddl: string, rule: string, options?: LibCallOptions): Promise<T> {
    return this.call<T>("validate_cbor_against_cddl", [hex, cddl, rule], options);
  }

  /** `validate_cddl(cddl)`: whether a schema parses and every reference resolves (`{valid: true} | {valid: false, error: CddlErrorInfo}`). */
  validateCddl(cddl: string, options?: LibCallOptions): Promise<CddlValidationResult> {
    return this.call<CddlValidationResult>("validate_cddl", [cddl], options);
  }

  /** `cddl_outline(cddl)`: one entry per top-level rule (spans in wire form). Throws when the text does not parse. */
  cddlOutline(cddl: string, options?: LibCallOptions): Promise<CddlOutlineEntry[]> {
    return this.call<CddlOutlineEntry[]>("cddl_outline", [cddl], options);
  }

  /** `cddl_references(cddl, name)`: definition span and every use of a rule name. Throws when the text does not parse. */
  cddlReferences(cddl: string, name: string, options?: LibCallOptions): Promise<CddlReferencesResult> {
    return this.call<CddlReferencesResult>("cddl_references", [cddl, name], options);
  }

  /** `cddl_symbol_at(cddl, byteOffset)`: the identifier under a UTF-8 byte offset. */
  cddlSymbolAt(cddl: string, byteOffset: number, options?: LibCallOptions): Promise<CddlSymbolAtResult> {
    return this.call<CddlSymbolAtResult>("cddl_symbol_at", [cddl, byteOffset], options);
  }

  /** `cddl_format(cddl)`: the schema pretty-printed. Throws when the text does not parse. */
  cddlFormat(cddl: string, options?: LibCallOptions): Promise<string> {
    return this.call<string>("cddl_format", [cddl], options);
  }

  /** `map_cbor_to_cddl(hex, cddl, rule)`: CBOR positions mapped to the CDDL spans that matched them. */
  mapCborToCddl<T = unknown>(hex: string, cddl: string, rule: string, options?: LibCallOptions): Promise<T> {
    return this.call<T>("map_cbor_to_cddl", [hex, cddl, rule], options);
  }

  /** UTxOs / accounts / pools / dReps / gov actions a validation needs (`get_necessary_data_list_js`). */
  necessaryData(txHex: string, network: NetworkType, options?: LibCallOptions): Promise<NecessaryInputData> {
    return this.call<NecessaryInputData>("get_necessary_data_list_js", [txHex, network], options);
  }

  /**
   * Full phase-1 + phase-2 validation. `ctxJson` is the ValidationInputContext serialised with bare
   * integers (serde expects u64 literals). Phase 2 runs with an unbounded budget and cannot be
   * interrupted, so the call is bounded by `timeoutMs` (default `config.evalTimeoutMs`) and the
   * worker is terminated and respawned on overrun. Throws when a referenced UTxO is missing from
   * `utxoSet` ("Can't get these UTXOs from API…").
   */
  validateTx(txHex: string, ctxJson: string, options: LibCallOptions = {}): Promise<ValidationResultWire> {
    return this.call<ValidationResultWire>("validate_transaction_js", [txHex, ctxJson], options);
  }

  extractHashes(txHex: string, options?: LibCallOptions): Promise<ExtractedHashes> {
    return this.call<ExtractedHashes>("extract_hashes_from_transaction_js", [txHex], options);
  }

  /** Hex of the reference script carried by output `outputIndex` (one wrapper layer removed). */
  refScriptBytes(txHex: string, outputIndex: number, options?: LibCallOptions): Promise<string> {
    return this.call<string>("get_ref_script_bytes", [txHex, outputIndex], options);
  }

  addWitnesses(txHex: string, witnesses: string[], options?: LibCallOptions): Promise<AddWitnessesReport> {
    return this.call<AddWitnessesReport>("add_witnesses_to_tx_with_report", [txHex, witnesses], options);
  }

  /** vkey / Catalyst witness signature check of a tx or block (`check_block_or_tx_signatures`). */
  checkSignatures(hex: string, options?: LibCallOptions): Promise<CheckSignaturesResult> {
    return this.call<CheckSignaturesResult>("check_block_or_tx_signatures", [hex], options);
  }

  /** Pretty-printed UPLC of a flat-encoded (CBOR-wrapped) Plutus script. */
  prettyUplc(scriptHex: string, options?: LibCallOptions): Promise<string> {
    return this.call<string>("decode_plutus_program_pretty_uplc", [scriptHex], options);
  }
}

export interface LibClientOptions {
  /** Worker entry override (tests). Default: `resolveWorkerEntry('lib.worker')`. */
  entry?: URL | string;
  onRespawn?: (info: RespawnInfo) => void;
}

/** The process's library: every call runs in the lib.worker under the WorkerHost's budgets and respawn. */
export class LibClient extends LibApi {
  readonly host: WorkerHost;
  private readonly config: ServerConfig;

  constructor(config: ServerConfig, options: LibClientOptions = {}) {
    super();
    this.config = config;
    this.host = new WorkerHost({
      entry: options.entry ?? resolveWorkerEntry("lib.worker"),
      name: "lib",
      defaultTimeoutMs: config.libCallTimeoutMs,
      // The library cannot be interrupted from inside; the grace only delays the kill.
      hardKillGraceMs: 500,
      maxInputBytes: config.maxLibInputBytes,
      readyTimeoutMs: config.workerReadyTimeoutMs,
      serial: true,
      autoRespawn: true,
      resourceLimits: { maxOldGenerationSizeMb: config.workerMaxOldGenerationMb },
      onRespawn: options.onRespawn,
    });
  }

  /** Spawn the worker and load the wasm ahead of the first call. */
  warm(): Promise<void> {
    return this.host.warm();
  }

  dispose(): Promise<void> {
    return this.host.dispose();
  }

  /** Version info the worker reported on `ready` (undefined until warmed). */
  get info(): Record<string, unknown> | undefined {
    return this.host.stats().workerInfo;
  }

  /**
   * The call's budgets by function: `validate_transaction_js` gets the eval timeout and the
   * validation input cap (it carries the fetched chain context), the CDDL functions twice the
   * plain cap (schema text next to the document), everything else the host defaults. This is
   * the server's input guard; the library's fixed budgets are not applied on top of it.
   */
  private budgetsFor(fn: LibFunction): Pick<CallOptions, "timeoutMs" | "maxInputBytes"> {
    if (fn === "validate_transaction_js") return { timeoutMs: this.config.evalTimeoutMs, maxInputBytes: this.config.maxValidateInputBytes };
    if (CDDL_FUNCTIONS.has(fn)) return { maxInputBytes: this.config.maxLibInputBytes * 2 };
    return {};
  }

  /**
   * Run `fn` in the worker; the answer exactly as the wasm returned it (see `LibApi.callRaw`).
   * Rejects with `WorkerInputTooLargeError` (before dispatch), `WorkerTimeoutError` (the worker was
   * terminated and replaced), `WorkerUnavailableError`, or `WorkerCallError` (the library threw;
   * `.fatal` when the wasm trapped and the worker was replaced). The first three extend the
   * library's `LibInputTooLargeError` / `LibTimeoutError` / `LibUnavailableError`, so the library's
   * `isLibRefusal` contract holds for code running through this backend.
   */
  override callRaw<T = unknown>(fn: LibFunction, args: unknown[], options: LibRawCallOptions = {}): Promise<T> {
    const budgets = this.budgetsFor(fn);
    return this.host.call<T>("callLib", [fn, args], {
      timeoutMs: options.timeoutMs ?? budgets.timeoutMs,
      signal: options.signal,
      maxInputBytes: options.maxInputBytes ?? budgets.maxInputBytes,
      inputSubject: `The input of ${fn}`,
    });
  }
}

export function createLibClient(config: ServerConfig, options?: LibClientOptions): LibClient {
  return new LibClient(config, options);
}
