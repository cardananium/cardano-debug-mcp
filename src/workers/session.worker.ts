// session.worker: one de-uplc engine instance, exactly one debug session. The main thread
// compiles the engine wasm once (`new WebAssembly.Module`) and hands the module through
// `workerData` (structured clone); `initSync({module})` instantiates it here without touching
// the network or the file system (the glue's default `init()` is never called).
//
// Every handler is synchronous and runs on this thread only; the host serialises calls. Long
// loops (`run`, `profile`) poll the shared stop flag every batch, so a host timeout or a client
// cancellation stops them cooperatively and leaves the session intact; a hard kill by the host
// (unresponsive builtin) loses the worker and with it the session.

import * as engine from "@cardananium/de-uplc-engine-wasm";

import { EngineSession } from "../engine/session-core.js";
import type {
  EngineLanguage,
  InspectOptions,
  InspectWhat,
  LocateQuery,
  PartsConfig,
  ProfileOptions,
  RunSpec,
  SourceWindowOptions,
} from "../engine/protocol.js";
import { SESSION_WORKER_MODULE_KEY } from "../engine/protocol.js";
import { getWorkerData, serveWorker, stopRequested } from "./rpc-worker.js";

let session: EngineSession | null = null;
let engineReady = false;

function initEngine(): void {
  if (engineReady) return;
  const data = getWorkerData<Record<string, unknown>>();
  const module = data[SESSION_WORKER_MODULE_KEY];
  const WA = (globalThis as unknown as { WebAssembly: { Module: abstract new () => WebAssembly.Module } }).WebAssembly;
  if (!(module instanceof WA.Module)) {
    throw new Error(`session.worker: workerData.${SESSION_WORKER_MODULE_KEY} must be a compiled WebAssembly.Module`);
  }
  engine.initSync({ module: module as WebAssembly.Module });
  engineReady = true;
}

function requireSession(): EngineSession {
  if (!session || session.isFreed) throw new Error("No session is open in this worker (call open_parts / open_program first).");
  return session;
}

function replaceSession(next: EngineSession): EngineSession {
  if (session && !session.isFreed) session.free();
  session = next;
  return next;
}

const handlers = {
  /** Open a parts / tx-mode session. Returns the SessionSummary. */
  open_parts: (parts: PartsConfig, contextLines = 6) => replaceSession(EngineSession.openParts(engine, parts)).summary(contextLines),
  /** Open a program-only session from UPLC text or script hex. */
  open_program: (source: string, language: EngineLanguage, contextLines = 6) => replaceSession(EngineSession.openProgram(engine, source, language)).summary(contextLines),
  summary: (contextLines = 6) => requireSession().summary(contextLines),
  run: (spec: RunSpec) => requireSession().run(spec, stopRequested),
  position: (contextLines = 6, frames = 6, breakpointLines: number[] = [], breakpointTermIds: number[] = []) =>
    requireSession().positionReport(contextLines, frames, new Set(breakpointLines), breakpointTermIds),
  inspect: (what: InspectWhat, options: InspectOptions) => requireSession().inspect(what, options),
  source_window: (options: SourceWindowOptions) => requireSession().sourceWindow(options),
  locate: (query: LocateQuery) => requireSession().locate(query),
  profile: (options: ProfileOptions) => requireSession().profile(options, stopRequested),
  reset: (contextLines = 6) => {
    const s = requireSession();
    s.reset();
    return s.positionReport(contextLines);
  },
  /** Resources: whole artefacts, fetched on demand. */
  uplc_text: () => requireSession().uplcText(),
  state_json: () => requireSession().stateJson(),
  context_json: (maxChars: number) => requireSession().contextJson(maxChars),
  traces_all: () => requireSession().tracesAll(),
  profile_json: (maxChars: number) => {
    const text = requireSession().profileJson();
    if (text === null) return null;
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  },
  close: () => {
    if (session && !session.isFreed) session.free();
    session = null;
    return true;
  },
  engine_info: () => ({ engine: "@cardananium/de-uplc-engine-wasm", ready: engineReady, session_open: session !== null && !session.isFreed }),
};

serveWorker(handlers, {
  init: initEngine,
  info: () => ({ engine: "@cardananium/de-uplc-engine-wasm", node: process.version }),
});
