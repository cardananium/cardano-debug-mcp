// tx_validate: full ledger validation (phase 1 rules + phase 2 script evaluation) through the lib
// worker under the watchdog; answers the verdict and compact summaries.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { chainStateOf } from "../chain/state.js";
import { validationSummary, verdictOf } from "../chain/validate.js";
import type { AppContext, ToolModule } from "../context.js";
import type { TxRecord } from "../store/txStore.js";
import { resolveTxInput } from "../tx/record.js";
import { chain, chainResources, progress, signalOf } from "./_chain.js";
import { failFromError, ok, showIt, ToolInputError, type ResourceLink, type ToolResult } from "./_shared.js";
import { providerFailure } from "./tx_load.js";
import { WorkerTimeoutError } from "../workers/rpc.js";
import { TOOL_TEXT } from "./descriptions.js";

const T = TOOL_TEXT.tx_validate;

const MAX_TIMEOUT_MS = 300_000;

const inputSchema = z.object({
  tx_id: z.string().optional().describe(T.params["tx_id"]),
  tx_cbor: z.string().optional().describe(T.params["tx_cbor"]),
  network: z.enum(["mainnet", "preprod", "preview"]).optional().describe(T.params["network"]),
  provider: z.enum(["koios", "blockfrost"]).optional().describe(T.params["provider"]),
  phases: z.enum(["both", "phase1"]).optional().describe(T.params["phases"]),
  refresh: z.boolean().optional().describe(T.params["refresh"]),
  timeout_ms: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional().describe(T.params["timeout_ms"]),
});

type Args = z.infer<typeof inputSchema>;

/** The answer lists the verdict's resource (and, for an incomplete context, the data the validation needs); the tx's own resources are tx_load's. */
function validateLinks(record: TxRecord): ResourceLink[] {
  const wanted = verdictOf(record) === "incomplete_context" ? /\/(validation|necessary)\.json$/ : /\/validation\.json$/;
  return chainResources(record).filter((link) => wanted.test(link.uri));
}

export async function txValidate(ctx: AppContext, args: Args, extra?: unknown): Promise<ToolResult> {
  const service = chain(ctx);
  const signal = signalOf(extra);
  try {
    const resolution = await resolveTxInput(ctx, args);
    if (!resolution.ok) return resolution.result;
    const { record } = resolution;
    const common = { tx_id: record.txId, tx_hash: record.txHash, network: record.network };
    const phases = args.phases ?? "both";

    // What this call loaded, the model has not seen in a tx_load answer: it gets the defaults list, not just its count.
    const defaults = !chainStateOf(record)?.context || args.refresh ? "full" : "count";
    const body = () => {
      const summary = validationSummary(record, { phases, defaults });
      const failed = summary.verdict === "phase1_failed" || summary.verdict === "phase2_failed" || summary.verdict === "both_failed";
      return { ...common, ...summary, phases, ...(failed ? { show_it: showIt("tx", record.txId) } : {}), ...(resolution.defaults_applied.length ? { load_defaults: resolution.defaults_applied } : {}) };
    };

    let state = chainStateOf(record);
    if (!state?.context || args.refresh) {
      await progress(extra, `resolving chain state on ${record.network}`, 1, 3);
      try {
        await service.loadContext(record, { provider: args.provider, refresh: args.refresh, signal });
      } catch (error) {
        const failure = providerFailure(error, common);
        if (failure) return failure;
        throw error;
      }
      state = chainStateOf(record);
    }
    if (!state?.context) throw new ToolInputError("No chain context could be attached to this transaction.", "tx_id");

    if (state.missingUtxos.length > 0) {
      return ok(body(), { links: validateLinks(record) });
    }

    let ran = false;
    if (!record.validation || args.refresh) {
      await progress(extra, `evaluating ${record.redeemerTargets.length} redeemer(s)`, 2, 3);
      try {
        ran = true;
        await service.validate(record, { timeoutMs: args.timeout_ms, signal, phases, refresh: args.refresh });
      } catch (error) {
        if (error instanceof WorkerTimeoutError) {
          return ok({ ...body(), timeout_ms: error.timeoutMs }, { links: validateLinks(record) });
        }
        throw error;
      }
    }
    await progress(extra, "done", 3, 3);
    return ok({ ...body(), cached: !ran }, { links: validateLinks(record) });
  } catch (error) {
    return providerFailure(error) ?? failFromError(error);
  }
}

export const txValidateTool: ToolModule = {
  name: "tx_validate",
  register(server: McpServer, ctx: AppContext) {
    chain(ctx);
    server.registerTool(
      "tx_validate",
      {
        title: T.title,
        description: T.description,
        inputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      },
      async (args, extra) => txValidate(ctx, args, extra),
    );
  },
};
