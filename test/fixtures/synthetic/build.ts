// Build every synthetic scenario deterministically and write its files under test/fixtures/ plus the manifest
// (test/fixtures/manifest.json). No network, no clock, no randomness: two runs give byte-identical files.
//
//   npm run fixtures:build     write the files
//   npm run fixtures:check     rebuild in memory and compare with the committed files (exit 1 on any difference)

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { mergeManifest, manifestText, type ManifestValue } from "./lib/manifest.js";
import { toolkit, type Scenario } from "./lib/toolkit.js";
import { scenarios as registered } from "./scenarios/index.js";

export const FIXTURES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_FILE = "manifest.json";

export interface BuildResult {
  /** relative path (under test/fixtures/) -> content */
  files: Map<string, string | Uint8Array>;
  manifest: Record<string, ManifestValue>;
  /** scenario name -> its file paths */
  byScenario: Record<string, string[]>;
}

function checkPath(scenario: string, file: string): void {
  if (path.isAbsolute(file) || file.split("/").includes("..") || file.includes("\\")) throw new Error(`scenario ${scenario}: bad output path ${file}`);
  if (file === MANIFEST_FILE) throw new Error(`scenario ${scenario}: ${MANIFEST_FILE} is reserved`);
}

/** Run the scenarios (default: every registered one) and collect their files and manifest. */
export function buildAll(scenarios: Scenario[] = registered): BuildResult {
  const files = new Map<string, string | Uint8Array>();
  const manifest: Record<string, ManifestValue> = {};
  const byScenario: Record<string, string[]> = {};
  const names = new Set<string>();
  for (const s of scenarios) {
    if (names.has(s.name)) throw new Error(`duplicate scenario name ${s.name}`);
    names.add(s.name);
    const out = s.build(toolkit);
    byScenario[s.name] = [];
    for (const [file, content] of Object.entries(out.files)) {
      checkPath(s.name, file);
      if (files.has(file)) throw new Error(`scenario ${s.name}: output file ${file} is already produced by another scenario`);
      files.set(file, content);
      byScenario[s.name]!.push(file);
    }
    mergeManifest(manifest, s.name, out.manifest);
  }
  manifest._files = Array.from(files.keys()).sort();
  files.set(MANIFEST_FILE, manifestText(manifest));
  return { files, manifest, byScenario };
}

const asBuffer = (c: string | Uint8Array): Buffer => (typeof c === "string" ? Buffer.from(c, "utf8") : Buffer.from(c));

function previousFiles(root: string): string[] {
  const file = path.join(root, MANIFEST_FILE);
  if (!existsSync(file)) return [];
  try {
    const m = JSON.parse(readFileSync(file, "utf8")) as { _files?: string[] };
    return Array.isArray(m._files) ? m._files : [];
  } catch {
    return [];
  }
}

/** Write the build into `root` (default test/fixtures), removing files an earlier build wrote that no scenario produces any more. */
export function writeAll(result: BuildResult, root = FIXTURES_ROOT): { written: number; removed: string[] } {
  const removed: string[] = [];
  for (const old of previousFiles(root)) {
    if (!result.files.has(old) && existsSync(path.join(root, old))) {
      rmSync(path.join(root, old), { force: true });
      removed.push(old);
    }
  }
  for (const [file, content] of result.files) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, asBuffer(content));
  }
  return { written: result.files.size, removed };
}

/** Compare the build with the files on disk. */
export function diffAll(result: BuildResult, root = FIXTURES_ROOT): string[] {
  const problems: string[] = [];
  for (const [file, content] of result.files) {
    const target = path.join(root, file);
    if (!existsSync(target)) {
      problems.push(`missing: ${file}`);
      continue;
    }
    if (!readFileSync(target).equals(asBuffer(content))) problems.push(`differs: ${file}`);
  }
  for (const old of previousFiles(root)) if (!result.files.has(old)) problems.push(`stale (no scenario produces it any more): ${old}`);
  return problems;
}

function main(): void {
  const check = process.argv.includes("--check");
  const started = Date.now();
  const result = buildAll();
  if (check) {
    const problems = diffAll(result);
    if (problems.length > 0) {
      console.error(`fixtures:check found ${problems.length} problem(s); run npm run fixtures:build and commit the result\n  ${problems.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`fixtures:check ok: ${result.files.size} files match (${Date.now() - started} ms)`);
    return;
  }
  const { written, removed } = writeAll(result);
  console.log(`fixtures:build wrote ${written} files${removed.length ? `, removed ${removed.length} stale` : ""} (${Date.now() - started} ms)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
