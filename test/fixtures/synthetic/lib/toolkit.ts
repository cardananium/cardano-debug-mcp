// The toolkit handed to every scenario: all modules of the synthetic library, namespaced, plus the scenario types.
//
//   export const scenario: Scenario = {
//     name: "s99",
//     description: "what it is for",
//     build(tk) {
//       const alice = tk.keys.paymentKey("alice");
//       ...
//       return { files: { "s99.tx": tk.writers.txText(tx) }, manifest: { "s99.txHash": tx.txHash } };
//     },
//   };

import * as address from "./address.js";
import * as blake2b from "./blake2b.js";
import * as bytes from "./bytes.js";
import * as cbor from "./cbor.js";
import * as context from "./context.js";
import * as fit from "./fit.js";
import * as flat from "./flat.js";
import * as keys from "./keys.js";
import * as manifest from "./manifest.js";
import * as params from "./params.js";
import * as plutusData from "./plutusData.js";
import * as script from "./script.js";
import * as scriptData from "./scriptData.js";
import * as scripts from "./scripts.js";
import * as tx from "./tx.js";
import * as validator from "./validator.js";
import * as value from "./value.js";
import * as writers from "./writers.js";

export const toolkit = { address, blake2b, bytes, cbor, context, fit, flat, keys, manifest, params, plutusData, script, scriptData, scripts, tx, validator, value, writers };

export type Toolkit = typeof toolkit;

/** A scenario's output: files (paths relative to test/fixtures/, text or bytes) and manifest entries (keys `<name>.<thing>`). */
export interface ScenarioOutput {
  files: Record<string, string | Uint8Array>;
  manifest: Record<string, unknown>;
}

export interface Scenario {
  /** Manifest prefix (`s12`, `payment`): every manifest key starts with `<name>.`. */
  name: string;
  description: string;
  build(tk: Toolkit): ScenarioOutput;
}
