// Every tool module the server registers, and the one place where they are registered.
// Other layers add a file under src/tools and one line here.
//
// Registration goes through `registerAllTools`: every tool's input schema is made strict there, once,
// so an argument a tool does not know is an error that names the valid ones instead of being dropped
// silently (a model that wrote `era:'babbage'` must not read "valid" as "valid for Babbage").
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AppContext, ToolModule } from "../context.js";
import { cborDecodeTool } from "./cbor_decode.js";
import { cborValidateTool } from "./cbor_validate.js";
import { cddlCheckTool } from "./cddl_check.js";
import { debugCloseTool } from "./debug_close.js";
import { debugInspectTool } from "./debug_inspect.js";
import { debugOpenTool } from "./debug_open.js";
import { debugProfileTool } from "./debug_profile.js";
import { debugRunTool } from "./debug_run.js";
import { debugSourceTool } from "./debug_source.js";
import { docsTool } from "./docs.js";
import { scriptLocateTool } from "./script_locate.js";
import { txInspectTool } from "./tx_inspect.js";

export const ALL_TOOLS: ToolModule[] = [
  docsTool,
  cborDecodeTool,
  cborValidateTool,
  cddlCheckTool,
  txInspectTool,
  debugOpenTool,
  debugRunTool,
  debugInspectTool,
  debugSourceTool,
  debugProfileTool,
  debugCloseTool,
  scriptLocateTool,
];
import { scriptDecompileTool } from "./script_decompile.js";
ALL_TOOLS.push(scriptDecompileTool);
import { txLoadTool } from "./tx_load.js";
import { txValidateTool } from "./tx_validate.js";
import { txRedeemerTool } from "./tx_redeemer.js";
import { txAddWitnessesTool } from "./tx_add_witnesses.js";
import { bundleExportTool } from "./bundle_export.js";
ALL_TOOLS.push(txLoadTool, txValidateTool, txRedeemerTool, txAddWitnessesTool, bundleExportTool);
import { uiLinkTool } from "./ui_link.js";
ALL_TOOLS.push(uiLinkTool);

// ---------- strict inputs ----------

/** Edit distance (insert / delete / substitute), for the did-you-mean of an unknown parameter. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row.push(Math.min((previous[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    previous = row;
  }
  return previous[b.length] ?? 0;
}

/** Names a model tends to use for a parameter that is called something else here (target must be valid for the tool). */
const COMMON_ALIASES: Record<string, string[]> = {
  era: ["cddl"],
  schema: ["cddl"],
  preset: ["cddl"],
  cbor: ["hex", "tx_cbor"],
  tx: ["tx_id", "tx_cbor"],
  txid: ["tx_id"],
  tx_hash_hex: ["tx_hash"],
  handle: ["dbg_id", "tx_id"],
  session: ["dbg_id"],
  session_id: ["dbg_id"],
  dbg: ["dbg_id"],
  script_cbor: ["script"],
  scriptHash: ["script_hash"],
};

const squash = (name: string): string => name.toLowerCase().replace(/[_\-\s]/g, "");

/** The valid parameter closest to `name`, when one is close enough to be a likely typo or synonym. */
export function suggestParameter(name: string, valid: readonly string[]): string | undefined {
  for (const alias of COMMON_ALIASES[name] ?? COMMON_ALIASES[squash(name)] ?? []) if (valid.includes(alias)) return alias;
  const wanted = squash(name);
  let best: { key: string; score: number } | undefined;
  for (const key of valid) {
    const other = squash(key);
    let score = editDistance(wanted, other);
    const limit = Math.max(1, Math.floor(Math.min(wanted.length, other.length) / 3));
    // `lines` for `line`, `txid` for `tx_id`: containment counts as close when the shorter name is a real word.
    if (Math.min(wanted.length, other.length) >= 3 && (other.includes(wanted) || wanted.includes(other))) score = Math.min(score, 1);
    if (score <= limit && (!best || score < best.score)) best = { key, score };
  }
  return best?.key;
}

/** The text of an unrecognized_keys issue: what was wrong, the closest valid name, every valid name. */
export function unknownParametersMessage(tool: string, unknown: readonly string[], valid: readonly string[]): string {
  const shown = unknown.map((key) => `'${key}'`).join(", ");
  const hints = unknown.flatMap((key) => {
    const suggestion = suggestParameter(key, valid);
    return suggestion ? [`'${key}' -> did you mean '${suggestion}'?`] : [];
  });
  return `unknown parameter${unknown.length > 1 ? "s" : ""} ${shown} for ${tool}; valid parameters: ${valid.join(", ")}${hints.length ? ` (${hints.join(" ")})` : ""}`;
}

type Logger = (message: string) => void;
const debugLog: Logger = (message) => {
  if (process.env.CARDANO_DEBUG_LOG === "debug") console.error(`[cardano-debug] debug: ${message}`);
};

type ZodShape = Record<string, z.ZodType>;

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value;
}

/** A plain `{ name: zodType }` shape: the SDK accepts it in place of a schema. */
function isRawShape(value: unknown): value is ZodShape {
  return typeof value === "object" && value !== null && !isZodType(value) && !("~standard" in value) && Object.values(value).every(isZodType);
}

/**
 * The strict version of a tool's input schema: the same fields, plus an `unrecognized_keys` error naming the
 * valid parameters. A schema that is not a plain object schema (or that carries checks the rebuild would lose)
 * is returned unchanged and noted at debug level. `undefined` stays `undefined` (a tool without parameters).
 */
export function strictInputSchema(tool: string, schema: unknown, log: Logger = debugLog): unknown {
  if (schema === undefined) return undefined;
  let shape: ZodShape | undefined;
  if (isRawShape(schema)) {
    shape = schema;
  } else if (isZodType(schema) && (schema as { _zod: { def: { type?: string; checks?: unknown[] } } })._zod.def.type === "object") {
    const def = (schema as { _zod: { def: { checks?: unknown[] } } })._zod.def;
    if (def.checks?.length) {
      log(`input schema of ${tool} has checks; left non-strict`);
      return schema;
    }
    shape = (schema as unknown as z.ZodObject).shape as ZodShape;
  }
  if (!shape) {
    log(`input schema of ${tool} is not a plain object schema; left non-strict`);
    return schema;
  }
  const valid = Object.keys(shape);
  return withCompactJsonSchema(
    z.strictObject(shape, {
      error: (issue) => (issue.code === "unrecognized_keys" ? unknownParametersMessage(tool, issue.keys, valid) : undefined),
    }),
  );
}

const SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

/**
 * A JSON Schema without noise the model gains nothing from: no `$schema` (draft 2020-12 is the default) and no
 * safe-integer bounds, which zod adds to every `.int()`. The tools/list catalogue is in every conversation's context.
 */
export function compactJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(compactJsonSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema") continue;
    if ((key === "maximum" && value === SAFE_INTEGER) || (key === "minimum" && value === -SAFE_INTEGER)) continue;
    out[key] = compactJsonSchema(value);
  }
  return out;
}

/** `schema` with its Standard Schema JSON output compacted; validation and everything else is the original's. */
function withCompactJsonSchema<T extends object>(schema: T): T {
  return new Proxy(schema, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property !== "~standard") return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      const standard = value as { jsonSchema?: { input: (options: unknown) => unknown; output: (options: unknown) => unknown } };
      const json = standard.jsonSchema;
      if (!json) return value;
      return { ...standard, jsonSchema: { input: (options: unknown) => compactJsonSchema(json.input(options)), output: (options: unknown) => compactJsonSchema(json.output(options)) } };
    },
  });
}

/**
 * Tool annotations without what the MCP spec already implies: `readOnlyHint` and `idempotentHint` default to false, and
 * idempotence only matters for a tool that is not read-only. The explicit values cost ~20 characters each, in every conversation.
 */
export function compactAnnotations(annotations: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...annotations };
  if (out.readOnlyHint === false) delete out.readOnlyHint;
  if (out.idempotentHint === false || out.readOnlyHint === true) delete out.idempotentHint;
  return out;
}

/** `server` with `registerTool` replaced by a version that makes the input schema strict. */
export function withStrictInputs(server: McpServer, log?: Logger): McpServer {
  return new Proxy(server, {
    get(target, property) {
      if (property === "registerTool") {
        return (name: string, config: { inputSchema?: unknown; annotations?: Record<string, unknown> }, handler: unknown) =>
          (target.registerTool as (...args: unknown[]) => unknown).call(target, name, { ...config, inputSchema: strictInputSchema(name, config.inputSchema, log), ...(config.annotations ? { annotations: compactAnnotations(config.annotations) } : {}) }, handler);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** Register every tool on `server`, with strict input schemas. */
export function registerAllTools(server: McpServer, ctx: AppContext, tools: readonly ToolModule[] = ALL_TOOLS): void {
  const strict = withStrictInputs(server);
  for (const tool of tools) {
    try {
      tool.register(strict, ctx);
    } catch (error) {
      console.error(`[cardano-debug] tool module ${tool.name} failed to register:`, error);
      throw error;
    }
  }
}
