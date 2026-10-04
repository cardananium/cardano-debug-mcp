// Shared fixtures of the toolkit's own tests: named identities, tiny scripts, a chain context. Every hash derives from a label
// (see lib/writers.ts `fakeHash`, lib/keys.ts).

import type { ProtocolParameters } from "@cardananium/cquisitor-lib";

import { baseAddress, enterpriseAddress, keyCred, rewardAddress, scriptCred } from "../../fixtures/synthetic/lib/address.js";
import { type ChainContext, utxo, type Utxo } from "../../fixtures/synthetic/lib/context.js";
import { flatProgram, lam, lams, unit, V3_VERSION, omega } from "../../fixtures/synthetic/lib/flat.js";
import { paymentKey, stakeKey } from "../../fixtures/synthetic/lib/keys.js";
import { protocolParameters, type ParamSetName } from "../../fixtures/synthetic/lib/params.js";
import { plutusFromFlat, scriptHash, type PlutusVersion } from "../../fixtures/synthetic/lib/script.js";
import { fakeHash } from "../../fixtures/synthetic/lib/writers.js";

export { fakeHash as h };

export const alice = { pay: paymentKey("test-alice"), stake: stakeKey("test-alice") };
export const bob = { pay: paymentKey("test-bob"), stake: stakeKey("test-bob") };
export const aliceAddr = baseAddress("mainnet", keyCred(alice.pay), keyCred(alice.stake));
export const bobAddr = baseAddress("mainnet", keyCred(bob.pay), keyCred(bob.stake));
export const aliceStakeAddr = rewardAddress("mainnet", keyCred(alice.stake));

/** A script that succeeds for any arguments: V1 / V2 `\_ _ _ -> ()` (works for mint too), V3 `\ctx -> ()`. */
export function succeeds(version: PlutusVersion) {
  return version === 3 ? plutusFromFlat(3, flatProgram(lam(unit()), V3_VERSION)) : plutusFromFlat(version, flatProgram(lams(3, unit())));
}

/** Never finishes (V1 / V2). */
export const looping = (version: 1 | 2 = 2) => plutusFromFlat(version, flatProgram(omega()));

export const scriptAddress = (hash: string) => enterpriseAddress("mainnet", scriptCred(hash));
export const scriptStakeAddress = (hash: string) => rewardAddress("mainnet", scriptCred(hash));

export function fundsUtxo(label = "funds", coin = 200_000_000n, index = 0): Utxo {
  return utxo({ ref: `${fakeHash(`world ${label}`)}#${index}`, address: aliceAddr, coin });
}

export function worldCtx(utxos: Utxo[], pv: ParamSetName = "pv10", extra: Partial<ChainContext> = {}): ChainContext {
  const params: ProtocolParameters = protocolParameters(pv);
  return { network: "mainnet", params, slot: 120_000_000n, utxos, ...extra };
}

export { scriptHash };
