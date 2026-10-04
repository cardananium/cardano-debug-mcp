// Canonical script-purpose vocabulary and the bijections to every engine's own tags.
//
//   canonical (MCP wire)  : spend | mint | withdraw | publish | vote | propose
//   cquisitor-lib tag     : Spend | Mint | Reward | Cert | Vote | Propose      (EvalRedeemerResult.tag, phase-1 RedeemerTag)
//   cquisitor-lib decoded : Spend | Mint | Reward | Cert | Vote | VotingProposal (decode(…,'Transaction') witness_set.redeemers[].tag)
//   de-uplc engine kind   : Spend | Mint | Withdraw | Publish | Vote | Propose  (redeemer keys 'Spend:N')
//   dehosk purpose        : spend | mint | withdraw | certificate | vote | propose
//   UI label              : Spending | Minting | Rewarding | Certifying | Voting | Proposing

export const PURPOSES = ["spend", "mint", "withdraw", "publish", "vote", "propose"] as const;
export type Purpose = (typeof PURPOSES)[number];

export type LibRedeemerTag = "Spend" | "Mint" | "Cert" | "Reward" | "Vote" | "Propose";
/** The tag as the library's transaction decoder (CSL `RedeemerTagKind`) spells it. */
export type LibDecodedRedeemerTag = "Spend" | "Mint" | "Cert" | "Reward" | "Vote" | "VotingProposal";
export type EngineRedeemerKind = "Spend" | "Mint" | "Withdraw" | "Publish" | "Vote" | "Propose";
export type DehoskPurpose = "spend" | "mint" | "withdraw" | "certificate" | "vote" | "propose";
export type PurposeLabel = "Spending" | "Minting" | "Rewarding" | "Certifying" | "Voting" | "Proposing";

interface PurposeRow {
  purpose: Purpose;
  lib: LibRedeemerTag;
  libDecoded: LibDecodedRedeemerTag;
  engine: EngineRedeemerKind;
  dehosk: DehoskPurpose;
  label: PurposeLabel;
  aliases: readonly string[];
}

const ROWS: readonly PurposeRow[] = [
  { purpose: "spend", lib: "Spend", libDecoded: "Spend", engine: "Spend", dehosk: "spend", label: "Spending", aliases: ["spending", "spent", "input"] },
  { purpose: "mint", lib: "Mint", libDecoded: "Mint", engine: "Mint", dehosk: "mint", label: "Minting", aliases: ["minting", "burn", "policy"] },
  { purpose: "withdraw", lib: "Reward", libDecoded: "Reward", engine: "Withdraw", dehosk: "withdraw", label: "Rewarding", aliases: ["withdrawal", "withdrawing", "reward", "rewarding", "rewards", "stake"] },
  { purpose: "publish", lib: "Cert", libDecoded: "Cert", engine: "Publish", dehosk: "certificate", label: "Certifying", aliases: ["publishing", "cert", "certificate", "certifying", "certs"] },
  { purpose: "vote", lib: "Vote", libDecoded: "Vote", engine: "Vote", dehosk: "vote", label: "Voting", aliases: ["voting", "voter"] },
  { purpose: "propose", lib: "Propose", libDecoded: "VotingProposal", engine: "Propose", dehosk: "propose", label: "Proposing", aliases: ["proposing", "proposal", "propose", "governance"] },
];

const BY_PURPOSE = new Map<Purpose, PurposeRow>(ROWS.map((r) => [r.purpose, r]));
const BY_ALIAS = new Map<string, Purpose>();
for (const row of ROWS) {
  BY_ALIAS.set(row.purpose, row.purpose);
  BY_ALIAS.set(row.lib.toLowerCase(), row.purpose);
  BY_ALIAS.set(row.libDecoded.toLowerCase(), row.purpose);
  BY_ALIAS.set(row.engine.toLowerCase(), row.purpose);
  BY_ALIAS.set(row.dehosk, row.purpose);
  BY_ALIAS.set(row.label.toLowerCase(), row.purpose);
  for (const alias of row.aliases) BY_ALIAS.set(alias, row.purpose);
}

function row(purpose: Purpose): PurposeRow {
  const found = BY_PURPOSE.get(purpose);
  if (!found) throw new Error(`unknown purpose ${String(purpose)}`);
  return found;
}

export function isPurpose(value: unknown): value is Purpose {
  return typeof value === "string" && BY_PURPOSE.has(value as Purpose);
}

/** Case-insensitive parse of any known spelling (canonical, lib tag, engine kind, dehosk name, UI label, aliases). */
export function parsePurpose(input: string): Purpose | undefined {
  return BY_ALIAS.get(input.trim().toLowerCase());
}

export function libTagFromPurpose(purpose: Purpose): LibRedeemerTag {
  return row(purpose).lib;
}
/** Known cquisitor-lib tags, both spellings, for error messages. */
export const LIB_REDEEMER_TAGS: readonly string[] = [...new Set(ROWS.flatMap((r) => [r.lib, r.libDecoded]))];

/** Purpose of a cquisitor-lib tag in either spelling (`Propose` in results, `VotingProposal` in the decoded tx); throws on any other. */
export function purposeFromLibTag(tag: string): Purpose {
  const lowered = String(tag).toLowerCase();
  const found = ROWS.find((r) => r.lib.toLowerCase() === lowered || r.libDecoded.toLowerCase() === lowered);
  if (!found) throw new Error(`unknown cquisitor-lib redeemer tag ${JSON.stringify(tag)} (known: ${LIB_REDEEMER_TAGS.join(", ")})`);
  return found.purpose;
}

export function engineKindFromPurpose(purpose: Purpose): EngineRedeemerKind {
  return row(purpose).engine;
}
export function purposeFromEngineKind(kind: string): Purpose {
  const found = ROWS.find((r) => r.engine.toLowerCase() === kind.toLowerCase());
  if (!found) throw new Error(`unknown de-uplc redeemer kind ${JSON.stringify(kind)}`);
  return found.purpose;
}

export function dehoskPurposeFromPurpose(purpose: Purpose): DehoskPurpose {
  return row(purpose).dehosk;
}
export function purposeFromDehoskPurpose(name: string): Purpose {
  const lowered = name.toLowerCase();
  const found = ROWS.find((r) => r.dehosk === lowered) ?? (lowered === "publish" ? row("publish") : undefined);
  if (!found) throw new Error(`unknown dehosk purpose ${JSON.stringify(name)}`);
  return found.purpose;
}

/** Human label ('Spending', 'Rewarding', ...). */
export function purposeLabel(purpose: Purpose): PurposeLabel {
  return row(purpose).label;
}

/** Ledger `RedeemerTag` ordinal (spend 0, mint 1, cert 2, reward 3, vote 4, propose 5). */
export function purposeOrdinal(purpose: Purpose): number {
  switch (purpose) {
    case "spend":
      return 0;
    case "mint":
      return 1;
    case "publish":
      return 2;
    case "withdraw":
      return 3;
    case "vote":
      return 4;
    case "propose":
      return 5;
  }
}
