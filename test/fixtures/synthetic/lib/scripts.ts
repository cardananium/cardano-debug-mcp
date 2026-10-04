// The script registry (test/fixtures/synthetic/scripts.json, written by the Aiken / UPLC compile step): artificial
// Plutus and native scripts by name. `registryScript(name)` returns a `PlutusScript` for the transaction builder and
// checks the registered hash against the one computed from the bytes; `registryNative(name)` does the same for the
// native scripts (their JSON form is the builder's `NativeScript`).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { bytesToHex } from "./bytes.js";
import { native, nativeScriptBytes, plutus, scriptHash, type NativeScript, type NativeScriptWitness, type PlutusScript, type PlutusVersion } from "./script.js";
import { hash224 } from "./blake2b.js";
import { concat } from "./bytes.js";

export interface RegistryEntry {
  name?: string;
  plutusVersion: string | number;
  purposes?: string[];
  /** single-wrapped script bytes (hex): CBOR byte string around the flat program */
  cborHex: string;
  flatHex?: string;
  hash?: string;
  sizeBytes?: number;
  source?: string;
  [key: string]: unknown;
}

export interface NativeEntry {
  name: string;
  json: NativeScript;
  cborHex: string;
  hash: string;
  sizeBytes?: number;
  notes?: string;
}

export interface RegistryFile {
  schema?: number;
  scripts: Record<string, RegistryEntry>;
  native?: NativeEntry[];
  keys?: Record<string, { label: string; keyHash: string; note?: string }>;
  [key: string]: unknown;
}

const REGISTRY_PATH = fileURLToPath(new URL("../scripts.json", import.meta.url));

let cached: RegistryFile | undefined;

export function hasRegistry(): boolean {
  return existsSync(REGISTRY_PATH);
}

/** The registry file (`{schema, scripts: {name: entry}, native: [...], keys}`); a bare `{name: entry}` map is accepted too. */
export function loadRegistry(): RegistryFile {
  if (!cached) {
    if (!existsSync(REGISTRY_PATH)) throw new Error(`script registry ${REGISTRY_PATH} does not exist yet (run npm run fixtures:compile)`);
    const json = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as RegistryFile | Record<string, RegistryEntry>;
    cached = "scripts" in json && typeof json.scripts === "object" ? (json as RegistryFile) : { scripts: json as Record<string, RegistryEntry> };
  }
  return cached;
}

export function versionOf(entry: RegistryEntry): PlutusVersion {
  const m = /([123])/.exec(String(entry.plutusVersion));
  if (!m) throw new Error(`registry entry has no Plutus version: ${String(entry.plutusVersion)}`);
  return Number(m[1]) as PlutusVersion;
}

/** The registered Plutus script `name` as a builder script (hash verified when the entry carries one). */
export function registryScript(name: string): PlutusScript {
  const reg = loadRegistry().scripts;
  const entry = reg[name];
  if (!entry) throw new Error(`no script named ${name} in the registry (have: ${Object.keys(reg).join(", ")})`);
  const script = plutus(versionOf(entry), entry.cborHex);
  const actual = scriptHash(script);
  if (entry.hash && entry.hash.toLowerCase() !== actual) throw new Error(`registry script ${name}: hash ${entry.hash} does not match its bytes (${actual})`);
  return script;
}

/** The registered native script `name`. */
export function registryNative(name: string): NativeScriptWitness {
  const list = loadRegistry().native ?? [];
  const entry = list.find((e) => e.name === name);
  if (!entry) throw new Error(`no native script named ${name} in the registry (have: ${list.map((e) => e.name).join(", ")})`);
  const script = native(entry.json);
  const actual = hash224(concat([0], nativeScriptBytes(entry.json)));
  if (entry.hash.toLowerCase() !== actual) throw new Error(`native script ${name}: hash ${entry.hash} does not match its structure (${actual})`);
  return script;
}

export const registryHash = (name: string): string => scriptHash(registryScript(name));
export const registryBytesHex = (name: string): string => bytesToHex(registryScript(name).bytes);
