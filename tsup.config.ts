// Build: one ESM bundle per entry (server + every worker), no code splitting so each
// worker file is self-contained and `new Worker(new URL('./workers/x.js', import.meta.url))`
// resolves inside the published package. The @cardananium/de-uplc-* packages ship TypeScript sources
// (no npm artifact): they are devDependencies, bundled here, and their wasm is copied to dist/wasm
// (a missing binary fails the build). @cardananium/cquisitor-lib stays external because its
// node build reads the wasm binary relative to its own __dirname at require time.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "tsup";

const require = createRequire(import.meta.url);

/** Worker entries. A missing file is skipped (with a note) so the skeleton builds before every worker exists. */
const WORKER_ENTRIES: Record<string, string> = {
  "workers/lib.worker": "src/workers/lib.worker.ts",
  "workers/session.worker": "src/workers/session.worker.ts",
  "workers/decompiler.worker": "src/workers/decompiler.worker.ts",
};

/**
 * wasm binaries + JS glue copied verbatim into dist/wasm/ (see src/wasm-assets.ts for the resolver).
 * The glue lives next to the binary in each package's pkg/ dir (its package exports only the ESM
 * `import` condition, so it is located via the binary's exported subpath).
 */
const WASM_ASSETS: Array<{ specifier: string; out: string; siblings: string[] }> = [
  { specifier: "@cardananium/de-uplc-engine-wasm/de_uplc_bg.wasm", out: "de_uplc_bg.wasm", siblings: ["de_uplc.js", "de_uplc.d.ts"] },
  {
    specifier: "@cardananium/de-uplc-decompiler-wasm/de_uplc_decompiler_wasm_bg.wasm",
    out: "de_uplc_decompiler_wasm_bg.wasm",
    siblings: ["de_uplc_decompiler_wasm.js", "de_uplc_decompiler_wasm.d.ts"],
  },
];

/** stdout of a git command in `cwd`, or undefined when git or the repository is not there (a tarball build). */
function git(args: string[], cwd: string = process.cwd()): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/** First `rev = "<sha>"` of `<name> = { git = ..., rev = ... }` in a crate manifest. */
function pinnedRev(manifest: string, name: string): string | undefined {
  try {
    return new RegExp(`^${name}\\s*=\\s*\\{[^}]*rev\\s*=\\s*"([0-9a-f]{7,40})"`, "m").exec(readFileSync(manifest, "utf8"))?.[1];
  } catch {
    return undefined;
  }
}

/** Provenance baked into dist (src/buildInfo.ts): every field is optional, a build without git still works. */
function computeBuildInfo(): Record<string, string> {
  const deps = path.resolve("deps/de-uplc-web");
  const commit = git(["rev-parse", "--short=12", "HEAD"]);
  const dirty = commit && git(["status", "--porcelain", "--untracked-files=no"]) ? "+dirty" : "";
  const fields: Record<string, string | undefined> = {
    built_at: new Date().toISOString(),
    commit: commit ? `${commit}${dirty}` : undefined,
    deps_commit: existsSync(path.join(deps, ".git")) ? git(["rev-parse", "HEAD"], deps) : undefined,
    dehosk_rev: pinnedRev(path.join(deps, "packages/decompiler-wasm/crate/Cargo.toml"), "dehosk"),
    uplc_rev: pinnedRev(path.join(deps, "packages/engine-wasm/crate/Cargo.toml"), "uplc"),
  };
  return Object.fromEntries(Object.entries(fields).filter((pair): pair is [string, string] => pair[1] !== undefined));
}

const entry: Record<string, string> = { server: "src/server.ts" };
for (const [name, file] of Object.entries(WORKER_ENTRIES)) {
  if (existsSync(file)) entry[name] = file;
  else console.error(`[tsup] note: ${file} does not exist yet; entry '${name}' skipped`);
}

export default defineConfig({
  entry,
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  shims: false,
  treeshake: true,
  // The glue's default `init()` builds `new URL('x.wasm', import.meta.url)` — never called, kept as-is.
  noExternal: [/^@cardananium\/de-uplc-/],
  define: { __CARDANO_DEBUG_BUILD__: JSON.stringify(computeBuildInfo()) },
  external: [/^@cardananium\/cquisitor-lib(\/|$)/, "@modelcontextprotocol/server", "zod", "bech32"],
  esbuildOptions(options) {
    options.legalComments = "none";
  },
  async onSuccess() {
    const wasmDir = path.resolve("dist/wasm");
    mkdirSync(wasmDir, { recursive: true });
    for (const asset of WASM_ASSETS) {
      try {
        const from = require.resolve(asset.specifier);
        cpSync(from, path.join(wasmDir, asset.out));
        for (const sibling of asset.siblings) {
          const siblingPath = path.join(path.dirname(from), sibling);
          if (existsSync(siblingPath)) cpSync(siblingPath, path.join(wasmDir, sibling));
        }
      } catch (error) {
        // A dist without the engine / decompiler wasm starts but cannot debug or decompile: fail the build.
        throw new Error(`[tsup] wasm asset ${asset.specifier} not copied (run "npm run build:deps" first): ${(error as Error).message}`);
      }
    }
    // Text assets (src/assets/cddl/<era>.cddl + ATTRIBUTION.md, …) -> dist/assets; see src/wasm-assets.ts resolveAsset.
    const assetsDir = path.resolve("dist/assets");
    mkdirSync(assetsDir, { recursive: true });
    for (const source of ["src/assets", "assets"]) {
      if (existsSync(path.resolve(source))) cpSync(path.resolve(source), assetsDir, { recursive: true });
    }
    // Model-facing docs (src/docs/<topic>/*.md, errors.json) and prompt templates (src/prompts/*.md)
    // -> dist/docs, dist/prompts; see src/wasm-assets.ts textAssetDir.
    for (const tree of ["docs", "prompts"]) {
      const from = path.resolve("src", tree);
      if (!existsSync(from)) continue;
      cpSync(from, path.resolve("dist", tree), { recursive: true, filter: (source) => statSync(source).isDirectory() || /\.(md|json)$/.test(source) });
    }
    const bin = path.resolve("dist/server.js");
    if (existsSync(bin)) chmodSync(bin, 0o755);
  },
});
