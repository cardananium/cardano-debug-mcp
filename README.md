# cardano-debug-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant such as Claude Code
**inspect, validate and step-debug Cardano transactions and Plutus scripts**.

Give it a transaction (CBOR or a hash) and ask why it fails. The assistant can then validate it
against the ledger rules, find the failing redeemer, step through the script on a CEK machine,
read the script as pseudocode, explain CBOR / CDDL errors, and send you a link that opens the
problem highlighted in [cquisitor](https://cardananium.github.io/cquisitor) or
[de-uplc-web](https://cardananium.github.io/de-uplc-web).

Under the hood:

- [cquisitor-lib](https://github.com/cardananium/cquisitor-lib): decoding and phase-1 / phase-2 validation
- [de-uplc](https://github.com/cardananium/de-uplc-web): the UPLC step debugger
- [dehosk](https://github.com/cardananium/dehosk): the UPLC → pseudocode decompiler

## Quick start

Needs Node ≥ 20. Install from npm and register the server with Claude Code:

```sh
npm install -g @cardananium/cardano-debug-mcp
claude mcp add --scope user cardano-debug -- cardano-debug-mcp
```

Start a new Claude Code session and ask, for example, "why does this transaction fail?" with the
transaction CBOR or its hash. Loading a transaction by hash uses the public Koios API, which is rate
limited: for regular use add a Koios API key or a Blockfrost project id (see
[Add it to Claude Code](#add-it-to-claude-code)). Details, other MCP clients and building from source
are under [Install](#install).

## What you can ask

These are starting points, not a fixed list. The tools share handles (`tx_id`, `dbg_id`) and one
canonical UPLC position format, so the assistant works iteratively: it picks the next call from the
previous result instead of running a script.

- "Why does this transaction fail?" (paste the CBOR or a tx hash)
- "Which redeemer fails, and where in the script?"
- "Step through the spend redeemer until the error and show me the environment."
- "What does this validator check?" (the script is decompiled to readable pseudocode)
- "Why doesn't this CBOR match the Conway CDDL?"
- "Open the failing part in cquisitor."

A typical "why does it fail?" run:

1. Load and validate the transaction. A phase-1 failure is explained from the ledger error, its
   location and hint.
2. For a failing redeemer, read its error and traces, then read the validator as pseudocode to
   form a hypothesis.
3. Open a debugging session and run until the error. Rewind to the failing term when needed,
   inspect the environment and frames, and stop at a trace, a builtin or a budget threshold to
   test the hypothesis.
4. Report the root cause with the decisive values, the evidence and a fix, and optionally open
   the problem in cquisitor or de-uplc-web.

You can also steer it mid-way ("stop at the first `lessThanInteger`", "why is this so expensive?",
"what would pass?").

## Install

Two ways: from npm (nothing to build) or from source.

### From npm

Requires Node ≥ 20.

```sh
npm install -g @cardananium/cardano-debug-mcp
cardano-debug-mcp --check   # verifies the install, exit code 0 = fine
```

### From source

Requirements:

- Node ≥ 20 and npm to run the server. The tests and `npm run dev` need Node ≥ 22.12.
- git: the debugger and decompiler wasm sources are the `deps/de-uplc-web` submodule.
- To build that wasm (`npm run build:deps`):
  - bash (the build scripts are bash; there is no native Windows build, use WSL2);
  - Rust with the wasm target: `rustup target add wasm32-unknown-unknown`;
  - `wasm-pack` (`cargo install wasm-pack`) for the debugger engine. It fetches the wasm-bindgen
    version pinned in the engine's `Cargo.lock` (0.2.129) by itself;
  - `wasm-bindgen-cli` for the decompiler, which pins a different version:
    `cargo install wasm-bindgen-cli --version 0.2.127 --locked`;
  - a `clang` that can emit WebAssembly (the BLS library compiles C for wasm). Apple's clang cannot:
    on macOS run `brew install llvm` (the build scripts pick it up). On Linux the distribution's
    `clang` works.
- Network access during the build: cargo downloads the crates and two git dependencies
  (`cardananium/aiken`, `cardananium/dehosk`), and `npm install` fetches the npm packages. The first
  wasm build compiles the Rust crates and can take several minutes.

```sh
git clone --recurse-submodules https://github.com/cardananium/cardano-debug-mcp.git
cd cardano-debug-mcp
npm run build:deps   # builds the debugger and decompiler wasm (git submodule deps/de-uplc-web)
npm install
npm run build        # -> dist/server.js
node dist/server.js --check   # verifies the install, exit code 0 = fine
```

Platforms: developed on macOS. Linux should work the same way (the wasm build scripts have a Linux
path). Windows is only supported through WSL2.

## Add it to Claude Code

With the npm install:

```sh
claude mcp add --scope user cardano-debug -- cardano-debug-mcp
# without installing it first (fetched on the first start, which then takes longer):
claude mcp add --scope user cardano-debug -- npx -y @cardananium/cardano-debug-mcp
```

From a source checkout:

```sh
claude mcp add --scope user cardano-debug -- node /path/to/cardano-debug-mcp/dist/server.js
```

Use an absolute path for a source checkout. `--scope user` makes the server available in every project. Without it Claude
Code adds it to the current project only (`local` scope, kept in `~/.claude.json`);
`--scope project` writes a `.mcp.json` that you can commit.

In the commands below, replace `node /path/to/cardano-debug-mcp/dist/server.js` by `cardano-debug-mcp` for the npm install.

The public Koios API works without a key but is rate limited: loading several transactions by hash
in a row, or a large one, can hit the limit (the server then answers `rate_limited` and says what to
do). For regular use get an API key from Koios ([koios.rest](https://koios.rest)) or a project id
from Blockfrost ([blockfrost.io](https://blockfrost.io)):

```sh
claude mcp add --scope user --env KOIOS_API_KEY=... cardano-debug -- node /path/to/cardano-debug-mcp/dist/server.js
# or Blockfrost (one project id per network: _MAINNET, _PREPROD, _PREVIEW)
claude mcp add --scope user --env BLOCKFROST_PROJECT_ID_MAINNET=... --env CARDANO_DEBUG_PROVIDER=blockfrost cardano-debug -- node /path/to/cardano-debug-mcp/dist/server.js
```

Or in `.mcp.json` (for the npm install use `"command": "cardano-debug-mcp"` and drop `args`):

```json
{
  "mcpServers": {
    "cardano-debug": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/cardano-debug-mcp/dist/server.js"],
      "env": { "KOIOS_API_KEY": "${KOIOS_API_KEY:-}" },
      "timeout": 600000
    }
  }
}
```

Keep the `:-` in `${KOIOS_API_KEY:-}`. When the variable is not set, a bare `${KOIOS_API_KEY}` is
passed to the server as that literal text, which Koios rejects as a key (HTTP 401); with `:-` the key
is empty and the server runs anonymously. `timeout` is the limit of one tool call in milliseconds;
the environment variables `MCP_TOOL_TIMEOUT` (tool calls) and `MCP_TIMEOUT` (server start-up) set
the defaults.

Start a new Claude Code session, then check with `claude mcp list` or `/mcp` that `cardano-debug`
is connected. Any other MCP client works the same way: run `node dist/server.js` over stdio.

## Tools

| Tool | What it does |
|---|---|
| `tx_load` | Load a transaction from CBOR, a tx hash (fetched from Koios / Blockfrost) or a saved bundle; returns a `tx_id` for the other tools |
| `tx_inspect` | Browse a loaded transaction by section: inputs, outputs, redeemers, scripts, datums, certificates, governance… |
| `tx_validate` | Phase-1 and phase-2 validation with per-redeemer budgets and the reasons a transaction is rejected |
| `tx_redeemer` | One redeemer in detail: error, traces, script context, script, links |
| `tx_add_witnesses` | Add vkey witnesses and validate again |
| `bundle_export` | Save a transaction with its chain context for offline replay |
| `debug_open` | Start a CEK debugging session for a redeemer, for a script with arguments, or for a bare program; `reopen` rebuilds a lost session |
| `debug_run` | Run until the error, the end, a term, a line, a trace, a builtin or a budget; breakpoints; `stop_before` for the state just before a failure |
| `debug_inspect` | Look at the machine: position, frames, environment, values, script context, traces, budget |
| `debug_source` | The UPLC listing around the current position, or a search in it (`find`) |
| `debug_profile` | Where the budget goes: hot terms, lines and builtins |
| `debug_close` | Close sessions |
| `script_decompile` | A script as readable pseudocode (or as UPLC) |
| `script_locate` | Translate between term ids and UPLC lines |
| `cbor_decode` | Decode any bytes as a ledger type, raw CBOR with byte spans, or "closest match"; `as='spans'` lists every node's offset |
| `cbor_validate` | Check CBOR against a CDDL schema (the ledger's Shelley to Conway schemas and the upcoming Dijkstra one are built in) with byte offsets and hints |
| `cddl_check` | Check that a CDDL schema parses and resolves; outline and rule lookup |
| `ui_link` | Build a link into cquisitor or de-uplc-web that highlights the problem with hints (a long link is also saved to `link_file`); optionally open it in the browser |
| `docs` | Built-in reference for the assistant (see below) |

Larger results are also available as `cardano-debug://` resources (decoded transactions, script
contexts, UPLC listings, pseudocode, profiles, CDDL schemas…).

A tool rejects an argument it does not have and names the valid ones (with a "did you mean"), so a
misspelled or invented argument is never silently ignored.

### Built-in knowledge

The server carries reference docs written for the assistant, so it does not have to guess:
transaction anatomy, ScriptContext and script arguments, UPLC and the CEK machine, validation
errors (a catalogue of every error and warning the validator reports), a debugging playbook, and
CBOR / CDDL diagnostics. The assistant reads them with the `docs` tool, one section at a time.
Only as a last resort, when the docs and tools leave a deciding question open (for example the
chain disagrees with the validator), it is told to read the
[cardano-ledger](https://github.com/IntersectMBO/cardano-ledger) source.

When you do not follow an explanation, or a position is hard to describe in words (a byte offset,
a field of a big transaction, a UPLC term, a branch of a script), the assistant builds a link into
cquisitor or de-uplc-web with the spot highlighted and annotated, instead of only describing it.

### Prompts

| Prompt | Use it to |
|---|---|
| `debug_tx` | find out why a transaction fails, step by step |
| `explain_script` | explain what a script checks |
| `replay_bundle` | debug a saved bundle offline |
| `diagnose_cbor` | explain what is wrong with some bytes |

In Claude Code they appear as `/cardano-debug:debug_tx` and so on.

## Configuration

All settings are environment variables; none is required. Numbers are plain digits (`90000`, not
`90s` or `60_000`); a value that cannot be read, or that is out of range, is reported on stderr and
replaced by the default (or cut to the maximum).

| Variable | Meaning | Default |
|---|---|---|
| `KOIOS_API_KEY` | Koios API key (empty = anonymous) | anonymous |
| `BLOCKFROST_PROJECT_ID_MAINNET` / `_PREPROD` / `_PREVIEW` | Blockfrost project ids | unset |
| `CARDANO_DEBUG_PROVIDER` | `koios` or `blockfrost` | `koios` |
| `CARDANO_DEBUG_OFFLINE` | `1` or `true`: never call a provider (bundles, the cache and CBOR input still work) | unset |
| `CARDANO_DEBUG_CACHE_DIR` | disk cache for chain data and bundles (see [Chain data cache](#chain-data-cache)) | `~/.cache/cardano-debug-mcp` |
| `CARDANO_DEBUG_CQUISITOR_URL` | cquisitor instance links point at | `https://cardananium.github.io/cquisitor` |
| `CARDANO_DEBUG_DE_UPLC_URL` | de-uplc-web instance links point at | `https://cardananium.github.io/de-uplc-web` |
| `CARDANO_DEBUG_NO_OPEN` | `1` or `true`: `ui_link` never opens a browser | unset |
| `CARDANO_DEBUG_LOG` | `debug` for verbose logs (stderr) | `info` |

<details>
<summary>Advanced</summary>

| Variable | Meaning | Default and range |
|---|---|---|
| `CARDANO_DEBUG_KOIOS_URL_MAINNET` / `_PREPROD` / `_PREVIEW` | Koios endpoint override (e.g. self-hosted) | public Koios |
| `CARDANO_DEBUG_BLOCKFROST_URL_MAINNET` / `_PREPROD` / `_PREVIEW` | Blockfrost endpoint override | public Blockfrost |
| `CARDANO_DEBUG_EVAL_TIMEOUT_MS` | time limit for one validation | `90000` (1 to `300000`) |
| `CARDANO_DEBUG_LIB_TIMEOUT_MS` | time limit for other library calls | `10000` (1 to `120000`) |
| `CARDANO_DEBUG_RUN_TIMEOUT_MS` | default `debug_run` / `debug_profile` time limit | `60000` (1 to `110000`) |
| `CARDANO_DEBUG_DECOMPILE_TIMEOUT_MS` | time limit for one decompilation | `120000` (1 to `300000`) |
| `CARDANO_DEBUG_WORKER_READY_TIMEOUT_MS` | time a worker may take to load its wasm | `60000` (1 to `300000`) |
| `CARDANO_DEBUG_TX_STORE_MAX` | loaded transactions kept | `32` (1 to `1024`) |
| `CARDANO_DEBUG_SESSION_MAX` | open debugging sessions kept | `8` (1 to `64`) |
| `CARDANO_DEBUG_WORKER_HEAP_MB` | heap limit per worker | `1024` (`128` to `8192`) |
| `CARDANO_DEBUG_MAX_MESSAGE_BYTES` | largest JSON-RPC message accepted | `134217728` (`1048576` to `1073741824`) |

</details>

API keys are read only from the environment and never echoed back.

## Chain data cache

Everything fetched from Koios or Blockfrost is cached under `CARDANO_DEBUG_CACHE_DIR`, per provider:

- transaction bytes fetched by hash: kept for good;
- the last live chain context of each loaded transaction, saved as a bundle (also the files
  `bundle_export` writes): kept for good and removed last. This is how a pending transaction that is
  not on chain yet survives a restart;
- the chain context a validation reads: 1 hour (10 minutes while the transaction is not on chain);
- UTxO rows: 10 minutes. Other provider rows (accounts, pools, DReps…): 5 minutes. The latest epoch
  parameters: 1 hour; the parameters of one past epoch: for good.

The cache is limited to 512 MB: the least recently modified files go first, bundles last. It is only
an accelerator, so deleting the directory is always safe.

Pass `refresh=true` to `tx_load` or `tx_validate` to bypass every cache and fetch again. Use it when a
transaction that was pending has been confirmed since, when its inputs were spent or created after
you first loaded it (a cached context keeps the tip slot and spent flags of that moment), or to retry
after a provider error.

## Troubleshooting

- **Logs.** The server logs to stderr; stdout carries only JSON-RPC. Start Claude Code with
  `claude --debug` to see the messages of MCP servers, or run `node dist/server.js` in a terminal to
  see its start-up messages (it then waits for JSON-RPC on stdin; press Ctrl-D to quit).
- **The server does not connect.** `claude mcp list` or `/mcp` in Claude Code shows its status. Run
  `cardano-debug-mcp --check` (from source: `node /path/to/cardano-debug-mcp/dist/server.js --check`): it verifies the Node version, the build
  files and wasm, the cache directory, the provider configuration and that the library worker starts,
  prints one line each, and exits 1 on any failure. A missing or stale `dist/` (after `git pull`, or
  a build that stopped half way) is fixed by `npm run build:deps && npm run build`. The server itself
  prints one such line and exits when the build is incomplete.
- **Which build is running.** `node dist/server.js --version` prints the package version, the build
  time, the commit and the de-uplc-web / dehosk revisions; the same is in the
  `cardano-debug://server/info` resource.
- **Old behaviour after an update.** The server is a long-running process: restart Claude Code (or
  reconnect the server in `/mcp`) after every `npm run build`.
- **"unknown parameter …".** A tool refuses an argument it does not have and lists the valid ones;
  the assistant normally corrects itself on the next call.
- **Answers come back as a file reference.** Claude Code limits one tool result to 25,000 tokens by
  default: narrow the request (the tools page with `offset` / `limit` and zoom with `path` / `depth`,
  and the assistant knows to use them) or raise `MAX_MCP_OUTPUT_TOKENS`.
- **`rate_limited`, or `provider_error` on a load by hash.** The public Koios API is throttled and can
  be overloaded. Get an API key from Koios (`KOIOS_API_KEY`) or a project id from Blockfrost
  (`BLOCKFROST_PROJECT_ID_MAINNET` / `_PREPROD` / `_PREVIEW`, with `CARDANO_DEBUG_PROVIDER=blockfrost`
  or `provider=blockfrost` in the call), set it in the server's environment and restart the server.
  Without any key you can still load a transaction from a bundle (`CARDANO_DEBUG_OFFLINE=1`).

## Update

From npm:

```sh
npm update -g @cardananium/cardano-debug-mcp
cardano-debug-mcp --check
```

From source:

```sh
git pull
git submodule update --init
npm install
npm run build:deps   # needed when deps/de-uplc-web moved; harmless otherwise
npm run build
node dist/server.js --check
```

Then restart Claude Code. (From source, `npm run build` empties `dist/` first: close Claude Code sessions that use
this checkout before building.)

## Uninstall

```sh
claude mcp remove cardano-debug              # add --scope user if you added it with that scope
rm -rf ~/.cache/cardano-debug-mcp            # the chain data cache (or your CARDANO_DEBUG_CACHE_DIR)
npm uninstall -g @cardananium/cardano-debug-mcp   # if you installed it from npm
```

For a source install, delete the cloned repository.

## How it works

Each engine (validator, debugger, decompiler) runs in its own worker thread behind a watchdog, so
a wasm crash or a runaway script never takes the server down. Chain data is fetched from Koios or
Blockfrost with retries and cached on disk; a transaction fetched by hash is replayed against the
chain state at the point it was included. Debugger positions are `{term_id, uplc_line}` in one
canonical UPLC listing per script, and the stepper uses the same protocol version and cost
models as the validator, so its budget matches the validator's on the same path. When the client
closes stdin the server still answers the calls it already received (for up to 5 seconds), stops the
workers and exits; on SIGTERM or SIGINT it stops the workers and exits at once.

## Development

```sh
npm test             # builds, then the unit tests and the end-to-end tests over stdio
npm run test:unit    # builds first (some unit tests start the built workers)
npm run test:e2e     # builds first
npm run typecheck
npm run dev          # run from source with tsx (Node ≥ 22.12)
npm run smoke        # starts dist/server.js and checks the tool list, a debugging session and a decompile; exit 1 on any failure
node dist/server.js --check
npx @modelcontextprotocol/inspector node dist/server.js
```

Running the tests: the test commands rebuild `dist/` (it is emptied first), so do not run them while
an MCP client uses the server from the same checkout. The tests start the server with a clean
environment (your `KOIOS_*`, `BLOCKFROST_*` and `CARDANO_DEBUG_*` variables are not passed on) and a
scratch cache. No test calls a chain API: tests that load a transaction by hash talk to a local
Koios stub (`test/helpers/koiosStub.ts`). The Node 20 compatibility run needs Node 20.14.0 under
nvm, or `CARDANO_DEBUG_E2E_NODE20=/path/to/node`; without it that run is reported as skipped.

Test data (transactions, scripts, addresses and chain snapshots) is built by the toolkit in
`test/fixtures/synthetic` (deterministic keys, validator-fitted fees and ex-units, scripts written in
Aiken and UPLC) and described by `test/fixtures/manifest.json`; tests read hashes and numbers from
the manifest. `npm run fixtures:build` regenerates the files, `npm run fixtures:check` verifies that
the committed ones are up to date, `npm run fixtures:compile` recompiles the scripts (needs two Aiken
compilers, see `test/fixtures/synthetic/README.md`).

To use a newer de-uplc-web, check out the commit in `deps/de-uplc-web`, then run
`npm run build:deps && npm run build`.

## License

Apache-2.0. The bundled ledger CDDL schemas come from
[cardano-ledger](https://github.com/IntersectMBO/cardano-ledger) (Apache-2.0); see `NOTICE` and
`src/assets/cddl/ATTRIBUTION.md`.
