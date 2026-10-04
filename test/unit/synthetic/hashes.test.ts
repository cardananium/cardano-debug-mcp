import { describe, expect, it } from "vitest";

import { blake2b, blake2b160, blake2b224, blake2b256, hash224 } from "../../fixtures/synthetic/lib/blake2b.js";
import { bytesToHex, hexToBytes, utf8 } from "../../fixtures/synthetic/lib/bytes.js";

const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 255);

// Digests produced by python's hashlib.blake2b(data, digest_size=...) over `pattern(length)`.
const PYTHON_VECTORS: Array<[number, number, string]> = [
  [0, 20, "3345524abf6bbe1809449224b5972c41790b6cf2"],
  [0, 28, "836cc68931c2e4e3e838602eca1902591d216837bafddfe6f0c8cb07"],
  [0, 32, "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8"],
  [1, 28, "b16b56f5ec064be6ac3cab6035efae86b366cc3dc4a0d571603d70e5"],
  [1, 32, "e88bd757ad5b9bedf372d8d3f0cf6c962a469db61a265f6418e1ffed86da29ec"],
  [3, 28, "260c560845c9523e6ec38728114cd4389a13f5200b4a5603ba085c33"],
  [3, 32, "9facd640130c81e7f318a8d5c660bc1b0f5d03861ffbd4cc1358e0e904593c28"],
  [127, 28, "198497238de2eb5ecfd747bbda92fb0a895d6f21431582ffc9775a7d"],
  [127, 32, "c9ae3859964b35f04c54b36d33cf299d7290ee621005d28e51598a943560aaaa"],
  [128, 28, "1e97c1e2b0b4945b759976c37f3e8168fd6afe29ae2d95e87d7e8cca"],
  [128, 32, "f0501d06597880592bc49234eef100ec1ff349058d0e9d9b753504e24af86dd6"],
  [129, 20, "b195dc7be88c88574f88d235228691bf35e409ec"],
  [129, 28, "24e90dabf80c32232a9a80be3e225fdf002405d0dc3b078616a8cd4c"],
  [129, 32, "a34a4e1e03c541dfbf3099c4b6c143c022ced65c28bd7e8a10e0a098461aecf0"],
  [129, 64, "47889df9eb4d717afc5019df5c6a83df00a0b8677395e078cd5778ace0f338a618e68b7d9afb065d9e6a01ccd31d109447e7fae771c3ee3e105709194122ba2b"],
  [255, 28, "c5a185989e6f604fe14f688e7c35b0647ca1ec5ce791ebc9bf1f9ea6"],
  [255, 32, "f2d64a40e9412a3414161ff6250075225418fd7c271c1123e162e1bca0de9f93"],
  [256, 28, "35d8532a0ef7e2a49d11024c41dd205119d36e522f7958e89b90d101"],
  [256, 32, "d93ebb9c802f5630ab22516fd82b6c21bc8bd551d531349b715f046ed11ed871"],
  [1000, 28, "5c7018a39c8e28ff8e37bb797274e6fb98a0ad3bc1c7f933675ef16f"],
  [1000, 32, "d62b6c768ce1afc8367e0498ab2f8e3f7c178c35b1429f14c4604b545d200f52"],
];

describe("blake2b", () => {
  it("RFC 7693 appendix A: blake2b-512 of 'abc'", () => {
    expect(bytesToHex(blake2b(utf8("abc"), 64))).toBe(
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
  });

  it("blake2b-512 of the empty input", () => {
    expect(bytesToHex(blake2b(new Uint8Array(0), 64))).toBe(
      "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce",
    );
  });

  it("the Cardano digest sizes of 'abc' (224 / 256 / 160 bits)", () => {
    expect(hash224(utf8("abc"))).toBe("9bd237b02a29e43bdd6738afa5b53ff0eee178d6210b618e4511aec8");
    expect(bytesToHex(blake2b256(utf8("abc")))).toBe("bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319");
    expect(blake2b160(utf8("abc"))).toHaveLength(20);
    expect(blake2b224(utf8("abc"))).toHaveLength(28);
  });

  it.each(PYTHON_VECTORS)("matches python hashlib: %i bytes, %i-byte digest", (length, digest, expected) => {
    expect(bytesToHex(blake2b(pattern(length), digest))).toBe(expected);
  });

  it("accepts hex text as input and rejects bad digest lengths", () => {
    expect(bytesToHex(blake2b256("616263"))).toBe(bytesToHex(blake2b256(utf8("abc"))));
    expect(() => blake2b(utf8("x"), 0)).toThrow(/digest length/);
    expect(() => blake2b(utf8("x"), 65)).toThrow(/digest length/);
    expect(hexToBytes("00ff")).toEqual(Uint8Array.of(0, 255));
  });
});
