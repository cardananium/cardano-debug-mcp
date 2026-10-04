import { describe, expect, it } from "vitest";

import {
  dehoskPurposeFromPurpose,
  engineKeyFromRef,
  engineKindFromPurpose,
  formatRedeemerRef,
  isWitnessIndexRef,
  LIB_REDEEMER_TAGS,
  libTagFromPurpose,
  parsePurpose,
  parseRedeemerRef,
  purposeFromDehoskPurpose,
  purposeFromEngineKind,
  purposeFromLibTag,
  purposeLabel,
  PURPOSES,
  RedeemerRefError,
  refFromEngineKey,
  refFromLibTag,
  tryParseRedeemerRef,
} from "../../src/vocab/index.js";

describe("purpose bijections", () => {
  it("round-trips lib tags", () => {
    for (const p of PURPOSES) expect(purposeFromLibTag(libTagFromPurpose(p))).toBe(p);
    expect(libTagFromPurpose("withdraw")).toBe("Reward");
    expect(libTagFromPurpose("publish")).toBe("Cert");
    expect(purposeFromLibTag("Reward")).toBe("withdraw");
    expect(purposeFromLibTag("Cert")).toBe("publish");
  });
  it("round-trips engine kinds", () => {
    for (const p of PURPOSES) expect(purposeFromEngineKind(engineKindFromPurpose(p))).toBe(p);
    expect(engineKindFromPurpose("withdraw")).toBe("Withdraw");
    expect(engineKindFromPurpose("publish")).toBe("Publish");
  });
  it("round-trips dehosk purposes", () => {
    for (const p of PURPOSES) expect(purposeFromDehoskPurpose(dehoskPurposeFromPurpose(p))).toBe(p);
    expect(dehoskPurposeFromPurpose("publish")).toBe("certificate");
    expect(purposeFromDehoskPurpose("Publish")).toBe("publish");
  });
  it("reads both library spellings of the propose tag: Propose (results) and VotingProposal (decoded tx)", () => {
    expect(purposeFromLibTag("Propose")).toBe("propose");
    expect(purposeFromLibTag("VotingProposal")).toBe("propose");
    expect(purposeFromLibTag("votingproposal")).toBe("propose");
    expect(parsePurpose("VotingProposal")).toBe("propose");
    expect(refFromLibTag("VotingProposal", 0)).toEqual({ purpose: "propose", index: 0 });
    expect(parseRedeemerRef("VotingProposal:0")).toEqual({ purpose: "propose", index: 0 });
    // an unknown tag is an error naming the known ones, never a guess
    expect(() => purposeFromLibTag("Frobnicate")).toThrow(/unknown cquisitor-lib redeemer tag "Frobnicate" \(known: Spend, Mint, Reward, Cert, Vote, Propose, VotingProposal\)/);
    expect(LIB_REDEEMER_TAGS).toEqual(["Spend", "Mint", "Reward", "Cert", "Vote", "Propose", "VotingProposal"]);
  });
  it("labels", () => {
    expect(purposeLabel("withdraw")).toBe("Rewarding");
    expect(purposeLabel("publish")).toBe("Certifying");
  });
  it("parses aliases case-insensitively", () => {
    expect(parsePurpose("SPEND")).toBe("spend");
    expect(parsePurpose("Reward")).toBe("withdraw");
    expect(parsePurpose("rewarding")).toBe("withdraw");
    expect(parsePurpose("Cert")).toBe("publish");
    expect(parsePurpose("certificate")).toBe("publish");
    expect(parsePurpose("Certifying")).toBe("publish");
    expect(parsePurpose("Minting")).toBe("mint");
    expect(parsePurpose("nonsense")).toBeUndefined();
  });
});

describe("parseRedeemerRef", () => {
  it("accepts the canonical form", () => {
    expect(parseRedeemerRef("spend:0")).toEqual({ purpose: "spend", index: 0 });
    expect(parseRedeemerRef("propose:12")).toEqual({ purpose: "propose", index: 12 });
  });
  it("accepts engine keys", () => {
    expect(parseRedeemerRef("Spend:0")).toEqual({ purpose: "spend", index: 0 });
    expect(parseRedeemerRef("Withdraw:0")).toEqual({ purpose: "withdraw", index: 0 });
    expect(parseRedeemerRef("Publish:3")).toEqual({ purpose: "publish", index: 3 });
  });
  it("accepts lib tags", () => {
    expect(parseRedeemerRef("Reward:1")).toEqual({ purpose: "withdraw", index: 1 });
    expect(parseRedeemerRef("Cert:0")).toEqual({ purpose: "publish", index: 0 });
  });
  it("accepts UI labels and loose separators", () => {
    expect(parseRedeemerRef("Rewarding #0")).toEqual({ purpose: "withdraw", index: 0 });
    expect(parseRedeemerRef("Spending #7")).toEqual({ purpose: "spend", index: 7 });
    expect(parseRedeemerRef("mint#2")).toEqual({ purpose: "mint", index: 2 });
    expect(parseRedeemerRef("  vote 4 ")).toEqual({ purpose: "vote", index: 4 });
    expect(parseRedeemerRef("certificate-1")).toEqual({ purpose: "publish", index: 1 });
  });
  it("accepts the witness-index form", () => {
    const ref = parseRedeemerRef("r:3");
    expect(isWitnessIndexRef(ref)).toBe(true);
    expect(ref).toEqual({ witnessIndex: 3 });
  });
  it("rejects garbage", () => {
    expect(() => parseRedeemerRef("")).toThrow(RedeemerRefError);
    expect(() => parseRedeemerRef("spend")).toThrow(RedeemerRefError);
    expect(() => parseRedeemerRef("foo:1")).toThrow(RedeemerRefError);
    expect(() => parseRedeemerRef("spend:-1")).toThrow(RedeemerRefError);
    expect(tryParseRedeemerRef("nope")).toBeUndefined();
  });
  it("formats and converts", () => {
    expect(formatRedeemerRef({ purpose: "withdraw", index: 2 })).toBe("withdraw:2");
    expect(engineKeyFromRef({ purpose: "withdraw", index: 2 })).toBe("Withdraw:2");
    expect(engineKeyFromRef({ purpose: "publish", index: 0 })).toBe("Publish:0");
    expect(refFromEngineKey("Publish:0")).toEqual({ purpose: "publish", index: 0 });
    expect(() => refFromEngineKey("r:0")).toThrow(RedeemerRefError);
    expect(refFromLibTag("Reward", 1)).toEqual({ purpose: "withdraw", index: 1 });
  });
});
