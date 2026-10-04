// Are the files this build needs there? One cheap check at start-up (so a half-built dist says so in one
// line instead of failing later inside a worker) and the same rows for `--check` (src/cli.ts).

import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveAsset, resolveWasm, textAssetDir, type WasmAssetName } from "./wasm-assets.js";
import { resolveWorkerEntry } from "./workers/host.js";

export interface FileCheck {
  /** Human name of the file: `worker lib.worker`, `wasm de_uplc_bg.wasm`, … */
  name: string;
  ok: boolean;
  /** Resolved path when found, the reason when not. */
  detail: string;
  /** Size in bytes when found. */
  bytes?: number;
  /** Without it no tool can work (the server exits instead of serving a dead process). */
  critical: boolean;
}

export const WORKER_NAMES = ["lib.worker", "session.worker", "decompiler.worker"] as const;
export const WASM_BINARIES: readonly WasmAssetName[] = ["de_uplc_bg.wasm", "de_uplc_decompiler_wasm_bg.wasm"];

/** Worker entry (`dist/workers/<name>.js`, or `src/workers/<name>.ts` under tsx). */
export function checkWorkers(): FileCheck[] {
  return WORKER_NAMES.map((name) => {
    try {
      const url = resolveWorkerEntry(name);
      return { name: `worker ${name}`, ok: true, detail: fileURLToPath(url), critical: name === "lib.worker" };
    } catch (error) {
      return { name: `worker ${name}`, ok: false, detail: error instanceof Error ? error.message : String(error), critical: name === "lib.worker" };
    }
  });
}

/** The debugger and decompiler wasm binaries (`dist/wasm/`, or the dependency packages under tsx). */
export function checkWasm(): FileCheck[] {
  return WASM_BINARIES.map((name) => {
    try {
      const file = resolveWasm(name);
      return { name: `wasm ${name}`, ok: true, detail: file, bytes: statSync(file).size, critical: false };
    } catch (error) {
      return { name: `wasm ${name}`, ok: false, detail: error instanceof Error ? error.message : String(error), critical: false };
    }
  });
}

/** Docs, prompt templates and the bundled CDDL (copied into dist/ by the build). */
export function checkTextAssets(): FileCheck[] {
  const probe = (name: string, locate: () => string): FileCheck => {
    try {
      const found = locate();
      return { name, ok: existsSync(found), detail: found, critical: false };
    } catch (error) {
      return { name, ok: false, detail: error instanceof Error ? error.message : String(error), critical: false };
    }
  };
  return [probe("docs", () => textAssetDir("docs")), probe("prompts", () => textAssetDir("prompts")), probe("cddl conway.cddl", () => resolveAsset("cddl/conway.cddl"))];
}

/** Everything `checkWorkers` and `checkWasm` look at. */
export function checkBuildFiles(): FileCheck[] {
  return [...checkWorkers(), ...checkWasm()];
}

/** The ONE line a start with missing build files logs, or undefined when everything is there. */
export function incompleteBuildMessage(checks: readonly FileCheck[]): string | undefined {
  const missing = checks.filter((check) => !check.ok);
  if (missing.length === 0) return undefined;
  return `this build is incomplete (missing: ${missing.map((m) => m.name).join(", ")}); in the repository run "npm run build:deps && npm run build", then restart the server`;
}
