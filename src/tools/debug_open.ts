// debug_open: start a CEK step-debugging session (tx redeemer, hand-supplied parts, or a bare
// program) in its own worker and return the handle + starting position.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AppContext, ToolModule } from "../context.js";
import { normalizeScriptInput, ScriptBytesError } from "../decompiler/scriptBytes.js";
import { isProgramOnly, isUplcText, parseLanguage, partsFromArgs, partsFromEval, PartsError, type BuiltParts, type CostModelSource } from "../engine/parts.js";
import type { EngineLanguage, PartsConfig, SessionSummary } from "../engine/protocol.js";
import { engineService } from "../engine/service.js";
import type { SessionInit, SessionMode, SessionRecord, SessionReopen } from "../store/sessionRegistry.js";
import { DBG_ID_PATTERN, expiredHandleError, SessionLimitError, sessionLimitError } from "../store/sessionRegistry.js";
import type { TxRecord } from "../store/txStore.js";
import { formatRedeemerRef, isWitnessIndexRef, parseRedeemerRef } from "../vocab/redeemerRef.js";
import { parsePurpose, purposeFromLibTag, type Purpose } from "../vocab/purpose.js";
import { DEFAULT_CONTEXT_LINES, expiresAtIso, lossOf, MAX_CONTEXT_LINES, sessionLinks, shapePosition } from "./_debug.js";
import { clampInt, fail, failFromError, ok, ToolInputError, type ToolResult } from "./_shared.js";
import { lookupTxRecord } from "../tx/record.js";
import { chainStateOf } from "../chain/state.js";
import { WorkerTimeoutError } from "../workers/rpc.js";
import { refuseNativeScript } from "./_nativeScript.js";
import { TOOL_TEXT } from "./descriptions.js";

const T = TOOL_TEXT.debug_open;

const inputSchema = z.object({
  tx_id: z.string().optional().describe(T.params["tx_id"]),
  redeemer: z.string().optional().describe(T.params["redeemer"]),
  script: z.string().optional().describe(T.params["script"]),
  plutus_version: z.string().optional().describe(T.params["plutus_version"]),
  context: z.string().optional().describe(T.params["context"]),
  redeemer_data: z.string().optional().describe(T.params["redeemer_data"]),
  datum: z.string().optional().describe(T.params["datum"]),
  cost_models: z.array(z.union([z.string(), z.number()])).optional().describe(T.params["cost_models"]),
  protocol_major: z.number().int().min(1).optional().describe(T.params["protocol_major"]),
  ex_units: z.object({ steps: z.union([z.string(), z.number()]), mem: z.union([z.string(), z.number()]) }).optional().describe(T.params["ex_units"]),
  purpose: z.string().optional().describe(T.params["purpose"]),
  reopen: z.string().optional().describe(T.params["reopen"]),
  allow_program_only: z.boolean().optional().describe(T.params["allow_program_only"]),
  context_lines: z.number().int().min(0).max(MAX_CONTEXT_LINES).optional().describe(T.params["context_lines"]),
});

export type DebugOpenArgs = z.infer<typeof inputSchema>;
type Args = DebugOpenArgs;

interface Resolved {
  mode: SessionMode;
  parts?: BuiltParts;
  program?: { source: string; language: EngineLanguage };
  txId?: string;
  redeemer?: string;
  purpose?: Purpose;
  network?: string;
  notes: string[];
  /** Protocol major the engine will run with, and where it comes from (the engine's own default is 11). */
  protocolMajor: number;
  protocolSource: "protocol_params" | "supplied" | "engine_default";
  /** Cost-model / validator-result facts a reopen carries over (tx mode and parts mode keep them on `parts.meta`). */
  costModelSource?: string;
  calculatedExUnits?: { steps: string; mem: string };
  reopenedFrom?: string;
}

/** Protocol major of a session the engine opens without a chain protocol version (`VAN_ROSSEM_PROTOCOL_VERSION`). */
const ENGINE_DEFAULT_PROTOCOL = 11;

/** Parameters that only mean something in another mode, with the mode that reads them. */
const PARTS_ONLY_ARGS = ["script", "plutus_version", "context", "redeemer_data", "datum", "cost_models", "protocol_major", "ex_units", "purpose"] as const;

function resolveTxRedeemer(record: TxRecord, redeemerInput: string): { ref: string; purpose: Purpose } {
  const parsed = parseRedeemerRef(redeemerInput);
  if (isWitnessIndexRef(parsed)) {
    const target = record.redeemerTargets.find((t) => t.witness_index === parsed.witnessIndex);
    if (!target) throw new ToolInputError(`r:${parsed.witnessIndex} is not a redeemer of ${record.txId} (it has ${record.redeemerTargets.length})`, "redeemer");
    return { ref: target.ref, purpose: target.purpose };
  }
  const ref = formatRedeemerRef(parsed);
  const known = record.redeemerTargets.find((t) => t.ref === ref);
  if (!known) {
    throw new ToolInputError(`${ref} is not a redeemer of ${record.txId}; it has: ${record.redeemerTargets.map((t) => t.ref).join(", ") || "none"}`, "redeemer");
  }
  return { ref, purpose: known.purpose };
}

/** tx-mode debug_open of a tx whose validation does not finish in its budget: say so instead of a retry loop. */
function validationTimeout(record: TxRecord, ref: string, timeoutMs: number): ToolResult {
  const target = record.redeemerTargets.find((t) => t.ref === ref);
  const info = chainStateOf(record)?.scriptHashes[ref];
  const scriptHash = info?.script_hash ?? target?.script_hash;
  const plutusVersion = info?.plutus_version ?? target?.plutus_version;
  const scriptResource = `cardano-debug://tx/${record.txId}/redeemer/${ref}/script.hex`;
  return fail({
    code: "validation_timeout",
    message:
      `The validation of ${record.txId} did not finish within ${timeoutMs} ms, and a tx-mode session is built from a finished validation (its applied ScriptContext), so ${ref} cannot be opened in tx mode. ` +
      `Retry tx_validate(tx_id, timeout_ms up to 300000); if it never finishes (an unbounded loop), step the script outside the tx: debug_open(script=<its bytes: read ${scriptResource}, or tx_redeemer(part='script')>, plutus_version${plutusVersion && plutusVersion !== "native" ? `=${JSON.stringify(plutusVersion)}` : ""}, redeemer_data / datum / context as far as you have them) with debug_run max_steps as the bound.`,
    tx_id: record.txId,
    redeemer: ref,
    timeout_ms: timeoutMs,
    ...(scriptHash ? { script_hash: scriptHash } : {}),
    ...(plutusVersion ? { plutus_version: plutusVersion } : {}),
    script_resource: scriptResource,
  });
}

function givenKeys(args: Args, keys: readonly string[]): string[] {
  const record = args as unknown as Record<string, unknown>;
  return keys.filter((key) => record[key] !== undefined && record[key] !== null && record[key] !== "");
}

/** The redeemers of a loaded tx as the model should pick one: `spend:0 (input abc…#0)`. */
function listRedeemers(record: TxRecord): string {
  if (record.redeemerTargets.length === 0) return "no redeemers (there is no script to step)";
  const shown = record.redeemerTargets.slice(0, 12).map((t) => `${t.ref} (${t.target.length > 96 ? `${t.target.slice(0, 96)}…` : t.target})`);
  const more = record.redeemerTargets.length - shown.length;
  return `${record.redeemerTargets.length} redeemer${record.redeemerTargets.length === 1 ? "" : "s"}: ${shown.join(", ")}${more > 0 ? `, … (+${more})` : ""}`;
}

/**
 * `script` as the engine reads it. UPLC text and plain hex pass through; a cardano-cli envelope,
 * base64 and a ScriptRef (`[tag, bytes]`) are brought to hex by the same normaliser script_decompile
 * uses, and the Plutus version they state is returned.
 */
function prepareScript(script: string): { ok: true; source: string; stated?: EngineLanguage; notes: string[] } | { ok: false; result: ToolResult } {
  if (isUplcText(script)) return { ok: true, source: script.trim(), notes: [] };
  const hexish = script.trim().replace(/\s+/g, "").replace(/^0x/i, "");
  const plain = /^(?:[0-9a-fA-F]{2})+$/.test(hexish);
  // Plain hex is passed on as given (a ScriptRef excepted): the engine reads flat / CBOR / double CBOR itself.
  if (plain && !/^820[123]/i.test(hexish)) return { ok: true, source: hexish.toLowerCase(), notes: [] };
  try {
    const normalized = normalizeScriptInput(script);
    const stated = normalized.statedVersion;
    const how = normalized.inputKind === "cli_envelope" ? "a cardano-cli envelope" : normalized.inputKind === "base64" ? "base64" : normalized.wrapping === "script_ref" ? "a ScriptRef" : "hex";
    return {
      ok: true,
      source: normalized.singleHex,
      ...(stated ? { stated } : {}),
      notes: [`script given as ${how}: read as ${normalized.wrapping} script bytes${stated ? ` (${stated} stated by the wrapping)` : ""}`],
    };
  } catch (error) {
    if (plain && error instanceof ScriptBytesError) return { ok: true, source: hexish.toLowerCase(), notes: [] };
    return {
      ok: false,
      result: fail({
        code: "invalid_argument",
        message: `script must be UPLC text '(program …', script hex (flat, CBOR or double CBOR), base64, a cardano-cli envelope {"type","cborHex"} or a ScriptRef: ${error instanceof Error ? error.message : String(error)}`,
        argument: "script",
      }),
    };
  }
}

/** The parts a kept session was built from, rebuilt without the transaction or the original arguments. */
function partsFromKept(source: SessionReopen): BuiltParts {
  const config = source.partsConfig as unknown as PartsConfig;
  const applied: BuiltParts["meta"]["applied"] = [];
  if (config.datum) applied.push("datum");
  if (config.redeemer) applied.push("redeemer");
  if (config.context) applied.push("context");
  return {
    config,
    meta: {
      language: source.language,
      purpose: source.purpose,
      cost_model_source: (source.costModelSource as CostModelSource | undefined) ?? "engine_default",
      cost_model_length: config.cost_models?.length,
      protocol_major: config.protocol_version,
      declared_ex_units: config.ex_units ? { steps: String(config.ex_units[0]), mem: String(config.ex_units[1]) } : undefined,
      calculated_ex_units: source.calculatedExUnits,
      applied,
      notes: [],
    },
  };
}

function resolveReopen(ctx: AppContext, args: Args): Resolved | ToolResult {
  const id = args.reopen!.trim();
  if (!DBG_ID_PATTERN.test(id)) return fail({ code: "invalid_argument", message: `reopen must be a dbg_id (dbg_<uuid>), got ${JSON.stringify(args.reopen)}`, argument: "reopen" });
  const source = ctx.sessions.reopenSource(id);
  if (!source) return expiredHandleError(id, "debug_open", { note: "its inputs are no longer kept: pass them again (tx_id + redeemer, or script with context / redeemer_data / datum)" });
  const notes = [`reopened from ${id}: same script, arguments, cost model and ScriptContext; position and breakpoints start over`];
  const others = givenKeys(args, ["tx_id", "redeemer", ...PARTS_ONLY_ARGS]);
  if (others.length > 0) notes.push(`ignored with reopen: ${others.join(", ")}`);
  const cfg = source.partsConfig as Record<string, unknown>;
  if (source.mode === "program") {
    const text = typeof cfg.program === "string" ? cfg.program : undefined;
    if (!text) return fail({ code: "expired_handle", message: `Session ${id} kept no program to reopen; pass script again.`, handle: id, recreate_with: "debug_open" });
    return { mode: "program", program: { source: text, language: source.language }, notes, protocolMajor: ENGINE_DEFAULT_PROTOCOL, protocolSource: "engine_default", reopenedFrom: id };
  }
  const parts = partsFromKept(source);
  const protocolMajor = parts.config.protocol_version;
  return {
    mode: source.mode,
    parts,
    ...(source.txId ? { txId: source.txId } : {}),
    ...(source.redeemer ? { redeemer: source.redeemer } : {}),
    purpose: source.purpose,
    network: source.network,
    notes: [...notes, ...source.notes],
    protocolMajor: protocolMajor ?? ENGINE_DEFAULT_PROTOCOL,
    protocolSource: protocolMajor === undefined ? "engine_default" : source.mode === "tx" ? "protocol_params" : "supplied",
    ...(source.costModelSource ? { costModelSource: source.costModelSource } : {}),
    reopenedFrom: id,
  };
}

async function resolve(ctx: AppContext, args: Args, signal: AbortSignal | undefined): Promise<Resolved | ToolResult> {
  if (args.reopen) return resolveReopen(ctx, args);
  const notes: string[] = [];
  if (args.tx_id) {
    const record = await lookupTxRecord(ctx, args.tx_id);
    if (!record) return expiredHandleError(args.tx_id, "tx_load");
    let redeemerInput = args.redeemer;
    if (!redeemerInput) {
      // One script to step: no need to ask which. Several: say which there are.
      if (record.redeemerTargets.length === 1) {
        redeemerInput = record.redeemerTargets[0]!.ref;
        notes.push(`redeemer not given: ${redeemerInput} is the only redeemer of ${record.txId}`);
      } else {
        return fail({
          code: "invalid_argument",
          message: `tx_id needs \`redeemer\` (which script of the transaction to step); ${record.txId} has ${listRedeemers(record)}.`,
          argument: "redeemer",
          tx_id: record.txId,
          redeemers: record.redeemerTargets.map((t) => ({ ref: t.ref, target: t.target, ...(t.script_hash ? { script_hash: t.script_hash } : {}) })),
        });
      }
    }
    const { ref, purpose } = resolveTxRedeemer(record, redeemerInput);
    let ev = record.validation?.redeemers.get(ref);
    const timedOut = chainStateOf(record)?.timedOut;
    // tx mode needs a finished validation (the applied ScriptContext comes from it); one that already
    // overran its budget would only overrun again here.
    if (!ev && timedOut && timedOut.timeout_ms >= ctx.config.evalTimeoutMs) return validationTimeout(record, ref, timedOut.timeout_ms);
    if (!ev && ctx.services.chain) {
      // The chain layer runs (or reuses) tx_validate so the exact applied bytes are known.
      try {
        await ctx.services.chain.validate(record, { signal });
      } catch (error) {
        if (error instanceof WorkerTimeoutError) return validationTimeout(record, ref, error.timeoutMs);
        return fail({
          code: "not_validated",
          message: `Transaction ${record.txId} could not be validated (${error instanceof Error ? error.message : String(error)}); run tx_validate(tx_id=${JSON.stringify(record.txId)}) to see why, then debug_open again.`,
          tx_id: record.txId,
          redeemer: ref,
          recreate_with: "tx_validate",
        });
      }
      ev = record.validation?.redeemers.get(ref);
    }
    if (!ev) {
      return fail({
        code: record.validation ? "redeemer_not_evaluated" : "not_validated",
        message: record.validation
          ? `tx_validate produced no evaluation for ${ref} (phase 1 may have failed before scripts ran, or a UTxO is missing). Check tx_validate(tx_id=${JSON.stringify(record.txId)}).`
          : `Transaction ${record.txId} has not been validated yet: call tx_validate(tx_id=${JSON.stringify(record.txId)}) first so the exact script / datum / redeemer / ScriptContext bytes are known, then debug_open again.`,
        tx_id: record.txId,
        redeemer: ref,
        recreate_with: "tx_validate",
      });
    }
    const ignored = givenKeys(args, PARTS_ONLY_ARGS);
    if (ignored.length > 0) notes.push(`ignored in tx mode (the validator's own script, arguments, cost model and protocol version are used): ${ignored.join(", ")}`);
    const protocolParams = record.validationContext?.protocolParameters;
    const parts = partsFromEval(ev, protocolParams);
    if (!ev.success) notes.push(`the validator reported this redeemer as failed${ev.error ? `: ${String(ev.error).slice(0, 200)}` : ""}; debug_run(until='error', stop_before=true) lands one transition before the failure`);
    const protocolMajor = parts.meta.protocol_major;
    return {
      mode: "tx",
      parts,
      txId: record.txId,
      redeemer: ref,
      purpose: purpose ?? purposeFromLibTag(ev.tag),
      network: record.network,
      notes: [...notes, ...parts.meta.notes],
      protocolMajor: protocolMajor ?? ENGINE_DEFAULT_PROTOCOL,
      protocolSource: protocolMajor === undefined ? "engine_default" : "protocol_params",
    };
  }
  if (!args.script) throw new ToolInputError("Give tx_id + redeemer, script (+ optional context / redeemer_data / datum / cost_models / ex_units) or reopen=<dbg_id>.", "script");
  if (args.redeemer) notes.push("ignored: redeemer (a transaction redeemer ref such as spend:0; it needs tx_id). The redeemer's PlutusData goes in redeemer_data");
  // A native script such as [1, [...]] starts like a ScriptRef (`8201`): refuse it on the bytes as given, before any normalisation reads them as a program.
  if (!isUplcText(args.script)) {
    const early = await refuseNativeScript(ctx, args.script);
    if (early) return early;
  }
  const prepared = prepareScript(args.script);
  if (!prepared.ok) return prepared.result;
  if (!isUplcText(prepared.source)) {
    const native = await refuseNativeScript(ctx, prepared.source);
    if (native) return native;
  }
  notes.push(...prepared.notes);
  const language: string | undefined = args.plutus_version ?? prepared.stated;
  if (args.plutus_version === undefined && prepared.stated) notes.push(`plutus_version taken from the script's wrapping: ${prepared.stated}`);
  else if (args.plutus_version !== undefined && prepared.stated && parseLanguage(args.plutus_version) !== prepared.stated) notes.push(`plutus_version ${args.plutus_version} was given although the script's wrapping states ${prepared.stated}; ${args.plutus_version} is used`);
  const partsArgs = {
    script: prepared.source,
    plutus_version: language,
    context: args.context,
    redeemer_data: args.redeemer_data,
    datum: args.datum,
    cost_models: args.cost_models,
    protocol_major: args.protocol_major,
    ex_units: args.ex_units,
    purpose: args.purpose,
  };
  if (isProgramOnly(partsArgs)) {
    if (args.allow_program_only === false) throw new ToolInputError("Only `script` was given and allow_program_only=false: add context / redeemer_data / datum, or allow a program-only session.", "allow_program_only");
    const programLanguage = language === undefined || language === "" ? "V3" : parseLanguage(language);
    if (language === undefined) notes.push("plutus_version not given: V3 assumed");
    notes.push("program-only session: no datum / redeemer / context applied; the program runs as written (a validator will wait for its arguments and finish at once)");
    if (args.protocol_major !== undefined) notes.push(`ignored: protocol_major (a program-only session always runs with the engine's protocol ${ENGINE_DEFAULT_PROTOCOL}; add context / redeemer_data / datum / cost_models for a parts session)`);
    return { mode: "program", program: { source: prepared.source, language: programLanguage }, notes, protocolMajor: ENGINE_DEFAULT_PROTOCOL, protocolSource: "engine_default" };
  }
  const parts = partsFromArgs(partsArgs);
  const purpose = args.purpose ? parsePurpose(args.purpose) : undefined;
  const protocolMajor = parts.meta.protocol_major;
  return {
    mode: "parts",
    parts,
    purpose,
    notes: [...notes, ...parts.meta.notes],
    protocolMajor: protocolMajor ?? ENGINE_DEFAULT_PROTOCOL,
    protocolSource: protocolMajor === undefined ? "engine_default" : "supplied",
  };
}

export async function debugOpen(ctx: AppContext, args: Args, signal: AbortSignal | undefined): Promise<ToolResult> {
  const contextLines = clampInt(args.context_lines, DEFAULT_CONTEXT_LINES, 0, MAX_CONTEXT_LINES);
  let resolved: Resolved | ToolResult;
  try {
    resolved = await resolve(ctx, args, signal);
  } catch (error) {
    if (error instanceof PartsError) return fail({ code: "invalid_argument", message: error.message, ...(error.argument ? { argument: error.argument } : {}) });
    return failFromError(error, "engine_error");
  }
  if ("content" in resolved) return resolved;

  const service = engineService(ctx);
  const language: EngineLanguage = resolved.parts ? resolved.parts.meta.language : resolved.program!.language;
  // A program session from compiled bytes keeps them as `script` too, so script_decompile(dbg_id) can decompile it.
  const program = resolved.program;
  const partsConfig: Record<string, unknown> = resolved.parts
    ? { ...resolved.parts.config }
    : { program: program!.source, language, ...(isUplcText(program!.source) ? {} : { script: program!.source }) };
  const costModelSource = resolved.parts?.meta.cost_model_source ?? resolved.costModelSource ?? "engine_default";
  const init: SessionInit = {
    mode: resolved.mode,
    language,
    partsConfig,
    txId: resolved.txId,
    redeemer: resolved.redeemer,
    purpose: resolved.purpose,
    protocolVersion: resolved.protocolMajor,
    network: resolved.network,
    costModelSource,
    calculatedExUnits: resolved.parts?.meta.calculated_ex_units,
    notes: resolved.notes,
  };

  // Nothing is registered, and so nothing evicted, until the engine has opened the session: a call
  // that fails (bad script, engine error) must not cost a healthy session its slot. Only a registry
  // whose every session is executing a command is refused up front, before a worker is spawned.
  try {
    ctx.sessions.assertRoom();
  } catch (error) {
    if (error instanceof SessionLimitError) return sessionLimitError(error);
    throw error;
  }
  const dbgId = ctx.sessions.newId();
  const client = service.newClient({
    onLost: (info) => {
      const lost = lossOf(info);
      ctx.sessions.markLost(dbgId, lost.reason, lost.cause);
    },
  });

  let summary: SessionSummary;
  try {
    summary = resolved.parts ? await client.openParts(resolved.parts.config, contextLines) : await client.openProgram(resolved.program!.source, resolved.program!.language, contextLines);
  } catch (error) {
    void client.close().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    return fail({
      code: /parse|decode|invalid|hex|flat|cbor/i.test(message) ? "invalid_argument" : "engine_error",
      message: `The engine could not open the session: ${message}`,
      mode: resolved.mode,
      ...(resolved.txId ? { tx_id: resolved.txId, redeemer: resolved.redeemer } : {}),
    });
  }

  let created: ReturnType<typeof ctx.sessions.create>;
  try {
    created = ctx.sessions.create({ ...init, dbgId, client, worker: client.host });
  } catch (error) {
    void client.close().catch(() => undefined);
    if (error instanceof SessionLimitError) return sessionLimitError(error);
    throw error;
  }
  const { record, evicted } = created;

  record.scriptHash = summary.script_hash ?? undefined;
  record.termCount = summary.term_count;
  record.termIdBase = summary.term_id_base;
  record.uplcLines = summary.uplc_lines;
  record.hasContext = summary.has_script_context;
  record.declaredExUnits = summary.declared_ex_units ?? undefined;
  record.lastPosition = summary.position;
  record.lastStatus = "ready";
  record.version = summary.version;
  if (!record.purpose && summary.purpose) {
    const p = summary.purpose.toLowerCase();
    record.purpose = (["spending", "spend"].includes(p) ? "spend" : ["minting", "mint"].includes(p) ? "mint" : ["rewarding", "withdraw"].includes(p) ? "withdraw" : ["certifying", "publish"].includes(p) ? "publish" : ["voting", "vote"].includes(p) ? "vote" : ["proposing", "propose"].includes(p) ? "propose" : undefined) as Purpose | undefined;
  }

  const fidelity =
    resolved.mode === "tx"
      ? { level: "tx", description: "same script / datum / redeemer / ScriptContext bytes the validator applied, with the cost model and protocol version of this transaction; steps reproduce the validation" }
      : resolved.mode === "parts"
        ? { level: "parts", description: "script applied to the supplied arguments; cost model " + (record.costModelSource === "supplied" ? "supplied" : record.costModelSource === "protocol_params" ? "from protocol parameters" : "engine default") }
        : { level: "program", description: "bare program, no arguments; budget has no declared limit" };

  // script_decompile(dbg_id) needs compiled bytes: a session opened from UPLC text has none.
  const bytes = typeof partsConfig.script === "string" && !isUplcText(partsConfig.script);
  const body: Record<string, unknown> = {
    dbg_id: record.dbgId,
    mode: record.mode,
    script_hash: summary.script_hash,
    plutus_version: summary.language,
    plutus_core_version: summary.plutus_core_version,
    purpose: record.purpose ?? (summary.purpose ? summary.purpose.toLowerCase() : null),
    purpose_label: summary.purpose,
    protocol_major: resolved.protocolMajor,
    protocol_major_source: resolved.protocolSource,
    cost_model_source: record.costModelSource,
    declared_ex_units: summary.declared_ex_units ? { steps: summary.declared_ex_units.cpu, mem: summary.declared_ex_units.mem } : null,
    term_count: summary.term_count,
    term_id_base: summary.term_id_base,
    uplc_lines: summary.uplc_lines,
    position: shapePosition(summary.position),
    uplc_window: summary.uplc_window.text,
    ...(summary.uplc_window.dedent > 0 ? { uplc_window_dedent: summary.uplc_window.dedent } : {}),
    fidelity,
    applied: resolved.parts?.meta.applied ?? [],
    has_script_context: summary.has_script_context,
    expires_at: expiresAtIso(record, ctx.sessions.limits.idleTtlMs),
    version: summary.version,
    limits: { idle_ttl_min: Math.round(ctx.sessions.limits.idleTtlMs / 60000), absolute_ttl_h: Math.round(ctx.sessions.limits.absoluteTtlMs / 3600000), max_sessions: ctx.sessions.limits.max },
    notes: record.notes,
    docs_hint:
      "docs(topic='debug-playbook') and docs(topic='uplc-cek') explain the workflow and the machine states; " +
      (bytes ? "script_decompile(dbg_id) gives the validator's logic as readable pseudocode" : "this session was opened from UPLC text: script_decompile(dbg_id) answers no_script_bytes, pass the compiled script bytes via script"),
  };
  if (record.txId) {
    body.tx_id = record.txId;
    body.redeemer = record.redeemer;
  }
  if (resolved.reopenedFrom) body.reopened_from = resolved.reopenedFrom;
  if (record.calculatedExUnits) body.validator_calculated_ex_units = record.calculatedExUnits;
  if (evicted) {
    body.evicted = {
      dbg_id: evicted.dbgId,
      reason: evicted.lost || evicted.poisoned ? "lost" : "lru",
      note: evicted.lost || evicted.poisoned ? `a lost session was dropped to stay within ${ctx.sessions.limits.max} sessions` : `the least recently used idle session was closed to stay within ${ctx.sessions.limits.max} sessions`,
    };
  }
  return ok(body, { links: sessionLinks(record.dbgId, "open") });
}

export const debugOpenTool: ToolModule = {
  name: "debug_open",
  register(server: McpServer, ctx: AppContext) {
    server.registerTool(
      "debug_open",
      {
        title: T.title,
        description: T.description,
        inputSchema,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      async (args, extra) => debugOpen(ctx, args, extra?.mcpReq?.signal),
    );
  },
};
