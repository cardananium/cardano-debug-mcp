// bundle_export: write the loaded transaction plus its chain state (and validation) as a
// self-contained offline bundle v1 that tx_load reproduces without network.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AppContext, ToolModule } from "../context.js";
import { expiredHandleError } from "../store/sessionRegistry.js";
import { lookupTxRecord } from "../tx/record.js";
import { chain, chainResources } from "./_chain.js";
import { fail, failFromError, ok, type ToolResult } from "./_shared.js";
import { TOOL_TEXT } from "./descriptions.js";

const T = TOOL_TEXT.bundle_export;

const INLINE_MAX_BYTES = 60 * 1024;

const inputSchema = z.object({
  tx_id: z.string().describe(T.params["tx_id"]),
  include_validation: z.boolean().optional().describe(T.params["include_validation"]),
  inline: z.boolean().optional().describe(T.params["inline"]),
});

type Args = z.infer<typeof inputSchema>;

export async function bundleExport(ctx: AppContext, args: Args): Promise<ToolResult> {
  const service = chain(ctx);
  try {
    const record = await lookupTxRecord(ctx, args.tx_id);
    if (!record) return expiredHandleError(args.tx_id.trim(), "tx_load");
    const written = await service.writeBundle(record, args.include_validation ?? true);
    const small = written.size_bytes < INLINE_MAX_BYTES;
    const resource = `cardano-debug://tx/${record.txId}/bundle.json`;
    const onDisk = written.path !== undefined;
    // The bundle.json resource reads the written file: without one, an inline copy is the only way out.
    if (!onDisk && !small) {
      return fail({
        code: "bundle_not_written",
        message: `The bundle (${written.size_bytes} bytes) could not be written to the disk cache (the server logged why on stderr; check that CARDANO_DEBUG_CACHE_DIR is writable) and is too large (>= ${INLINE_MAX_BYTES} bytes) to inline. Make the cache directory writable and call bundle_export again.`,
        tx_id: record.txId,
        size_bytes: written.size_bytes,
      });
    }
    const inline = ((args.inline ?? false) || !onDisk) && small;
    return ok(
      {
        tx_id: record.txId,
        tx_hash: record.txHash,
        network: record.network,
        size_bytes: written.size_bytes,
        path: written.path ?? null,
        captured_at: written.bundle.captured_at,
        slot: written.bundle.slot,
        protocol_major: written.bundle.protocol_major,
        includes_validation: written.bundle.validation_result !== undefined,
        utxos: written.bundle.validation_input_context.utxoSet.length,
        ...(onDisk ? {} : { warning: `The bundle could not be written to the disk cache (the server logged why on stderr; check that CARDANO_DEBUG_CACHE_DIR is writable): path is null and the bundle.json resource is not available, so the bundle is inlined here.` }),
        ...(inline ? { bundle: written.text } : args.inline ? { note: `bundle is ${written.size_bytes} bytes (>= ${INLINE_MAX_BYTES}); read it from the path or ${resource}` } : {}),
        replay: `tx_load(bundle=<${onDisk ? "path or JSON" : "the bundle JSON"}>) reproduces this transaction offline; the network is taken from the bundle.`,
      },
      { links: onDisk ? chainResources(record).filter((link) => link.uri === resource) : [] },
    );
  } catch (error) {
    return failFromError(error);
  }
}

export const bundleExportTool: ToolModule = {
  name: "bundle_export",
  register(server: McpServer, ctx: AppContext) {
    chain(ctx);
    server.registerTool(
      "bundle_export",
      {
        title: T.title,
        description: T.description,
        inputSchema,
        annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => bundleExport(ctx, args),
    );
  },
};
