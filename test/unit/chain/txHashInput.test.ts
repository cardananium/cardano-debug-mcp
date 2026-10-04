// A transaction hash is not transaction bytes and not a handle: said so, with the call to make. Handles are
// matched however they were spelled.
import { describe, expect, it } from "vitest";

import { isTxHash, makeTxId, normalizeTxId, parseTxId } from "../../../src/store/txStore.js";
import { ToolInputError } from "../../../src/tools/_shared.js";
import { buildTxRecord, lookupTxRecord, normalizeTxHex, resolveTxInput } from "../../../src/tx/record.js";
import { makeContext, SAMPLE_HASH, SAMPLE_ID, SAMPLE_TX } from "./serviceHarness.js";

describe("a 64-hex hash given as tx_cbor", () => {
  it.each([SAMPLE_HASH, SAMPLE_HASH.toUpperCase(), `0x${SAMPLE_HASH}`, `  ${SAMPLE_HASH}\n`])("%j is refused with the call to make", (input) => {
    const error = (() => {
      try {
        normalizeTxHex(input);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as ToolInputError).argument).toBe("tx_cbor");
    expect((error as ToolInputError).message).toContain("transaction HASH");
    expect((error as ToolInputError).message).toContain(`tx_load(tx_hash="${SAMPLE_HASH}", network=mainnet|preprod|preview)`);
  });

  it("transaction bytes still pass", () => {
    expect(normalizeTxHex(SAMPLE_TX)).toBe(SAMPLE_TX.toLowerCase());
    expect(normalizeTxHex(`0x${SAMPLE_TX.toUpperCase()}`)).toBe(SAMPLE_TX.toLowerCase());
  });
});

describe("handles", () => {
  it("are lower-cased, and a full hash after the network is cut to the 12-hex handle", () => {
    expect(normalizeTxId(`  TX_Mainnet_${SAMPLE_HASH.slice(0, 12).toUpperCase()} `)).toBe(SAMPLE_ID);
    expect(normalizeTxId(`tx_mainnet_${SAMPLE_HASH}`)).toBe(SAMPLE_ID);
    expect(normalizeTxId("dbg_abc")).toBe("dbg_abc");
    expect(normalizeTxId(" nonsense ")).toBe("nonsense");
    expect(parseTxId(SAMPLE_ID.toUpperCase())).toEqual({ network: "mainnet", hashPrefix: SAMPLE_HASH.slice(0, 12) });
    expect(makeTxId("preprod", SAMPLE_HASH.toUpperCase())).toBe(`tx_preprod_${SAMPLE_HASH.slice(0, 12)}`);
    expect(isTxHash(SAMPLE_HASH)).toBe(true);
    expect(isTxHash(SAMPLE_ID)).toBe(false);
    expect(isTxHash(SAMPLE_HASH.slice(1))).toBe(false);
  });

  it("find a stored record whatever the case", async () => {
    const { ctx, lib } = makeContext();
    ctx.txStore.put(await buildTxRecord(lib, { tx: SAMPLE_TX, network: "mainnet" }));
    expect((await lookupTxRecord(ctx, SAMPLE_ID.toUpperCase()))?.txId).toBe(SAMPLE_ID);
    expect((await lookupTxRecord(ctx, ` ${SAMPLE_ID} `))?.txId).toBe(SAMPLE_ID);
    expect((await lookupTxRecord(ctx, `tx_mainnet_${SAMPLE_HASH}`))?.txId).toBe(SAMPLE_ID);
    expect(await lookupTxRecord(ctx, "tx_mainnet_000000000000")).toBeUndefined();
  });
});

describe("a hash given as tx_id", () => {
  it("says it is a hash and what to call; an unknown handle stays an expired_handle; tx_cbor alongside is used", async () => {
    const { ctx } = makeContext();
    const error = await resolveTxInput(ctx, { tx_id: SAMPLE_HASH }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as ToolInputError).argument).toBe("tx_id");
    expect((error as ToolInputError).message).toContain("transaction HASH");
    expect((error as ToolInputError).message).toContain("then pass the tx_id that call returns");

    const unknown = await resolveTxInput(ctx, { tx_id: "tx_mainnet_000000000000" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.result.structuredContent).toMatchObject({ code: "expired_handle" });

    const withBytes = await resolveTxInput(ctx, { tx_id: SAMPLE_HASH, tx_cbor: SAMPLE_TX, network: "mainnet" });
    expect(withBytes.ok && withBytes.record.txId).toBe(SAMPLE_ID);
  });
});
