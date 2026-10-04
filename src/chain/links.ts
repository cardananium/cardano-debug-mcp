// Hand-off artefacts derived from one EvalRedeemerResult: deep links (de-uplc-web debugger,
// cquisitor share link, decompiler) through the core handoff / share codecs, and the de-uplc
// PartsConfig built from the very parameters the validator used. A failed redeemer's links carry
// annotations: its diagnostics in cquisitor, its failing term in de-uplc-web when a debug session
// of it stopped on the error.

import type { EvalRedeemerResult, UtxoInputContext } from "@cardananium/cquisitor-lib";
import type { KoiosUtxoInfo } from "@cardananium/cquisitor-lib/chain/koiosTypes";
import type { FetchedValidationData } from "@cardananium/cquisitor-lib/chain/transactionValidation";
import { fieldsFromEval, fieldsFromEvalDecompile, fieldsToDecompileUrl, fieldsToUrl } from "@cardananium/cquisitor-lib/handoff/deUplcLink";
import type { Annotation, CquisitorTarget } from "@cardananium/cquisitor-lib/share";
import { encodeValidatorLink } from "@cardananium/cquisitor-lib/share/encoder";

import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import type { EvalRedeemerResultWire } from "../lib.js";
import type { TxRecord } from "../store/txStore.js";
import { failingTermAnnotation, failureOfRedeemer, noFailingTermNote, redeemerAnnotations } from "../ui/autoAnnotations.js";
import { innerFromLibForm } from "./refScript.js";
import { refOfEval } from "./validate.js";
import { chainStateOf, engineParamsOfRecord, type ChainState } from "./state.js";

/** URLs up to this length are inlined in tx_redeemer answers (three links per answer); longer ones are served as a resource. */
export const INLINE_URL_CHARS = 2_000;
/** ui_link answers carry one URL: the model copies it verbatim up to this length (longer: link_file / the resource). */
export const UI_LINK_INLINE_CHARS = 16_000;

/** A URL for a tool answer: the string itself, or its length and a preview when too long to inline. */
export function inlineUrl(url: string | undefined, resource: string, options: { cap?: number; file?: boolean } = {}): unknown {
  if (!url) return null;
  if (url.length <= (options.cap ?? INLINE_URL_CHARS)) return url;
  const where = options.file ? `open link_file or read the ${resource} resource` : `read the ${resource} resource`;
  return { length: url.length, preview: `${url.slice(0, 120)}…`, note: `too long to inline; ${where}` };
}

export interface RedeemerLinks {
  de_uplc_url?: string;
  cquisitor_url?: string;
  decompiler_url?: string;
  notes: string[];
}

/** Koios label of a reference script's type. */
function koiosScriptType(type: { kind: "plutus" | "native"; plutus_version?: string }): string {
  return type.kind === "native" ? "native" : `plutus${type.plutus_version ?? "V2"}`;
}

/** The display row (Koios `utxo_info` shape) of one context UTxO: only what the context itself knows. */
function utxoRowOf(entry: UtxoInputContext): KoiosUtxoInfo {
  const { input, output } = entry.utxo;
  const lovelace = output.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0";
  const assets = output.amount
    .filter((a) => a.unit !== "lovelace")
    .map((a) => ({ policy_id: a.unit.slice(0, 56), asset_name: a.unit.slice(56), fingerprint: "", decimals: 0, quantity: String(a.quantity) }));
  const script = output.scriptRef ? innerFromLibForm(output.scriptRef) : undefined;
  return {
    tx_hash: input.txHash.toLowerCase(),
    tx_index: Number(input.outputIndex),
    address: output.address,
    value: String(lovelace),
    stake_address: null,
    payment_cred: null,
    epoch_no: 0,
    block_height: 0,
    block_time: 0,
    datum_hash: output.dataHash ?? null,
    inline_datum: output.plutusData ? { bytes: output.plutusData, value: null } : null,
    reference_script: script && output.scriptHash ? { hash: output.scriptHash, size: script.inner.length / 2, type: koiosScriptType(script.type), bytes: script.inner, value: null } : null,
    asset_list: assets.length > 0 ? assets : null,
    is_spent: false,
  };
}

/**
 * The context a link carries when the chain state holds a ValidationInputContext but no fetched
 * data (a bundle, a DebuggerContext, a context assembled by hand): the context fields plus display
 * rows for the UTxOs. The provider rows win where the bundle has them; every other UTxO gets a row
 * made from the context alone.
 */
export function assembledFetchedData(state: Pick<ChainState, "context" | "providerRows">): FetchedValidationData | undefined {
  const context = state.context;
  if (!context) return undefined;
  const { networkType: _networkType, ...rest } = context;
  const rows = new Map<string, KoiosUtxoInfo>();
  for (const row of state.providerRows?.utxo_info ?? []) rows.set(`${row.tx_hash.toLowerCase()}#${row.tx_index}`, row);
  const utxoInfos = context.utxoSet.map((entry) => rows.get(`${entry.utxo.input.txHash.toLowerCase()}#${entry.utxo.input.outputIndex}`) ?? utxoRowOf(entry));
  return { ...rest, constitution: rest.constitution ?? null, slot: BigInt(rest.slot), treasuryValue: BigInt(rest.treasuryValue), utxoInfos } as unknown as FetchedValidationData;
}

/**
 * cquisitor transaction-validator link of a loaded tx. The chain context rides in the link: the
 * fetched data when the state has it, else one assembled from the state's context (`assembled`),
 * else only the transaction goes (the app then fetches the inputs itself).
 */
export async function cquisitorTxUrl(
  config: Pick<ServerConfig, "cquisitorBase">,
  record: TxRecord,
  annotations: Annotation<CquisitorTarget>[] = [],
  annotationFocus = 0,
): Promise<{ url: string; withContext: boolean; assembled: boolean }> {
  const state = chainStateOf(record);
  const assembled = !state?.fetched && state?.context !== undefined;
  const ctx = state?.fetched ?? (state ? assembledFetchedData(state) : undefined);
  const withContext = ctx !== undefined;
  const url = await encodeValidatorLink(
    config.cquisitorBase,
    { cbor: record.txHex, net: record.network, ctx, capturedAt: state?.capturedAt ?? undefined, annotations, annotationFocus },
    { kind: withContext ? "compressed" : "minimal" },
    withContext,
  );
  return { url, withContext, assembled };
}

/** What a transaction link owes the reader about its chain context, as a predicate for "the link …" (none when the context was fetched). */
export function contextNote(built: { withContext: boolean; assembled: boolean }): string | undefined {
  if (!built.withContext) return "carries the transaction only (no chain context is loaded for it); the app fetches the inputs from Koios, so made-up or chained inputs show as missing";
  if (built.assembled) return "embeds a context assembled from the bundle / DebuggerContext, not fetched (the state the server validated against)";
  return undefined;
}

/** All three URLs for a redeemer. Large payloads are gzip/brotli-compressed by the codecs; URLs can still be tens of KB. */
export async function buildLinks(ctx: Pick<AppContext, "config" | "sessions">, record: TxRecord, ev: EvalRedeemerResultWire): Promise<RedeemerLinks> {
  const notes: string[] = [];
  const out: RedeemerLinks = { notes };
  const ref = refOfEval(ev);
  const link = fieldsFromEval(ev as unknown as EvalRedeemerResult);
  if (link.ok) {
    const known = ev.success ? undefined : failureOfRedeemer(ctx.sessions, record.txId, ref);
    const failing = known?.failing;
    const fields = failing ? { ...link.fields, annotations: [failingTermAnnotation(failing, ref, ev.error, ev.logs?.at(-1))] } : link.fields;
    out.de_uplc_url = await fieldsToUrl(fields, ctx.config.deUplcBase);
    if (link.fidelity === "program-only") notes.push("de-uplc link is program-only (no ScriptContext bytes in the eval result)");
    if (!ev.success && !failing) notes.push(`de-uplc link has no failing-term annotation: ${noFailingTermNote(known?.withoutTerm ?? false)}`);
  } else notes.push(`de-uplc link unavailable: ${link.reason}`);
  const decompile = fieldsFromEvalDecompile(ev as unknown as EvalRedeemerResult);
  if (decompile) out.decompiler_url = await fieldsToDecompileUrl(decompile, ctx.config.deUplcBase);
  try {
    const annotations = redeemerAnnotations(record, ref, ev);
    const built = await cquisitorTxUrl(ctx.config, record, annotations);
    out.cquisitor_url = built.url;
    const note = contextNote(built);
    if (note) notes.push(`cquisitor link ${note}`);
  } catch (error) {
    notes.push(`cquisitor link unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return out;
}

/** de-uplc PartsConfig for one eval result (apply order datum -> redeemer -> context; V3 = context only). */
export function partsConfigOf(record: TxRecord, ev: EvalRedeemerResultWire): Record<string, unknown> {
  const link = fieldsFromEval(ev as unknown as EvalRedeemerResult);
  const params = engineParamsOfRecord(record);
  const language = ev.plutus_version ? (ev.plutus_version.toLowerCase() as "v1" | "v2" | "v3") : undefined;
  const parts: Record<string, unknown> = { script: ev.script_bytes ?? null, language: language ?? null };
  if (link.ok) {
    if (link.fields.context) parts.context = link.fields.context;
    if (link.fields.redeemer) parts.redeemer = link.fields.redeemer;
    if (link.fields.datum) parts.datum = link.fields.datum;
    if (link.fields.exUnits) parts.ex_units = link.fields.exUnits;
    parts.fidelity = link.fidelity;
  } else {
    parts.error = link.reason;
  }
  if (params) {
    parts.protocol_version = params.protocol_major;
    const costModels = ev.plutus_version ? params.cost_models[ev.plutus_version] : undefined;
    if (costModels) parts.cost_models = costModels;
  }
  return parts;
}
