// Values (lovelace + multi-assets) with exact bigint arithmetic, and the unit / asset-name helpers.

import { compareBytes, hexToBytes } from "./bytes.js";

/** policy id (hex) -> asset name (hex, may be empty) -> quantity */
export type Assets = Record<string, Record<string, bigint>>;

export interface Value {
  coin: bigint;
  assets?: Assets;
}

export function cloneAssets(a: Assets | undefined): Assets {
  const out: Assets = {};
  for (const [p, names] of Object.entries(a ?? {})) out[p] = { ...names };
  return out;
}

/** Add `b` into a copy of `a` (quantities may go negative: use `isNonNegative` after a subtraction). */
export function addAssets(a: Assets | undefined, b: Assets | undefined, sign: 1n | -1n = 1n): Assets {
  const out = cloneAssets(a);
  for (const [p, names] of Object.entries(b ?? {})) {
    const into = (out[p] ??= {});
    for (const [n, q] of Object.entries(names)) into[n] = (into[n] ?? 0n) + sign * q;
  }
  return pruneAssets(out);
}

/** Drop zero quantities and empty policies. */
export function pruneAssets(a: Assets): Assets {
  const out: Assets = {};
  for (const [p, names] of Object.entries(a)) {
    const kept: Record<string, bigint> = {};
    for (const [n, q] of Object.entries(names)) if (q !== 0n) kept[n] = q;
    if (Object.keys(kept).length > 0) out[p] = kept;
  }
  return out;
}

export const addValue = (a: Value, b: Value): Value => ({ coin: a.coin + b.coin, assets: addAssets(a.assets, b.assets) });
export const subValue = (a: Value, b: Value): Value => ({ coin: a.coin - b.coin, assets: addAssets(a.assets, b.assets, -1n) });
export const sumValues = (values: Value[]): Value => values.reduce(addValue, { coin: 0n, assets: {} });

export function isNonNegative(v: Value): boolean {
  if (v.coin < 0n) return false;
  for (const names of Object.values(v.assets ?? {})) for (const q of Object.values(names)) if (q < 0n) return false;
  return true;
}

export function hasAssets(v: Value): boolean {
  return Object.keys(pruneAssets(v.assets ?? {})).length > 0;
}

/** Policies and asset names in ledger order (lexicographic bytes), zero quantities dropped. */
export function sortedAssets(a: Assets | undefined): Array<[string, Array<[string, bigint]>]> {
  const pruned = pruneAssets(a ?? {});
  return Object.keys(pruned)
    .sort((x, y) => compareBytes(hexToBytes(x), hexToBytes(y)))
    .map((p) => [p, Object.keys(pruned[p]!).sort((x, y) => compareBytes(hexToBytes(x), hexToBytes(y))).map((n) => [n, pruned[p]![n]!] as [string, bigint])]);
}

/** `policy` + `name` (both hex) as one unit string, the form Koios / the validator's `amount[].unit` use. */
export const unitOf = (policyHex: string, nameHex: string): string => `${policyHex}${nameHex}`;

/** `lovelace` + one `{unit, quantity}` per asset, quantities as decimal strings (the validator's `Asset[]`). */
export function toAmountList(v: Value): Array<{ unit: string; quantity: string }> {
  const out = [{ unit: "lovelace", quantity: v.coin.toString() }];
  for (const [p, names] of sortedAssets(v.assets)) for (const [n, q] of names) out.push({ unit: unitOf(p, n), quantity: q.toString() });
  return out;
}

/** Inverse of `toAmountList` (policy ids are 56 hex characters). */
export function fromAmountList(list: ReadonlyArray<{ unit: string; quantity: string }>): Value {
  let coin = 0n;
  const assets: Assets = {};
  for (const { unit, quantity } of list) {
    if (unit === "lovelace") coin += BigInt(quantity);
    else {
      const policy = unit.slice(0, 56);
      const name = unit.slice(56);
      (assets[policy] ??= {})[name] = (assets[policy]?.[name] ?? 0n) + BigInt(quantity);
    }
  }
  return { coin, assets: pruneAssets(assets) };
}
