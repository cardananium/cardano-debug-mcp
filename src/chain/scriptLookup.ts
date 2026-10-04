// Script bytes by hash for `script_decompile {script_hash, network}` (the decompiler layer's
// `ctx.services.scriptSource` hook): loaded transactions' reference scripts first, then the disk
// cache (immutable, forever), then the provider — Koios `POST /script_info`, Blockfrost
// `GET /scripts/{hash}` + `/scripts/{hash}/cbor`. Every answer is canonicalised and hash-checked
// through the library before it is served.

import type { AppContext } from "../context.js";
import type { Network } from "../config.js";
import type { ChainService } from "./index.js";
import { BLOCKFROST_DEFAULT_BASE_URLS, KOIOS_DEFAULT_BASE_URLS, runWithRequestScope } from "./http.js";
import { selectProvider } from "./providers.js";
import { canonicalizeRefScript, refScriptType, verifyRefScript, type PlutusVersion } from "./refScript.js";
import { chainStateOf } from "./state.js";

export interface LocatedScript {
  hex: string;
  plutus_version?: PlutusVersion | "native";
  source?: string;
}

interface CachedScript {
  inner: string;
  plutus_version: PlutusVersion | "native";
  verified: boolean;
  provider: string;
}

const HASH = /^[0-9a-f]{56}$/;

export async function fetchScriptByHash(service: ChainService, ctx: AppContext, network: Network, scriptHash: string, options: { signal?: AbortSignal } = {}): Promise<LocatedScript | undefined> {
  const hash = scriptHash.trim().toLowerCase();
  if (!HASH.test(hash)) return undefined;

  for (const record of ctx.txStore.list()) {
    if (record.network !== network) continue;
    const ref = chainStateOf(record)?.refScripts[hash];
    if (ref) return { hex: ref.inner, plutus_version: ref.plutus_version, source: `${record.txId} reference ${ref.utxo}${ref.verified ? " (verified)" : ""}` };
  }

  const ns = `scripts/${network}`;
  const cached = await service.cache.getJson<CachedScript>(ns, `${hash}.json`);
  if (cached) return { hex: cached.inner, plutus_version: cached.plutus_version, source: `disk cache (${cached.provider}${cached.verified ? ", verified" : ", unverified"})` };
  if (service.offline) return undefined;

  const selection = selectProvider(ctx.config, network);
  const fetched = await runWithRequestScope({ signal: options.signal, label: `script ${hash.slice(0, 12)}` }, () =>
    selection.provider === "blockfrost" ? fromBlockfrost(network, hash, selection.apiKey!) : fromKoios(network, hash, selection.apiKey),
  );
  if (!fetched) return undefined;
  const type = refScriptType(fetched.type);
  if (!type) return undefined;
  const canonical = canonicalizeRefScript(fetched.bytes, type);
  const check = await verifyRefScript(ctx.lib, canonical, hash);
  const plutus_version = canonical.kind === "native" ? "native" : canonical.plutus_version!;
  await service.cache.setJson(ns, `${hash}.json`, { inner: canonical.inner, plutus_version, verified: check.verified, provider: selection.provider } satisfies CachedScript);
  return {
    hex: canonical.inner,
    plutus_version,
    source: `${selection.provider} script lookup (${check.verified ? "hash verified" : `UNVERIFIED: computed ${check.computed_hash ?? "n/a"}`})`,
  };
}

interface FetchedScript {
  type: string;
  bytes: string;
}

async function fromKoios(network: Network, hash: string, apiKey: string | undefined): Promise<FetchedScript | undefined> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${KOIOS_DEFAULT_BASE_URLS[network]}/script_info`, { method: "POST", headers, body: JSON.stringify({ _script_hashes: [hash] }) });
  if (!response.ok) throw new Error(`Koios API error: ${response.status} ${response.statusText} (script_info)`);
  const rows = (await response.json()) as Array<{ script_hash?: string; type?: string; bytes?: string | null }>;
  const row = rows.find((r) => r.script_hash?.toLowerCase() === hash) ?? rows[0];
  if (!row?.bytes || !row.type) return undefined;
  return { type: row.type, bytes: row.bytes };
}

async function fromBlockfrost(network: Network, hash: string, projectId: string): Promise<FetchedScript | undefined> {
  const headers = { project_id: projectId, Accept: "application/json" };
  const base = BLOCKFROST_DEFAULT_BASE_URLS[network];
  const info = await fetch(`${base}/scripts/${hash}`, { headers });
  if (info.status === 404) return undefined;
  if (!info.ok) throw new Error(`Blockfrost API error: ${info.status} ${info.statusText} (scripts/${hash})`);
  const meta = (await info.json()) as { type?: string };
  if (!meta.type || !/^plutus/i.test(meta.type)) return undefined; // native scripts come back as JSON, not CBOR
  const cbor = await fetch(`${base}/scripts/${hash}/cbor`, { headers });
  if (!cbor.ok) throw new Error(`Blockfrost API error: ${cbor.status} ${cbor.statusText} (scripts/${hash}/cbor)`);
  const body = (await cbor.json()) as { cbor?: string | null };
  if (!body.cbor) return undefined;
  return { type: meta.type, bytes: body.cbor };
}
