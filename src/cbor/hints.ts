// Pattern-based hints for CBOR / CDDL diagnostics: from the structural error kind, the validator's
// `expected` / message pairs, the encoding oddities and a few probes of the raw tree, say what the
// bytes most likely are and how to fix them. Pure; every rule is a predicate + one sentence.

import { CBOR_WALKER_DEPTH_LIMIT } from "@cardananium/cquisitor-lib/util";

export interface HintError {
  kind: string;
  message: string;
  expected: string | null;
  path: string | null;
  /** The row states what one alternative of a type choice wanted, not what the document has to be. */
  from_type_choice?: boolean;
  /** The schema text the validator applied when it failed (for rules that need to know the target kind). */
  cddl_fragment?: string | null;
}

export interface HintContext {
  /** `cbor_to_json` failure (the bytes are not well-formed CBOR). */
  structural?: { kind: string; message: string; offset?: number } | null;
  /** Validator diagnostics, head first. */
  errors?: ReadonlyArray<HintError>;
  oddities?: ReadonlyArray<{ kind: string; path?: string }>;
  /** `cborRootKind` of the decoded root (`array`, `map`, `tag:258`, `bytes`, …). */
  rootKind?: string | null;
  /** Hex of byte strings found in the tree (for the double-wrapped-script probe). */
  byteStrings?: ReadonlyArray<string>;
  /** Era preset in use (`conway`, `babbage`, …) or null for a user schema. */
  era?: string | null;
  /** Rule the verdict is about (when one was picked). */
  rule?: string | null;
  /** How the candidate search went when `rule` was omitted. */
  candidates?: { tried: number; anyValid: boolean };
  /** Total bytes of the input. */
  inputBytes?: number;
}

export const MAX_HINTS = 8;

const CONSTRUCTOR_TAG = /got #6\.(\d+)\(/;

/** Whether tag `n` is a PlutusData constructor tag (121-127, 1280-1400) or the general form 102. */
export function isPlutusConstructorTag(n: number): boolean {
  return n === 102 || (n >= 121 && n <= 127) || (n >= 1280 && n <= 1400);
}

/** Constructor index a PlutusData tag stands for, or null. */
export function constructorIndexOf(tag: number): number | null {
  if (tag >= 121 && tag <= 127) return tag - 121;
  if (tag >= 1280 && tag <= 1400) return tag - 1280 + 7;
  return null;
}

const HEX_TEXT = /got text "([0-9a-fA-F]{8,}…?)"/;
/** Byte strings longer than the 64-byte `bounded_bytes` cap: `got bytes 0x… (65 bytes)`. */
const OVERLONG_BYTES = /got bytes .*\((6[5-9]|[7-9]\d|\d{3,}) bytes\)/;
const CHUNKED_BYTES = /got indefinite bytes\((\d+) chunks\)/;
/** `bounded_bytes` itself refusing a definite string: `expected byte string length to be in the range 0 <= value <= 64, got 65`. */
const BOUNDED_BYTES_LENGTH = /^expected byte string length to be in the range 0 <= value <= 64, got (\d+)$/;
/** `bounded_bytes` refusing one chunk of an indefinite-length string: `… to be at most 64 bytes, got 70 bytes in chunk 0`. */
const BOUNDED_BYTES_CHUNK = /^expected each chunk of the indefinite-length byte string to be at most 64 bytes, got (\d+) bytes in chunk (\d+)$/;
/** An empty array where the rule wants something else: `expected map { … }, got array(0 items)`. */
const EMPTY_ARRAY = /got (?:indefinite )?array\(0 items\)$/;
const EMBEDDED_CBOR = /error decoding embedded CBOR:?\s*(.+)$/i;

/** True when a byte string's content is itself a CBOR byte string wrapping a flat Plutus program (`01 00 00 …`). */
export function looksDoubleWrappedScript(hex: string): boolean {
  return /^(58[0-9a-f]{2}|59[0-9a-f]{4}|5a[0-9a-f]{8}|5b[0-9a-f]{16})01000[0-9a-f]/i.test(hex);
}

function structuralHints(s: NonNullable<HintContext["structural"]>, inputBytes: number | undefined): string[] {
  const at = s.offset !== undefined ? ` at offset ${s.offset}` : "";
  switch (s.kind) {
    case "invalid_hex":
      return ["The input is not a hex byte string (odd digit count or non-hex characters): a nibble was lost, or the text is base64 / bech32 — those are accepted as-is, but not mixed with hex."];
    case "unexpected_eof":
      return [`The input ends${inputBytes !== undefined ? ` after ${inputBytes} bytes` : ""} while an item${at} still expects content: the hex was truncated, or a length prefix (bytes / text / array / map count) is larger than the payload that follows.`];
    case "trailing_data":
      return [`Bytes remain after the top-level item ends${at}: two items were concatenated, a length prefix is shorter than its payload, or an enclosing header is missing at the front (a body without its transaction array, a datum without its constructor tag).`];
    case "unexpected_break":
      return [`A break byte (ff)${at} closes no indefinite-length container: a definite-length container was terminated with ff, or a stray ff was appended.`];
    case "invalid_utf8":
      return [`A text string (major type 3)${at} holds bytes that are not UTF-8: raw bytes were encoded as text — use a byte string (major type 2: headers 4x / 58 / 59).`];
    case "invalid_chunk":
      return [`A chunk of an indefinite-length string${at} has the wrong type: every chunk must be a definite-length string of the same major type as the container.`];
    case "invalid_syntax":
      return [`The initial byte${at} is not a valid CBOR header (reserved additional info 28-30, or a malformed argument): a flipped byte, or data that is not CBOR here (e.g. a flat Plutus program without its byte-string wrapper).`];
    case "int_not_representable":
      return [`An integer${at} does not fit the decoder's 64-bit range: encode it as a bignum (tag 2 / 3) if the field allows one.`];
    case "non_finite_float":
      return [`A float${at} is NaN or infinite; Cardano schemas use no floats — the bytes are probably not a ledger object, or a header was misread as a float.`];
    case "nesting_too_deep":
      return [`Nesting is deeper than the decoder examines (an implementation limit, ${CBOR_WALKER_DEPTH_LIMIT} levels): the bytes were not judged invalid — inspect a smaller part.`];
    default:
      return [];
  }
}

function inputParseHints(e: HintError, inputBytes: number | undefined): string[] {
  const m = e.message;
  const offset = /offset (\d+)/.exec(m);
  const at = offset ? Number(offset[1]) : undefined;
  if (/unexpected end/i.test(m)) return structuralHints({ kind: "unexpected_eof", message: m, offset: at }, inputBytes);
  if (/trailing/i.test(m)) return structuralHints({ kind: "trailing_data", message: m, offset: at }, inputBytes);
  if (/break/i.test(m)) return structuralHints({ kind: "unexpected_break", message: m, offset: at }, inputBytes);
  if (/utf-?8/i.test(m)) return structuralHints({ kind: "invalid_utf8", message: m, offset: at }, inputBytes);
  if (/hex/i.test(m)) return structuralHints({ kind: "invalid_hex", message: m }, inputBytes);
  if (/chunk/i.test(m)) return structuralHints({ kind: "invalid_chunk", message: m, offset: at }, inputBytes);
  return [`The bytes are not well-formed CBOR${at !== undefined ? ` at offset ${at}` : ""}: ${m}.`];
}

/**
 * Hints for one validator row. `isHead`: the row is the head error (`errors[0]`) — only the head
 * may speak about the root item as a whole; a `from_type_choice` sibling (what another alternative
 * of a choice wanted) contributes no container-kind or "wrong object" hints, since the head already
 * names the real fault and the sibling would contradict it.
 */
function mismatchHints(e: HintError, ctx: HintContext, isHead = true): string[] {
  const out: string[] = [];
  const expected = e.expected ?? "";
  const msg = e.message;
  const gotTag = CONSTRUCTOR_TAG.exec(msg);
  const gotTagNumber = gotTag ? Number(gotTag[1]) : null;
  const isRoot = e.path === "$" && isHead;
  const speculative = !isHead && e.from_type_choice === true;
  const era = ctx.era ?? null;

  // Conway set tag 258
  if (/#6\.258/.test(expected) && /got (indefinite )?array/.test(msg)) {
    out.push("The schema wants a Conway set (`#6.258([* a])`) and found a plain array: sets are tagged 258 from Conway on (pre-Conway eras use bare arrays) — check the era preset and the encoder's set tagging.");
  }
  if (gotTagNumber === 258 && !/258/.test(expected)) {
    out.push(
      `The bytes carry the Conway set tag 258 but this ${era && era !== "conway" && era !== "dijkstra" ? `${era} schema` : "rule"} does not allow it here${era && era !== "conway" && era !== "dijkstra" ? ": validate with cddl='conway' (or newer), or the encoder must emit plain arrays for this era" : ": a set was written where the rule wants a plain array"}.`,
    );
  }

  // PlutusData constructor tags
  if (gotTagNumber !== null && gotTagNumber !== 258 && /#6\.12[1-7]|constr|plutus_data/.test(expected)) {
    if (gotTagNumber >= 1280 && gotTagNumber <= 1400) {
      out.push(
        `Tag ${gotTagNumber} is PlutusData constructor ${constructorIndexOf(gotTagNumber)} (tags 1280-1400 encode constructors 7-127); the era CDDL's constr rule lists only 121-127 and the general form #6.102([index, fields]), so this is a schema over-approximation, not necessarily a fault of the bytes — the ledger accepts it.`,
      );
    } else if (!isPlutusConstructorTag(gotTagNumber)) {
      out.push(`Tag ${gotTagNumber} is not a PlutusData constructor: constructors 0-6 are tags 121-127, 7-127 are 1280-1400, anything else uses #6.102([index, fields]).`);
    }
  } else if (!speculative && gotTagNumber !== null && isPlutusConstructorTag(gotTagNumber) && gotTagNumber !== 102 && !/#6\.12[1-7]|constr|plutus_data|any/.test(expected)) {
    out.push(`The item is a PlutusData constructor (tag ${gotTagNumber} = constructor ${constructorIndexOf(gotTagNumber)}) where the rule wants ${expected || "something else"}: a datum / redeemer blob stands where a ledger structure belongs (or the wrong rule was picked — plutus_data would accept it).`);
  }

  // bounded_bytes: every bstr in plutus_data is bounded to 64 bytes — a definite string as a whole,
  // an indefinite-length string per chunk (the ledger's rule, which the validator applies)
  const DEFINITE_OVER_64 = "A definite byte string longer than 64 bytes inside plutus_data: the node rejects it (`bounded_bytes` is 0..64) — encode long values as an indefinite-length string of definite chunks of at most 64 bytes (`5f 5840 <64 bytes> 4x <rest> ff`), which is what the reference encoders emit.";
  const chunkOver64 = (chunk?: string, length?: string) =>
    `An indefinite-length byte string inside plutus_data has a chunk over 64 bytes${length ? ` (chunk ${chunk}: ${length} bytes)` : ""}: the ledger bounds EACH chunk of a chunked \`bounded_bytes\` to 64 bytes (a chunked string of ≤ 64-byte chunks of any total length is accepted) — re-chunk the value into definite chunks of at most 64 bytes (\`5f 5840 <64 bytes> 4x <rest> ff\`).`;
  // `.size (0..64)` is bounded_bytes in an era schema (or a rule that names it); in a user schema it is an ordinary size bound
  const plutusContext = era !== null || /bounded_bytes|plutus_data/.test(`${e.cddl_fragment ?? ""} ${ctx.rule ?? ""}`);
  const boundedLength = plutusContext ? BOUNDED_BYTES_LENGTH.exec(msg) : null;
  const boundedChunk = plutusContext ? BOUNDED_BYTES_CHUNK.exec(msg) : null;
  if (boundedChunk) out.push(chunkOver64(boundedChunk[2], boundedChunk[1]));
  else if (boundedLength) out.push(DEFINITE_OVER_64);
  else if (/#6\.12[1-7]|bounded_bytes|plutus_data|big_u?int|big_nint/.test(expected)) {
    if (CHUNKED_BYTES.test(msg)) out.push(chunkOver64());
    else if (OVERLONG_BYTES.test(msg)) out.push(DEFINITE_OVER_64);
  }

  // an embedded `.cbor` payload (inline datum, script_ref, aux data) that is not well-formed CBOR
  const embedded = EMBEDDED_CBOR.exec(msg);
  if (embedded && !speculative) {
    out.push(
      `The bytes inside a \`.cbor\` wrapper (an inline datum / script_ref / encoded-CBOR payload, tag 24 around a byte string) are not well-formed CBOR: ${embedded[1]!.replace(/\.$/, "")} — decode the wrapped byte string on its own (cbor_decode(as='raw') on the hex of the bstr content) to see where it breaks; the wrapper's length prefix must cover exactly one CBOR item.`,
    );
  }

  // container kind
  const wantsMap = /^(map|\{)/.test(expected) || /^expected (indefinite )?map/.test(msg);
  const wantsArray = /^(array|\[)/.test(expected) || /^expected (indefinite )?array/.test(msg);
  const gotMap = /got (indefinite )?map\(/.test(msg);
  const gotArray = /got (indefinite )?array\(/.test(msg);
  const emptyArray = EMPTY_ARRAY.test(msg);
  const wantsTag = /^tagged data #6\.\d+/.test(expected);
  if (speculative) {
    // a choice sibling's container kind says nothing about the document
  } else if (emptyArray && (wantsMap || wantsTag)) {
    out.push(
      `An empty array (80) was found where the rule wants ${wantsMap ? "a map (`{}` = a0)" : "a tagged item"}: an empty witness set / body / metadata map was encoded as a list, or an item is missing its wrapper — compare the byte at the offset with ${wantsMap ? "a0" : "the tag's header"}.`,
    );
  } else if (wantsMap && gotArray) {
    out.push(
      isRoot
        ? `The root item is an array but the rule wants a map: a transaction is [body, witness_set, is_valid, aux_data] (array) while transaction_body and transaction_witness_set are maps; legacy transaction outputs are arrays, post-Alonzo outputs maps — the bytes are probably a different object (omit rule, or run cbor_decode as='auto').`
        : "A map was expected but an array was found: the item uses an array shape where this era wants the map form (e.g. a legacy [address, amount] output where a post-Alonzo output map is required), or a body / witness set was written as a list.",
    );
  } else if (wantsArray && gotMap) {
    const redeemers = /redeemer/.test(expected);
    if (isRoot) {
      out.push("The root item is a map but the rule wants an array: a body or witness set (map) was given where a whole transaction [body, witness_set, is_valid, aux_data] was expected — try rule='transaction_body' / 'transaction_witness_set', or omit rule.");
    } else if (redeemers && era !== "conway" && era !== "dijkstra") {
      out.push("Redeemers in the Conway map form ({[tag, index] => [data, ex_units]}) where this schema only has the array form [* [tag, index, data, ex_units]]: validate with cddl='conway' (or newer), or encode the array form for a pre-Conway era.");
    } else if (!redeemers) {
      out.push("An array was expected but a map was found: a post-Alonzo output map where a legacy array output is required, or an item wrapped in a map by mistake.");
    }
    // redeemers under Conway: the map form was tried as well; the rows under the map say why it failed
  }

  // text where bytes expected / a hex string encoded as text
  const hexText = HEX_TEXT.exec(msg);
  const wantsBytes = /^(bstr|bytes|h')/.test(expected) || /bounded_bytes|hash|address|_script|policy_id|asset_name/.test(expected);
  if (wantsBytes) {
    if (hexText) out.push(`A hex string was encoded as CBOR text (major type 3) instead of the bytes it spells (major type 2): decode "${hexText[1]!.slice(0, 16)}…" from hex before encoding it.`);
    else if (/got text/.test(msg)) out.push("Bytes were expected but a text string was found: encode the raw bytes as a byte string (major type 2).");
  } else if (hexText && !speculative) {
    const digits = hexText[1]!.replace(/…$/, "");
    const spelled = hexText[1]!.endsWith("…") ? "" : ` (${digits.length / 2} bytes${digits.length === 56 ? ": a key / script hash" : digits.length === 64 ? ": a transaction id / datum hash / vkey" : digits.length === 114 ? ": an address" : ""})`;
    out.push(
      `The item is a text string spelling hex${spelled}: almost certainly a byte string encoded as CBOR text (major type 3 instead of 2) — decode "${digits.slice(0, 16)}…" from hex before encoding it; the rule picked here wants ${expected || "something else"}, so the field may also be misplaced.`,
    );
  }

  // .size on strings: `expected byte string of size 28 bytes, got 27 bytes` /
  // `expected byte string length to be in the range 28 <= value <= 32, got 27` (text: UTF-8 bytes)
  const sizeExact = /^expected (byte|text) string of size (\d+) bytes, got (\d+) bytes$/.exec(msg);
  const sizeRange = !boundedLength && !boundedChunk ? /^expected (byte|text) string length to be in the range (\d+) <= value <= (\d+), got (\d+)$/.exec(msg) : null;
  if (sizeExact || sizeRange) {
    const kind = (sizeExact ?? sizeRange)![1];
    const want = sizeExact ? sizeExact[2]! : `${sizeRange![2]}..${sizeRange![3]}`;
    const got = sizeExact ? sizeExact[3]! : sizeRange![4]!;
    out.push(
      kind === "byte"
        ? `Byte string of the wrong length: ${got} bytes where ${want} are required (28 = key / script hash / policy id, 32 = transaction id / datum hash / script data hash / vkey, 57 or 29 = address).`
        : `Text string of the wrong length: ${got} UTF-8 bytes where ${want} are required (the rule's .size counts bytes, not characters).`,
    );
  }
  // a chunk over the `.size` upper bound of a user schema's rule named `bounded_bytes` (the only rule
  // whose upper bound the validator applies per chunk, as the ledger does for Plutus bytes; every
  // other `.size` measures the whole string)
  const chunkRange = !boundedChunk ? /^expected each chunk of the indefinite-length (byte|text) string to be (at most|fewer than) (\d+) bytes, got (\d+) bytes in chunk (\d+)$/.exec(msg) : null;
  if (chunkRange) out.push(`Chunk ${chunkRange[5]} of an indefinite-length ${chunkRange[1]} string is ${chunkRange[4]} bytes where ${chunkRange[2]} ${chunkRange[3]} are allowed: under a rule named \`bounded_bytes\` the upper bound of \`.size\` holds each chunk (the ledger's Plutus rule; any other \`.size\` measures the whole string) — re-chunk, or use a definite-length string.`);
  // metadatum strings: `bytes .size (0..64) / text .size (0..64)` bound the WHOLE string, chunked or not
  // (the ledger concatenates the chunks first), so a byte / text string fails a metadatum only by length
  if (/metadatum/.test(expected) && (CHUNKED_BYTES.test(msg) || OVERLONG_BYTES.test(msg) || /got text "/.test(msg))) {
    out.push("A metadatum byte / text string holds at most 64 bytes in total (text: UTF-8 bytes), and an indefinite-length string counts all its chunks together (unlike plutus_data's `bounded_bytes`, bounded per chunk) — split a longer value into a list of ≤ 64-byte strings.");
  }
  // .size on integers: `expected value .size 2, got 65536`
  const intSize = /^expected value \.size (\d+), got (-?\d+)$/.exec(msg);
  if (intSize) out.push(`The integer ${intSize[2]} does not fit ${intSize[1]} byte(s) (uint .size ${intSize[1]} = 0 .. 2^${8 * Number(intSize[1])} - 1): the value overflows the field, or a different field's value landed here.`);

  // integers
  if (/^(uint|coin|int64|int)\b/.test(expected) && /got #6\.[23]\(/.test(msg)) {
    out.push("A bignum (tag 2 / 3) was found where a native integer is expected: the value overflows the field, or the encoder emits bignums for small values (see the BignumForSmallInt oddity) — write integers up to 2^64-1 as plain major type 0 / 1.");
  } else if (/^(uint|coin)\b/.test(expected) && /got -\d/.test(msg)) {
    out.push("A negative integer was found where an unsigned one is required: an amount / index / slot cannot be negative — check the encoder's sign, or the field ordering.");
  } else if (/in range/.test(expected)) {
    out.push("The integer is outside the range the rule allows (e.g. int64 for a fee, uint .size 4 for a block body size): the value overflows the field, or a different field's value landed here.");
  }

  // map keys
  const unexpectedKey = /unexpected key (.+)$/.exec(msg);
  if (unexpectedKey) {
    const key = unexpectedKey[1]!;
    const bySchema = `by the rule${era ? ` of the ${era} schema` : ""}`;
    if (/^-?\d+$/.test(key)) {
      // integer keys are where the eras differ (body, witness set, auxiliary data)
      out.push(`Key ${key} is not allowed in this map ${bySchema}: newer eras add keys (Conway body keys 19-22 voting_procedures / proposal_procedures / current_treasury_value / donation; witness keys 6 / 7 for PlutusV2 / V3 scripts) — check the era preset, or the key is misplaced / mistyped.`);
    } else if (/^\[\d+, \d+\]$/.test(key) && (/redeemer/.test(e.cddl_fragment ?? "") || /\[5\]\[\[\d+, \d+\]\]$/.test(e.path ?? ""))) {
      // the Conway map form of redeemers is checked entry by entry: only a bad [tag, index] key lands here
      out.push(`Redeemer key ${key} is not a valid [tag, index]: tag 0 spend, 1 mint, 2 cert, 3 reward, 4 voting, 5 proposing (4-5 from Conway), index a uint of at most 4 bytes — the map form itself is fine; fix the key, or drop the redeemer.`);
    } else {
      out.push(`Key ${key} is not allowed in this map ${bySchema}: no entry of the map's rule (cddl_fragment) accepts a key of this value / type — the key is misplaced, mistyped, or encoded with the wrong CBOR type.`);
    }
  }
  const missingKey = /missing key:? (.+)$/.exec(msg);
  if (missingKey) {
    out.push(`Required map key ${missingKey[1]} is missing: the rule marks it mandatory (no \`?\`) — e.g. a transaction_body needs 0 (inputs), 1 (outputs) and 2 (fee).`);
  }

  // indefinite length
  if (/indefinite/.test(msg) && !/indefinite/.test(expected) && /\.size|definite/.test(expected)) {
    out.push("An indefinite-length item (header 9f / bf / 5f / 7f … ff) where the rule needs a definite length: canonical encoders emit definite lengths.");
  }

  return out;
}

/** Deduplicated, capped hint list for one diagnosis. */
export function hintsFor(ctx: HintContext): string[] {
  const hints: string[] = [];
  const push = (list: string[]) => {
    for (const h of list) if (h && !hints.includes(h)) hints.push(h);
  };

  if (ctx.structural) push(structuralHints(ctx.structural, ctx.inputBytes));

  const errors = ctx.errors ?? [];
  for (const [index, e] of errors.entries()) {
    if (e.kind === "input_parse") push(inputParseHints(e, ctx.inputBytes));
    else if (e.kind === "mismatch" || e.kind === "map_cut" || e.kind === "generic") push(mismatchHints(e, ctx, index === 0));
    else if (e.kind === "missing_rule") push(["The rule name is not declared by the schema (names are case-sensitive): cddl_check(cddl) lists the declared roots, or omit rule to let the tool pick candidates."]);
    else if (e.kind === "group_rule_root") push(["The rule names a group `( … )`, which describes entries inside a container rather than a standalone item: validate against the type rule that uses the group."]);
    else if (e.kind === "nesting_too_deep" || e.kind === "validation_too_complex") push(["The validator stopped at an implementation limit (nesting depth or work budget): the bytes were not judged invalid — validate a smaller part (a sub-rule, or a slice of the bytes)."]);
    else if (e.kind === "parse_error" || e.kind === "unresolved_references" || e.kind === "no_rules" || e.kind === "invalid_schema") push(["The schema itself is not usable: run cddl_check(cddl) for the line / column of the fault."]);
    if (hints.length >= MAX_HINTS) break;
  }

  // oddities (encoding facts, whatever the verdict)
  const kinds = new Set((ctx.oddities ?? []).map((o) => o.kind));
  if (kinds.has("MapKeysNotSorted")) push(["Map keys are not in canonical order (bytewise lexicographic order of the encoded keys, RFC 8949 §4.2.1: `1818` sorts before `20`, a short key is not automatically first): the ledger accepts this, but hashes over a canonical re-encoding (tx id, script_data_hash, datum hashes) differ from the original bytes — always hash the exact bytes, never a re-encoding."]);
  if (kinds.has("DuplicateMapKeys")) push(["Duplicate map keys: the same key is encoded twice; the ledger rejects (or silently keeps one of) repeated keys — the encoder wrote a field twice."]);
  if (kinds.has("BignumForSmallInt")) push(["A tag 2 / 3 bignum wraps a value that fits a native integer: valid CBOR but non-canonical; ledger fields typed uint / int reject bignums outright."]);
  if (kinds.has("BignumLeadingZeroes")) push(["A bignum has leading zero bytes: non-canonical; strip them (the ledger and hashing tools expect the minimal form)."]);
  if (kinds.has("IntNotShortest") || kinds.has("FloatNotShortest")) push(["Some integers / floats are not in their shortest form (e.g. 18 05 for 5): valid CBOR, but any canonical re-encoding changes the bytes and thus every hash computed over them."]);
  if (kinds.has("IndefiniteLength")) push(["Indefinite-length items are present (9f / bf / 5f / 7f … ff): fine for the ledger's decoders in most places, but hashes of a canonical re-encoding will not match, and some consumers (hardware wallets, strict CDDL rules) demand definite lengths."]);

  // probes
  for (const hex of ctx.byteStrings ?? []) {
    if (looksDoubleWrappedScript(hex)) {
      push(["A byte string contains another CBOR byte string that wraps a flat Plutus program (01 00 00 …): the script is double-wrapped — ledger script fields carry exactly one wrap, and a cardano-cli envelope's cborHex already includes it, so do not wrap it again."]);
      break;
    }
  }

  // candidate search outcome (judged on the head row only: a choice sibling at `$` is not a root refusal)
  if (ctx.candidates && !ctx.candidates.anyValid) {
    const head = errors[0];
    if (ctx.candidates.tried === 0) push([`No root rule of the schema accepts a ${ctx.rootKind ?? "document of this kind"} at the root: the bytes are a different object or era — cbor_decode(as='auto') lists which typed ledger decoders accept them.`]);
    else if (head && head.kind === "mismatch" && head.path === "$" && !/with length \d+, got|must have/.test(head.message)) push([`None of the ${ctx.candidates.tried} candidate roots accepts the root item as a whole: the bytes are probably a different object (or era) — cbor_decode(as='auto') lists the typed ledger decoders that accept them.`]);
  }
  if (ctx.rootKind === "bytes" && ctx.candidates?.anyValid) push(["The root is a bare byte string: many bstr rules accept it, so a match says little — decode its content (cbor_decode) to see what it is (a script, an address, a hash, embedded CBOR)."]);

  return hints.slice(0, MAX_HINTS);
}
