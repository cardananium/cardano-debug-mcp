// `show_it`: the ready ui_link call with the targets filled in and the text of every card left to the model.
import { describe, expect, it } from "vitest";

import type { EnginePosition } from "../../src/engine/protocol.js";
import type { TxRecord } from "../../src/store/txStore.js";
import { showItCbor, showItDebug, showItProfile, showItTx } from "../../src/ui/showIt.js";

type Card = { target: Record<string, unknown>; label: string; hint: string; severity: string };

/** The annotations array of the call in a show_it text. */
function cardsOf(text: string): Card[] {
  const match = /annotations=(\[.*\])\)/s.exec(text);
  expect(match, text.slice(0, 200)).not.toBeNull();
  return JSON.parse(match![1]!) as Card[];
}

const record = {
  txId: "tx_mainnet_000000000000",
  decoded: { transaction: { body: { voting_procedures: [{ voter: { StakingPool: "aa" }, votes: [{ action_id: {} }] }], fee: "1" }, witness_set: { redeemers: [{ tag: "Spend", index: 0 }] } } },
  redeemerTargets: [{ ref: "spend:0", purpose: "spend", index: 0, witness_index: 0, target: "input x#0", ex_units: { mem: "1", steps: "1" } }],
  validation: {
    at: 0,
    elapsedMs: 1,
    phases: "both",
    redeemers: new Map(),
    result: {
      errors: [
        { error: { DisallowedVoters: {} }, error_message: "voters not allowed", locations: ["transaction.body.voting_procedures.0.0"] },
        { error: { FeeTooSmallUTxO: {} }, error_message: "fee too small", locations: ["transaction.nowhere.0"] },
        { error: { ThirdError: {} }, error_message: "never reaches the call", locations: ["transaction.body.fee"] },
      ],
      phase2_errors: [{ error: { MachineError: {} }, error_message: "machine error", locations: ["transaction.witness_set.redeemers.0"] }],
      warnings: [{ warning: "SomeWarning", warning_message: "careful", locations: ["transaction.body.fee"] }],
      phase2_warnings: [],
    },
  },
} as unknown as TxRecord;

describe("show_it", () => {
  it("a failing transaction: a rule card and a place card for each of its first two errors, the text left as placeholders", () => {
    const text = showItTx(record);
    expect(text).toMatch(/^After you explain where it breaks, offer to show it; on yes call ui_link\(app='cquisitor', tx_id='tx_mainnet_000000000000', open=true, annotations=/);
    expect(text).toContain("WRITE the cards");
    const cards = cardsOf(text);
    expect(cards.map((c) => c.target)).toEqual([
      { kind: "diagnostic", index: 0 },
      // the validator's spelling is rewritten to the decoded transaction's path
      { kind: "tx_path", path: "transaction.body.voting_procedures.0.votes.0" },
      { kind: "diagnostic", index: 1 },
      // a location the transaction does not have gives no place card
    ]);
    for (const c of cards) {
      expect(c.label).toMatch(/^<.+>$/);
      expect(c.hint).toMatch(/^<.+>$/);
      expect(c.severity).toBe("error");
    }
  });

  it("a failing redeemer is a place by its Plutus row", () => {
    const only = { ...record, validation: { ...record.validation, result: { errors: [], phase2_errors: [{ error: { MachineError: {} }, error_message: "machine error", locations: ["transaction.witness_set.redeemers.0"] }], warnings: [], phase2_warnings: [] } } } as unknown as TxRecord;
    expect(cardsOf(showItTx(only)).map((c) => c.target)).toEqual([{ kind: "diagnostic", index: 0 }, { kind: "redeemer", tag: "Spend", index: 0 }]);
  });

  it("a stopped session: a card on the failing term (the position's last term between terms); none without one", () => {
    const at = (term_id: number | null, last_term_id: number | null) => ({ term_id, last_term_id, raw_term_id: 1, kind: "Apply", uplc_line: 3, machine_state: "Compute" }) as unknown as EnginePosition;
    const text = showItDebug("dbg_x", at(12, null));
    expect(text).toContain("ui_link(app='de_uplc', dbg_id='dbg_x', open=true, annotations=");
    expect(cardsOf(text).map((c) => c.target)).toEqual([{ kind: "term", term_id: 12 }]);
    expect(cardsOf(showItDebug("dbg_x", at(null, 7))).map((c) => c.target)).toEqual([{ kind: "term", term_id: 7 }]);
    expect(cardsOf(showItDebug("dbg_x", undefined))).toEqual([]);
    expect(text).toContain("for each value the check compared");
  });

  it("a profile: the three hottest terms as info cards; terms the report could not place are skipped", () => {
    const text = showItProfile("dbg_p", [null, 5, 6, 7, 8]);
    const cards = cardsOf(text);
    expect(cards.map((c) => c.target)).toEqual([{ kind: "term", term_id: 5 }, { kind: "term", term_id: 6 }, { kind: "term", term_id: 7 }]);
    expect(cards.every((c) => c.severity === "info")).toBe(true);
    expect(text).toContain("from=['profile']");
  });

  it("bad bytes: a span on the failing byte, else the path, else no card", () => {
    expect(cardsOf(showItCbor({ offset: 44, length: 2 })).map((c) => c.target)).toEqual([{ kind: "cbor_span", offset: 44, length: 2 }]);
    expect(cardsOf(showItCbor({ offset: 0 })).map((c) => c.target)).toEqual([{ kind: "cbor_span", offset: 0, length: 1 }]);
    expect(cardsOf(showItCbor({ offset: null, path: "$[0][7]" })).map((c) => c.target)).toEqual([{ kind: "cbor_path", path: "$[0][7]" }]);
    expect(cardsOf(showItCbor())).toEqual([]);
    expect(showItCbor()).toContain("cddl / preset and rule as here");
  });
});
