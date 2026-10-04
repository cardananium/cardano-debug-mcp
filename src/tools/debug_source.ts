// debug_source: a numbered window of the session's canonical UPLC listing (one term per line; the
// line numbers are the `uplc_line` coordinates every debug_* tool reports and accepts), or, with
// `find`, the lines of that listing containing a constant / builtin name / string with their term ids.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AppContext, ToolModule } from "../context.js";
import type { SourceWindowOptions } from "../engine/protocol.js";
import { breakpointsOf, leaseSession, sessionErrorResult } from "./_debug.js";
import { clampInt, fail, jsonSizeOf, ok, type ToolResult } from "./_shared.js";
import { TOOL_TEXT } from "./descriptions.js";

const T = TOOL_TEXT.debug_source;

const DEFAULT_RADIUS = 20;
const MAX_RADIUS = 200;
const DEFAULT_MAX_CHARS = 12_000;
/** Ceiling of `max_chars`: the whole response has to stay under ~8k tokens (~30k chars). */
const MAX_MAX_CHARS = 24_000;
/** Budget of the serialised result; `lines` (with_ids) is trimmed to fit under it. */
const RESPONSE_CHARS = 30_000;
const DEFAULT_MATCHES = 20;
const MAX_MATCHES = 100;
/** Cap of the text shown per match (a context constant is one 5k+ character line). */
const EXCERPT_CHARS = 160;

const inputSchema = z.object({
  dbg_id: z.string().describe(T.params["dbg_id"]),
  around: z.union([z.literal("current"), z.number().int().min(0)]).optional().describe(T.params["around"]),
  line_from: z.number().int().min(1).optional().describe(T.params["line_from"]),
  line_to: z.number().int().min(1).optional().describe(T.params["line_to"]),
  radius: z.number().int().min(0).max(MAX_RADIUS).optional().describe(T.params["radius"]),
  with_ids: z.boolean().optional().describe(T.params["with_ids"]),
  max_chars: z.number().int().min(200).max(MAX_MAX_CHARS).optional().describe(T.params["max_chars"]),
  find: z.string().min(1).max(200).optional().describe(T.params["find"]),
  max_matches: z.number().int().min(1).max(MAX_MATCHES).optional().describe(T.params["max_matches"]),
});

type Args = z.infer<typeof inputSchema>;

/**
 * `lines` (with_ids) lists `{n, term_ids}` per window line; keep as many whole records as fit next to
 * the rest of the body so the response stays under RESPONSE_CHARS. Pure over `body`.
 */
export function trimLinesToBudget(body: Record<string, unknown>, budget = RESPONSE_CHARS): void {
  const lines = body.lines;
  if (!Array.isArray(lines)) return;
  const total = jsonSizeOf(body);
  if (total <= budget) return;
  const withoutLines = total - jsonSizeOf(lines);
  const room = budget - withoutLines;
  const kept: unknown[] = [];
  let used = 2;
  for (const line of lines) {
    const cost = jsonSizeOf(line) + 1;
    if (used + cost > room) break;
    kept.push(line);
    used += cost;
  }
  body.lines = kept;
  body.lines_truncated = { kept: kept.length, of: lines.length, note: `lines[] was cut to keep the response under ${budget} characters; narrow the window (radius/line_from/line_to) or page it.` };
}

const LEGEND = "n> text: current line; n* text: breakpoint line; lines are 1-based; long lines are cut with '… [+N chars]'";

/** The ids-only rows of `with_ids`: the text of each line is already in `text`. */
export function idRows(lines: ReadonlyArray<{ n: number; term_ids?: number[] }>): Array<{ n: number; term_ids: number[] }> {
  return lines.map((line) => ({ n: line.n, term_ids: line.term_ids ?? [] }));
}

/** Lowercase, without spaces and underscores: `un_list_data` ~ `unListData`. */
function compact(text: string): string {
  return text.toLowerCase().replace(/[\s_]+/g, "");
}

export interface FindResult {
  /** Matching lines inside the range (all of them). */
  total: number;
  /** The first `cap` matches: 1-based line, trimmed text and where the needle sits in it. */
  hits: Array<{ line: number; text: string; at: number }>;
  /** Matched ignoring case, spaces and underscores because the plain substring found nothing. */
  loose: boolean;
}

/**
 * Case-insensitive substring search over the listing lines `from..to` (1-based, inclusive). When
 * nothing matches and the needle has spaces / underscores, retries ignoring them (pseudocode writes
 * `un_list_data`, the listing `unListData`). Pure.
 */
export function findInListing(lines: readonly string[], needle: string, range: { from: number; to: number }, cap: number): FindResult {
  const from = Math.max(1, range.from);
  const to = Math.min(lines.length, range.to);
  const run = (key: (text: string) => string, wanted: string): Omit<FindResult, "loose"> => {
    let total = 0;
    const hits: FindResult["hits"] = [];
    for (let n = from; n <= to; n++) {
      const raw = lines[n - 1]!;
      const text = raw.trim();
      const at = key(text).indexOf(wanted);
      if (at < 0) continue;
      total++;
      if (hits.length < cap) hits.push({ line: n, text, at });
    }
    return { total, hits };
  };
  const plain = run((text) => text.toLowerCase(), needle.toLowerCase());
  if (plain.total > 0 || !/[\s_]/.test(needle)) return { ...plain, loose: false };
  const wanted = compact(needle);
  if (wanted === "") return { ...plain, loose: false };
  // `at` indexes the compacted text, so the excerpt of a long loose hit starts at the line head.
  const loose = run(compact, wanted);
  return { total: loose.total, hits: loose.hits.map((h) => ({ ...h, at: 0 })), loose: true };
}

/** At most `max` characters of `text`, centred on the match when the line is longer. */
export function excerptAround(text: string, at: number, max = EXCERPT_CHARS): string {
  if (text.length <= max) return text;
  const start = Math.max(0, Math.min(at - Math.floor(max / 3), text.length - max));
  const end = start + max;
  return `${start > 0 ? "… " : ""}${text.slice(start, end)}${end < text.length ? ` … [+${text.length - end} chars]` : ""}`;
}

async function findInSession(ctx: AppContext, args: Args, needle: string): Promise<ToolResult> {
  const lease = leaseSession(ctx, args.dbg_id);
  if (!lease.ok) return lease.result;
  const { record, release } = lease;
  try {
    const client = record.client!;
    const lines = (await client.uplcText()).split("\n");
    const from = args.line_from ?? 1;
    const to = args.line_to ?? lines.length;
    const cap = clampInt(args.max_matches, DEFAULT_MATCHES, 1, MAX_MATCHES);
    const found = findInListing(lines, needle, { from, to }, cap);
    const matches: Array<Record<string, unknown>> = [];
    for (const hit of found.hits) {
      const row: Record<string, unknown> = { line: hit.line };
      // The ids of the terms starting there; the most nested one is where a breakpoint on this line lands.
      const located = await client.locate({ uplc_line: hit.line, context_lines: 0 });
      if (located.term_id !== undefined) {
        row.term_id = located.term_id;
        if (located.term_kind !== undefined) row.kind = located.term_kind;
        if (located.label !== undefined) row.label = located.label;
        if (located.candidates && located.candidates.length > 1) row.term_ids = located.candidates.map((c) => c.term_id);
      }
      row.text = excerptAround(hit.text, hit.at);
      matches.push(row);
    }
    const body: Record<string, unknown> = {
      dbg_id: record.dbgId,
      find: needle,
      total_lines: lines.length,
      ...(args.line_from !== undefined || args.line_to !== undefined ? { searched: { line_from: Math.max(1, from), line_to: Math.min(lines.length, to) } } : {}),
      matches_total: found.total,
      matches,
    };
    const notes: string[] = [];
    if (found.loose) notes.push("no line contains it as written; matched ignoring case, spaces and underscores");
    if (found.total === 0) {
      notes.push("no line matches: the search is a case-insensitive substring over the canonical UPLC (constants as #hex, builtins by their UPLC name such as unListData, strings as written)");
    } else if (found.total > matches.length) {
      const last = matches[matches.length - 1]!.line as number;
      body.truncated = true;
      body.next_line_from = last + 1;
      notes.push(`${found.total - matches.length} more match${found.total - matches.length === 1 ? "" : "es"}: use a longer find, raise max_matches (max ${MAX_MATCHES}) or continue with line_from=${last + 1}`);
    }
    if (notes.length > 0) body.note = notes.join("; ");
    return ok(body);
  } catch (error) {
    return sessionErrorResult(ctx, record, error);
  } finally {
    release();
  }
}

async function debugSource(ctx: AppContext, args: Args): Promise<ToolResult> {
  if (args.find !== undefined) {
    const needle = args.find.trim();
    if (needle === "") return fail({ code: "invalid_argument", message: "find is empty: pass a constant (#9e3c…), a builtin name (unListData) or a string to search the UPLC listing for.", argument: "find" });
    const clash = (["around", "radius", "with_ids", "max_chars"] as const).find((name) => args[name] !== undefined && args[name] !== false);
    if (clash) {
      return fail({ code: "invalid_argument", message: `find answers matching lines, not a window, so ${clash} does not apply. Drop ${clash}, or call debug_source without find to read a window (line_from / line_to also narrow where find searches).`, argument: clash });
    }
    return findInSession(ctx, args, needle);
  }
  if (args.max_matches !== undefined) {
    return fail({ code: "invalid_argument", message: "max_matches only applies together with find.", argument: "max_matches" });
  }
  const lease = leaseSession(ctx, args.dbg_id);
  if (!lease.ok) return lease.result;
  const { record, release } = lease;
  try {
    const options: SourceWindowOptions = {
      around: args.around ?? "current",
      line_from: args.line_from,
      line_to: args.line_to,
      radius: clampInt(args.radius, DEFAULT_RADIUS, 0, MAX_RADIUS),
      with_ids: args.with_ids ?? false,
      max_chars: clampInt(args.max_chars, DEFAULT_MAX_CHARS, 200, MAX_MAX_CHARS),
      breakpoints: breakpointsOf(record),
    };
    const window = await record.client!.sourceWindow(options);
    const body: Record<string, unknown> = {
      dbg_id: record.dbgId,
      total_lines: window.total_lines,
      window: window.window,
      current: window.current,
      text: window.text,
      legend: LEGEND,
    };
    if (options.with_ids) body.lines = idRows(window.lines);
    if (window.truncated) body.truncated = true;
    trimLinesToBudget(body);
    return ok(body);
  } catch (error) {
    return sessionErrorResult(ctx, record, error);
  } finally {
    release();
  }
}

export const debugSourceTool: ToolModule = {
  name: "debug_source",
  register(server: McpServer, ctx: AppContext) {
    server.registerTool(
      "debug_source",
      {
        title: T.title,
        description: T.description,
        inputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        _meta: { "anthropic/maxResultSizeChars": 150_000 },
      },
      async (args) => debugSource(ctx, args),
    );
  },
};
