// Loader for the generated synthetic fixtures (test/fixtures/**, built by `npm run fixtures:build`).
//
//   fixturePath("vote-tx.tx")        absolute path of a fixture file or directory
//   readFixtureText("vote-tx.tx")    its text
//   readTx("vote-tx.tx")             a bare-hex tx fixture, trimmed
//   fx("s12.txId")                   a manifest value (throws a clear error for a missing key)
//   fxStr / fxNum / fxInt / fxBig    the same with the type checked ("size" numbers, bigint from decimal strings)
//
// Tests read every id, hash and number that came from a fixture from the manifest; none is hard-coded.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lookup } from "../fixtures/synthetic/lib/manifest.js";

export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export function fixturePath(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

export function readFixtureText(name: string): string {
  return readFileSync(fixturePath(name), "utf8");
}

/** A `.tx` fixture: the hex, trimmed. */
export function readTx(name: string): string {
  return readFixtureText(name).trim();
}

export function readFixtureJson<T = unknown>(name: string): T {
  return JSON.parse(readFixtureText(name)) as T;
}

let cachedManifest: Record<string, unknown> | undefined;

/** The whole manifest (flat `<scenario>.<thing>` keys; values may be nested objects). */
export function manifest(): Record<string, unknown> {
  if (!cachedManifest) {
    try {
      cachedManifest = JSON.parse(readFileSync(fixturePath("manifest.json"), "utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`test/fixtures/manifest.json cannot be read (${error instanceof Error ? error.message : String(error)}); run \`npm run fixtures:build\``);
    }
  }
  return cachedManifest;
}

export function fxHas(key: string): boolean {
  return lookup(manifest(), key).found;
}

/** Keys of the manifest that start with `prefix` (for error messages and tests that walk a scenario). */
export function fxKeys(prefix = ""): string[] {
  return Object.keys(manifest()).filter((k) => k.startsWith(prefix) && !k.startsWith("_"));
}

/** A manifest value by key (`s12.txId`, or a path into an object: `s12.spans.body.offset`). */
export function fx<T = unknown>(key: string): T {
  const hit = lookup(manifest(), key);
  if (!hit.found) {
    const scenario = key.split(".")[0] ?? "";
    const known = fxKeys(`${scenario}.`);
    throw new Error(
      `fixture manifest has no key "${key}"` +
        (known.length > 0 ? ` (scenario "${scenario}" has: ${known.slice(0, 40).join(", ")}${known.length > 40 ? ", ..." : ""})` : ` (no scenario "${scenario}" in the manifest; run \`npm run fixtures:build\`)`),
    );
  }
  return hit.value as T;
}

export function fxStr(key: string): string {
  const v = fx(key);
  if (typeof v !== "string") throw new Error(`fixture manifest key "${key}" is a ${typeof v}, not a string`);
  return v;
}

export function fxNum(key: string): number {
  const v = fx(key);
  if (typeof v !== "number") throw new Error(`fixture manifest key "${key}" is a ${typeof v}, not a number`);
  return v;
}

/** A number that must be an integer. */
export function fxInt(key: string): number {
  const v = fxNum(key);
  if (!Number.isInteger(v)) throw new Error(`fixture manifest key "${key}" is ${v}, not an integer`);
  return v;
}

/** A bigint recorded as a decimal string (or a safe integer number). */
export function fxBig(key: string): bigint {
  const v = fx(key);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  throw new Error(`fixture manifest key "${key}" is not an integer (${JSON.stringify(v)})`);
}

export function fxArr<T = unknown>(key: string): T[] {
  const v = fx(key);
  if (!Array.isArray(v)) throw new Error(`fixture manifest key "${key}" is not an array`);
  return v as T[];
}
