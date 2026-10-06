// Governance action ids the way people read them: CIP-129 bech32 (`gov_action1…`) with a Cardanoscan
// link, instead of the validator's Rust debug text (`GovernanceActionId { tx_hash: [57, 178, …], index: 0 }`).

import { encodeGovernanceActionId } from "@cardananium/cquisitor-lib/chain/cip129";
import { getGovActionLink } from "@cardananium/cquisitor-lib/util/cardanoscanLinks";

import type { Network } from "../config.js";

/** The validator's debug text of an action id (a `Debug` print of its `tx_hash` bytes and `index`). */
const RAW_ACTION_ID = /GovernanceActionId \{ tx_hash: \[([\d,\s]+)\], index: (\d+) \}/g;

function hexOf(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** CIP-129 id of an action (the 32-byte transaction id and the one-byte index); undefined when either does not fit. */
export function govActionIdBech32(txHash: string | ArrayLike<number>, index: number): string | undefined {
  try {
    return encodeGovernanceActionId({ txHash: typeof txHash === "string" ? txHash.toLowerCase() : hexOf(txHash), index });
  } catch {
    return undefined;
  }
}

/** The Cardanoscan page of an action id on `network`. */
export function govActionUrl(id: string, network: Network): string {
  return getGovActionLink(network, id);
}

/** `[gov_action1…](https://…)` (a link the model passes on as written), or the bare id when `network` is not given. */
export function govActionLabel(id: string, network?: Network): string {
  return network ? `[${id}](${govActionUrl(id, network)})` : id;
}

function bytesFromList(list: string): number[] | undefined {
  const bytes = list.split(",").map((part) => Number(part.trim()));
  return bytes.length === 32 && bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255) ? bytes : undefined;
}

/** `text` with every raw action id replaced by its CIP-129 form (a link when `network` is given); other text is kept as is. */
export function readableActionIds(text: string, network?: Network): string {
  return text.replace(RAW_ACTION_ID, (raw, list: string, index: string) => {
    const bytes = bytesFromList(list);
    const id = bytes ? govActionIdBech32(bytes, Number(index)) : undefined;
    return id ? govActionLabel(id, network) : raw;
  });
}

/**
 * Copy of a validator value with each `{ txHash: [32 bytes], index }` (its `GovernanceActionId`) replaced by
 * the CIP-129 id string and the raw ids in its texts rewritten. Run it before integers become strings.
 */
export function readableActionIdValues(value: unknown, network?: Network): unknown {
  if (typeof value === "string") return readableActionIds(value, network);
  if (Array.isArray(value)) return value.map((item) => readableActionIdValues(item, network));
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 2 && Array.isArray(record.txHash) && typeof record.index === "number") {
    const id = govActionIdBech32(record.txHash as number[], record.index);
    if (id) return govActionLabel(id, network);
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, readableActionIdValues(item, network)]));
}
