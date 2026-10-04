// The real validator (cquisitor-lib wasm), in this process. The toolkit fits transactions against it and the
// scenarios assert diagnostics from it; nothing here talks to a network.

import { createRequire } from "node:module";

import { parseJsonExact, type ValidationInputContext, type WasmModule } from "@cardananium/cquisitor-lib";

import { type ChainContext, contextJson } from "./context.js";

const require = createRequire(import.meta.url);

let cachedWasm: WasmModule | undefined;

/** The raw wasm module (sync, snake_case exports). */
export function wasm(): WasmModule {
  cachedWasm ??= require("@cardananium/cquisitor-lib/wasm") as WasmModule;
  return cachedWasm;
}

export interface EvalResult {
  tag: "Spend" | "Mint" | "Cert" | "Reward" | "Vote" | "Propose";
  index: number;
  provided_ex_units: { mem: number | string; steps: number | string };
  calculated_ex_units?: { mem: number | string; steps: number | string } | null;
  logs: string[];
  success: boolean;
  error?: string | null;
  script_context_bytes?: string | null;
  script_context?: string | null;
  script_bytes?: string | null;
  plutus_version?: "V1" | "V2" | "V3" | null;
  redeemer_bytes?: string | null;
  datum_bytes?: string | null;
  [key: string]: unknown;
}

/** `validate_transaction_js` answer in wire form (integers beyond 2^53 as decimal strings). */
export interface ValidationResult {
  errors: Array<{ error: Record<string, unknown> | string; error_message: string; hint?: string; locations?: string[] }>;
  warnings: Array<{ warning?: unknown; warning_message?: string; [k: string]: unknown }>;
  phase2_errors: unknown[];
  phase2_warnings: unknown[];
  eval_redeemer_results: EvalResult[];
  [key: string]: unknown;
}

/** Validate `txHex` against a context (a ChainContext, a ValidationInputContext or its JSON text). Throws when a UTxO is missing. */
export function validate(txHex: string, ctx: ChainContext | ValidationInputContext | string): ValidationResult {
  const text = typeof ctx === "string" ? ctx : contextJson(ctx);
  const raw = wasm().validate_transaction_js(txHex, text) as unknown as string;
  return parseJsonExact<ValidationResult>(raw, { bigIntegers: "string" });
}

/** Name of the error variant of a phase-1 / phase-2 diagnostic (`FeeTooSmallUTxO`, `ScriptDataHashMismatch`, ...). */
export function errorKind(e: ValidationResult["errors"][number]): string {
  return typeof e.error === "string" ? e.error : (Object.keys(e.error)[0] ?? "unknown");
}

export const errorKinds = (r: ValidationResult): string[] => r.errors.map(errorKind);

export interface CborNode {
  [k: string]: unknown;
}

/** Positional CBOR tree (`cbor_to_json`) in wire form. */
export function cborToJson(hex: string): { ok: boolean; value?: CborNode; [k: string]: unknown } {
  return parseJsonExact(wasm().cbor_to_json(hex) as unknown as string, { bigIntegers: "string" });
}

/** The typed decode of a ledger type (`decode_specific_type`), e.g. `Transaction`. */
export function decodeType<T = unknown>(hex: string, typeName: string, params: Record<string, unknown> = {}): T {
  return parseJsonExact<T>(wasm().decode_specific_type(hex, typeName, params as never) as unknown as string, { bigIntegers: "string" });
}

export function checkSignatures(hex: string): unknown {
  return wasm().check_block_or_tx_signatures(hex);
}
