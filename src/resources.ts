// Resources (`cardano-debug://…`): whole artefacts the model fetches on demand, so tool results
// can stay small. Every URI below is a `ResourceTemplate` with `list: undefined` (instances are
// unbounded) except the static ones (server/info, cddl, cddl/conway, docs).
//
// Data sources, in order: a provider registered through `providersOf(ctx)` (src/providers.ts —
// the chain / engine / decompiler layers plug in there), then what the stores hold (TxStore,
// SessionRegistry, the lib). Anything still unknown is a `ResourceNotFoundError` (protocol error,
// as the design requires; the recovery text lives in the tools, which the model drives).
//
// Text resources accept `?offset=<line>&limit=<lines>`. The SDK matches templates against the
// full URI (query included), so a catch-all template registered last strips the query and routes
// the bare URI through the same table (`ROUTES`).

import { McpServer, ResourceNotFoundError, ResourceTemplate, UriTemplate } from "@modelcontextprotocol/server";

import { buildInfo } from "./buildInfo.js";
import { isNetwork, type Network } from "./config.js";
import type { AppContext } from "./context.js";
import { DOC_TOPICS, docIndexMarkdown, findSection, isDocTopic, topicIndexMarkdown } from "./docs/index.js";
import {
  providersOf,
  REDEEMER_ARTIFACT_PARTS,
  SCRIPT_ARTIFACT_PARTS,
  SESSION_ARTIFACT_PARTS,
  type ArtifactText,
  type RedeemerArtifactPart,
  type ScriptArtifactPart,
  type ScriptBytes,
  type SessionArtifactPart,
} from "./providers.js";
import type { SessionRecord } from "./store/sessionRegistry.js";
import type { PlutusVersionOrNative, RedeemerTarget, TxRecord } from "./store/txStore.js";
import { integersAsStrings } from "./tx/dataView.js";
import { cddlAttribution, DEFAULT_ERA, ERA_PRESETS, isEraPreset, loadEraCddl, resolveSchemaInput } from "./cbor/presets.js";
import { loadSchemaInfo } from "./cbor/schema.js";
import { parseJsonBigintSafe, toWireJson } from "./vocab/json.js";
import { isWitnessIndexRef, tryParseRedeemerRef } from "./vocab/redeemerRef.js";
import { packageVersion } from "./wasm-assets.js";
import { lookupTxRecord } from "./tx/record.js";
import { readableActionIdValues } from "./chain/govId.js";
import { SEMANTICS } from "./chain/validate.js";
import { compactIndentation, INDENT_CAP, LISTING_DEFAULT_LINES } from "./engine/indent.js";
import { LINK_ID_PATTERN } from "./ui/linkStore.js";

export interface ResourceModule {
  name: string;
  register(server: McpServer, ctx: AppContext): void;
}

// ---------- text slicing ----------

export interface LineSlice {
  text: string;
  total_lines: number;
  offset: number;
  limit?: number;
  sliced: boolean;
}

/**
 * `?offset=<line>&limit=<lines>` slicing for text resources (0-based line offset). `defaultLimit`
 * windows a text even when the URI names no limit (UPLC listings: megabytes of lines otherwise).
 */
export function sliceLines(text: string, uri: URL, defaultLimit?: number): LineSlice {
  const offsetRaw = uri.searchParams.get("offset");
  const limitRaw = uri.searchParams.get("limit");
  if (offsetRaw === null && limitRaw === null && defaultLimit === undefined) return { text, total_lines: text === "" ? 0 : text.split("\n").length, offset: 0, sliced: false };
  const lines = text.split("\n");
  const offset = offsetRaw ? Math.max(0, Number.parseInt(offsetRaw, 10) || 0) : 0;
  const limit = limitRaw ? Math.max(1, Number.parseInt(limitRaw, 10) || 1) : defaultLimit;
  const slice = lines.slice(offset, limit !== undefined ? offset + limit : undefined);
  return { text: slice.join("\n"), total_lines: lines.length, offset, limit, sliced: true };
}

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text: string;
  _meta?: Record<string, unknown>;
}

/**
 * One text content block, sliced by the URI's `offset`/`limit` when present. A UPLC listing is
 * always windowed (LISTING_DEFAULT_LINES without a limit) and its indentation compacted (the
 * window's common indentation removed, the rest capped at INDENT_CAP columns); `_meta` says so.
 */
export function textContent(uri: URL, text: string, mimeType: string, options: { listing?: boolean } = {}): ResourceContent {
  const slice = sliceLines(text, uri, options.listing ? LISTING_DEFAULT_LINES : undefined);
  let body = slice.text;
  let compacted: ReturnType<typeof compactIndentation> | undefined;
  if (options.listing && body !== "") {
    compacted = compactIndentation(body.split("\n"));
    body = compacted.lines.join("\n");
  }
  const block: ResourceContent = { uri: uri.href, mimeType, text: body };
  if (slice.sliced) {
    const lines = body === "" ? 0 : body.split("\n").length;
    block._meta = { offset: slice.offset, limit: slice.limit, total_lines: slice.total_lines, lines_returned: lines };
    if (compacted) {
      block._meta.dedent = compacted.dedent;
      if (compacted.capped > 0) block._meta.indent_capped_at = INDENT_CAP;
      if (slice.offset + lines < slice.total_lines) block._meta.next_offset = slice.offset + lines;
    }
  }
  return block;
}

function prettyJson(value: unknown): string {
  return JSON.stringify(toWireJson(value), null, 2);
}

export function mimeFor(part: string): string {
  return part.endsWith(".json") ? "application/json" : part.endsWith(".md") ? "text/markdown" : "text/plain";
}

// ---------- routing table ----------

export type RouteVars = Record<string, string>;

export interface Route {
  /** Registration name (unique). */
  name: string;
  /** `cardano-debug://…` with `{var}` placeholders; static when it has none. */
  template: string;
  title: string;
  description: string;
  mimeType: string;
  /** Answer the text for a matched URI, or `undefined` for "not found". */
  read(ctx: AppContext, uri: URL, vars: RouteVars): Promise<string | ArtifactText | undefined>;
}

const notFound = (uri: URL) => new ResourceNotFoundError(uri.href);

function getRecord(ctx: AppContext, txId: string | undefined): Promise<TxRecord | undefined> {
  return txId ? lookupTxRecord(ctx, txId) : Promise.resolve(undefined);
}

/** Canonical redeemer target of `refText` (any accepted alias, or `r:<witness index>`). */
export function resolveRedeemer(record: TxRecord, refText: string): RedeemerTarget | undefined {
  const parsed = tryParseRedeemerRef(decodeURIComponent(refText));
  if (!parsed) return undefined;
  if (isWitnessIndexRef(parsed)) return record.redeemerTargets.find((t) => t.witness_index === parsed.witnessIndex);
  return record.redeemerTargets.find((t) => t.purpose === parsed.purpose && t.index === parsed.index);
}

const BYTE_FIELDS = ["script_context_bytes", "script_context", "script_bytes", "redeemer_bytes", "datum_bytes"] as const;

/** `validation.json`: the stored ValidationResult with byte-heavy fields removed and logs counted. */
export function validationView(record: TxRecord): unknown | undefined {
  const validation = record.validation;
  if (!validation) return undefined;
  const redeemers = Array.from(validation.redeemers.entries()).map(([ref, result]) => {
    const copy: Record<string, unknown> = { redeemer: ref, ...result };
    for (const field of BYTE_FIELDS) {
      if (copy[field] !== undefined) copy[`${field}_present`] = copy[field] !== null && copy[field] !== "";
      delete copy[field];
    }
    if (Array.isArray(result.logs)) {
      copy.logs_count = result.logs.length;
      delete copy.logs;
    }
    return copy;
  });
  return {
    tx_id: record.txId,
    tx_hash: record.txHash,
    network: record.network,
    validated_at: new Date(validation.at).toISOString(),
    elapsed_ms: validation.elapsedMs,
    phases: validation.phases,
    ...(readableActionIdValues(validation.result, record.network) as object),
    eval_redeemer_results: redeemers,
    resources: {
      traces: `cardano-debug://tx/${record.txId}/redeemer/<ref>/traces.txt`,
      context: `cardano-debug://tx/${record.txId}/redeemer/<ref>/context.json`,
      script: `cardano-debug://tx/${record.txId}/redeemer/<ref>/script.hex`,
    },
  };
}

/** calculated > declared on either axis (the ledger's NoEnoughBudget). */
export function overDeclaredBudget(result: { provided_ex_units?: unknown; calculated_ex_units?: unknown }): boolean {
  const pair = (v: unknown) => (v && typeof v === "object" ? (v as { mem?: unknown; steps?: unknown }) : {});
  const big = (v: unknown) => {
    try {
      return typeof v === "number" || typeof v === "string" || typeof v === "bigint" ? BigInt(v) : undefined;
    } catch {
      return undefined;
    }
  };
  const declared = pair(result.provided_ex_units);
  const calculated = pair(result.calculated_ex_units);
  const [dm, ds, cm, cs] = [big(declared.mem), big(declared.steps), big(calculated.mem), big(calculated.steps)];
  if (dm === undefined || ds === undefined || cm === undefined || cs === undefined) return false;
  return cm > dm || cs > ds;
}

/** Default redeemer artefacts derived from the stored EvalRedeemerResult (and the tx's own scripts). */
async function redeemerArtifactDefault(record: TxRecord, target: RedeemerTarget, part: RedeemerArtifactPart): Promise<ArtifactText | undefined> {
  const result = record.validation?.redeemers.get(target.ref);
  switch (part) {
    case "context.json": {
      if (!result?.script_context) return undefined;
      const parsed = typeof result.script_context === "string" ? parseJsonBigintSafe(result.script_context) : result.script_context;
      return { text: prettyJson(integersAsStrings(parsed)), mimeType: "application/json" };
    }
    case "context.cbor":
      return result?.script_context_bytes ? { text: result.script_context_bytes } : undefined;
    case "traces.txt":
      return result ? { text: (result.logs ?? []).join("\n") } : undefined;
    case "script.hex": {
      if (result?.script_bytes) return { text: result.script_bytes };
      // No evaluation (not validated yet, or the validation timed out): the witness or reference script by hash.
      const chain = record.extra.chain as { scriptHashes?: Record<string, { script_hash?: string }> } | undefined;
      const hash = chain?.scriptHashes?.[target.ref]?.script_hash ?? target.script_hash;
      const bytes = hash ? scriptBytesFromRecord(record, hash) : undefined;
      return bytes ? { text: bytes.hex } : undefined;
    }
    case "error.txt":
      if (!result) return undefined;
      return {
        text: result.error
          ? String(result.error)
          : result.success
            ? overDeclaredBudget(result)
              ? "(the script completed, but used more than its declared ex-units: the ledger rejects it with NoEnoughBudget; see tx_redeemer part='error')"
              : "(no error: the redeemer evaluated successfully within its declared ex-units)"
            : "(no error text recorded)",
      };
    default:
      // parts.json / links.txt come from the engine layer through a provider.
      return undefined;
  }
}

/** Shape of the chain layer's `record.extra.chain.refScripts[hash]` (ChainState); read here without importing the layer. */
interface RefScriptLike {
  inner: string;
  plutus_version?: PlutusVersionOrNative;
  utxo?: string;
  verified?: boolean;
}

/**
 * Script bytes carried by one record: witness / inline scripts, then the bytes a validated
 * redeemer resolved to, then the reference scripts the chain layer canonicalised.
 */
export function scriptBytesFromRecord(record: TxRecord, scriptHash: string): ScriptBytes | undefined {
  const hash = scriptHash.toLowerCase();
  const script = record.scripts.find((s) => s.script_hash === hash && s.hex);
  if (script?.hex) return { hex: script.hex, plutus_version: script.plutus_version, source: `${record.txId} ${script.source}` };
  const validated = record.validation ? Array.from(record.validation.redeemers.entries()) : [];
  for (const [ref, result] of validated) {
    const target = record.redeemerTargets.find((t) => t.ref === ref);
    if (target?.script_hash === hash && result.script_bytes) {
      return { hex: result.script_bytes, plutus_version: result.plutus_version ?? undefined, source: `${record.txId} ${ref}` };
    }
  }
  const chain = record.extra.chain as { refScripts?: Record<string, RefScriptLike> } | undefined;
  const ref = chain?.refScripts?.[hash];
  if (ref?.inner) return { hex: ref.inner, plutus_version: ref.plutus_version, source: `${record.txId} reference ${ref.utxo ?? ""}${ref.verified === false ? " (UNVERIFIED)" : ""}` };
  return undefined;
}

/** Default script bytes: any loaded transaction that carries the script (witness, inline output, validated redeemer, reference input). */
export function scriptBytesFromStore(ctx: AppContext, scriptHash: string): ScriptBytes | undefined {
  for (const record of ctx.txStore.list()) {
    const found = scriptBytesFromRecord(record, scriptHash);
    if (found) return found;
  }
  return undefined;
}

async function scriptBytesOf(ctx: AppContext, scriptHash: string): Promise<ScriptBytes | undefined> {
  return (await providersOf(ctx).first("scriptBytes", scriptHash)) ?? scriptBytesFromStore(ctx, scriptHash);
}

async function scriptArtifactDefault(ctx: AppContext, scriptHash: string, part: ScriptArtifactPart): Promise<ArtifactText | undefined> {
  switch (part) {
    case "bytes.hex": {
      const bytes = await scriptBytesOf(ctx, scriptHash);
      return bytes ? { text: bytes.hex } : undefined;
    }
    case "uplc.txt": {
      const bytes = await scriptBytesOf(ctx, scriptHash);
      if (!bytes || bytes.plutus_version === "native") return undefined;
      return { text: await ctx.lib.prettyUplc(bytes.hex), listing: true };
    }
    default:
      // pseudocode.txt / uplc_canonical.txt need the decompiler layer.
      return undefined;
  }
}

/** `session/{dbg_id}/state.json` from the registry record alone (no engine call). */
export function sessionStateView(session: SessionRecord): Record<string, unknown> {
  return {
    dbg_id: session.dbgId,
    mode: session.mode,
    tx_id: session.txId,
    redeemer: session.redeemer,
    script_hash: session.scriptHash,
    language: session.language,
    purpose: session.purpose,
    protocol_version: session.protocolVersion,
    breakpoints: session.breakpoints,
    logs_offset: session.logsOffset,
    last_term_id: session.lastTermId,
    total_steps: session.totalSteps,
    memory_bytes: session.memoryBytes,
    poisoned: session.poisoned,
    lost: session.lost,
    busy: session.busy,
    version: session.version,
    worker: session.worker ? session.worker.stats() : null,
    created_at: new Date(session.createdAt).toISOString(),
    last_used_at: new Date(session.lastUsedAt).toISOString(),
    expires_at: new Date(session.expiresAt).toISOString(),
  };
}

// ---------- server/info ----------

export function serverInfo(ctx: AppContext): Record<string, unknown> {
  const sessions = ctx.sessions.list();
  const libStats = ctx.lib.host.stats();
  const providers = providersOf(ctx);
  const base: Record<string, unknown> = {
    name: "cardano-debug",
    version: packageVersion(),
    build: buildInfo(),
    node: process.version,
    uptime_s: Math.round((Date.now() - ctx.startedAt) / 1000),
    engines: {
      cquisitor_lib: libStats.workerInfo ?? { status: libStats.alive ? "loading" : "cold" },
      de_uplc_engine: ctx.services.engineInfo ?? "not loaded",
      dehosk_decompiler: ctx.services.decompilerInfo ?? "not loaded",
    },
    semantics: SEMANTICS,
    vocabulary: {
      redeemer: "<purpose>:<index> with purpose in spend|mint|withdraw|publish|vote|propose (aliases Reward/Cert, 'Spending #0', r:<witness index> accepted)",
      integers: "on-chain quantities and decoded data-tree integers are decimal strings; indices, counters and line numbers are JSON numbers",
      plutus_version: "V1|V2|V3",
      handles: "tx_id = tx_<network>_<12 hex> (deterministic; re-run tx_load when expired); dbg_id = dbg_<uuid> (re-run debug_open when expired)",
    },
    limits: {
      lib_call_timeout_ms: ctx.config.libCallTimeoutMs,
      eval_timeout_ms: ctx.config.evalTimeoutMs,
      run_timeout_ms: ctx.config.runTimeoutMs,
      decompile_timeout_ms: ctx.config.decompileTimeoutMs,
      max_lib_input_bytes: ctx.config.maxLibInputBytes,
      max_validate_input_bytes: ctx.config.maxValidateInputBytes,
      tx_store: { max: ctx.config.txStoreMax, idle_ttl_ms: ctx.config.txStoreTtlMs },
      sessions: { max: ctx.config.sessionMax, idle_ttl_ms: ctx.config.sessionIdleTtlMs, absolute_ttl_ms: ctx.config.sessionAbsoluteTtlMs },
    },
    providers: {
      default: ctx.config.defaultProvider,
      koios_api_key: Boolean(ctx.config.koiosApiKey),
      blockfrost_project_id: {
        mainnet: Boolean(ctx.config.blockfrostProjectIds.mainnet),
        preprod: Boolean(ctx.config.blockfrostProjectIds.preprod),
        preview: Boolean(ctx.config.blockfrostProjectIds.preview),
      },
      cache_dir: ctx.config.cacheDir,
    },
    resource_providers: providers.implemented(),
    open_sessions: sessions.map((s) => ({ dbg_id: s.dbgId, mode: s.mode, tx_id: s.txId, redeemer: s.redeemer, idle_s: Math.round((Date.now() - s.lastUsedAt) / 1000) })),
    loaded_transactions: ctx.txStore.list().map((t) => ({ tx_id: t.txId, tx_hash: t.txHash, network: t.network, source: t.source, chain_context: Boolean(t.validationContext), validated: Boolean(t.validation) })),
    lib_worker: { generation: libStats.generation, total_calls: libStats.totalCalls, total_respawns: libStats.totalRespawns },
  };
  const extras = providers.serverInfoExtras();
  return Object.keys(extras).length ? mergeInfo(base, extras) : base;
}

function mergeInfo(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const existing = out[key];
    out[key] =
      existing !== null && typeof existing === "object" && !Array.isArray(existing) && value !== null && typeof value === "object" && !Array.isArray(value)
        ? mergeInfo(existing as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return out;
}

/** `cardano-debug://cddl`: the bundled era schemas with their rule counts (outline through the lib worker). */
export async function cddlIndex(ctx: AppContext): Promise<Record<string, unknown>> {
  const attribution = cddlAttribution();
  const eras: Array<Record<string, unknown>> = [];
  for (const era of ERA_PRESETS) {
    const text = loadEraCddl(era);
    const entry: Record<string, unknown> = { era, uri: `cardano-debug://cddl/${era}`, chars: text.length, lines: text.split("\n").length };
    try {
      const info = await loadSchemaInfo(ctx.lib, resolveSchemaInput(era));
      entry.valid = info.validation.valid;
      entry.rules = info.declared.length;
      entry.roots = info.roots.length;
      entry.groups = info.groups.length;
      entry.generic = info.parameterised.length;
    } catch (error) {
      entry.note = `outline unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    eras.push(entry);
  }
  return {
    default: DEFAULT_ERA,
    eras,
    ledger_revision: attribution.revision,
    license: "Apache-2.0 (IntersectMBO/cardano-ledger, Input Output Global Inc)",
    attribution: attribution.text,
    tools: { validate: "cbor_validate(hex, cddl=<era>|<text>|<path>, rule?)", inspect: "cddl_check(cddl=<era>|<text>|<path>, rule?, format?)" },
  };
}

// ---------- the routes ----------

const asText = (value: unknown, mimeType = "application/json"): ArtifactText | undefined => (value === undefined ? undefined : { text: typeof value === "string" ? value : prettyJson(value), mimeType });

export const ROUTES: Route[] = [
  {
    name: "server-info",
    template: "cardano-debug://server/info",
    title: "cardano-debug server info",
    description: "Version and build (time, commit, de-uplc-web), engine provenance, semantics notes, vocabulary, limits, configured providers (booleans only), open sessions and loaded transactions.",
    mimeType: "application/json",
    read: async (ctx) => prettyJson(serverInfo(ctx)),
  },
  {
    name: "cddl-index",
    template: "cardano-debug://cddl",
    title: "Bundled CDDL schemas",
    description: `Index of the bundled era CDDL schemas (${ERA_PRESETS.join(", ")}): rule / root counts per era, the ledger revision and the attribution; the presets cbor_validate and cddl_check accept.`,
    mimeType: "application/json",
    read: async (ctx) => prettyJson(await cddlIndex(ctx)),
  },
  {
    name: "cddl-conway",
    template: `cardano-debug://cddl/${DEFAULT_ERA}`,
    title: "Conway CDDL",
    description: "The bundled Conway-era CDDL, the default schema of cbor_validate (text; ?offset=&limit= for line windows).",
    mimeType: "text/plain",
    read: async () => loadEraCddl(DEFAULT_ERA),
  },
  {
    name: "cddl-era",
    template: "cardano-debug://cddl/{era}",
    title: "Era CDDL",
    description: `One bundled era CDDL as text, era in ${ERA_PRESETS.join(" | ")} (?offset=<line>&limit=<lines> for a window); cbor_validate error rows name the line of the fragment they point at.`,
    mimeType: "text/plain",
    read: async (_ctx, _uri, { era }) => (isEraPreset(era) ? loadEraCddl(era) : undefined),
  },
  {
    name: "docs-index",
    template: "cardano-debug://docs",
    title: "Built-in docs index",
    description: `The model-facing reference topics (${DOC_TOPICS.join(", ")}), one line each. Same content as the docs tool without arguments.`,
    mimeType: "text/markdown",
    read: async () => docIndexMarkdown(),
  },
  {
    name: "docs-topic",
    template: "cardano-debug://docs/{topic}",
    title: "Built-in doc topic",
    description: `One topic's summary and its sections (id, gist, size), topic in ${DOC_TOPICS.join(" | ")}.`,
    mimeType: "text/markdown",
    read: async (_ctx, _uri, { topic }) => (isDocTopic(topic) ? topicIndexMarkdown(topic) : undefined),
  },
  {
    name: "docs-section",
    template: "cardano-debug://docs/{topic}/{section}",
    title: "Built-in doc section",
    description: "One section as markdown, by its id (as the topic index lists it), number or heading.",
    mimeType: "text/markdown",
    read: async (_ctx, _uri, { topic, section }) => (isDocTopic(topic) && section ? findSection(section, topic)?.section.text : undefined),
  },
  {
    name: "tx-cbor",
    template: "cardano-debug://tx/{tx_id}/cbor",
    title: "Transaction CBOR",
    description: "Raw transaction bytes as hex.",
    mimeType: "text/plain",
    read: async (ctx, _uri, { tx_id }) => (await getRecord(ctx, tx_id))?.txHex,
  },
  {
    name: "tx-decoded",
    template: "cardano-debug://tx/{tx_id}/decoded.json",
    title: "Decoded transaction",
    description: "The whole decoded transaction (CSL JSON, pretty-printed; embedded PlutusData / metadata are JSON strings).",
    mimeType: "application/json",
    read: async (ctx, _uri, { tx_id }) => {
      const record = await getRecord(ctx, tx_id);
      return record ? prettyJson(record.decoded) : undefined;
    },
  },
  {
    name: "tx-validation",
    template: "cardano-debug://tx/{tx_id}/validation.json",
    title: "Validation result",
    description: "Phase-1 errors/warnings and per-redeemer phase-2 results without byte fields (available after tx_validate).",
    mimeType: "application/json",
    read: async (ctx, _uri, { tx_id }) => {
      const record = await getRecord(ctx, tx_id);
      if (!record) return undefined;
      return asText((await providersOf(ctx).first("txValidation", record)) ?? validationView(record));
    },
  },
  {
    name: "tx-bundle",
    template: "cardano-debug://tx/{tx_id}/bundle.json",
    title: "Offline bundle",
    description: "Self-contained bundle (tx + resolved chain state + validation) that tx_load(bundle=…) replays without network (after tx_load / bundle_export).",
    mimeType: "application/json",
    read: async (ctx, _uri, { tx_id }) => {
      const record = await getRecord(ctx, tx_id);
      if (!record) return undefined;
      const fromProvider = await providersOf(ctx).first("txBundle", record);
      if (fromProvider !== undefined) return asText(fromProvider);
      if (record.bundlePath) {
        const { readFile } = await import("node:fs/promises");
        return readFile(record.bundlePath, "utf8").catch(() => undefined);
      }
      return undefined;
    },
  },
  {
    name: "tx-necessary",
    template: "cardano-debug://tx/{tx_id}/necessary.json",
    title: "Necessary chain data",
    description: "UTxOs / accounts / pools / dReps / governance actions the validation needs (get_necessary_data_list; after tx_load).",
    mimeType: "application/json",
    read: async (ctx, _uri, { tx_id }) => {
      const record = await getRecord(ctx, tx_id);
      if (!record) return undefined;
      return asText((await providersOf(ctx).first("txNecessary", record)) ?? record.necessary);
    },
  },
  ...REDEEMER_ARTIFACT_PARTS.map(
    (part): Route => ({
      name: `tx-redeemer-${part.replace(/\W/g, "-")}`,
      template: `cardano-debug://tx/{tx_id}/redeemer/{ref}/${part}`,
      title: `Redeemer ${part}`,
      description: redeemerPartDescription(part),
      mimeType: mimeFor(part),
      read: async (ctx, _uri, { tx_id, ref }) => {
        const record = await getRecord(ctx, tx_id);
        const target = record && ref ? resolveRedeemer(record, ref) : undefined;
        if (!record || !target) return undefined;
        const canonical = { purpose: target.purpose, index: target.index };
        return (await providersOf(ctx).first("redeemerArtifact", record, canonical, part)) ?? redeemerArtifactDefault(record, target, part);
      },
    }),
  ),
  {
    name: "tx-script-bytes",
    template: "cardano-debug://tx/{tx_id}/script/{script_hash}/bytes.hex",
    title: "Script bytes (tx-scoped)",
    description: "Hex of a script the transaction uses: witness, inline in an output, resolved by a validated redeemer, or a reference input's script.",
    mimeType: "text/plain",
    read: async (ctx, _uri, { tx_id, script_hash }) => {
      const record = await getRecord(ctx, tx_id);
      if (!record || !script_hash) return undefined;
      return scriptBytesFromRecord(record, String(script_hash))?.hex;
    },
  },
  ...SCRIPT_ARTIFACT_PARTS.map(
    (part): Route => ({
      name: `script-${part.replace(/\W/g, "-")}`,
      template: `cardano-debug://script/{script_hash}/${part}`,
      title: `Script ${part}`,
      description: scriptPartDescription(part),
      mimeType: mimeFor(part),
      read: async (ctx, uri, { script_hash }) => {
        if (!script_hash || !/^[0-9a-f]{56}$/i.test(script_hash)) return undefined;
        const hash = script_hash.toLowerCase();
        const opts = uri.searchParams.get("opts") ?? undefined;
        return (await providersOf(ctx).first("scriptArtifact", hash, part, { opts })) ?? scriptArtifactDefault(ctx, hash, part);
      },
    }),
  ),
  ...SESSION_ARTIFACT_PARTS.map(
    (part): Route => ({
      name: `session-${part.replace(/\W/g, "-")}`,
      template: `cardano-debug://session/{dbg_id}/${part}`,
      title: `Session ${part}`,
      description: sessionPartDescription(part),
      mimeType: mimeFor(part),
      read: async (ctx, _uri, { dbg_id }) => {
        const session = dbg_id ? ctx.sessions.get(dbg_id) : undefined;
        if (!session) return undefined;
        const fromProvider = await providersOf(ctx).first("sessionArtifact", session, part);
        if (fromProvider) return fromProvider;
        return part === "state.json" ? asText(sessionStateView(session)) : undefined;
      },
    }),
  ),
  {
    name: "ui-link-url",
    template: "cardano-debug://link/{link_id}/url.txt",
    title: "UI link URL",
    description: "The full URL a ui_link call built (cquisitor / de-uplc-web), for links too long to inline; kept for the last 32 links.",
    mimeType: "text/plain",
    read: async (ctx, _uri, { link_id }) => (link_id && LINK_ID_PATTERN.test(link_id) ? ctx.services.uiLinks?.get(link_id) : undefined),
  },
  {
    name: "chain-epoch-params",
    template: "cardano-debug://chain/{net}/epoch_params",
    title: "Epoch / protocol parameters",
    description: "Current protocol parameters of a network as the chain layer fetched them (mainnet | preprod | preview).",
    mimeType: "application/json",
    read: async (ctx, _uri, { net }) => {
      if (!isNetwork(net)) return undefined;
      return asText(await providersOf(ctx).first("epochParams", net as Network));
    },
  },
];

function redeemerPartDescription(part: RedeemerArtifactPart): string {
  switch (part) {
    case "context.json":
      return "The ScriptContext the validator saw, as JSON (integers as decimal strings); after tx_validate.";
    case "context.cbor":
      return "The ScriptContext as PlutusData CBOR hex; after tx_validate.";
    case "traces.txt":
      return "Trace messages emitted while evaluating the redeemer, one per line; after tx_validate.";
    case "script.hex":
      return "Bytes of the script the redeemer runs (hex): the evaluated bytes after tx_validate, else the witness / reference script by hash (also after a validation timeout).";
    case "error.txt":
      return "Full machine error text of the redeemer evaluation; after tx_validate.";
    case "parts.json":
      return "Exact engine PartsConfig (script, language, context, redeemer, datum, cost model, ex-units) for de-uplc-web; needs the engine layer.";
    case "links.txt":
      return "Deep links into de-uplc-web / cquisitor for this redeemer; needs the hand-off layer.";
  }
}

function scriptPartDescription(part: ScriptArtifactPart): string {
  switch (part) {
    case "pseudocode.txt":
      return "Decompiled pseudocode (dehosk); ?opts=<id> picks a decompile options set; after script_decompile.";
    case "uplc.txt":
      return "Pretty-printed UPLC of the script (spine-flattened after script_decompile; otherwise from any loaded transaction that carries it), in windows of 400 lines unless ?limit= is given, indentation compacted. Not the debugger's listing: uplc_line coordinates belong to session/{dbg_id}/uplc.txt.";
    case "uplc_canonical.txt":
      return "Binary-nested (canonical) UPLC of the script, windowed and compacted like uplc.txt; after script_decompile with view='uplc_canonical'.";
    case "bytes.hex":
      return "Script bytes (hex) from any loaded transaction or the chain layer's cache.";
  }
}

function sessionPartDescription(part: SessionArtifactPart): string {
  switch (part) {
    case "uplc.txt":
      return "The session's one-term-per-line UPLC listing (line n = uplc_line n; term ids per line via debug_source with_ids=true), in windows of 400 lines unless ?offset=&limit= is given; each window's indentation is compacted (_meta.dedent, indent_capped_at); needs the engine layer.";
    case "state.json":
      return "Session state: identity, position, budget, breakpoints, flags (JSON, one row per line; ?offset=&limit= pages it).";
    case "env.json":
      return "Current environment of the CEK machine (lazy tree; JSON, one row per line); needs the engine layer.";
    case "traces.txt":
      return "Trace messages emitted so far in the session; needs the engine layer.";
    case "profile.json":
      return "Last debug_profile report (JSON, one row per line: a term / builtin / timeline row each; ?offset=&limit= pages it; the whole report of a large script is 100k+ characters); needs the engine layer.";
  }
}

// ---------- registration ----------

interface CompiledRoute {
  route: Route;
  matcher: UriTemplate | null;
}

let compiled: CompiledRoute[] | null = null;
function compiledRoutes(): CompiledRoute[] {
  if (!compiled) compiled = ROUTES.map((route) => ({ route, matcher: route.template.includes("{") ? new UriTemplate(route.template) : null }));
  return compiled;
}

/** Route a URI (query ignored) to `{route, vars}`; `undefined` when nothing matches. */
export function matchRoute(uri: URL): { route: Route; vars: RouteVars } | undefined {
  const bare = uri.href.split("?")[0]!.split("#")[0]!;
  for (const { route, matcher } of compiledRoutes()) {
    if (!matcher) {
      if (route.template === bare) return { route, vars: {} };
      continue;
    }
    const vars = matcher.match(bare);
    if (vars) {
      const flat: RouteVars = {};
      for (const [k, v] of Object.entries(vars)) flat[k] = Array.isArray(v) ? v.join(",") : v;
      return { route, vars: flat };
    }
  }
  return undefined;
}

async function readRoute(ctx: AppContext, route: Route, uri: URL, vars: RouteVars): Promise<{ contents: ResourceContent[] }> {
  const answer = await route.read(ctx, uri, vars);
  if (answer === undefined) throw notFound(uri);
  const text = typeof answer === "string" ? answer : answer.text;
  const mimeType = typeof answer === "string" ? route.mimeType : (answer.mimeType ?? route.mimeType);
  return { contents: [textContent(uri, text, mimeType, { listing: typeof answer !== "string" && answer.listing === true })] };
}

/** Read any `cardano-debug://` URI through the routing table (what the MCP handlers call). */
export async function readResourceUri(ctx: AppContext, uri: URL): Promise<{ contents: ResourceContent[] }> {
  const match = matchRoute(uri);
  if (!match) throw notFound(uri);
  return readRoute(ctx, match.route, uri, match.vars);
}

export const coreResources: ResourceModule = {
  name: "core",
  register(server, ctx) {
    for (const route of ROUTES) {
      const meta = { title: route.title, description: route.description, mimeType: route.mimeType };
      if (route.template.includes("{")) {
        server.registerResource(route.name, new ResourceTemplate(route.template, { list: undefined }), meta, async (uri, vars) => {
          // A template whose last segment is a variable (docs/{topic}) would swallow `?offset=…` into
          // the variable: with a query string, re-match on the bare URI like the catch-all does.
          if (uri.search) return readResourceUri(ctx, uri);
          const flat: RouteVars = {};
          for (const [k, v] of Object.entries(vars)) flat[k] = Array.isArray(v) ? v.join(",") : String(v);
          return readRoute(ctx, route, uri, flat);
        });
      } else {
        server.registerResource(route.name, route.template, meta, async (uri) => readRoute(ctx, route, uri, {}));
      }
    }
    // Catch-all for URIs with a query string (`?offset=&limit=`, `?opts=`): the SDK matches templates
    // against the whole URI, so this last template strips the query and re-routes.
    server.registerResource(
      "any-with-query",
      new ResourceTemplate("cardano-debug://{+path}", { list: undefined }),
      {
        title: "Any cardano-debug resource (with query)",
        description: "Same URIs as above with ?offset=<line>&limit=<lines> (text windows) or ?opts=<id> (pseudocode options).",
        mimeType: "text/plain",
      },
      async (uri) => readResourceUri(ctx, uri),
    );
  },
};

/** Every resource module the server registers (other layers append theirs). */
export const ALL_RESOURCES: ResourceModule[] = [coreResources];

export function registerResources(server: McpServer, ctx: AppContext): void {
  for (const module of ALL_RESOURCES) module.register(server, ctx);
}
