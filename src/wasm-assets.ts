// Locates the wasm binaries (and their JS glue) in both run modes:
//  - dist mode: tsup copied them to <package>/dist/wasm/<name> (see tsup.config.ts);
//  - dev mode (`tsx src/server.ts`): resolved from the dependency packages via `require.resolve`.
// Also locates bundled text assets (src/assets/cddl/<era>.cddl -> dist/assets/cddl/<era>.cddl) and the
// model-facing docs and prompt templates (src/{docs,prompts} -> dist/{docs,prompts}) the same way.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/**
 * Known assets: file name in dist/wasm -> the exported subpath of the binary that sits next to it
 * in the dependency package (the packages export only an ESM `import` condition for the glue, so
 * everything is located relative to the binary's exported path).
 */
export const WASM_ASSETS = {
  "de_uplc_bg.wasm": "@cardananium/de-uplc-engine-wasm/de_uplc_bg.wasm",
  "de_uplc.js": "@cardananium/de-uplc-engine-wasm/de_uplc_bg.wasm",
  "de_uplc_decompiler_wasm_bg.wasm": "@cardananium/de-uplc-decompiler-wasm/de_uplc_decompiler_wasm_bg.wasm",
  "de_uplc_decompiler_wasm.js": "@cardananium/de-uplc-decompiler-wasm/de_uplc_decompiler_wasm_bg.wasm",
} as const;

export type WasmAssetName = keyof typeof WASM_ASSETS;

let cachedRoot: string | null = null;

/** Directory that holds this package's package.json (works from src/, dist/ and dist/workers/). */
export function packageRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string };
        if (pkg.name === "@cardananium/cardano-debug-mcp") {
          cachedRoot = dir;
          return dir;
        }
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("cardano-debug-mcp: package root not found from " + import.meta.url);
}

/**
 * Absolute path of a wasm asset. Prefers the copy in dist/wasm (present after `npm run build`,
 * and the only copy in a published tarball), then the dependency package (dev mode).
 */
export function resolveWasm(name: WasmAssetName): string {
  const root = packageRoot();
  const inDist = path.join(root, "dist", "wasm", name);
  if (existsSync(inDist)) return inDist;
  const specifier = WASM_ASSETS[name];
  try {
    const binary = require.resolve(specifier, { paths: [root] });
    const candidate = path.join(path.dirname(binary), name);
    if (!existsSync(candidate)) throw new Error(`${candidate} does not exist`);
    return candidate;
  } catch (error) {
    throw new Error(
      `wasm asset ${name} not found: neither ${inDist} nor dependency ${specifier} (${(error as Error).message})`,
    );
  }
}

/** The bytes of a wasm asset (for `new WebAssembly.Module(bytes)` / `initSync({ module })`). */
export function readWasm(name: WasmAssetName): Buffer {
  return readFileSync(resolveWasm(name));
}

/** Path of a bundled text asset: src/assets/<name> in dev, dist/assets/<name> after build (tsup copies src/assets there). */
export function resolveAsset(name: string): string {
  const root = packageRoot();
  for (const candidate of [path.join(root, "src", "assets", name), path.join(root, "dist", "assets", name), path.join(root, "assets", name)]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`asset ${name} not found under ${root}/src/assets or ${root}/dist/assets`);
}

export function readAsset(name: string): string {
  return readFileSync(resolveAsset(name), "utf8");
}

/**
 * Directory of a bundled text tree: src/<name> in dev, dist/<name> after build (tsup copies the .md /
 * .json files of src/docs and src/prompts there). Used for the model-facing docs and prompt templates.
 */
export function textAssetDir(name: "docs" | "prompts"): string {
  const root = packageRoot();
  // The src tree wins in a checkout (dev and tests read what is edited); a published package has only dist.
  for (const candidate of [path.join(root, "src", name), path.join(root, "dist", name)]) {
    if (existsSync(path.join(candidate, name === "docs" ? "errors.json" : "debug_tx.md"))) return candidate;
  }
  throw new Error(`text assets '${name}' not found under ${root}/src or ${root}/dist`);
}

/** Package version, read from package.json (no build-time define, so tsx dev mode agrees with dist). */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
