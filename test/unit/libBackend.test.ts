// The server's LibClient is the library's `LibBackend`: registered with `configure({ backend })`, it
// must honour the contract — the raw wasm answer (JSON text for get_necessary_data_list_js /
// validate_transaction_js / …, JS values for the rest) — so the library's own typed API and chain
// layer run through the lib worker. Exercised end-to-end: real lib worker -> configure -> typed API.
import { existsSync } from "node:fs";
import path from "node:path";

import { configure, getBackend, isBackendConfigured, necessaryData, possibleTypes, resetConfig, validateTransaction } from "@cardananium/cquisitor-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createLibClient, type LibClient } from "../../src/lib.js";
import { readTx } from "../helpers/fixtures.js";
import { PROJECT_ROOT } from "../mcpClient.js";

const LIB_WORKER = path.join(PROJECT_ROOT, "dist", "workers", "lib.worker.js");
const txHex = readTx("vote-tx.tx");
/** PlutusData `Constr 0 [2^63, 2^64]` (an unsigned 64-bit integer and a one-byte-longer bignum): both past 2^53. */
const BIG_INTS = "d8799f1b8000000000000000c249010000000000000000ff";

describe.skipIf(!existsSync(LIB_WORKER))("LibClient as the library's LibBackend", () => {
  let lib: LibClient;

  beforeAll(async () => {
    lib = createLibClient(loadConfig({}), { entry: new URL(`file://${LIB_WORKER}`) });
    await lib.warm();
    configure({ backend: lib });
  });

  afterAll(async () => {
    resetConfig();
    await lib.dispose();
  });

  it("callRaw hands over the library's JSON text for the *_js functions and typed decoding, JS values for the rest", async () => {
    expect(isBackendConfigured()).toBe(true);
    const backend = getBackend();
    expect(backend).toBe(lib);
    const necessary = await backend.callRaw<unknown>("get_necessary_data_list_js", [txHex, "mainnet"]);
    expect(typeof necessary).toBe("string");
    expect(JSON.parse(necessary as string)).toHaveProperty("utxos");
    const hashes = await backend.callRaw<unknown>("extract_hashes_from_transaction_js", [txHex]);
    expect(typeof hashes).toBe("string");
    const types = await backend.callRaw<string[]>("get_possible_types_for_input", [txHex]);
    expect(Array.isArray(types)).toBe(true);
    expect(types).toContain("Transaction");
    // typed decoding answers JSON text too: integers past 2^53 keep their digits
    // (the server's wire form is applied by LibApi.call, the library's typed API parses it itself).
    const decoded = await backend.callRaw<unknown>("decode_specific_type", [BIG_INTS, "PlutusData", {}]);
    expect(typeof decoded).toBe("string");
    expect(decoded as string).toContain('"int":9223372036854775808');
    expect(await lib.decodeType<{ plutus_data: { fields: Array<{ int: unknown }> } }>(BIG_INTS, "PlutusData")).toMatchObject({ plutus_data: { fields: [{ int: "9223372036854775808" }, { int: "18446744073709551616" }] } });
  });

  it("the library's typed API runs through the worker (necessaryData, possibleTypes)", async () => {
    const data = await necessaryData(txHex, "mainnet");
    expect(Array.isArray(data.utxos)).toBe(true);
    expect(data.utxos.length).toBeGreaterThan(0);
    expect(data.utxos[0]).toMatchObject({ txHash: expect.stringMatching(/^[0-9a-f]{64}$/), outputIndex: expect.any(Number) });
    expect(await possibleTypes("85e9")).toEqual([]); // malformed input: no candidates, no trap
    expect(lib.host.stats().totalRespawns).toBe(0);
  });

  it("the library's validateTransaction reaches the wasm (its own context error comes back, not a parse error)", async () => {
    const context = {
      utxoSet: [],
      protocolParameters: {},
      slot: 0,
      accountContexts: [],
      drepContexts: [],
      poolContexts: [],
      govActionContexts: [],
      lastEnactedGovAction: [],
      currentCommitteeMembers: [],
      potentialCommitteeMembers: [],
      treasuryValue: 0,
      networkType: "mainnet",
      constitution: null,
    };
    const error = await validateTransaction(txHex, context as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/not valid JSON/);
    // serde's complaint about the deliberately empty protocolParameters.
    expect((error as Error).message).toMatch(/missing field `minFeeCoefficientA`/);
  });

  it("the server's own helpers answer in wire form (decimal strings past 2^53, numbers below)", async () => {
    const data = await lib.necessaryData(txHex, "mainnet");
    expect(Array.isArray(data.utxos)).toBe(true);
    const decoded = await lib.decodeType<{ transaction: { body: { fee: unknown } } }>(txHex, "Transaction");
    expect(["number", "string"]).toContain(typeof decoded.transaction.body.fee);
    const big = await lib.decodeType<{ plutus_data: { fields: Array<{ int: unknown }> } }>(BIG_INTS, "PlutusData");
    expect(big.plutus_data.fields.map((f) => f.int)).toEqual(["9223372036854775808", "18446744073709551616"]);
  });
});
