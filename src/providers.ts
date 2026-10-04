// Provider seam between the base layer (tx_inspect, resources, server/info) and the layers that
// own the heavier artefacts (chain, engine, decompiler). The base layer asks the registry first
// and falls back to what the stores hold; a layer plugs in with one call:
//
//   providersOf(ctx).register({
//     txBundle: (record) => bundleCodec.encode(record),                    // chain layer
//     redeemerArtifact: (record, ref, part) => part === "parts.json" ? { text: JSON.stringify(buildParts(record, ref)), mimeType: "application/json" } : undefined,
//     scriptArtifact: (hash, part) => part === "pseudocode.txt" ? decompilerCache.get(hash) : undefined,
//     sessionArtifact: (session, part) => engine.readArtifact(session, part),
//     epochParams: (network) => chain.epochParams(network),
//     serverInfo: () => ({ engines: { de_uplc_engine: engineVersion } }),
//   });
//
// Providers are consulted in registration order; the first one that answers something other than
// `undefined` wins. Every hook is optional, sync or async.

import type { Network } from "./config.js";
import type { AppContext } from "./context.js";
import type { PlutusVersionOrNative, TxRecord } from "./store/txStore.js";
import type { SessionRecord } from "./store/sessionRegistry.js";
import type { ResolvedUtxo } from "./tx/dataView.js";
import type { RedeemerRef } from "./vocab/redeemerRef.js";

export type MaybePromise<T> = T | Promise<T>;

/** A text artefact served as one resource content block. */
export interface ArtifactText {
  text: string;
  /** Default: chosen from the part's extension (`.json` -> application/json, else text/plain). */
  mimeType?: string;
  /** A UPLC listing: served in line windows (400 lines when the URI names no limit) with compacted indentation. */
  listing?: boolean;
}

export const REDEEMER_ARTIFACT_PARTS = ["context.json", "context.cbor", "traces.txt", "script.hex", "error.txt", "parts.json", "links.txt"] as const;
export type RedeemerArtifactPart = (typeof REDEEMER_ARTIFACT_PARTS)[number];

export const SCRIPT_ARTIFACT_PARTS = ["pseudocode.txt", "uplc.txt", "uplc_canonical.txt", "bytes.hex"] as const;
export type ScriptArtifactPart = (typeof SCRIPT_ARTIFACT_PARTS)[number];

export const SESSION_ARTIFACT_PARTS = ["uplc.txt", "state.json", "env.json", "traces.txt", "profile.json"] as const;
export type SessionArtifactPart = (typeof SESSION_ARTIFACT_PARTS)[number];

export interface ScriptBytes {
  hex: string;
  plutus_version?: PlutusVersionOrNative;
  /** Where the bytes came from (`tx_… witness`, `reference <utxo>`, `provider`, `cache`). */
  source?: string;
}

/** Hooks a layer may implement. All optional. */
export interface ResourceProviders {
  /** Resolved UTxOs of a record (`<hash>#<ix>` -> row); default reads `record.validationContext.utxoSet`. */
  resolvedUtxos?(record: TxRecord): Map<string, ResolvedUtxo> | undefined;
  /** `tx/{tx_id}/validation.json` (JSON value, byte fields already removed); default derives from `record.validation`. */
  txValidation?(record: TxRecord): MaybePromise<unknown | undefined>;
  /** `tx/{tx_id}/bundle.json`: bundle v1 as a JSON value or text; default reads `record.bundlePath`. */
  txBundle?(record: TxRecord): MaybePromise<unknown | string | undefined>;
  /** `tx/{tx_id}/necessary.json`; default `record.necessary`. */
  txNecessary?(record: TxRecord): MaybePromise<unknown | undefined>;
  /** `tx/{tx_id}/redeemer/{ref}/<part>`; default derives context/traces/script/error from the stored EvalRedeemerResult. */
  redeemerArtifact?(record: TxRecord, ref: RedeemerRef, part: RedeemerArtifactPart): MaybePromise<ArtifactText | undefined>;
  /** Bytes of a script by hash (reference scripts fetched from the chain, disk cache, …); default searches the TxStore. */
  scriptBytes?(scriptHash: string): MaybePromise<ScriptBytes | undefined>;
  /** `script/{hash}/<part>`; default: bytes.hex from `scriptBytes`, uplc.txt via the lib; pseudocode.txt / uplc_canonical.txt need the decompiler layer. */
  scriptArtifact?(scriptHash: string, part: ScriptArtifactPart, options: { opts?: string }): MaybePromise<ArtifactText | undefined>;
  /** `session/{dbg_id}/<part>`; default: state.json from the registry record only. */
  sessionArtifact?(session: SessionRecord, part: SessionArtifactPart): MaybePromise<ArtifactText | undefined>;
  /** `chain/{net}/epoch_params` (JSON value). No default. */
  epochParams?(network: Network): MaybePromise<unknown | undefined>;
  /** Extra fields deep-merged into `cardano-debug://server/info` (e.g. `{engines: {...}}`). */
  serverInfo?(): Record<string, unknown> | undefined;
}

type ProviderFn<K extends keyof ResourceProviders> = NonNullable<ResourceProviders[K]>;
type ProviderArgs<K extends keyof ResourceProviders> = Parameters<ProviderFn<K>>;
type ProviderResult<K extends keyof ResourceProviders> = Awaited<ReturnType<ProviderFn<K>>>;

export class ProviderRegistry {
  private readonly providers: ResourceProviders[] = [];

  /** Add a provider; returns an unregister function. */
  register(providers: ResourceProviders): () => void {
    this.providers.push(providers);
    return () => {
      const at = this.providers.indexOf(providers);
      if (at >= 0) this.providers.splice(at, 1);
    };
  }

  get size(): number {
    return this.providers.length;
  }

  /** Names of the hooks at least one provider implements. */
  implemented(): Array<keyof ResourceProviders> {
    const names = new Set<keyof ResourceProviders>();
    for (const p of this.providers) for (const key of Object.keys(p) as Array<keyof ResourceProviders>) if (typeof p[key] === "function") names.add(key);
    return Array.from(names);
  }

  /** First non-undefined answer among the providers implementing `kind` (async). */
  async first<K extends keyof ResourceProviders>(kind: K, ...args: ProviderArgs<K>): Promise<ProviderResult<K> | undefined> {
    for (const provider of this.providers) {
      const fn = provider[kind] as ((...a: ProviderArgs<K>) => unknown) | undefined;
      if (typeof fn !== "function") continue;
      const value = await fn.apply(provider, args);
      if (value !== undefined) return value as ProviderResult<K>;
    }
    return undefined;
  }

  /** Synchronous variant for the sync hooks (`resolvedUtxos`, `serverInfo`); a Promise answer is ignored. */
  firstSync<K extends "resolvedUtxos" | "serverInfo">(kind: K, ...args: ProviderArgs<K>): ProviderResult<K> | undefined {
    for (const provider of this.providers) {
      const fn = provider[kind] as ((...a: ProviderArgs<K>) => unknown) | undefined;
      if (typeof fn !== "function") continue;
      const value = fn.apply(provider, args);
      if (value !== undefined && !(value instanceof Promise)) return value as ProviderResult<K>;
    }
    return undefined;
  }

  /** All `serverInfo()` answers, deep-merged in registration order (later wins on conflicts). */
  serverInfoExtras(): Record<string, unknown> {
    let merged: Record<string, unknown> = {};
    for (const provider of this.providers) {
      if (typeof provider.serverInfo !== "function") continue;
      try {
        const extra = provider.serverInfo();
        if (extra) merged = deepMerge(merged, extra);
      } catch (error) {
        console.error("[cardano-debug] serverInfo provider failed:", error instanceof Error ? error.message : error);
      }
    }
    return merged;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export function deepMerge(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

declare module "./context.js" {
  interface AppServices {
    /** Resource / enrichment providers (see src/providers.ts). Created lazily by `providersOf(ctx)`. */
    providers?: ProviderRegistry;
  }
}

/** The process-wide registry, created on first use and attached to `ctx.services.providers`. */
export function providersOf(ctx: AppContext): ProviderRegistry {
  if (!ctx.services.providers) ctx.services.providers = new ProviderRegistry();
  return ctx.services.providers;
}
