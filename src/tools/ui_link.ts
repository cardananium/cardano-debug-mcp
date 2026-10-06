// ui_link: a deep link into cquisitor (transaction validator, Cardano CBOR, general CBOR, CDDL
// validator) or de-uplc-web (debugger, decompiler) carrying annotations — targets the app highlights,
// each with a label and hint — built from a loaded tx, bytes / a schema, a debug session or a script.
// The caller's annotations are validated (every rejected entry is reported with its reason, and a
// target that points at nothing the server can see is dropped with a hint of what exists); `from`
// adds generated ones. `open` hands the URL to the OS opener. The URL is answered inline up to
// UI_LINK_INLINE_CHARS; it is always written to `link_file` and served as
// cardano-debug://link/{link_id}/url.txt.

import type { McpServer } from "@modelcontextprotocol/server";
import type { EvalRedeemerResult } from "@cardananium/cquisitor-lib";
import { fieldsFromDecompile, fieldsFromEval, fieldsToDecompileUrl, fieldsToUrl, type DecompileFields, type DeUplcFields } from "@cardananium/cquisitor-lib/handoff/deUplcLink";
import type { Annotation, CquisitorTarget, DeUplcTarget, TabId } from "@cardananium/cquisitor-lib/share";
import { encodeCardanoCborLink, encodeCddlLink, encodeGeneralCborLink } from "@cardananium/cquisitor-lib/share/encoder";
import * as z from "zod/v4";

import type { ErrorRow, StructuralError } from "../cbor/diagnostics.js";
import { ERA_PRESETS, isEraPreset, resolveSchemaInput, type SchemaSource } from "../cbor/presets.js";
import { loadSchemaInfo } from "../cbor/schema.js";
import { contextNote, cquisitorTxUrl, inlineUrl, UI_LINK_INLINE_CHARS } from "../chain/links.js";
import { chainStateOf } from "../chain/state.js";
import type { AppContext, ToolModule } from "../context.js";
import { OptionsError, type UserDecompileOptions } from "../decompiler/options.js";
import { resolveScript, type ResolvedScript } from "../decompiler/resolve.js";
import { getDecompilerService } from "../decompiler/service.js";
import type { PositionReport } from "../engine/protocol.js";
import { expiredHandleError, type SessionRecord } from "../store/sessionRegistry.js";
import type { TxRecord } from "../store/txStore.js";
import { lookupTxRecord } from "../tx/record.js";
import { checkAnnotations, type AnyAnnotation, type TargetResolver, type UiApp } from "../ui/annotations.js";
import { AUTO_MAX, cborErrorAnnotations, errorTermOfSession, failingTermAnnotation, failureOfRedeemer, noFailingTermNote, positionTerm, profileAnnotations, profileOfRedeemer, profileOfSession, termAnnotation, validationAnnotations, type FailingTerm } from "../ui/autoAnnotations.js";
import { linkResourceUri, uiLinkStore, writeLinkFile } from "../ui/linkStore.js";
import { openUrl } from "../ui/opener.js";
import { cborTargetResolver, loadTree, ownKinds, programTargetResolver, pseudocodeTargetResolver, txTargetResolver, type ProgramShape } from "../ui/targets.js";
import { dehoskPurposeFromPurpose } from "../vocab/purpose.js";
import { WorkerTimeoutError } from "../workers/rpc.js";
import { chain, signalOf } from "./_chain.js";
import { leaseSession } from "./_debug.js";
import { cborValidate } from "./cbor_validate.js";
import { fail, failFromError, normalizeBytesInput, ok, ToolInputError, type ToolResult } from "./_shared.js";
import { providerFailure } from "./tx_load.js";
import { resolveRedeemer } from "./tx_redeemer.js";
import { TOOL_TEXT } from "./descriptions.js";

const T = TOOL_TEXT.ui_link;

export const UI_APPS = ["cquisitor", "de_uplc", "decompiler"] as const;
export const UI_TABS = ["transaction-validator", "cardano-cbor", "general-cbor", "cddl-validator"] as const;
export const FROM_SOURCES = ["validation", "cbor_errors", "session", "profile"] as const;
type FromSource = (typeof FROM_SOURCES)[number];

/** Keys script_decompile's `options` accepts. */
const DECOMPILE_OPTION_KEYS = new Set(["strip_all_traces", "strip_plutustx_traces", "decode_church_to_native", "expect_or_fail", "synthesize_stub_adts", "safe_mode", "compilable_data_access", "split_purposes", "applied_kind", "raw"]);
/** cbor_validate rows read for from='cbor_errors'. */
const CBOR_ERROR_ROWS = 20;

export const uiLinkInputSchema = z.object({
  app: z.enum(UI_APPS).describe(T.params["app"]),
  tab: z.enum(UI_TABS).optional().describe(T.params["tab"]),
  tx_id: z.string().optional().describe(T.params["tx_id"]),
  redeemer: z.string().optional().describe(T.params["redeemer"]),
  dbg_id: z.string().optional().describe(T.params["dbg_id"]),
  script: z.string().optional().describe(T.params["script"]),
  plutus_version: z.string().optional().describe(T.params["plutus_version"]),
  cbor: z.string().optional().describe(T.params["cbor"]),
  network: z.enum(["mainnet", "preprod", "preview"]).optional().describe(T.params["network"]),
  cddl: z.string().optional().describe(T.params["cddl"]),
  rule: z.string().optional().describe(T.params["rule"]),
  preset: z.string().optional().describe(T.params["preset"]),
  annotations: z.array(z.unknown()).optional().describe(T.params["annotations"]),
  from: z.array(z.enum(FROM_SOURCES)).optional().describe(T.params["from"]),
  focus: z.number().int().min(0).max(1_000).optional().describe(T.params["focus"]),
  open: z.boolean().optional().describe(T.params["open"]),
  decompile_options: z.record(z.string(), z.unknown()).optional().describe(T.params["decompile_options"]),
});

export type UiLinkArgs = z.infer<typeof uiLinkInputSchema>;

/** What a source produced: how to encode the URL once the annotations are final, generated annotations, notes. */
interface Built {
  tab?: TabId;
  generated: AnyAnnotation[];
  /** Appended to by the resolver and by `encode`: read after both ran. */
  notes: string[];
  /** Resolves the caller's targets against what the server knows; `kinds` are the target kinds the caller gave. */
  resolver?: (kinds: Set<string>) => Promise<TargetResolver>;
  encode: (annotations: AnyAnnotation[], focus: number) => Promise<string>;
}

type Outcome = Built | ToolResult;
const isResult = (value: Outcome): value is ToolResult => "content" in value;

const invalid = (message: string, argument?: string): ToolResult => fail({ code: "invalid_argument", message, ...(argument ? { argument } : {}) });

function given(args: UiLinkArgs, keys: Array<keyof UiLinkArgs>): Array<keyof UiLinkArgs> {
  return keys.filter((k) => args[k] !== undefined && args[k] !== "");
}

/** The record of a tx_id, validated (context loaded first); a failure result when that cannot happen. */
async function validatedRecord(ctx: AppContext, txId: string, extra: unknown): Promise<{ record: TxRecord } | ToolResult> {
  const record = await lookupTxRecord(ctx, txId);
  if (!record) return expiredHandleError(txId.trim(), "tx_load");
  const service = chain(ctx);
  const signal = signalOf(extra);
  const common = { tx_id: record.txId };
  try {
    if (!chainStateOf(record)?.context) await service.loadContext(record, { signal });
  } catch (error) {
    return providerFailure(error, common) ?? failFromError(error);
  }
  const state = chainStateOf(record);
  if (state && state.missingUtxos.length > 0) {
    return fail({ ...common, code: "incomplete_context", message: `Cannot validate: ${state.missingUtxos.length} UTxO(s) were not resolved; see tx_validate.`, missing_utxos: state.missingUtxos.slice(0, 10) });
  }
  if (!record.validation) {
    try {
      await service.validate(record, { signal });
    } catch (error) {
      if (error instanceof WorkerTimeoutError) return fail({ ...common, code: "timeout", message: `Validation exceeded ${error.timeoutMs} ms; run tx_validate with a larger timeout_ms first.` });
      return providerFailure(error, common) ?? failFromError(error);
    }
  }
  return { record };
}

// ---------- cquisitor ----------

function defaultTab(args: UiLinkArgs): TabId | undefined {
  if (args.tab) return args.tab;
  if (args.cddl !== undefined || args.preset !== undefined || args.rule !== undefined) return "cddl-validator";
  if (args.tx_id) return "transaction-validator";
  if (args.cbor) return "general-cbor";
  return undefined;
}

/** cbor_validate's structured answer for the bytes / schema / rule. */
async function runCborValidate(ctx: AppContext, hex: string, cddl: string | undefined, rule: string | undefined): Promise<{ answer: Record<string, unknown> } | ToolResult> {
  const result = await cborValidate(ctx, { hex, cddl, rule, max_errors: CBOR_ERROR_ROWS, decode: false });
  if (result.isError) return result;
  return { answer: result.structuredContent };
}

async function cquisitorLink(ctx: AppContext, args: UiLinkArgs, from: Set<FromSource>, extra: unknown): Promise<Outcome> {
  const extraneous = given(args, ["redeemer", "dbg_id", "script", "plutus_version", "decompile_options"]);
  if (extraneous.length > 0) return invalid(`${extraneous.join(", ")} do not apply to app='cquisitor' (they belong to de_uplc / decompiler).`, extraneous[0]);
  const tab = defaultTab(args);
  if (!tab) return invalid("Give a source for cquisitor: tx_id (transaction validator), cbor (CBOR tabs) or cbor + cddl / rule / preset (CDDL tab).", "tx_id");
  const notes: string[] = [];
  const generated: AnyAnnotation[] = [];
  const base = ctx.config.cquisitorBase;
  const otherFrom = (kinds: FromSource[], where: TabId = tab) => kinds.filter((k) => from.has(k)).forEach((k) => notes.push(`from='${k}' does not apply to the ${where} tab`));
  if (args.network && tab !== "cardano-cbor") notes.push(`network applies to the cardano-cbor tab only (the ${tab} tab does not use it)`);

  if (tab === "transaction-validator") {
    if (!args.tx_id) return invalid("The transaction-validator tab needs tx_id (tx_load the transaction first).", "tx_id");
    if (args.cbor || args.cddl !== undefined || args.preset !== undefined || args.rule !== undefined) return invalid("cbor / cddl / rule / preset belong to the CBOR and CDDL tabs, not to the transaction validator.", "tab");
    let record: TxRecord | undefined;
    if (from.has("validation")) {
      const validated = await validatedRecord(ctx, args.tx_id, extra);
      if ("content" in validated) return validated;
      record = validated.record;
      const auto = validationAnnotations(record);
      generated.push(...auto.annotations);
      if (auto.total === 0) notes.push("from='validation': the validation reports no errors or warnings");
      if (auto.total > auto.annotations.length) notes.push(`from='validation': ${auto.total} targets, the first ${auto.annotations.length} kept`);
    } else {
      record = await lookupTxRecord(ctx, args.tx_id);
      if (!record) return expiredHandleError(args.tx_id.trim(), "tx_load");
    }
    otherFrom(["cbor_errors", "session", "profile"]);
    const rec = record;
    return {
      tab,
      generated,
      notes,
      resolver: async () => txTargetResolver(rec, notes),
      encode: async (annotations, focus) => {
        const built = await cquisitorTxUrl(ctx.config, rec, annotations as Annotation<CquisitorTarget>[], focus);
        const note = contextNote(built);
        if (note) notes.push(`the link ${note}`);
        return built.url;
      },
    };
  }

  // CBOR tabs: the bytes come from `cbor` or the loaded transaction.
  let hex: string | undefined;
  let network: TxRecord["network"] | undefined = args.network;
  let fromTx = false;
  if (args.tx_id) {
    const record = await lookupTxRecord(ctx, args.tx_id);
    if (!record) return expiredHandleError(args.tx_id.trim(), "tx_load");
    if (args.network && args.network !== record.network) notes.push(`network ${args.network} ignored: the transaction ${record.txId} is on ${record.network}`);
    network = record.network;
    if (!args.cbor) {
      hex = record.txHex;
      fromTx = true;
    }
  }
  if (args.cbor) {
    const normalized = normalizeBytesInput(args.cbor);
    if (normalized.kind === "bech32" || normalized.kind === "text") return invalid("cbor must be hex, base64 or a cardano-cli envelope.", "cbor");
    hex = normalized.value;
  }
  if (!hex) return invalid(`The ${tab} tab needs cbor (or tx_id for the transaction bytes).`, "cbor");
  const bytes = hex;
  const inputBytes = bytes.length / 2;
  /** Resolver of byte / path targets: the positional tree is read only when a cbor_path asks for it. */
  const bytesResolver = (schema?: { chars: number; rules?: readonly string[] }) => async (given: Set<string>): Promise<TargetResolver> => {
    const loaded = given.has("cbor_path") ? await loadTree(ctx, bytes) : { partial: false as const };
    return cborTargetResolver({ hex: bytes, schema, tree: loaded.tree, partial: loaded.partial }, notes);
  };
  /** cbor_validate's view of the bytes alone: the structural error as a span. */
  const structuralAnnotations = (structural: StructuralError) => cborErrorAnnotations({ structural, rows: [], withCddlRange: false, inputBytes });

  if (tab === "cardano-cbor") {
    if (args.cddl !== undefined || args.preset !== undefined || args.rule !== undefined) return invalid("cddl / rule / preset belong to the cddl-validator tab.", "tab");
    otherFrom(["validation", "cbor_errors", "session", "profile"]);
    if (!network) notes.push("network not given: the bytes are tagged mainnet (pass network for preprod / preview)");
    const net = network ?? "mainnet";
    const type = fromTx ? "Transaction" : undefined;
    return {
      tab,
      generated,
      notes,
      encode: (annotations, focus) => encodeCardanoCborLink(base, { cbor: bytes, net, ...(type ? { type } : {}), annotations: annotations as Annotation<CquisitorTarget>[], annotationFocus: focus }, { kind: "compressed" }),
    };
  }

  const generalCbor = (): Built => ({
    tab: "general-cbor",
    generated,
    notes,
    resolver: bytesResolver(),
    encode: (annotations, focus) => encodeGeneralCborLink(base, { cbor: bytes, annotations: annotations as Annotation<CquisitorTarget>[], annotationFocus: focus }, { kind: "compressed" }),
  });

  if (tab === "general-cbor") {
    if (args.cddl !== undefined || args.preset !== undefined || args.rule !== undefined) return invalid("cddl / rule / preset belong to the cddl-validator tab.", "tab");
    if (from.has("cbor_errors")) {
      const run = await runCborValidate(ctx, bytes, undefined, undefined);
      if ("content" in run) return run;
      const structural = run.answer.structural_error as StructuralError | undefined;
      if (structural) generated.push(...structuralAnnotations(structural));
      else notes.push("from='cbor_errors': the bytes are well-formed CBOR; schema mismatches need the cddl-validator tab (pass cddl / rule / preset)");
    }
    otherFrom(["validation", "session", "profile"]);
    return generalCbor();
  }

  // cddl-validator
  if (args.preset !== undefined && args.cddl !== undefined) return invalid("Pass cddl (embedded schema) or preset (the app's own copy), not both.", "preset");
  let preset: string | undefined;
  let source: SchemaSource;
  let validateWith: string | undefined;
  const own = ownKinds(args.annotations ?? []);
  const needsText = own.has("cddl_range") || own.has("cddl_rule");
  if (args.preset !== undefined) {
    const era = args.preset.trim().toLowerCase();
    if (!isEraPreset(era) || era === "dijkstra") return invalid(`preset must be one of ${ERA_PRESETS.filter((e) => e !== "dijkstra").join(", ")} (the presets cquisitor ships); for other schemas pass cddl.`, "preset");
    preset = era;
    validateWith = era;
    source = resolveSchemaInput(era);
  } else {
    try {
      source = resolveSchemaInput(args.cddl);
    } catch (error) {
      return failFromError(error, "invalid_argument");
    }
    validateWith = args.cddl;
    // An era schema travels as the app's own preset (a few hundred characters instead of ~23 KB) unless a schema target needs the text.
    if (source.origin === "preset" && source.era && source.era !== "dijkstra" && !needsText) {
      preset = source.era;
      validateWith = source.era;
    }
  }
  const schemaText = preset === undefined ? source.text : "";
  let rule = args.rule?.trim() || undefined;
  if (from.has("cbor_errors") || !rule) {
    const run = await runCborValidate(ctx, bytes, validateWith, rule);
    if ("content" in run) return run;
    const schema = (run.answer.schema ?? {}) as { rule?: string };
    const structural = run.answer.structural_error as StructuralError | undefined;
    rule = rule ?? schema.rule;
    if (!rule && structural) {
      // no rule applies to bytes that are not CBOR: the general tab shows the structural error
      notes.push("the bytes are not well-formed CBOR, so no schema rule applies: this link opens the general-cbor tab (give rule to keep the cddl-validator tab)");
      if (from.has("cbor_errors")) generated.push(...structuralAnnotations(structural));
      otherFrom(["validation", "session", "profile"], "general-cbor");
      return generalCbor();
    }
    if (from.has("cbor_errors")) {
      const rows = (run.answer.errors ?? []) as ErrorRow[];
      generated.push(...cborErrorAnnotations({ structural, rows, withCddlRange: preset === undefined, inputBytes }));
      const more = Number(run.answer.additional_count ?? 0);
      if (more > 0) notes.push(`from='cbor_errors': ${more} more error(s) not shown (the first ${rows.length} rows were read); fix these, or read cbor_validate for the rest`);
      if (run.answer.valid === true) notes.push(`from='cbor_errors': the bytes are a valid ${rule}`);
      if (preset !== undefined && rows.some((r) => r.cddl_range)) notes.push("from='cbor_errors': no cddl_range targets while the link names the app's preset (its copy of the era schema may differ from the server's); pass a cddl_range or cddl_rule annotation, or a cddl text, to embed the schema");
    }
  }
  if (!rule) return invalid("No root rule admits these bytes: pass rule (cddl_check lists the roots of the schema).", "rule");
  otherFrom(["validation", "session", "profile"]);
  const finalRule = rule;
  return {
    tab,
    generated,
    notes,
    resolver: async (given) => {
      const rules = given.has("cddl_rule") ? (await loadSchemaInfo(ctx.lib, source)).declared : undefined;
      return bytesResolver({ chars: source.text.length, rules })(given);
    },
    encode: (annotations, focus) =>
      encodeCddlLink(base, { cddl: schemaText, cbor: bytes, rule: finalRule, preset: preset ?? null, annotations: annotations as Annotation<CquisitorTarget>[], annotationFocus: focus }, { kind: "compressed" }),
  };
}

// ---------- de-uplc-web ----------

function deUplcSourceCheck(args: UiLinkArgs): ToolResult | undefined {
  const extraneous = given(args, ["tab", "cbor", "network", "cddl", "rule", "preset"]);
  if (extraneous.length > 0) return invalid(`${extraneous.join(", ")} ${extraneous.length === 1 ? "applies" : "apply"} only to app='cquisitor'.`, extraneous[0]);
  const sources = given(args, ["tx_id", "dbg_id", "script"]);
  if (sources.length !== 1) return invalid(`Give exactly one source for app='${args.app}': tx_id + redeemer, dbg_id or script${sources.length ? ` (got ${sources.join(", ")})` : ""}.`, sources[1] ?? "tx_id");
  if (args.tx_id && !args.redeemer) return invalid("With tx_id also pass redeemer (e.g. spend:0).", "redeemer");
  if (args.redeemer && !args.tx_id) return invalid("redeemer goes with tx_id.", "redeemer");
  if (args.plutus_version && !args.script) return invalid("plutus_version goes with script.", "plutus_version");
  if (args.decompile_options && args.app !== "decompiler") return invalid("decompile_options apply to app='decompiler'.", "decompile_options");
  return undefined;
}

/**
 * The session's annotations: the failing term (error; it survives a rewind) and, when the machine
 * stands elsewhere, the current position (info).
 */
async function sessionAnnotations(ctx: AppContext, dbgId: string): Promise<{ annotations: Annotation<DeUplcTarget>[]; notes: string[] } | ToolResult> {
  const lease = leaseSession(ctx, dbgId);
  if (!lease.ok) return lease.result;
  try {
    const record = lease.record;
    const client = record.client!;
    const report = (await client.position(0, 0, [])) as PositionReport;
    const current = positionTerm(report.position);
    const traces = await client.tracesAll().catch(() => [] as string[]);
    const lastTrace = traces.length > 0 ? traces[traces.length - 1] : undefined;
    // standing on the error: the live position; else what the session kept of its run to the error
    const failing: FailingTerm | undefined = report.status === "error" && current !== null ? { termId: current, exact: report.position.term_id !== null } : errorTermOfSession(record);
    const txError = record.txId && record.redeemer ? ctx.txStore.peek(record.txId)?.validation?.redeemers.get(record.redeemer)?.error : undefined;
    const annotations: Annotation<DeUplcTarget>[] = [];
    const notes: string[] = [];
    if (failing) annotations.push(failingTermAnnotation(failing, "the script", report.error_message ?? txError, lastTrace));
    if (current !== null && current !== failing?.termId) annotations.push(termAnnotation(current, `current position (${report.status})`, lastTrace ? `last trace: ${lastTrace}` : undefined, "info"));
    if (!failing && current === null) notes.push("from='session': the session has no current term");
    else if (!failing && report.status !== "error") notes.push(record.errorTermId === null ? "from='session': the run to the error failed without a term of its own (a builtin or machine error): only the current position is marked" : "from='session': this session has not stopped on an error; only its current position is marked (debug_run(until='error') finds the failing term)");
    return { annotations, notes };
  } finally {
    lease.release();
  }
}

/** DeUplcFields of a session's program and arguments. */
function sessionFields(session: SessionRecord): DeUplcFields | string {
  const parts = session.partsConfig;
  const script = typeof parts.script === "string" ? parts.script : undefined;
  if (!script) return "the session was opened from UPLC text; de-uplc-web needs the compiled script bytes (pass script instead)";
  const fields: DeUplcFields = { script, v: session.language.toLowerCase() as DeUplcFields["v"] };
  if (typeof parts.context === "string") fields.context = parts.context;
  if (typeof parts.redeemer === "string") fields.redeemer = parts.redeemer;
  if (typeof parts.datum === "string") fields.datum = parts.datum;
  if (Array.isArray(parts.ex_units) && parts.ex_units.length === 2) fields.exUnits = [Number(parts.ex_units[0]), Number(parts.ex_units[1])];
  return fields;
}

function versionLower(script: ResolvedScript): "v1" | "v2" | "v3" {
  return script.version.toLowerCase() as "v1" | "v2" | "v3";
}

async function resolved(ctx: AppContext, args: Parameters<typeof resolveScript>[1]): Promise<{ script: ResolvedScript } | ToolResult> {
  const result = await resolveScript(ctx, args);
  return result.ok ? { script: result.script } : result.result;
}

/** Term / line counts of the program, from the session that holds it (the given one, or any open one of the same redeemer / script). */
function programShape(ctx: AppContext, match: { session?: SessionRecord; txId?: string; redeemer?: string; script?: string }): ProgramShape {
  const live =
    match.session ??
    ctx.sessions.list().find((s) => (match.txId !== undefined && s.txId === match.txId && s.redeemer === match.redeemer) || (match.script !== undefined && typeof s.partsConfig.script === "string" && s.partsConfig.script.toLowerCase() === match.script.toLowerCase()));
  return live ? { terms: live.termCount, lines: live.uplcLines } : {};
}

async function deUplcLink(ctx: AppContext, args: UiLinkArgs, from: Set<FromSource>, extra: unknown): Promise<Outcome> {
  const bad = deUplcSourceCheck(args);
  if (bad) return bad;
  const notes: string[] = [];
  const generated: AnyAnnotation[] = [];
  const base = ctx.config.deUplcBase;
  let fields: DeUplcFields;
  let shape: ProgramShape;

  if (args.tx_id) {
    const validated = await validatedRecord(ctx, args.tx_id, extra);
    if ("content" in validated) return validated;
    const record = validated.record;
    const target = resolveRedeemer(record, args.redeemer!);
    const ev = record.validation?.redeemers.get(target.ref);
    if (!ev) return fail({ code: "no_eval_result", message: `The validator produced no evaluation result for ${target.ref} (see tx_validate).`, tx_id: record.txId, redeemer: target.ref });
    const link = fieldsFromEval(ev as unknown as EvalRedeemerResult);
    if (!link.ok) return fail({ code: "link_unavailable", message: `No de-uplc link for ${target.ref}: ${link.reason}`, tx_id: record.txId, redeemer: target.ref });
    fields = link.fields;
    if (link.fidelity === "program-only") notes.push("program-only link (no ScriptContext bytes in the eval result)");
    if (from.has("validation") || from.has("session")) {
      const known = ev.success ? undefined : failureOfRedeemer(ctx.sessions, record.txId, target.ref);
      if (known?.failing) generated.push(failingTermAnnotation(known.failing, target.ref, ev.error, ev.logs?.at(-1)));
      else notes.push(ev.success ? `${target.ref} succeeded: no failing term to annotate` : noFailingTermNote(known?.withoutTerm ?? false));
    }
    if (from.has("profile")) {
      const hot = profileOfRedeemer(ctx.sessions, record.txId, target.ref);
      if (hot) generated.push(...profileAnnotations(hot));
      else notes.push(`from='profile': no profile of ${target.ref} yet: debug_open + debug_profile, then call ui_link again (or use dbg_id)`);
    }
    shape = programShape(ctx, { txId: record.txId, redeemer: target.ref });
  } else if (args.dbg_id) {
    const session = ctx.sessions.get(args.dbg_id.trim());
    if (!session) return expiredHandleError(args.dbg_id.trim(), "debug_open");
    const built = sessionFields(session);
    if (typeof built === "string") return fail({ code: "link_unavailable", message: built, dbg_id: session.dbgId });
    fields = built;
    if (session.mode === "program") notes.push("program-only session: the link carries the program without arguments");
    if (from.has("session")) {
      const auto = await sessionAnnotations(ctx, session.dbgId);
      if ("content" in auto) return auto;
      generated.push(...auto.annotations);
      notes.push(...auto.notes);
    }
    if (from.has("profile")) {
      const hot = profileOfSession(session);
      if (hot) {
        generated.push(...profileAnnotations(hot));
        if (hot.outcome !== "done" && hot.outcome !== "error") notes.push(`from='profile': the profile run ended '${hot.outcome}': the shares are partial`);
      } else notes.push("from='profile': run debug_profile on this session first");
    }
    if (from.has("validation")) notes.push("from='validation' needs tx_id + redeemer; with dbg_id use from=['session']");
    shape = programShape(ctx, { session });
  } else {
    const script = await resolved(ctx, { script: args.script, plutus_version: args.plutus_version });
    if ("content" in script) return script;
    fields = { script: script.script.singleHex, v: versionLower(script.script) };
    notes.push("program-only link: no datum / redeemer / context");
    if (!script.script.versionCertain) notes.push(`the Plutus version is not stated (V1 and V2 scripts look alike): the link says ${fields.v}; pass plutus_version to pin it`);
    for (const k of from) notes.push(`from='${k}' needs ${k === "session" || k === "profile" ? "dbg_id" : "tx_id + redeemer"}`);
    shape = programShape(ctx, { script: script.script.singleHex });
  }
  if (from.has("cbor_errors")) notes.push("from='cbor_errors' applies to the cquisitor CBOR / CDDL tabs");
  const launch = fields;
  return {
    generated,
    notes,
    resolver: async () => programTargetResolver(shape, notes),
    encode: (annotations, focus) => fieldsToUrl({ ...launch, annotations: annotations as Annotation<DeUplcTarget>[], annotationFocus: focus }, base),
  };
}

function decompileUserOptions(raw: Record<string, unknown> | undefined): UserDecompileOptions | undefined {
  if (!raw) return undefined;
  const unknown = Object.keys(raw).filter((k) => !DECOMPILE_OPTION_KEYS.has(k));
  if (unknown.length > 0) throw new OptionsError(`decompile_options has no option ${unknown.map((k) => `'${k}'`).join(", ")} (accepted: ${[...DECOMPILE_OPTION_KEYS].join(", ")}).`, "decompile_options");
  return raw as UserDecompileOptions;
}

async function decompilerLink(ctx: AppContext, args: UiLinkArgs, from: Set<FromSource>, extra: unknown): Promise<Outcome> {
  const bad = deUplcSourceCheck(args);
  if (bad) return bad;
  const notes: string[] = [];
  let script: ResolvedScript;
  if (args.tx_id) {
    const validated = await validatedRecord(ctx, args.tx_id, extra);
    if ("content" in validated) return validated;
    const record = validated.record;
    const target = resolveRedeemer(record, args.redeemer!);
    const hash = chainStateOf(record)?.scriptHashes[target.ref]?.script_hash ?? target.script_hash;
    const ev = record.validation?.redeemers.get(target.ref);
    let found = hash ? await resolved(ctx, { tx_id: record.txId, script_hash: hash, purpose: target.purpose }) : undefined;
    if ((!found || "content" in found) && ev?.script_bytes) found = await resolved(ctx, { script: ev.script_bytes, plutus_version: ev.plutus_version ?? undefined, purpose: target.purpose });
    if (!found) return fail({ code: "script_not_found", message: `No script bytes for ${target.ref}.`, tx_id: record.txId, redeemer: target.ref });
    if ("content" in found) return found;
    script = found.script;
  } else {
    const found = await resolved(ctx, args.dbg_id ? { dbg_id: args.dbg_id } : { script: args.script, plutus_version: args.plutus_version });
    if ("content" in found) return found;
    script = found.script;
  }
  for (const k of from) notes.push(`from='${k}' has no decompiler targets (pseudocode lines are not debugger positions); pass pseudo_line annotations from script_decompile`);
  const service = getDecompilerService(ctx);
  const options = await service.buildOptions({ view: "pseudocode", scriptVersion: script.versionCertain ? script.version : undefined, purpose: script.purpose, user: decompileUserOptions(args.decompile_options) });
  const fields: DecompileFields | null = fieldsFromDecompile({ hex: script.singleHex, version: script.versionCertain ? script.version : undefined, purpose: script.purpose ? dehoskPurposeFromPurpose(script.purpose) : undefined });
  if (!fields) return fail({ code: "link_unavailable", message: "The script bytes could not be normalised for the decompiler link." });
  const launch: DecompileFields = { ...fields, options: options.bag };
  if (!script.versionCertain) notes.push("the Plutus version is not stated: the link leaves it to the decompiler's detection; pass plutus_version (or tx_id) to pin it");
  const lineCount = service.cache.get(script.scriptHash, options.hash)?.lines.length;
  return {
    generated: [],
    notes,
    resolver: async () => pseudocodeTargetResolver(lineCount, notes),
    encode: (annotations, focus) => fieldsToDecompileUrl({ ...launch, annotations: annotations as Annotation<DeUplcTarget>[], annotationFocus: focus }, ctx.config.deUplcBase),
  };
}

// ---------- the tool ----------

export async function uiLink(ctx: AppContext, args: UiLinkArgs, extra?: unknown): Promise<ToolResult> {
  const app = args.app as UiApp;
  const from = new Set<FromSource>(args.from ?? []);
  try {
    const built = app === "cquisitor" ? await cquisitorLink(ctx, args, from, extra) : app === "de_uplc" ? await deUplcLink(ctx, args, from, extra) : await decompilerLink(ctx, args, from, extra);
    if (isResult(built)) return built;
    const own = args.annotations ?? [];
    const generated = built.generated.slice(0, AUTO_MAX);
    if (built.generated.length > generated.length) built.notes.push(`${built.generated.length} annotations generated, the first ${generated.length} kept`);
    // only the caller's entries are resolved: the generated ones come from the server's own answers
    const resolver = own.length > 0 && built.resolver ? await built.resolver(ownKinds(own)) : undefined;
    const resolve: TargetResolver | undefined = resolver ? (target, index) => (index < own.length ? resolver(target, index) : undefined) : undefined;
    const checked = checkAnnotations([...own, ...generated], app, built.tab, args.focus ?? 0, resolve);
    const dropped = checked.dropped.map((d) => (d.index >= own.length ? { ...d, reason: `generated: ${d.reason}` } : d));
    const notes = built.notes;
    if (checked.clipped > 0) notes.push(`${checked.clipped} label / hint text(s) cut to the length limits (label 80, hint 2000)`);
    if (args.focus !== undefined) {
      const lost = dropped.find((d) => d.index === args.focus);
      if (lost) notes.push(`focus ${args.focus} pointed at a dropped annotation (${lost.reason}); ${checked.annotations.length > 0 ? "the next kept one is focused" : "nothing is focused"}`);
      else if (args.focus >= own.length + generated.length && checked.annotations.length > 0) notes.push(`focus ${args.focus} is past the last annotation; the last one is focused`);
    }
    const url = await built.encode(checked.annotations, checked.focus);
    const linkId = uiLinkStore(ctx).put(url);
    const resource = linkResourceUri(linkId);
    const file = writeLinkFile(ctx.config.cacheDir, linkId, url);
    let opened = { opened: false } as Awaited<ReturnType<typeof openUrl>>;
    if (args.open) {
      opened = await openUrl(ctx, url);
      if (opened.note) notes.push(opened.note);
    }
    return ok({
      url: inlineUrl(url, resource, { cap: UI_LINK_INLINE_CHARS, file: file !== undefined }),
      url_length: url.length,
      app,
      ...(built.tab ? { tab: built.tab } : {}),
      annotations_count: checked.annotations.length,
      ...(checked.annotations.length > 0 ? { focus: checked.focus } : {}),
      dropped,
      opened: opened.opened,
      ...(opened.open_error ? { open_error: opened.open_error } : {}),
      notes,
      link_resource: resource,
      ...(file ? { link_file: file } : {}),
    });
  } catch (error) {
    if (error instanceof OptionsError) return invalid(error.message, error.argument);
    if (error instanceof ToolInputError) return invalid(error.message, error.argument);
    return providerFailure(error) ?? failFromError(error);
  }
}

export const uiLinkTool: ToolModule = {
  name: "ui_link",
  register(server: McpServer, ctx: AppContext) {
    server.registerTool(
      "ui_link",
      {
        title: T.title,
        description: T.description,
        inputSchema: uiLinkInputSchema,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
      },
      async (args, extra) => uiLink(ctx, args, extra),
    );
  },
};
