// Minimal CBOR walker for tests that need "the same transaction with other witnesses": item
// boundaries of definite- and indefinite-length items, and a witness-set key remover.

function head(bytes: Uint8Array, offset: number): { major: number; info: number; value: number; next: number } {
  const first = bytes[offset]!;
  const major = first >> 5;
  const info = first & 0x1f;
  if (info < 24) return { major, info, value: info, next: offset + 1 };
  const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
  if (size === 0) return { major, info, value: -1, next: offset + 1 }; // 31 = indefinite
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 256 + bytes[offset + 1 + i]!;
  return { major, info, value, next: offset + 1 + size };
}

/** Offset just past the CBOR item starting at `offset`. */
export function itemEnd(bytes: Uint8Array, offset: number): number {
  const h = head(bytes, offset);
  const indefinite = h.info === 31;
  switch (h.major) {
    case 0:
    case 1:
    case 7:
      return h.next;
    case 2:
    case 3: {
      if (!indefinite) return h.next + h.value;
      let p = h.next;
      while (bytes[p] !== 0xff) p = itemEnd(bytes, p);
      return p + 1;
    }
    case 4:
    case 5: {
      const per = h.major === 5 ? 2 : 1;
      let p = h.next;
      if (indefinite) {
        while (bytes[p] !== 0xff) p = itemEnd(bytes, p);
        return p + 1;
      }
      for (let i = 0; i < h.value * per; i++) p = itemEnd(bytes, p);
      return p;
    }
    case 6:
      return itemEnd(bytes, h.next);
    default:
      throw new Error(`unsupported CBOR major type ${h.major}`);
  }
}

const toBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function mapHeader(count: number): Uint8Array {
  if (count < 24) return Uint8Array.of(0xa0 + count);
  if (count < 256) return Uint8Array.of(0xb8, count);
  return Uint8Array.of(0xb9, count >> 8, count & 0xff);
}

/**
 * The transaction `[body, witness_set, is_valid, aux]` with witness-set map key `key` removed (0 =
 * vkey witnesses). The body bytes are untouched, so the tx hash stays the same.
 */
export function withoutWitnessKey(txHex: string, key: number): string {
  const bytes = toBytes(txHex);
  const top = head(bytes, 0);
  if (top.major !== 4) throw new Error("not a transaction array");
  const bodyEnd = itemEnd(bytes, top.next);
  const wsStart = bodyEnd;
  const ws = head(bytes, wsStart);
  if (ws.major !== 5 || ws.info === 31) throw new Error("witness set is not a definite-length map");
  const wsEnd = itemEnd(bytes, wsStart);
  const kept: Uint8Array[] = [];
  let removed = false;
  let p = ws.next;
  for (let i = 0; i < ws.value; i++) {
    const keyEnd = itemEnd(bytes, p);
    const valueEnd = itemEnd(bytes, keyEnd);
    const k = head(bytes, p);
    if (k.major === 0 && k.value === key) removed = true;
    else kept.push(bytes.slice(p, valueEnd));
    p = valueEnd;
  }
  if (!removed) throw new Error(`witness set has no key ${key}`);
  const parts = [bytes.slice(0, wsStart), mapHeader(kept.length), ...kept, bytes.slice(wsEnd)];
  return parts.map(toHex).join("");
}
