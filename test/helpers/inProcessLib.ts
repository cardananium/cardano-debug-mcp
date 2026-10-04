// In-process library for unit tests: the wasm in this thread (no worker), behind the same
// `LibApi` surface the server's worker-backed client offers, so chain / cbor helpers run unchanged.
//
//   inProcessLib()  -> a LibApi over the library's default in-process backend (typed, wire form)
//   rawLib()        -> the raw wasm module (sync, snake_case exports), for tests that want the
//                      library's own JSON text
import { createRequire } from "node:module";

import { createInProcessBackend, type InProcessBackend, type WasmModule } from "@cardananium/cquisitor-lib";

import { LibApi, type LibFunction, type LibRawCallOptions } from "../../src/lib.js";

const require = createRequire(import.meta.url);

let cachedWasm: WasmModule | undefined;

/** The raw wasm module (the package's node build, loaded synchronously through `require`). */
export function rawLib(): WasmModule {
  if (!cachedWasm) cachedWasm = require("@cardananium/cquisitor-lib/wasm") as WasmModule;
  return cachedWasm;
}

class InProcessLib extends LibApi {
  private readonly backend: InProcessBackend = createInProcessBackend();
  override callRaw<T = unknown>(fn: LibFunction, args: unknown[], options: LibRawCallOptions = {}): Promise<T> {
    return this.backend.callRaw<T>(fn, args, { signal: options.signal, timeoutMs: options.timeoutMs });
  }
}

let cachedLib: LibApi | undefined;

/** A `LibApi` calling the wasm in this thread (one instance per test process). */
export function inProcessLib(): LibApi {
  if (!cachedLib) cachedLib = new InProcessLib();
  return cachedLib;
}
