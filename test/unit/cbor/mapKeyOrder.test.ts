// Canonical map-key order: the library sorts BYTEWISE by the encoded key (RFC 8949 §4.2.1), not
// shortest-first (RFC 7049 §3.9); the hint and the docs must say what the library does.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { hintsFor } from "../../../src/cbor/hints.js";
import { collectOddities } from "../../../src/cbor/rawTree.js";
import { rawLib } from "../../helpers/inProcessLib.js";

const oddities = (hex: string) => collectOddities((JSON.parse(rawLib().cbor_to_json!(hex) as string) as { value: unknown }).value).rows.map((r) => r.kind);

describe("map key order", () => {
  it("mixed-length keys: `1818` (24) sorts before `20` (-1) bytewise, so only the other order is flagged", () => {
    expect(oddities("a2 1818 02 20 01".replace(/ /g, ""))).toEqual([]);
    expect(oddities("a2 20 01 1818 02".replace(/ /g, ""))).toEqual(["MapKeysNotSorted"]);
    // text keys: "b" (`6162`) before "aa" (`626161`), the length byte decides; the reverse is flagged
    expect(oddities("a2 6162 01 626161 02".replace(/ /g, ""))).toEqual([]);
    expect(oddities("a2 626161 02 6162 01".replace(/ /g, ""))).toEqual(["MapKeysNotSorted"]);
  });

  it("the hint says bytewise order of the encoded keys, not shortest first", () => {
    const [hint] = hintsFor({ oddities: [{ kind: "MapKeysNotSorted" }] });
    expect(hint).toMatch(/bytewise lexicographic order of the encoded keys/);
    expect(hint).toMatch(/`1818` sorts before `20`/);
    expect(hint).not.toMatch(/shortest encoding first/);
  });

  it("the oddity docs state the same order", () => {
    const doc = readFileSync(path.join(process.cwd(), "src/docs/cbor-cddl/03-oddity-kinds.md"), "utf8");
    expect(doc).toMatch(/bytewise order of their encodings/);
    expect(doc).toMatch(/`1818` sorts before `20`/);
  });
});
