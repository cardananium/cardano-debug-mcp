// The scenario registry: build.ts runs these in order. One module per scenario; every module exports `scenario`.
// Add a scenario with one import line and one array entry (re-read this file first: several people edit it).

import type { Scenario } from "../lib/toolkit.js";
import { scenario as payment } from "./payment.js";
import { scenario as s01 } from "./s01-hub.js";
import { scenario as s02 } from "./s02-loop.js";
import { scenario as s03 } from "./s03-native.js";
import { scenario as s04 } from "./s04-propose.js";
import { scenario as s05 } from "./s05-spo-vote.js";
import { scenario as s06 } from "./s06-onchain.js";
import { scenario as s07 } from "./s07-pool-mint.js";
import { scenario as s08 } from "./s08-lock-spend.js";
import { scenario as s09 } from "./s09-wide-mint.js";
import { scenario as s10 } from "./s10-multi-redeemer.js";
import { scenario as s11 } from "./s11-datum-lock.js";
import { scenario as s12 } from "./s12-vote-tx.js";

export const scenarios: Scenario[] = [payment, s01, s02, s03, s04, s05, s06, s07, s08, s09, s10, s11, s12];
