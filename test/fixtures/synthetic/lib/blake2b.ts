// BLAKE2b (RFC 7693), pure TypeScript: Cardano hashes everything with blake2b-224 (key / script hashes),
// blake2b-256 (tx ids, datum hashes, script data hash) and blake2b-160 (CIP-14 fingerprints).
// Unkeyed, any digest length 1..64. 64-bit words are two 32-bit halves in a Uint32Array (no BigInt in the hot loop).

import { bytesToHex, toBytes } from "./bytes.js";

const IV = [
  0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
  0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179,
];

const SIGMA: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
SIGMA.push(SIGMA[0]!, SIGMA[1]!);

/** v[a] += v[b] + m (64-bit, halves at 2a / 2a+1: high, low). */
function add3(v: Uint32Array, a: number, b: number, mHi: number, mLo: number): void {
  const lo = (v[2 * a + 1]! >>> 0) + (v[2 * b + 1]! >>> 0) + (mLo >>> 0);
  const carry = lo > 0xffffffff ? Math.floor(lo / 0x100000000) : 0;
  v[2 * a + 1] = lo >>> 0;
  v[2 * a] = ((v[2 * a]! >>> 0) + (v[2 * b]! >>> 0) + (mHi >>> 0) + carry) >>> 0;
}

function xorRotr(v: Uint32Array, d: number, a: number, n: number): void {
  const hi = (v[2 * d]! ^ v[2 * a]!) >>> 0;
  const lo = (v[2 * d + 1]! ^ v[2 * a + 1]!) >>> 0;
  if (n === 32) {
    v[2 * d] = lo;
    v[2 * d + 1] = hi;
  } else if (n < 32) {
    v[2 * d] = ((hi >>> n) | (lo << (32 - n))) >>> 0;
    v[2 * d + 1] = ((lo >>> n) | (hi << (32 - n))) >>> 0;
  } else {
    const k = n - 32;
    v[2 * d] = ((lo >>> k) | (hi << (32 - k))) >>> 0;
    v[2 * d + 1] = ((hi >>> k) | (lo << (32 - k))) >>> 0;
  }
}

function g(v: Uint32Array, m: Uint32Array, a: number, b: number, c: number, d: number, x: number, y: number): void {
  add3(v, a, b, m[2 * x]!, m[2 * x + 1]!);
  xorRotr(v, d, a, 32);
  add3(v, c, d, 0, 0);
  xorRotr(v, b, c, 24);
  add3(v, a, b, m[2 * y]!, m[2 * y + 1]!);
  xorRotr(v, d, a, 16);
  add3(v, c, d, 0, 0);
  xorRotr(v, b, c, 63);
}

function compress(h: Uint32Array, block: Uint8Array, counter: number, last: boolean): void {
  const v = new Uint32Array(32);
  const m = new Uint32Array(32);
  for (let i = 0; i < 16; i++) {
    // little-endian 64-bit word i: low half first in the bytes
    const o = i * 8;
    m[2 * i + 1] = (block[o]! | (block[o + 1]! << 8) | (block[o + 2]! << 16) | (block[o + 3]! << 24)) >>> 0;
    m[2 * i] = (block[o + 4]! | (block[o + 5]! << 8) | (block[o + 6]! << 16) | (block[o + 7]! << 24)) >>> 0;
  }
  for (let i = 0; i < 16; i++) v[i] = h[i]!;
  for (let i = 0; i < 16; i++) v[16 + i] = IV[i]!;
  // counter < 2^53 here (test inputs are small): low = counter mod 2^32, high = counter / 2^32
  v[2 * 12 + 1] = (v[2 * 12 + 1]! ^ (counter >>> 0)) >>> 0;
  v[2 * 12] = (v[2 * 12]! ^ Math.floor(counter / 0x100000000)) >>> 0;
  if (last) {
    v[2 * 14] = ~v[2 * 14]! >>> 0;
    v[2 * 14 + 1] = ~v[2 * 14 + 1]! >>> 0;
  }
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r]!;
    g(v, m, 0, 4, 8, 12, s[0]!, s[1]!);
    g(v, m, 1, 5, 9, 13, s[2]!, s[3]!);
    g(v, m, 2, 6, 10, 14, s[4]!, s[5]!);
    g(v, m, 3, 7, 11, 15, s[6]!, s[7]!);
    g(v, m, 0, 5, 10, 15, s[8]!, s[9]!);
    g(v, m, 1, 6, 11, 12, s[10]!, s[11]!);
    g(v, m, 2, 7, 8, 13, s[12]!, s[13]!);
    g(v, m, 3, 4, 9, 14, s[14]!, s[15]!);
  }
  for (let i = 0; i < 16; i++) h[i] = (h[i]! ^ v[i]! ^ v[16 + i]!) >>> 0;
}

/** BLAKE2b digest of `data` with `outLength` bytes (1..64). */
export function blake2b(data: Uint8Array | string, outLength: number): Uint8Array {
  if (!Number.isInteger(outLength) || outLength < 1 || outLength > 64) throw new Error(`blake2b: bad digest length ${outLength}`);
  const input = toBytes(data);
  const h = new Uint32Array(16);
  for (let i = 0; i < 16; i++) h[i] = IV[i]!;
  // parameter block word 0: digest length | key length << 8 | fanout 1 << 16 | depth 1 << 24 (low half of h[0])
  h[1] = (h[1]! ^ (0x01010000 | outLength)) >>> 0;
  let offset = 0;
  const block = new Uint8Array(128);
  // every block but the last is full; the last holds the remainder (a whole block when the length is a multiple of 128)
  while (input.length - offset > 128) {
    block.set(input.subarray(offset, offset + 128));
    offset += 128;
    compress(h, block, offset, false);
  }
  block.fill(0);
  block.set(input.subarray(offset));
  compress(h, block, input.length, true);
  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) {
    const hi = h[2 * i]!;
    const lo = h[2 * i + 1]!;
    out[i * 8] = lo & 0xff;
    out[i * 8 + 1] = (lo >>> 8) & 0xff;
    out[i * 8 + 2] = (lo >>> 16) & 0xff;
    out[i * 8 + 3] = (lo >>> 24) & 0xff;
    out[i * 8 + 4] = hi & 0xff;
    out[i * 8 + 5] = (hi >>> 8) & 0xff;
    out[i * 8 + 6] = (hi >>> 16) & 0xff;
    out[i * 8 + 7] = (hi >>> 24) & 0xff;
  }
  return out.slice(0, outLength);
}

export const blake2b224 = (data: Uint8Array | string): Uint8Array => blake2b(data, 28);
export const blake2b256 = (data: Uint8Array | string): Uint8Array => blake2b(data, 32);
export const blake2b160 = (data: Uint8Array | string): Uint8Array => blake2b(data, 20);

export const hash224 = (data: Uint8Array | string): string => bytesToHex(blake2b224(data));
export const hash256 = (data: Uint8Array | string): string => bytesToHex(blake2b256(data));
