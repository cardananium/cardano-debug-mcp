// EngineSession: everything the MCP does with ONE de-uplc `SessionController` — open, the
// run-until loop (gdb breakpoint semantics, cooperative stop flag, wall-clock deadline, exact
// trace / budget stops by coarse scan + replay), position and window rendering, lazy inspection,
// profiling with in-worker top-N reduction. It runs inside session.worker (one instance per
// worker) and, for unit tests, in-process after `initSync`.
//
// Engine facts this code relies on (session_controller.rs):
//  - `step()` returns `{term_id, status:{status_type:'Ready'|'Done'|'Error', result?|message?}}`
//    where `term_id` is the term that was CURRENT BEFORE the transition;
//  - `get_current_term_id()` is -1 in Return state, the Error term's id after a failure and the
//    last executed source term after success;
//  - `get_logs()` serialises the WHOLE trace vector on every call (so it is polled coarsely);
//  - `get_budget()` reports spent = image (i64::MAX) - remaining, plus the declared units when any;
//  - a declared budget is never enforced (`over_budget` only compares), but the machine has its own
//    safety cap (ExBudget::max(), about 1e13 cpu / 1.4e13 mem) and fails with "went over budget" past it;
//    `reset()` rebuilds the machine and bumps `version`;
//  - `get_machine_context_lazy()` copies the WHOLE continuation stack per call (cost ~ depth^2, a
//    wasm stack overflow, which poisons the instance, from about 5,600 frames): frames are read
//    only when asked for and never blindly after a cut run (see `framesForReport`).

import type { SessionController } from "@cardananium/de-uplc-engine-wasm";

import { capJson, capString, childKeys, lookupPath, normalizeContextPath, parsePath, pruneDepth } from "../tools/_shared.js";
import { integersAsStrings, parseJsonBigintSafe, toWireJson } from "../vocab/json.js";
import { isWasmTrap } from "../workers/rpc.js";
import type {
  AtFailure,
  EngineBudget,
  EngineLanguage,
  EnginePosition,
  EnvItem,
  FrameSummary,
  FramesTotal,
  InspectOptions,
  InspectWhat,
  LocateQuery,
  LocateResult,
  MachineStateKind,
  PartsConfig,
  PositionReport,
  ProfileHotTerm,
  ProfileOptions,
  ProfileReport,
  RunReport,
  RunSpec,
  SessionSummary,
  SourceWindow,
  StopKind,
  UplcWindow,
} from "./protocol.js";
import { builtinKey, closeBuiltinNames, PLUTUS_BUILTINS } from "./builtins.js";
import { ScriptIndex } from "./termIndex.js";

/** The two constructors of the engine glue this module needs (keeps tests free to pass a stub). */
export interface EngineApi {
  new_session_from_parts(config_json: string): SessionController;
  new_session_from_program(program_src: string, language: string): SessionController;
}

/** Thrown for a bad argument (unknown term id, line out of range, …); surfaces as `invalid_argument`. */
/** A context path that does not exist: the same `path_not_found` answer as tx_redeemer(part='context'). */
export class EnginePathError extends Error {
  readonly data: { code: "path_not_found"; argument: "path"; resolved: string; available?: string[] };
  constructor(message: string, resolved: string, available: string[] | undefined) {
    super(message);
    this.name = "EnginePathError";
    this.data = { code: "path_not_found", argument: "path", resolved, ...(available ? { available } : {}) };
  }
}

export class EngineInputError extends Error {
  readonly data: { code: "invalid_argument"; argument?: string };
  constructor(message: string, argument?: string) {
    super(message);
    this.name = "EngineInputError";
    this.data = argument ? { code: "invalid_argument", argument } : { code: "invalid_argument" };
  }
}

/** Thrown when the session has no script context (program-only mode). */
export class NoContextError extends Error {
  readonly data = { code: "no_script_context" } as const;
  constructor() {
    super("This session has no script context: it was opened from a bare program (no transaction, datum, redeemer or context).");
    this.name = "NoContextError";
  }
}

interface StepStatus {
  status_type: "Ready" | "Done" | "Error";
  message?: string;
  result?: unknown;
}

interface EngineBudgetRaw {
  exUnitsSpent: number | string;
  exUnitsAvailable?: number | string | null;
  memoryUnitsSpent: number | string;
  memoryUnitsAvailable?: number | string | null;
}

type Json = Record<string, unknown>;
/** A lazy-API placeholder: `{_type, _kind, _length?, _path?}` standing in for a not-yet-loaded node. */
type Placeholder = Json & { _type: unknown; _kind: unknown; _length?: unknown; _path?: unknown };

/** Steps between stop-flag / deadline checks. */
export const BATCH_STEPS = 512;
/** Steps between coarse trace / budget predicate checks (the fine replay is at most this long). */
const COARSE_STEPS = 64;
/** Placeholders expanded per `value` inspection. */
const MAX_EXPANSIONS = 48;
const DEFAULT_FRAME_ROWS = 6;
/** A stack read at or below this depth is always cheap (<= ~0.4 s): depth never exceeds the steps taken. */
const FRAMES_SAFE_DEPTH = 3_000;
/** After a run that was cut (deadline / step cap / stop) the stack is read only when it is certainly this shallow. */
const FRAMES_CUT_DEPTH = 1_000;
/** One stack read slower than this stops frames from being attached to reports (explicit reads still work). */
const FRAMES_SLOW_MS = 400;
/** Failures of the machine's own budget cap read as the declared budget being exceeded: say what it is. */
const OVER_BUDGET = /went over budget/i;

/** The engine's wording for a failed transition, made truthful where the engine's own is misleading. */
export function describeEngineFailure(message: string): string {
  if (OVER_BUDGET.test(message)) {
    return `the engine's own safety cap on a machine budget (about 1e13 cpu / 1.4e13 mem) was exceeded, not a budget you declared (budget.over_budget compares to the declared one): ${message}`;
  }
  return message;
}

export interface MachineStateSnapshot {
  kind: MachineStateKind;
  rawTermId: number;
}

/**
 * An exact-position replay (trace / budget stop) that a deadline or the stop flag cut short: the
 * machine was rewound and stands at or before `anchorSteps`, where the predicate is known false;
 * it was known true within COARSE_STEPS after the anchor (at `rewoundFrom`, roughly).
 */
interface PendingPin {
  until: "trace" | "budget" | "before_error";
  anchorSteps: number;
  /** Position the coarse scan had reached when the machine was rewound. */
  rewoundFrom: number;
  contains?: string;
  cpuTarget?: bigint;
  /** k-th matching trace (`trace`). */
  hit?: number;
  /** Trace count at the start of the run that set the pin (`trace` counts fresh lines from here). */
  logsCountBase: number;
  /** `before_error`: the failure the replay stops short of. */
  failure?: { message: string; at: EnginePosition };
}

type PinOutcome = "found" | "deadline" | "cancelled" | "diverged";

/** `cpu` of `until='budget'`: a non-negative decimal integer (number or string). */
export function parseCpuTarget(cpu: string | number): bigint {
  const text = typeof cpu === "number" ? (Number.isSafeInteger(cpu) && cpu >= 0 ? String(cpu) : "") : cpu.trim();
  if (!/^\d+$/.test(text)) throw new EngineInputError(`cpu must be a non-negative decimal integer (got ${JSON.stringify(cpu)})`, "cpu");
  return BigInt(text);
}

export class EngineSession {
  readonly script: ScriptIndex;
  readonly language: EngineLanguage;
  readonly scriptHash: string | null;
  readonly purpose: string | null;
  readonly plutusCoreVersion: string;
  readonly declared: { cpu: bigint; mem: bigint } | null;
  readonly hasContext: boolean;

  private controller: SessionController | null;
  private finished: "done" | "error" | null = null;
  private errorMessage: string | undefined;
  /** Last non-negative id `get_current_term_id()` answered (the engine says -1 in Return state). */
  private lastRawTermId: number;
  /** Cache of `holdsFinalValue()` for one engine version. */
  private finalValueCheck: { version: string; done: boolean } | null = null;
  /** The last transition started in Return state (`step()` answered term_id -1). */
  private lastStepFromReturn = false;
  /** Transitions applied since the last reset — the machine's position as a step count. */
  private stepsSinceReset = 0;
  /** Transitions applied over the session's lifetime (replays included); never rewinds. */
  private transitions = 0;
  /** Unfinished exact-position replay, continued by the next `run` with the same stop condition. */
  private pendingPin: PendingPin | null = null;
  /** How many log lines have been handed out as "new". */
  private logsReported = 0;
  private contextJsonCache: unknown | undefined;
  private lastProfileJson: string | null = null;
  /** Set once a stack read was slow: reports stop carrying frames (cleared by `reset()`). */
  private framesBlocked: string | null = null;
  /** Depth of the last stack read, and the step count it was read at (since the last rewind). */
  private framesMark: { depth: number; steps: number } | null = null;
  /** An automatic read was skipped since the last read / rewind: the depth is unknown, later automatic reads stay skipped. */
  private framesUnread = false;

  private constructor(controller: SessionController, hasContext: boolean) {
    this.controller = controller;
    this.script = ScriptIndex.fromJson(controller.get_script());
    this.language = normalizeLanguage(controller.get_plutus_language_version());
    const hash = controller.get_script_hash();
    this.scriptHash = hash ? hash : null;
    const purpose = controller.get_script_purpose();
    this.purpose = purpose ? purpose : null;
    this.plutusCoreVersion = controller.get_plutus_core_version();
    const raw = this.readBudgetRaw();
    this.declared = raw.exUnitsAvailable !== null && raw.exUnitsAvailable !== undefined && raw.memoryUnitsAvailable !== null && raw.memoryUnitsAvailable !== undefined
      ? { cpu: BigInt(raw.exUnitsAvailable), mem: BigInt(raw.memoryUnitsAvailable) }
      : null;
    this.hasContext = hasContext;
    this.lastRawTermId = controller.get_current_term_id();
  }

  static openParts(engine: EngineApi, parts: PartsConfig): EngineSession {
    const controller = engine.new_session_from_parts(JSON.stringify(parts));
    return new EngineSession(controller, Boolean(parts.context));
  }

  static openProgram(engine: EngineApi, source: string, language: EngineLanguage): EngineSession {
    const controller = engine.new_session_from_program(source, language);
    return new EngineSession(controller, false);
  }

  // ---------- lifecycle ----------

  get isFreed(): boolean {
    return this.controller === null;
  }

  free(): void {
    if (!this.controller) return;
    try {
      this.controller.free();
    } finally {
      this.controller = null;
    }
  }

  private get c(): SessionController {
    if (!this.controller) throw new Error("The session was closed.");
    return this.controller;
  }

  get version(): string {
    return String(this.c.get_version());
  }

  get stepsTotal(): number {
    return this.stepsSinceReset;
  }

  get status(): "ready" | "done" | "error" {
    return this.finished ?? "ready";
  }

  // ---------- position / budget ----------

  /**
   * True when the machine already holds its final value (the last Return landed on an empty frame
   * stack) while the engine's status is still `Ready`: the engine only reports `Done` on the NEXT
   * transition, and in that window `get_current_term_id()` answers the last computed term, which
   * would read as a phantom Compute state. One lazy root read per engine version.
   */
  private holdsFinalValue(): boolean {
    const version = String(this.c.get_version());
    if (this.finalValueCheck?.version === version) return this.finalValueCheck.done;
    let done = false;
    try {
      const state = this.stateLazy() as Json | null;
      done = state !== null && typeof state === "object" && state.machine_state_type === "Done";
    } catch (error) {
      if (isWasmTrap(error)) throw error;
      done = false;
    }
    this.finalValueCheck = { version, done };
    return done;
  }

  machineState(): MachineStateSnapshot {
    const raw = this.c.get_current_term_id();
    if (raw >= 0) this.lastRawTermId = raw;
    let kind: MachineStateKind;
    if (this.finished === "error") kind = "Error";
    else if (this.finished === "done") kind = "Done";
    else if (raw < 0) kind = "Return";
    else if (this.holdsFinalValue()) kind = "Done";
    else kind = "Compute";
    return { kind, rawTermId: raw };
  }

  /** Why `env` is empty outside Compute state, with the call that gets the model to a readable one. */
  private noEnvNote(kind: MachineStateKind): string {
    switch (kind) {
      case "Return":
        return "no environment in Return state (a value is in hand: what='value', path='state.value'; environments live in the frames: frames.N.env); step once to reach the next Compute state";
      case "Done":
        return "no environment in Done state (the machine finished); debug_run(restart=true, until='term' | 'steps' | 'builtin', …) to revisit a position";
      case "Error": {
        const before = this.stepsSinceReset - 1;
        return before >= 1
          ? `no environment in Error state (the machine replaced its state with the error; frames are empty too). Rewind to the transition before the failure: debug_run(until='steps', steps=${before}, restart=true) — for an explicit (error) term that is Compute state with the environment; for a builtin failure or a machine error it is Return state (what='value', path='state.value' = the value in hand; what='frames' shows the partially applied builtin or the application / force that fails on it, frames.N.env their environments); for a builtin, until='builtin', builtin=<name> stops on the builtin node with the environment readable`
          : "no environment in Error state (the very first transition failed; the initial term has no bindings)";
      }
      default:
        return `no environment in ${kind} state (the environment belongs to the term being computed)`;
    }
  }

  position(): EnginePosition {
    const state = this.machineState();
    const effectiveRaw = state.rawTermId >= 0 ? state.rawTermId : this.lastRawTermId;
    const info = effectiveRaw >= 0 ? this.script.infoOfRaw(effectiveRaw) : undefined;
    const last = this.lastRawTermId >= 0 ? this.script.normalize(this.lastRawTermId) : null;
    const position: EnginePosition = {
      term_id: state.rawTermId >= 0 && info ? info.term_id : null,
      raw_term_id: state.rawTermId,
      kind: info?.kind ?? null,
      uplc_line: info?.uplc_line ?? null,
      machine_state: state.kind,
      last_term_id: last,
    };
    if (info?.label !== undefined) position.label = info.label;
    return position;
  }

  private readBudgetRaw(): EngineBudgetRaw {
    return JSON.parse(this.c.get_budget()) as EngineBudgetRaw;
  }

  budget(): EngineBudget {
    const raw = this.readBudgetRaw();
    const cpu = BigInt(raw.exUnitsSpent);
    const mem = BigInt(raw.memoryUnitsSpent);
    const out: EngineBudget = { cpu_spent: cpu.toString(), mem_spent: mem.toString(), over_budget: false };
    if (this.declared) {
      out.cpu_declared = this.declared.cpu.toString();
      out.mem_declared = this.declared.mem.toString();
      out.cpu_pct = pct(cpu, this.declared.cpu);
      out.mem_pct = pct(mem, this.declared.mem);
      out.over_budget = cpu > this.declared.cpu || mem > this.declared.mem;
    }
    return out;
  }

  /** Current 1-based line, from the current term or (Return / Done) the last executed one. */
  currentLine(): number | null {
    const state = this.machineState();
    const raw = state.rawTermId >= 0 ? state.rawTermId : this.lastRawTermId;
    return raw >= 0 ? this.script.lineOfRaw(raw) : null;
  }

  windowAroundCurrent(contextLines: number, breakpointLines?: ReadonlySet<number>): UplcWindow {
    return this.script.windowAround(this.currentLine(), contextLines, { breakpointLines, maxChars: 12_000 });
  }

  summary(contextLines: number): SessionSummary {
    return {
      script_hash: this.scriptHash,
      language: this.language,
      purpose: this.purpose,
      plutus_core_version: this.plutusCoreVersion,
      term_count: this.script.count,
      term_id_base: this.script.base,
      uplc_lines: this.script.lines.length,
      longest_uplc_line: this.script.longestLine,
      declared_ex_units: this.declared ? { cpu: this.declared.cpu.toString(), mem: this.declared.mem.toString() } : null,
      has_script_context: this.hasContext,
      position: this.position(),
      budget: this.budget(),
      version: this.version,
      uplc_window: this.windowAroundCurrent(contextLines),
    };
  }

  positionReport(contextLines: number, frameRows = DEFAULT_FRAME_ROWS, breakpointLines?: ReadonlySet<number>, breakpointTermIds: readonly number[] = []): PositionReport {
    const frames = this.framesForReport(frameRows, false);
    const report: PositionReport = {
      position: this.position(),
      uplc_window: this.windowAroundCurrent(contextLines, this.breakpointLinesOf(breakpointLines, breakpointTermIds)),
      frames: frames.rows,
      frames_total: frames.total,
      budget: this.budget(),
      version: this.version,
      status: this.status,
      steps_total: this.stepsSinceReset,
    };
    if (frames.note) report.frames_note = frames.note;
    if (this.errorMessage !== undefined) report.error_message = this.errorMessage;
    return report;
  }

  /** Lines to mark `*` in a window: the given lines plus the start line of every breakpoint term id. */
  private breakpointLinesOf(lines: Iterable<number> | undefined, termIds: readonly number[]): Set<number> {
    const out = new Set<number>(lines ?? []);
    for (const id of termIds) {
      const info = this.script.infoOf(id);
      if (info) out.add(info.uplc_line);
    }
    return out;
  }

  // ---------- stepping ----------

  private stepOnce(): StepStatus {
    const result = JSON.parse(this.c.step()) as { term_id: number; status: StepStatus };
    this.stepsSinceReset++;
    this.transitions++;
    this.lastStepFromReturn = result.term_id < 0;
    if (result.term_id >= 0) this.lastRawTermId = result.term_id;
    if (result.status.status_type === "Done") this.finished = "done";
    else if (result.status.status_type === "Error") {
      this.finished = "error";
      this.errorMessage = describeEngineFailure(result.status.message ?? "the validator failed");
    }
    return result.status;
  }

  reset(): void {
    this.rewind();
    this.logsReported = 0;
    this.pendingPin = null;
    this.framesBlocked = null;
    this.framesUnread = false;
  }

  /** Whether an exact-position replay is pending (see `RunReport.pinning`). */
  get hasPendingPin(): boolean {
    return this.pendingPin !== null;
  }

  /** Raw ids to pause on: explicit term ids + every term starting on a breakpoint line. */
  private breakpointRawIds(bp: RunSpec["breakpoints"]): Set<number> {
    const ids = new Set<number>();
    for (const id of bp.term_ids) {
      const raw = this.script.denormalize(id);
      if (raw !== undefined) ids.add(raw);
    }
    for (const raw of this.script.rawIdsOnLines(bp.uplc_lines)) ids.add(raw);
    return ids;
  }

  private logsText(): string {
    return this.c.get_logs();
  }

  private logsArray(): string[] {
    return JSON.parse(this.logsText()) as string[];
  }

  /**
   * Execute until the spec's stop condition, a breakpoint, `max_steps`, the deadline or the stop
   * flag. Breakpoints are checked against the term ABOUT to execute (gdb semantics); the very first
   * term is skipped when `skip_first` so a resume steps off the breakpoint it is paused on.
   *
   * `until='trace' | 'budget'` are coarse predicates: they are evaluated every COARSE_STEPS steps
   * and, once one holds, the exact position is pinned by resetting the machine and replaying it to
   * the last anchor where the predicate was false, then single-stepping. A replay cut by the
   * deadline or the stop flag is kept as a pending pin (`pinning` in the report) and continued by
   * the next `run` with the same stop condition, so a target further than one call's wall-clock
   * budget from the start still converges; the machine never moves backwards between calls except
   * for that rewind, which the report names.
   *
   * `stop_before` (until='error' / 'done') uses the same pin for its single step back: when the
   * script fails, the machine is replayed to the transition before the failing one.
   */
  run(spec: RunSpec, stopRequested: () => boolean = () => false): RunReport {
    const breakpoints = this.breakpointRawIds(spec.breakpoints);
    const bpLines = new Set(spec.breakpoints.uplc_lines);
    const markedLines = this.breakpointLinesOf(spec.breakpoints.uplc_lines, spec.breakpoints.term_ids);
    let untilRaw: number | undefined;
    let lineRaws: Set<number> | undefined;
    let builtin: string | undefined;
    let cpuTarget: bigint | undefined;
    let stepsTarget: number | undefined;
    const notes: string[] = [];

    // Everything that can be refused is checked before anything moves (`restart` included).
    const hit = spec.hit ?? 1;
    if (!Number.isInteger(hit) || hit < 1) throw new EngineInputError("hit must be an integer >= 1", "hit");
    if (hit > 1 && spec.until !== "term" && spec.until !== "uplc_line" && spec.until !== "builtin" && spec.until !== "trace") {
      throw new EngineInputError(`hit counts visits for until='term' | 'uplc_line' | 'builtin' | 'trace'; it has no meaning for until='${spec.until}'`, "hit");
    }
    if (spec.stop_before && spec.until !== "error" && spec.until !== "done") {
      throw new EngineInputError("stop_before applies to until='error' (or 'done'): it stops one transition before the script fails", "stop_before");
    }
    switch (spec.until) {
      case "term": {
        if (spec.term_id === undefined) throw new EngineInputError("until='term' needs term_id", "term_id");
        untilRaw = this.script.denormalize(spec.term_id);
        if (untilRaw === undefined) throw new EngineInputError(`term_id ${spec.term_id} is not a node of this script (0..${this.script.count - 1})`, "term_id");
        break;
      }
      case "uplc_line": {
        if (spec.line === undefined) throw new EngineInputError("until='uplc_line' needs line", "line");
        if (spec.line < 1 || spec.line > this.script.lines.length) throw new EngineInputError(`line ${spec.line} is outside 1..${this.script.lines.length}`, "line");
        const raws = this.script.rawIdsOnLines([spec.line]);
        if (raws.length === 0) {
          const nearest = this.script.resolveLine(spec.line);
          if (!nearest) throw new EngineInputError(`no term starts on or near line ${spec.line}`, "line");
          notes.push(`no term starts on line ${spec.line}; using the nearest term (line ${nearest.uplc_line}, term ${nearest.term_id})`);
          raws.push(nearest.raw_id);
        }
        lineRaws = new Set(raws);
        break;
      }
      case "builtin": {
        if (!spec.builtin) throw new EngineInputError("until='builtin' needs builtin (e.g. divideInteger)", "builtin");
        builtin = this.resolveBuiltinName(spec.builtin).toLowerCase();
        break;
      }
      case "budget": {
        if (spec.cpu === undefined) throw new EngineInputError("until='budget' needs cpu (ex-units spent to stop at)", "cpu");
        cpuTarget = parseCpuTarget(spec.cpu);
        break;
      }
      case "steps": {
        stepsTarget = spec.steps ?? 1;
        if (stepsTarget < 1) throw new EngineInputError("steps must be >= 1", "steps");
        break;
      }
      default:
        break;
    }
    if (spec.restart) this.reset();

    const startSteps = this.stepsSinceReset;
    const transitionsAtStart = this.transitions;
    const logsAtStart = this.logsReported;
    let stopped: RunReport["stopped"] | null = null;
    let replayed = false;
    let pinning: RunReport["pinning"] | undefined;
    let beforeFailure: NonNullable<PendingPin["failure"]> | undefined;
    let visits = 0;

    // Coarse predicates (trace / budget) are evaluated every COARSE_STEPS steps; when one flips the
    // machine is reset and replayed to the last point where it was false, then single-stepped.
    const coarse = spec.until === "trace" || spec.until === "budget";
    let anchorSteps = this.stepsSinceReset;
    let logsLenAtCheck = coarse && spec.until === "trace" ? this.logsText().length : 0;
    let logsCountBase = coarse && spec.until === "trace" ? this.logsArray().length : 0;
    const contains = spec.contains;

    const tracePredicate = (): boolean => {
      const text = this.logsText();
      if (text.length === logsLenAtCheck) return false;
      const logs = JSON.parse(text) as string[];
      const fresh = logs.slice(logsCountBase);
      const matching = contains ? fresh.filter((m) => m.includes(contains)) : fresh;
      if (matching.length >= hit) return true;
      logsLenAtCheck = text.length; // nothing new that counts: skip this text until it changes again
      return false;
    };
    const budgetPredicate = (): boolean => BigInt(this.readBudgetRaw().exUnitsSpent) >= cpuTarget!;
    const predicate = spec.until === "trace" ? tracePredicate : budgetPredicate;
    const onAnchor = (): void => {
      if (spec.until === "trace") logsLenAtCheck = this.logsText().length;
    };
    const pinLabel = (pin: PendingPin): string => (pin.until === "before_error" ? "pre-failure" : pin.until);

    // Translate the outcome of a (started or continued) pin replay into the stop record.
    const settlePin = (pin: PendingPin, outcome: PinOutcome): RunReport["stopped"] => {
      if (outcome === "found") {
        replayed = true;
        if (pin.until === "before_error") {
          beforeFailure = pin.failure;
          return { kind: "error", detail: `the script fails on the next transition (${firstLine(pin.failure?.message ?? "the script failed")}); the machine stands one transition before it, state readable` };
        }
        return spec.until === "trace"
          ? { kind: "trace", detail: `${hit > 1 ? `trace #${hit}` : "trace"}${contains ? ` containing ${JSON.stringify(contains)}` : ""} emitted` }
          : { kind: "budget", detail: `cpu spent reached ${cpuTarget}` };
      }
      if (outcome === "diverged") {
        // Only possible if the machine were not deterministic; the pin is dropped, the state is real.
        if (this.finished) return { kind: this.finished, detail: `the machine finished while replaying to pin the exact ${pinLabel(pin)} position` };
        return { kind: "limit", detail: `the exact ${pinLabel(pin)} position could not be pinned by replay (the replay diverged from the scan); the machine stands at step ${this.stepsSinceReset}` };
      }
      const progress = `replayed ${this.stepsSinceReset.toLocaleString("en-US")} of ${pin.anchorSteps.toLocaleString("en-US")} steps`;
      pinning = { anchor_steps: pin.anchorSteps, rewound_from: pin.rewoundFrom, replayed_steps: this.stepsSinceReset };
      if (outcome === "cancelled") {
        return { kind: "cancelled", detail: `stopped by the host while replaying the machine to pin the exact ${pinLabel(pin)} position (${progress}); run again with the same stop condition to continue` };
      }
      return { kind: "limit", detail: `wall-clock budget reached while replaying the machine to pin the exact ${pinLabel(pin)} position (${progress}); run again with the same stop condition to continue`, reason: "deadline" };
    };

    // When a coarse predicate holds, pin the exact position by replay.
    const settleCoarse = (): RunReport["stopped"] => {
      const pin: PendingPin = { until: spec.until as "trace" | "budget", anchorSteps, rewoundFrom: this.stepsSinceReset, contains, cpuTarget, hit, logsCountBase };
      this.rewind();
      this.pendingPin = pin;
      return settlePin(pin, this.continuePin(pin, predicate, spec.deadline_at, stopRequested, onAnchor));
    };

    // The machine just failed and the caller wants the state BEFORE the failing transition.
    const settleBeforeError = (): RunReport["stopped"] => {
      const failure = { message: this.errorMessage ?? "the script failed", at: this.position() };
      const pin: PendingPin = { until: "before_error", anchorSteps: Math.max(0, this.stepsSinceReset - 1), rewoundFrom: this.stepsSinceReset, logsCountBase, failure };
      this.rewind();
      this.pendingPin = pin;
      return settlePin(pin, this.continuePin(pin, () => false, spec.deadline_at, stopRequested, () => undefined));
    };

    // A pin left unfinished by an earlier call: continue it when this call asks for the same stop,
    // otherwise abandon it (the machine stands at a real, earlier position) and say so.
    if (this.pendingPin) {
      const pin = this.pendingPin;
      const same =
        pin.until === "before_error"
          ? spec.stop_before === true && (spec.until === "error" || spec.until === "done")
          : coarse && pin.until === spec.until && (spec.until === "trace" ? (pin.contains ?? null) === (contains ?? null) && (pin.hit ?? 1) === hit : pin.cpuTarget === cpuTarget);
      if (same) {
        logsCountBase = pin.logsCountBase;
        stopped = settlePin(pin, this.continuePin(pin, pin.until === "before_error" ? () => false : predicate, spec.deadline_at, stopRequested, onAnchor));
      } else {
        this.pendingPin = null;
        notes.push(`an unfinished replay pinning the exact ${pinLabel(pin)} position was abandoned: the machine was rewound and stands at step ${this.stepsSinceReset.toLocaleString("en-US")} (it had reached ${pin.rewoundFrom.toLocaleString("en-US")})`);
      }
    }

    if (!stopped && this.finished) {
      stopped =
        this.finished === "error" && spec.stop_before
          ? settleBeforeError()
          : { kind: this.finished, detail: `the machine already finished (${this.finished}); use restart=true to run again` };
    }

    if (!stopped && spec.until === "budget" && predicate()) {
      stopped = { kind: "budget", detail: `cpu spent is already >= ${cpuTarget}; pick a larger cpu or restart` };
    }

    let check = !spec.skip_first;
    let steps = 0;
    let nextCoarseAt = coarse ? this.coarseInterval(spec.until) : 0;
    const visit = (): boolean => ++visits >= hit;
    const visitText = (): string => (hit > 1 ? ` (visit ${hit})` : "");
    while (!stopped) {
      if (steps > 0 && steps % BATCH_STEPS === 0) {
        if (stopRequested()) {
          stopped = coarse && predicate() ? settleCoarse() : { kind: "cancelled", detail: "stopped by the host (cancellation or timeout); the session is intact" };
          break;
        }
        if (Date.now() >= spec.deadline_at) {
          stopped = coarse && predicate() ? settleCoarse() : { kind: "limit", detail: `wall-clock budget reached after ${steps} steps in this call`, reason: "deadline" };
          break;
        }
      }
      if (steps >= spec.max_steps) {
        stopped = coarse && predicate() ? settleCoarse() : { kind: "limit", detail: `max_steps (${spec.max_steps}) reached; call again to continue`, reason: "max_steps" };
        break;
      }
      const cur = this.c.get_current_term_id();
      // After a Return into an empty frame stack the machine holds its final value and the engine
      // still answers the last computed term: not a Compute of that term, so no stop condition may
      // match there (the next transition reports Done). The cheap pre-check keeps the lazy read rare.
      const phantom = cur >= 0 && this.lastStepFromReturn && cur === this.lastRawTermId && this.holdsFinalValue();
      if (cur >= 0) this.lastRawTermId = cur;
      if (check && cur >= 0 && !phantom) {
        if (untilRaw !== undefined && cur === untilRaw && visit()) {
          stopped = { kind: "term", detail: `reached term ${spec.term_id}${visitText()}` };
          break;
        }
        if (lineRaws && lineRaws.has(cur) && visit()) {
          stopped = { kind: "uplc_line", detail: `reached a term starting on UPLC line ${spec.line}${visitText()}` };
          break;
        }
        if (builtin !== undefined) {
          const info = this.script.infoOfRaw(cur);
          if (info?.kind === "Builtin" && info.label?.toLowerCase() === builtin && visit()) {
            stopped = { kind: "builtin", detail: `about to evaluate builtin ${info.label}${visitText()}` };
            break;
          }
        }
        if (breakpoints.has(cur)) {
          const info = this.script.infoOfRaw(cur);
          const viaLine = info && bpLines.has(info.uplc_line);
          stopped = { kind: "breakpoint", detail: `breakpoint on ${viaLine ? `UPLC line ${info.uplc_line}` : `term ${info?.term_id ?? cur - this.script.base}`}` };
          break;
        }
      }
      check = true;

      const status = this.stepOnce();
      steps++;
      if (status.status_type === "Done") {
        stopped = coarse && predicate() ? settleCoarse() : { kind: "done", detail: spec.until === "error" ? "the script completed without an error" : "the script completed" };
        break;
      }
      if (status.status_type === "Error") {
        stopped = coarse && predicate() ? settleCoarse() : spec.stop_before ? settleBeforeError() : { kind: "error", detail: this.errorMessage ?? "the script failed" };
        break;
      }
      if (stepsTarget !== undefined && steps >= stepsTarget) {
        stopped = { kind: "steps", detail: `${steps} step${steps === 1 ? "" : "s"} executed` };
        break;
      }
      if (coarse && steps >= nextCoarseAt) {
        if (predicate()) {
          stopped = settleCoarse();
          break;
        }
        anchorSteps = this.stepsSinceReset;
        nextCoarseAt = steps + this.coarseInterval(spec.until);
      }
    }

    // New traces are those past the last report. After a rewind the machine holds fewer lines than
    // were already reported; they are identical up to that count (deterministic replay), so the
    // reported mark only ever grows until `reset()`.
    const logs = this.logsArray();
    const fresh = logs.slice(logsAtStart);
    this.logsReported = Math.max(logsAtStart, logs.length);
    const report: RunReport = {
      stopped: stopped!,
      steps_this_call: this.transitions - transitionsAtStart,
      steps_total: this.stepsSinceReset,
      status: stopped!.kind === "cancelled" ? "cancelled" : this.status,
      position: this.position(),
      uplc_window: this.windowAroundCurrent(spec.context_lines, markedLines),
      frames: [],
      frames_total: "unknown",
      budget: this.budget(),
      traces: { total: logs.length, new: fresh.slice(0, spec.max_new_traces).map((m) => capString(m, 300)), new_total: fresh.length },
      version: this.version,
    };
    // A cut run (deadline / step cap / cancel) is not read blindly: the stack may be deep and its
    // copy costs ~depth^2. The tool asks for frames explicitly (debug_inspect what='frames').
    const frames = this.framesForReport(spec.frames, stopped!.kind === "limit" || stopped!.kind === "cancelled");
    report.frames = frames.rows.slice(0, spec.frames);
    report.frames_total = frames.total;
    if (frames.note) report.frames_note = frames.note;
    if (this.errorMessage !== undefined) report.error_message = this.errorMessage;
    if (beforeFailure) {
      report.error_message = beforeFailure.message;
      report.error_at = beforeFailure.at;
      report.at_failure = this.failureContext();
    }
    if (replayed) report.replayed = true;
    if (pinning) report.pinning = pinning;
    if (this.stepsSinceReset < startSteps) report.rewound_from = startSteps;
    if (notes.length > 0) report.stopped.detail += ` (${notes.join("; ")})`;
    return report;
  }

  /** The state a stop-before-failure report adds: the value in hand (Return) or the environment (Compute). */
  private failureContext(): AtFailure {
    const out: AtFailure = {};
    const state = this.machineState();
    try {
      if (state.kind === "Compute") {
        const env = this.env(0, 8);
        out.env = { total: env.total, items: env.items, ...(env.note ? { note: env.note } : {}) };
      } else if (state.kind === "Return") {
        const detail = this.stateLazy(["value"]) as Json;
        out.value = { type: valueType(detail, detail), summary: this.valueSummary(detail), ref: "state.value" };
      }
    } catch (error) {
      if (isWasmTrap(error)) throw error;
    }
    return out;
  }

  /**
   * Steps between coarse predicate checks. The budget check is O(1); a trace check serialises the
   * whole trace vector, so its cost grows with the traces already emitted: the interval grows with
   * the run (~sqrt of the steps taken) to keep checks plus the fine search cheap in total instead of
   * quadratic in the number of traces. The fine phase covers whatever interval was in force.
   */
  private coarseInterval(until: RunSpec["until"]): number {
    return until === "trace" ? Math.max(COARSE_STEPS, Math.floor(Math.sqrt(this.stepsSinceReset))) : COARSE_STEPS;
  }

  /** Rebuild the machine at step 0 without touching the trace-report mark or a pending pin. */
  private rewind(): void {
    this.c.reset();
    this.finished = null;
    this.errorMessage = undefined;
    this.stepsSinceReset = 0;
    this.lastStepFromReturn = false;
    this.lastRawTermId = this.c.get_current_term_id();
    this.lastProfileJson = null;
    this.framesMark = null;
    this.framesUnread = false;
  }

  /**
   * Drive a pin replay from the machine's current position (already rewound, at or before the
   * anchor): re-execute up to `pin.anchorSteps` without checks (those transitions were passed
   * once already, breakpoints included), then single-step with the predicate after each step.
   * The machine is deterministic, so the state reached is exactly the one the coarse scan passed
   * over. Returns `found` (pin cleared), `deadline` / `cancelled` (pin kept, machine at a real
   * position before the anchor) or `diverged` (pin dropped; never expected).
   */
  private continuePin(pin: PendingPin, predicate: () => boolean, deadlineAt: number, stopRequested: () => boolean, onAnchor: () => void): PinOutcome {
    let i = 0;
    while (this.stepsSinceReset < pin.anchorSteps) {
      // At least one batch per call, so a caller looping on the deadline always makes progress.
      if (i > 0 && i % BATCH_STEPS === 0) {
        if (stopRequested()) return "cancelled";
        if (Date.now() >= deadlineAt) return "deadline";
      }
      const status = this.stepOnce();
      i++;
      if (status.status_type !== "Ready") {
        this.pendingPin = null;
        return "diverged";
      }
    }
    onAnchor();
    if (pin.until === "before_error") {
      // The anchor IS the target: one transition before the failing one.
      this.pendingPin = null;
      return "found";
    }
    // Fine phase: the predicate flipped between the anchor and where the coarse scan stood (or at the finishing transition).
    const fineSteps = Math.max(COARSE_STEPS * 2, pin.rewoundFrom - pin.anchorSteps + COARSE_STEPS);
    for (let k = 0; k < fineSteps && !this.finished; k++) {
      if (predicate()) {
        this.pendingPin = null;
        return "found";
      }
      this.stepOnce();
    }
    this.pendingPin = null;
    return predicate() ? "found" : "diverged";
  }

  // ---------- frames / env / values ----------

  /** One-line description of a lazily loaded value with term ids normalised to this script. */
  private valueSummary(detail: Json, placeholder?: Json): string {
    return valueSummary(detail, placeholder, (raw) => {
      const id = this.script.normalize(raw);
      const line = this.script.lineOfRaw(raw);
      return id === null ? `raw ${raw}` : line === null ? `term ${id}` : `term ${id} @ line ${line}`;
    });
  }

  private machineContextLazy(path: string[] = [], full = false): unknown {
    try {
      return JSON.parse(this.c.get_machine_context_lazy(JSON.stringify(path), full));
    } catch (error) {
      // A wasm trap (stack overflow on a very deep stack) poisons the instance: never swallow it.
      if (isWasmTrap(error)) throw error;
      return path.length === 0 ? [] : undefined;
    }
  }

  /**
   * The continuation stack, innermost first. The engine copies the whole stack per call (cost ~
   * depth^2 and a wasm stack overflow from about 5,600 frames), so a read is timed: a slow one
   * stops reports from carrying frames (`framesBlocked`) until the next `reset()`.
   */
  frames(): FrameSummary[] {
    const started = Date.now();
    const raw = this.machineContextLazy();
    const elapsed = Date.now() - started;
    const frames = this.summarizeFrames(raw);
    this.framesMark = { depth: frames.length, steps: this.stepsSinceReset };
    this.framesUnread = false;
    if (elapsed > FRAMES_SLOW_MS) {
      this.framesBlocked = `reading the stack (${frames.length} frames) took ${elapsed} ms: the engine copies the whole stack per read, so the cost grows with depth squared`;
    }
    return frames;
  }

  /** Upper bound of the stack depth: a transition pushes at most one frame, so depth <= steps since the last read. */
  private depthBound(): number {
    const mark = this.framesMark;
    return mark && mark.steps <= this.stepsSinceReset ? mark.depth + (this.stepsSinceReset - mark.steps) : this.stepsSinceReset;
  }

  /**
   * Frames for a run / position report, or why there are none. Never read after a cut run (deadline,
   * step cap, cancel) unless the stack is certainly shallow, and never again once a read was slow:
   * the model asks for them explicitly (`debug_inspect what='frames'`).
   */
  private framesForReport(rows: number, cut: boolean): { rows: FrameSummary[]; total: FramesTotal; note?: string } {
    if (rows <= 0) return { rows: [], total: "unknown" };
    if (this.finished) return { rows: [], total: 0 }; // a finished machine keeps no stack
    const explicit = "debug_inspect(what='frames') reads them on request";
    if (this.framesBlocked) return { rows: [], total: "unknown", note: `frames not attached: ${this.framesBlocked}; ${explicit}` };
    const bound = this.depthBound();
    if (bound > FRAMES_CUT_DEPTH && (cut || (this.framesUnread && bound > FRAMES_SAFE_DEPTH))) {
      this.framesUnread = true;
      return { rows: [], total: "unknown", note: `frames not read: the run was cut or the stack may be deep (up to ${bound.toLocaleString("en-US")} frames; reading it copies the whole stack, cost ~ depth^2); ${explicit}` };
    }
    const frames = this.frames();
    return { rows: frames.slice(0, rows), total: frames.length, ...(this.framesBlocked ? { note: `later reports omit frames: ${this.framesBlocked}` } : {}) };
  }

  private summarizeFrames(raw: unknown): FrameSummary[] {
    if (!Array.isArray(raw)) return [];
    const frames: FrameSummary[] = [];
    raw.forEach((frame, index) => {
      const f = frame as Json;
      const kind = typeof f.context_type === "string" ? f.context_type : "?";
      if (kind === "NoFrame") return;
      const summary: FrameSummary = { index, kind };
      const termRef = f.term as Json | undefined;
      const rawId = termRef && typeof termRef.id === "number" ? termRef.id : typeof f.term_id === "number" ? f.term_id : undefined;
      if (rawId !== undefined) {
        summary.term_id = this.script.normalize(rawId);
        summary.uplc_line = this.script.lineOfRaw(rawId);
      }
      const env = f.env as Json | undefined;
      if (env && Array.isArray(env.values)) summary.env_size = env.values.length;
      if (kind === "FrameConstr") summary.detail = `tag ${String(f.tag)}, ${Array.isArray(f.values) ? f.values.length : 0} values ready, ${Array.isArray(f.terms) ? f.terms.length : 0} terms pending`;
      if (kind === "FrameCases") summary.detail = `${Array.isArray(f.terms) ? f.terms.length : 0} branches`;
      if (kind === "FrameAwaitArg" || kind === "FrameAwaitFunValue") {
        const value = f.value as Json | undefined;
        if (value) {
          summary.detail = this.valueSummary(value);
          if (typeof value.term_id === "number" && rawId === undefined) {
            summary.term_id = this.script.normalize(value.term_id);
            summary.uplc_line = this.script.lineOfRaw(value.term_id);
          }
        }
      }
      frames.push(summary);
    });
    return frames;
  }

  private envLazy(path: string[] = [], full = false): unknown {
    return JSON.parse(this.c.get_current_env_lazy(JSON.stringify(path), full));
  }

  private stateLazy(path: string[] = [], full = false): unknown {
    return JSON.parse(this.c.get_machine_state_lazy(JSON.stringify(path), full));
  }

  env(offset: number, limit: number): { total: number; items: EnvItem[]; note?: string } {
    const state = this.machineState();
    if (state.kind !== "Compute") {
      return { total: 0, items: [], note: this.noEnvNote(state.kind) };
    }
    const env = this.envLazy() as Json;
    const values = Array.isArray(env.values) ? (env.values as Json[]) : [];
    const total = values.length;
    const lambdas = this.script.enclosingLambdas(state.rawTermId);
    const aligned = lambdas.length === total;
    const items: EnvItem[] = [];
    for (let i = offset; i < Math.min(total, offset + limit); i++) {
      const placeholder = values[i]!;
      let detail: Json = placeholder;
      try {
        detail = this.envLazy(["values", String(i)], false) as Json;
      } catch (error) {
        if (isWasmTrap(error)) throw error;
        // keep the placeholder
      }
      const item: EnvItem = {
        index: i,
        debruijn: total - i,
        type: valueType(placeholder, detail),
        summary: this.valueSummary(detail, placeholder),
        ref: `env.values.${i}`,
      };
      if (aligned) {
        const binder = lambdas[i]!;
        item.name = binder.name;
        item.binder_term_id = binder.term_id;
        item.binder_uplc_line = binder.uplc_line;
      }
      items.push(item);
    }
    const out: { total: number; items: EnvItem[]; note?: string } = { total, items };
    if (!aligned && total > 0) out.note = `${lambdas.length} enclosing lambdas vs ${total} bound values: names are not attached; debruijn 1 = innermost`;
    return out;
  }

  /**
   * Resolve a `ref` (`env.values.7.fields.1`, `frames.0.env.values.2`, `state.value`, or lazy-API
   * segments) and expand placeholders breadth-first up to `depth` levels.
   */
  value(pathInput: string | string[] | undefined, depth: number, maxChars: number): { ref: string; type: string; value: unknown; children_refs?: string[]; truncated?: boolean; expansions: number } {
    const segments = Array.isArray(pathInput) ? pathInput.map(String) : parsePath(typeof pathInput === "string" ? pathInput : undefined);
    if (segments.length === 0) throw new EngineInputError("value needs a path such as env.values.0 or frames.0.env.values.2 or state.value", "path");
    let root: "env" | "frames" | "state";
    let rest: string[];
    const head = segments[0]!.toLowerCase();
    if (head === "env") {
      root = "env";
      rest = segments.slice(1);
    } else if (head === "frames" || head === "context" || head === "frame") {
      root = "frames";
      rest = segments.slice(1);
    } else if (head === "state" || head === "machine") {
      root = "state";
      rest = segments.slice(1);
    } else if (head === "values") {
      root = "env";
      rest = segments;
    } else {
      throw new EngineInputError(`path must start with env, frames or state (got ${JSON.stringify(segments[0])})`, "path");
    }
    const fetch = (path: string[]): unknown => {
      switch (root) {
        case "env":
          return this.envLazy(path, false);
        case "frames":
          return this.machineContextLazy(path, false);
        default:
          return this.stateLazy(path, false);
      }
    };
    let node: unknown;
    try {
      node = fetch(rest);
    } catch (error) {
      if (isWasmTrap(error)) throw error;
      throw new EngineInputError(`nothing at ${segments.join(".")}: ${error instanceof Error ? error.message : String(error)}`, "path");
    }
    if (node === undefined) throw new EngineInputError(`nothing at ${segments.join(".")}`, "path");
    // Expand placeholders breadth-first.
    let expansions = 0;
    const queue: Array<{ holder: Json | unknown[]; key: string | number; level: number }> = [];
    const enqueue = (container: unknown, level: number) => {
      if (container === null || typeof container !== "object") return;
      if (Array.isArray(container)) container.forEach((v, i) => isPlaceholder(v) && queue.push({ holder: container, key: i, level }));
      else for (const [k, v] of Object.entries(container as Json)) if (isPlaceholder(v)) queue.push({ holder: container as Json, key: k, level });
    };
    const wrapper: Json = { node };
    if (isPlaceholder(node)) queue.push({ holder: wrapper, key: "node", level: 0 });
    else enqueue(node, 1);
    while (queue.length > 0 && expansions < MAX_EXPANSIONS) {
      const { holder, key, level } = queue.shift()!;
      if (level >= depth) continue;
      const placeholder = (Array.isArray(holder) ? holder[key as number] : holder[key as string]) as Json;
      const path = placeholder._path;
      if (!Array.isArray(path)) continue;
      let expanded: unknown;
      try {
        expanded = fetch(path.map(String));
        expansions++;
      } catch (error) {
        if (isWasmTrap(error)) throw error;
        continue;
      }
      if (Array.isArray(holder)) holder[key as number] = expanded;
      else holder[key as string] = expanded;
      enqueue(expanded, level + 1);
    }
    const value = wrapper.node;
    const type = typeof value === "object" && value !== null ? valueType(value as Json, value as Json) : typeof value;
    const capped = capJson(toWireJson(value), maxChars, Math.max(depth + 2, 3));
    const remaining = collectPlaceholderRefs(capped.value, root, 12);
    const out: { ref: string; type: string; value: unknown; children_refs?: string[]; truncated?: boolean; expansions: number } = {
      ref: segments.join("."),
      type,
      value: capped.value,
      expansions,
    };
    if (remaining.length > 0) out.children_refs = remaining;
    if (capped.truncated) out.truncated = true;
    return out;
  }

  // ---------- script context / traces ----------

  scriptContext(): unknown {
    if (this.contextJsonCache !== undefined) return this.contextJsonCache;
    if (!this.hasContext) throw new NoContextError();
    let text: string;
    try {
      text = this.c.get_tx_script_context();
    } catch {
      throw new NoContextError();
    }
    this.contextJsonCache = parseJsonBigintSafe(text);
    return this.contextJsonCache;
  }

  traces(offset: number, limit: number): { total: number; offset: number; items: string[]; next_offset?: number } {
    const logs = this.logsArray();
    const items = logs.slice(offset, offset + limit).map((m) => capString(m, 300));
    const out: { total: number; offset: number; items: string[]; next_offset?: number } = { total: logs.length, offset, items };
    if (offset + items.length < logs.length) out.next_offset = offset + items.length;
    return out;
  }

  /** Full trace list (resource). */
  tracesAll(): string[] {
    return this.logsArray();
  }

  // ---------- inspect dispatcher ----------

  inspect(what: InspectWhat, options: InspectOptions): Record<string, unknown> {
    switch (what) {
      case "position":
        return { ...this.positionReport(options.context_lines, DEFAULT_FRAME_ROWS) };
      case "frames": {
        const frames = this.frames();
        const items = frames.slice(options.offset, options.offset + options.limit);
        const out: Json = { total: frames.length, offset: options.offset, items, machine_state: this.machineState().kind };
        if (options.offset + items.length < frames.length) out.next_offset = options.offset + items.length;
        return out;
      }
      case "env": {
        const env = this.env(options.offset, options.limit);
        const out: Json = { total: env.total, offset: options.offset, items: env.items };
        if (env.note) out.note = env.note;
        if (options.offset + env.items.length < env.total) out.next_offset = options.offset + env.items.length;
        return out;
      }
      case "value":
        return { ...this.value(options.path, options.depth, options.max_chars) };
      case "term": {
        let raw: number | undefined;
        let termId: number | null;
        if (options.term_id !== undefined || (options.path !== undefined && options.path !== "" && !(Array.isArray(options.path) && options.path.length === 0))) {
          const fromParam = options.term_id !== undefined;
          const id = fromParam ? options.term_id! : Number.parseInt(Array.isArray(options.path) ? String(options.path![0]) : (options.path as string), 10);
          if (!Number.isInteger(id)) throw new EngineInputError("what='term' takes an optional term_id (parameter `term_id`; `path` accepted): the id of the term to show, default the current one", fromParam ? "term_id" : "path");
          raw = this.script.denormalize(id);
          if (raw === undefined) throw new EngineInputError(`term_id ${id} is not a node of this script (0..${this.script.count - 1})`, fromParam ? "term_id" : "path");
          termId = id;
        } else {
          const state = this.machineState();
          raw = state.rawTermId >= 0 ? state.rawTermId : this.lastRawTermId;
          termId = raw >= 0 ? this.script.normalize(raw) : null;
        }
        if (raw === undefined || raw < 0) return { term_id: null, uplc_text: "", note: "no current term" };
        const info = this.script.infoOfRaw(raw);
        const maxLines = Math.max(4, Math.min(400, Math.floor(options.max_chars / 40)));
        const sub = this.script.subtreeText(raw, maxLines);
        const out: Json = { term_id: termId, kind: info?.kind ?? null, uplc_line: info?.uplc_line ?? null, lines: sub.lines, uplc_text: capString(sub.text, options.max_chars) };
        if (info?.label !== undefined) out.label = info.label;
        if (sub.truncated || sub.text.length > options.max_chars) out.truncated = true;
        return out;
      }
      case "context": {
        // Same document, path grammar, integer policy and miss semantics as tx_redeemer(part='context'):
        // the version key is optional (`tx_info.inputs.0` == `tx_info.V2.inputs.0`, bare `inputs.0`
        // works), every integer is a decimal string, a miss is `path_not_found` with resolved / available.
        const context = this.scriptContext();
        const given = Array.isArray(options.path) ? options.path.map(String) : parsePath(typeof options.path === "string" ? options.path : undefined);
        const segments = context !== null && typeof context === "object" && !Array.isArray(context) ? normalizeContextPath(context as Json, given) : given;
        const hit = lookupPath(context, segments);
        if (!hit.found) {
          const available = hit.available ?? childKeys(lookupPath(context, hit.resolved).value);
          throw new EnginePathError(
            `Path ${JSON.stringify(given.join("."))} does not exist in the ScriptContext; resolved up to ${hit.resolved.join(".") || "(root)"}${available ? `; available: ${available.join(", ")}` : ""}.`,
            hit.resolved.join("."),
            available,
          );
        }
        const capped = capJson(integersAsStrings(hit.value), options.max_chars, options.depth);
        const out: Json = { path: segments.join(".") || "(root)", value: capped.value, depth: capped.depth };
        if (capped.truncated) out.truncated = true;
        const keys = childKeys(hit.value);
        if (keys) out.keys = keys;
        return out;
      }
      case "traces":
        return { ...this.traces(options.offset, options.limit) };
      case "budget":
        return { ...this.budget(), steps_total: this.stepsSinceReset, machine_state: this.machineState().kind };
      default:
        throw new EngineInputError(`unknown what ${JSON.stringify(what)}`, "what");
    }
  }

  // ---------- source / locate ----------

  sourceWindow(options: { around?: "current" | number; line_from?: number; line_to?: number; radius: number; with_ids: boolean; max_chars: number; breakpoints: RunSpec["breakpoints"] }): SourceWindow {
    const total = this.script.lines.length;
    const bpLines = new Set<number>(options.breakpoints.uplc_lines);
    for (const id of options.breakpoints.term_ids) {
      const info = this.script.infoOf(id);
      if (info) bpLines.add(info.uplc_line);
    }
    const currentLine = this.currentLine();
    const state = this.machineState();
    const currentRaw = state.rawTermId >= 0 ? state.rawTermId : this.lastRawTermId;
    const current = { term_id: currentRaw >= 0 ? this.script.normalize(currentRaw) : null, line: currentLine };
    let from: number;
    let to: number;
    if (options.line_from !== undefined || options.line_to !== undefined) {
      from = options.line_from ?? Math.max(1, (options.line_to ?? total) - 2 * options.radius);
      to = options.line_to ?? from + 2 * options.radius;
    } else if (typeof options.around === "number") {
      const info = this.script.infoOf(options.around);
      if (!info) throw new EngineInputError(`term_id ${options.around} is not a node of this script (0..${this.script.count - 1})`, "around");
      from = info.uplc_line - options.radius;
      to = info.uplc_line + options.radius;
    } else {
      const centre = currentLine ?? 1;
      from = centre - options.radius;
      to = centre + options.radius;
    }
    if (from < 1) {
      to += 1 - from;
      from = 1;
    }
    const window = this.script.window({ from, to, current: currentLine, breakpointLines: bpLines, withIds: options.with_ids, maxChars: options.max_chars });
    const out: SourceWindow = {
      total_lines: total,
      window: { line_from: window.line_from, line_to: window.line_to, dedent: window.dedent },
      current,
      lines: window.lines,
      text: window.text,
    };
    if (window.line_to < Math.min(to, total)) out.truncated = true;
    return out;
  }

  locate(query: LocateQuery): LocateResult {
    if (query.term_id !== undefined) {
      const info = this.script.infoOf(query.term_id);
      if (!info) throw new EngineInputError(`term_id ${query.term_id} is not a node of this script (0..${this.script.count - 1})`, "term_id");
      const window = this.script.windowAround(info.uplc_line, query.context_lines, { maxChars: 6_000 });
      const out: LocateResult = { term_id: info.term_id, term_kind: info.kind, uplc: { line: info.uplc_line, excerpt: window.text.split("\n") } };
      if (info.label !== undefined) out.label = info.label;
      return out;
    }
    if (query.uplc_line !== undefined) {
      if (query.uplc_line < 1 || query.uplc_line > this.script.lines.length) throw new EngineInputError(`uplc_line ${query.uplc_line} is outside 1..${this.script.lines.length}`, "uplc_line");
      const terms = this.script.termsOnLine(query.uplc_line);
      const window = this.script.windowAround(query.uplc_line, query.context_lines, { maxChars: 6_000 });
      const out: LocateResult = { uplc: { line: query.uplc_line, excerpt: window.text.split("\n") }, candidates: terms.map((t) => (t.label !== undefined ? { term_id: t.term_id, kind: t.kind, label: t.label } : { term_id: t.term_id, kind: t.kind })) };
      if (terms.length > 0) {
        // The most nested term starting here is the one a breakpoint lands on.
        const primary = terms[terms.length - 1]!;
        out.term_id = primary.term_id;
        out.term_kind = primary.kind;
        if (primary.label !== undefined) out.label = primary.label;
      } else {
        const nearest = this.script.resolveLine(query.uplc_line);
        out.note = nearest
          ? `no term starts on line ${query.uplc_line} (a closing bracket); the nearest term is ${nearest.term_id} on line ${nearest.uplc_line}`
          : `no term starts on line ${query.uplc_line}`;
        if (nearest) out.candidates = [nearest.label !== undefined ? { term_id: nearest.term_id, kind: nearest.kind, label: nearest.label } : { term_id: nearest.term_id, kind: nearest.kind }];
      }
      return out;
    }
    throw new EngineInputError("locate needs term_id or uplc_line", "term_id");
  }

  /**
   * The label of the builtin node `name` refers to in THIS script (case, underscores and spaces are
   * ignored, so pseudocode's un_constr_data finds unConstrData). An unknown name, or one the script
   * never uses, is an input error with close names instead of a run to the end that never stops.
   */
  private resolveBuiltinName(name: string): string {
    const used = new Map<string, string>();
    for (const loc of this.script.locations) {
      if (loc.kind === "Builtin" && loc.label) used.set(builtinKey(loc.label), loc.label);
    }
    const hit = used.get(builtinKey(name));
    if (hit) return hit;
    const inScript = Array.from(used.values()).sort();
    const known = PLUTUS_BUILTINS.find((b) => builtinKey(b) === builtinKey(name));
    if (known) {
      throw new EngineInputError(`builtin ${known} never occurs in this script, so until='builtin' could not stop; the script uses: ${inScript.join(", ") || "(no builtins)"}`, "builtin");
    }
    const close = closeBuiltinNames(name, [...new Set([...inScript, ...PLUTUS_BUILTINS])]);
    throw new EngineInputError(
      `unknown builtin ${JSON.stringify(name)}${close.length ? `; did you mean ${close.join(", ")}?` : ""} (names as in the UPLC listing, e.g. unConstrData; the script uses: ${inScript.join(", ") || "(no builtins)"})`,
      "builtin",
    );
  }

  // ---------- resources ----------

  uplcText(): string {
    return this.script.text;
  }

  /** The lazy machine state (one level) as JSON text. */
  stateJson(): string {
    return JSON.stringify(toWireJson(this.stateLazy()));
  }

  contextJson(maxChars: number): string {
    const text = JSON.stringify(toWireJson(this.scriptContext()));
    return text.length > maxChars ? capString(text, maxChars) : text;
  }

  profileJson(): string | null {
    return this.lastProfileJson;
  }

  // ---------- profiling ----------

  /**
   * Run the script to completion on the engine's second machine (the session's own position is
   * untouched) and reduce the report to top-N rows here, so the multi-MB JSON never leaves the
   * worker.
   */
  profile(options: ProfileOptions, stopRequested: () => boolean = () => false): ProfileReport {
    const started = Date.now();
    this.c.profile_start();
    let outcome: ProfileReport["outcome"] = "limit";
    let run: { outcome: string; steps: number; cpu: number; mem: number } | null = null;
    let stepsRun = 0;
    while (true) {
      const remaining = options.max_steps - stepsRun;
      if (remaining <= 0) {
        outcome = "limit";
        break;
      }
      run = JSON.parse(this.c.profile_run(Math.min(options.chunk_steps, remaining))) as { outcome: string; steps: number; cpu: number; mem: number };
      stepsRun = run.steps;
      if (run.outcome === "Done") {
        outcome = "done";
        break;
      }
      if (run.outcome === "Error") {
        outcome = "error";
        break;
      }
      if (stopRequested()) {
        outcome = "cancelled";
        break;
      }
      if (Date.now() >= options.deadline_at) {
        outcome = "timeout";
        break;
      }
    }
    const reportText = this.c.profile_report();
    this.lastProfileJson = reportText;
    const report = parseJsonBigintSafe(reportText) as Json;
    return this.reduceProfile(report, outcome, options, reportText.length, Date.now() - started);
  }

  private reduceProfile(report: Json, outcome: ProfileReport["outcome"], options: ProfileOptions, reportChars: number, elapsedMs: number): ProfileReport {
    const totals = (report.totals ?? {}) as Json;
    const cpu = big(totals.cpuSpent);
    const mem = big(totals.memSpent);
    const cpuLimit = totals.cpuLimit !== null && totals.cpuLimit !== undefined ? big(totals.cpuLimit) : undefined;
    const memLimit = totals.memLimit !== null && totals.memLimit !== undefined ? big(totals.memLimit) : undefined;
    const outTotals: ProfileReport["totals"] = {
      steps: String(totals.steps ?? 0),
      cpu: cpu.toString(),
      mem: mem.toString(),
      startup_cpu: String(totals.startupCpu ?? 0),
      startup_mem: String(totals.startupMem ?? 0),
      over_budget: Boolean((cpuLimit !== undefined && cpu > cpuLimit) || (memLimit !== undefined && mem > memLimit)),
    };
    if (cpuLimit !== undefined) {
      outTotals.cpu_declared = cpuLimit.toString();
      outTotals.cpu_pct = pct(cpu, cpuLimit);
    }
    if (memLimit !== undefined) {
      outTotals.mem_declared = memLimit.toString();
      outTotals.mem_pct = pct(mem, memLimit);
    }
    const terms = Array.isArray(report.terms) ? (report.terms as Json[]) : [];
    const keyOf: Record<ProfileOptions["by"], string> = { self_cpu: "selfCpu", total_cpu: "totalCpu", self_mem: "selfMem", hits: "hits" };
    const sortKey = keyOf[options.by];
    const sorted = terms.slice().sort((a, b) => cmpBig(big(b[sortKey]), big(a[sortKey])));
    const denominator = cpu - big(totals.startupCpu);
    const hot: ProfileHotTerm[] = sorted.slice(0, options.top).map((t) => {
      const rawId = Number(t.termId);
      const info = this.script.infoOfRaw(rawId);
      const row: ProfileHotTerm = {
        term_id: info ? info.term_id : rawId - this.script.base,
        kind: info?.kind ?? null,
        uplc_line: info?.uplc_line ?? null,
        excerpt: info ? this.script.oneLiner(rawId, 100) : undefined,
        hits: String(t.hits ?? 0),
        self_cpu: String(t.selfCpu ?? 0),
        self_mem: String(t.selfMem ?? 0),
        total_cpu: String(t.totalCpu ?? 0),
        total_mem: String(t.totalMem ?? 0),
        pct: pct(big(options.by === "total_cpu" ? t.totalCpu : t.selfCpu), denominator > 0n ? denominator : 1n),
      };
      if (info?.label !== undefined) row.label = info.label;
      return row;
    });
    // Per-line aggregate of self cost (the unit the model reads code in).
    const byLine = new Map<number, { cpu: bigint; mem: bigint; hits: bigint }>();
    for (const t of terms) {
      const line = this.script.lineOfRaw(Number(t.termId));
      if (line === null) continue;
      const acc = byLine.get(line) ?? { cpu: 0n, mem: 0n, hits: 0n };
      acc.cpu += big(t.selfCpu);
      acc.mem += big(t.selfMem);
      acc.hits += big(t.hits);
      byLine.set(line, acc);
    }
    const hotLines = Array.from(byLine.entries())
      .sort((a, b) => cmpBig(b[1].cpu, a[1].cpu))
      .slice(0, Math.min(options.top, 10))
      .map(([line, acc]) => {
        const first = this.script.termsOnLine(line)[0];
        const text = first ? this.script.oneLiner(first.raw_id, 120) : (this.script.lines[line - 1] ?? "").trim();
        return { uplc_line: line, self_cpu: acc.cpu.toString(), self_mem: acc.mem.toString(), hits: acc.hits.toString(), pct: pct(acc.cpu, denominator > 0n ? denominator : 1n), text: capString(text, 120) };
      });
    const builtins = (Array.isArray(report.builtins) ? (report.builtins as Json[]) : [])
      .slice()
      .sort((a, b) => cmpBig(big(b.cpu), big(a.cpu)))
      .slice(0, 20)
      .map((b) => ({ name: String(b.name), calls: String(b.calls ?? 0), cpu: String(b.cpu ?? 0), mem: String(b.mem ?? 0) }));
    const stepKinds = (Array.isArray(report.steps) ? (report.steps as Json[]) : []).map((s) => ({ kind: String(s.kind), count: String(s.count ?? 0), cpu: String(s.cpu ?? 0), mem: String(s.mem ?? 0) }));
    const timelineRaw = Array.isArray(report.timeline) ? (report.timeline as Json[]) : [];
    const timeline = sample(timelineRaw, 8).map((s) => ({ step: String(s.step ?? 0), cpu: String(s.cpu ?? 0), mem: String(s.mem ?? 0) }));
    const tracesRaw = Array.isArray(report.traces) ? (report.traces as Json[]) : [];
    const traces = {
      total: tracesRaw.length + Number(report.tracesDropped ?? 0),
      dropped: Number(report.tracesDropped ?? 0) + Math.max(0, tracesRaw.length - options.include_traces),
      items: tracesRaw.slice(0, options.include_traces).map((t) => {
        const rawId = Number(t.termId);
        return { index: Number(t.index), step: String(t.step ?? 0), message: capString(String(t.message ?? ""), 300), term_id: this.script.normalize(rawId), uplc_line: this.script.lineOfRaw(rawId) };
      }),
    };
    const out: ProfileReport = {
      outcome,
      totals: outTotals,
      hot_terms: hot,
      hot_lines: hotLines,
      builtins,
      step_kinds: stepKinds,
      timeline,
      traces,
      terms_executed: terms.length,
      report_chars: reportChars,
      elapsed_ms: elapsedMs,
    };
    const outcomeObj = totals.outcome as Json | undefined;
    if (outcomeObj && outcomeObj.outcome_type === "Error") {
      const rawId = Number(outcomeObj.termId ?? -1);
      out.error = { message: capString(describeEngineFailure(String(outcomeObj.message ?? "the script failed")), 400), term_id: rawId >= 0 ? this.script.normalize(rawId) : null, uplc_line: rawId >= 0 ? this.script.lineOfRaw(rawId) : null };
    }
    return out;
  }
}

// ---------- helpers ----------

function firstLine(text: string): string {
  return capString((text.split("\n")[0] ?? "").trim(), 160);
}

function normalizeLanguage(value: string | undefined): EngineLanguage {
  const text = (value ?? "V3").toUpperCase();
  return text === "V1" || text === "V2" ? text : "V3";
}

function pct(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  return Number((part * 10000n) / whole) / 100;
}

function big(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.trim() !== "") {
    try {
      return BigInt(value.trim());
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function cmpBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]!);
  return out;
}

function isPlaceholder(value: unknown): value is Placeholder {
  return value !== null && typeof value === "object" && !Array.isArray(value) && "_type" in (value as Json) && "_kind" in (value as Json);
}

function collectPlaceholderRefs(value: unknown, root: string, limit: number): string[] {
  const refs: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0 && refs.length < limit) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (isPlaceholder(node)) {
      const path = node._path;
      if (Array.isArray(path)) refs.push([root, ...path.map(String)].join("."));
      continue;
    }
    if (Array.isArray(node)) for (const v of node) stack.push(v);
    else for (const v of Object.values(node as Json)) stack.push(v);
  }
  return refs;
}

/** The value's shape name: `Con:Integer`, `Lambda`, `Builtin`, `Delay`, `Constr`, `Data:Constr`. */
function valueType(placeholder: Json, detail: Json): string {
  const type = typeof detail.value_type === "string" ? detail.value_type : typeof placeholder._type === "string" ? placeholder._type : "?";
  if (type === "Con") {
    const constant = detail.constant as Json | undefined;
    const ct = constant && typeof constant.type === "string" ? constant.type : typeof placeholder._kind === "string" ? placeholder._kind : undefined;
    return ct ? `Con:${ct}` : "Con";
  }
  if (type === "Data" || placeholder._type === "Data") {
    const data = (detail.data ?? detail) as Json;
    return typeof data.type === "string" ? `Data:${data.type}` : "Data";
  }
  return type;
}

/** One-line description of a lazily loaded value (from its one-level expansion, or its placeholder). */
function valueSummary(detail: Json, placeholder?: Json, describeTerm: (raw: number) => string = (raw) => `raw ${raw}`): string {
  const type = typeof detail.value_type === "string" ? detail.value_type : typeof placeholder?._type === "string" ? placeholder!._type : undefined;
  const at = typeof detail.term_id === "number" ? ` (${describeTerm(detail.term_id)})` : "";
  switch (type) {
    case "Con": {
      const constant = detail.constant as Json | undefined;
      return constant ? constantSummary(constant) : String(placeholder?._kind ?? "constant");
    }
    case "Lambda": {
      const env = detail.env as Json | undefined;
      const envSize = env && Array.isArray(env.values) ? env.values.length : undefined;
      return `λ${String(detail.parameterName ?? "?")}${at}${envSize !== undefined ? `, ${envSize} captured` : ""}`;
    }
    case "Delay":
      return `delay${at}`;
    case "Builtin": {
      const runtime = detail.runtime as Json | undefined;
      const fun = runtime && typeof runtime.fun === "string" ? runtime.fun : String(detail.fun ?? placeholder?._kind ?? "?");
      if (!runtime) return `builtin ${fun}`;
      const args = Array.isArray(runtime.args) ? runtime.args.length : 0;
      return `builtin ${fun} (${args}/${String(runtime.arity ?? "?")} args, ${String(runtime.forces ?? 0)} forces)`;
    }
    case "Constr":
      return `constr ${String(detail.tag ?? "?")} (${Array.isArray(detail.fields) ? detail.fields.length : 0} fields)${at}`;
    default:
      if (placeholder) return `${String(placeholder._type)}${placeholder._kind ? ` ${String(placeholder._kind)}` : ""}${placeholder._length ? ` [${String(placeholder._length)}]` : ""}`;
      return capString(JSON.stringify(toWireJson(detail)), 120);
  }
}

function constantSummary(constant: Json): string {
  const type = String(constant.type ?? "?");
  switch (type) {
    case "Integer":
      return String(constant.value);
    case "ByteString": {
      const hex = String(constant.value ?? "");
      return `#${hex.length > 64 ? `${hex.slice(0, 64)}… (${hex.length / 2} bytes)` : hex}`;
    }
    case "String":
      return JSON.stringify(capString(String(constant.value ?? ""), 80));
    case "Bool":
      return constant.value ? "True" : "False";
    case "Unit":
      return "()";
    case "ProtoList": {
      const values = Array.isArray(constant.values) ? constant.values : [];
      return `list[${values.length}${isPlaceholder(constant.values) ? "+" : ""}]`;
    }
    case "ProtoPair":
      return "pair";
    case "Data":
      return dataSummary((constant.data ?? constant) as Json);
    default:
      return type;
  }
}

function dataSummary(data: Json): string {
  if (isPlaceholder(data)) return `data ${String(data._kind)}${data._length ? ` [${String(data._length)}]` : ""}`;
  if ("Int" in data) return `I ${String(data.Int)}`;
  if ("BigUInt" in data) return `I ${String(data.BigUInt)}`;
  if ("BigNInt" in data) return `I -${String(data.BigNInt)}`;
  switch (data.type) {
    case "Constr": {
      const fields = Array.isArray(data.fields) ? data.fields.length : 0;
      const tag = Number(data.tag);
      const index = tag >= 121 && tag <= 127 ? tag - 121 : tag >= 1280 && tag <= 1400 ? tag - 1280 + 7 : (data.any_constructor as number | null | undefined) ?? tag;
      return `Constr ${index} [${fields} fields]`;
    }
    case "Map":
      return `Map [${Array.isArray(data.key_value_pairs) ? data.key_value_pairs.length : 0} pairs]`;
    case "Array":
      return `List [${Array.isArray(data.values) ? data.values.length : 0}]`;
    case "BoundedBytes": {
      const hex = String(data.value ?? "");
      return `B #${hex.length > 64 ? `${hex.slice(0, 64)}… (${hex.length / 2} bytes)` : hex}`;
    }
    default:
      return "data";
  }
}
