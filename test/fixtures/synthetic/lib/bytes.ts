// Byte helpers shared by the synthetic toolkit (hex <-> bytes, concat, comparison, big-endian numbers).

export type Hex = string;

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) throw new Error(`not a hex string: ${hex.length > 40 ? `${hex.slice(0, 40)}...` : hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Accept hex text or bytes. */
export function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? hexToBytes(value) : value;
}

export function concat(...parts: Array<Uint8Array | readonly number[]>): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Lexicographic byte comparison (shorter first on a common prefix): the ledger's `Ord` on hashes and asset names. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Canonical CBOR key order: shorter encoding first, then lexicographic. */
export function compareCanonical(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return compareBytes(a, b);
}

export function bigToBytes(value: bigint, length?: number): Uint8Array {
  if (value < 0n) throw new Error("bigToBytes: negative value");
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  if (value === 0n && length === undefined) hex = "";
  const raw = hexToBytes(hex);
  if (length === undefined) return raw;
  if (raw.length > length) throw new Error(`bigToBytes: ${value} does not fit ${length} bytes`);
  const out = new Uint8Array(length);
  out.set(raw, length - raw.length);
  return out;
}

export function bytesToBig(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function utf8Hex(text: string): string {
  return bytesToHex(utf8(text));
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return compareBytes(a, b) === 0;
}
