// Native (timelock) scripts handed to the Plutus tools. A native script has no UPLC program: the
// engine would read its CBOR as flat bytes and open a meaningless program, so the tools that take a
// Plutus `script` answer a clear code instead.

import type { CborValidationResult } from "@cardananium/cquisitor-lib";

import { DEFAULT_ERA, loadEraCddl } from "../cbor/presets.js";
import type { AppContext } from "../context.js";
import { fail, type ToolResult } from "./_shared.js";

/** First item of a CBOR array header at the start of `hex`, if it is a small unsigned integer. */
function leadingArrayTag(hex: string): number | null {
  const first = parseInt(hex.slice(0, 2), 16);
  // definite array of 1..23 items (0x81..0x97) or indefinite (0x9f); a Plutus script is a byte string, raw flat starts 0x01
  if (!(first >= 0x81 && first <= 0x97) && first !== 0x9f) return null;
  const item = parseInt(hex.slice(2, 4), 16);
  return item >= 0x00 && item <= 0x17 ? item : null;
}

/**
 * Whether `hex` is a native script, bare (`native_script`) or in its `script` wrapper
 * (`[0, native_script]`), checked against the Conway CDDL (the CDDL walker follows any depth a
 * transaction can carry). Undefined when it is not one.
 */
export async function nativeScriptForm(ctx: AppContext, hex: string): Promise<"bare" | "wrapped" | undefined> {
  const tag = leadingArrayTag(hex);
  if (tag === null || tag > 5) return undefined;
  const cddl = loadEraCddl(DEFAULT_ERA);
  try {
    if ((await ctx.lib.validateAgainstCddl<CborValidationResult>(hex, cddl, "native_script")).valid) return "bare";
    if (tag === 0 && (await ctx.lib.validateAgainstCddl<CborValidationResult>(hex, cddl, "script")).valid) return "wrapped";
  } catch {
    return undefined;
  }
  return undefined;
}

/** The `native_script` refusal for a Plutus tool given a native script's bytes. */
export function nativeScriptRefusal(form: "bare" | "wrapped", argument = "script"): ToolResult {
  return fail({
    code: "native_script",
    argument,
    form,
    message:
      `${argument} is a native (timelock) script${form === "wrapped" ? " in its [0, native_script] script wrapper" : ""}, not a Plutus script: there is no UPLC program to open, step or locate. ` +
      "The ledger checks a native script in phase 1: cbor_decode(hex, as='NativeScript') shows it (native scripts may nest up to 32768 levels), cbor_validate(hex, rule='native_script') checks its shape, and tx_validate reports whether a transaction satisfies it.",
  });
}

/** `nativeScriptRefusal` when `script` (hex, not UPLC text) is a native script; undefined otherwise. */
export async function refuseNativeScript(ctx: AppContext, script: string, argument = "script"): Promise<ToolResult | undefined> {
  const hex = script.trim().replace(/\s+/g, "").replace(/^0x/i, "").toLowerCase();
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return undefined;
  const form = await nativeScriptForm(ctx, hex);
  return form ? nativeScriptRefusal(form, argument) : undefined;
}
