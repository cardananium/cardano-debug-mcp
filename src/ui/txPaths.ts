// The validator names a spot of the transaction with a location (`transaction.body.voting_procedures.0.0`);
// cquisitor looks a `tx_path` target up in the decoded transaction JSON. The two spell some places differently,
// so a generated target is translated to the JSON's own path and, when nothing is there, reduced to the closest
// enclosing place that exists.

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function child(at: unknown, segment: string): unknown {
  if (Array.isArray(at)) return /^\d+$/.test(segment) ? at[Number(segment)] : undefined;
  return isRecord(at) && Object.prototype.hasOwnProperty.call(at, segment) ? at[segment] : undefined;
}

/** Whether a dotted path names a value (not null) inside `root`, the way cquisitor looks it up. */
export function pathExists(root: unknown, path: string): boolean {
  let at = root;
  for (const segment of path.split(".")) {
    at = child(at, segment);
    if (at === undefined) return false;
  }
  return at !== null;
}

/** The validator's spelling rewritten to the decoded JSON's: a missing `body`, votes nested under their voter, plutus data under `elems`. */
export function jsonPathOf(location: string): string {
  let path = location.replace(/^transaction\.(inputs|reference_inputs)\./, "transaction.body.$1.");
  path = path.replace(/^(transaction\.body\.voting_procedures\.\d+)\.(\d+)(?=\.|$)/, "$1.votes.$2");
  path = path.replace(/^(transaction\.witness_set\.plutus_data)\.(\d+)(?=\.|$)/, "$1.elems.$2");
  return path;
}

/**
 * The path a `tx_path` annotation for `location` should carry: the JSON path when it exists in `decoded`, else its longest
 * existing prefix (a withdrawal sits in an object keyed by reward account, so `withdrawals.1` is the section), else undefined.
 * Without a decoded transaction the translated path is returned unchecked.
 */
export function resolveLocation(decoded: unknown, location: string): string | undefined {
  const path = jsonPathOf(location);
  if (decoded === undefined || decoded === null) return path;
  const segments = path.split(".");
  for (let length = segments.length; length > 1; length--) {
    const prefix = segments.slice(0, length).join(".");
    if (pathExists(decoded, prefix)) return prefix;
  }
  return undefined;
}
