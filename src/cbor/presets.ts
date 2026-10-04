// Schema presets: the bundled era CDDL files (src/assets/cddl/<era>.cddl, attribution in
// src/assets/cddl/ATTRIBUTION.md) and the resolution of a tool's `cddl` argument to schema text —
// a preset name, an inline schema, or a path to a .cddl file on disk.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ToolInputError } from "../tools/_shared.js";
import { readAsset } from "../wasm-assets.js";

/** Era presets in the order the tools list them (newest mainnet era first). */
export const ERA_PRESETS = ["conway", "babbage", "alonzo", "mary", "allegra", "shelley", "dijkstra"] as const;
export type EraPreset = (typeof ERA_PRESETS)[number];
export const DEFAULT_ERA: EraPreset = "conway";

/** Largest schema file the `cddl` argument may point at (bytes). */
export const MAX_SCHEMA_FILE_BYTES = 4 * 1024 * 1024;

export function isEraPreset(name: unknown): name is EraPreset {
  return typeof name === "string" && (ERA_PRESETS as readonly string[]).includes(name);
}

const eraTexts = new Map<EraPreset, string>();

/** The bundled CDDL text of an era (read once per process). */
export function loadEraCddl(era: EraPreset): string {
  let text = eraTexts.get(era);
  if (text === undefined) {
    text = readAsset(path.join("cddl", `${era}.cddl`));
    eraTexts.set(era, text);
  }
  return text;
}

let attribution: { revision: string | null; text: string } | null = null;

/** The bundled attribution note and the ledger revision it names. */
export function cddlAttribution(): { revision: string | null; text: string } {
  if (!attribution) {
    let text = "";
    try {
      text = readAsset(path.join("cddl", "ATTRIBUTION.md"));
    } catch {
      text = "";
    }
    const match = /commit `([0-9a-f]{40})`/.exec(text);
    attribution = { revision: match ? match[1]! : null, text };
  }
  return attribution;
}

export type SchemaOrigin = "preset" | "inline" | "file";

export interface SchemaSource {
  origin: SchemaOrigin;
  /** `preset:<era>` | `inline` | `file:<path>` — what the tools report as `schema.source`. */
  label: string;
  era?: EraPreset;
  path?: string;
  text: string;
}

const PRESET_LIST = ERA_PRESETS.join(" | ");
/** File extensions the `cddl` argument may point at. */
export const SCHEMA_FILE_EXTENSION = /\.(cddl|txt)$/i;

/** A string that can only be a schema body: has a rule assignment, a newline or a CDDL comment. */
export function looksLikeCddlText(input: string): boolean {
  return /\r|\n/.test(input) || /^\s*;/.test(input) || /^[\s;]*[$A-Za-z_][\w$@.-]*\s*(\/\/=|\/=|=)/.test(input) || /=\s*[\[{(#"h']/.test(input);
}

function expandHome(p: string): string {
  return p.startsWith("~/") || p === "~" ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Resolve the `cddl` argument: omitted -> the Conway preset; an era name -> that preset; a schema
 * text (anything with a rule assignment / newline) -> inline; otherwise an absolute path to an
 * existing `.cddl` / `.txt` file (relative paths are refused: the server's cwd is not the caller's).
 * Throws `ToolInputError` (-> `invalid_argument`) for anything else.
 */
export function resolveSchemaInput(input: string | undefined, argument = "cddl"): SchemaSource {
  const trimmed = (input ?? "").trim();
  if (trimmed === "") return { origin: "preset", label: `preset:${DEFAULT_ERA}`, era: DEFAULT_ERA, text: loadEraCddl(DEFAULT_ERA) };
  const lowered = trimmed.toLowerCase();
  if (isEraPreset(lowered)) return { origin: "preset", label: `preset:${lowered}`, era: lowered, text: loadEraCddl(lowered) };
  if (looksLikeCddlText(trimmed)) return { origin: "inline", label: "inline", text: input!.replace(/\r\n/g, "\n") };
  if (trimmed.length <= 1024 && !/\s/.test(trimmed)) {
    const expanded = expandHome(trimmed);
    const looksLikePath = SCHEMA_FILE_EXTENSION.test(trimmed) || /[\\/]/.test(trimmed);
    if (looksLikePath && !path.isAbsolute(expanded)) {
      throw new ToolInputError(`${argument} names a relative path (${JSON.stringify(trimmed)}); the server's working directory is not the caller's, so pass an absolute path (or ~/…), the schema text itself, or a preset (${PRESET_LIST}).`, argument);
    }
    const candidate = path.resolve(expanded);
    if (looksLikePath && existsSync(candidate)) {
      // The extension rule applies to the file actually read: a *.cddl symlink to any other file is refused.
      const real = realpathSync(candidate);
      const stat = statSync(real);
      if (!stat.isFile()) throw new ToolInputError(`${candidate} is not a file. Pass a .cddl file, the schema text itself, or a preset (${PRESET_LIST}).`, argument);
      if (!SCHEMA_FILE_EXTENSION.test(candidate) || !SCHEMA_FILE_EXTENSION.test(real)) {
        throw new ToolInputError(
          `${candidate}${real !== candidate ? ` (a link to ${real})` : ""} is not a .cddl file (only .cddl / .txt files are read). Pass the schema text itself, or a preset (${PRESET_LIST}).`,
          argument,
        );
      }
      if (stat.size > MAX_SCHEMA_FILE_BYTES) throw new ToolInputError(`${candidate} is ${stat.size} bytes; schema files are capped at ${MAX_SCHEMA_FILE_BYTES} bytes.`, argument);
      return { origin: "file", label: `file:${candidate}`, path: candidate, text: readFileSync(real, "utf8").replace(/\r\n/g, "\n") };
    }
    if (SCHEMA_FILE_EXTENSION.test(trimmed)) throw new ToolInputError(`Schema file ${candidate} does not exist. Pass the schema text itself, an existing .cddl path, or a preset (${PRESET_LIST}).`, argument);
  }
  throw new ToolInputError(`${argument} must be a CDDL schema text, a path to a .cddl file, or an era preset (${PRESET_LIST}; default conway); ${JSON.stringify(trimmed.slice(0, 40))} is none of them.`, argument);
}
