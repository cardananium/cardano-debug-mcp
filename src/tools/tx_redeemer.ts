// tx_redeemer: zoom into ONE redeemer of a validated transaction: summary, full error,
// traces (paged, filtered), a slice of the ScriptContext the validator built, the script identity,
// or deep links into de-uplc-web / cquisitor. Runs tx_validate implicitly when needed.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { buildLinks, inlineUrl } from "../chain/links.js";
import { chainStateOf, type ChainState } from "../chain/state.js";
import { errorHeadline, fidelityOf, phaseLists, redeemerSummary, summarizeDiagnostics } from "../chain/validate.js";
import type { AppContext, ToolModule } from "../context.js";
import type { EvalRedeemerResultWire } from "../lib.js";
import type { RedeemerTarget, TxRecord } from "../store/txStore.js";
import { scriptBytesFromRecord } from "../resources.js";
import { lookupTxRecord, parseEmbeddedJson } from "../tx/record.js";
import { integersAsStrings, parseJsonBigintSafe } from "../vocab/json.js";
import { formatRedeemerRef, isWitnessIndexRef, parseRedeemerRef } from "../vocab/redeemerRef.js";
import { WorkerTimeoutError } from "../workers/rpc.js";
import { expiredHandleError } from "../store/sessionRegistry.js";
import { chain, progress, signalOf } from "./_chain.js";
import { capJson, capString, childKeys, clampInt, fail, failFromError, lookupPath, missingUtxosView, normalizeContextPath, ok, pageOf, parsePath, pruneDepth, resourceLink, ToolInputError, type ResourceLink, type ToolResult } from "./_shared.js";
import { providerFailure } from "./tx_load.js";
import { TOOL_TEXT } from "./descriptions.js";

const T = TOOL_TEXT.tx_redeemer;

export const REDEEMER_PARTS = ["summary", "error", "traces", "context", "script", "links"] as const;
export type RedeemerPart = (typeof REDEEMER_PARTS)[number];

const TRACE_CHARS = 500;
const CONTEXT_CHARS = 10_000;
const ERROR_CHARS = 4_000;

const inputSchema = z.object({
  tx_id: z.string().describe(T.params["tx_id"]),
  redeemer: z.string().describe(T.params["redeemer"]),
  part: z.enum(REDEEMER_PARTS).optional().describe(T.params["part"]),
  path: z.string().optional().describe(T.params["path"]),
  depth: z.number().int().min(1).max(6).optional().describe(T.params["depth"]),
  offset: z.number().int().min(0).optional().describe(T.params["offset"]),
  limit: z.number().int().min(1).max(100).optional().describe(T.params["limit"]),
  filter: z.string().optional().describe(T.params["filter"]),
  decode_data: z.boolean().optional().describe(T.params["decode_data"]),
});

type Args = z.infer<typeof inputSchema>;
type Json = Record<string, unknown>;

/** URI of one artefact of a redeemer (`context.json`, `traces.txt`, …). */
export function redeemerResourceUri(txId: string, ref: string, file: string): string {
  return `cardano-debug://tx/${txId}/redeemer/${ref}/${file}`;
}

/** Every artefact of a redeemer; only part='summary' lists them all, the other parts list the one they point at. */
export function redeemerResources(record: TxRecord, ref: string): ResourceLink[] {
  const base = `cardano-debug://tx/${record.txId}/redeemer/${ref}`;
  return [
    resourceLink(`${base}/context.json`, `${ref} context`, "application/json", "Full ScriptContext JSON (as the validator built it)"),
    resourceLink(`${base}/context.cbor`, `${ref} context cbor`, "text/plain", "ScriptContext as PlutusData CBOR hex"),
    resourceLink(`${base}/traces.txt`, `${ref} traces`, "text/plain", "All trace messages, one per line"),
    resourceLink(`${base}/error.txt`, `${ref} error`, "text/plain", "Full machine error text"),
    resourceLink(`${base}/script.hex`, `${ref} script`, "text/plain", "Script bytes (CBOR hex)"),
    resourceLink(`${base}/parts.json`, `${ref} parts`, "application/json", "de-uplc PartsConfig for this redeemer"),
    resourceLink(`${base}/links.txt`, `${ref} links`, "text/plain", "de-uplc-web / cquisitor / decompiler URLs"),
  ];
}

/** Resolve a user-given ref to the record's target (witness-index refs included). */
export function resolveRedeemer(record: TxRecord, input: string): RedeemerTarget {
  const parsed = parseRedeemerRef(input);
  if (isWitnessIndexRef(parsed)) {
    const byIndex = record.redeemerTargets.find((t) => t.witness_index === parsed.witnessIndex);
    if (!byIndex) throw new ToolInputError(`The transaction has ${record.redeemerTargets.length} redeemer(s); witness index ${parsed.witnessIndex} does not exist.`, "redeemer");
    return byIndex;
  }
  const ref = formatRedeemerRef(parsed);
  const target = record.redeemerTargets.find((t) => t.ref === ref);
  if (!target) {
    throw new ToolInputError(`Redeemer ${ref} is not in this transaction. Available: ${record.redeemerTargets.map((t) => t.ref).join(", ") || "(none)"}.`, "redeemer");
  }
  return target;
}

/** The parsed ScriptContext JSON (`{script_context_version, tx_info: {V2: {...}}, purpose}`) or undefined. */
export function scriptContextOf(ev: EvalRedeemerResultWire): Json | undefined {
  if (typeof ev.script_context !== "string" || ev.script_context.trim() === "") return undefined;
  try {
    const parsed = parseJsonBigintSafe(ev.script_context);
    return parsed !== null && typeof parsed === "object" ? (parsed as Json) : undefined;
  } catch {
    return undefined;
  }
}

export type ErrorCategory = "script_failed" | "budget" | "decode" | "missing_script" | "missing_datum" | "context_build" | "machine_error" | "none";
/** Refines machine_error: `data_shape` = a builtin met the wrong Data constructor / kind (wrong datum, redeemer or context shape). */
export type ErrorSubcategory = "data_shape";

/** Phase-2 errors for which the library never builds the ScriptContext (the script does not run). */
export const CONTEXT_REFUSALS = ["BuildTxContextError", "UnreadableOutput", "ByronAddressNotAllowed", "CertificateNotSupportedInPlutusV1V2", "FieldNotSupportedInPlutusV1V2", "InlineDatumNotAllowedForPlutusV1"] as const;

/** A builtin refused the Data it was given (unConstrData on a non-Constr, unIData on a non-I, …). */
const DATA_SHAPE = /(failed to )?deserialis(e|ing) PlutusData|\bun(Constr|I|B|List|Map)Data\b/i;

export function categorizeError(error: string | null | undefined, phase2Errors: Array<{ name: string }>): ErrorCategory {
  const names = phase2Errors.map((e) => e.name);
  if (names.includes("NoEnoughBudget")) return "budget";
  if (names.includes("ScriptDecodeError")) return "decode";
  if (names.includes("MissingRequiredScript") || names.includes("ScriptLookupError")) return "missing_script";
  if (names.includes("MissingRequiredDatum") || names.includes("MissingRequiredInlineDatumOrHash")) return "missing_datum";
  // The ledger cannot build this script's context, so the script never ran: an output it cannot
  // read, a Byron address, a Conway certificate or field under PlutusV1/V2.
  if (CONTEXT_REFUSALS.some((name) => names.includes(name))) return "context_build";
  // The name is authoritative: a CEK stop is a machine error whatever words its text contains
  // ("failed to deserialise PlutusData" is a Data-shape failure, not undecodable script bytes).
  if (names.includes("MachineError")) return "machine_error";
  if (!error) return "none";
  if (/budget|exhausted|out of ex|ExBudget/i.test(error)) return "budget";
  if (/explicit error|called 'error'|evaluation failure|EvaluationFailure|validation returned false|script returned false/i.test(error)) return "script_failed";
  if (DATA_SHAPE.test(error)) return "machine_error";
  if (/failed to decode script|flat decod/i.test(error)) return "decode";
  if (/script.*not found|missing.*script/i.test(error)) return "missing_script";
  if (/missing.*datum|datum.*not found/i.test(error)) return "missing_datum";
  return "machine_error";
}

export function subcategorizeError(category: ErrorCategory, error: string | null | undefined): ErrorSubcategory | undefined {
  return category === "machine_error" && error && DATA_SHAPE.test(error) ? "data_shape" : undefined;
}

const CATEGORY_HINTS: Record<ErrorCategory, string> = {
  script_failed: "The validator ran to an explicit failure (error / expect / fail). Read the last traces (part='traces'), then debug_open this redeemer and debug_run(until='error') to see the failing expression and its environment.",
  budget: "Execution exceeded the declared ex-units. Compare declared vs calculated in the summary; raise the redeemer's ex-units or profile the script (debug_profile) to find the hot terms.",
  decode: "The script bytes do not decode as a Plutus program of the declared version: check plutus_version, double CBOR wrapping, or a truncated reference script.",
  missing_script: "No script with the required hash is available in the witness set, the outputs or the reference inputs (or the reference UTxO was not resolved). Check tx_load's scripts and missing_utxos.",
  missing_datum: "A spent script output needs its datum (inline or in the witness set) matching its datum hash.",
  context_build: "The ScriptContext could not be built from the transaction and its resolved inputs; check that every input / reference input resolved and that redeemer indices point at existing entries.",
  machine_error: "The CEK machine stopped on this error. Use part='traces' for the script's own messages, then debug_open + debug_run(until='error').",
  none: "This redeemer evaluated successfully.",
};

const SUBCATEGORY_HINTS: Record<ErrorSubcategory, string> = {
  data_shape:
    "A builtin got Data of the wrong shape (unConstrData on a non-Constr, unIData on a non-integer, …): the datum, redeemer or a context field does not have the constructor / kind the script expects — the script bytes are fine. Compare part='summary' redeemer_data / datum with the shape script_decompile shows, then debug_run(until='error') and inspect the value.",
};

/** part='error' text: the machine error; for a script that finished, whether the ledger still rejects the redeemer (phase-2 errors such as NoEnoughBudget). */
export function redeemerErrorMessage(ev: Pick<EvalRedeemerResultWire, "error" | "success">, phase2: Array<{ name: string; message: string }>, exUnitsVerdict: string): string {
  if (ev.error) return capString(ev.error, ERROR_CHARS);
  if (ev.success && (phase2.length > 0 || exUnitsVerdict === "over_budget")) {
    const why = phase2.length > 0 ? phase2.map((e) => `${e.name}: ${capString(e.message, 300)}`).join("; ") : "it used more than its declared ex-units";
    return `The script completed, but the ledger rejects this redeemer: ${why}.`;
  }
  if (ev.success) return "(no error: the redeemer evaluated successfully within its declared ex-units)";
  return phase2[0]?.message ?? "(no error text)";
}

function phase2ErrorsFor(record: TxRecord, ref: string): Array<{ name: string; message: string; hint?: string; data?: unknown }> {
  if (!record.validation) return [];
  return summarizeDiagnostics(phaseLists(record.validation).phase2_errors, "error", record, 1_000).items.filter((e) => e.redeemer === ref);
}

async function decodePlutusData(ctx: AppContext, hex: string | null | undefined, depth: number): Promise<unknown> {
  if (!hex) return undefined;
  try {
    const decoded = await ctx.lib.decodeType<Json>(hex, "PlutusData", { plutus_data_schema: "DetailedSchema" });
    return pruneDepth(integersAsStrings(parseEmbeddedJson(decoded.plutus_data ?? decoded)), depth);
  } catch (error) {
    return { decode_error: capString(error instanceof Error ? error.message : String(error), 200) };
  }
}

function scriptSource(record: TxRecord, state: ChainState | undefined, hash: string | undefined): string {
  if (!hash) return "eval result";
  const own = record.scripts.find((s) => s.script_hash === hash);
  if (own) return own.source;
  const ref = state?.refScripts[hash];
  if (ref) return `reference ${ref.utxo}${ref.verified ? "" : ref.hash_source === "derived" ? " (hash derived from bytes)" : " (UNVERIFIED: hash mismatch)"}`;
  return "eval result (script_bytes)";
}

export async function txRedeemer(ctx: AppContext, args: Args, extra?: unknown): Promise<ToolResult> {
  const service = chain(ctx);
  const signal = signalOf(extra);
  try {
    const record = await lookupTxRecord(ctx, args.tx_id);
    if (!record) return expiredHandleError(args.tx_id.trim(), "tx_load");
    const target = resolveRedeemer(record, args.redeemer);
    const part: RedeemerPart = args.part ?? "summary";
    const common: Json = { tx_id: record.txId, ref: target.ref, part };

    // Validate implicitly.
    let state = chainStateOf(record);
    if (!state?.context) {
      await progress(extra, "resolving chain state", 1, 3);
      try {
        await service.loadContext(record, { signal });
      } catch (error) {
        const failure = providerFailure(error, common);
        if (failure) return failure;
        throw error;
      }
      state = chainStateOf(record);
    }
    if (state && state.missingUtxos.length > 0) {
      return fail({ ...common, code: "incomplete_context", message: `Cannot evaluate: ${state.missingUtxos.length} UTxO(s) were not resolved (${state.missingUtxos.slice(0, 5).join(", ")}${state.missingUtxos.length > 5 ? ", …" : ""}). See tx_validate.`, ...missingUtxosView(state.missingUtxos) });
    }
    if (!record.validation) {
      // A validation that already overran the default budget would only overrun again (debug_open does the same).
      const overran = state?.timedOut && state.timedOut.timeout_ms >= ctx.config.evalTimeoutMs ? state.timedOut.timeout_ms : undefined;
      let timeoutMs = overran;
      if (timeoutMs === undefined) {
        await progress(extra, "validating", 2, 3);
        try {
          await service.validate(record, { signal });
        } catch (error) {
          if (!(error instanceof WorkerTimeoutError)) throw error;
          timeoutMs = error.timeoutMs;
        }
      }
      if (timeoutMs !== undefined) {
        // The script's identity and bytes come from the tx and its inputs, not from the evaluation.
        if (part === "script") return scriptWithoutEvaluation(record, target, chainStateOf(record), common, timeoutMs);
        return fail({
          ...common,
          code: "timeout",
          message: `Validation exceeded ${timeoutMs} ms; retry tx_validate with a larger timeout_ms (<= 300000). part='script' still answers: the script bytes (script_resource) to step it outside the tx with debug_open(script=…) and debug_run max_steps.`,
          timeout_ms: timeoutMs,
          script_resource: redeemerResourceUri(record.txId, target.ref, "script.hex"),
        });
      }
    }
    // A parallel refresh may have cleared the validation while this call awaited.
    const validation = record.validation;
    if (!validation) return fail({ ...common, code: "no_eval_result", message: "The validation of this transaction was cleared while this call ran (a parallel refresh); call tx_redeemer again." });
    const ev = validation.redeemers.get(target.ref);
    if (!ev) return fail({ ...common, code: "no_eval_result", message: `The validator produced no evaluation result for ${target.ref} (phase 1 may have failed before phase 2; see tx_validate).` });
    // Links: part='summary' lists every artefact; another part lists the one it may point at, when it does.
    const uri = (file: string) => redeemerResourceUri(record.txId, target.ref, file);
    const linkTo = (...files: string[]): ResourceLink[] => redeemerResources(record, target.ref).filter((link) => files.some((file) => link.uri === uri(file)));

    switch (part) {
      case "summary": {
        const summary = redeemerSummary(record, target, ev);
        const decode = args.decode_data ?? true;
        return ok(
          {
            ...common,
            ...summary,
            purpose: target.purpose,
            index: target.index,
            datum_present: Boolean(ev.datum_bytes),
            context_available: Boolean(ev.script_context_bytes || ev.script_context),
            script_size_bytes: ev.script_bytes ? ev.script_bytes.length / 2 : undefined,
            ...(decode ? { redeemer_data: await decodePlutusData(ctx, ev.redeemer_bytes, 2), datum: await decodePlutusData(ctx, ev.datum_bytes, 2) } : {}),
          },
          { links: redeemerResources(record, target.ref) },
        );
      }
      case "error": {
        const phase2 = phase2ErrorsFor(record, target.ref);
        const category = categorizeError(ev.error, phase2);
        const subcategory = subcategorizeError(category, ev.error);
        const exUnits = summaryExUnits(record, target, ev);
        const message = redeemerErrorMessage(ev, phase2, exUnits.verdict);
        return ok(
          {
            ...common,
            success: Boolean(ev.success),
            within_budget: exUnits.verdict === "not_run" ? null : exUnits.verdict !== "over_budget",
            category,
            ...(subcategory ? { subcategory } : {}),
            message,
            headline: errorHeadline(ev.error),
            hint:
              target.plutus_version === "native"
                ? "This redeemer points at an element locked by a NATIVE script: native scripts take no redeemer and have no Plutus program, so the lookup reports MissingRequiredScript although the script is present. Remove the redeemer (the node rejects it as an extra redeemer)."
                : ((subcategory ? SUBCATEGORY_HINTS[subcategory] : undefined) ?? phase2.find((e) => e.hint)?.hint ?? CATEGORY_HINTS[category]),
            phase2_errors: phase2.map((e) => ({ name: e.name, message: capString(e.message, 400), data: e.data })),
            trace_count: Array.isArray(ev.logs) ? ev.logs.length : 0,
            ex_units: exUnits,
          },
          { links: ev.error && ev.error.length > ERROR_CHARS ? linkTo("error.txt") : [] },
        );
      }
      case "traces": {
        const logs = Array.isArray(ev.logs) ? ev.logs.map((l) => String(l)) : [];
        const filter = args.filter?.toLowerCase();
        const indexed = logs.map((message, index) => ({ index, message }));
        const filtered = filter ? indexed.filter((t) => t.message.toLowerCase().includes(filter)) : indexed;
        const page = pageOf(filtered, clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER), clampInt(args.limit, 50, 1, 100));
        return ok(
          {
            ...common,
            total: page.total,
            total_unfiltered: logs.length,
            offset: page.offset,
            items: page.rows.map((t) => ({ index: t.index, message: capString(t.message, TRACE_CHARS) })),
            next_offset: page.next_offset,
            filter: args.filter,
          },
          { links: logs.some((message) => message.length > TRACE_CHARS) ? linkTo("traces.txt") : [] },
        );
      }
      case "context": {
        const context = scriptContextOf(ev);
        if (!context) {
          return fail({ ...common, code: "no_context", message: "The eval result carries no ScriptContext JSON (the context could not be built for this redeemer).", context_cbor_available: Boolean(ev.script_context_bytes) });
        }
        const segments = normalizeContextPath(context, parsePath(args.path));
        const lookup = lookupPath(context, segments);
        if (!lookup.found) {
          return fail({
            ...common,
            code: "path_not_found",
            message: `Path ${JSON.stringify(args.path)} does not exist in the ScriptContext; resolved up to ${lookup.resolved.join(".") || "(root)"}.`,
            resolved: lookup.resolved.join("."),
            available: lookup.available ?? childKeys(lookupPath(context, lookup.resolved).value),
          });
        }
        const depth = clampInt(args.depth, 2, 1, 6);
        const capped = capJson(integersAsStrings(lookup.value), CONTEXT_CHARS, depth);
        return ok(
          {
            ...common,
            path: segments.join(".") || "(root)",
            value: capped.value,
            truncated: capped.truncated || undefined,
            depth: capped.depth,
            children: capped.truncated ? childKeys(lookup.value) : undefined,
            hint: capped.truncated ? `Narrow \`path\` (e.g. tx_info.inputs.0) or raise \`depth\`; the whole document is ${uri("context.json")}.` : undefined,
          },
          { links: capped.truncated ? linkTo("context.json") : [] },
        );
      }
      case "script": {
        const info = state?.scriptHashes[target.ref];
        const hash = info?.script_hash ?? target.script_hash;
        const version = info?.plutus_version ?? ev.plutus_version ?? target.plutus_version ?? null;
        return ok(
          {
            ...common,
            script_hash: hash ?? null,
            plutus_version: version,
            size_bytes: ev.script_bytes ? ev.script_bytes.length / 2 : null,
            source: scriptSource(record, state, hash),
            verified: hash && state?.refScripts[hash] ? state.refScripts[hash].verified : undefined,
            fidelity: fidelityOf(ev),
          },
          { links: scriptLinks(record, target, hash, true, version) },
        );
      }
      case "links": {
        await progress(extra, "building links", 3, 3);
        const built = await buildLinks(ctx, record, ev);
        const urls = [built.de_uplc_url, built.cquisitor_url, built.decompiler_url].map((url) => inlineUrl(url, uri("links.txt")));
        return ok(
          {
            ...common,
            de_uplc_url: urls[0],
            cquisitor_url: urls[1],
            decompiler_url: urls[2],
            notes: built.notes,
          },
          // A URL too long to inline is read from links.txt.
          { links: urls.some((url) => url !== null && typeof url === "object") ? linkTo("links.txt") : [] },
        );
      }
    }
    return fail({ ...common, code: "invalid_argument", message: `unknown part ${String(part)}` });
  } catch (error) {
    return providerFailure(error) ?? failFromError(error);
  }
}

/**
 * part='script' when the validation did not finish: the identity (hash, version, source) and the
 * bytes are known from the witness set / the resolved reference inputs; nothing about the run is.
 */
function scriptWithoutEvaluation(record: TxRecord, target: RedeemerTarget, state: ChainState | undefined, common: Json, timeoutMs: number): ToolResult {
  const info = state?.scriptHashes[target.ref];
  const hash = info?.script_hash ?? target.script_hash;
  const bytes = hash ? scriptBytesFromRecord(record, hash) : undefined;
  const own = hash ? record.scripts.find((s) => s.script_hash === hash) : undefined;
  const reference = hash ? state?.refScripts[hash] : undefined;
  const plutusVersion = info?.plutus_version ?? target.plutus_version ?? bytes?.plutus_version ?? null;
  const scriptResource = redeemerResourceUri(record.txId, target.ref, "script.hex");
  return ok(
    {
      ...common,
      script_hash: hash ?? null,
      plutus_version: plutusVersion,
      size_bytes: own?.size_bytes ?? reference?.size_bytes ?? null,
      source: bytes ? scriptSource(record, state, hash) : "unresolved (no witness or reference script with this hash)",
      verified: reference ? reference.verified : undefined,
      evaluated: false,
      note:
        `The validation did not finish within ${timeoutMs} ms, so this redeemer has no evaluation (no fidelity, traces or context); identity and bytes come from the transaction and its resolved inputs. ` +
        (bytes
          ? `To step it outside the tx: debug_open(script=<${scriptResource}>, plutus_version=${JSON.stringify(plutusVersion ?? "V3")}, redeemer_data / datum / context as far as known), then debug_run with max_steps as the bound.`
          : "Its bytes are not in the transaction or its resolved reference inputs."),
      ...(bytes ? { script_resource: scriptResource } : {}),
    },
    { links: scriptLinks(record, target, hash, Boolean(bytes), plutusVersion) },
  );
}

/** part='script' links: the script bytes, and (for a Plutus script) its pseudocode / UPLC texts. */
function scriptLinks(record: TxRecord, target: RedeemerTarget, hash: string | undefined, hasBytes: boolean, plutusVersion?: string | null): ResourceLink[] {
  return [
    ...(hasBytes ? [resourceLink(redeemerResourceUri(record.txId, target.ref, "script.hex"), `${target.ref} script`, "text/plain", "Script bytes (CBOR hex)")] : []),
    ...(hash && hasBytes && plutusVersion !== "native"
      ? [
          resourceLink(`cardano-debug://script/${hash}/pseudocode.txt`, `${hash.slice(0, 8)} pseudocode`, "text/plain", "Decompiled pseudocode (after script_decompile)"),
          resourceLink(`cardano-debug://script/${hash}/uplc.txt`, `${hash.slice(0, 8)} uplc`, "text/plain", "Pretty-printed UPLC"),
        ]
      : []),
  ];
}

function summaryExUnits(record: TxRecord, target: RedeemerTarget, ev: EvalRedeemerResultWire) {
  return redeemerSummary(record, target, ev).ex_units;
}

export const txRedeemerTool: ToolModule = {
  name: "tx_redeemer",
  register(server: McpServer, ctx: AppContext) {
    chain(ctx);
    server.registerTool(
      "tx_redeemer",
      {
        title: T.title,
        description: T.description,
        inputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      },
      async (args, extra) => txRedeemer(ctx, args, extra),
    );
  },
};
