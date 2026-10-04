// Wire types between the main thread (tools / EngineService) and session.worker. Plain data only:
// everything here crosses `postMessage` (structured clone), so no classes, bigints as decimal
// strings, and no engine objects.
//
// Term ids on this wire are NORMALISED: `term_id = uniq_id - term_id_base`, where the base is the
// smallest id in the session's `get_script()` tree. The engine's uniq ids are process-global and
// monotonic (a second session in the same process starts where the first stopped), so the raw
// numbers mean nothing to the model; ordinals are stable for one script across sessions and
// across the engine / decompiler instances.

export type EngineLanguage = "V1" | "V2" | "V3";

/** `PartsConfig` exactly as `new_session_from_parts` deserialises it (debugger_engine.rs). */
export interface PartsConfig {
  /** Validator: hex (CBOR / double-CBOR / raw flat) or UPLC text starting with `(`. */
  script: string;
  /** "v1" | "v2" | "v3" (the engine lower-cases and defaults to V3). */
  language: string;
  /** ScriptContext as PlutusData CBOR hex, applied last. */
  context?: string;
  /** Redeemer PlutusData CBOR hex, applied after the datum (V1/V2 only). */
  redeemer?: string;
  /** Spend datum PlutusData CBOR hex, applied first (V1/V2 spend only). */
  datum?: string;
  /** Flat cost-model parameter list of the script's language. Omitted => engine built-in default. */
  cost_models?: number[];
  /** Declared ex-units as `[cpu, mem]` (both non-negative) — anything else is ignored by the engine. */
  ex_units?: [number, number];
  /** Protocol major version (selects PV-aware costing when `cost_models` is given). */
  protocol_version?: number;
  /** Free-form purpose label override ("Spending", "spend", …). */
  purpose?: string;
}

export type MachineStateKind = "Compute" | "Return" | "Done" | "Error";

/**
 * Where the machine is. `term_id` is null when the current term is not a node of the source (a
 * discharged value in Done state) or in Return state. `{term_id, uplc_line}` is the only positional
 * coordinate system of the server: `uplc_line` is a 1-based line of the canonical one-term-per-line
 * UPLC listing (debug_source / session/{dbg_id}/uplc.txt); decompiled pseudocode has no positions.
 */
export interface EnginePosition {
  term_id: number | null;
  /** Raw engine uniq id (-1 in Return state). For diagnostics only. */
  raw_term_id: number;
  kind: string | null;
  label?: string;
  /** 1-based line in the canonical UPLC rendering. */
  uplc_line: number | null;
  machine_state: MachineStateKind;
  /** Last source term id that executed (what `term_id` falls back to in Return / Done). */
  last_term_id: number | null;
}

export interface EngineBudget {
  cpu_spent: string;
  mem_spent: string;
  cpu_declared?: string;
  mem_declared?: string;
  cpu_pct?: number;
  mem_pct?: number;
  over_budget: boolean;
}

export interface UplcWindowLine {
  /** 1-based line number. */
  n: number;
  /** `>` current line, `*` breakpoint, `>*` both, `` otherwise. */
  marker: string;
  text: string;
  /** Normalised ids of the terms starting on this line (when requested). */
  term_ids?: number[];
}

export interface UplcWindow {
  total_lines: number;
  line_from: number;
  line_to: number;
  /** Columns of common indentation removed from every line of the window. */
  dedent: number;
  lines: UplcWindowLine[];
  /** Rendered as one string with `n> text` rows (what the model reads first). */
  text: string;
}

export interface FrameSummary {
  /** 0 = innermost continuation. */
  index: number;
  kind: string;
  term_id?: number | null;
  uplc_line?: number | null;
  env_size?: number;
  /** For FrameConstr: tag; values/terms counts. */
  detail?: string;
}

export interface SessionSummary {
  script_hash: string | null;
  language: EngineLanguage;
  purpose: string | null;
  plutus_core_version: string;
  term_count: number;
  term_id_base: number;
  uplc_lines: number;
  longest_uplc_line: number;
  declared_ex_units: { cpu: string; mem: string } | null;
  has_script_context: boolean;
  position: EnginePosition;
  budget: EngineBudget;
  version: string;
  uplc_window: UplcWindow;
}

/** Stop conditions of `debug_run`. Positions are always UPLC coordinates (`term_id` / `uplc_line` of the canonical listing). */
export type UntilKind = "error" | "done" | "steps" | "term" | "uplc_line" | "trace" | "builtin" | "budget";

export type StopKind =
  | "error"
  | "done"
  | "steps"
  | "term"
  | "uplc_line"
  | "trace"
  | "builtin"
  | "budget"
  | "breakpoint"
  | "limit"
  | "cancelled";

export interface RunSpec {
  until: UntilKind;
  steps?: number;
  term_id?: number;
  line?: number;
  contains?: string;
  builtin?: string;
  /** Decimal string or number: stop once cpu spent >= this. */
  cpu?: string | number;
  /** k-th visit (default 1) of `term` / `uplc_line` / `builtin`, k-th matching trace for `trace`; counted from this call's start. */
  hit?: number;
  /** `until='error'` / `'done'`: when the script fails, stop one transition BEFORE the failing one (the machine stays readable). */
  stop_before?: boolean;
  /** Rewind to step 0 first, once the rest of the spec has been validated (an invalid call moves nothing). */
  restart?: boolean;
  /** Cap on steps for THIS call. */
  max_steps: number;
  /** Absolute wall-clock deadline (Date.now() ms); the worker returns `limit` when reached. */
  deadline_at: number;
  breakpoints: { term_ids: number[]; uplc_lines: number[] };
  /** Do not treat the very first term as a breakpoint hit (resume semantics). */
  skip_first: boolean;
  context_lines: number;
  frames: number;
  max_new_traces: number;
}

/** Frame count of a report: a number, or "unknown" when reading the stack was skipped or failed (see `frames_note`). */
export type FramesTotal = number | "unknown";

/** What a stopped-before-failure report adds: the value in hand (Return state) or the environment (Compute state). */
export interface AtFailure {
  value?: { type: string; summary: string; ref: string };
  env?: { total: number; items: EnvItem[]; note?: string };
}

export interface RunReport {
  stopped: { kind: StopKind; detail: string; reason?: "deadline" | "max_steps" };
  /** Transitions executed by this call, replayed ones included (never negative). */
  steps_this_call: number;
  /** The machine's position: transitions since the last reset / restart. */
  steps_total: number;
  status: "ready" | "done" | "error" | "cancelled";
  error_message?: string;
  position: EnginePosition;
  uplc_window: UplcWindow;
  frames: FrameSummary[];
  frames_total: FramesTotal;
  /** Why `frames` is empty although the stack may not be (reading it was skipped or too slow). */
  frames_note?: string;
  budget: EngineBudget;
  traces: { total: number; new: string[]; new_total: number };
  version: string;
  /** True when this call replayed the machine from the start to pin an exact trace/budget position (and finished doing so). */
  replayed?: boolean;
  /**
   * Set while such a replay is unfinished: the machine was rewound to step 0 and re-executed
   * `replayed_steps` of the `anchor_steps` it must reach before the fine search; the next run with
   * the same stop condition continues it (a different one abandons it).
   */
  pinning?: { anchor_steps: number; rewound_from: number; replayed_steps: number };
  /** `steps_total` at the start of the call when the call left the machine before it (a rewind). */
  rewound_from?: number;
  /** `stop_before`: where the machine failed (the report's own `position` is one transition earlier). */
  error_at?: EnginePosition;
  at_failure?: AtFailure;
}

export interface PositionReport {
  position: EnginePosition;
  uplc_window: UplcWindow;
  frames: FrameSummary[];
  frames_total: FramesTotal;
  frames_note?: string;
  budget: EngineBudget;
  version: string;
  status: "ready" | "done" | "error";
  error_message?: string;
  steps_total: number;
}

export type InspectWhat = "position" | "frames" | "env" | "value" | "term" | "context" | "traces" | "budget";

export interface InspectOptions {
  /** `ref` string (`env.values.7.fields.1`) or lazy-API segments. */
  path?: string | string[];
  /** what='term': the term to show (alias of a term id in `path`). */
  term_id?: number;
  depth: number;
  offset: number;
  limit: number;
  context_lines: number;
  max_chars: number;
}

export interface EnvItem {
  index: number;
  /** Parameter name of the binding lambda, when the enclosing-lambda chain lines up with the env. */
  name?: string;
  /** 1 = innermost binding (what `Var` de Bruijn indices count from). */
  debruijn: number;
  binder_term_id?: number;
  binder_uplc_line?: number;
  type: string;
  summary: string;
  ref: string;
}

export interface SourceWindowOptions {
  around?: "current" | number;
  line_from?: number;
  line_to?: number;
  radius: number;
  with_ids: boolean;
  max_chars: number;
  breakpoints: { term_ids: number[]; uplc_lines: number[] };
}

export interface SourceWindow {
  total_lines: number;
  window: { line_from: number; line_to: number; dedent: number };
  current: { term_id: number | null; line: number | null };
  lines: UplcWindowLine[];
  text: string;
  truncated?: boolean;
}

export interface LocateQuery {
  term_id?: number;
  uplc_line?: number;
  context_lines: number;
}

export interface LocateResult {
  term_id?: number;
  term_kind?: string;
  label?: string;
  uplc: { line: number; excerpt: string[] } | null;
  /** For a line query: every term starting on that line. */
  candidates?: Array<{ term_id: number; kind: string; label?: string }>;
  note?: string;
}

export interface ProfileOptions {
  top: number;
  by: "self_cpu" | "total_cpu" | "self_mem" | "hits";
  max_steps: number;
  deadline_at: number;
  include_traces: number;
  chunk_steps: number;
}

export interface ProfileHotTerm {
  term_id: number;
  kind: string | null;
  label?: string;
  uplc_line: number | null;
  /** Compact one-line UPLC of the node's subtree. */
  excerpt?: string;
  hits: string;
  self_cpu: string;
  self_mem: string;
  total_cpu: string;
  total_mem: string;
  pct: number;
}

export interface ProfileReport {
  outcome: "done" | "error" | "limit" | "timeout" | "cancelled";
  error?: { message: string; term_id: number | null; uplc_line: number | null };
  totals: {
    steps: string;
    cpu: string;
    mem: string;
    startup_cpu: string;
    startup_mem: string;
    cpu_declared?: string;
    mem_declared?: string;
    cpu_pct?: number;
    mem_pct?: number;
    over_budget: boolean;
  };
  hot_terms: ProfileHotTerm[];
  hot_lines: Array<{ uplc_line: number; self_cpu: string; self_mem: string; hits: string; pct: number; text: string }>;
  builtins: Array<{ name: string; calls: string; cpu: string; mem: string }>;
  step_kinds: Array<{ kind: string; count: string; cpu: string; mem: string }>;
  timeline: Array<{ step: string; cpu: string; mem: string }>;
  traces: { total: number; dropped: number; items: Array<{ index: number; step: string; message: string; term_id: number | null; uplc_line: number | null }> };
  terms_executed: number;
  report_chars: number;
  elapsed_ms: number;
}

/** `workerData` keys the session worker expects. */
export const SESSION_WORKER_MODULE_KEY = "engineModule";
