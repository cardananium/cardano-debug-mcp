# Synthetic fixtures

Every transaction, script, address and hash the tests use is built here, deterministically, from named
keys and fixed phrases. Sections: the toolkit, the scripts, the governance and on-chain scenarios, the plain transactions and the Koios stub.

## Toolkit

`lib/` builds, fits, signs and writes artificial transactions; `scenarios/` says which ones; `build.ts` runs them.
No dependency beyond what the repository has (node crypto, `bech32`, the `cquisitor-lib` wasm, tsx); no network.

```
lib/blake2b.ts     blake2b 224 / 256 / 160 in pure TypeScript (tested against RFC 7693 and python hashlib)
lib/cbor.ts        value tree -> bytes (shortest heads by default; forced widths, indefinite containers, chunked strings on request),
                   `mark(label, item)` + `encodeWithSpans` for byte offsets, a decoder that re-encodes byte-exactly
lib/plutusData.ts  Constr (121.., 1280.., 102), `80` / `9f..ff` lists, 64-byte byte-string chunks, bignums, datum hash, Koios JSON form
lib/keys.ts        named ed25519 keys (`paymentKey("alice")`: seed = blake2b of a fixed phrase + `payment/alice`), vkey witnesses
lib/address.ts     base / enterprise / reward addresses (mainnet, testnet), Byron base58, pool / drep / cc / gov-action ids, CIP-14 fingerprints
lib/script.ts      native + Plutus V1/V2/V3 scripts, hashes (`blake2b224(tag || single-wrapped bytes)`), `deepNativeScriptBytes`
lib/flat.ts        a UPLC term builder + flat encoder (`flatProgram(lams(3, unit()))`, `omega()`), for hand-written test scripts
lib/scriptData.ts  language views and the script data hash (V1 double-bagged, V2/V3 definite lists)
lib/tx.ts          `TxSpec` -> `assemble()` -> `BuiltTx { hex, txId, spans, redeemers, ... }`; ledger ordering of inputs / policies /
                   withdrawals / voters; redeemer targets resolved to indices; every encoding option and hook
lib/fit.ts         `fit(spec, {ctx, keys})`: validator-in-the-loop fee, ex-units, min UTxO, change, collateral, signatures
lib/context.ts     `ChainContext` (UTxOs, parameters, slot, accounts, dreps, pools, governance) -> the validator's ValidationInputContext
lib/validator.ts   the cquisitor-lib wasm in-process: `validate(txHex, ctx)`, `cborToJson`, `decodeType`
lib/writers.ts     .tx text, DebuggerContext, bundle v1, raw validator result, Koios rows and the provider-cache layout
lib/manifest.ts    manifest values and merging;  lib/scripts.ts  reader of scripts.json;  lib/params.ts  protocol parameter sets
lib/toolkit.ts     everything above as one namespaced object + the `Scenario` type
params/            pv10.json, pv11.json (see "What is copied")
scenarios/         one module per scenario, registered in scenarios/index.ts
build.ts           runs every scenario, writes test/fixtures/** and test/fixtures/manifest.json
```

### A scenario

```ts
import type { Scenario } from "../lib/toolkit.js";

export const scenario: Scenario = {
  name: "demo", // manifest prefix: every manifest key is "demo.<thing>"
  description: "what it is for",
  build(tk) {
    const { address, keys, context, fit, params, writers } = tk;
    const alice = keys.paymentKey("demo-alice");
    const addr = address.baseAddress("mainnet", address.keyCred(alice), address.keyCred(keys.stakeKey("demo-alice")));
    const funds = context.utxo({ ref: `${writers.fakeHash("demo funds")}#0`, address: addr, coin: 50_000_000n });
    const ctx = { network: "mainnet" as const, params: params.protocolParameters("pv10"), slot: 150_000_000n, utxos: [funds] };
    const fitted = fit.fit(
      { inputs: [funds.ref], outputs: [{ address: addr, value: { coin: "min" }, change: true }], ttl: ctx.slot + 3600n },
      { ctx, keys: [alice] }, // valid under the real validator, or it throws
    );
    return {
      files: { "demo.tx": writers.txText(fitted.tx), "demo.bundle.json": writers.bundleFile({ tx: fitted.tx, ctx }) },
      manifest: { "demo.txHash": fitted.tx.txHash, "demo.fee": fitted.spec.fee },
    };
  },
};
```

Register it in `scenarios/index.ts` (one import, one array entry), run `npm run fixtures:build`, and read values in tests through
`test/helpers/fixtures.ts`: `fixturePath`, `readTx`, `readFixtureText`, `readFixtureJson`, `fx("demo.txHash")`, `fxStr`, `fxInt`, `fxBig`, `fxArr`
(a missing key throws an error that lists what the scenario does have). Tests never hard-code a hash or a number that came from a fixture.
Manifest key convention: `<scenario>.<thing>`; a transaction is `<scenario>.txHash` (64 hex) and `<scenario>.txId` (the server's handle,
`tx_mainnet_<12 hex>`, `writers.txHandle`); a size is a number, a bigint (lovelace, ex-units) a decimal string (`fxBig`), a byte span `{offset, length}`.

What `fit` settles: output coins written `"min"`, the change output (`change: true`), the validator's minimum fee (+ `feeAdjust`), ex-units
from phase 2 (`exUnits`: `"exact"`, `slack(0.1, 0.2)`, `"declared"`, or a function), collateral (150 % of the fee, return output), the
script data hash and the vkey witnesses (from the `keys` book, by the hashes the transaction needs). It then checks `expect`: `"valid"`
(default), `"any"`, or exact lists, e.g. `{ errors: ["FeeTooSmallUTxO"] }`, `{ phase2Warnings: ["BudgetIsBiggerThanExpected"] }`. Asking for a
broken transaction is how the diagnostics fixtures are made: `feeAdjust: -1n`, `scriptDataHash: "00".repeat(32)`, a reference input that is also an
input, declared units above the calculated ones. `validate: false` skips the validator (for the omega loop, which phase 2 never finishes).

Facts about the validator the toolkit encodes (each has a test): it counts a transaction as one byte shorter than its CBOR for the minimum
fee; it warns `FeeIsBiggerThanMinFee` only above 110 % of the minimum; `BudgetIsBiggerThanExpected` is a phase-2 warning; it only accepts
witness datums as a tag-258 set (the script data hash is rebuilt that way: `sets.datums` defaults to true, a plain array gives
`ScriptDataHashMismatch`) and redeemers in definite encoding; it rejects extraneous vkey witnesses (`ExtraneousSignature`: make exactly the needed keys sign)
and a witness datum next to an inline datum (`ExtraneousDatumWitnesses`); it reads a stake credential's withdrawal as not allowed unless the account
is delegated to a DRep (zero withdrawals excepted); reference scripts count in the fee at 15 lovelace per byte, x1.2 every 25 KiB (`referenceScriptFee`).

### Determinism

Two runs of `npm run fixtures:build` give byte-identical files: keys come from fixed phrases, ids from `fakeHash(label)`, slots and times are given,
JSON is written with sorted keys, nothing reads the clock or a random source. `npm run fixtures:check` rebuilds in memory and compares with the committed
files (exit 1 on any difference; `test/unit/synthetic/fixtures.test.ts` does the same inside the test run). `manifest.json` also lists every generated
file (`_files`), so a file no scenario produces any more is removed by the next build.

### What the toolkit generates, what it takes as given

Generated: every key, address, transaction id, script, datum, signature and hash. Keys are labelled (`payment/alice`) and every fake id is
`blake2b(fixed phrase + label)`, so a value can always be traced to the line of a scenario that named it. Addresses are well-formed mainnet addresses,
signatures are real ed25519 signatures over the real body hash, script hashes are the real blake2b-224 of the real bytes.

Taken as given: `params/pv10.json` and `params/pv11.json`, the protocol parameter sets (fee coefficients, limits, execution prices, cost models for
PlutusV1 / V2 / V3, governance thresholds) at protocol versions 10 and 11, plus the same values in the shape of a Koios `epoch_params` row.
They are protocol constants: the script data hash and the execution units depend on the cost models.
Epoch number, nonce and block hash are not part of them: every scenario gives its own.
The CDDL schemas in `src/assets/cddl` are the other piece of specification the project keeps.

### Limits

Pointer addresses, Byron witnesses, pool registration certificates (use `{kind: "raw", cbor}`), Plutus V3 `Case` / `Constr` beyond what `flat.ts` encodes (no
lists / pairs / BLS constants in `flat.ts`), and the Dijkstra era are not modelled. `fit` evaluates in-process and cannot interrupt a script that never
finishes (`validate: false`). Redeemer indices follow the ledger's ordering (inputs by (tx id, index), policies by hash, withdrawals with script credentials before
key credentials, voters committee < DRep < pool); `encoding.keepOrder` turns the sorting off for odd-encoding tests.


## Scripts

The Plutus scripts of the fixtures are ours: written in Aiken (the validators) and in UPLC text (the tiny ones), compiled
once, committed, and listed in the registry `scripts.json`. Nothing here is a script that ever existed on a chain.
Nothing runs a compiler at test time: `npm run fixtures:build` and the tests read `scripts.json` and the committed
`plutus.json` files; only `npm run fixtures:compile` needs Aiken.

```
aiken-v2/    Aiken project, Plutus V2: compiler v1.0.29-alpha, stdlib 1.9.0, old validator syntax
  lib/order_book.ak       the order-book rules shared by order_spend and order_fixed (+ their Aiken tests)
  validators/             order_spend  order_fixed  burn_mint  reward_ok  lock_spend   (each with Aiken tests)
  plutus.json aiken.lock  committed blueprint (parameters NOT applied) and lock file
aiken-v3/    Aiken project, Plutus V3: compiler v1.1.21, stdlib v3.0.0
  validators/             spend_v3  pool_mint_a  pool_mint_b  guardrails                (each with Aiken tests)
uplc/        hand-written UPLC text: tiny  tiny_v3  v1_dummy  loop_v2
scripts.json registry: every script with hash, bytes, size, term count, parameters, notes + the native-script catalogue
compile.ts   the `fixtures:compile` driver (also exports the helpers the tests use)
```

### Toolchain and how to recompile

Two compilers, because Aiken v1.1.x builds only Plutus V3 and the V2 syntax changed:

| use | version | where |
| --- | --- | --- |
| V3 (`aiken-v3/`) | aiken v1.1.21 | `cargo install aiken --version 1.1.21` (any build of v1.1.21) |
| V2 (`aiken-v2/`) | aiken v1.0.29-alpha | https://github.com/aiken-lang/aiken/releases/download/v1.0.29-alpha/aiken-aarch64-apple-darwin.tar.gz (other platforms: the same release page) |

```
AIKEN_V3=$(command -v aiken) AIKEN_V2=/path/to/aiken-1.0.29-alpha/aiken npm run fixtures:compile
```

It runs `aiken build -t verbose -f user-defined` and `aiken check` (the Aiken unit tests: 30 for V2, 39 for V3) in both
projects, applies the parameters, encodes the UPLC, hashes everything, measures it and rewrites `scripts.json` and both
`plutus.json`. A second run gives byte-identical files (`AIKEN_V3=... AIKEN_V2=... npx vitest run test/unit/synthetic/scripts.test.ts`
checks exactly that when the two variables are set). The standard library is fetched from GitHub the first time
(`build/` holds it and is ignored by git; `aiken.lock` pins the versions).

Trace flags: `-t verbose -f user-defined` keeps the `trace` calls the validators write themselves (they sit on failure
paths, plus one "unlocking" line in `lock_spend`) and none of the compiler's own, so a failed `expect` stays a bare
builtin failure (`failed to deserialise PlutusData using UnConstrData`, the "data_shape" family of MachineErrors).

Compiler quirks worth knowing: v1.1.21 prints nothing, and exits 1, when a compile error occurs while stdout is not a
terminal (re-run `aiken check` in a terminal to read the message); in v1.1.21 `use` lines must precede every definition; an `expect`
cast to an opaque stdlib type is refused, so tests build such values through a mirror type with the same Plutus Data
shape (see the `guardrails` tests); in tests a failing `expect` inside a validator is a crash, so the cases that crash use
`test ... fail { }`.

### Parameters

A parameterised validator is applied with `aiken blueprint apply -m <module> -v <validator> <cbor hex>`, one parameter
per call, the first declared parameter first; the published script is the blueprint program with every parameter applied
(so the program starts with an outer Apply chain whose arguments are `con data` constants, and the decompiler's first
note is "Applied compile-time params"). The values are in `scripts.json` (`params[]`: name, type, CBOR, value, note):

- every key hash is the hash of a named toolkit key: `payment/script-operator` (`keys.paymentKey("script-operator")`, listed
  under `keys.operator` in the registry). To satisfy a script it guards, make that key a required signer and add its vkey
  witness. The native 3-of-6 script uses `payment/native-signer-1` .. `6`.
- `order_spend`: `operator` = that key hash, `fee_numerator` = 30 (basis points).
- `burn_mint`: `admin` = that key hash, `max_supply` = 10^15.
- `pool_mint_a`: `owner` = that key hash, `reference_holder` = the hash of `spend_v3` (the reference token must be paid to
  `spend_v3`'s script address).
- `pool_mint_b`: `seed` = the output reference `{transactionId: blake2b-256("cardano-debug-mcp synthetic fixture seed output / pool_mint_b"), outputIndex: 0}`.
  A UTxO set must contain that output, and the minting transaction must spend it. It is an artificial id: add it to the
  context of the scenario like any other UTxO.

`order_fixed` is `order_spend` with the same values compiled in as constants: no applied parameters, so the decompiler's
first note is "Outer Apply chain — no compile-time params" (use it where a test pins that note).

### The scripts

Sizes are of the single-CBOR form (`cborHex`, what the ledger hashes; `59xxxx` from 256 bytes); exact numbers, hashes and
the measured term / line counts are in `scripts.json`.

| name | version | purpose | about | what it is for |
| --- | --- | --- | --- | --- |
| `order_spend` | V2 | spend | 2.4 KB, ~2,600 terms | the big parameterised spend validator (order book) |
| `order_fixed` | V2 | spend | 2.4 KB | the same logic without applied parameters |
| `burn_mint` | V2 | mint | 0.7 KB | parameterised minting policy, Burn needs no signature |
| `reward_ok` | V2 | withdraw, publish | 0.2 KB | zero withdrawals and script stake certificates |
| `lock_spend` | V2 | spend | 1.1 KB | small spend validator for reference-script use, `Constr 1 []` unlocks |
| `spend_v3` | V3 | spend | 0.6 KB | time-lock vault with an inline-datum check |
| `pool_mint_a` | V3 | mint | 1.2 KB | CIP-68 reference + user token pair |
| `pool_mint_b` | V3 | mint | 0.5 KB | one-shot NFT policy |
| `guardrails` | V3 | propose, vote, publish | 2.0 KB | constitution-guardrails shape (one script, three handlers) |
| `tiny` | V2 | any | 11 B | always succeeds (`\datum redeemer context -> ()`) |
| `tiny_v3` | V3 | any | 6 B | always succeeds (`\context -> ()`) |
| `v1_dummy` | V1 | any | 20 B | a Plutus V1 validator that succeeds |
| `loop_v2` | V2 | any | 14 B | never terminates (omega, behind one lambda); validation ends in `verdict: "timeout"` |

Datum / redeemer shapes (Plutus Data constructors; the rules and bounds are in the header comments of each `.ak` file):

- **order_spend / order_fixed.** Datum `Constr 0 [maker address, sell_policy, sell_asset, unit_price, quantity, expires_at (POSIX ms), memo]`
  (the address is `Constr 0 [credential, Maybe stake]`; a list datum fails with a builtin failure on `unConstrData`).
  Redeemers: `Cancel = Constr 0 []` (the maker's key or the operator is a required signer), `Fill = Constr 1 [amount, payout_index]`
  (validity range with a finite upper bound <= expires_at; nothing of the sold policy minted, burning is fine; the spent input carries
  `quantity` of the sold token; output `payout_index` pays the maker at least `unit_price*amount - fee`; the operator is paid at least
  `fee = unit_price*amount*30/10000` in total; a partial fill needs an output at the order's address with the datum's `quantity` reduced
  and the remaining tokens), `Reprice = Constr 2 [new_unit_price]` (maker signs, continuing output with the new price).
  Mind the ledger's rules when you size a fill: the fee output must itself meet the minimum UTxO, so use a price of a few hundred ada.
- **burn_mint.** `Burn = Constr 1 []`: every quantity of the policy in the mint field is negative (and there is one); no signature, no datum.
  `MintTokens = Constr 0 [asset_name]`: the admin is a required signer, one minted entry with that name, `0 < quantity <= 10^15`.
- **reward_ok.** `Constr 0 []` passes; `Constr 1 []` fails with the trace `reward_ok: denied`; any other shape fails with a MachineError.
- **lock_spend.** Any datum. `Unlock = Constr 1 []` passes (trace `lock_spend: unlocking`) when the input is among the inputs;
  `Refund = Constr 0 []` fails with `lock_spend: refund is disabled`; `Batch = Constr 2 [n]` needs exactly n inputs at the same script
  (`lock_spend: batch size mismatch` otherwise); `Sweep = Constr 3 [i]` needs output i at a key address with the input's lovelace minus the fee.
- **spend_v3.** Inline datum `Constr 0 [owner key hash, unlock_after]`, equal to the spent output's inline datum (a datum-hash input fails).
  `Withdraw = Constr 0 []`: owner is a required signer and the validity range starts at or after `unlock_after` (POSIX ms).
  `Extend = Constr 1 []` fails with `spend_v3: extend is not supported`.
- **pool_mint_a.** `MintPair = Constr 0 [name, reference_output_index]`: the operator is a required signer; the mint field is exactly
  `{000643b0 ++ name: 1, 000de140 ++ name: 1}` under the policy (name 1..28 bytes); output i carries the reference token at `spend_v3`'s
  address with the inline datum `Constr 0 [Map {"name": .., "image": ..} (byte keys), 1, extra]`. `BurnPair = Constr 1 [name]`: operator signs, both burned.
- **pool_mint_b.** `MintNft = Constr 0 [name]`: the seed output is spent, the mint field is exactly `{name: 1}`. `BurnNft = Constr 1 []`: all negative.
- **guardrails.** `propose`: redeemer a Plutus map (`Map []` normally; anything else fails on `unMapData`); a ParameterChange passes when each
  changed parameter is inside its bound (table in the header of `guardrails.ak`, e.g. max tx size 12288..32768, collateral percentage
  100..200, max tx ex-units memory <= 40,000,000 and cpu <= 30,000,000,000), an empty change passes; a TreasuryWithdrawal passes up to
  10,000,000 ada; every other action fails. `vote`: one required signer at least; a pool voter must be that signer, any other voter needs
  `Constr 0 []`. `publish`: DRep registration with a deposit >= 100 ada, or a DRep update. The handlers share one hash.
- **tiny / tiny_v3 / v1_dummy / loop_v2.** No shapes. A Plutus V1 script cannot run in a transaction whose inputs or outputs carry an inline
  datum (`InlineDatumNotAllowedForPlutusV1`): give its inputs datum hashes.

### Native scripts

`scripts.json` > `native[]`: `all_empty` (`ScriptAll []`, 3 bytes), `any_empty` (never valid), `sig_operator`, `after_slot_1000`,
`before_slot_1000`, `operator_and_window` and `multisig_3_of_6` (196 bytes). Each entry has the toolkit's form (`json`), the cardano-cli
form (`cliJson`), the CBOR (`cborHex`) and the hash (blake2b-224 of `00 || cbor`).

### Using them from a scenario

```ts
const { scripts, keys } = tk;
const burn = scripts.registryScript("burn_mint");          // { kind: "plutus", version: 2, bytes } for the builder (hash checked)
const hash = scripts.registryHash("burn_mint");            // 56 hex
const multisig = scripts.registryNative("multisig_3_of_6");
const operator = keys.paymentKey("script-operator");       // sign / require this key for the scripts it guards
```

`lib/scripts.ts` re-hashes every script it loads and refuses a registry entry whose hash differs from its bytes.

### Tests

- `test/unit/synthetic/scripts.test.ts`: registry consistency (hash = blake2b-224(version byte ‖ bytes), flat bytes, sizes and the
  shapes other tests pin, parameters inside the bytes, keys), the decompiler's and the debugger's view of every script, every script's
  success and failure behaviour on hand-built ScriptContexts (`scriptContexts.ts`), and, when `AIKEN_V2` / `AIKEN_V3` are set,
  recompilation reproducing the committed files.
- `test/unit/synthetic/scriptsValidator.test.ts`: the same behaviours inside full transactions built by the toolkit and run by the
  validator (cquisitor-lib).
- the Aiken unit tests: `aiken check` in `aiken-v2/` and `aiken-v3/` (run by `fixtures:compile`).


## Governance and on-chain scenarios (S4, S5, S6)

Three scenarios (`scenarios/s04-propose.ts`, `s05-spo-vote.ts`, `s06-onchain.ts`), manifest keys `s04.*`, `s05.*`, `s06.*`; their checks are in
`test/unit/synthetic/governanceOnChain.test.ts`, the tests that consume them read the manifest (`s04.guardrailsHash`, `s05.securityParameters`, `s06.slot` ...).

- **S4, `s04.propose.bundle.json`** (bundle v1): a Plutus V3 ParameterChange proposal whose `policy_hash` is the hash of the artificial `guardrails` script; the
  script is in the witness set, the redeemer is `VotingProposal 0` with data `Map []`, declared ex-units equal the calculated ones (verdict `exact`) and the
  transaction validates with zero diagnostics at its inclusion slot (PV10 parameters). The bundle carries `validation_input_context` (the proposer's account,
  one active and one last-enacted ParameterChange, the constitution naming the script, treasury, slot), `on_chain`, `defaults_applied` and no `validation_result`.
  Manifest: `s04.txHash`, `s04.txId`, `s04.guardrailsHash`, `s04.exUnits`, `s04.redeemer` (ref `propose:0`, target `proposal #0`).
- **S5, `s05.spo-vote.bundle.json`** (bundle v1, PV11): a stake pool operator votes Yes (with an anchor) on a ParameterChange; 11 key inputs (`isSpent: true`), one
  output, a reward withdrawal of the wrong amount, 3 vkey witnesses (payment, stake and pool key). The context predates `changedParameters` (the governance
  action context names none); `provider_rows.proposals[0].param_proposal` changes exactly `max_block_ex_mem`, `max_block_ex_steps`, `max_tx_ex_mem`,
  `max_tx_ex_steps` (the ledger's security group, `s05.securityParameters`). The stored `validation_result` is the validator's own answer on that context: it holds
  `DisallowedVoters`, `WrongRequestedWithdrawalAmount` and 11 `BadInputsUTxO` (`s05.storedErrors`); importing the bundle fills the names from the row and drops the
  stale verdict. With `s05.otherParameters` (`min_pool_cost`, `drep_deposit`) the same vote is `DisallowedVoters` again.
- **S6, `onchain__synthetic_s06/`** (a provider-cache directory, copy it to `CARDANO_DEBUG_CACHE_DIR`): the Koios rows (keyed `<kind>/mainnet/koios/...`) of one
  on-chain transaction that is fully valid at its inclusion slot (protocol major 10): two V2 spends (`lock_spend`, `tiny`) and a zero-lovelace withdrawal from the
  script stake address of `reward_ok`, all three scripts delivered by reference inputs, inline datums, one required signer, one key input that is also the collateral,
  validity interval around the slot. 13 files: the tx row, the 7 UTxO rows, `account_info`, `committee_info`, `constitution`, `totals/<epoch>` and
  `epoch_params/<epoch>`; the server asks for exactly these (a request for anything else reaches the test's stub and fails it). Manifest: `s06.slot` (decimal string),
  `s06.epoch`, `s06.blockHeight`, `s06.blockHash`, `s06.timestamp`, `s06.txHash`, `s06.txId`, `s06.withdrawExUnits`, `s06.redeemerRefs`, `s06.scripts.*`, `s06.cacheDir`.

## Plain transactions (S7 - S11) and the Koios stub

Five scenarios (`scenarios/s07-pool-mint.ts` .. `s11-datum-lock.ts`), manifest keys `s07.*` .. `s11.*`; each is built with `fit` and valid under the real validator, signed for real.
Their checks are in `test/unit/synthetic/plainScenarios.test.ts`; the tests that consume them read the manifest (`s08.out1Coin`, `s07.scripts`, `s11.scriptAddress` ...).

| scenario | file | what it is | size |
| --- | --- | --- | --- |
| S7 | `pool-mint.tx` | two V3 witness minting scripts (`pool_mint_a` CIP-68 pair, `pool_mint_b` one-shot NFT); array redeemers Mint 0 / Mint 1; tag 258 on body 0 / 13 and witness 0 (so it fails the Babbage CDDL at `$[0][0]`, `$[0][13]`, `$[1][0]`, `$[1][7]`); 2 inputs, 3 outputs with inline datums (output 0 holds a 4 KB image blob); 1 signer, 1 vkey | ~6.9 KB, ui_link URL ~8,400 chars |
| S8 | `lock-spend.tx`, `lock-spend.provider-rows.json` | V2 reference-script spend (`lock_spend`, Spend 1 `Constr 1 []`), the listing is input 1; 3 vkeys, 1 witness datum, ttl + validity start, 2 metadata labels (674, 1337), collateral + return + total, a reference input holding the script (that UTxO is not in the transaction); the rows file is the provider's view of it as an on-chain transaction | ~1 KB, 109 span rows |
| S9 | `wide-mint.tx` | 26 outputs (25 with ~265-byte inline datums), 25 assets minted under one native policy, 721 metadata, 2 reference inputs, 1 signer, 1 vkey, no scripts run | ~14.7 KB (limit 16,384) |
| S10 | `multi-redeemer.tx` | four map-form redeemers (Spend 0, Spend 1, Mint 0, Reward 0), a zero withdrawal from a script stake address, a burn, 4 reference inputs (one per V2 script), 2 witness datums, a datum-hash output and an inline-datum output | ~1 KB, 132 span rows |
| S11 | `datum-lock.tx` | a datum-hash lock at the `order_fixed` script address, change with one native asset, 1 witness datum, 1 vkey, no redeemers; owns the identifiers of the data-view tests (`s11.scriptAddress`, `s11.scriptHash`, `s11.makerAddress`, `s11.makerStakeAddress`, `s11.datumHash`, `s11.unit`, `s11.byronAddress`) | ~0.6 KB |

`test/helpers/koiosStub.ts` is the local Koios the tests that load a transaction by hash use:
`const stub = await startKoiosStub(loadProviderRows(fxStr("s08.providerRows")))` listens on 127.0.0.1, `stub.env` is the one variable that points the server at it
(`CARDANO_DEBUG_KOIOS_URL_MAINNET`), `stub.requests` / `stub.count("/utxo_info")` show what the server asked. It serves `/tip`, `/tx_cbor`, `/utxo_info`, `/epoch_params`,
`/totals` from the rows and answers the account / pool / drep / committee / proposal / asset endpoints with empty lists. `test/e2e/chain.e2e.test.ts` and
`test/e2e/fullFlow.e2e.test.ts` run s08 through it by default (no network, no gate); `test/unit/synthetic/koiosStub.test.ts` tests the stub itself.
