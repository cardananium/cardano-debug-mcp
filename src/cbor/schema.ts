// Schema information the tools share: validity (`validate_cddl`), the outline, the root rules and
// the kinds each root admits — computed once per schema text through the lib worker and cached
// (the era presets are the hot path; a user schema is cached by content hash).

import { createHash } from "node:crypto";

import { ruleRootKinds } from "@cardananium/cquisitor-lib/cddl/rootKinds";
import { declaredRuleNames, isParameterisedRule, rootRuleNames } from "@cardananium/cquisitor-lib/cddl/ruleSelection";
import type { CddlOutlineEntry, CddlValidationResult } from "@cardananium/cquisitor-lib";

import type { LibApi } from "../lib.js";
import type { SchemaSource } from "./presets.js";

export interface SchemaInfo {
  source: SchemaSource;
  validation: CddlValidationResult;
  /** Empty when the text does not parse. */
  outline: CddlOutlineEntry[];
  /** Type rules without generic parameters: the valid validation roots, declaration order. */
  roots: string[];
  /** Every declared name (groups and generics included), deduplicated. */
  declared: string[];
  /** Generic rules (`set<a0>`), which cannot be roots. */
  parameterised: string[];
  /** Group rules (`g = ( … )`). */
  groups: string[];
}

const CACHE_CAP = 8;
const cache = new Map<string, Promise<SchemaInfo>>();

export function schemaKey(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** Outline + roots + validity of a schema, cached per text. Never throws for an unparsable schema (outline empty). */
export function loadSchemaInfo(lib: LibApi, source: SchemaSource): Promise<SchemaInfo> {
  const key = schemaKey(source.text);
  const hit = cache.get(key);
  if (hit) return hit.then((info) => (info.source.label === source.label ? info : { ...info, source }));
  const pending = (async (): Promise<SchemaInfo> => {
    const validation = await lib.validateCddl(source.text);
    let outline: CddlOutlineEntry[] = [];
    if (validation.valid || (validation.error.kind !== "parse_error" && validation.error.kind !== "nesting_too_deep")) {
      try {
        outline = await lib.cddlOutline(source.text);
      } catch {
        outline = [];
      }
    }
    const text = source.text;
    return {
      source,
      validation,
      outline,
      roots: rootRuleNames(outline, text),
      declared: declaredRuleNames(outline),
      parameterised: dedupe(outline.filter((e) => e.kind === "type" && isParameterisedRule(e, text)).map((e) => e.name)),
      groups: dedupe(outline.filter((e) => e.kind === "group").map((e) => e.name)),
    };
  })();
  pending.catch(() => cache.delete(key));
  if (cache.size >= CACHE_CAP) cache.delete(cache.keys().next().value!);
  cache.set(key, pending);
  return pending;
}

function dedupe(names: string[]): string[] {
  return Array.from(new Set(names));
}

/** Rule names similar to `query` (contains either way), for `missing_rule` recoveries. */
export function similarRules(names: readonly string[], query: string, limit = 12): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const exact = names.filter((n) => n.toLowerCase() === needle);
  const prefix = names.filter((n) => n.toLowerCase().startsWith(needle) && !exact.includes(n));
  const contains = names.filter((n) => (n.toLowerCase().includes(needle) || needle.includes(n.toLowerCase())) && !exact.includes(n) && !prefix.includes(n));
  return [...exact, ...prefix, ...contains].slice(0, limit);
}

/** Root rules grouped by the CBOR root kind they admit (`array`, `map`, `bytes`, `tag:258`, …; `any` when the schema does not settle it). */
export function rootsByKind(info: SchemaInfo): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const rule of info.roots) {
    const kinds = ruleRootKinds(rule, info.outline, info.source.text);
    for (const kind of kinds && kinds.length > 0 ? kinds : ["any"]) (groups[kind] ??= []).push(rule);
  }
  return groups;
}

/** Resolve a user-typed rule name against the schema (exact, then case-insensitive); undefined when absent. */
export function resolveRuleName(info: SchemaInfo, rule: string): string | undefined {
  const trimmed = rule.trim();
  return info.declared.find((n) => n === trimmed) ?? info.declared.find((n) => n.toLowerCase() === trimmed.toLowerCase());
}
