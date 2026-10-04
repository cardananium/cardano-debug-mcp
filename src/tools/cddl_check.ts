// cddl_check: is a CDDL schema usable? Parse / resolution errors with line, column and snippet
// (every unresolved name), the outline (root rules grouped by the CBOR root kind they admit,
// groups, generic rules), the definition and uses of one rule, and the formatted schema (windowed).

import type { McpServer } from "@modelcontextprotocol/server";
import type { CddlReferencesResult } from "@cardananium/cquisitor-lib";
import { ruleRootKinds } from "@cardananium/cquisitor-lib/cddl/rootKinds";
import * as z from "zod/v4";

import { cddlFragment, lineColOf } from "../cbor/arithmetic.js";
import { shapeSchemaError } from "../cbor/diagnostics.js";
import { resolveSchemaInput, type SchemaSource } from "../cbor/presets.js";
import { loadSchemaInfo, resolveRuleName, rootsByKind, similarRules, type SchemaInfo } from "../cbor/schema.js";
import type { AppContext, ToolModule } from "../context.js";
import { WorkerCallError } from "../workers/rpc.js";
import { cddlResourceLink } from "./cbor_validate.js";
import { capString, clampInt, fail, failFromError, ok, type ToolResult } from "./_shared.js";
import { TOOL_TEXT } from "./descriptions.js";

const T = TOOL_TEXT.cddl_check;

export const CDDL_CHECK_FORMAT_LINES = 200;
export const CDDL_CHECK_FORMAT_MAX_LINES = 1_000;
export const CDDL_CHECK_FORMAT_CHARS = 16_000;
export const CDDL_CHECK_USES = 50;
export const CDDL_CHECK_DEFINITION_CHARS = 600;
/** Names listed per outline list (a root kind, the groups, the generic rules); the rest is counted. */
export const CDDL_CHECK_OUTLINE_NAMES = 100;

/** RFC 8610 prelude names: no schema defines them, so a rule lookup of one is not a typo. */
const PRELUDE_NAMES: ReadonlySet<string> = new Set([
  "any", "uint", "nint", "int", "bstr", "bytes", "tstr", "text", "bool", "true", "false", "nil", "null", "undefined", "float", "float16", "float32", "float64",
  "float16-32", "float32-64", "number", "integer", "unsigned", "tdate", "time", "uri", "b64url", "b64legacy", "regexp", "mime-message", "cbor-any", "encoded-cbor",
  "eb64url", "eb64legacy", "eb16", "biguint", "bignint", "bigint", "decfrac", "bigfloat",
]);

const inputSchema = z.object({
  cddl: z.string().min(1).describe(T.params["cddl"]),
  rule: z.string().optional().describe(T.params["rule"]),
  format: z.boolean().optional().describe(T.params["format"]),
  offset: z.number().int().min(0).optional().describe(T.params["offset"]),
  limit: z.number().int().min(1).max(CDDL_CHECK_FORMAT_MAX_LINES).optional().describe(T.params["limit"]),
});

export type CddlCheckArgs = z.infer<typeof inputSchema>;

function schemaBlock(source: SchemaSource): Record<string, unknown> {
  const block: Record<string, unknown> = { source: source.label, chars: source.text.length, lines: source.text === "" ? 0 : source.text.split("\n").length };
  if (source.era) block.era = source.era;
  if (source.path) block.path = source.path;
  return block;
}

/** `names` cut to `CDDL_CHECK_OUTLINE_NAMES`; the omitted count is reported beside the list. */
function cutNames(names: readonly string[]): { names: string[]; omitted: number } {
  return names.length <= CDDL_CHECK_OUTLINE_NAMES ? { names: [...names], omitted: 0 } : { names: names.slice(0, CDDL_CHECK_OUTLINE_NAMES), omitted: names.length - CDDL_CHECK_OUTLINE_NAMES };
}

function outlineBlock(info: SchemaInfo): Record<string, unknown> {
  const byKind: Record<string, string[]> = {};
  const kindsOmitted: Record<string, number> = {};
  for (const [kind, rules] of Object.entries(rootsByKind(info))) {
    const cut = cutNames(rules);
    byKind[kind] = cut.names;
    if (cut.omitted > 0) kindsOmitted[kind] = cut.omitted;
  }
  const groups = cutNames(info.groups);
  const generic = cutNames(info.parameterised);
  return {
    rules: info.declared.length,
    roots: info.roots.length,
    roots_by_kind: byKind,
    ...(Object.keys(kindsOmitted).length > 0 ? { roots_by_kind_omitted: kindsOmitted } : {}),
    groups: groups.names,
    ...(groups.omitted > 0 ? { groups_omitted: groups.omitted } : {}),
    parameterised: generic.names,
    ...(generic.omitted > 0 ? { parameterised_omitted: generic.omitted } : {}),
  };
}

async function referencesBlock(ctx: AppContext, info: SchemaInfo, ruleArg: string): Promise<{ block?: Record<string, unknown>; failure?: ToolResult }> {
  const text = info.source.text;
  const resolved = resolveRuleName(info, ruleArg) ?? ruleArg.trim();
  let refs: CddlReferencesResult;
  try {
    refs = await ctx.lib.cddlReferences(text, resolved);
  } catch (error) {
    if (error instanceof WorkerCallError && !error.fatal) return { block: { rule: resolved, note: `cddl_references could not run: ${error.message}` } };
    throw error;
  }
  if (!refs.definition && refs.uses.length === 0 && PRELUDE_NAMES.has(resolved)) {
    return { block: { rule: resolved, declared: false, kind: "prelude", is_root: false, definition: null, uses: [], uses_total: 0, note: `'${resolved}' is an RFC 8610 prelude type: no schema defines it, and ${info.source.label} does not use it.` } };
  }
  if (!refs.definition && refs.uses.length === 0) {
    const suggestions = similarRules(info.declared, ruleArg);
    return {
      failure: fail({
        code: "invalid_argument",
        argument: "rule",
        schema: schemaBlock(info.source),
        suggestions,
        message: `${info.source.label} neither defines nor uses a rule named '${ruleArg.trim()}'.${suggestions.length ? ` Similar: ${suggestions.join(", ")}.` : ""}`,
      }),
    };
  }
  const entry = info.outline.find((e) => e.name === resolved && !e.is_alternate) ?? info.outline.find((e) => e.name === resolved);
  const definitionText = entry ? cddlFragment(text, entry.span, CDDL_CHECK_DEFINITION_CHARS) : null;
  const kinds = info.roots.includes(resolved) ? ruleRootKinds(resolved, info.outline, text) : null;
  const uses = refs.uses.map((u) => {
    const pos = lineColOf(text, u.char_offset);
    return { line: pos.line, col: pos.col };
  });
  const block: Record<string, unknown> = {
    rule: resolved,
    declared: Boolean(refs.definition),
    kind: entry ? entry.kind : info.declared.includes(resolved) ? "type" : PRELUDE_NAMES.has(resolved) ? "prelude" : "undefined",
    is_root: info.roots.includes(resolved),
    ...(info.parameterised.includes(resolved) ? { generic: true } : {}),
    root_kinds: info.roots.includes(resolved) ? (kinds && kinds.length > 0 ? kinds : ["any"]) : undefined,
    alternates: info.outline.filter((e) => e.name === resolved && e.is_alternate).length || undefined,
    definition: refs.definition ? { line: refs.definition.line, col: lineColOf(text, refs.definition.char_offset).col, text: definitionText?.text ?? null } : null,
    uses: uses.slice(0, CDDL_CHECK_USES),
    uses_total: uses.length,
  };
  if (!refs.definition) block.note = PRELUDE_NAMES.has(resolved) ? `'${resolved}' is an RFC 8610 prelude type: no schema defines it.` : "No rule defines this name: an unresolved reference, so the schema is not usable until it is defined.";
  return { block };
}

export async function cddlCheck(ctx: AppContext, args: CddlCheckArgs): Promise<ToolResult> {
  let source: SchemaSource;
  try {
    source = resolveSchemaInput(args.cddl);
  } catch (error) {
    return failFromError(error, "invalid_argument");
  }
  const link = cddlResourceLink(source);
  const links = link ? [link] : [];
  try {
    const info = await loadSchemaInfo(ctx.lib, source);
    const base: Record<string, unknown> = { valid: info.validation.valid, schema: schemaBlock(source) };
    if (!info.validation.valid) {
      const error = shapeSchemaError(info.validation.error, source.text);
      base.error = error;
      base.verdict = `The schema is not usable: ${error.kind}${error.line ? ` at line ${error.line}:${error.col}` : ""} — ${error.message}${error.unresolved.length ? ` (${error.unresolved.length} unresolved name${error.unresolved.length === 1 ? "" : "s"}${error.unresolved_truncated ? ", list truncated" : ""})` : ""}.`;
    } else {
      base.verdict = `The schema parses and every reference resolves: ${info.declared.length} rules, ${info.roots.length} usable roots${info.groups.length ? `, ${info.groups.length} groups` : ""}${info.parameterised.length ? `, ${info.parameterised.length} generic` : ""}.`;
    }
    base.outline = outlineBlock(info);

    if (args.rule !== undefined && args.rule.trim() !== "") {
      if (info.outline.length === 0) {
        base.references = { rule: args.rule.trim(), note: "The schema does not parse, so references cannot be resolved; fix the error above first." };
      } else {
        const refs = await referencesBlock(ctx, info, args.rule);
        if (refs.failure) return refs.failure;
        base.references = refs.block;
      }
    }

    if (args.format) {
      if (info.outline.length === 0 && !info.validation.valid) {
        base.formatted = { note: "The schema does not parse; cddl_format needs a parsable document." };
      } else {
        try {
          const formatted = await ctx.lib.cddlFormat(source.text);
          const lines = formatted.split("\n");
          const limit = clampInt(args.limit, CDDL_CHECK_FORMAT_LINES, 1, CDDL_CHECK_FORMAT_MAX_LINES);
          const offset = Math.max(0, Math.trunc(args.offset ?? 0));
          if (offset >= lines.length) {
            base.formatted = { text: "", offset, limit, lines_returned: 0, total_lines: lines.length, note: `offset ${offset} is past the last line: the formatted schema has ${lines.length} lines (0-based offsets 0..${lines.length - 1})` };
          } else {
            // whole lines only, so next_offset continues exactly where the text stops (the first line is always taken)
            const window = lines.slice(offset, offset + limit);
            let kept = 0;
            let chars = 0;
            for (const line of window) {
              const size = line.length + 1;
              if (kept > 0 && chars + size > CDDL_CHECK_FORMAT_CHARS) break;
              chars += size;
              kept++;
            }
            const joined = window.slice(0, kept).join("\n");
            const text = capString(joined, CDDL_CHECK_FORMAT_CHARS);
            base.formatted = {
              text,
              offset,
              limit,
              lines_returned: kept,
              total_lines: lines.length,
              ...(offset + kept < lines.length ? { next_offset: offset + kept } : {}),
              ...(kept < window.length ? { truncated: true, note: `the window was cut at ${CDDL_CHECK_FORMAT_CHARS.toLocaleString("en-US")} characters after ${kept} lines; continue with offset=${offset + kept}` } : text.length < joined.length ? { truncated: true, note: "the first line alone passes the character cap and is cut" } : {}),
            };
          }
        } catch (error) {
          if (!(error instanceof WorkerCallError) || error.fatal) throw error;
          base.formatted = { note: `cddl_format failed: ${error.message}` };
        }
      }
    }
    return ok(base, { links });
  } catch (error) {
    return failFromError(error, "internal_error", { schema: schemaBlock(source) });
  }
}

export const cddlCheckTool: ToolModule = {
  name: "cddl_check",
  register(server: McpServer, ctx: AppContext) {
    server.registerTool(
      "cddl_check",
      {
        title: T.title,
        description: T.description,
        inputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args) => cddlCheck(ctx, args),
    );
  },
};
