// The stdio transport's limits: a JSON-RPC message above the SDK's 10 MiB default is still read (the
// server raises the cap to CARDANO_DEBUG_MAX_MESSAGE_BYTES, default 128 MiB), and a message above the
// cap makes the process exit non-zero instead of lingering with a closed transport (the host then
// sees a dead server, not one that silently never answers).
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { McpTestClient } from "../mcpClient.js";

const env = (extra: NodeJS.ProcessEnv = {}) => ({ CARDANO_DEBUG_OFFLINE: "1", CARDANO_DEBUG_CACHE_DIR: mkdtempSync(path.join(os.tmpdir(), "cdm-e2e-transport-")), ...extra });

/** One tools/call line whose `bundle` argument is `size` characters of JSON text. */
function hugeBundleCall(id: number, size: number): string {
  const bundle = `{"pad":"${"x".repeat(size)}"}`;
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "tx_load", arguments: { bundle } } }) + "\n";
}

describe("stdio transport limits", () => {
  const clients: McpTestClient[] = [];
  afterAll(async () => {
    for (const client of clients) await client.close();
  });

  it("reads an 11 MB message (over the SDK's 10 MiB default), answers it and keeps serving", async () => {
    const client = await McpTestClient.start({ env: env() });
    clients.push(client);
    const answer = client.request<{ isError?: boolean; structuredContent?: { code?: string } }>("tools/call", { name: "tx_load", arguments: { bundle: `{"pad":"${"x".repeat(11 * 1024 * 1024)}"}` } }, 60_000);
    const result = await answer;
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("invalid_argument"); // not a bundle, but it was read and answered
    await expect(client.ping(10_000)).resolves.toEqual({});
    expect(client.stderrText()).not.toMatch(/ReadBuffer exceeded/);
  });

  it("a message over the cap closes the transport and the process exits non-zero instead of hanging", async () => {
    const client = await McpTestClient.start({ env: env({ CARDANO_DEBUG_MAX_MESSAGE_BYTES: String(1024 * 1024) }) });
    clients.push(client);
    await expect(client.ping(10_000)).resolves.toEqual({});
    client.writeRaw(hugeBundleCall(9_999, 2 * 1024 * 1024));
    const code = await client.waitForExit(15_000);
    expect(code, `server still running; stderr:\n${client.stderrText()}`).not.toBeUndefined();
    expect(code).not.toBe(0);
    expect(client.stderrText()).toMatch(/exiting so the host sees a dead server/);
  });
});
