// resolveScript against a minimal AppContext (real lib worker from dist for hashing, in-memory
// stores): session / tx witness / resolved reference input / validation script_bytes / chain hook.
import { existsSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import type { AppContext } from "../../src/context.js";
import { resolveScript } from "../../src/decompiler/resolve.js";
import { wrapCborBytes } from "../../src/decompiler/scriptBytes.js";
import { createLibClient, type LibClient } from "../../src/lib.js";
import { SessionRegistry } from "../../src/store/sessionRegistry.js";
import { TxStore, type TxRecord } from "../../src/store/txStore.js";
import { ToolInputError } from "../../src/tools/_shared.js";
import { buildTxRecord } from "../../src/tx/record.js";
import { fx, fxStr, readFixtureText, readTx } from "../helpers/fixtures.js";
import { PROJECT_ROOT } from "../helpers/stdioClient.js";

const LIB_WORKER = path.join(PROJECT_ROOT, "dist", "workers", "lib.worker.js");
// The spend script of the artificial S1 sample (`order_fixed`, single-CBOR-wrapped PlutusV2), its hash as V2 and as the V1 twin (same bytes, V1 tag).
const SAMPLE_HASH_V2 = fxStr("s01.spendScript.hash");
const SAMPLE_HASH_V1 = fxStr("s01.spendScript.hashV1");
// the first witness script of scenario s07 (two V3 minting scripts) is the policy of its Mint 0 redeemer
const POOL_MINT = fx<Array<{ hash: string }>>("s07.scripts")[0]!.hash;

describe.skipIf(!existsSync(LIB_WORKER))("resolveScript", () => {
  let lib: LibClient;
  let ctx: AppContext;
  let single: string;
  let pool: TxRecord;

  beforeAll(async () => {
    const config = loadConfig({});
    lib = createLibClient(config, { entry: new URL(`file://${LIB_WORKER}`) });
    const txStore = new TxStore();
    const sessions = new SessionRegistry({ sweepIntervalMs: 60_000 });
    ctx = { config, lib, txStore, sessions, startedAt: Date.now(), services: {}, onShutdown: () => undefined, shutdown: async () => undefined };
    single = readFixtureText(fxStr("s01.spendScriptFile")).trim();
    pool = await buildTxRecord(lib, { tx: readTx("pool-mint.tx"), network: "mainnet" });
    txStore.put(pool);
  });

  afterAll(async () => {
    ctx.sessions.closeAll("shutdown");
    await lib.dispose();
  });

  it("session: takes script, language and purpose from partsConfig; program-only sessions have no bytes", async () => {
    const { record } = ctx.sessions.create({ mode: "parts", language: "V2", purpose: "spend", partsConfig: { script: single, language: "v2" }, redeemer: "spend:0", txId: "tx_mainnet_000000000000" });
    const found = await resolveScript(ctx, { dbg_id: record.dbgId });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.script.scriptHash).toBe(SAMPLE_HASH_V2);
    expect(found.script.version).toBe("V2");
    expect(found.script.versionDecision).toBe("from_session");
    expect(found.script.versionCertain).toBe(true);
    expect(found.script.purpose).toBe("spend");
    expect(found.script.purposeDecision).toBe("from_session");
    expect(found.script.source).toEqual({ kind: "session", detail: `${record.dbgId} (parts session, tx_mainnet_000000000000 spend:0)` });
    // The caller's own hints win over the session's.
    const overridden = await resolveScript(ctx, { dbg_id: record.dbgId, plutus_version: "v1", purpose: "Rewarding" });
    expect(overridden.ok && overridden.script.version).toBe("V1");
    expect(overridden.ok && overridden.script.scriptHash).toBe(SAMPLE_HASH_V1);
    expect(overridden.ok && overridden.script.purpose).toBe("withdraw");

    const program = ctx.sessions.create({ mode: "program", language: "V3", partsConfig: { program: "(program 1.1.0 (con integer 1))", language: "v3" } });
    const none = await resolveScript(ctx, { dbg_id: program.record.dbgId });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.result.structuredContent).toMatchObject({ code: "no_script_bytes", mode: "program" });
    const expired = await resolveScript(ctx, { dbg_id: "dbg_missing" });
    expect(!expired.ok && expired.result.structuredContent).toMatchObject({ code: "expired_handle", recreate_with: "debug_open" });
  });

  it("tx: witness scripts (with purpose from the redeemers) and native scripts", async () => {
    const found = await resolveScript(ctx, { tx_id: pool.txId, script_hash: POOL_MINT.toUpperCase() });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.script.version).toBe("V3");
    expect(found.script.versionDecision).toBe("from_tx");
    expect(found.script.purpose).toBe("mint");
    expect(found.script.hashVerified).toBe(true);
    expect(found.script.wrapping).toBe("single");
    expect(found.script.source.detail).toBe(`${pool.txId} witness script`);
    await expect(resolveScript(ctx, { tx_id: pool.txId })).rejects.toThrow(ToolInputError);
    await expect(resolveScript(ctx, { tx_id: pool.txId, script_hash: "nope" })).rejects.toThrow(/script_hash must be 28 bytes/);
    await expect(resolveScript(ctx, { script: single, tx_id: pool.txId, script_hash: POOL_MINT })).rejects.toThrow(/exactly one script identity/);
  });

  it("tx: resolved reference inputs (utxoSet ScriptRef) and validation script_bytes", async () => {
    const record: TxRecord = { ...pool, txId: "tx_mainnet_aaaaaaaaaaaa", scripts: [], redeemerTargets: [], extra: {} };
    record.validationContext = {
      utxoSet: [
        { utxo: { input: { txHash: "ab".repeat(32), outputIndex: 1 }, output: { address: "addr1", amount: [], scriptRef: "8202" + wrapCborBytes(single), scriptHash: SAMPLE_HASH_V2 } }, isSpent: false },
      ],
    };
    ctx.txStore.put(record);
    const ref = await resolveScript(ctx, { tx_id: record.txId, script_hash: SAMPLE_HASH_V2 });
    expect(ref.ok).toBe(true);
    if (!ref.ok) return;
    expect(ref.script.version).toBe("V2");
    expect(ref.script.versionDecision).toBe("from_tx");
    expect(ref.script.hashVerified).toBe(true);
    expect(ref.script.source.detail).toBe(`${record.txId} reference input ${"ab".repeat(32)}#1`);
    expect(ref.script.purpose).toBeUndefined();

    const validated: TxRecord = { ...pool, txId: "tx_mainnet_bbbbbbbbbbbb", scripts: [], redeemerTargets: [], extra: {} };
    validated.validation = {
      result: { errors: [], warnings: [], phase2_errors: [], phase2_warnings: [] },
      redeemers: new Map([["spend:0", { tag: "Spend", index: 0, provided_ex_units: { mem: 1, steps: 1 }, logs: [], success: true, script_bytes: single, plutus_version: "V2" }]]),
      at: Date.now(),
      elapsedMs: 1,
      phases: "both",
    };
    ctx.txStore.put(validated);
    const fromValidation = await resolveScript(ctx, { tx_id: validated.txId, script_hash: SAMPLE_HASH_V2 });
    expect(fromValidation.ok).toBe(true);
    if (!fromValidation.ok) return;
    expect(fromValidation.script.purpose).toBe("spend");
    expect(fromValidation.script.purposeDecision).toBe("from_tx");
    expect(fromValidation.script.source.detail).toBe(`${validated.txId} validation of spend:0`);
    expect(validated.extra.scriptHashByBytes).toEqual({ [single]: SAMPLE_HASH_V2 });

    const missing = await resolveScript(ctx, { tx_id: validated.txId, script_hash: "00".repeat(28) });
    expect(!missing.ok && missing.result.structuredContent.code).toBe("script_not_found");
  });

  it("script_hash alone: loaded transactions first, then the chain hook, else script_unavailable", async () => {
    const loaded = await resolveScript(ctx, { script_hash: POOL_MINT });
    expect(loaded.ok && loaded.script.source.kind).toBe("tx");
    const wrongNet = await resolveScript(ctx, { script_hash: POOL_MINT, network: "preprod" });
    expect(!wrongNet.ok && wrongNet.result.structuredContent.code).toBe("script_unavailable");

    const calls: Array<[string, string]> = [];
    ctx.services.scriptSource = {
      async fetchScriptByHash(network, hash) {
        calls.push([network, hash]);
        return hash === SAMPLE_HASH_V1 ? { hex: wrapCborBytes(single), plutus_version: "plutusv1", source: "koios script_info" } : undefined;
      },
    };
    const needsNetwork = await resolveScript(ctx, { script_hash: SAMPLE_HASH_V1 });
    expect(!needsNetwork.ok && needsNetwork.result.structuredContent.code).toBe("invalid_argument");
    const chain = await resolveScript(ctx, { script_hash: SAMPLE_HASH_V1, network: "mainnet" });
    expect(chain.ok).toBe(true);
    if (!chain.ok) return;
    expect(chain.script.version).toBe("V1");
    expect(chain.script.versionDecision).toBe("from_chain");
    expect(chain.script.hashVerified).toBe(true);
    expect(chain.script.source).toEqual({ kind: "chain", detail: "koios script_info" });
    expect(chain.script.wrapping).toBe("double");
    const unknown = await resolveScript(ctx, { script_hash: "33".repeat(28), network: "mainnet" });
    expect(!unknown.ok && unknown.result.structuredContent.code).toBe("script_not_found");
    expect(calls).toEqual([["mainnet", SAMPLE_HASH_V1], ["mainnet", "33".repeat(28)]]);
    delete ctx.services.scriptSource;
  });

  it("inline: header V3 wins over a wrong label; garbage is invalid_argument", async () => {
    const v3 = pool.scripts[0]!.hex!;
    const found = await resolveScript(ctx, { script: v3, plutus_version: "V2" });
    expect(found.ok && found.script.version).toBe("V3");
    expect(found.ok && found.script.versionDecision).toBe("header_v3");
    expect(found.ok && found.script.scriptHash).toBe(pool.scripts[0]!.script_hash);
    await expect(resolveScript(ctx, { script: "deadbeef" })).rejects.toThrow(/do not decode as a Plutus script/);
    await expect(resolveScript(ctx, {})).rejects.toThrow(/Identify the script/);
    await expect(resolveScript(ctx, { script: single, plutus_version: "V4" })).rejects.toThrow(/plutus_version/);
    await expect(resolveScript(ctx, { script: single, purpose: "frobnicate" })).rejects.toThrow(/purpose/);
  });
});
