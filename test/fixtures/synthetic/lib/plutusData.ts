// Plutus data (the `data` of the ledger CDDL) and its canonical on-chain encoding:
//   Constr i  -> tag 121..127 (i < 7), tag 1280.. (7 <= i < 128), else tag 102 [i, fields]
//   fields / lists: definite `80` when empty, indefinite `9f .. ff` otherwise (what the node's Plutus serialiser writes)
//   byte strings: definite up to 64 bytes, indefinite chunks of 64 bytes beyond that
//   integers: major 0 / 1 within 64 bits, bignum tags 2 / 3 (bytes chunked at 64) beyond
//   maps: definite, entries in the order given

import { bigToBytes, bytesToBig, bytesToHex, toBytes } from "./bytes.js";
import { blake2b256 } from "./blake2b.js";
import { array, bytes as cbytes, decode, encode, int, map as cmap, tag, type Cbor } from "./cbor.js";

export type PlutusData =
  | { kind: "int"; v: bigint }
  | { kind: "bytes"; v: Uint8Array }
  | { kind: "list"; items: PlutusData[] }
  | { kind: "map"; entries: Array<[PlutusData, PlutusData]> }
  | { kind: "constr"; index: bigint; fields: PlutusData[] };

export const pInt = (v: number | bigint): PlutusData => ({ kind: "int", v: BigInt(v) });
export const pBytes = (v: string | Uint8Array): PlutusData => ({ kind: "bytes", v: toBytes(v) });
export const pText = (s: string): PlutusData => ({ kind: "bytes", v: new TextEncoder().encode(s) });
export const pList = (items: PlutusData[]): PlutusData => ({ kind: "list", items });
export const pMap = (entries: Array<[PlutusData, PlutusData]>): PlutusData => ({ kind: "map", entries });
export const constr = (index: number | bigint, fields: PlutusData[] = []): PlutusData => ({ kind: "constr", index: BigInt(index), fields });

/** The unit value `Constr 0 []`. */
export const UNIT: PlutusData = constr(0, []);
export const pBool = (b: boolean): PlutusData => constr(b ? 1 : 0, []);
export const pSome = (v: PlutusData): PlutusData => constr(0, [v]);
export const pNone: PlutusData = constr(1, []);

const CHUNK = 64;

function bytesItem(b: Uint8Array): Cbor {
  return b.length <= CHUNK ? cbytes(b) : cbytes(b, { chunkSize: CHUNK });
}

function listItem(items: Cbor[]): Cbor {
  return array(items, { indefinite: items.length > 0 });
}

export function plutusDataToCbor(d: PlutusData): Cbor {
  switch (d.kind) {
    case "int": {
      const v = d.v;
      if (v >= 0n && v < 1n << 64n) return int(v);
      if (v < 0n && -1n - v < 1n << 64n) return int(v);
      return v >= 0n ? tag(2, bytesItem(bigToBytes(v))) : tag(3, bytesItem(bigToBytes(-1n - v)));
    }
    case "bytes":
      return bytesItem(d.v);
    case "list":
      return listItem(d.items.map(plutusDataToCbor));
    case "map":
      return cmap(d.entries.map(([k, v]) => [plutusDataToCbor(k), plutusDataToCbor(v)] as [Cbor, Cbor]));
    case "constr": {
      const fields = listItem(d.fields.map(plutusDataToCbor));
      const i = d.index;
      if (i >= 0n && i <= 6n) return tag(121n + i, fields);
      if (i >= 7n && i <= 127n) return tag(1280n + (i - 7n), fields);
      return tag(102, array([int(i), fields]));
    }
  }
}

export function encodePlutusData(d: PlutusData): Uint8Array {
  return encode(plutusDataToCbor(d));
}

export function encodePlutusDataHex(d: PlutusData): string {
  return bytesToHex(encodePlutusData(d));
}

/** blake2b-256 of the encoding: the datum hash. */
export function datumHash(d: PlutusData | Uint8Array | string): string {
  const b = typeof d === "object" && "kind" in d ? encodePlutusData(d) : toBytes(d as Uint8Array | string);
  return bytesToHex(blake2b256(b));
}

function bytesOfItem(c: Cbor): Uint8Array {
  if (c.t !== "bytes") throw new Error("expected a byte string");
  return c.v;
}

export function plutusDataFromCbor(c: Cbor): PlutusData {
  switch (c.t) {
    case "uint":
    case "nint":
      return { kind: "int", v: c.v };
    case "bytes":
      return { kind: "bytes", v: c.v };
    case "array":
      return { kind: "list", items: c.items.map(plutusDataFromCbor) };
    case "map":
      return { kind: "map", entries: c.entries.map(([k, v]) => [plutusDataFromCbor(k), plutusDataFromCbor(v)] as [PlutusData, PlutusData]) };
    case "tag": {
      const t = c.tag;
      if (t === 2n) return { kind: "int", v: bytesToBig(bytesOfItem(c.v)) };
      if (t === 3n) return { kind: "int", v: -1n - bytesToBig(bytesOfItem(c.v)) };
      const fieldsOf = (x: Cbor): PlutusData[] => {
        if (x.t !== "array") throw new Error("constructor fields must be an array");
        return x.items.map(plutusDataFromCbor);
      };
      if (t >= 121n && t <= 127n) return { kind: "constr", index: t - 121n, fields: fieldsOf(c.v) };
      if (t >= 1280n && t <= 1400n) return { kind: "constr", index: t - 1280n + 7n, fields: fieldsOf(c.v) };
      if (t === 102n) {
        if (c.v.t !== "array" || c.v.items.length !== 2) throw new Error("tag 102 expects [index, fields]");
        const idx = c.v.items[0]!;
        if (idx.t !== "uint") throw new Error("tag 102 index must be an unsigned integer");
        return { kind: "constr", index: idx.v, fields: fieldsOf(c.v.items[1]!) };
      }
      throw new Error(`tag ${t} is not Plutus data`);
    }
    case "mark":
      return plutusDataFromCbor(c.v);
    case "raw":
      return plutusDataFromCbor(decode(c.bytes));
    default:
      throw new Error(`CBOR ${c.t} is not Plutus data`);
  }
}

export function decodePlutusData(input: string | Uint8Array): PlutusData {
  return plutusDataFromCbor(decode(input));
}

/** The JSON shape Koios (and db-sync) use for `inline_datum.value`: `{constructor, fields}`, `{int}`, `{bytes}`, `{list}`, `{map: [{k, v}]}`. */
export function plutusDataToKoiosJson(d: PlutusData): unknown {
  switch (d.kind) {
    case "int":
      return { int: d.v >= BigInt(Number.MIN_SAFE_INTEGER) && d.v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(d.v) : d.v };
    case "bytes":
      return { bytes: bytesToHex(d.v) };
    case "list":
      return { list: d.items.map(plutusDataToKoiosJson) };
    case "map":
      return { map: d.entries.map(([k, v]) => ({ k: plutusDataToKoiosJson(k), v: plutusDataToKoiosJson(v) })) };
    case "constr":
      return { constructor: Number(d.index), fields: d.fields.map(plutusDataToKoiosJson) };
  }
}
