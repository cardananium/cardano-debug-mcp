// Model-facing tool texts, in one table: each tool's title, description (what it does, key
// arguments, when to call it, the docs section with the details) and its parameter descriptions
// (`a.b` keys for nested object properties). Detailed rules live in the docs (topic 'tools' and the
// domain topics), not here: tests cap a description at 600 characters, a parameter at 300, and the
// whole tools/list catalogue.

export interface ToolText {
  title: string;
  description: string;
  params: Record<string, string>;
}

const ROWS = "Rows per page";

export const TOOL_TEXT = {
  docs: {
    title: "Built-in Cardano / Plutus / debugger docs",
    description:
      "Built-in reference docs, checked against this server's ledger CDDL, validator and CEK engine: call BEFORE guessing. docs() = topics; docs(topic) = sections + gists; docs(topic, section) = one section; docs(error=<Name>) = an error / warning; docs(query=…) = search. Topics: debug-playbook, validation-errors, tx-anatomy, script-context, uplc-cek, cbor-cddl, cips, tools.",
    params: {
      topic: "Topic: answers its summary and section list.",
      section: "Section id, number or heading (prefix / substring; 'topic/section' works); without topic all topics are searched.",
      error: "Error or warning name, e.g. FeeTooSmallUTxO.",
      query: "Case-insensitive substring search (context lines, matching error names; capped).",
    },
  },
  cbor_decode: {
    title: "Decode Cardano CBOR",
    description:
      "Decode any Cardano CBOR (PlutusData, address, script, witness set, transaction, unknown bytes); no handle needed. as: auto (default), a ledger type, raw (positional tree: `at: 'offset+length'`, oddities) or spans (paged rows {path, type, offset, length} for ui_link cbor_span). No typed candidate: `structural` + `closest_schema`. Schema check: cbor_validate.",
    params: {
      hex: "Hex (0x optional), base64, cardano-cli envelope, bech32 (address / stake / script / key) or base58 Byron address.",
      as: "'auto' (default), a ledger type (PlutusData, Address, Transaction, Redeemer, PlutusScript, NativeScript, …), 'raw' (positional tree) or 'spans' (every node's byte span, paged).",
      path: "JSON pointer (/a/b/0) or dotted path (a.b.0) to zoom into; as='raw' / 'spans' also take a CBOR path ($[0][2]).",
      depth: "Max levels; omitted: as many as fit the budget (10k chars; >= 6: 100k). spans: levels below path (default all).",
      offset: "as='spans': first row (default 0).",
      limit: "as='spans': rows per page (default 50, max 100).",
      plutus_version: "as='PlutusScript': its language (exact hash; inferred from an envelope).",
      schema: "PlutusData rendering: detailed (default; {constructor, fields}, {int}, …) or basic (plain JSON).",
    },
  },
  cbor_validate: {
    title: "Validate CBOR against CDDL",
    description:
      "Validate CBOR bytes against a CDDL schema: what is wrong and where. Schema: era preset (conway default, babbage, alonzo, mary, allegra, shelley, dijkstra), CDDL text or a .cddl path; `rule` = root, else admissible roots are tried. valid: true | false | null (not examined); errors[] (path, byte offset, hex excerpt, CDDL fragment); hints[]. Typed view: cbor_decode; schemas: cddl_check. docs(topic='cbor-cddl').",
    params: {
      hex: "Hex (0x optional), base64, or a cardano-cli envelope.",
      cddl: "Era preset (default conway), CDDL text, or a .cddl path.",
      rule: "Root rule (transaction, transaction_body, plutus_data, block, …); omitted: up to 12 admissible roots.",
      max_errors: "Mismatch rows (default 10, max 50); the rest count in additional_count.",
      decode: "Include `decoded`, the CDDL-labelled JSON (default true).",
      include_raw: "Include `raw`, the positional tree with byte spans `at: 'offset+length'` (default false).",
      path: "Zooms `decoded`: JSON pointer or dotted path (/transaction_body/2). A `$` path ($[0][2]) zooms `raw`.",
      raw_path: "Zooms `raw` only (a `$` path or JSON pointer); wins over `path` for raw.",
      depth: "Max levels in decoded / raw (default: as many as fit each 6,000-char window, breadth-first).",
    },
  },
  cddl_check: {
    title: "Check a CDDL schema",
    description:
      "Check a CDDL schema (text, .cddl path or era preset): does it parse, does every name resolve? Answers the error with line / col / snippet and an outline whose roots_by_kind lists the roots cbor_validate tries; rule=<name> adds its definition and uses, format=true the pretty-printed schema. Use it before cbor_validate with your own schema.",
    params: {
      cddl: "CDDL text, a .cddl path, or an era preset.",
      rule: "A rule: its definition, uses, root-ability and admitted CBOR root kinds.",
      format: "Include `formatted`, the pretty-printed schema windowed by offset / limit.",
      offset: "First line (0-based) of the formatted window.",
      limit: "Lines in the formatted window (default 200).",
    },
  },
  tx_inspect: {
    title: "Inspect a transaction section",
    description:
      "Show one section of a decoded transaction (WHAT it does; WHY it fails is tx_validate); inputs carry resolved UTxOs after tx_load, raw_json takes any path. Pass tx_id, or tx_cbor (creates a tx_id, no chain data).",
    params: {
      tx_id: "Handle from tx_load. Either tx_id or tx_cbor.",
      tx_cbor: "Transaction CBOR (hex / base64 / envelope); a tx_id is created (no chain data).",
      network: "Network for tx_cbor (inferred from addresses).",
      section: "Which part to show (default body).",
      offset: "First row (default 0).",
      limit: `${ROWS} (default 20, max 100).`,
      path: "raw_json only: JSON pointer or dotted path into the decoded transaction.",
      depth: "Depth of datum / metadata trees (default 3).",
    },
  },
  tx_load: {
    title: "Load a transaction",
    description:
      "CALL THIS FIRST: load a transaction and what validating and debugging it needs; pass its tx_id to every tx_* / debug_open call. Exactly one of tx_cbor, tx_hash (fetched), bundle. Lists redeemers, scripts, missing UTxOs, warnings. Provider trouble: tx_hash answers auth_failed | rate_limited | provider_error | offline + `next`; tx_cbor still loads (bytes only, `warning`).",
    params: {
      tx_cbor: "Transaction CBOR: hex, base64 or a cardano-cli envelope.",
      tx_hash: "64-hex transaction hash, fetched from the provider (needs network).",
      bundle: "bundle_export output (JSON text or file path), a de-uplc DebuggerContext JSON, or a cquisitor share link.",
      network: "Required with tx_hash; inferred for tx_cbor; a bundle has its own (a differing value overrides it, with a warning).",
      provider: "Chain data provider (default: server config); keys come from the server environment. Ignored while a chain state is loaded (add refresh=true).",
      refresh: "Bypass every cache and fetch again (a cached state of a pending tx keeps its old tip slot and spent flags).",
    },
  },
  tx_validate: {
    title: "Validate a transaction",
    description:
      "THE 'why does the tx fail' tool: phase 1 (ledger rules: name, location, hint) and phase 2 (every redeemer, real cost models: success, error, declared vs calculated ex-units, traces). verdict: valid | phase1_failed | phase2_failed | both_failed | incomplete_context | timeout | not_examined. docs(error=<Name>); next steps: docs(topic='debug-playbook', section='verdict-decision-tree').",
    params: {
      tx_id: "From tx_load.",
      tx_cbor: "Or the transaction CBOR (creates a tx_id; fetches chain state).",
      network: "Network for tx_cbor (inferred).",
      provider: "Provider for a fresh fetch (default: server config).",
      phases: "both (default) | phase1 (scripts still run; only phase 1 shown).",
      refresh: "Re-fetch the chain state and re-validate.",
      timeout_ms: "Evaluation budget in ms (default 90000, max 300000).",
    },
  },
  tx_redeemer: {
    title: "Inspect one redeemer",
    description:
      "One redeemer of a tx (validates first if needed). part: summary (script, target, ex-units, decoded redeemer / datum) | error (category, hint, within_budget) | traces | context (ScriptContext by path) | script | links. Context fields: docs(topic='script-context').",
    params: {
      tx_id: "From tx_load.",
      redeemer: "Ref <purpose>:<index>, e.g. spend:0, mint:1, withdraw:0 (aliases accepted).",
      part: "Default summary.",
      path: "context: dotted path or JSON pointer (tx_info.inputs.2, purpose; version key optional).",
      depth: "context: tree depth (default 2).",
      offset: "traces: first trace (default 0).",
      limit: "traces: per page (default 50).",
      filter: "traces: substring to keep (case-insensitive).",
      decode_data: "summary: decode redeemer / datum to JSON (default true).",
    },
  },
  tx_add_witnesses: {
    title: "Add witnesses and re-validate",
    description:
      "Add signatures to a loaded tx and re-validate on the same chain context (body unchanged, nothing refetched): vkey / bootstrap witnesses, a wallet signTx witness set, or a signed tx. Returns added / duplicates / invalid, the added key hashes (compare with MissingVKeyWitnesses), a short verdict.",
    params: {
      tx_id: "From tx_load.",
      witnesses: "Witnesses, a TransactionWitnessSet or a signed tx; each hex, base64 or a cardano-cli envelope.",
      revalidate: "Re-validate (default true).",
    },
  },
  bundle_export: {
    title: "Export an offline bundle",
    description:
      "Export a loaded tx with its chain data (UTxOs, parameters, accounts, governance, provider rows) and validation as a self-contained offline bundle; tx_load(bundle=…) replays it without network, elsewhere or after a restart (good for bug reports). Inline only when < 60 KB and inline=true; else a path and a resource link.",
    params: {
      tx_id: "From tx_load.",
      include_validation: "Embed the validation result with per-redeemer bytes (default true).",
      inline: "Inline JSON when < 60 KB (default false).",
    },
  },
  script_decompile: {
    title: "Decompile a Plutus script",
    description:
      "Read a Plutus script as Aiken-like pseudocode (dehosk) or exact UPLC: the preferred way to see what a validator checks, so call it early. Script by `script`, tx_id + script_hash, script_hash + network, or dbg_id. Paged (120 lines, max 600). // Info / // Warning notes say what is guessed; its line numbers are never debugger positions.",
    params: {
      script: "Script hex in any wrapping (flat, CBOR, double CBOR, ScriptRef), base64, or an envelope.",
      dbg_id: "The script of this session (a UPLC-text session has no bytes: pass script).",
      tx_id: "Loaded tx holding the script; with script_hash.",
      script_hash: "28-byte hex hash: with tx_id, that tx's script; alone (+ network) loaded txs and the chain.",
      network: "Network for a chain lookup.",
      plutus_version: "V1 | V2 | V3 if known (else from the tx / session).",
      purpose: "spend | mint | withdraw | publish | vote | propose if known (else from the tx).",
      view: "pseudocode (default) | uplc (exact, `[f a b]`) | uplc_canonical (`[[f a] b]`).",
      from_line: "First line (1-based; default 1).",
      lines: "Lines (default 120, max 600).",
      options: "Pseudocode options; defaults = the de-uplc-web preset.",
      "options.split_purposes": "auto (default) | always | never.",
      "options.applied_kind": "compile (default) | runtime | auto | count of runtime args.",
      refresh: "Bypass the cache and any decompile_failed marker.",
    },
  },
  script_locate: {
    title: "Translate term id <-> UPLC line",
    description:
      "Translate CEK term_id <-> line of the canonical UPLC listing, for a session (dbg_id) or a bare script. Exactly one of term_id (answers its uplc_line and an excerpt) or uplc_line (answers every term starting there).",
    params: {
      dbg_id: "Session handle (ids match debug_run positions).",
      script: "Without dbg_id: UPLC text, or script hex in any wrapping, base64 or cardano-cli envelope (a throwaway session).",
      plutus_version: "V1 | V2 | V3 for `script` (default: the envelope / ScriptRef version, else V3).",
      term_id: "Normalised term id.",
      uplc_line: "1-based UPLC listing line.",
      context_lines: "Excerpt lines around it (default 6).",
    },
  },
  debug_open: {
    title: "Open a CEK debug session",
    description:
      "Open a CEK step-debugging session: dbg_id, start position {term_id, uplc_line}, UPLC window, declared budget. Preferred: tx_id + redeemer after tx_validate (the validator's exact bytes and settings). Else script + plutus_version with context / redeemer_data / datum, or script alone (program-only); reopen=<dbg_id> rebuilds a gone session.",
    params: {
      tx_id: "Handle from tx_load; with `redeemer`.",
      redeemer: "Ref <purpose>:<index>, e.g. spend:0, mint:1 (aliases accepted).",
      script: "UPLC text '(program …' or script hex (flat / CBOR / double CBOR), base64, cardano-cli envelope or ScriptRef; alone = program-only.",
      plutus_version: "V1 | V2 | V3 (default V3): builtin semantics, default cost model.",
      context: "ScriptContext PlutusData CBOR hex (or the engine's ScriptContext JSON), applied last.",
      redeemer_data: "Redeemer PlutusData CBOR hex (V1/V2; V3 has it in the context).",
      datum: "Spend datum PlutusData CBOR hex (V1/V2 spend).",
      cost_models: "Flat cost-model list (decimal strings or numbers); default: the engine's.",
      protocol_major: "Protocol major for costing (default 11).",
      ex_units: "Declared {steps, mem}: enables budget % and over_budget.",
      purpose: "Label for a parts session whose context does not decode.",
      reopen: "A gone dbg_id (evicted, expired, lost): rebuild it from its kept inputs; nothing else needed.",
      allow_program_only: "Allow a session without arguments (default true).",
      context_lines: "UPLC lines around the start (default 6).",
    },
  },
  debug_run: {
    title: "Run a debug session to a stop condition",
    description:
      "Run to a stop condition (`until`) and report: position {term_id, uplc_line}, UPLC window, frames, budget, new traces, tx-mode parity. stopped.kind: the until kind, or error | done | breakpoint | limit (call again) | cancelled. To debug a failure: until='error' + stop_before=true (state before it, value / env in the reply). Stop rules: docs(topic='debug-playbook', section='stop-conditions').",
    params: {
      dbg_id: "Session from debug_open.",
      until: "error | done | steps (`steps`) | term (`term_id`) | uplc_line (`line`) | trace (`contains`) | builtin (`builtin`) | budget (`cpu`).",
      steps: "CEK transitions (default 1).",
      term_id: "Normalised term id.",
      line: "1-based UPLC listing line.",
      contains: "Substring of the trace message.",
      builtin: "A builtin the script uses, e.g. divideInteger (case / underscores ignored).",
      cpu: "Cpu spent at which to stop (decimal).",
      hit: "term | uplc_line | builtin | trace: stop at the N-th visit / trace instead of the first (default 1).",
      stop_before: "until='error' | 'done': stop one transition before the failure, with the value in hand or the environment in the reply.",
      restart: "Rewind to the start first (ids and lines stay valid; traces and counters reset).",
      max_steps: "Step cap (default 2,000,000, max 50,000,000).",
      timeout_ms: "Budget in ms (default 60000, max 110000).",
      context_lines: "UPLC lines around the stop (default 6).",
      breakpoints: "Persistent breakpoints to add.",
      "breakpoints.term_ids": "Normalised term ids.",
      "breakpoints.uplc_lines": "1-based lines where a term starts.",
      clear_breakpoints: "Drop every breakpoint before adding `breakpoints`.",
    },
  },
  debug_inspect: {
    title: "Inspect the machine state of a debug session",
    description:
      "Look at the machine state without moving it: position, frames, env (only in Compute state), value (expand a ref), term, context (ScriptContext by path), traces, budget. After an error use debug_run(until='error', stop_before=true) first. States and frames: docs(topic='uplc-cek').",
    params: {
      dbg_id: "Session from debug_open.",
      what: "View (env index 0 = outermost).",
      path: "value: a ref (env.values.N…, frames.N.…, state.value); context: a ScriptContext path.",
      term_id: "term: the term to show (default: the current one).",
      depth: "Levels to expand (default 2, max 5).",
      offset: "frames / env / traces: first row (default 0).",
      limit: "frames / env / traces: rows (default 20, max 100).",
      context_lines: "position: UPLC lines around (default 6).",
    },
  },
  debug_source: {
    title: "Show the UPLC listing around a position",
    description:
      "The session's canonical UPLC listing (one term per line) around the current position, a term or a line range; its line numbers are the uplc_line of every debug_* tool. '>' current, '*' breakpoint; with_ids adds term ids. find='unListData' | '#9e3c…' | 'msg' lists matching lines with their term_id: the anchor for a pseudocode fragment. Also session/{dbg_id}/uplc.txt (400-line windows).",
    params: {
      dbg_id: "Session from debug_open.",
      around: "'current' (default) or a term_id to centre on.",
      line_from: "Window start (1-based); overrides around. With find: first line searched.",
      line_to: "Window end (inclusive). With find: last line searched.",
      radius: "Lines each side (default 20, max 200).",
      with_ids: "Add lines[] = {n, term_ids}: the terms starting on each line (the text is not repeated).",
      max_chars: "Text cap (default 12000).",
      find: "Instead of a window: case-insensitive substring (constant #9e3c…, builtin unListData, string text). Answers matching lines {line, term_id, kind, text} and matches_total.",
      max_matches: "With find: matches returned (default 20, max 100).",
    },
  },
  debug_profile: {
    title: "Profile the session's script",
    description:
      "Run the script to the end on a second machine (the session does not move): cpu / mem per UPLC line, term and builtin, spent vs declared, every trace with its term / line and, on failure, the failing term: the shortest path to a crash site or a hot spot.",
    params: {
      dbg_id: "Session from debug_open.",
      top: "Hot terms (default 15).",
      by: "Hot-term ranking (default self_cpu); total_* adds static descendants.",
      max_steps: "Step cap (default 5,000,000).",
      timeout_ms: "Budget in ms (default 60000).",
      include_traces: "Traces to include (default 50).",
    },
  },
  ui_link: {
    title: "Link into cquisitor / de-uplc-web",
    description:
      "Build a link into cquisitor (tx validator, CBOR, CDDL tabs) or de-uplc-web (debugger, decompiler) with highlighted, annotated targets; open=true shows it to the user. Source: tx_id (+ redeemer), cbor (not hex) with cddl / rule / preset, dbg_id or script; from= generates annotations. Copy `url` verbatim, or give link_file when too long to inline. cardano-cbor tab: no annotations.",
    params: {
      app: "cquisitor | de_uplc (debugger) | decompiler.",
      tab: "cquisitor tab; default inferred from the source.",
      tx_id: "Loaded tx; + redeemer for de_uplc / decompiler.",
      redeemer: "Ref, e.g. spend:0.",
      dbg_id: "Debug session.",
      script: "Script hex (de_uplc program-only, decompiler).",
      plutus_version: "V1 | V2 | V3 for script.",
      cbor: "CBOR hex of the CBOR / CDDL tabs (named cbor here, not hex).",
      network: "Network tag of the cardano-cbor tab (default: the tx_id's, else mainnet).",
      cddl: "CDDL tab schema: era name, text or .cddl path (default conway). An era is sent as the app's preset (short link) unless a cddl_range / cddl_rule target needs the text.",
      rule: "CDDL root rule (default: as cbor_validate picks).",
      preset: "The app's own era schema instead of cddl (no cddl_range).",
      annotations: "[{target, label?, hint?, severity?}]; targets are checked against the bytes / tx / session: rejected ones come back in dropped.",
      from: "Generate annotations: validation (tx_id errors), cbor_errors (cbor_validate rows), session (dbg_id failing term + position), profile (the hottest terms of the session's last debug_profile).",
      focus: "Annotation shown first (yours, then generated).",
      open: "Open in the user's browser (default false): true when showing it to the user, not for a link to share.",
      decompile_options: "script_decompile options, so pseudo_line targets match its lines.",
    },
  },
  debug_close: {
    title: "Close debug session(s)",
    description:
      "Close a debug session (or 'all') and terminate its worker. Optional: sessions expire after 30 min idle / 4 h.",
    params: {
      dbg_id: "Session handle from debug_open, or 'all'.",
    },
  },
} satisfies Record<string, ToolText>;

export type ToolName = keyof typeof TOOL_TEXT;
