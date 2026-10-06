// tx_inspect: one section of a decoded transaction, paged. Works from the bytes alone; once the
// chain layer has attached a ValidationInputContext to the TxStore record (tx_load), the inputs
// are enriched with the resolved UTxO rows, spend redeemers get their script hash from the spent
// address, and reference scripts appear in the `scripts` section.
//
// Enrichment hook: `providersOf(ctx).first/firstSync('resolvedUtxos', record)` is asked first;
// the default reads `record.validationContext.utxoSet` (see src/tx/dataView.ts).

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { govActionIdBech32, govActionLabel } from "../chain/govId.js";
import type { Network } from "../config.js";
import type { AppContext, ToolModule } from "../context.js";
import { providersOf } from "../providers.js";
import type { PlutusVersionOrNative, RedeemerTarget, TxRecord } from "../store/txStore.js";
import {
  addressCredentials,
  integersAsStrings,
  referenceScriptsOf,
  resolvedUtxosFromContext,
  withSpendScriptHashes,
  type ResolvedUtxo,
  type ViewScript,
} from "../tx/dataView.js";
import { formatInputRef, inputRefOf, parseEmbeddedJson, plutusScriptHex, resolveTxInput, sortedInputs } from "../tx/record.js";
import {
  capJson,
  capString,
  childKeys,
  clampInt,
  DEFAULT_DEPTH,
  DEFAULT_ROWS,
  fail,
  failFromError,
  lookupPath,
  MAX_DEPTH,
  missingUtxosView,
  MAX_ROWS,
  pageWithinChars,
  ROW_PAGE_CHARS,
  ok,
  pageOf,
  parsePath,
  pruneDepth,
  RAW_JSON_CHARS,
  resourceLink,
  type ResourceLink,
  type ToolResult,
} from "./_shared.js";
import { TOOL_TEXT } from "./descriptions.js";

const T = TOOL_TEXT.tx_inspect;

export const TX_SECTIONS = ["body", "inputs", "outputs", "redeemers", "scripts", "datums", "witnesses", "certs", "governance", "aux", "raw_json", "mint", "withdrawals"] as const;
export type TxSection = (typeof TX_SECTIONS)[number];

const inputSchema = z.object({
  tx_id: z.string().optional().describe(T.params["tx_id"]),
  tx_cbor: z.string().optional().describe(T.params["tx_cbor"]),
  network: z.enum(["mainnet", "preprod", "preview"]).optional().describe(T.params["network"]),
  section: z
    .enum(TX_SECTIONS, { error: (issue) => `section ${JSON.stringify(issue.input)} is not a tx_inspect section; valid: ${TX_SECTIONS.join(", ")} (default body)` })
    .optional()
    .describe(T.params["section"]),
  offset: z.number().int().min(0).optional().describe(T.params["offset"]),
  limit: z.number().int().min(1).max(MAX_ROWS).optional().describe(T.params["limit"]),
  path: z.string().optional().describe(T.params["path"]),
  depth: z.number().int().min(1).max(MAX_DEPTH).optional().describe(T.params["depth"]),
});

export type TxInspectArgs = z.infer<typeof inputSchema>;
type Json = Record<string, unknown>;

const rec = (value: unknown): Json => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const count = (value: unknown): number => (Array.isArray(value) ? value.length : value !== null && typeof value === "object" ? Object.keys(value as Json).length : 0);
const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" || typeof value === "bigint" ? String(value) : undefined;

/** A decoded PlutusData / metadata tree in tool form: integers as decimal strings, cut at `depth`. */
function dataTree(value: unknown, depth: number): unknown {
  return pruneDepth(integersAsStrings(parseEmbeddedJson(value)), depth);
}

/** Resources of a transaction handle; tx_inspect(section='body') lists them, `chainResources` adds the chain ones. */
export function txResources(record: TxRecord): ResourceLink[] {
  const links = [
    resourceLink(`cardano-debug://tx/${record.txId}/decoded.json`, `${record.txId} decoded`, "application/json", "Full decoded transaction (CSL JSON)"),
    resourceLink(`cardano-debug://tx/${record.txId}/cbor`, `${record.txId} cbor`, "text/plain", "Raw transaction CBOR hex"),
  ];
  if (record.validation) {
    links.push(resourceLink(`cardano-debug://tx/${record.txId}/validation.json`, `${record.txId} validation`, "application/json", "Validation result without byte fields"));
  }
  return links;
}

// ---------- the enriched view of a record ----------

export interface TxView {
  record: TxRecord;
  /** Inputs in ledger order (`<hash>#<ix>`), the order spend indices refer to. */
  sortedInputRefs: string[];
  /** Resolved UTxOs (`<hash>#<ix>` -> row); empty without chain context. */
  resolved: Map<string, ResolvedUtxo>;
  /** Witness + inline + reference scripts (a reference script whose language is not known says "unknown"). */
  scripts: ViewScript[];
  /** Redeemer targets with spend script hashes filled from the resolved inputs. */
  redeemers: RedeemerTarget[];
  versionByHash: Map<string, PlutusVersionOrNative>;
}

/** Build the enriched view: providers first, then the record's own ValidationInputContext. */
export function txView(ctx: AppContext, record: TxRecord): TxView {
  const sortedInputRefs = sortedInputs(record.decoded).map(formatInputRef);
  const resolved = providersOf(ctx).firstSync("resolvedUtxos", record) ?? resolvedUtxosFromContext(record);
  const body = record.decoded.transaction.body;
  const referenced = [...arr(body.reference_inputs), ...arr(body.inputs)]
    .map(inputRefOf)
    .filter((x): x is NonNullable<typeof x> => x !== undefined)
    .map(formatInputRef);
  const known = new Set(record.scripts.map((s) => s.script_hash));
  const referenceScripts = referenceScriptsOf(resolved, Array.from(new Set(referenced))).filter((s) => !known.has(s.script_hash));
  const scripts = [...record.scripts, ...referenceScripts];
  const versionByHash = new Map<string, PlutusVersionOrNative>();
  for (const s of scripts) if (s.plutus_version !== "unknown") versionByHash.set(s.script_hash, s.plutus_version);
  const redeemers = withSpendScriptHashes(record.redeemerTargets, sortedInputRefs, resolved, versionByHash);
  return { record, sortedInputRefs, resolved, scripts, redeemers, versionByHash };
}

/** Byte length of a hex string, or `undefined` without one. */
function sizeOfHex(hex: string | undefined): number | undefined {
  return hex === undefined ? undefined : hex.length / 2;
}

// ---------- sections ----------

function bodyRows(view: TxView): Json[] {
  const { record } = view;
  const body = record.decoded.transaction.body;
  const ws = record.decoded.transaction.witness_set;
  const collateralReturn = rec(body.collateral_return);
  return [
    {
      tx_hash: record.txHash,
      network: record.network,
      size_bytes: record.sizeBytes,
      is_valid: record.decoded.transaction.is_valid,
      fee: str(body.fee),
      validity: { start: str(body.validity_start_interval) ?? null, end: str(body.ttl) ?? null },
      network_id: body.network_id ?? null,
      script_data_hash: body.script_data_hash ?? null,
      auxiliary_data_hash: body.auxiliary_data_hash ?? null,
      total_collateral: str(body.total_collateral) ?? null,
      collateral_return: Object.keys(collateralReturn).length ? { address: collateralReturn.address, lovelace: str(rec(collateralReturn.amount).coin) } : null,
      donation: str(body.donation) ?? null,
      current_treasury_value: str(body.current_treasury_value) ?? null,
      required_signers: arr(body.required_signers),
      counts: {
        inputs: count(body.inputs),
        reference_inputs: count(body.reference_inputs),
        collateral: count(body.collateral),
        outputs: count(body.outputs),
        mint_policies: count(body.mint),
        certs: count(body.certs),
        withdrawals: count(body.withdrawals),
        votes: count(body.voting_procedures),
        proposals: count(body.voting_proposals),
        redeemers: count(ws.redeemers),
        vkey_witnesses: count(ws.vkeys),
        bootstrap_witnesses: count(ws.bootstraps),
        witness_scripts: count(ws.plutus_scripts) + count(ws.native_scripts),
        reference_scripts: view.scripts.filter((s) => s.source.startsWith("reference")).length,
        datums: count(rec(ws.plutus_data).elems),
        metadata_labels: count(rec(rec(record.decoded.transaction.auxiliary_data).metadata)),
      },
      redeemers: view.redeemers.map((r) => r.ref),
      chain_context: record.validationContext ? "resolved" : "none",
      ...(record.protocolMajor !== undefined ? { protocol_major: record.protocolMajor } : {}),
      ...(record.slot !== undefined ? { slot: record.slot } : {}),
      ...(record.missingUtxos?.length ? missingUtxosView(record.missingUtxos) : {}),
      ...(record.validation ? { validated: true } : {}),
    },
  ];
}

interface InputRow extends Json {
  position: number;
  role: "input" | "reference" | "collateral";
  utxo?: string;
  spend_index?: number;
  redeemer?: string;
  resolved?: Json;
  /** Set on the page rows only; decoded by the lib after paging. */
  _inline_datum_hex?: string;
}

function inputRows(view: TxView): InputRow[] {
  const body = view.record.decoded.transaction.body;
  const spendIndexOf = new Map<string, number>(view.sortedInputRefs.map((ref, i) => [ref, i]));
  const redeemerOf = new Map<number, RedeemerTarget>();
  for (const r of view.redeemers) if (r.purpose === "spend") redeemerOf.set(r.index, r);
  const rows: InputRow[] = [];
  const push = (raw: unknown, role: InputRow["role"], position: number) => {
    const ref = inputRefOf(raw);
    const row: InputRow = { position, role };
    if (!ref) {
      row.raw = pruneDepth(raw, 2);
      rows.push(row);
      return;
    }
    const key = formatInputRef(ref);
    row.utxo = key;
    if (role === "input") {
      const spendIndex = spendIndexOf.get(key);
      row.spend_index = spendIndex;
      const redeemer = spendIndex !== undefined ? redeemerOf.get(spendIndex) : undefined;
      if (redeemer) {
        row.redeemer = redeemer.ref;
        if (redeemer.script_hash) row.script_hash = redeemer.script_hash;
      }
    }
    const utxo = view.resolved.get(key);
    if (utxo) {
      row.resolved = {
        address: utxo.address,
        payment_credential: utxo.payment,
        lovelace: utxo.lovelace,
        assets_count: utxo.assets.length,
        assets: utxo.assets.slice(0, 8),
        ...(utxo.assets.length > 8 ? { assets_truncated_count: utxo.assets.length - 8 } : {}),
        datum_hash: utxo.datum_hash,
        ...(utxo.inline_datum_hex ? { inline_datum_bytes: utxo.inline_datum_hex.length / 2 } : {}),
        ref_script_hash: utxo.ref_script_hash,
        ref_script_version: utxo.ref_script_version ?? (utxo.ref_script_hash ? "unknown" : undefined),
        ...(utxo.spent ? { spent: true } : {}),
      };
      if (utxo.inline_datum_hex) row._inline_datum_hex = utxo.inline_datum_hex;
    }
    rows.push(row);
  };
  arr(body.inputs).forEach((raw, i) => push(raw, "input", i));
  arr(body.reference_inputs).forEach((raw, i) => push(raw, "reference", i));
  arr(body.collateral).forEach((raw, i) => push(raw, "collateral", i));
  return rows;
}

/** Decode the inline datums of the page rows (one lib call per row, page-bounded). */
async function decodeInlineDatums(ctx: AppContext, rows: InputRow[], depth: number): Promise<void> {
  for (const row of rows) {
    const hex = row._inline_datum_hex;
    delete row._inline_datum_hex;
    if (!hex || !row.resolved) continue;
    try {
      const decoded = await ctx.lib.decodeType<{ plutus_data?: unknown; data_hash?: string }>(hex, "PlutusData", { plutus_data_schema: "DetailedSchema" });
      row.resolved.inline_datum = dataTree(decoded?.plutus_data ?? decoded, depth);
      if (decoded?.data_hash) row.resolved.inline_datum_hash = decoded.data_hash;
    } catch (error) {
      row.resolved.inline_datum_error = capString(error instanceof Error ? error.message : String(error), 200);
    }
  }
}

function multiassetSummary(multiasset: unknown): { assets_count: number; assets: Array<{ policy: string; asset_name: string; quantity: string }>; assets_truncated_count?: number } {
  const list: Array<{ policy: string; asset_name: string; quantity: string }> = [];
  for (const [policy, assets] of Object.entries(rec(multiasset))) {
    for (const [name, qty] of Object.entries(rec(assets))) list.push({ policy, asset_name: name, quantity: str(qty) ?? "0" });
  }
  return { assets_count: list.length, assets: list.slice(0, 8), ...(list.length > 8 ? { assets_truncated_count: list.length - 8 } : {}) };
}

function outputRows(view: TxView, depth: number): Json[] {
  const { record } = view;
  const body = record.decoded.transaction.body;
  const inlineScripts = record.hashes.output_inline_scripts;
  const inlineDatumHashes = record.hashes.output_inline_datum_hashes;
  return arr(body.outputs).map((raw, index) => {
    const output = rec(raw);
    const amount = rec(output.amount);
    const datum = rec(output.plutus_data);
    const scriptRef = rec(output.script_ref);
    const address = str(output.address) ?? "";
    const creds = addressCredentials(address);
    const row: Json = {
      index,
      address,
      ...(creds?.payment ? { payment_credential: creds.payment } : {}),
      lovelace: str(amount.coin),
      ...multiassetSummary(amount.multiasset),
    };
    if (typeof datum.DataHash === "string") row.datum = { kind: "hash", hash: datum.DataHash };
    else if (datum.Data !== undefined) {
      row.datum = { kind: "inline", hash: inlineDatumHashes[index] ?? undefined, value: dataTree(datum.Data, depth) };
    }
    if (Object.keys(scriptRef).length > 0) {
      const info = inlineScripts[index];
      const kind = Object.keys(scriptRef)[0];
      row.script_ref = {
        kind,
        script_hash: info?.hash,
        plutus_version: info ? (info.script_type === "Native" ? "native" : info.script_type.Plutus) : undefined,
        size_bytes: sizeOfHex(plutusScriptHex(scriptRef.PlutusScript)),
      };
    }
    return row;
  });
}

function mintRows(view: TxView): Json[] {
  const mint = arr(view.record.decoded.transaction.body.mint);
  const redeemerByPolicy = new Map<string, RedeemerTarget>();
  for (const r of view.redeemers) if (r.purpose === "mint" && r.script_hash) redeemerByPolicy.set(r.script_hash, r);
  return mint.map((entry, position) => {
    const [policy, assets] = Array.isArray(entry) ? entry : [undefined, undefined];
    const list = Object.entries(rec(assets)).map(([name, qty]) => ({ asset_name: name, quantity: str(qty) ?? "0" }));
    const redeemer = typeof policy === "string" ? redeemerByPolicy.get(policy.toLowerCase()) : undefined;
    return {
      position,
      policy,
      redeemer: redeemer?.ref,
      plutus_version: redeemer?.plutus_version ?? (typeof policy === "string" ? view.versionByHash.get(policy.toLowerCase()) : undefined),
      assets_count: list.length,
      assets: list.slice(0, 16),
      ...(list.length > 16 ? { assets_truncated_count: list.length - 16 } : {}),
    };
  });
}

function withdrawalRows(view: TxView): Json[] {
  const withdrawals = rec(view.record.decoded.transaction.body.withdrawals);
  const redeemerByAccount = new Map<string, RedeemerTarget>();
  for (const r of view.redeemers) if (r.purpose === "withdraw") redeemerByAccount.set(r.target.replace(/^stake /, ""), r);
  return Object.entries(withdrawals).map(([account, amount], position) => {
    const redeemer = redeemerByAccount.get(account);
    const creds = addressCredentials(account);
    return {
      position,
      reward_account: account,
      stake_credential: creds?.stake,
      amount: str(amount),
      redeemer: redeemer?.ref,
      script_hash: redeemer?.script_hash,
      plutus_version: redeemer?.plutus_version,
    };
  });
}

function redeemerRows(view: TxView, depth: number): Json[] {
  const redeemers = arr(view.record.decoded.transaction.witness_set.redeemers);
  return view.redeemers.map((target) => {
    const raw = rec(redeemers[target.witness_index]);
    const evalResult = view.record.validation?.redeemers.get(target.ref);
    const row: Json = {
      ref: target.ref,
      witness_index: target.witness_index,
      target: target.target,
      script_hash: target.script_hash,
      plutus_version: target.plutus_version,
      ex_units: target.ex_units,
      data: dataTree(raw.data, depth),
    };
    if (evalResult) {
      row.validated = {
        success: evalResult.success,
        error_headline: evalResult.error ? capString(String(evalResult.error).split("\n")[0] ?? "", 200) : undefined,
        calculated_ex_units: evalResult.calculated_ex_units ? { mem: String(evalResult.calculated_ex_units.mem), steps: String(evalResult.calculated_ex_units.steps) } : undefined,
        trace_count: Array.isArray(evalResult.logs) ? evalResult.logs.length : undefined,
      };
    }
    return row;
  });
}

function scriptRows(view: TxView): Json[] {
  const usedBy = new Map<string, string[]>();
  for (const r of view.redeemers) {
    if (!r.script_hash) continue;
    usedBy.set(r.script_hash, [...(usedBy.get(r.script_hash) ?? []), r.ref]);
  }
  return view.scripts.map((s) => ({
    script_hash: s.script_hash,
    plutus_version: s.plutus_version,
    source: s.source,
    size_bytes: s.size_bytes,
    used_by_redeemers: usedBy.get(s.script_hash) ?? [],
    resources: s.plutus_version === "native" ? undefined : [`cardano-debug://script/${s.script_hash}/bytes.hex`, `cardano-debug://script/${s.script_hash}/uplc.txt`],
  }));
}

function datumRows(view: TxView, depth: number): Json[] {
  const { record } = view;
  const plutusData = rec(record.decoded.transaction.witness_set.plutus_data);
  const elems = arr(plutusData.elems);
  const hashes = record.hashes.witness_datum_hashes;
  const usedByOutput = new Map<string, number[]>();
  record.hashes.output_datum_hashes.forEach((h, i) => {
    if (h) usedByOutput.set(h, [...(usedByOutput.get(h) ?? []), i]);
  });
  const usedByInput: string[] = [];
  for (const [key, utxo] of view.resolved) if (utxo.datum_hash) usedByInput.push(`${utxo.datum_hash}:${key}`);
  return elems.map((raw, witness_index) => {
    const hash = hashes[witness_index] ?? undefined;
    return {
      witness_index,
      datum_hash: hash,
      referenced_by_outputs: hash ? (usedByOutput.get(hash) ?? []) : [],
      referenced_by_inputs: hash ? usedByInput.filter((entry) => entry.startsWith(`${hash}:`)).map((entry) => entry.slice(hash.length + 1)) : [],
      value: dataTree(raw, depth),
    };
  });
}

function witnessRows(view: TxView): Json[] {
  const ws = view.record.decoded.transaction.witness_set;
  const rows: Json[] = [];
  arr(ws.vkeys).forEach((raw, index) => {
    const w = rec(raw);
    rows.push({ index, kind: "vkey", vkey: w.vkey, signature: typeof w.signature === "string" ? capString(w.signature, 32) : undefined });
  });
  arr(ws.bootstraps).forEach((raw, index) => {
    const w = rec(raw);
    rows.push({ index, kind: "bootstrap", vkey: w.vkey, chain_code: w.chain_code !== undefined ? "(present)" : undefined });
  });
  return rows;
}

function certRows(view: TxView, depth: number): Json[] {
  const certs = arr(view.record.decoded.transaction.body.certs);
  const redeemerByIndex = new Map<number, RedeemerTarget>();
  for (const r of view.redeemers) if (r.purpose === "publish") redeemerByIndex.set(r.index, r);
  return certs.map((raw, index) => {
    const cert = rec(raw);
    const kind = Object.keys(cert)[0] ?? "unknown";
    const redeemer = redeemerByIndex.get(index);
    return { index, kind, redeemer: redeemer?.ref, script_hash: redeemer?.script_hash, fields: pruneDepth(cert[kind], depth) };
  });
}

/** A decoded vote entry with the CIP-129 id (and its explorer link) beside each `action_id`. */
function withActionLabels(entry: unknown, network: Network): unknown {
  const voter = rec(entry);
  if (!Array.isArray(voter.votes)) return entry;
  const votes = voter.votes.map((vote) => {
    const actionId = rec(rec(vote).action_id);
    const id = typeof actionId.transaction_id === "string" && typeof actionId.index === "number" ? govActionIdBech32(actionId.transaction_id, actionId.index) : undefined;
    return id ? { ...rec(vote), gov_action: govActionLabel(id, network) } : vote;
  });
  return { ...voter, votes };
}

function governanceRows(view: TxView, depth: number): Json[] {
  const body = view.record.decoded.transaction.body;
  const rows: Json[] = [];
  const redeemerBy = (purpose: "vote" | "propose") => new Map(view.redeemers.filter((r) => r.purpose === purpose).map((r) => [r.index, r] as const));
  const voteRedeemers = redeemerBy("vote");
  const proposalRedeemers = redeemerBy("propose");
  const votes = body.voting_procedures;
  const voteEntries: unknown[] = Array.isArray(votes) ? votes : Object.entries(rec(votes));
  const { network, txHash } = view.record;
  voteEntries.forEach((entry, index) => {
    rows.push({ index, kind: "vote", redeemer: voteRedeemers.get(index)?.ref, value: pruneDepth(withActionLabels(entry, network), depth) });
  });
  arr(body.voting_proposals).forEach((entry, index) => {
    // the id the action has once this transaction is on chain
    const id = govActionIdBech32(txHash, index);
    rows.push({ index, kind: "proposal", redeemer: proposalRedeemers.get(index)?.ref, gov_action: id && govActionLabel(id, network), value: pruneDepth(entry, depth) });
  });
  if (body.current_treasury_value !== undefined || body.donation !== undefined) {
    rows.push({ kind: "treasury", current_treasury_value: str(body.current_treasury_value) ?? null, donation: str(body.donation) ?? null });
  }
  return rows;
}

function auxRows(view: TxView, depth: number): Json[] {
  const aux = rec(view.record.decoded.transaction.auxiliary_data);
  const rows: Json[] = [];
  for (const [label, value] of Object.entries(rec(aux.metadata))) {
    rows.push({ kind: "metadata", label, value: dataTree(value, depth) });
  }
  arr(aux.native_scripts).forEach((s, index) => rows.push({ kind: "native_script", index, value: pruneDepth(s, depth) }));
  arr(aux.plutus_scripts).forEach((s, index) => rows.push({ kind: "plutus_script", index, size_bytes: sizeOfHex(plutusScriptHex(s)) }));
  if (aux.prefer_alonzo_format !== undefined) rows.push({ kind: "format", prefer_alonzo_format: aux.prefer_alonzo_format });
  return rows;
}

// ---------- the tool ----------

export async function txInspect(ctx: AppContext, args: TxInspectArgs): Promise<ToolResult> {
  try {
    const resolution = await resolveTxInput(ctx, args);
    if (!resolution.ok) return resolution.result;
    const { record } = resolution;
    const section: TxSection = args.section ?? "body";
    const view = txView(ctx, record);
    const depth = clampInt(args.depth, DEFAULT_DEPTH, 1, MAX_DEPTH);
    const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(args.limit, DEFAULT_ROWS, 1, MAX_ROWS);
    const common: Json = {
      tx_id: record.txId,
      tx_hash: record.txHash,
      network: record.network,
      section,
      ...(resolution.created ? { created: true } : {}),
      ...(resolution.defaults_applied.length ? { defaults_applied: resolution.defaults_applied } : {}),
    };

    if (section === "raw_json") {
      const segments = parsePath(args.path);
      const lookup = lookupPath(record.decoded, segments);
      if (!lookup.found) {
        return fail({
          ...common,
          code: "path_not_found",
          message: `Path ${JSON.stringify(args.path)} does not exist in the decoded transaction; resolved up to /${lookup.resolved.join("/")}.`,
          resolved: "/" + lookup.resolved.join("/"),
          available: lookup.available ?? childKeys(lookupPath(record.decoded, lookup.resolved).value),
        });
      }
      const capped = capJson(lookup.value, RAW_JSON_CHARS, args.depth ?? MAX_DEPTH);
      return ok(
        {
          ...common,
          path: "/" + segments.join("/"),
          value: capped.value,
          truncated: capped.truncated || undefined,
          depth: capped.depth,
          children: capped.truncated ? childKeys(lookup.value) : undefined,
          hint: capped.truncated ? `Narrow \`path\` (e.g. /transaction/body/outputs/0) or read the whole document: cardano-debug://tx/${record.txId}/decoded.json.` : undefined,
        },
        // The whole-document link only where the answer points at it.
        { links: capped.truncated ? txResources(record).slice(0, 1) : [] },
      );
    }

    let rows: Json[];
    let extra: Json = {};
    switch (section) {
      case "body":
        rows = bodyRows(view);
        break;
      case "inputs": {
        const all = inputRows(view);
        const page = pageOf(all, offset, limit);
        await decodeInlineDatums(ctx, page.rows as InputRow[], depth);
        for (const row of all) delete (row as InputRow)._inline_datum_hex;
        rows = all;
        if (view.resolved.size === 0) extra = { note: "UTxO rows are not resolved (no chain context); tx_load resolves them and adds address / value / datum / reference script per input." };
        else {
          const unresolved = all.filter((row) => row.utxo && !row.resolved).map((row) => row.utxo);
          if (unresolved.length) extra = { unresolved_utxos: unresolved.slice(0, 32), unresolved_count: unresolved.length };
        }
        break;
      }
      case "outputs":
        rows = outputRows(view, depth);
        break;
      case "mint":
        rows = mintRows(view);
        break;
      case "withdrawals":
        rows = withdrawalRows(view);
        break;
      case "redeemers":
        rows = redeemerRows(view, depth);
        if (view.redeemers.some((r) => r.purpose === "spend" && !r.script_hash)) {
          extra = { note: "spend redeemers show script_hash once the spent UTxOs are resolved (tx_load)." };
        }
        break;
      case "scripts":
        rows = scriptRows(view);
        break;
      case "datums":
        rows = datumRows(view, depth);
        break;
      case "witnesses": {
        rows = witnessRows(view);
        try {
          const check = await ctx.lib.checkSignatures(record.txHex);
          extra = {
            signature_check: {
              valid: check.valid,
              invalid_vkey_witnesses: check.invalidVkeyWitnesses ?? [],
              invalid_catalyst_witnesses: check.invalidCatalystWitnesses?.length ? check.invalidCatalystWitnesses : undefined,
            },
            required_signers: arr(record.decoded.transaction.body.required_signers),
          };
        } catch (error) {
          extra = { signature_check: { error: error instanceof Error ? capString(error.message, 200) : String(error) } };
        }
        break;
      }
      case "certs":
        rows = certRows(view, depth);
        break;
      case "governance":
        rows = governanceRows(view, depth);
        break;
      case "aux":
        rows = auxRows(view, depth);
        break;
      default:
        rows = [];
    }
    const page = pageWithinChars(rows, offset, limit);
    return ok(
      {
        ...common,
        total: page.total,
        offset: page.offset,
        rows: page.rows,
        next_offset: page.next_offset,
        truncated: page.truncated,
        ...(page.page_cut
          ? { page_cut: true, page_note: `The page stopped after ${page.rows.length} row(s) to stay under ${ROW_PAGE_CHARS} characters; continue with offset=${page.next_offset}, or lower depth.` }
          : {}),
        ...extra,
      },
      // The handle's resources are listed with the summary; later pages and sections do not repeat them.
      { links: section === "body" ? txResources(record) : [] },
    );
  } catch (error) {
    return failFromError(error);
  }
}

export const txInspectTool: ToolModule = {
  name: "tx_inspect",
  register(server: McpServer, ctx: AppContext) {
    server.registerTool(
      "tx_inspect",
      {
        title: T.title,
        description: T.description,
        inputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args) => txInspect(ctx, args),
    );
  },
};
