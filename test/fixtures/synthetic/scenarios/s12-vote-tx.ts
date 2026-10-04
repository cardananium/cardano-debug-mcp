// S12: a minimal Conway transaction with one DRep vote and no witnesses, laid out byte for byte as the CBOR tests expect
// (they assert byte offsets): 197 bytes, body at 1 (193 bytes), tag 258 inputs at 3 (40 bytes), outputs key at 43,
// outputs array at 44 (70 bytes: one 57-byte base address + a u64 coin), fee `1a0002a515` at 115 (173333), key 19 at 120 with its
// 73-byte value at 121, empty witness set `a0` at 194, `f5` at 195, `f6` at 196. Every value is artificial.

import type { Scenario } from "../lib/toolkit.js";

export const scenario: Scenario = {
  name: "s12",
  description: "A minimal Conway transaction with a fixed byte layout (the CBOR tests pin offsets): one DRep vote, tag-258 inputs, no witnesses, 197 bytes.",
  build(tk) {
    const { address, keys, tx, writers } = tk;
    const { bytesToHex } = tk.bytes;
    const net = "mainnet" as const;

    const recipient = address.baseAddress(net, address.keyCred(keys.paymentKey("s12-recipient")), address.keyCred(keys.stakeKey("s12-recipient")));
    const drep = keys.drepKey("s12-voter");
    const inputTx = writers.fakeHash("s12 input transaction");
    const govActionTx = writers.fakeHash("s12 governance action transaction");

    const built = tx.assemble({
      inputs: [tx.txin(inputTx, 2)],
      // 31,415,926,479 lovelace: needs the 8-byte unsigned width (>= 2^32)
      outputs: [{ address: recipient, value: { coin: 31_415_926_479n } }],
      fee: 173_333n,
      votes: [{ voter: { kind: "drep", cred: address.keyCred(drep) }, actions: [{ id: { txHash: govActionTx, index: 0 }, vote: 0 }] }],
      encoding: { sets: { inputs: true } },
    });

    const span = (name: string) => built.spans[name]!;
    // where the library's decoder gives up on a truncated copy (the CBOR error tests assert the offset)
    const eof = (length: number) => {
      const res = tk.validator.cborToJson(built.hex.slice(0, length * 2)) as { ok: boolean; error?: { kind: string; offset: number; path: string } };
      if (res.ok || !res.error) throw new Error(`s12: the ${length}-byte truncation was expected to fail`);
      return { length, kind: res.error.kind, offset: res.error.offset, path: res.error.path };
    };
    return {
      files: { "vote-tx.tx": writers.txText(built) },
      manifest: {
        "s12.txHash": built.txHash,
        "s12.txId": writers.txHandle(net, built.txHash),
        "s12.size": built.size,
        "s12.network": net,
        "s12.fee": 173_333n,
        "s12.inputTxHash": inputTx,
        "s12.inputIndex": 2,
        "s12.outputAddress": recipient.bech32,
        "s12.outputAddressHex": recipient.hex,
        "s12.outputCoin": 31_415_926_479n,
        "s12.voterKeyHash": drep.keyHashHex,
        "s12.govActionTxId": govActionTx,
        "s12.govActionIndex": 0,
        "s12.bodyHex": bytesToHex(built.bytes.subarray(1, 1 + span("body").length)),
        "s12.truncated": { minus10: eof(built.size - 10), minus20: eof(built.size - 20) },
        // byte contract: every offset / length the CBOR tests use
        "s12.spans": {
          tx: { offset: 0, length: built.size },
          body: span("body"),
          inputsKey: span("body.key.0"),
          inputs: span("body.0"),
          outputsKey: span("body.key.1"),
          outputs: span("body.1"),
          feeKey: span("body.key.2"),
          fee: span("body.2"),
          votesKey: span("body.key.19"),
          votes: span("body.19"),
          witnessSet: span("witnesses"),
          isValid: span("is_valid"),
          aux: span("aux"),
        },
      },
    };
  },
};
