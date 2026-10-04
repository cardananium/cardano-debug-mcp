// lib.worker: owns the single cquisitor-lib wasm instance. One call at a time (the host is serial),
// so the library's CDDL schema cache is shared and a trap only ever concerns one call.
//
// The wasm is loaded through the library's own `loadWasm()` (`@cardananium/cquisitor-lib/wasm`,
// the node build: CommonJS glue that reads its 7 MB binary next to its own file at require time),
// so the package stays external to the bundle. `callLib(fn, args)` answers EXACTLY what the wasm
// function returned (the `LibBackend` contract): JSON text for the text-answering functions, the
// JS value — bigint, serde boxes and all — for the rest; the host shapes it (src/lib.ts).

import { createRequire } from "node:module";

import { answersInJsonText, isWasmFunction, loadWasm, type WasmModule } from "@cardananium/cquisitor-lib";

import { serveWorker } from "./rpc-worker.js";

const require = createRequire(import.meta.url);

let lib: WasmModule | null = null;
let libVersion = "unknown";

// ---------- test hooks (CARDANO_DEBUG_TEST_HOOKS=1 only) ----------
// The library itself refuses hostile input gracefully (deep nesting, garbage), so proving that the
// server survives a *lost* worker needs a way to lose one on purpose: a genuine wasm trap
// (`unreachable`) or a JS stack overflow. Both are classified fatal by the host, which then
// respawns the worker. Never enabled in normal operation.
const TEST_HOOKS = process.env.CARDANO_DEBUG_TEST_HOOKS === "1";
/** Hex of "__trap__": with test hooks on, any library call carrying it as its first argument traps. */
const TRAP_MAGIC_HEX = "5f5f747261705f5f";

// (module (func (export "trap") unreachable))
const TRAP_MODULE_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type: () -> ()
  0x03, 0x02, 0x01, 0x00, // one function of type 0
  0x07, 0x08, 0x01, 0x04, 0x74, 0x72, 0x61, 0x70, 0x00, 0x00, // export "trap" = func 0
  0x0a, 0x05, 0x01, 0x03, 0x00, 0x00, 0x0b, // body: unreachable; end
]);

function simulateTrap(kind: unknown = "unreachable"): never {
  if (!TEST_HOOKS) throw new Error("simulateTrap is available only with CARDANO_DEBUG_TEST_HOOKS=1");
  if (kind === "stack_overflow") {
    const recurse = (n: number): number => recurse(n + 1) + 1;
    return recurse(0) as never;
  }
  // `lib` has no DOM types: reach WebAssembly through globalThis (same as the engine service).
  const wa = (globalThis as unknown as { WebAssembly: { Module: new (bytes: Uint8Array) => object; Instance: new (module: object, imports: object) => { exports: Record<string, unknown> } } }).WebAssembly;
  const instance = new wa.Instance(new wa.Module(TRAP_MODULE_BYTES), {});
  (instance.exports.trap as () => void)();
  throw new Error("the trap module returned"); // unreachable
}

async function loadLib(): Promise<WasmModule> {
  if (lib) return lib;
  lib = await loadWasm();
  try {
    libVersion = (require("@cardananium/cquisitor-lib/package.json") as { version?: string }).version ?? libVersion;
  } catch {
    // keep 'unknown'
  }
  return lib;
}

/**
 * `callLib(fn, args)`: invoke one of the library's wasm functions (the library's own allowlist,
 * `isWasmFunction`: an unchecked name could reach constructors whose instances cannot be cloned).
 * The answer is the wasm's, untouched.
 */
function callLib(fn: unknown, args: unknown): unknown {
  if (!isWasmFunction(fn)) throw new Error(`${String(fn)} is not a callable library function`);
  if (!lib) throw new Error("the library is not loaded yet");
  const impl = (lib as unknown as Record<string, unknown>)[fn];
  if (typeof impl !== "function") throw new Error(`The library does not export ${fn}`);
  const list = Array.isArray(args) ? args : [];
  if (TEST_HOOKS && list[0] === TRAP_MAGIC_HEX) simulateTrap("unreachable");
  const raw = (impl as (...a: unknown[]) => unknown)(...list);
  if (answersInJsonText(fn) && typeof raw !== "string") throw new Error(`The library answered ${fn} with something other than JSON text`);
  return raw;
}

/** The library's own version string (from its package.json). */
function libInfo(): Record<string, unknown> {
  return { lib: "@cardananium/cquisitor-lib", version: libVersion, exports: lib ? Object.keys(lib).length : 0 };
}

serveWorker(
  TEST_HOOKS ? { callLib, libInfo, simulateTrap } : { callLib, libInfo },
  {
    init: async () => {
      await loadLib();
    },
    info: libInfo,
  },
);
