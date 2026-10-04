// Script identity for script_decompile: exactly one of
//   script            — bytes in any wrapping (hex / base64 / cli envelope / ScriptRef)
//   dbg_id            — the script of a live debug session (SessionRecord.partsConfig.script)
//   tx_id+script_hash — a script the loaded transaction carries (witness, inline output, resolved
//                       reference input, or the validation's EvalRedeemerResult.script_bytes)
//   script_hash+network — the chain layer's lookup hook (`ctx.services.scriptSource`), else every
//                       loaded transaction is searched; otherwise a clear error.
// The script hash is always computed / verified through the lib (blake2b-224 over tag || single-wrapped).

import type { AppContext } from "../context.js";
import { isNetwork, type Network } from "../config.js";
import { isUplcText } from "../engine/parts.js";
import type { LibApi } from "../lib.js";
import { expiredHandleError } from "../store/sessionRegistry.js";
import type { TxRecord } from "../store/txStore.js";
import { fail, ToolInputError, type ToolResult } from "../tools/_shared.js";
import { parsePurpose, purposeFromLibTag, type Purpose } from "../vocab/purpose.js";
import { WorkerCallError } from "../workers/rpc.js";
import {
  isPlutusVersion,
  normalizeScriptInput,
  parsePlutusVersion,
  plutusVersionNumber,
  ScriptBytesError,
  unwrapScriptHex,
  type NormalizedScript,
  type PlutusVersion,
  type ScriptWrapping,
} from "./scriptBytes.js";
import { lookupTxRecord } from "../tx/record.js";

/** Chain lookup of script bytes by hash. The chain layer attaches an implementation under `ctx.services.scriptSource`. */
export interface ScriptSourceHook {
  fetchScriptByHash(
    network: Network,
    scriptHash: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ hex: string; plutus_version?: string; source?: string } | undefined>;
}

declare module "../context.js" {
  interface AppServices {
    scriptSource?: ScriptSourceHook;
  }
}

export interface ResolveScriptArgs {
  script?: string;
  dbg_id?: string;
  tx_id?: string;
  script_hash?: string;
  network?: string;
  plutus_version?: string;
  purpose?: string;
  signal?: AbortSignal;
}

export type VersionDecision =
  | "given"
  | "from_tx"
  | "from_session"
  | "from_chain"
  | "from_envelope"
  | "from_script_ref"
  | "header_v3"
  | "assumed_v2";

export type PurposeDecision = "given" | "from_tx" | "from_session" | "auto";

export interface ResolvedScript {
  /** CBOR bytes(flat) — the decompiler input and the hashed form. */
  singleHex: string;
  flatHex: string;
  sizeBytes: number;
  wrapping: ScriptWrapping;
  scriptHash: string;
  /** When the header leaves V1/V2 open and nothing pinned it: the hash under the other reading. */
  alternativeHashes?: Partial<Record<PlutusVersion, string>>;
  version: PlutusVersion;
  /** Pass the version to the decompiler only when it is certain. */
  versionCertain: boolean;
  versionDecision: VersionDecision;
  purpose?: Purpose;
  purposeDecision: PurposeDecision;
  source: { kind: "inline" | "tx" | "session" | "chain"; detail: string };
  /** Set when a script_hash was requested: whether the bytes hash to it. */
  hashVerified?: boolean;
}

export type ResolveScriptResult = { ok: true; script: ResolvedScript } | { ok: false; result: ToolResult };

interface Located {
  hex: string;
  version?: PlutusVersion;
  purpose?: Purpose;
  detail: string;
}

const HASH_PATTERN = /^[0-9a-f]{56}$/;

/** blake2b-224(tag || single-wrapped) through the lib (which normalises any wrapping itself). */
export async function hashScript(lib: LibApi, singleHex: string, version: PlutusVersion, signal?: AbortSignal): Promise<string> {
  let answer: { script_hash?: unknown } | undefined;
  try {
    answer = await lib.call<{ script_hash?: unknown }>(
      "decode_specific_type",
      [singleHex, "PlutusScript", { plutus_script_version: plutusVersionNumber(version) }],
      // Scripts are at most a few hundred KB on chain; the cap only matters for pasted giants.
      { signal, maxInputBytes: Math.max(4 * 1024 * 1024 + 1024, singleHex.length + 1024) },
    );
  } catch (error) {
    if (error instanceof WorkerCallError && !error.fatal) {
      throw new ToolInputError(`The bytes do not decode as a Plutus script (${error.message}). Pass compiled script bytes: flat, CBOR-wrapped, a cardano-cli envelope or a ScriptRef.`, "script");
    }
    throw error;
  }
  const hash = answer?.script_hash;
  if (typeof hash !== "string" || !HASH_PATTERN.test(hash.toLowerCase())) {
    throw new Error("The library did not return a script hash for these bytes.");
  }
  return hash.toLowerCase();
}

function normalizeHashArg(value: string): string {
  const hash = value.trim().toLowerCase().replace(/^0x/, "");
  if (!HASH_PATTERN.test(hash)) throw new ToolInputError(`script_hash must be 28 bytes of hex (56 characters), got ${JSON.stringify(value)}.`, "script_hash");
  return hash;
}

export async function resolveScript(ctx: AppContext, args: ResolveScriptArgs): Promise<ResolveScriptResult> {
  const given = [args.script && "script", args.dbg_id && "dbg_id", args.tx_id && "tx_id"].filter(Boolean) as string[];
  if (given.length > 1) {
    throw new ToolInputError(`Pass exactly one script identity: ${given.join(", ")} were all given. Use script (bytes), dbg_id (session), tx_id+script_hash (loaded tx) or script_hash+network (chain).`, given[1]);
  }
  let givenVersion: PlutusVersion | undefined;
  if (args.plutus_version !== undefined) {
    givenVersion = parsePlutusVersion(args.plutus_version);
    if (!givenVersion) throw new ToolInputError(`plutus_version must be V1, V2 or V3 (got ${JSON.stringify(args.plutus_version)}).`, "plutus_version");
  }
  let givenPurpose: Purpose | undefined;
  if (args.purpose !== undefined && args.purpose.trim() !== "") {
    givenPurpose = parsePurpose(args.purpose);
    if (!givenPurpose) throw new ToolInputError(`purpose must be one of spend, mint, withdraw, publish, vote, propose (aliases cert/certificate/reward accepted; got ${JSON.stringify(args.purpose)}).`, "purpose");
  }
  const wantedHash = args.script_hash !== undefined ? normalizeHashArg(args.script_hash) : undefined;

  let located: Located;
  let kind: ResolvedScript["source"]["kind"];
  let decision: VersionDecision | undefined;

  if (args.script !== undefined) {
    kind = "inline";
    located = { hex: args.script, detail: "script argument" };
  } else if (args.dbg_id !== undefined) {
    kind = "session";
    const found = fromSession(ctx, args.dbg_id.trim());
    if (!found.ok) return found;
    located = found.located;
    decision = "from_session";
  } else if (args.tx_id !== undefined) {
    kind = "tx";
    if (!wantedHash) throw new ToolInputError("With tx_id also pass script_hash (see tx_inspect section='scripts' or 'redeemers').", "script_hash");
    const record = await lookupTxRecord(ctx, args.tx_id);
    if (!record) return { ok: false, result: expiredHandleError(args.tx_id.trim(), "tx_load") };
    const found = await fromTxRecord(ctx.lib, record, wantedHash, args.signal);
    if (isNative(found)) return { ok: false, result: notPlutus(wantedHash, found.detail, { tx_id: record.txId }) };
    if (!found) {
      return {
        ok: false,
        result: fail({
          code: "script_not_found",
          message: `${record.txId} does not carry script ${wantedHash} (not in its witness set, inline outputs, resolved reference inputs or validation results). ` +
            `Check tx_inspect section='scripts'; if the script lives in a reference input, run tx_load / tx_validate first so the UTxOs are resolved, or pass the bytes via script.`,
          tx_id: record.txId,
          script_hash: wantedHash,
          available: record.scripts.map((s) => ({ script_hash: s.script_hash, plutus_version: s.plutus_version, source: s.source, has_bytes: Boolean(s.hex) })),
        }),
      };
    }
    located = found;
    decision = "from_tx";
  } else if (wantedHash) {
    const found = await fromAnywhere(ctx, wantedHash, args.network, args.signal);
    if (!found.ok) return found;
    kind = found.kind;
    located = found.located;
    decision = found.decision;
  } else {
    throw new ToolInputError("Identify the script: script (hex in any wrapping), dbg_id, tx_id + script_hash, or script_hash + network.", "script");
  }

  let normalized: NormalizedScript;
  try {
    normalized = kind === "inline" ? normalizeScriptInput(located.hex) : { ...unwrapScriptHex(located.hex), inputKind: "hex" };
  } catch (error) {
    if (error instanceof ScriptBytesError) throw new ToolInputError(error.message, "script");
    throw error;
  }

  // Version: caller > carrier (tx / session / chain / envelope / ScriptRef) > flat header.
  let version: PlutusVersion;
  let versionCertain = true;
  let versionDecision: VersionDecision;
  if (givenVersion) {
    version = givenVersion;
    versionDecision = "given";
  } else if (located.version && decision) {
    version = located.version;
    versionDecision = decision;
  } else if (normalized.statedVersion) {
    version = normalized.statedVersion;
    versionDecision = normalized.wrapping === "script_ref" ? "from_script_ref" : "from_envelope";
  } else if (normalized.headerVersion === "V3") {
    version = "V3";
    versionDecision = "header_v3";
  } else {
    version = "V2";
    versionCertain = false;
    versionDecision = "assumed_v2";
  }
  if (normalized.headerVersion === "V3" && version !== "V3") {
    // The flat header says (1,1,_): only V3 reads it. Trust the bytes over a stale label.
    version = "V3";
    versionDecision = "header_v3";
    versionCertain = true;
  }

  const scriptHash = await hashScript(ctx.lib, normalized.singleHex, version, args.signal);
  const resolved: ResolvedScript = {
    singleHex: normalized.singleHex,
    flatHex: normalized.flatHex,
    sizeBytes: normalized.sizeBytes,
    wrapping: normalized.wrapping,
    scriptHash,
    version,
    versionCertain,
    versionDecision,
    purpose: givenPurpose ?? located.purpose,
    purposeDecision: givenPurpose ? "given" : located.purpose ? (kind === "session" ? "from_session" : "from_tx") : "auto",
    source: { kind, detail: located.detail },
  };
  if (!versionCertain) {
    const other: PlutusVersion = version === "V2" ? "V1" : "V2";
    resolved.alternativeHashes = { [other]: await hashScript(ctx.lib, normalized.singleHex, other, args.signal) };
  }
  if (wantedHash) {
    if (scriptHash === wantedHash) resolved.hashVerified = true;
    else if (resolved.alternativeHashes && Object.values(resolved.alternativeHashes).includes(wantedHash)) {
      // The other V1/V2 reading matches: pin it.
      const pinned = (Object.entries(resolved.alternativeHashes).find(([, h]) => h === wantedHash)?.[0] ?? version) as PlutusVersion;
      resolved.version = pinned;
      resolved.versionCertain = true;
      resolved.versionDecision = kind === "chain" ? "from_chain" : "from_tx";
      resolved.scriptHash = wantedHash;
      delete resolved.alternativeHashes;
      resolved.hashVerified = true;
    } else {
      resolved.hashVerified = false;
    }
  }
  return { ok: true, script: resolved };
}

// ---------- sources ----------

function fromSession(ctx: AppContext, dbgId: string): { ok: true; located: Located } | { ok: false; result: ToolResult } {
  const record = ctx.sessions.get(dbgId);
  if (!record) return { ok: false, result: expiredHandleError(dbgId, "debug_open") };
  const { script, program } = record.partsConfig;
  // A session opened from UPLC text keeps that text (as `program` in program mode, as `script` in
  // parts mode: debug_open(script="(program …", context=…)): it carries no compiled bytes either way.
  const bytes = typeof script === "string" && script.length > 0 ? script : undefined;
  if (bytes === undefined || isUplcText(bytes)) {
    const fromText = bytes !== undefined || (typeof program === "string" && isUplcText(program));
    return {
      ok: false,
      result: fail({
        code: "no_script_bytes",
        message:
          `Session ${dbgId} was opened from ${fromText ? "UPLC source text" : "a configuration without compiled script bytes"}, so there are no compiled script bytes to decompile. ` +
          "Pass the compiled script (hex in any wrapping, cardano-cli envelope or ScriptRef) via script. The session's own UPLC is readable with debug_source(dbg_id) and as the session uplc.txt resource.",
        dbg_id: dbgId,
        mode: record.mode,
        argument: "script",
        next: ["script_decompile(script=<compiled script hex>)", "debug_source(dbg_id) lists the session's UPLC"],
      }),
    };
  }
  const language = parsePlutusVersion(record.language) ?? parsePlutusVersion(typeof record.partsConfig.language === "string" ? record.partsConfig.language : undefined);
  return { ok: true, located: { hex: bytes, version: language, purpose: record.purpose, detail: `${dbgId} (${record.mode} session${record.txId ? `, ${record.txId}` : ""}${record.redeemer ? ` ${record.redeemer}` : ""})` } };
}

/** Purposes of the redeemers that point at `scriptHash` in a loaded tx (from the decoded tx and, when present, the validation). */
function purposeInTx(record: TxRecord, scriptHash: string): Purpose | undefined {
  const purposes = new Set<Purpose>();
  for (const target of record.redeemerTargets) if (target.script_hash === scriptHash) purposes.add(target.purpose);
  if (purposes.size === 0 && record.validation) {
    for (const [, result] of record.validation.redeemers) {
      const hex = result.script_bytes;
      if (typeof hex !== "string") continue;
      const known = (record.extra.scriptHashByBytes as Record<string, string> | undefined)?.[hex];
      if (known === scriptHash) {
        try {
          purposes.add(purposeFromLibTag(result.tag));
        } catch {
          // unknown tag: ignore
        }
      }
    }
  }
  return purposes.size === 1 ? Array.from(purposes)[0] : undefined;
}

/** A native (multisig / timelock) script was found under the hash: there is no Plutus program to decompile. */
interface NativeFound {
  native: true;
  detail: string;
}

function isNative(found: Located | NativeFound | undefined): found is NativeFound {
  return found !== undefined && "native" in found;
}

function notPlutus(scriptHash: string, detail: string, extra: Record<string, unknown> = {}): ToolResult {
  return fail({
    code: "not_plutus",
    message:
      `Script ${scriptHash} (${detail}) is a native script: a multisig / timelock rule set with no Plutus program, so there is nothing to decompile. ` +
      "Read it as it is: tx_inspect(section='scripts') lists it, cbor_decode(hex, as='NativeScript') decodes its rules.",
    script_hash: scriptHash,
    ...extra,
  });
}

async function fromTxRecord(lib: LibApi, record: TxRecord, scriptHash: string, signal?: AbortSignal): Promise<Located | NativeFound | undefined> {
  // 1. Witness / inline output scripts (hash known from the tx).
  const nativeOwn = record.scripts.find((s) => s.script_hash === scriptHash && s.plutus_version === "native");
  if (nativeOwn) return { native: true, detail: `${record.txId} ${nativeOwn.source}` };
  const own = record.scripts.find((s) => s.script_hash === scriptHash && s.hex);
  if (own) {
    return { hex: own.hex!, version: isPlutusVersion(own.plutus_version) ? own.plutus_version : undefined, purpose: purposeInTx(record, scriptHash), detail: `${record.txId} ${own.source} script` };
  }
  // 2. Resolved UTxOs of the validation context (reference scripts).
  const utxoSet = (record.validationContext as { utxoSet?: unknown } | undefined)?.utxoSet;
  if (Array.isArray(utxoSet)) {
    for (const row of utxoSet) {
      const output = (row as { utxo?: { input?: { txHash?: string; outputIndex?: number }; output?: { scriptRef?: string | null; scriptHash?: string | null } } })?.utxo;
      const out = output?.output;
      if (!out || typeof out.scriptRef !== "string") continue;
      if (typeof out.scriptHash === "string" && out.scriptHash.toLowerCase() !== scriptHash) continue;
      // `82 00 <native script>`: a native reference script under this hash.
      if (typeof out.scriptHash === "string" && out.scriptRef.toLowerCase().startsWith("8200")) {
        return { native: true, detail: `${record.txId} reference input ${output?.input?.txHash ?? "?"}#${output?.input?.outputIndex ?? "?"}` };
      }
      let shaped;
      try {
        shaped = unwrapScriptHex(out.scriptRef);
      } catch {
        continue;
      }
      const candidates: PlutusVersion[] = shaped.statedVersion ? [shaped.statedVersion] : shaped.headerVersion === "V3" ? ["V3"] : ["V2", "V1"];
      for (const version of candidates) {
        if (typeof out.scriptHash === "string" || (await hashScript(lib, shaped.singleHex, version, signal)) === scriptHash) {
          return { hex: shaped.singleHex, version, purpose: purposeInTx(record, scriptHash), detail: `${record.txId} reference input ${output?.input?.txHash ?? "?"}#${output?.input?.outputIndex ?? "?"}` };
        }
      }
    }
  }
  // 3. EvalRedeemerResult.script_bytes of a validation run.
  if (record.validation) {
    const byBytes = (record.extra.scriptHashByBytes ??= {}) as Record<string, string>;
    for (const [ref, result] of record.validation.redeemers) {
      const hex = result.script_bytes;
      if (typeof hex !== "string" || hex.length === 0) continue;
      const version = parsePlutusVersion(result.plutus_version ?? undefined);
      let hash = byBytes[hex];
      if (!hash) {
        try {
          const shaped = unwrapScriptHex(hex);
          hash = await hashScript(lib, shaped.singleHex, version ?? (shaped.headerVersion === "V3" ? "V3" : "V2"), signal);
          byBytes[hex] = hash;
        } catch {
          continue;
        }
      }
      if (hash === scriptHash) {
        let purpose: Purpose | undefined;
        try {
          purpose = purposeFromLibTag(result.tag);
        } catch {
          purpose = undefined;
        }
        return { hex, version, purpose, detail: `${record.txId} validation of ${ref}` };
      }
    }
  }
  return undefined;
}

async function fromAnywhere(
  ctx: AppContext,
  scriptHash: string,
  networkArg: string | undefined,
  signal?: AbortSignal,
): Promise<{ ok: true; located: Located; decision: VersionDecision; kind: "tx" | "chain" } | { ok: false; result: ToolResult }> {
  let network: Network | undefined;
  if (networkArg !== undefined) {
    if (!isNetwork(networkArg)) throw new ToolInputError(`network must be one of mainnet, preprod, preview (got ${JSON.stringify(networkArg)}).`, "network");
    network = networkArg;
  }
  // Every loaded transaction first (free).
  for (const record of ctx.txStore.list()) {
    if (network && record.network !== network) continue;
    const found = await fromTxRecord(ctx.lib, record, scriptHash, signal);
    if (isNative(found)) return { ok: false, result: notPlutus(scriptHash, found.detail, { tx_id: record.txId }) };
    if (found) return { ok: true, located: found, decision: "from_tx", kind: "tx" };
  }
  const hook = ctx.services.scriptSource;
  if (hook && network) {
    const answer = await hook.fetchScriptByHash(network, scriptHash, { signal });
    if (answer?.plutus_version === "native") return { ok: false, result: notPlutus(scriptHash, answer.source ?? `${network} chain lookup`, { network }) };
    if (answer) {
      return {
        ok: true,
        located: { hex: answer.hex, version: parsePlutusVersion(answer.plutus_version), detail: answer.source ?? `${network} chain lookup` },
        decision: "from_chain",
        kind: "chain",
      };
    }
    return {
      ok: false,
      result: fail({
        code: "script_not_found",
        message: `No script ${scriptHash} is known on ${network}: the chain lookup returned nothing and no loaded transaction carries it. Check the hash and network, or pass the bytes via script.`,
        script_hash: scriptHash,
        network,
      }),
    };
  }
  return {
    ok: false,
    result: fail({
      code: hook ? "invalid_argument" : "script_unavailable",
      message: hook
        ? `Pass network (mainnet | preprod | preview) to look script ${scriptHash} up on chain; no loaded transaction carries it.`
        : `Script ${scriptHash} is not carried by any loaded transaction and this server has no chain lookup for scripts by hash attached. ` +
          "Load a transaction that spends or references it (tx_load, then tx_id + script_hash), or pass the script bytes via script (hex in any wrapping, cardano-cli envelope, or a ScriptRef).",
      script_hash: scriptHash,
      ...(network ? { network } : {}),
      loaded_transactions: ctx.txStore.list().map((r) => r.txId),
    }),
  };
}
