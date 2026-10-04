// CBOR for the synthetic toolkit: a small value tree that encodes byte-exactly (canonical widths by default,
// any odd encoding on request: forced argument widths, indefinite containers, chunked strings), records the
// byte span of marked sub-items, and a decoder that keeps every encoding choice so a decoded item re-encodes
// to the very same bytes (tests patch transactions this way).
//
//   const item = array([uint(1), bytes("00ff"), tag(258, array([]))]);
//   encode(item)                         -> Uint8Array
//   encodeWithSpans(array([mark("x", uint(7))]))  -> { bytes, spans: { x: { offset: 1, length: 1 } } }

import { bigToBytes, bytesToBig, bytesToHex, compareBytes, compareCanonical, concat, toBytes, utf8 } from "./bytes.js";

/** Argument width in bytes of the item head: 0 = inline (< 24), 1, 2, 4 or 8. `undefined` = shortest. */
export type Width = 0 | 1 | 2 | 4 | 8;

export interface CUint { t: "uint"; v: bigint; width?: Width }
/** `v` is the (negative) value itself: -1 encodes as argument 0. */
export interface CNint { t: "nint"; v: bigint; width?: Width }
export interface CBytes { t: "bytes"; v: Uint8Array; /** indefinite-length string made of these chunks (their concatenation is `v`) */ chunks?: Uint8Array[]; width?: Width }
export interface CText { t: "text"; v: string; chunks?: string[]; width?: Width }
export interface CArray { t: "array"; items: Cbor[]; indefinite?: boolean; width?: Width }
export interface CMap { t: "map"; entries: Array<[Cbor, Cbor]>; indefinite?: boolean; width?: Width }
export interface CTag { t: "tag"; tag: bigint; v: Cbor; width?: Width }
/** 20 false, 21 true, 22 null, 23 undefined (or any simple value). */
export interface CSimple { t: "simple"; v: number }
/** A float kept as its raw argument bytes (2, 4 or 8). */
export interface CFloat { t: "float"; bytes: Uint8Array }
/** Already-encoded CBOR (one or more items), inserted verbatim. */
export interface CRaw { t: "raw"; bytes: Uint8Array }
/** Records the span of `v` under `label` (see `encodeWithSpans`). */
export interface CMark { t: "mark"; label: string; v: Cbor }

export type Cbor = CUint | CNint | CBytes | CText | CArray | CMap | CTag | CSimple | CFloat | CRaw | CMark;

export interface Span { offset: number; length: number }

// ---------------------------------------------------------------- constructors

const MAX_U64 = (1n << 64n) - 1n;

export function uint(v: number | bigint, width?: Width): CUint {
  const big = BigInt(v);
  if (big < 0n || big > MAX_U64) throw new Error(`uint out of range: ${v}`);
  return { t: "uint", v: big, ...(width === undefined ? {} : { width }) };
}

/** An integer of either sign (major 0 or 1); beyond 64 bits use `plutusData` bignums. */
export function int(v: number | bigint, width?: Width): CUint | CNint {
  const big = BigInt(v);
  if (big >= 0n) return uint(big, width);
  if (-1n - big > MAX_U64) throw new Error(`int out of range: ${v}`);
  return { t: "nint", v: big, ...(width === undefined ? {} : { width }) };
}

export function bytes(v: string | Uint8Array, opts: { chunkSize?: number; width?: Width } = {}): CBytes {
  const data = toBytes(v);
  const item: CBytes = { t: "bytes", v: data };
  if (opts.width !== undefined) item.width = opts.width;
  if (opts.chunkSize !== undefined) {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < data.length; i += opts.chunkSize) chunks.push(data.slice(i, i + opts.chunkSize));
    item.chunks = chunks;
  }
  return item;
}

export function text(v: string, opts: { width?: Width } = {}): CText {
  return { t: "text", v, ...(opts.width === undefined ? {} : { width: opts.width }) };
}

export function array(items: Cbor[], opts: { indefinite?: boolean; width?: Width } = {}): CArray {
  return { t: "array", items, ...(opts.indefinite ? { indefinite: true } : {}), ...(opts.width === undefined ? {} : { width: opts.width }) };
}

export function map(entries: Array<[Cbor, Cbor]>, opts: { indefinite?: boolean; width?: Width } = {}): CMap {
  return { t: "map", entries, ...(opts.indefinite ? { indefinite: true } : {}), ...(opts.width === undefined ? {} : { width: opts.width }) };
}

/** A map with its entries ordered by the encoded key: `bytewise` (RFC 8949 deterministic) or `shortlex` (RFC 7049 canonical). */
export function sortedMap(entries: Array<[Cbor, Cbor]>, order: "bytewise" | "shortlex" = "shortlex", opts: { indefinite?: boolean } = {}): CMap {
  const keyed = entries.map((e) => ({ e, k: encode(e[0]) }));
  keyed.sort((a, b) => (order === "shortlex" ? compareCanonical(a.k, b.k) : compareBytes(a.k, b.k)));
  return map(
    keyed.map((x) => x.e),
    opts,
  );
}

export function tag(n: number | bigint, v: Cbor, width?: Width): CTag {
  return { t: "tag", tag: BigInt(n), v, ...(width === undefined ? {} : { width }) };
}

export const TRUE: CSimple = { t: "simple", v: 21 };
export const FALSE: CSimple = { t: "simple", v: 20 };
export const NULL: CSimple = { t: "simple", v: 22 };
export const bool = (b: boolean): CSimple => (b ? TRUE : FALSE);
export const simple = (v: number): CSimple => ({ t: "simple", v });

export function raw(v: string | Uint8Array): CRaw {
  return { t: "raw", bytes: toBytes(v) };
}

export function mark(label: string, v: Cbor): CMark {
  return { t: "mark", label, v };
}

/** The same item with a forced argument width (the head of the outermost item only). */
export function wide<T extends CUint | CNint | CBytes | CText | CArray | CMap | CTag>(item: T, width: Width): T {
  return { ...item, width };
}

// ---------------------------------------------------------------- encoder

/** Item head: major type + argument, in `width` bytes (or the shortest). */
export function head(major: number, arg: bigint, width?: Width): Uint8Array {
  if (arg < 0n || arg > MAX_U64) throw new Error(`CBOR argument out of range: ${arg}`);
  const m = major << 5;
  const natural: Width = arg < 24n ? 0 : arg < 0x100n ? 1 : arg < 0x10000n ? 2 : arg < 0x100000000n ? 4 : 8;
  const w = width ?? natural;
  if (w < natural) throw new Error(`CBOR argument ${arg} does not fit ${w} byte(s)`);
  if (w === 0) return Uint8Array.of(m | Number(arg));
  const info = w === 1 ? 24 : w === 2 ? 25 : w === 4 ? 26 : 27;
  return concat([m | info], bigToBytes(arg, w));
}

const INDEFINITE = (major: number) => Uint8Array.of((major << 5) | 31);
const BREAK = Uint8Array.of(0xff);

class Sink {
  private parts: Uint8Array[] = [];
  size = 0;
  push(b: Uint8Array): void {
    this.parts.push(b);
    this.size += b.length;
  }
  finish(): Uint8Array {
    return concat(...this.parts);
  }
}

function encodeInto(item: Cbor, sink: Sink, spans: Record<string, Span> | undefined): void {
  switch (item.t) {
    case "uint":
      sink.push(head(0, item.v, item.width));
      return;
    case "nint":
      sink.push(head(1, -1n - item.v, item.width));
      return;
    case "bytes":
      if (item.chunks) {
        sink.push(INDEFINITE(2));
        for (const c of item.chunks) {
          sink.push(head(2, BigInt(c.length)));
          sink.push(c);
        }
        sink.push(BREAK);
      } else {
        sink.push(head(2, BigInt(item.v.length), item.width));
        sink.push(item.v);
      }
      return;
    case "text":
      if (item.chunks) {
        sink.push(INDEFINITE(3));
        for (const c of item.chunks) {
          const u = utf8(c);
          sink.push(head(3, BigInt(u.length)));
          sink.push(u);
        }
        sink.push(BREAK);
      } else {
        const u = utf8(item.v);
        sink.push(head(3, BigInt(u.length), item.width));
        sink.push(u);
      }
      return;
    case "array":
      sink.push(item.indefinite ? INDEFINITE(4) : head(4, BigInt(item.items.length), item.width));
      for (const child of item.items) encodeInto(child, sink, spans);
      if (item.indefinite) sink.push(BREAK);
      return;
    case "map":
      sink.push(item.indefinite ? INDEFINITE(5) : head(5, BigInt(item.entries.length), item.width));
      for (const [k, v] of item.entries) {
        encodeInto(k, sink, spans);
        encodeInto(v, sink, spans);
      }
      if (item.indefinite) sink.push(BREAK);
      return;
    case "tag":
      sink.push(head(6, item.tag, item.width));
      encodeInto(item.v, sink, spans);
      return;
    case "simple":
      sink.push(item.v < 24 ? Uint8Array.of(0xe0 | item.v) : Uint8Array.of(0xf8, item.v));
      return;
    case "float":
      sink.push(Uint8Array.of(item.bytes.length === 2 ? 0xf9 : item.bytes.length === 4 ? 0xfa : 0xfb));
      sink.push(item.bytes);
      return;
    case "raw":
      sink.push(item.bytes);
      return;
    case "mark": {
      const offset = sink.size;
      encodeInto(item.v, sink, spans);
      if (!spans) return;
      if (item.label in spans) throw new Error(`duplicate span label ${item.label}`);
      spans[item.label] = { offset, length: sink.size - offset };
      return;
    }
  }
}

export function encode(item: Cbor): Uint8Array {
  const sink = new Sink();
  encodeInto(item, sink, undefined);
  return sink.finish();
}

export function encodeHex(item: Cbor): string {
  return bytesToHex(encode(item));
}

/** Encode and report the byte span of every `mark`ed sub-item (offsets relative to the start of `item`). */
export function encodeWithSpans(item: Cbor): { bytes: Uint8Array; spans: Record<string, Span> } {
  const sink = new Sink();
  const spans: Record<string, Span> = {};
  encodeInto(item, sink, spans);
  return { bytes: sink.finish(), spans };
}

// ---------------------------------------------------------------- decoder

/** A decoded node: the item plus where it sat in the input. */
export interface Decoded {
  item: Cbor;
  start: number;
  end: number;
}

function widthOf(info: number): Width {
  return info < 24 ? 0 : info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 8;
}

/**
 * Decode one item at `offset`, keeping widths, indefinite containers and string chunking so that
 * `encode(decodeAt(b).item)` reproduces `b`. Throws on malformed or truncated input.
 */
export function decodeAt(input: Uint8Array, offset = 0): Decoded {
  const need = (n: number, at: number) => {
    if (at + n > input.length) throw new Error(`CBOR input ends at ${input.length} (needed ${at + n})`);
  };
  const read = (at: number): { major: number; info: number; arg: bigint; width: Width; next: number } => {
    need(1, at);
    const first = input[at]!;
    const major = first >> 5;
    const info = first & 0x1f;
    if (info < 24) return { major, info, arg: BigInt(info), width: 0, next: at + 1 };
    if (info > 27) return { major, info, arg: 0n, width: 0, next: at + 1 };
    const w = widthOf(info);
    need(1 + w, at);
    return { major, info, arg: bytesToBig(input.subarray(at + 1, at + 1 + w)), width: w, next: at + 1 + w };
  };
  const one = (at: number): Decoded => {
    const h = read(at);
    const { major, info, arg, width } = h;
    let p = h.next;
    const done = (item: Cbor): Decoded => ({ item, start: at, end: p });
    switch (major) {
      case 0:
        if (info > 27) throw new Error(`malformed CBOR at ${at}`);
        return done({ t: "uint", v: arg, width });
      case 1:
        if (info > 27) throw new Error(`malformed CBOR at ${at}`);
        return done({ t: "nint", v: -1n - arg, width });
      case 2:
      case 3: {
        if (info === 31) {
          const chunks: Uint8Array[] = [];
          for (;;) {
            need(1, p);
            if (input[p] === 0xff) {
              p += 1;
              break;
            }
            const ch = read(p);
            if (ch.major !== major || ch.info > 27) throw new Error(`bad chunk in indefinite string at ${p}`);
            need(Number(ch.arg), ch.next);
            chunks.push(input.slice(ch.next, ch.next + Number(ch.arg)));
            p = ch.next + Number(ch.arg);
          }
          const all = concat(...chunks);
          return major === 2 ? done({ t: "bytes", v: all, chunks }) : done({ t: "text", v: new TextDecoder().decode(all), chunks: chunks.map((c) => new TextDecoder().decode(c)) });
        }
        if (info > 27) throw new Error(`malformed CBOR at ${at}`);
        need(Number(arg), p);
        const body = input.slice(p, p + Number(arg));
        p += Number(arg);
        return major === 2 ? done({ t: "bytes", v: body, width }) : done({ t: "text", v: new TextDecoder().decode(body), width });
      }
      case 4: {
        const items: Cbor[] = [];
        if (info === 31) {
          for (;;) {
            need(1, p);
            if (input[p] === 0xff) {
              p += 1;
              break;
            }
            const d = one(p);
            items.push(d.item);
            p = d.end;
          }
          return done({ t: "array", items, indefinite: true });
        }
        for (let i = 0n; i < arg; i++) {
          const d = one(p);
          items.push(d.item);
          p = d.end;
        }
        return done({ t: "array", items, width });
      }
      case 5: {
        const entries: Array<[Cbor, Cbor]> = [];
        if (info === 31) {
          for (;;) {
            need(1, p);
            if (input[p] === 0xff) {
              p += 1;
              break;
            }
            const k = one(p);
            const v = one(k.end);
            entries.push([k.item, v.item]);
            p = v.end;
          }
          return done({ t: "map", entries, indefinite: true });
        }
        for (let i = 0n; i < arg; i++) {
          const k = one(p);
          const v = one(k.end);
          entries.push([k.item, v.item]);
          p = v.end;
        }
        return done({ t: "map", entries, width });
      }
      case 6: {
        const inner = one(p);
        p = inner.end;
        return done({ t: "tag", tag: arg, v: inner.item, width });
      }
      default: {
        // major 7: simple values and floats (the argument bytes were not consumed as an integer: re-read from the head)
        if (info < 24) return done({ t: "simple", v: info });
        if (info === 24) {
          need(1, at + 1);
          p = at + 2;
          return done({ t: "simple", v: input[at + 1]! });
        }
        if (info >= 25 && info <= 27) {
          const w = widthOf(info);
          need(w, at + 1);
          p = at + 1 + w;
          return done({ t: "float", bytes: input.slice(at + 1, at + 1 + w) });
        }
        throw new Error(`unsupported CBOR simple/break at ${at}`);
      }
    }
  };
  return one(offset);
}

/** Decode a whole buffer holding exactly one item. */
export function decode(input: Uint8Array | string): Cbor {
  const data = toBytes(input);
  const d = decodeAt(data, 0);
  if (d.end !== data.length) throw new Error(`CBOR input has ${data.length - d.end} trailing byte(s) after the item (item ends at ${d.end})`);
  return d.item;
}

/** Offset just past the item that starts at `offset`. */
export function itemEnd(input: Uint8Array, offset = 0): number {
  return decodeAt(input, offset).end;
}

// ---------------------------------------------------------------- inspection helpers

/** Plain JS view of an item (bytes as hex, maps as `{map: [[k, v]]}`): for asserts in tests. */
export function toPlain(item: Cbor): unknown {
  switch (item.t) {
    case "uint":
    case "nint":
      return item.v;
    case "bytes":
      return bytesToHex(item.v);
    case "text":
      return item.v;
    case "array":
      return item.items.map(toPlain);
    case "map":
      return { map: item.entries.map(([k, v]) => [toPlain(k), toPlain(v)]) };
    case "tag":
      return { tag: item.tag, value: toPlain(item.v) };
    case "simple":
      return item.v === 20 ? false : item.v === 21 ? true : item.v === 22 ? null : item.v === 23 ? undefined : { simple: item.v };
    case "float":
      return { float: bytesToHex(item.bytes) };
    case "raw":
      return toPlain(decode(item.bytes));
    case "mark":
      return toPlain(item.v);
  }
}

/** Value of map key `key` (uint) in a map item. */
export function mapGet(item: Cbor, key: number | bigint): Cbor | undefined {
  if (item.t !== "map") throw new Error("mapGet: not a map");
  const k = BigInt(key);
  for (const [kk, v] of item.entries) if (kk.t === "uint" && kk.v === k) return v;
  return undefined;
}
