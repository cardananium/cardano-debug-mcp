// Resource-provider hooks of the chain layer (src/providers.ts seam): bundle.json, necessary.json,
// redeemer parts.json / links.txt, reference-script bytes by hash, chain/{net}/epoch_params and
// the chain section of server/info. Defaults of the base layer cover context / traces / script /
// error, which read the stored EvalRedeemerResult directly.

import type { AppContext } from "../context.js";
import type { ResourceProviders } from "../providers.js";
import { formatRedeemerRef } from "../vocab/redeemerRef.js";
import { encodeBundle } from "./bundle.js";
import { TTL } from "./cache.js";
import type { ChainService } from "./index.js";
import { buildLinks, partsConfigOf } from "./links.js";
import { rowNamespace } from "./providers.js";
import { capturedAtIso, chainStateOf } from "./state.js";

export function chainResourceProviders(service: ChainService, ctx: AppContext): ResourceProviders {
  return {
    txBundle(record) {
      if (!chainStateOf(record)?.context) return undefined;
      // Reading a resource must not write: bundle_export is what puts a bundle on disk.
      return encodeBundle(service.buildBundle(record, true));
    },

    txNecessary(record) {
      const state = chainStateOf(record);
      if (!state?.necessary) return undefined;
      return { necessary: state.necessary, missing_utxos: state.missingUtxos, resolved_utxos: state.context?.utxoSet.length ?? 0, context_status: state.status, origin: state.origin };
    },

    async redeemerArtifact(record, ref, part) {
      const canonical = formatRedeemerRef(ref);
      const ev = record.validation?.redeemers.get(canonical);
      if (!ev) return undefined;
      if (part === "parts.json") return { text: JSON.stringify(partsConfigOf(record, ev), null, 1), mimeType: "application/json" };
      if (part === "links.txt") {
        const links = await buildLinks(ctx, record, ev);
        const lines = [
          `de_uplc_url: ${links.de_uplc_url ?? "(unavailable)"}`,
          `cquisitor_url: ${links.cquisitor_url ?? "(unavailable)"}`,
          `decompiler_url: ${links.decompiler_url ?? "(unavailable)"}`,
          ...links.notes.map((n) => `note: ${n}`),
        ];
        return { text: lines.join("\n"), mimeType: "text/plain" };
      }
      return undefined;
    },

    scriptBytes(scriptHash) {
      const hash = scriptHash.toLowerCase();
      for (const record of ctx.txStore.list()) {
        const ref = chainStateOf(record)?.refScripts[hash];
        if (ref) return { hex: ref.inner, plutus_version: ref.plutus_version, source: `${record.txId} reference ${ref.utxo}${ref.verified ? "" : ref.hash_source === "derived" ? " (hash derived from bytes)" : " (UNVERIFIED: hash mismatch)"}` };
        // Scripts a validated redeemer resolved to (witness or reference) — the eval result carries the bytes.
        const state = chainStateOf(record);
        if (state && record.validation) {
          for (const [redeemerRef, info] of Object.entries(state.scriptHashes)) {
            const ev = record.validation.redeemers.get(redeemerRef);
            if (info.script_hash === hash && ev?.script_bytes) return { hex: ev.script_bytes, plutus_version: info.plutus_version, source: `${record.txId} ${redeemerRef}` };
          }
        }
      }
      return undefined;
    },

    async epochParams(network) {
      // The configured provider's row first, then the other's (both are epoch-params rows of the same network).
      const preferred = ctx.config.defaultProvider;
      for (const provider of [preferred, preferred === "koios" ? "blockfrost" : "koios"] as const) {
        const rows = await service.cache.getJson<unknown[]>(rowNamespace("epoch_params", network, provider), "latest.json", TTL.epochParams);
        if (rows) return Array.isArray(rows) ? rows[0] ?? rows : rows;
      }
      // Nothing fetched for this network (offline / bundle-only): answer from the protocol parameters
      // of the most recently used record of that network, saying where they come from.
      for (const record of ctx.txStore.list()) {
        const state = chainStateOf(record);
        if (record.network !== network || !state?.context) continue;
        return {
          source: `protocol parameters of ${record.txId} (${state.origin}; not a live epoch_params row)`,
          protocol_major: state.protocolMajor ?? null,
          slot: state.slot === undefined ? null : String(state.slot),
          captured_at: capturedAtIso(state),
          protocol_parameters: state.context.protocolParameters,
        };
      }
      return undefined;
    },

    serverInfo() {
      return {
        chain: {
          offline: service.offline,
          cache_dir: service.cache.root,
          memory_entries: service.memory.size,
          endpoint_overrides: Object.fromEntries(
            (["koios", "blockfrost"] as const).flatMap((p) =>
              (["mainnet", "preprod", "preview"] as const)
                .filter((n) => (p === "koios" ? service.endpoints.koios[n] !== undefined && !service.endpoints.koios[n].includes("koios.rest") : !service.endpoints.blockfrost[n].includes("blockfrost.io")))
                .map((n) => [`${p}_${n}`, true] as const),
            ),
          ),
          policy: "30 s per request, 3 retries with exponential backoff on 429/5xx/timeouts",
        },
      };
    },
  };
}
