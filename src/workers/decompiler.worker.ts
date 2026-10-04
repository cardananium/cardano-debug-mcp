// decompiler.worker: owns the single dehosk wasm instance (@cardananium/de-uplc-decompiler-wasm, wasm-pack
// --target web). Exactly one instance per process: the module bakes in a 64 MB shadow stack and the
// instance grows to ~85 MB after the first call, so it is never duplicated. The host is serial
// (one decompile in flight) and respawns this worker after a trap (RuntimeError / stack overflow
// leave the shadow stack pointer unrestored) or a hard timeout — the decompiler cannot be
// interrupted from inside.
//
// The wasm is instantiated from bytes with `initSync({ module })`; the glue's default `init()`
// (URL fetch) is never called.

import * as decompiler from "@cardananium/de-uplc-decompiler-wasm";

import { readWasm } from "../wasm-assets.js";
import { serveWorker } from "./rpc-worker.js";

const MAX_HEX_CHARS = 4 * 1024 * 1024;

// ---------- test hook (CARDANO_DEBUG_TEST_HOOKS=1 only) ----------
// CARDANO_DEBUG_TEST_DECOMPILE_DELAY_MS=<n> blocks the worker thread for n ms before every
// decompile, the way a slow dehosk run does (it cannot be interrupted either), so the watchdog /
// failure-marker tests do not depend on how fast the real decompiler is on the test machine.
const TEST_DELAY_MS = process.env.CARDANO_DEBUG_TEST_HOOKS === "1" ? Number.parseInt(process.env.CARDANO_DEBUG_TEST_DECOMPILE_DELAY_MS ?? "", 10) : Number.NaN;

function testDelay(): void {
  if (!Number.isFinite(TEST_DELAY_MS) || TEST_DELAY_MS <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TEST_DELAY_MS);
}

let catalogueText: string | null = null;
let catalogueVersion: number | undefined;
let calls = 0;

function init(): void {
  const started = Date.now();
  const bytes = readWasm("de_uplc_decompiler_wasm_bg.wasm");
  decompiler.initSync({ module: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
  catalogueText = decompiler.options_catalogue();
  try {
    const parsed = JSON.parse(catalogueText) as { version?: unknown };
    if (typeof parsed.version === "number") catalogueVersion = parsed.version;
  } catch {
    // reported by the host when it parses the catalogue
  }
  console.error(`dehosk wasm ready in ${Date.now() - started} ms (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB module)`);
}

/** `options_catalogue()` JSON text (captured at init). */
function catalogue(): string {
  if (catalogueText === null) catalogueText = decompiler.options_catalogue();
  return catalogueText;
}

export interface DecompileAnswer {
  text: string;
  elapsed_ms: number;
}

/**
 * `decompile(hex, optionsJson)`: the rendered text (pseudocode or UPLC by `output_layer`).
 * Throws the decompiler's message (`Error`) for bad input / options; a wasm trap propagates as a
 * `RuntimeError` / `RangeError`, which the RPC layer classifies as fatal.
 */
function decompile(hex: unknown, optionsJson: unknown): DecompileAnswer {
  if (typeof hex !== "string" || hex.length === 0) throw new Error("decompile: the script hex is missing");
  if (hex.length > MAX_HEX_CHARS) throw new Error(`decompile: the script hex is ${hex.length} characters, over the ${MAX_HEX_CHARS} limit`);
  const options = typeof optionsJson === "string" ? optionsJson : "";
  const started = Date.now();
  calls++;
  testDelay();
  const text = decompiler.decompile_uplc(hex, options);
  return { text, elapsed_ms: Date.now() - started };
}

/** Static provenance for the `ready` message; live counters come from `WorkerHost.stats()` / `__stats`. */
function info(): Record<string, unknown> {
  return {
    decompiler: "@cardananium/de-uplc-decompiler-wasm",
    engine: "dehosk",
    catalogue_version: catalogueVersion,
    ...(calls > 0 ? { calls } : {}),
  };
}

serveWorker({ decompile, catalogue, info }, { init, info });
