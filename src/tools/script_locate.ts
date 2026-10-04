// script_locate: translate between the two positional coordinates of the server — the CEK term id
// and the line of the canonical UPLC listing — for a session or a bare script. Both directions are
// exact (the listing has one term per line; a line may start several terms => candidates).

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AppContext, ToolModule } from "../context.js";
import { normalizeScriptInput, ScriptBytesError } from "../decompiler/scriptBytes.js";
import { isUplcText, parseLanguage, PartsError } from "../engine/parts.js";
import type { EngineLanguage, LocateQuery, LocateResult } from "../engine/protocol.js";
import { engineService } from "../engine/service.js";
import { DEFAULT_CONTEXT_LINES, leaseSession, MAX_CONTEXT_LINES, sessionErrorResult } from "./_debug.js";
import { clampInt, fail, failFromError, normalizeBytesInput, ok, ToolInputError, type ToolResult } from "./_shared.js";
import { WorkerCallError } from "../workers/rpc.js";
import { refuseNativeScript } from "./_nativeScript.js";
import { TOOL_TEXT } from "./descriptions.js";

const T = TOOL_TEXT.script_locate;

const inputSchema = z.object({
  dbg_id: z.string().optional().describe(T.params["dbg_id"]),
  script: z.string().optional().describe(T.params["script"]),
  plutus_version: z.string().optional().describe(T.params["plutus_version"]),
  term_id: z.number().int().min(0).optional().describe(T.params["term_id"]),
  uplc_line: z.number().int().min(1).optional().describe(T.params["uplc_line"]),
  context_lines: z.number().int().min(0).max(MAX_CONTEXT_LINES).optional().describe(T.params["context_lines"]),
});

type Args = z.infer<typeof inputSchema>;

const ACCEPTED_SCRIPT = "UPLC text '(program …', or compiled script hex in any wrapping (flat, CBOR, double CBOR, ScriptRef), base64 or a cardano-cli envelope";

function shape(result: LocateResult, dbgId: string | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (dbgId) body.dbg_id = dbgId;
  if (result.term_id !== undefined) body.term_id = result.term_id;
  if (result.term_kind !== undefined) body.term_kind = result.term_kind;
  if (result.label !== undefined) body.label = result.label;
  body.uplc = result.uplc;
  if (result.candidates) body.candidates = result.candidates;
  if (result.note) body.note = result.note;
  return body;
}

async function scriptLocate(ctx: AppContext, args: Args): Promise<ToolResult> {
  const given = [args.term_id !== undefined, args.uplc_line !== undefined].filter(Boolean).length;
  if (given !== 1) return fail({ code: "invalid_argument", message: "Give exactly one of term_id, uplc_line.", argument: "term_id" });
  const contextLines = clampInt(args.context_lines, DEFAULT_CONTEXT_LINES, 0, MAX_CONTEXT_LINES);
  const query: LocateQuery = { term_id: args.term_id, uplc_line: args.uplc_line, context_lines: contextLines };

  if (args.dbg_id) {
    const lease = leaseSession(ctx, args.dbg_id);
    if (!lease.ok) return lease.result;
    try {
      const result = await lease.record.client!.locate(query);
      return ok(shape(result, args.dbg_id));
    } catch (error) {
      return sessionErrorResult(ctx, lease.record, error);
    } finally {
      lease.release();
    }
  }

  if (!args.script) return fail({ code: "invalid_argument", message: `Give dbg_id (a session) or script (${ACCEPTED_SCRIPT}).`, argument: "script" });
  let language: EngineLanguage;
  let source: string;
  try {
    if (isUplcText(args.script)) {
      source = args.script.trim();
      language = args.plutus_version ? parseLanguage(args.plutus_version) : "V3";
    } else {
      // Hex, base64 and a cli envelope all end in script bytes: a native script is refused whichever way it arrived.
      const bytes = normalizeBytesInput(args.script);
      if (bytes.kind === "hex" || bytes.kind === "base64" || bytes.kind === "cli_envelope") {
        const native = await refuseNativeScript(ctx, bytes.value);
        if (native) return native;
      }
      const normalized = normalizeScriptInput(args.script);
      // The engine reads flat or CBOR-wrapped bytes but not a ScriptRef: hand it the single-wrapped form.
      source = normalized.singleHex;
      language = args.plutus_version ? parseLanguage(args.plutus_version) : (normalized.statedVersion ?? "V3");
    }
  } catch (error) {
    if (error instanceof ScriptBytesError) return fail({ code: "invalid_argument", message: `${error.message} script_locate accepts ${ACCEPTED_SCRIPT}.`, argument: "script" });
    return error instanceof PartsError ? fail({ code: "invalid_argument", message: error.message, argument: error.argument }) : failFromError(error);
  }
  const client = engineService(ctx).newClient();
  try {
    const summary = await client.openProgram(source, language, 0);
    const result = await client.locate(query);
    return ok({ ...shape(result, undefined), script_hash: summary.script_hash, plutus_version: summary.language, term_count: summary.term_count, uplc_lines: summary.uplc_lines, note_session: "indexed with a throwaway session; open debug_open for stepping" });
  } catch (error) {
    if (error instanceof WorkerCallError) {
      const data = error.data as { code?: string; argument?: string } | undefined;
      if (data?.code === "invalid_argument") return fail({ code: "invalid_argument", message: error.message, ...(data.argument ? { argument: data.argument } : {}) });
      if (/parse|decode|invalid|hex|flat|cbor/i.test(error.message)) {
        return fail({ code: "invalid_argument", message: `${error.message} (script_locate accepts ${ACCEPTED_SCRIPT}.)`, argument: "script" });
      }
      return fail({ code: "engine_error", message: error.message });
    }
    if (error instanceof ToolInputError) return failFromError(error);
    return failFromError(error, "engine_error");
  } finally {
    await client.close().catch(() => undefined);
  }
}

export const scriptLocateTool: ToolModule = {
  name: "script_locate",
  register(server: McpServer, ctx: AppContext) {
    server.registerTool(
      "script_locate",
      {
        title: T.title,
        description: T.description,
        inputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args) => scriptLocate(ctx, args),
    );
  },
};
