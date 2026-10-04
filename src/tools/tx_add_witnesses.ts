// tx_add_witnesses: merge signatures into a loaded transaction (lib `add_witnesses_to_tx_with_report`)
// and re-validate against the SAME chain context (the body does not change, so nothing is refetched).
// The tx hash — and therefore the tx_id — stays the same; the stored record is replaced by the
// signed bytes, keeping the chain state.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { carryChainState, chainStateOf } from "../chain/state.js";
import { validationSummary, verdictOf } from "../chain/validate.js";
import type { AppContext, ToolModule } from "../context.js";
import { buildTxRecord, lookupTxRecord } from "../tx/record.js";
import { expiredHandleError } from "../store/sessionRegistry.js";
import { chain, chainResources, signalOf } from "./_chain.js";
import { fail, failFromError, missingUtxosView, ok, ToolInputError, type ToolResult } from "./_shared.js";
import { WorkerTimeoutError } from "../workers/rpc.js";
import { TOOL_TEXT } from "./descriptions.js";

const T = TOOL_TEXT.tx_add_witnesses;

const inputSchema = z.object({
  tx_id: z.string().describe(T.params["tx_id"]),
  witnesses: z.array(z.string()).min(1).max(64).describe(T.params["witnesses"]),
  revalidate: z.boolean().optional().describe(T.params["revalidate"]),
});

type Args = z.infer<typeof inputSchema>;

export async function txAddWitnesses(ctx: AppContext, args: Args, extra?: unknown): Promise<ToolResult> {
  const service = chain(ctx);
  const signal = signalOf(extra);
  try {
    const record = await lookupTxRecord(ctx, args.tx_id);
    if (!record) return expiredHandleError(args.tx_id.trim(), "tx_load");
    const witnesses = args.witnesses.map((w) => w.trim()).filter((w) => w !== "");
    if (witnesses.length === 0) throw new ToolInputError("witnesses is empty", "witnesses");

    const report = await ctx.lib.addWitnesses(record.txHex, witnesses, { signal });
    // The record may have been evicted from the store while the library worked; the one looked up above still carries the chain state.
    const before = ctx.txStore.get(record.txId) ?? record;
    const signed = await buildTxRecord(ctx.lib, { tx: report.tx_hex, network: record.network, source: record.source });
    if (signed.txHash !== record.txHash) {
      return fail({ code: "internal_error", message: `The signed transaction hashes to ${signed.txHash}, not ${record.txHash}; the body should not change when adding witnesses.` });
    }
    // Carry the chain state over (same body => same context); drop the stale validation.
    carryChainState(before, signed);
    const state = chainStateOf(signed);
    signed.createdAt = before.createdAt;
    signed.bundlePath = before.bundlePath;
    ctx.txStore.put(signed);

    const result: Record<string, unknown> = {
      tx_id: signed.txId,
      new_tx_id: signed.txId,
      tx_id_unchanged: true,
      tx_hash: signed.txHash,
      network: signed.network,
      size_bytes: signed.sizeBytes,
      added: report.added,
      duplicates: report.duplicates,
      invalid: report.invalid,
      added_key_hashes: report.added_key_hashes,
      vkey_witnesses_now: Array.isArray(signed.decoded.transaction.witness_set.vkeys) ? (signed.decoded.transaction.witness_set.vkeys as unknown[]).length : 0,
      note: "The body is unchanged, so the tx hash and tx_id are the same; the stored transaction now carries the added witnesses. Compare added_key_hashes with the MissingVKeyWitnesses hashes reported by tx_validate.",
    };
    if (args.revalidate ?? true) {
      if (!state?.context) {
        result.validation = { skipped: true, reason: "no chain context on this tx_id; tx_load it with a network first" };
      } else if (state.missingUtxos.length > 0) {
        result.validation = { verdict: "incomplete_context", ...missingUtxosView(state.missingUtxos) };
      } else {
        try {
          await service.validate(signed, { signal, refresh: true });
          const summary = validationSummary(signed);
          const phase1 = summary.phase1 as { errors: unknown[]; errors_total: number } | undefined;
          const phase2 = summary.phase2 as { redeemers?: Array<{ ref: string; success: boolean }>; redeemers_total?: number; failed_count?: number; redeemers_truncated?: true } | undefined;
          result.validation = {
            verdict: verdictOf(signed),
            phase1_errors: phase1?.errors ?? [],
            phase1_errors_total: phase1?.errors_total ?? 0,
            redeemers: phase2?.redeemers?.map((r) => ({ ref: r.ref, success: r.success })) ?? [],
            ...(phase2?.redeemers_total !== undefined ? { redeemers_total: phase2.redeemers_total, failed_count: phase2.failed_count } : {}),
            ...(phase2?.redeemers_truncated ? { redeemers_truncated: true } : {}),
          };
        } catch (error) {
          if (error instanceof WorkerTimeoutError) result.validation = { verdict: "timeout", timeout_ms: error.timeoutMs };
          else throw error;
        }
      }
    }
    // The signed bytes are the news: their cbor, and the verdict resource when one exists.
    return ok(result, { links: chainResources(signed).filter((link) => /\/(cbor|validation\.json)$/.test(link.uri)) });
  } catch (error) {
    return failFromError(error);
  }
}

export const txAddWitnessesTool: ToolModule = {
  name: "tx_add_witnesses",
  register(server: McpServer, ctx: AppContext) {
    chain(ctx);
    server.registerTool(
      "tx_add_witnesses",
      {
        title: T.title,
        description: T.description,
        inputSchema,
        annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args, extra) => txAddWitnesses(ctx, args, extra),
    );
  },
};
