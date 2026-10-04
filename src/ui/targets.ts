// Target resolution for ui_link: the server holds the bytes, the decoded transaction, its validation,
// the session's term count and the cached pseudocode, so it can say whether a well-formed target of
// the caller points at something. A target that does not resolve is dropped with a reason and a hint
// of what does; one the server cannot check stays, and a note says so once. Only the caller's own
// annotations are resolved: generated ones come from the server's own answers.

import type { CborDecodeResult } from "@cardananium/cquisitor-lib";
import { joinCborPath, splitCborPath } from "@cardananium/cquisitor-lib/cddl/cborPath";

import { describeRawNode, keyLiteral, resolveRawNode, type RawNode } from "../cbor/rawTree.js";
import { similarRules } from "../cbor/schema.js";
import type { AppContext } from "../context.js";
import type { TxRecord } from "../store/txStore.js";
import { childKeys, lookupPath, parsePath } from "../tools/_shared.js";
import { libTagFromPurpose, parsePurpose } from "../vocab/purpose.js";
import type { AnyTarget, TargetResolver } from "./annotations.js";
import { indexedDiagnostics } from "./autoAnnotations.js";

/** Entries of an `available` hint. */
const AVAILABLE_MAX = 12;
const LIB_TAGS = ["Spend", "Mint", "Cert", "Reward", "Vote", "Propose"];

/** A note raised at most once per resolver, however many targets run into it. */
function onceNotes(notes: string[]): (text: string) => void {
  const seen = new Set<string>();
  return (text) => {
    if (seen.has(text)) return;
    seen.add(text);
    notes.push(text);
  };
}

/** The target kinds present in the caller's annotations (decides what a resolver has to load). */
export function ownKinds(own: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  for (const entry of own) {
    const target = entry !== null && typeof entry === "object" ? (entry as { target?: { kind?: unknown } }).target : undefined;
    if (target && typeof target.kind === "string") out.add(target.kind);
  }
  return out;
}

// ---------- transaction tab ----------

/** Dotted paths of the children of `value` below `prefix` (arrays as one `prefix.0..prefix.N` entry). */
function childPaths(prefix: readonly string[], value: unknown): string[] | undefined {
  const keys = childKeys(value, AVAILABLE_MAX);
  if (!keys) return undefined;
  const base = prefix.join(".");
  return keys.map((k) => (k.startsWith("0..") ? `${base}.0..${base}.${k.slice(3)}` : [base, k].filter(Boolean).join(".")));
}

export function txTargetResolver(record: TxRecord, notes: string[]): TargetResolver {
  const note = onceNotes(notes);
  let diagnostics: ReturnType<typeof indexedDiagnostics> | undefined;
  return (target) => {
    switch (target.kind) {
      case "tx_path": {
        const path = target.path.trim();
        if (path.startsWith("/")) return { drop: `tx_path is a dotted path (transaction.body.fee), not a JSON pointer: ${path}` };
        const segments = parsePath(path);
        if (segments[0] !== "transaction") return { drop: `tx_path starts at "transaction" (transaction.body.fee), not at ${JSON.stringify(segments[0] ?? path)}`, available: ["transaction.body", "transaction.witness_set", "transaction.auxiliary_data"] };
        const lookup = lookupPath(record.decoded, segments);
        if (lookup.found) return undefined;
        const at = lookup.resolved.length > 0 ? lookup.resolved.join(".") : "the root";
        return { drop: `tx_path ${path} is not in the decoded transaction (resolved up to ${at})`, available: childPaths(lookup.resolved, lookupPath(record.decoded, lookup.resolved).value) };
      }
      case "diagnostic": {
        if (!record.validation) {
          note("diagnostic targets are not checked: the transaction has not been validated here (tx_validate lists the diagnostics)");
          return undefined;
        }
        diagnostics ??= indexedDiagnostics(record);
        const total = diagnostics.length;
        if ("index" in target && target.index !== undefined) {
          if (target.index < total) return undefined;
          return {
            drop: total === 0 ? `diagnostic index ${target.index}: the validation reports no errors or warnings` : `diagnostic index ${target.index} is past the last diagnostic (${total}; errors phase 1, phase 2, then warnings)`,
            available: diagnostics.slice(0, AVAILABLE_MAX).map((d) => `${d.index}: ${d.name}`),
          };
        }
        const name = (target as { name: string }).name;
        const count = diagnostics.filter((d) => d.name === name).length;
        const occurrence = (target as { occurrence?: number }).occurrence ?? 0;
        if (count > occurrence) return undefined;
        const names = [...new Set(diagnostics.map((d) => d.name))].slice(0, AVAILABLE_MAX);
        return { drop: count === 0 ? `no diagnostic named ${name} in the validation` : `diagnostic ${name} occurs ${count} time(s); occurrence ${occurrence} does not exist`, available: names };
      }
      case "redeemer": {
        const purpose = parsePurpose(target.tag);
        if (!purpose) return { drop: `unknown redeemer tag ${JSON.stringify(target.tag)}`, available: LIB_TAGS };
        const tag = libTagFromPurpose(purpose);
        if (!record.redeemerTargets.some((t) => t.purpose === purpose && t.index === target.index)) {
          return { drop: `this transaction has no ${tag} redeemer with index ${target.index}`, available: record.redeemerTargets.map((t) => t.ref).slice(0, AVAILABLE_MAX) };
        }
        return tag === target.tag ? undefined : { target: { kind: "redeemer", tag, index: target.index } };
      }
      default:
        return undefined;
    }
  };
}

// ---------- CBOR / CDDL tabs ----------

export interface CborResolveInput {
  hex: string;
  /** Declared rule names of the CDDL tab's schema and its text length, when the tab has a schema. */
  schema?: { chars: number; rules?: readonly string[] };
  /** The positional tree (or the partial one of malformed bytes); undefined when none is available. */
  tree?: RawNode;
  /** True when `tree` is the partial tree of malformed bytes. */
  partial?: boolean;
}

/** The positional tree of `hex`, whole or partial; undefined when the library cannot give one. */
export async function loadTree(ctx: AppContext, hex: string): Promise<{ tree?: RawNode; partial: boolean }> {
  try {
    const raw = await ctx.lib.cborToJson<CborDecodeResult>(hex);
    if (raw.ok) return { tree: raw.value as unknown as RawNode, partial: false };
    return { tree: raw.partial as unknown as RawNode | undefined, partial: true };
  } catch {
    return { partial: false };
  }
}

/** The deepest prefix of `path` that resolves in `tree`, what is there and how to go on from it. */
function deepestResolved(tree: RawNode, path: string): { resolved_to: string; node: string; children?: string[] } {
  let segments: string[];
  try {
    segments = splitCborPath(path);
  } catch {
    segments = [];
  }
  let best = "$";
  for (let k = 1; k <= segments.length; k++) {
    const prefix = `$${segments.slice(0, k).map((s) => `[${s}]`).join("")}`;
    if (!resolveRawNode(tree, prefix)) break;
    best = prefix;
  }
  const node = resolveRawNode(tree, best) ?? tree;
  let children: string[] | undefined;
  if (node.type === "Map" && Array.isArray(node.values)) {
    children = (node.values as RawNode[])
      .map((e) => keyLiteral(e?.key))
      .filter((k): k is string => k !== null)
      .slice(0, AVAILABLE_MAX)
      .map((k) => (/^-?\d+$/.test(k) ? `${best}[${k}]` : joinCborPath(best, k.replace(/^"(.*)"$/, "$1"))));
  } else if (Array.isArray(node.values)) {
    const count = node.values.filter((v) => !(v !== null && typeof v === "object" && (v as RawNode).type === "Break")).length;
    children = count === 0 ? [] : [`${best}[0]..${best}[${count - 1}]`];
  }
  return { resolved_to: best, node: describeRawNode(node), ...(children ? { children } : {}) };
}

export function cborTargetResolver(input: CborResolveInput, notes: string[]): TargetResolver {
  const note = onceNotes(notes);
  const bytes = input.hex.length / 2;
  return (target: AnyTarget) => {
    switch (target.kind) {
      case "cbor_span": {
        if (target.offset + target.length <= bytes) return undefined;
        const room = Math.max(0, bytes - target.offset);
        return {
          drop: target.offset >= bytes ? `cbor_span offset ${target.offset} is past the end of the input (${bytes} bytes)` : `cbor_span ${target.offset}+${target.length} runs past the end of the input (${bytes} bytes)`,
          available: { input_bytes: bytes, ...(room > 0 ? { max_length_at_offset: room } : { last_offset: bytes - 1 }) },
        };
      }
      case "cbor_path": {
        if (!input.tree) {
          note("cbor_path targets are not checked: the bytes could not be decoded to a tree");
          return undefined;
        }
        if (resolveRawNode(input.tree, target.path)) return undefined;
        if (!target.path.trim().startsWith("$")) return { drop: `cbor_path starts at the root: $[0][2] or $.key, not ${JSON.stringify(target.path)}`, available: deepestResolved(input.tree, "$") };
        const where = deepestResolved(input.tree, target.path);
        return { drop: `cbor_path ${target.path} does not resolve${input.partial ? " in the decoded part of the malformed bytes" : ""}: nothing at the next segment after ${where.resolved_to} (${where.node})`, available: where };
      }
      case "cddl_range": {
        if (!input.schema) return undefined;
        if (target.end <= input.schema.chars) return undefined;
        return { drop: `cddl_range ${target.start}..${target.end} is past the end of the schema (${input.schema.chars} characters)`, available: { schema_chars: input.schema.chars } };
      }
      case "cddl_rule": {
        const rules = input.schema?.rules;
        if (!rules) return undefined;
        if (rules.includes(target.name)) return undefined;
        const exact = rules.find((r) => r.toLowerCase() === target.name.toLowerCase());
        if (exact) return { target: { kind: "cddl_rule", name: exact } };
        const similar = similarRules(rules, target.name, AVAILABLE_MAX);
        return { drop: `cddl_rule ${JSON.stringify(target.name)} is not declared in the schema`, available: similar.length > 0 ? similar : rules.slice(0, AVAILABLE_MAX) };
      }
      default:
        return undefined;
    }
  };
}

// ---------- de-uplc-web ----------

export interface ProgramShape {
  /** Nodes of the program: term ids are 0..terms-1. */
  terms?: number;
  /** Lines of the canonical UPLC listing. */
  lines?: number;
}

export function programTargetResolver(shape: ProgramShape, notes: string[]): TargetResolver {
  const note = onceNotes(notes);
  return (target) => {
    if (target.kind === "term") {
      if (shape.terms === undefined) {
        note("term targets are not checked: no debug session of this program is open (debug_open, then pass dbg_id)");
        return undefined;
      }
      if (target.term_id < shape.terms) return undefined;
      return { drop: `term_id ${target.term_id} is not a node of this program (0..${shape.terms - 1})`, available: { term_ids: `0..${shape.terms - 1}` } };
    }
    if (target.kind === "uplc_line") {
      if (shape.lines === undefined) {
        note("uplc_line targets are not checked: no debug session of this program is open (debug_open, then pass dbg_id)");
        return undefined;
      }
      if (target.line <= shape.lines) return undefined;
      return { drop: `uplc_line ${target.line} is outside the UPLC listing (1..${shape.lines})`, available: { lines: `1..${shape.lines}` } };
    }
    return undefined;
  };
}

/** pseudo_line targets against the line count of the cached script_decompile output (undefined: not decompiled yet). */
export function pseudocodeTargetResolver(lineCount: number | undefined, notes: string[]): TargetResolver {
  const note = onceNotes(notes);
  return (target) => {
    if (target.kind !== "pseudo_line") return undefined;
    if (lineCount === undefined) {
      note("pseudo_line targets are not checked: script_decompile has not produced this script's pseudocode with these options yet");
      return undefined;
    }
    const last = target.end_line ?? target.line;
    if (last <= lineCount) return undefined;
    return { drop: `pseudo_line ${target.line}${target.end_line !== undefined ? `-${target.end_line}` : ""} is past the end of the pseudocode (${lineCount} lines)`, available: { lines: `1..${lineCount}` } };
  };
}
