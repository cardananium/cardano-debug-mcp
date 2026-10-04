import { describe, expect, it } from "vitest";

import { bytesKey, epochOfSlot, inclusionDefaults, InclusionClient, inclusionFromBlockfrostTx, inclusionFromKoiosRow, isIncludedBytes, parseOnChainInfo, withIncludedBytes } from "../../../src/chain/onChain.js";
import { carryChainState, emptyChainState, setChainState } from "../../../src/chain/state.js";
import { onChainView } from "../../../src/chain/validate.js";
import type { NecessaryInputData } from "../../../src/lib.js";
import type { OnChainInfo, TxRecord } from "../../../src/store/txStore.js";
import { fxInt, fxStr } from "../../helpers/fixtures.js";

// the artificial on-chain transaction of scenario S6 (its inclusion facts are in the fixture manifest)
const TX_HASH = fxStr("s06.txHash");
const TX_ID = fxStr("s06.txId");
const SLOT = fxStr("s06.slot");
const EPOCH = fxInt("s06.epoch");
const BLOCK_HEIGHT = fxInt("s06.blockHeight");
/** An epoch later than the inclusion one: what "the current epoch" answers. */
const CURRENT_EPOCH = EPOCH + 100;

/** A Koios tx_cbor row (the provider upper-cases the block hash in some answers; the reader lower-cases it). */
const TX_ROW = {
  tx_hash: TX_HASH,
  block_hash: fxStr("s06.blockHash").toUpperCase(),
  block_height: BLOCK_HEIGHT,
  epoch_no: EPOCH,
  absolute_slot: Number(SLOT),
  tx_timestamp: fxInt("s06.timestamp"),
  valid_contract: true,
  cbor: "84",
};

describe("inclusion facts", () => {
  it("epochOfSlot follows each network's Shelley epoch arithmetic", () => {
    expect(epochOfSlot("mainnet", Number(SLOT))).toBe(EPOCH);
    expect(epochOfSlot("mainnet", 198_500_000)).toBe(657);
    expect(epochOfSlot("mainnet", 4_492_800)).toBe(208);
    expect(epochOfSlot("mainnet", 4_492_799)).toBe(207);
    expect(epochOfSlot("preprod", 86_400)).toBe(4);
    expect(epochOfSlot("preview", 86_400 * 10 + 5)).toBe(10);
  });

  it("reads Koios tx_cbor rows and Blockfrost /txs answers; bundles are validated", () => {
    expect(inclusionFromKoiosRow(TX_ROW)).toEqual({ slot: SLOT, epoch: EPOCH, block_height: BLOCK_HEIGHT, is_valid: true, source: "koios tx_cbor row", block_hash: TX_ROW.block_hash.toLowerCase() });
    expect(inclusionFromKoiosRow({ tx_hash: "x", cbor: "84" })).toBeUndefined();
    expect(inclusionFromBlockfrostTx("mainnet", { slot: Number(SLOT), block_height: BLOCK_HEIGHT, block: "AB", valid_contract: false })).toMatchObject({ slot: SLOT, epoch: EPOCH, is_valid: false, source: "blockfrost /txs" });
    expect(parseOnChainInfo({ slot: SLOT, epoch: EPOCH, block_height: 1, is_valid: true, source: "koios tx_cbor row" })).toMatchObject({ slot: SLOT, epoch: EPOCH });
    expect(parseOnChainInfo({ slot: "nope", epoch: 1 })).toBeUndefined();
    expect(parseOnChainInfo(null)).toBeUndefined();
  });

  it("InclusionClient answers the tip, params and totals as of the inclusion epoch; falls back loudly", async () => {
    const calls: string[] = [];
    const rows: { tip?: unknown } = {};
    const inner = {
      rows,
      getEpochParams: async (epoch?: number) => {
        calls.push(`epoch_params ${epoch}`);
        return epoch === EPOCH ? [{ epoch_no: EPOCH }] : epoch === undefined ? [{ epoch_no: CURRENT_EPOCH }] : [];
      },
      getTotals: async (epoch?: number) => {
        calls.push(`totals ${epoch}`);
        return epoch === undefined ? [{ epoch_no: CURRENT_EPOCH, treasury: "2" }] : [];
      },
    } as never;
    const at = inclusionFromKoiosRow(TX_ROW)!;
    const client = new InclusionClient(inner, at);
    const [tip] = await client.getTip();
    expect(tip).toMatchObject({ abs_slot: Number(SLOT), epoch_no: EPOCH, block_height: BLOCK_HEIGHT });
    expect(rows.tip).toBe(tip);
    expect(await client.getEpochParams()).toEqual([{ epoch_no: EPOCH }]);
    expect(await client.getTotals()).toEqual([{ epoch_no: CURRENT_EPOCH, treasury: "2" }]); // no row for the inclusion epoch: current, and said so
    expect(calls).toEqual([`epoch_params ${EPOCH}`, `totals ${EPOCH}`, "totals undefined"]);
    expect(client.fallbacks.join("\n")).toMatch(new RegExp(`CURRENT treasury .* epoch ${EPOCH}`));
  });

  it("defaults_applied names what was rebuilt and what stayed current", () => {
    const necessary: NecessaryInputData = { utxos: [], accounts: ["stake1…"], pools: [], dReps: [], govActions: [], lastEnactedGovAction: [], committeeMembersCold: [], committeeMembersHot: [] };
    const lines = inclusionDefaults(inclusionFromKoiosRow(TX_ROW)!, "koios", necessary, 3, 7, false).join("\n");
    expect(lines).toMatch(new RegExp(`slot=${SLOT}: the transaction is on chain \\(epoch ${EPOCH}, block ${BLOCK_HEIGHT}\\)`));
    expect(lines).toMatch(new RegExp(`epoch ${EPOCH} parameters`));
    expect(lines).toMatch(/the 7 inputs \/ collateral \/ reference inputs were unspent .* 3 of them spent now/);
    expect(lines).toMatch(/reward accounts .*CURRENT state/);
    expect(lines).not.toMatch(/constitution/);
  });
});

// The ledger judged the exact bytes it included. The same body with other witnesses / redeemers /
// ex-units replays at the same point, but "accepted" (or is_valid=false) is not a fact about them.
describe("on_chain belongs to the included bytes", () => {
  const INCLUDED = "84a100818258200000000000000000000000000000000000000000000000000000000000000000000a0f5f6";
  const EDITED = "84a100818258200000000000000000000000000000000000000000000000000000000000000000000a1f5f6";
  const at = (isValid: boolean | null = true): OnChainInfo =>
    withIncludedBytes({ slot: SLOT, epoch: EPOCH, block_height: BLOCK_HEIGHT, is_valid: isValid, source: "koios tx_cbor row" }, INCLUDED);

  function record(txHex: string): TxRecord {
    const now = Date.now();
    return {
      txId: TX_ID,
      txHash: TX_HASH,
      network: "mainnet",
      txHex,
      sizeBytes: txHex.length / 2,
      source: "provider",
      createdAt: now,
      lastUsedAt: now,
      decoded: { transaction_hash: TX_HASH.slice(0, 8), transaction: { body: {}, witness_set: {}, is_valid: true, auxiliary_data: null } },
      hashes: { witness_native_script_hashes: [], witness_plutus_scripts: [], witness_datum_hashes: [], output_inline_scripts: [], output_inline_datum_hashes: [], output_datum_hashes: [] },
      redeemerTargets: [],
      scripts: [],
      extra: {},
    };
  }

  it("tx_bytes keys the included bytes; parse keeps it, rejects junk", () => {
    expect(at().tx_bytes).toBe(bytesKey(INCLUDED));
    expect(bytesKey(INCLUDED.toUpperCase())).toBe(bytesKey(INCLUDED));
    expect(isIncludedBytes(at(), INCLUDED)).toBe(true);
    expect(isIncludedBytes(at(), EDITED)).toBe(false);
    expect(isIncludedBytes({ ...at(), tx_bytes: undefined }, EDITED)).toBeUndefined();
    expect(parseOnChainInfo({ ...at() })?.tx_bytes).toBe(bytesKey(INCLUDED));
    expect(parseOnChainInfo({ ...at(), tx_bytes: "not-a-key" })?.tx_bytes).toBeUndefined();
  });

  it("the included bytes of an accepted tx: a failure is a replay artefact", () => {
    const view = onChainView(at(), INCLUDED, "phase1_failed");
    expect(view).toMatchObject({ slot: SLOT, is_valid: true, bytes_as_included: true });
    expect(String(view.note)).toMatch(/ACCEPTED/);
    expect(onChainView(at(), INCLUDED, "valid").note).toBeUndefined();
  });

  it("edited bytes of the same body: never called accepted, failures are real", () => {
    for (const verdict of ["phase1_failed", "phase2_failed", "valid", undefined] as const) {
      const view = onChainView(at(), EDITED, verdict);
      expect(view.bytes_as_included).toBe(false);
      expect(String(view.note)).not.toMatch(/ACCEPTED|replay artefact, not a defect/);
      expect(String(view.note)).toMatch(/NOT the bytes the ledger included/);
      expect(String(view.note)).toMatch(/real for these bytes/);
    }
    // is_valid=false belongs to the included bytes too
    expect(String(onChainView(at(false), EDITED, "phase2_failed").note)).toMatch(/NOT the bytes the ledger included/);
  });

  it("is_valid=false: the phase-2 failure is the chain's, to be debugged", () => {
    const note = String(onChainView(at(false), INCLUDED, "phase2_failed").note);
    expect(note).toMatch(/is_valid=false/);
    expect(note).toMatch(/one the chain saw: debug it/);
    expect(note).not.toMatch(/ACCEPTED/);
  });

  it("carryChainState keeps the replay point for other bytes of the same body, the view tells them apart", () => {
    const fetched = record(INCLUDED);
    fetched.onChain = at();
    setChainState(fetched, emptyChainState("mainnet", "koios"));
    const edited = record(EDITED);
    carryChainState(fetched, edited);
    expect(edited.onChain).toMatchObject({ slot: SLOT, epoch: EPOCH });
    expect(onChainView(edited.onChain!, edited.txHex, "phase1_failed").bytes_as_included).toBe(false);
    // and back: the included bytes carried from an edited record are recognised again
    const back = record(INCLUDED);
    carryChainState(edited, back);
    expect(onChainView(back.onChain!, back.txHex, "valid").bytes_as_included).toBe(true);
  });
});
