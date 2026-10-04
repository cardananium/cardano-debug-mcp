// A transaction loaded by hash is already on chain: tx_load / tx_validate rebuild its context at the
// inclusion point (slot, epoch parameters, own inputs unspent) instead of the current tip, and say
// so (`on_chain`, defaults_applied). Offline and deterministic: the provider rows of the artificial
// transaction of scenario S6 (two V2 spends and a zero withdrawal from a script stake credential, all three
// scripts delivered by reference inputs; its slot, epoch and block come from the fixture manifest) are served
// from a fixture disk cache, and Koios points at a local stub that counts requests (none may reach it: the
// inclusion tip is synthetic and every row it needs is cached). At the tip this
// tx fails BadInputsUTxO / OutsideValidityIntervalUTxO / ScriptDataHashMismatch and a made-up
// NoEnoughBudget; at its inclusion point it is valid.
//
// The same server also proves the handle contract across a restart: the tx_id is rebuilt from the
// disk cache on first use, without a new tx_load.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withoutWitnessKey } from "../helpers/cborSplice.js";
import { fixturePath, fxInt, fxStr } from "../helpers/fixtures.js";
import { PROJECT_ROOT, StdioClient } from "../helpers/stdioClient.js";

const FIXTURE_CACHE = fixturePath(fxStr("s06.cacheDir"));
const TX_HASH = fxStr("s06.txHash");
const TX_ID = fxStr("s06.txId");
const SLOT = fxStr("s06.slot");
const EPOCH = fxInt("s06.epoch");
const BLOCK_HEIGHT = fxInt("s06.blockHeight");
const WITHDRAW = fxStr("s06.withdrawRef");

type Json = Record<string, any>;

describe("on-chain transaction replayed at its inclusion point (fixture cache, no network)", () => {
  let client: StdioClient;
  let cacheDir: string;
  let stub: Server;
  let env: NodeJS.ProcessEnv;
  const stubRequests: string[] = [];

  beforeAll(async () => {
    expect(existsSync(path.join(PROJECT_ROOT, "dist", "server.js")), "run `npm run build` before the e2e test").toBe(true);
    // Copy (fresh mtimes: row TTLs count from the file's mtime).
    cacheDir = mkdtempSync(path.join(os.tmpdir(), "cdm-onchain-"));
    cpSync(FIXTURE_CACHE, cacheDir, { recursive: true });
    stub = createServer((req, res) => {
      stubRequests.push(`${req.method} ${req.url}`);
      res.writeHead(404, { "content-type": "application/json" }).end("[]");
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    env = { CARDANO_DEBUG_CACHE_DIR: cacheDir, CARDANO_DEBUG_KOIOS_URL_MAINNET: `http://127.0.0.1:${(stub.address() as AddressInfo).port}/api/v1` };
    client = StdioClient.dist(process.execPath, env);
    await client.initialize();
  });

  afterAll(async () => {
    if (client) {
      const code = await client.close();
      expect(client.nonJsonStdout).toEqual([]);
      expect(code).toBe(0);
    }
    await new Promise<void>((resolve) => stub?.close(() => resolve()));
    expect(stubRequests, "every provider row must come from the fixture cache").toEqual([]);
  });

  it("tx_load(tx_hash) marks the tx on chain and builds the context at the inclusion slot with the inclusion epoch parameters", async () => {
    const load = await client.callTool<Json>("tx_load", { tx_hash: TX_HASH, network: "mainnet" }, 120_000);
    expect(load.isError, JSON.stringify(load.structuredContent)).toBeFalsy();
    const s = load.structuredContent!;
    expect(s.tx_id).toBe(TX_ID);
    expect(s.on_chain).toMatchObject({ slot: SLOT, epoch: EPOCH, block_height: BLOCK_HEIGHT, is_valid: true });
    expect(s.slot).toBe(SLOT);
    expect(s.protocol_major).toBe(fxInt("s06.protocolMajor"));
    expect(s.missing_utxos).toEqual([]);
    const defaults = (s.defaults_applied as string[]).join("\n");
    expect(defaults).toMatch(new RegExp(`slot=${SLOT}: the transaction is on chain`));
    expect(defaults).toMatch(new RegExp(`epoch ${EPOCH} parameters`));
    expect(defaults).toMatch(/isSpent=false: the \d+ inputs \/ collateral \/ reference inputs were unspent/);
    expect(defaults).toMatch(/reward accounts .*CURRENT state/);
  });

  it("tx_validate: valid at the inclusion point (no BadInputsUTxO, validity-interval, script-data-hash or budget artefacts)", async () => {
    const result = await client.callTool<Json>("tx_validate", { tx_id: TX_ID }, 120_000);
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
    const s = result.structuredContent!;
    const names = (s.phase1.errors as Json[]).map((e) => e.name);
    expect(names).not.toContain("BadInputsUTxO");
    expect(names).not.toContain("OutsideValidityIntervalUTxO");
    expect(names).not.toContain("ScriptDataHashMismatch");
    expect((s.phase2.errors as Json[]).map((e) => e.name)).not.toContain("NoEnoughBudget");
    expect(s.verdict).toBe("valid");
    expect(s.slot).toBe(SLOT);
    expect(s.on_chain).toMatchObject({ slot: SLOT, epoch: EPOCH, is_valid: true });
    const withdraw = (s.phase2.redeemers as Json[]).find((r) => r.ref === WITHDRAW);
    expect(withdraw).toMatchObject({ success: true });
    expect(withdraw!.ex_units.verdict).not.toBe("over_budget");
    // The inclusion-epoch parameters and totals are now cached forever under their epoch.
    expect(readdirSync(path.join(cacheDir, "epoch_params", "mainnet", "koios"))).toContain(`${EPOCH}.json`);
  });

  it("a restart keeps the tx_id usable: the record is rebuilt from the disk cache on first use", async () => {
    await client.close();
    client = StdioClient.dist(process.execPath, { ...env, CARDANO_DEBUG_OFFLINE: "1" });
    await client.initialize();
    const validate = await client.callTool<Json>("tx_validate", { tx_id: TX_ID }, 120_000);
    expect(validate.isError, JSON.stringify(validate.structuredContent)).toBeFalsy();
    expect(validate.structuredContent!.verdict).toBe("valid");
    expect(validate.structuredContent!.on_chain).toMatchObject({ slot: SLOT, epoch: EPOCH });
    const inspect = await client.callTool<Json>("tx_inspect", { tx_id: TX_ID, section: "body" });
    expect(inspect.isError, JSON.stringify(inspect.structuredContent)).toBeFalsy();
    const cbor = await client.readResource(`cardano-debug://tx/${TX_ID}/cbor`);
    expect(cbor.contents[0]!.text!.length).toBeGreaterThan(100);
    // A handle the cache has never seen is still an ordinary expired_handle.
    const unknown = await client.callTool<Json>("tx_validate", { tx_id: "tx_mainnet_000000000000" });
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toMatchObject({ code: "expired_handle", recreate_with: "tx_load" });
  });

  it("edited bytes of the same body keep the replay point but are never called accepted", async () => {
    const included = JSON.parse(readFileSync(path.join(FIXTURE_CACHE, "tx", "mainnet", "koios", `${TX_HASH}.json`), "utf8")).cbor as string;
    const stripped = withoutWitnessKey(included, 0);
    const edited = await client.callTool<Json>("tx_validate", { tx_cbor: stripped, network: "mainnet" }, 120_000);
    expect(edited.isError, JSON.stringify(edited.structuredContent)).toBeFalsy();
    const e = edited.structuredContent!;
    expect(e.verdict).toBe("phase1_failed");
    expect((e.phase1.errors as Json[]).map((x) => x.name)).toContain("MissingVKeyWitnesses");
    // same replay point (inclusion slot, epoch parameters), but the ledger never judged these bytes
    expect(e.slot).toBe(SLOT);
    expect(e.on_chain).toMatchObject({ slot: SLOT, epoch: EPOCH, bytes_as_included: false });
    expect(String(e.on_chain.note)).not.toMatch(/ACCEPTED/);
    expect(String(e.on_chain.note)).toMatch(/real for these bytes/);
    // the included bytes again: accepted, valid, no note
    const back = await client.callTool<Json>("tx_validate", { tx_cbor: included, network: "mainnet" }, 120_000);
    expect(back.structuredContent!.verdict).toBe("valid");
    expect(back.structuredContent!.on_chain).toMatchObject({ bytes_as_included: true });
    expect(back.structuredContent!.on_chain.note).toBeUndefined();
  });
});
