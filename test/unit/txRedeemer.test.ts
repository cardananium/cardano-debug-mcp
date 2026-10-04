import { describe, expect, it } from "vitest";

import { overDeclaredBudget } from "../../src/resources.js";
import { categorizeError, redeemerErrorMessage, subcategorizeError } from "../../src/tools/tx_redeemer.js";
import { fxBig } from "../helpers/fixtures.js";

const UNCONSTR = "Plutus machine error: failed to deserialise PlutusData using UnConstrData\nValue B #00";
const UNIDATA = "Plutus machine error: failed to deserialise PlutusData using UnIData\nValue Constr 0 []";
const EXPLICIT = "Plutus machine error: the validator crashed / exited prematurely";

describe("tx_redeemer error categories", () => {
  it("a MachineError is machine_error whatever its text says; wrong Data shapes get the data_shape subcategory", () => {
    for (const text of [UNCONSTR, UNIDATA]) {
      const category = categorizeError(text, [{ name: "MachineError" }]);
      expect(category).toBe("machine_error");
      expect(subcategorizeError(category, text)).toBe("data_shape");
      // without the phase-2 row the text alone must not read as undecodable script bytes either
      expect(categorizeError(text, [])).toBe("machine_error");
    }
    expect(categorizeError(EXPLICIT, [{ name: "MachineError" }])).toBe("machine_error");
    expect(subcategorizeError("machine_error", EXPLICIT)).toBeUndefined();
  });

  it("keeps the name-based categories and the decode regex for script bytes", () => {
    expect(categorizeError("x", [{ name: "NoEnoughBudget" }])).toBe("budget");
    expect(categorizeError("Failed to decode script: flat decode error", [{ name: "ScriptDecodeError" }])).toBe("decode");
    expect(categorizeError("Failed to decode script: bad", [])).toBe("decode");
    expect(categorizeError("x", [{ name: "MissingRequiredScript" }])).toBe("missing_script");
    expect(categorizeError(null, [])).toBe("none");
  });

  it("a ScriptContext the ledger refuses to build is context_build (the script never ran), not a machine error", () => {
    const cases: Array<[string, string]> = [
      ["UnreadableOutput", "Output 0 cannot be translated into a script context: its address cannot be read: invalid address length 10"],
      ["CertificateNotSupportedInPlutusV1V2", "Certificate 0 (VoteDeleg) is a Conway certificate, which a PlutusV2 script context cannot represent (CertificateNotSupported)"],
      ["FieldNotSupportedInPlutusV1V2", "proposal_procedures cannot be represented in a PlutusV2 script context"],
      ["ByronAddressNotAllowed", "Byron (legacy) addresses cannot be used in Plutus script transactions"],
      ["InlineDatumNotAllowedForPlutusV1", "inline datums cannot be used with PlutusV1"],
      ["BuildTxContextError", "could not build"],
    ];
    for (const [name, message] of cases) {
      expect(categorizeError(message, [{ name }]), name).toBe("context_build");
      expect(subcategorizeError("context_build", message), name).toBeUndefined();
    }
  });

  it("part='error' of a script that finished over its declared ex-units says the ledger rejects it", () => {
    // the ledger's own wording: it counted a few more steps than the redeemer declares (the declared steps of the S6 withdrawal)
    const declared = fxBig("s06.withdrawExUnits.steps");
    const over = redeemerErrorMessage({ error: null, success: true }, [{ name: "NoEnoughBudget", message: `expected ${declared} steps, got ${declared + 107_684n}` }], "over_budget");
    expect(over).toMatch(/completed, but the ledger rejects this redeemer: NoEnoughBudget/);
    expect(over).not.toMatch(/no error/);
    expect(redeemerErrorMessage({ error: null, success: true }, [], "over_budget")).toMatch(/more than its declared ex-units/);
    expect(redeemerErrorMessage({ error: null, success: true }, [], "slack")).toMatch(/^\(no error/);
    expect(redeemerErrorMessage({ error: UNCONSTR, success: false }, [], "unknown")).toBe(UNCONSTR);
  });

  it("error.txt knows an over-budget success from a clean one", () => {
    expect(overDeclaredBudget({ provided_ex_units: { mem: "10", steps: "100" }, calculated_ex_units: { mem: "10", steps: "101" } })).toBe(true);
    expect(overDeclaredBudget({ provided_ex_units: { mem: 10, steps: 100 }, calculated_ex_units: { mem: 9, steps: 100 } })).toBe(false);
    expect(overDeclaredBudget({})).toBe(false);
  });
});
