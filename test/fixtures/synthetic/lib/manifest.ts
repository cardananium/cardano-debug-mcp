// The manifest: every id, hash, size and number a test needs from a generated fixture, in one JSON file
// (test/fixtures/manifest.json). Keys are `<scenario>.<thing>` (`s12.txHash`, `s12.spans.body.offset`); tests read them through
// test/helpers/fixtures.ts and never hard-code a value that came from a fixture.
//
// Values are JSON: numbers, strings, booleans, null, arrays, objects. bigint is recorded as a decimal string and bytes as hex.

export type ManifestValue = string | number | boolean | null | ManifestValue[] | { [key: string]: ManifestValue };

export type ManifestInput = Record<string, unknown>;

/** Convert a scenario value to its manifest form (bigint -> decimal string, bytes -> hex, undefined dropped). */
export function toManifestValue(value: unknown, path = "value"): ManifestValue {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new Error(`manifest ${path}: not a finite number`);
      return value;
    case "bigint":
      return value.toString();
    case "object": {
      if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
      if (Array.isArray(value)) return value.map((v, i) => toManifestValue(v, `${path}[${i}]`));
      const out: { [key: string]: ManifestValue } = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue;
        out[k] = toManifestValue(v, `${path}.${k}`);
      }
      return out;
    }
    default:
      throw new Error(`manifest ${path}: cannot record a ${typeof value}`);
  }
}

/** Objects with keys in sorted order, all the way down (arrays keep their order). */
export function sortKeysDeep(value: ManifestValue): ManifestValue {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: ManifestValue } = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]!);
    return out;
  }
  return value;
}

export function manifestText(manifest: Record<string, ManifestValue>): string {
  return `${JSON.stringify(sortKeysDeep(manifest), null, 2)}\n`;
}

/** Merge a scenario's manifest under its name: every key must start with `<name>.`, and no key may exist twice. */
export function mergeManifest(into: Record<string, ManifestValue>, scenario: string, input: ManifestInput): void {
  for (const [key, value] of Object.entries(input)) {
    if (!key.startsWith(`${scenario}.`)) throw new Error(`scenario ${scenario}: manifest key ${key} must start with "${scenario}."`);
    if (key in into) throw new Error(`scenario ${scenario}: manifest key ${key} is already set`);
    into[key] = toManifestValue(value, key);
  }
}

/** Look a key up: exact key first, then the longest `a.b` prefix that is a key followed by a path into its object. */
export function lookup(manifest: Record<string, unknown>, key: string): { found: boolean; value?: unknown } {
  if (key in manifest) return { found: true, value: manifest[key] };
  const parts = key.split(".");
  for (let n = parts.length - 1; n >= 1; n--) {
    const head = parts.slice(0, n).join(".");
    if (!(head in manifest)) continue;
    let cur: unknown = manifest[head];
    let ok = true;
    for (const p of parts.slice(n)) {
      if (cur !== null && typeof cur === "object" && p in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[p];
      else {
        ok = false;
        break;
      }
    }
    if (ok) return { found: true, value: cur };
  }
  return { found: false };
}
