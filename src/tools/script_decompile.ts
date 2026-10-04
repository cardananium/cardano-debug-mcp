// script_decompile: read a Plutus script as Aiken-like pseudocode (dehosk) or as UPLC, paged by
// line, with the decompiler's `// Info:` / `// Warning:` / `// Note:` header extracted into notes[].
// Also registers the `cardano-debug://script/{script_hash}/{pseudocode|uplc|uplc_canonical}.txt`
// resources that serve the cached full texts.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AppContext, ToolModule } from "../context.js";
import { numberLines } from "../decompiler/notes.js";
import { DECOMPILE_VIEWS, OptionsError, type DecompileView } from "../decompiler/options.js";
import { resolveScript } from "../decompiler/resolve.js";
import { getDecompilerService } from "../decompiler/service.js";
import { compactIndentation, INDENT_CAP } from "../engine/indent.js";
import { purposeLabel } from "../vocab/purpose.js";
import { clampInt, fail, failFromError, ok, resourceLink, type ResourceLink, type ToolResult } from "./_shared.js";
import { refuseNativeScript } from "./_nativeScript.js";
import { TOOL_TEXT } from "./descriptions.js";

const T = TOOL_TEXT.script_decompile;

export const DEFAULT_LINES = 120;
export const MAX_LINES = 600;
/** A 600-line page must not spill into a file. */
export const MAX_RESULT_CHARS = 200_000;
/** Character budget of one page of numbered code (keeps a response under ~8k tokens even for UPLC). */
export const PAGE_CHARS = 28_000;
/** One source line longer than this is cut (UPLC spines can be a single very long line). */
export const LINE_CHARS = 4_000;

/**
 * Cut `slice` at the last whole line that keeps the numbered page within `budget` characters
 * (at least one line is kept). Over-long lines are truncated first.
 */
export function fitPage(slice: readonly string[], budget = PAGE_CHARS, lineChars = LINE_CHARS): { lines: string[]; cut: boolean } {
  const out: string[] = [];
  let used = 0;
  for (const raw of slice) {
    const line = raw.length > lineChars ? `${raw.slice(0, lineChars)}… [truncated ${raw.length - lineChars} chars]` : raw;
    const cost = line.length + 8; // number gutter + newline
    if (out.length > 0 && used + cost > budget) return { lines: out, cut: true };
    out.push(line);
    used += cost;
  }
  return { lines: out, cut: false };
}

const optionsSchema = z
  .object({
    strip_all_traces: z.boolean().optional(),
    strip_plutustx_traces: z.boolean().optional(),
    decode_church_to_native: z.boolean().optional(),
    expect_or_fail: z.boolean().optional(),
    synthesize_stub_adts: z.boolean().optional(),
    safe_mode: z.boolean().optional(),
    compilable_data_access: z.boolean().optional(),
    split_purposes: z.string().optional().describe(T.params["options.split_purposes"]),
    applied_kind: z.union([z.string(), z.number().int().min(0)]).optional().describe(T.params["options.applied_kind"]),
    raw: z.record(z.string(), z.unknown()).optional(),
  })
  .optional();

const inputSchema = z.object({
  script: z.string().optional().describe(T.params["script"]),
  dbg_id: z.string().optional().describe(T.params["dbg_id"]),
  tx_id: z.string().optional().describe(T.params["tx_id"]),
  script_hash: z.string().optional().describe(T.params["script_hash"]),
  network: z.enum(["mainnet", "preprod", "preview"]).optional().describe(T.params["network"]),
  plutus_version: z.string().optional().describe(T.params["plutus_version"]),
  purpose: z.string().optional().describe(T.params["purpose"]),
  view: z.enum(DECOMPILE_VIEWS as [DecompileView, ...DecompileView[]]).optional().describe(T.params["view"]),
  from_line: z.number().int().min(1).optional().describe(T.params["from_line"]),
  lines: z.number().int().min(1).max(MAX_LINES).optional().describe(T.params["lines"]),
  options: optionsSchema.describe(T.params["options"]),
  refresh: z.boolean().optional().describe(T.params["refresh"]),
});

type Args = z.infer<typeof inputSchema>;


export function scriptResources(scriptHash: string): ResourceLink[] {
  return [
    resourceLink(`cardano-debug://script/${scriptHash}/pseudocode.txt`, `${scriptHash.slice(0, 12)} pseudocode`, "text/plain", "Full dehosk pseudocode (latest options), ?offset=&limit= for line slices"),
    resourceLink(`cardano-debug://script/${scriptHash}/uplc.txt`, `${scriptHash.slice(0, 12)} uplc`, "text/plain", "Full UPLC (spine-flattened), ?offset=&limit= for line slices"),
  ];
}

async function scriptDecompile(ctx: AppContext, args: Args, signal?: AbortSignal): Promise<ToolResult> {
  const view: DecompileView = args.view ?? "pseudocode";
  const lines = clampInt(args.lines, DEFAULT_LINES, 1, MAX_LINES);
  const fromLine = clampInt(args.from_line, 1, 1, Number.MAX_SAFE_INTEGER);
  if (view !== "pseudocode" && args.options && Object.keys(args.options).length > 0) {
    // The UPLC layers ignore every decompiler option; say so rather than silently caching under a different key.
    return fail({ code: "invalid_argument", message: `options only apply to view='pseudocode'; the ${view} view echoes the decoded program and ignores them. Drop options or switch the view.`, argument: "options" });
  }

  if (args.script && !args.dbg_id) {
    const native = await refuseNativeScript(ctx, args.script);
    if (native) return native;
  }
  try {
    const resolved = await resolveScript(ctx, {
      script: args.script,
      dbg_id: args.dbg_id,
      tx_id: args.tx_id,
      script_hash: args.script_hash,
      network: args.network,
      plutus_version: args.plutus_version,
      purpose: args.purpose,
      signal,
    });
    if (!resolved.ok) return resolved.result;
    const script = resolved.script;
    const service = getDecompilerService(ctx);
    const outcome = await service.decompile({
      scriptHex: script.singleHex,
      scriptHash: script.scriptHash,
      view,
      scriptVersion: script.versionCertain ? script.version : undefined,
      purpose: view === "pseudocode" ? script.purpose : undefined,
      user: view === "pseudocode" ? args.options : undefined,
      refresh: args.refresh,
      signal,
    });

    const identity: Record<string, unknown> = {
      script_hash: script.scriptHash,
      plutus_version: script.version,
      version_decision: describeVersionDecision(script.versionDecision),
      ...(script.alternativeHashes ? { script_hash_if: script.alternativeHashes } : {}),
      ...(script.hashVerified !== undefined ? { hash_verified: script.hashVerified } : {}),
      purpose_used: script.purpose ? { purpose: script.purpose, label: purposeLabel(script.purpose), decision: script.purposeDecision } : null,
      source: `${script.source.kind}: ${script.source.detail}`,
      size_bytes: script.sizeBytes,
      wrapping: script.wrapping,
      view,
      options_used: outcome.options.echo,
    };
    if (script.hashVerified === false) {
      identity.warning = `The bytes hash to ${script.scriptHash} under ${script.version}, not to the requested script_hash. Pass plutus_version if the language tag is the difference.`;
    }

    if (!outcome.ok) {
      if (outcome.code === "decompile_failed") {
        const retryInS = Math.max(1, Math.round((outcome.marker.until - Date.now()) / 1000));
        return fail({
          code: "decompile_failed",
          message:
            `The decompiler could not finish this script (${outcome.marker.code}: ${outcome.marker.message}). ` +
            `Identical requests are refused for ${retryInS} s to avoid repeating a ${Math.round(ctx.config.decompileTimeoutMs / 1000)} s attempt; ` +
            "try view='uplc' (exact and cheap), options.safe_mode=true, or refresh=true to force another attempt.",
          ...identity,
          failure: outcome.marker.code,
          failed_at: new Date(outcome.marker.at).toISOString(),
          retry_after_s: retryInS,
        });
      }
      return fail({ code: "decompile_error", message: outcome.message, ...identity });
    }

    const entry = outcome.entry;
    const total = entry.lines.length;
    if (fromLine > total) {
      return fail({
        code: "invalid_argument",
        message: `from_line ${fromLine} is past the end: the ${view} text has ${total} lines.`,
        argument: "from_line",
        total_lines: total,
        ...identity,
      });
    }
    const start = fromLine - 1;
    const requested = entry.lines.slice(start, start + lines);
    // UPLC indents two columns per level without bound: show the page with compacted indentation
    // (common indentation removed, the rest capped), so the character budget buys lines, not spaces.
    const compacted = view === "pseudocode" ? undefined : compactIndentation(requested);
    const page = fitPage(compacted ? compacted.lines : requested);
    const toLine = start + page.lines.length;
    const links = scriptResources(script.scriptHash);
    const body: Record<string, unknown> = {
      ...identity,
      total_lines: total,
      from_line: fromLine,
      to_line: toLine,
      ...(toLine < total ? { next_from_line: toLine + 1 } : {}),
      ...(page.cut
        ? { page_cut: true, page_note: `The page was cut at line ${toLine} to stay under ${PAGE_CHARS} characters (${requested.length} lines requested); continue with from_line=${toLine + 1} or read the resource.` }
        : {}),
      ...(compacted ? { dedent: compacted.dedent, ...(compacted.capped > 0 ? { indent_capped_at: INDENT_CAP } : {}) } : {}),
      notes: entry.notes,
      header_lines: entry.headerLines,
      code: numberLines(page.lines, fromLine, String(total).length),
      elapsed_ms: entry.elapsedMs,
      cached: outcome.cached,
    };
    return ok(body, { links });
  } catch (error) {
    if (error instanceof OptionsError) return fail({ code: "invalid_argument", message: error.message, argument: error.argument });
    return failFromError(error, "decompile_error");
  }
}

function describeVersionDecision(decision: string): string {
  switch (decision) {
    case "given":
      return "given";
    case "from_tx":
      return "from the transaction";
    case "from_session":
      return "from the debug session";
    case "from_chain":
      return "from the chain lookup";
    case "from_envelope":
      return "from the cardano-cli envelope type";
    case "from_script_ref":
      return "from the ScriptRef tag";
    case "header_v3":
      return "inferred: the UPLC header (1,1,_) is V3-only";
    case "assumed_v2":
      return "assumed: the UPLC header (1,0,_) is shared by V1 and V2; pass plutus_version to pin it (affects TxInfo field names and the script hash)";
    default:
      return decision;
  }
}

export const scriptDecompileTool: ToolModule = {
  name: "script_decompile",
  register(server: McpServer, ctx: AppContext) {
    server.registerTool(
      "script_decompile",
      {
        title: T.title,
        description: T.description,
        inputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        _meta: { "anthropic/maxResultSizeChars": MAX_RESULT_CHARS },
      },
      async (args, mcp) => scriptDecompile(ctx, args, mcp.mcpReq.signal),
    );

    // The script/{hash}/{pseudocode,uplc,uplc_canonical}.txt resources are served by the base routes
    // through the scriptArtifact provider that getDecompilerService registers.
    getDecompilerService(ctx);
  },
};
