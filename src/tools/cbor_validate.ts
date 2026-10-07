// cbor_validate: validate CBOR bytes against a CDDL schema (an era preset, an inline schema or a
// .cddl file) and say what is wrong and where — structural decoder errors with byte offsets,
// schema mismatches with path / expected / hex excerpt / schema fragment, encoding oddities and
// pattern-based hints. Without `rule` the tool decodes the root, computes the root rules that admit
// its kind and validates against the candidates (well-known roots first, capped), reporting the
// first valid one or the candidate whose head mismatch sits deepest.

import type { McpServer } from "@modelcontextprotocol/server";
import type { CborDecodeResult, CborValidationErrorInfo } from "@cardananium/cquisitor-lib";
import { abbreviatePath, isImplementationLimit } from "@cardananium/cquisitor-lib/cddl/cddlError";
import { CBOR_WALKER_DEPTH_LIMIT } from "@cardananium/cquisitor-lib/util";
import * as z from "zod/v4";

import { cddlFragment } from "../cbor/arithmetic.js";
import { CANDIDATE_CAP } from "../cbor/candidates.js";
import { shapeSchemaError, shapeStructuralError, shapeValidationErrors, type ErrorRow, type StructuralError } from "../cbor/diagnostics.js";
import { hintsFor } from "../cbor/hints.js";
import { resolveSchemaInput, type SchemaSource } from "../cbor/presets.js";
import { budgetJson, budgetRaw } from "../cbor/budget.js";
import { byteStringValues, collectOddities, compactRaw, describeRawNode, lookupRawPath, rawRootKind, type Oddity, type OddityRow } from "../cbor/rawTree.js";
import { loadSchemaInfo, resolveRuleName, similarRules, type SchemaInfo } from "../cbor/schema.js";
import { runValidation, type ValidationRun } from "../cbor/validate.js";
import type { AppContext, ToolModule } from "../context.js";
import { integersAsStrings } from "../tx/dataView.js";
import { showItCbor } from "../ui/showIt.js";
import { describeTextInput, inputNotes } from "./cbor_decode.js";
import { childKeys, clampInt, fail, failFromError, lookupPath, normalizeBytesInput, ok, parsePath, resourceLink, truncateArray, type ResourceLink, type ToolResult } from "./_shared.js";
import { TOOL_TEXT } from "./descriptions.js";

const T = TOOL_TEXT.cbor_validate;

export const CBOR_VALIDATE_DEFAULT_ERRORS = 10;
export const CBOR_VALIDATE_MAX_ERRORS = 50;
/** Levels inlined in `decoded` / `raw` when `depth` is omitted: as many as fit the window, up to the maximum a caller may ask for. */
export const CBOR_VALIDATE_DEFAULT_DEPTH = 8;
/** Character cap of the `decoded` (labelled JSON) and `raw` windows (each fitted breadth-first, whatever the depth). */
export const CBOR_VALIDATE_WINDOW_CHARS = 6_000;
export const CBOR_VALIDATE_ODDITIES = 16;

const inputSchema = z.object({
  hex: z.string().min(1).describe(T.params["hex"]),
  cddl: z.string().optional().describe(T.params["cddl"]),
  rule: z
    .string()
    .optional()
    .describe(T.params["rule"]),
  max_errors: z.number().int().min(1).max(CBOR_VALIDATE_MAX_ERRORS).optional().describe(T.params["max_errors"]),
  decode: z.boolean().optional().describe(T.params["decode"]),
  include_raw: z.boolean().optional().describe(T.params["include_raw"]),
  path: z.string().optional().describe(T.params["path"]),
  raw_path: z.string().optional().describe(T.params["raw_path"]),
  depth: z.number().int().min(1).max(8).optional().describe(T.params["depth"]),
});

export type CborValidateArgs = z.infer<typeof inputSchema>;

// ---------- helpers ----------

export function cddlResourceLink(source: SchemaSource): ResourceLink | undefined {
  return source.era ? resourceLink(`cardano-debug://cddl/${source.era}`, `${source.era} CDDL`, "text/plain", `The bundled ${source.era} era CDDL (accepts ?offset=<line>&limit=<lines>)`) : undefined;
}

function schemaBlock(info: SchemaInfo, run: ValidationRun | null): Record<string, unknown> {
  // `rules` = every declared name, `roots` = the usable validation roots (same meaning as cddl_check's outline)
  const block: Record<string, unknown> = { source: info.source.label, rules: info.declared.length, roots: info.roots.length };
  if (info.source.era) block.era = info.source.era;
  if (info.source.path) block.path = info.source.path;
  if (run) {
    block.rule = run.rule;
    block.rule_picked = run.auto;
    if (run.auto) block.admissible_roots = run.admitted;
    block.candidates = run.candidates;
    if (run.untried > 0) block.untried_candidates = run.untried;
  }
  return block;
}

type View = "decoded" | "raw";

/** A `$…` path (the CBOR path grammar of validator errors and `cbor_decode(as='spans')`) rather than a JSON pointer. */
const isCborPath = (path: string | undefined): path is string => path !== undefined && path.trim().startsWith("$");

const windowNote = `cut to the ${CBOR_VALIDATE_WINDOW_CHARS.toLocaleString("en-US")}-character window, breadth-first (deeper nodes folded): zoom with path / raw_path, or read the whole tree with cbor_decode(as='raw' | 'spans')`;

/** `value` (a labelled-JSON tree, or the compact positional tree) fitted into one window. */
function fitWindow(view: View, value: unknown, depth: number, path?: string): Record<string, unknown> {
  const capped = view === "raw" ? budgetRaw(value, depth, CBOR_VALIDATE_WINDOW_CHARS) : budgetJson(value, depth, CBOR_VALIDATE_WINDOW_CHARS);
  return { ...(path !== undefined ? { path } : {}), value: capped.value, depth: capped.depth, truncated: capped.truncated || undefined, ...(capped.truncated ? { note: windowNote } : {}) };
}

/** Where a JSON pointer / dotted path resolves in `value` (a window, or null when it does not). */
function pointerWindow(view: View, value: unknown, path: string, depth: number): { window: Record<string, unknown> } | { miss: Record<string, unknown> } {
  const segments = parsePath(path);
  if (segments.length === 0) return { window: fitWindow(view, value, depth) };
  const lookup = lookupPath(value, segments);
  if (!lookup.found) {
    return {
      miss: {
        view,
        path_not_found: `/${segments.join("/")}`,
        resolved: `/${lookup.resolved.join("/")}`,
        available: lookup.available ?? childKeys(lookupPath(value, lookup.resolved).value),
      },
    };
  }
  return { window: fitWindow(view, lookup.value, depth, `/${segments.join("/")}`) };
}

/**
 * The `decoded` window: the CDDL-labelled JSON zoomed by `path` (a JSON pointer, `/transaction_body/2`).
 * A `$` path names an item of the bytes, so it belongs to the `raw` window: said, not reported as missing.
 */
function decodedWindow(value: unknown, args: { path?: string }, depth: number): Record<string, unknown> {
  if (isCborPath(args.path)) return { view: "decoded", skipped: `path ${JSON.stringify(args.path)} is a CBOR path ($ grammar): it zooms the raw view (include_raw); decoded takes a JSON pointer such as /transaction_body/2` };
  const hit = args.path === undefined ? { window: fitWindow("decoded", value, depth) } : pointerWindow("decoded", value, args.path, depth);
  return "window" in hit ? hit.window : hit.miss;
}

/**
 * The `raw` window: the compact positional tree zoomed by `raw_path`, else by `path` when that is a `$`
 * path or a pointer that resolves in the tree; a `path` that only the decoded view reads is said so
 * instead of being reported as missing.
 */
function rawWindow(root: unknown, args: { path?: string; raw_path?: string }, depth: number, decodedReadsPath: boolean): Record<string, unknown> {
  const requested = args.raw_path ?? args.path;
  if (requested === undefined || requested.trim() === "") return fitWindow("raw", compactRaw(root, [] as Oddity[]), depth);
  if (isCborPath(requested)) {
    const hit = lookupRawPath(root, requested.trim());
    if ("node" in hit) return fitWindow("raw", compactRaw(hit.node, [] as Oddity[]), depth, requested.trim());
    return { view: "raw", path_not_found: requested.trim(), resolved: hit.miss.resolved, available: hit.miss.available };
  }
  const hit = pointerWindow("raw", compactRaw(root, [] as Oddity[]), requested, depth);
  if ("window" in hit) return hit.window;
  if (args.raw_path === undefined && decodedReadsPath) return { view: "raw", skipped: `path ${JSON.stringify(requested)} reads the decoded view; pass raw_path ($[0][2], or a JSON pointer into the positional tree) to zoom raw` };
  return hit.miss;
}

function oddityBlock(root: unknown): { oddities?: OddityRow[]; oddities_total?: number; oddities_truncated_count?: number; rows: OddityRow[] } {
  const { rows, total } = collectOddities(root);
  if (total === 0) return { rows };
  const cut = truncateArray(rows, CBOR_VALIDATE_ODDITIES);
  return { oddities: cut.items, oddities_total: total, oddities_truncated_count: cut.truncated_count || undefined, rows };
}

const SCHEMA_ERROR_KINDS = new Set(["parse_error", "unresolved_references", "no_rules", "invalid_schema"]);

/** Human verdict for a failed run (the expected type is appended only when the message does not already state it). */
export function mismatchVerdict(rule: string, head: ErrorRow | undefined, shown: number, additional: number): string {
  const total = shown + additional;
  const where = head?.path ? ` at ${head.path_short ?? head.path}` : "";
  const offset = head?.byte_offset !== null && head?.byte_offset !== undefined ? ` (byte ${head.byte_offset})` : "";
  const message = head?.message ?? "";
  const expected = head?.expected && !/^expected /.test(message) ? `; expected ${head.expected.length > 80 ? `${head.expected.slice(0, 79)}…` : head.expected}` : "";
  return `The bytes do not match ${rule}: ${total} problem${total === 1 ? "" : "s"}; head ${head?.kind ?? "mismatch"}${where}${offset} — ${message}${expected}.`;
}

/** Hint-rule view of the error rows (`from_type_choice` and the schema fragment travel along). */
export function hintErrors(rows: ReadonlyArray<ErrorRow>): Array<{ kind: string; message: string; expected: string | null; path: string | null; from_type_choice?: boolean; cddl_fragment?: string | null }> {
  return rows.map((r) => ({ kind: r.kind, message: r.message, expected: r.expected, path: r.path, from_type_choice: r.from_type_choice === true, cddl_fragment: r.cddl_fragment }));
}

/** `valid: null` answer for a host-side depth limit (a JS stack overflow while shaping the library's answer). */
function hostLimitAnswer(base: Record<string, unknown>, error: RangeError, extra: Record<string, unknown> = {}, links: ResourceLink[] = []): ToolResult {
  return ok(
    {
      ...base,
      ...extra,
      valid: null,
      unexamined: { kind: "nesting_too_deep", message: `host limit: ${error.message} while shaping the answer (the library itself examines up to ${CBOR_WALKER_DEPTH_LIMIT} levels)` },
      verdict: "Not examined: the document nests deeper than this host can shape — the bytes were not judged invalid; inspect a smaller part (cbor_decode(as='raw', path=…) with a small depth).",
      errors: [],
      additional_count: 0,
      hints: ["Nesting is deeper than the host shapes (an implementation limit, not a verdict): validate a sub-item, or pass a slice of the bytes."],
    },
    { links },
  );
}

// ---------- the tool ----------

export async function cborValidate(ctx: AppContext, args: CborValidateArgs): Promise<ToolResult> {
  const maxErrors = clampInt(args.max_errors, CBOR_VALIDATE_DEFAULT_ERRORS, 1, CBOR_VALIDATE_MAX_ERRORS);
  const depth = clampInt(args.depth, CBOR_VALIDATE_DEFAULT_DEPTH, 1, 8);
  const normalized = normalizeBytesInput(args.hex);
  if (normalized.kind === "bech32" || normalized.kind === "text") {
    return fail({
      code: "invalid_argument",
      argument: "hex",
      input_kind: normalized.kind,
      message:
        normalized.kind === "bech32"
          ? "hex is a bech32 string, not CBOR bytes: cbor_decode(hex=<bech32>) decodes addresses / keys / hashes; to validate the address bytes against the `address` rule, pass their hex."
          : `hex must be hex, base64 or a cardano-cli JSON envelope; ${describeTextInput(args.hex)}`,
    });
  }
  const hex = normalized.value;
  const notes = inputNotes(args.hex, normalized.kind);
  const base: Record<string, unknown> = { input_kind: normalized.kind, input_bytes: hex.length / 2, ...(notes.length ? { input_notes: notes } : {}) };

  let source: SchemaSource;
  try {
    source = resolveSchemaInput(args.cddl);
  } catch (error) {
    return failFromError(error, "invalid_argument", base);
  }
  const link = cddlResourceLink(source);
  const links = link ? [link] : [];

  try {
    const info = await loadSchemaInfo(ctx.lib, source);
    if (!info.validation.valid) {
      const schemaError = shapeSchemaError(info.validation.error, source.text);
      return fail({
        ...base,
        code: "invalid_schema",
        schema: schemaBlock(info, null),
        error: schemaError,
        message: `The schema (${source.label}) is not usable: ${schemaError.kind}${schemaError.line ? ` at line ${schemaError.line}:${schemaError.col}` : ""} — ${schemaError.message}. Fix it (cddl_check gives every unresolved name) and retry.`,
      });
    }

    // explicit rule: resolve it against the schema before spending a validation run
    let rule: string | undefined;
    if (args.rule !== undefined && args.rule.trim() !== "") {
      const resolved = resolveRuleName(info, args.rule);
      if (!resolved) {
        const suggestions = similarRules(info.declared, args.rule);
        return fail({
          ...base,
          code: "invalid_argument",
          argument: "rule",
          schema: schemaBlock(info, null),
          suggestions,
          message: `${source.label} declares no rule named '${args.rule.trim()}'.${suggestions.length ? ` Similar: ${suggestions.join(", ")}.` : ""} Omit rule to let the tool pick candidates, or cddl_check(cddl) for the full outline.`,
        });
      }
      if (info.groups.includes(resolved) && !info.roots.includes(resolved)) {
        return fail({ ...base, code: "invalid_argument", argument: "rule", schema: schemaBlock(info, null), message: `'${resolved}' is a group rule ( … ): it describes entries inside a container, not a standalone item. Validate against the type rule that uses it.` });
      }
      if (info.parameterised.includes(resolved)) {
        return fail({ ...base, code: "invalid_argument", argument: "rule", schema: schemaBlock(info, null), message: `'${resolved}' is a generic rule (${resolved}<…>): its parameters are unbound outside a use site, so it cannot be a root. Pick a rule that instantiates it.` });
      }
      rule = resolved;
    }

    // structural decode first: malformed bytes need no schema run
    const raw = await ctx.lib.cborToJson<CborDecodeResult>(hex);
    if (!raw.ok) {
      const structural: StructuralError = shapeStructuralError(raw.error, raw.partial, hex);
      const odd = oddityBlock(raw.partial);
      const unexamined = raw.error.kind === "nesting_too_deep";
      const hints = hintsFor({ structural: raw.error, oddities: odd.rows, inputBytes: hex.length / 2, byteStrings: byteStringValues(raw.partial), era: source.era ?? null });
      const at = structural.offset !== null ? ` at byte ${structural.offset}` : "";
      return ok(
        {
          ...base,
          schema: schemaBlock(info, rule ? { rule, candidates: [], result: null, auto: false, admitted: 0, untried: 0 } : null),
          valid: unexamined ? null : false,
          ...(unexamined ? { unexamined: { kind: raw.error.kind, message: raw.error.message } } : { show_it: showItCbor({ offset: structural.offset, length: 1 }) }),
          verdict: unexamined
            ? `Not examined: the decoder stopped at its nesting limit${at} — the bytes were not judged invalid.`
            : `The bytes are not well-formed CBOR: ${raw.error.kind}${at} — ${raw.error.message}${structural.partial_summary ? ` (decoded so far: ${structural.partial_summary})` : ""}.`,
          structural_error: structural,
          errors: [],
          additional_count: 0,
          oddities: odd.oddities,
          oddities_total: odd.oddities_total,
          oddities_truncated_count: odd.oddities_truncated_count,
          hints,
          ...(args.include_raw && raw.partial !== undefined ? { raw: rawWindow(raw.partial, args, depth, false), raw_partial: true } : {}),
        },
        { links },
      );
    }

    const rootKind = rawRootKind(raw.value);
    const rootSummary = describeRawNode(raw.value);
    const odd = oddityBlock(raw.value);
    const run = await runValidation(ctx.lib, hex, info, rule, rootKind, CANDIDATE_CAP, undefined, raw.value);
    const common = { ...base, root: rootSummary, root_kind: rootKind, schema: schemaBlock(info, run) };
    const hintBase = { oddities: odd.rows, rootKind, byteStrings: byteStringValues(raw.value), era: source.era ?? null, rule: run.rule, inputBytes: hex.length / 2 };
    const oddOut = { oddities: odd.oddities, oddities_total: odd.oddities_total, oddities_truncated_count: odd.oddities_truncated_count };

    if (!run.rule || !run.result) {
      return ok(
        {
          ...common,
          valid: false,
          verdict: `No root rule of ${source.label} admits a ${rootKind ?? "document of this kind"} at the root (${rootSummary}).`,
          errors: [],
          additional_count: 0,
          ...oddOut,
          hints: hintsFor({ ...hintBase, candidates: { tried: 0, anyValid: false } }),
        },
        { links },
      );
    }

    const candidates = run.auto ? { tried: run.candidates.length, anyValid: run.candidates.some((c) => c.valid) } : undefined;
    const decodedBlock = async (): Promise<Record<string, unknown>> => {
      if (args.decode === false || !run.rule) return {};
      try {
        const decoded = await ctx.lib.decodeAgainstCddl<{ ok: boolean; value?: unknown; error?: { kind?: string; message?: string } }>(hex, source.text, run.rule);
        if (!decoded.ok) return { decoded_note: `decode_cbor_against_cddl did not produce a labelled tree: ${decoded.error?.message ?? decoded.error?.kind ?? "no value"}` };
        return { decoded: decodedWindow(integersAsStrings(decoded.value), args, depth) };
      } catch (error) {
        return { decoded_note: `decode_cbor_against_cddl failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    };
    /** `decoded` (when asked for) then `raw`, in answer order: the raw window knows whether the decoded one read the path. */
    const viewBlocks = async (): Promise<Record<string, unknown>> => {
      const decodedPart = await decodedBlock();
      const decodedWindowOut = decodedPart.decoded as Record<string, unknown> | undefined;
      const decodedRead = decodedWindowOut !== undefined && !("path_not_found" in decodedWindowOut) && !("skipped" in decodedWindowOut);
      return { ...decodedPart, ...(args.include_raw ? { raw: rawWindow(raw.value, args, depth, decodedRead) } : {}) };
    };

    if (run.result.valid) {
      return ok(
        {
          ...common,
          valid: true,
          verdict: `The bytes are a valid ${run.rule} under ${source.label}${run.auto ? ` (rule picked: ${run.candidates.length} of ${run.admitted} admissible root${run.admitted === 1 ? "" : "s"} tried)` : ""}.`,
          errors: [],
          additional_count: 0,
          ...oddOut,
          hints: hintsFor({ ...hintBase, errors: [], candidates }),
          ...(await viewBlocks()),
        },
        { links },
      );
    }

    const error: CborValidationErrorInfo = run.result.error;
    if (isImplementationLimit(error.kind)) {
      const failed = run.auto ? run.candidates.filter((c) => !c.valid && !c.unexamined) : [];
      const others = failed.length > 0
        ? ` ${failed.length} other candidate${failed.length === 1 ? "" : "s"} failed (${failed.slice(0, 3).map((c) => c.rule).join(", ")}${failed.length > 3 ? ", …" : ""}), but ${run.rule} may be the valid reading, so there is no verdict.`
        : "";
      return ok(
        {
          ...common,
          valid: null,
          unexamined: { kind: error.kind, message: error.message, ...(error.path ? { path: abbreviatePath(error.path) } : {}) },
          verdict: `Not examined: the validator stopped at an implementation limit (${error.kind}) while checking ${run.rule} — the bytes were not judged invalid.${others}`,
          errors: [],
          additional_count: 0,
          ...oddOut,
          hints: hintsFor({ ...hintBase, errors: [{ kind: error.kind, message: error.message, expected: null, path: error.path ?? null }], candidates }),
          ...(args.include_raw ? { raw: rawWindow(raw.value, args, depth, false) } : {}),
        },
        { links },
      );
    }
    if (SCHEMA_ERROR_KINDS.has(error.kind)) {
      const fragment = cddlFragment(source.text, error.cddl_byte_span);
      return fail({
        ...common,
        code: "invalid_schema",
        error: { kind: error.kind, message: error.message, cddl_fragment: fragment?.text ?? null, cddl_line: fragment?.line ?? null },
        message: `The schema (${source.label}) is not usable at rule ${run.rule}: ${error.kind} — ${error.message}. Run cddl_check(cddl) for the location.`,
      });
    }
    if (error.kind === "missing_rule" || error.kind === "group_rule_root") {
      return fail({ ...common, code: "invalid_argument", argument: "rule", message: `${error.kind}: ${error.message}` });
    }

    const shaped = shapeValidationErrors(error, hex, source.text, maxErrors, undefined, raw.value);
    const head = shaped.errors[0];
    const hints = hintsFor({ ...hintBase, errors: hintErrors(shaped.errors), candidates });
    return ok(
      {
        ...common,
        valid: false,
        verdict: mismatchVerdict(run.rule, head, shaped.errors.length, shaped.additional_count),
        show_it: showItCbor({ offset: head?.byte_offset, length: head?.byte_length, path: head?.path }),
        errors: shaped.errors,
        additional_count: shaped.additional_count,
        ...oddOut,
        hints,
        ...(await viewBlocks()),
      },
      { links },
    );
  } catch (error) {
    if (error instanceof RangeError) return hostLimitAnswer(base, error, {}, links);
    return failFromError(error, "internal_error", base);
  }
}

export const cborValidateTool: ToolModule = {
  name: "cbor_validate",
  register(server: McpServer, ctx: AppContext) {
    server.registerTool(
      "cbor_validate",
      {
        title: T.title,
        description: T.description,
        inputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args) => cborValidate(ctx, args),
    );
  },
};
