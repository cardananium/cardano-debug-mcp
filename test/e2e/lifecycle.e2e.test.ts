// Process lifecycle over stdio: what happens when the host closes stdin with calls still running, on SIGTERM
// during warm-up, and on an unhandled error; plus the Node 20 compatibility start-up.
//
// Runs against dist/server.js; CARDANO_DEBUG_E2E_MODE=dev runs `tsx src/server.ts` instead (no build needed).
import { describe, expect, it } from "vitest";

import { registryBytesHex } from "../fixtures/synthetic/lib/scripts.js";
import { hasNode20, McpTestClient, NODE20_BIN, type McpTestClientOptions } from "../mcpClient.js";

const mode: McpTestClientOptions["mode"] = process.env.CARDANO_DEBUG_E2E_MODE === "dev" ? "dev" : "dist";
const TINY_SCRIPT = registryBytesHex("tiny"); // the artificial always-succeeds V2 script (test/fixtures/synthetic/uplc/tiny.uplc)
/** The decompiler worker blocks this long before every decompile (test hook), so the call is surely in flight at EOF. */
const hooks = (delayMs: number) => ({ CARDANO_DEBUG_TEST_HOOKS: "1", CARDANO_DEBUG_TEST_DECOMPILE_DELAY_MS: String(delayMs), CARDANO_DEBUG_OFFLINE: "1" });

describe("stdin closed by the host", () => {
  it("calls already sent are still answered, then the server exits 0", async () => {
    const client = await McpTestClient.start({ mode, env: hooks(700) });
    const decoded = client.callTool("cbor_decode", { hex: "d8799f41aa02ff" });
    const decompiled = client.callTool("script_decompile", { script: TINY_SCRIPT, plutus_version: "V2" }, 120_000);
    client.child.stdin.end();
    const [a, b] = await Promise.all([decoded, decompiled]);
    expect(a.isError).toBeFalsy();
    expect(b.isError, JSON.stringify(b.structuredContent).slice(0, 300)).toBeFalsy();
    expect(String(b.structuredContent!.code).length).toBeGreaterThan(0);
    expect(await client.waitForExit(10_000)).toBe(0);
    expect(client.nonJsonStdout).toEqual([]);
  });

  it("a call that outlasts the drain window is abandoned: exit 0 after about 5 s, with a log line", async () => {
    const client = await McpTestClient.start({ mode, env: hooks(20_000) });
    const stuck = client.callTool("script_decompile", { script: TINY_SCRIPT, plutus_version: "V2" }, 60_000).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const closed = Date.now();
    client.child.stdin.end();
    expect(await client.waitForExit(20_000)).toBe(0);
    expect(Date.now() - closed).toBeLessThan(14_000);
    expect(client.stderrText()).toMatch(/stdin closed while 1 call\(s\) were still running/);
    expect(await stuck).toBeInstanceOf(Error);
  }, 50_000);
});

describe("shutdown and crashes", () => {
  it("SIGTERM right after the handshake (during warm-up) exits 0 without a 'failed to warm' error", async () => {
    const client = await McpTestClient.start({ mode, env: { CARDANO_DEBUG_OFFLINE: "1" } });
    client.child.kill("SIGTERM");
    expect(await client.waitForExit(10_000)).toBe(0);
    expect(client.stderrText()).not.toContain("failed to warm");
  });

  it.each([
    ["rejection", "unhandled rejection"],
    ["exception", "uncaught exception"],
  ])("an unhandled %s is logged and the process exits non-zero", async (crash, label) => {
    const client = await McpTestClient.start({ mode, skipInitialize: true, env: { CARDANO_DEBUG_TEST_HOOKS: "1", CARDANO_DEBUG_TEST_CRASH: crash, CARDANO_DEBUG_OFFLINE: "1" } });
    expect(await client.waitForExit(15_000)).toBe(1);
    expect(client.stderrText()).toContain(`[cardano-debug] ${label}:`);
    expect(client.stderrText()).toContain(`test hook: ${label}`);
    expect(client.nonJsonStdout).toEqual([]);
  });
});

describe.skipIf(!hasNode20())(`Node 20 compatibility (needs ${NODE20_BIN}; set CARDANO_DEBUG_E2E_NODE20 to another Node 20 binary)`, () => {
  it("the dist server starts, answers and exits 0 on Node 20", async () => {
    const client = await McpTestClient.start({ nodeBin: NODE20_BIN, env: { CARDANO_DEBUG_OFFLINE: "1" } });
    try {
      expect(client.initializeResult!.serverInfo.name).toBe("cardano-debug");
      const decoded = await client.callTool("cbor_decode", { hex: "d8799f41aa02ff" });
      expect(decoded.isError).toBeFalsy();
    } finally {
      expect(await client.close()).toBe(0);
    }
  });
});
