// tx_load: load a transaction (bytes, hash or bundle) plus everything a validation needs, and
// answer with the compact summary. The record lives in the TxStore under the
// deterministic tx_id; the chain state and a bundle are written to the disk cache.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { ProviderAbortedError, ProviderHttpError, ProviderOfflineError, type ProviderName } from "../chain/http.js";
import { sameInclusion } from "../chain/onChain.js";
import { providerStatusOf } from "../chain/providers.js";
import { chainStateOf, emptyChainState, setChainState } from "../chain/state.js";
import type { AppContext, ToolModule } from "../context.js";
import { isNetwork, log, type Network } from "../config.js";
import { makeTxId, type OnChainInfo, type TxRecord } from "../store/txStore.js";
import { buildTxRecord, inferNetwork, normalizeTxHex } from "../tx/record.js";
import { chain, chainResources, loadSummary, progress, signalOf } from "./_chain.js";
import { fail, failFromError, ok, ToolInputError, type ToolResult } from "./_shared.js";
import { TOOL_TEXT } from "./descriptions.js";

const T = TOOL_TEXT.tx_load;

const inputSchema = z.object({
  tx_cbor: z.string().optional().describe(T.params["tx_cbor"]),
  tx_hash: z.string().optional().describe(T.params["tx_hash"]),
  bundle: z.string().optional().describe(T.params["bundle"]),
  network: z.enum(["mainnet", "preprod", "preview"]).optional().describe(T.params["network"]),
  provider: z.enum(["koios", "blockfrost"]).optional().describe(T.params["provider"]),
  refresh: z.boolean().optional().describe(T.params["refresh"]),
});

type Args = z.infer<typeof inputSchema>;

/** What went wrong with a provider call, whichever layer noticed. */
interface ProviderTrouble {
  provider: ProviderName;
  network?: Network;
  status?: number;
  attempts?: number;
  retryAfterS?: number;
  /** Whether the request carried credentials; undefined when unknown. */
  authenticated?: boolean;
  message: string;
}

function troubleOf(error: unknown): ProviderTrouble | undefined {
  if (error instanceof ProviderHttpError) {
    return {
      provider: error.provider,
      network: error.network,
      ...(error.status !== undefined ? { status: error.status } : {}),
      attempts: error.attempts,
      ...(error.retryAfterS !== undefined ? { retryAfterS: error.retryAfterS } : {}),
      ...(error.authenticated !== undefined ? { authenticated: error.authenticated } : {}),
      message: error.message,
    };
  }
  // A status error the core client threw that did not pass the caching client's translation.
  const plain = providerStatusOf(error);
  return plain ? { provider: plain.provider, status: plain.status, message: (error as Error).message } : undefined;
}

const otherProvider = (p: ProviderName): ProviderName => (p === "koios" ? "blockfrost" : "koios");

const koiosKeyHowto = "get a Koios API key (koios.rest) and set KOIOS_API_KEY in the server environment";
const blockfrostKeyHowto = (net: string): string => `get a Blockfrost project id (blockfrost.io), set BLOCKFROST_PROJECT_ID_${net} and use provider=blockfrost`;

/** What to do about a provider limit or a rejected key: the public Koios API is rate limited, a Koios API key or a Blockfrost project id lifts that. */
function keyAdvice(t: ProviderTrouble, cause: "auth" | "rate"): string {
  const net = (t.network ?? "<NETWORK>").toUpperCase();
  if (t.provider === "koios") {
    if (cause === "auth") return "KOIOS_API_KEY was rejected: replace it with a valid key, or unset it (the public Koios API also answers without a key, with lower limits), then restart the server";
    if (t.authenticated === false) return `the public Koios API is rate limited: ${koiosKeyHowto}, or ${blockfrostKeyHowto(net)} (restart the server after changing its environment)`;
    if (t.authenticated === true) return `the limit of the KOIOS_API_KEY's plan was reached: wait, move to a higher Koios plan, or ${blockfrostKeyHowto(net)}`;
    return `without a KOIOS_API_KEY the public Koios limits apply: ${koiosKeyHowto}, or ${blockfrostKeyHowto(net)}; with a key set, the limit of its plan was reached`;
  }
  return cause === "auth"
    ? `BLOCKFROST_PROJECT_ID_${net} was rejected: it must be the project id of this network (check the Blockfrost dashboard), then restart the server`
    : `the Blockfrost project's rate limit or daily quota was reached (see its plan in the Blockfrost dashboard): wait, upgrade the plan, or ${koiosKeyHowto} and use provider=koios`;
}

/** Map provider failures to recoverable tool errors: offline | cancelled | auth_failed | rate_limited | provider_error. */
export function providerFailure(error: unknown, extra: Record<string, unknown> = {}): ToolResult | undefined {
  if (error instanceof ProviderOfflineError) {
    return fail({ code: "offline", message: error.message, next: ["tx_load(bundle=<bundle_export file>) needs no provider", "start the server without CARDANO_DEBUG_OFFLINE to reach the providers"], ...extra });
  }
  if (error instanceof ProviderAbortedError) return fail({ code: "cancelled", message: error.message, ...extra });
  const t = troubleOf(error);
  if (!t) return undefined;
  const other = otherProvider(t.provider);
  const alternatives = [`provider=${other} (needs its credentials in the server environment)`, "tx_load(bundle=<file>) needs no provider"];
  let code: "auth_failed" | "rate_limited" | "provider_error";
  let advice: string;
  let next: string[];
  if (t.status === 401 || t.status === 403) {
    code = "auth_failed";
    advice = `The ${t.provider} credentials were refused (HTTP ${t.status}): ${keyAdvice(t, "auth")}.`;
    next = [keyAdvice(t, "auth"), ...alternatives];
  } else if (t.status === 429 || t.status === 402 || t.status === 418) {
    code = "rate_limited";
    const wait = t.retryAfterS !== undefined ? `wait ${t.retryAfterS} s, then repeat the call` : "wait a little, then repeat the call";
    advice = `${t.provider} is limiting this server's requests (HTTP ${t.status}): ${wait}; ${keyAdvice(t, "rate")}.`;
    next = [wait, keyAdvice(t, "rate"), ...alternatives];
  } else {
    code = "provider_error";
    advice =
      t.status !== undefined && t.status >= 400 && t.status < 500
        ? `${t.provider} refused the request (HTTP ${t.status}): check that network matches the transaction, or try refresh=true, the other provider, or load a bundle.`
        : "Retry later, try refresh=true or the other provider, or load a bundle.";
    next = ["repeat the call later (refresh=true bypasses the caches)", ...alternatives];
    if (t.provider === "koios" && t.authenticated !== true) {
      advice += " The public Koios API can be overloaded or throttled: a Koios API key or a Blockfrost project id gives this server its own limits.";
      next.push(`${koiosKeyHowto}, or ${blockfrostKeyHowto((t.network ?? "<NETWORK>").toUpperCase())}`);
    }
  }
  return fail({
    code,
    message: `${t.message}. ${advice}`,
    provider: t.provider,
    ...(t.network ? { network: t.network } : {}),
    ...(t.status !== undefined ? { status: t.status } : {}),
    ...(t.attempts !== undefined ? { attempts: t.attempts } : {}),
    ...(t.retryAfterS !== undefined ? { retry_after_s: t.retryAfterS } : {}),
    next,
    ...extra,
  });
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function txLoad(ctx: AppContext, args: Args, extra?: unknown): Promise<ToolResult> {
  const service = chain(ctx);
  const signal = signalOf(extra);
  let network: Network | undefined = args.network;
  try {
    const given = (["tx_cbor", "tx_hash", "bundle"] as const).filter((name) => args[name] !== undefined && args[name] !== "");
    if (given.length !== 1) {
      throw new ToolInputError(`Pass exactly one of tx_cbor, tx_hash or bundle (${given.length === 0 ? "got none" : `got ${given.join(", ")}`}).`);
    }
    const defaults: string[] = [];
    let record: TxRecord;

    if (args.bundle !== undefined) {
      await progress(extra, "importing bundle", 1, 3);
      const loaded = await service.loadFromBundleArgument(args.bundle, { network });
      record = loaded.record;
      await progress(extra, "bundle loaded", 3, 3);
      return ok({ ...loadSummary(record), defaults_applied: [...defaults, ...(chainStateOf(record)?.defaultsApplied ?? [])] }, { links: chainResources(record) });
    }

    let txHex: string;
    let source: TxRecord["source"] = "cbor";
    let inclusion: OnChainInfo | undefined;
    if (args.tx_hash !== undefined) {
      if (!network) throw new ToolInputError("network is required with tx_hash (mainnet | preprod | preview).", "network");
      await progress(extra, `fetching tx ${args.tx_hash.slice(0, 12)}… from ${args.provider ?? ctx.config.defaultProvider}`, 1, 4);
      const fetched = await service.fetchTxCbor(args.tx_hash, network, { provider: args.provider, refresh: args.refresh, signal });
      txHex = fetched.txHex;
      source = fetched.source;
      inclusion = fetched.inclusion;
      if (!inclusion) {
        defaults.push(
          `the tx is on chain (the provider returned it by hash) but its inclusion slot is unknown (${fetched.inclusion_error ?? "no inclusion data"}): it is validated at the current tip, so BadInputsUTxO, OutsideValidityIntervalUTxO, ScriptDataHashMismatch and ex-unit deltas are replay artefacts`,
        );
      }
    } else {
      txHex = normalizeTxHex(args.tx_cbor!);
    }

    await progress(extra, "decoding", 2, 4);
    const probe = await buildTxRecord(ctx.lib, { tx: txHex, network: network ?? "mainnet", source });
    if (!network) {
      const inferred = inferNetwork(probe.decoded);
      network = inferred?.network ?? "mainnet";
      defaults.push(
        `network=${network} (${inferred ? (inferred.certain ? "inferred from addresses" : "inferred from testnet addresses; pass network=preview if this is preview") : "no addresses to infer from; assumed"})`,
      );
      probe.network = network;
      probe.txId = makeTxId(network, probe.txHash);
    }
    if (!isNetwork(network)) throw new ToolInputError("network must be mainnet | preprod | preview", "network");

    // Reuse a live record with the same bytes unless a refresh was asked for.
    const existing = ctx.txStore.get(probe.txId);
    record = existing && existing.txHex === probe.txHex && !args.refresh ? existing : probe;
    if (record !== existing) ctx.txStore.put(record);
    if (args.refresh) {
      record.validation = undefined;
      delete record.extra.chain;
    }
    if (inclusion && !sameInclusion(record.onChain, inclusion)) {
      // Now known to be on chain: a context / verdict built at the tip does not apply any more.
      record.onChain = inclusion;
      record.validation = undefined;
      delete record.extra.chain;
    } else if (inclusion && record.onChain && record.onChain.tx_bytes !== inclusion.tx_bytes) {
      // The record holds the fetched bytes (a record with other bytes was replaced above): these are the included ones.
      record.onChain = { ...record.onChain, tx_bytes: inclusion.tx_bytes };
    }

    const state = chainStateOf(record);
    if (args.provider && state?.context && !args.refresh && state.provider !== args.provider) {
      defaults.push(
        `provider=${args.provider} ignored: the chain state already loaded for ${record.txId} (${state.status}, ${state.origin}) was not fetched from it; pass refresh=true to fetch it from ${args.provider}`,
      );
    }
    if (!state?.context || args.refresh) {
      await progress(extra, `resolving chain state on ${network}`, 3, 4);
      try {
        await service.loadContext(record, { provider: args.provider, refresh: args.refresh, signal });
      } catch (error) {
        const failure = providerFailure(error);
        // Provider misconfiguration (e.g. blockfrost without a project id) is the caller's problem: fail loudly.
        if (!failure && !(error instanceof ToolInputError)) throw error;
        if (error instanceof ToolInputError && error.argument === "provider") throw error;
        // Network trouble: keep the record usable from the bytes alone; tx_validate will report incomplete_context.
        const empty = emptyChainState(network, "bytes only (chain state unavailable)");
        empty.providerWarnings.push(`chain state not loaded: ${messageOf(error)}`);
        setChainState(record, empty);
        log.warn(`tx_load ${record.txId}: chain state unavailable: ${messageOf(error)}`);
        const next = failure?.structuredContent.next ?? ["repeat tx_load later (refresh=true), or tx_load(bundle=<file>) to give the chain state yourself"];
        return ok(
          {
            ...loadSummary(record),
            defaults_applied: defaults,
            warning: (failure?.structuredContent.message as string | undefined) ?? messageOf(error),
            ...(failure ? { warning_code: failure.structuredContent.code } : {}),
            next,
          },
          { links: chainResources(record) },
        );
      }
    }
    await progress(extra, "done", 4, 4);
    ctx.txStore.touch(record.txId);
    return ok({ ...loadSummary(record), defaults_applied: [...defaults, ...(chainStateOf(record)?.defaultsApplied ?? [])] }, { links: chainResources(record) });
  } catch (error) {
    // A hash that could not be fetched has no tx_id: name it, so the call can be repeated as is.
    const known = args.tx_hash !== undefined && network ? { tx_hash: args.tx_hash.trim().toLowerCase(), network } : {};
    return providerFailure(error, known) ?? failFromError(error);
  }
}

export const txLoadTool: ToolModule = {
  name: "tx_load",
  register(server: McpServer, ctx: AppContext) {
    chain(ctx);
    server.registerTool(
      "tx_load",
      {
        title: T.title,
        description: T.description,
        inputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      },
      async (args, extra) => txLoad(ctx, args, extra),
    );
  },
};
