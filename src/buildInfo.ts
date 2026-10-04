// What this dist was built from. tsup injects `__CARDANO_DEBUG_BUILD__` (see tsup.config.ts); running from
// source (tsx, vitest) has no such constant and reports `{ source: "src" }`. The package version is
// separate (wasm-assets.ts packageVersion).

export interface BuildInfo {
  /** `"dist"` for a built bundle, `"src"` when running from source. */
  source: "dist" | "src";
  /** ISO time of the build. */
  built_at?: string;
  /** This repository's commit (short; `+dirty` when the tree had local changes). */
  commit?: string;
  /** Commit of the deps/de-uplc-web checkout the wasm was built from. */
  deps_commit?: string;
  /** dehosk revision pinned by the decompiler crate. */
  dehosk_rev?: string;
  /** aiken/uplc revision pinned by the engine crate. */
  uplc_rev?: string;
}

declare const __CARDANO_DEBUG_BUILD__: Omit<BuildInfo, "source"> | undefined;

export function buildInfo(): BuildInfo {
  try {
    if (typeof __CARDANO_DEBUG_BUILD__ !== "undefined" && __CARDANO_DEBUG_BUILD__) return { source: "dist", ...__CARDANO_DEBUG_BUILD__ };
  } catch {
    // fall through
  }
  return { source: "src" };
}

/** `built 2026-10-04T10:00:00Z, commit abc1234, de-uplc-web 57c5815, dehosk eb42c2e`, or `from source`. */
export function describeBuild(info: BuildInfo = buildInfo()): string {
  if (info.source === "src") return "from source";
  const parts: string[] = [];
  if (info.built_at) parts.push(`built ${info.built_at}`);
  if (info.commit) parts.push(`commit ${info.commit}`);
  if (info.deps_commit) parts.push(`de-uplc-web ${info.deps_commit.slice(0, 7)}`);
  if (info.dehosk_rev) parts.push(`dehosk ${info.dehosk_rev.slice(0, 7)}`);
  return parts.length ? parts.join(", ") : "build info unavailable";
}
