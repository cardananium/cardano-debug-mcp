// `<purpose>:<index>` redeemer references, with every alias the tools accept.
//
// Accepted forms (case-insensitive, whitespace tolerant):
//   canonical      spend:0  mint:1  withdraw:0  publish:2  vote:0  propose:0
//   engine keys    Spend:0  Withdraw:0  Publish:0
//   lib tags       Reward:0  Cert:0  Spend:0
//   UI labels      "Rewarding #0"  "Spending #1"  "Certifying 2"
//   dehosk         certificate:0
//   separators     ':'  '#'  ' '  '-'  '/'   (e.g. spend#0, spend 0, spend-0)
//   witness index  r:3  (position in the witness-set redeemer array; resolved against the decoded tx)

import { parsePurpose, type Purpose } from "./purpose.js";

export interface RedeemerRef {
  purpose: Purpose;
  index: number;
}

/** `r:<n>` — the n-th entry of the witness-set redeemer list, whatever its purpose. */
export interface WitnessIndexRef {
  witnessIndex: number;
}

export type ParsedRedeemerRef = RedeemerRef | WitnessIndexRef;

export class RedeemerRefError extends Error {
  readonly input: string;
  constructor(input: string, reason: string) {
    super(`Cannot read redeemer reference ${JSON.stringify(input)}: ${reason}. Use <purpose>:<index>, e.g. spend:0, mint:1, withdraw:0, publish:0, vote:0, propose:0 (aliases: Reward/Cert, Spending #0, r:<witness index>).`);
    this.name = "RedeemerRefError";
    this.input = input;
  }
}

export function isWitnessIndexRef(ref: ParsedRedeemerRef): ref is WitnessIndexRef {
  return typeof (ref as WitnessIndexRef).witnessIndex === "number";
}

const REF_PATTERN = /^([a-z]+)\s*(?::|#|-|\/|\s)\s*#?\s*(\d+)$/i;

/** Parse; throws `RedeemerRefError` on anything unreadable. */
export function parseRedeemerRef(input: string): ParsedRedeemerRef {
  if (typeof input !== "string") throw new RedeemerRefError(String(input), "not a string");
  const text = input.trim();
  if (text === "") throw new RedeemerRefError(input, "empty");
  const match = REF_PATTERN.exec(text);
  if (!match) throw new RedeemerRefError(input, "expected <purpose>:<index>");
  const head = match[1]!;
  const index = Number.parseInt(match[2]!, 10);
  if (!Number.isSafeInteger(index) || index < 0) throw new RedeemerRefError(input, "index must be a non-negative integer");
  if (head.toLowerCase() === "r" || head.toLowerCase() === "redeemer" || head.toLowerCase() === "witness") {
    return { witnessIndex: index };
  }
  const purpose = parsePurpose(head);
  if (!purpose) throw new RedeemerRefError(input, `unknown purpose ${JSON.stringify(head)}`);
  return { purpose, index };
}

/** Parse, or `undefined` instead of throwing. */
export function tryParseRedeemerRef(input: string): ParsedRedeemerRef | undefined {
  try {
    return parseRedeemerRef(input);
  } catch {
    return undefined;
  }
}

/** Canonical text: `spend:0`. */
export function formatRedeemerRef(ref: RedeemerRef): string {
  return `${ref.purpose}:${ref.index}`;
}

/** de-uplc engine key: `Spend:0`, `Withdraw:0`, `Publish:0`. */
export function engineKeyFromRef(ref: RedeemerRef): string {
  return `${engineKindOf(ref.purpose)}:${ref.index}`;
}

function engineKindOf(purpose: Purpose): string {
  switch (purpose) {
    case "spend":
      return "Spend";
    case "mint":
      return "Mint";
    case "withdraw":
      return "Withdraw";
    case "publish":
      return "Publish";
    case "vote":
      return "Vote";
    case "propose":
      return "Propose";
  }
}

/** Strict parse of an engine key (`Spend:0`); anything else throws. */
export function refFromEngineKey(key: string): RedeemerRef {
  const parsed = parseRedeemerRef(key);
  if (isWitnessIndexRef(parsed)) throw new RedeemerRefError(key, "engine keys never use the r: form");
  return parsed;
}

/** cquisitor-lib `{tag, index}` -> ref. */
export function refFromLibTag(tag: string, index: number): RedeemerRef {
  const purpose = parsePurpose(tag);
  if (!purpose) throw new RedeemerRefError(`${tag}:${index}`, `unknown cquisitor-lib tag ${JSON.stringify(tag)}`);
  return { purpose, index };
}

export function sameRef(a: RedeemerRef, b: RedeemerRef): boolean {
  return a.purpose === b.purpose && a.index === b.index;
}
