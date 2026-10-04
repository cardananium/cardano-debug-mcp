// The README must stay true: it names every tool, prompt and environment variable the code has, quotes the
// defaults and limits of src/config.ts and the cache numbers of src/chain/cache.ts, and only uses npm scripts
// and command line flags that exist.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ERA_PRESETS } from "../../src/cbor/presets.js";
import { DEFAULT_DISK_BUDGET_BYTES, TTL } from "../../src/chain/cache.js";
import { parseCliArgs } from "../../src/cli.js";
import * as configModule from "../../src/config.js";
import { registerPrompts } from "../../src/prompts/index.js";
import { ALL_TOOLS } from "../../src/tools/index.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const README = readFileSync(path.join(ROOT, "README.md"), "utf8");
const PACKAGE = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };

/** Every src/**.ts file. */
function sourceFiles(dir = path.join(ROOT, "src")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "docs" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Environment variables the server reads: `env.NAME`, `process.env.NAME` or a quoted / templated name. Test hooks are not documented. */
function environmentVariables(): string[] {
  const found = new Set<string>();
  const pattern = /(?:\benv\.|\benv\[\s*|["'`])((?:CARDANO_DEBUG|KOIOS|BLOCKFROST)_[A-Z0-9_]*)/g;
  for (const file of sourceFiles()) {
    for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
      const name = match[1]!;
      if (!name.includes("_TEST_")) found.add(name);
    }
  }
  return [...found].sort();
}

const mentions = (name: string): boolean => new RegExp(`\\b${name}\\b`).test(README);
/** A per-network variable is documented as `<name>_MAINNET` followed by `_PREPROD` / `_PREVIEW`. */
function documented(name: string): boolean {
  if (name.endsWith("_")) return mentions(`${name}MAINNET`);
  const network = /^(.*)_(MAINNET|PREPROD|PREVIEW)$/.exec(name);
  if (network) return mentions(name) || (mentions(`${network[1]}_MAINNET`) && README.includes(`\`_${network[2]}\``));
  return mentions(name);
}

describe("README names everything the code has", () => {
  it("every registered tool", () => {
    for (const tool of ALL_TOOLS) expect(README, tool.name).toContain(`\`${tool.name}\``);
  });

  it("every registered prompt", () => {
    const registered: string[] = [];
    const server = { registerPrompt: (name: string) => void registered.push(name) };
    registerPrompts(server as never, {} as never);
    expect(registered.length).toBeGreaterThan(0);
    for (const name of registered) expect(README, name).toContain(`\`${name}\``);
  });

  it("every CARDANO_DEBUG_* / KOIOS_* / BLOCKFROST_* variable the source reads (a templated name by its first network)", () => {
    const variables = environmentVariables();
    expect(variables).toEqual(expect.arrayContaining(["CARDANO_DEBUG_CACHE_DIR", "KOIOS_API_KEY", "CARDANO_DEBUG_OFFLINE"]));
    const missing = variables.filter((name) => !documented(name));
    expect(missing, `README.md does not mention: ${missing.join(", ")}`).toEqual([]);
    // the per-network variables come as `<name>_MAINNET / _PREPROD / _PREVIEW`
    for (const prefix of variables.filter((name) => name.endsWith("_"))) for (const net of ["_PREPROD", "_PREVIEW"]) expect(README, `${prefix}${net}`).toContain(`\`${net}\``);
  });

  it("the Dijkstra preset next to the earlier eras", () => {
    expect(ERA_PRESETS).toContain("dijkstra");
    expect(README).toMatch(/Shelley to Conway[^|]*Dijkstra/);
  });
});

describe("README quotes the code's numbers", () => {
  it("the default and the maximum of every limited variable in src/config.ts", () => {
    const limits = (configModule as { ENV_LIMITS?: Record<string, { default: number; max: number }> }).ENV_LIMITS;
    expect(limits, "src/config.ts exports ENV_LIMITS").toBeDefined();
    for (const [name, limit] of Object.entries(limits!)) {
      const line = README.split("\n").find((l) => l.includes(`\`${name}\``));
      expect(line, `a README row for ${name}`).toBeDefined();
      expect(line, `${name} default`).toContain(`\`${limit.default}\``);
      expect(line, `${name} maximum`).toContain(`\`${limit.max}\``);
    }
  });

  it("the cache lifetimes and the disk budget of src/chain/cache.ts", () => {
    const minutes = (ms: number) => `${ms / 60_000} minutes`;
    expect(README).toContain(`UTxO rows: ${minutes(TTL.utxoRows)}`);
    expect(README).toContain(`Other provider rows (accounts, pools, DReps…): ${minutes(TTL.providerRows)}`);
    expect(README).toContain(`(${minutes(TTL.pendingContext)} while the transaction is not on chain)`);
    expect(README).toContain(`context a validation reads: ${TTL.context / 3_600_000} hour`);
    expect(README).toContain(`${DEFAULT_DISK_BUDGET_BYTES / 1024 / 1024} MB`);
  });
});

describe("README only uses what exists", () => {
  it("every `npm run <script>` is a package.json script", () => {
    const used = [...README.matchAll(/npm run ([a-z0-9:-]+)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(3);
    for (const script of used) expect(PACKAGE.scripts, script).toHaveProperty(script);
  });

  it("the command line flags are recognised", () => {
    for (const flag of ["--check", "--version"]) {
      expect(README).toContain(flag);
      expect(parseCliArgs([flag]).kind).not.toBe("error");
    }
  });

  it("claude mcp add shows the user scope and the .mcp.json example guards the optional key", () => {
    expect(README).toContain("claude mcp add --scope user cardano-debug --");
    expect(README).toContain("--scope user --env KOIOS_API_KEY=");
    expect(README).toContain('"KOIOS_API_KEY": "${KOIOS_API_KEY:-}"');
    expect(README).not.toContain('"${KOIOS_API_KEY}"');
  });

  it("has the sections a user looks for", () => {
    for (const heading of ["## Install", "## Add it to Claude Code", "## Configuration", "## Chain data cache", "## Troubleshooting", "## Update", "## Uninstall", "## Development"]) expect(README, heading).toContain(`\n${heading}\n`);
  });

  it("the wasm-bindgen pins are the ones in the submodule's lock files (when the submodule is checked out)", () => {
    const pin = (crate: string): string | undefined => {
      const lock = path.join(ROOT, "deps", "de-uplc-web", "packages", crate, "crate", "Cargo.lock");
      if (!existsSync(lock)) return undefined;
      return /name = "wasm-bindgen"\nversion = "([^"]+)"/.exec(readFileSync(lock, "utf8"))?.[1];
    };
    const decompiler = pin("decompiler-wasm");
    const engine = pin("engine-wasm");
    if (decompiler) expect(README).toContain(`cargo install wasm-bindgen-cli --version ${decompiler} --locked`);
    if (engine && engine !== decompiler) expect(README).toContain(`(${engine})`);
  });
});
