// Engine-layer providers for the base layer's resource routes (src/providers.ts):
// `cardano-debug://session/{dbg_id}/{uplc.txt | state.json | env.json | traces.txt | profile.json}`
// and the `engines.de_uplc_engine` block of `server/info`. Registered once by `engineService(ctx)`.
//
// A session running a long command (debug_run / debug_profile) is refused instead of queued: the
// read would wait behind the run for up to its whole budget. Short commands in flight do not matter:
// the worker host queues the read behind them and a call's timeout only starts when it is dispatched.

import type { AppContext } from "../context.js";
import { providersOf, type ArtifactText, type SessionArtifactPart } from "../providers.js";
import type { SessionRecord } from "../store/sessionRegistry.js";
import { parseJsonBigintSafe, rowsJson } from "../vocab/json.js";
import type { EngineService } from "./service.js";

/** Guard on any single resource payload. */
const MAX_RESOURCE_CHARS = 16 * 1024 * 1024;

function liveClient(session: SessionRecord) {
  const client = session.client;
  if (!client || session.lost || client.lost) return undefined;
  if (session.running) throw new Error(`session ${session.dbgId} is busy (${session.running.tool} is in flight); read the resource after it returns`);
  return client;
}

export async function sessionArtifact(session: SessionRecord, part: SessionArtifactPart): Promise<ArtifactText | undefined> {
  const client = liveClient(session);
  if (!client) return undefined;
  switch (part) {
    case "uplc.txt": {
      const text = await client.uplcText();
      return { text: text.length > MAX_RESOURCE_CHARS ? text.slice(0, MAX_RESOURCE_CHARS) : text, mimeType: "text/plain", listing: true };
    }
    case "state.json": {
      const machine = JSON.parse(await client.stateJson()) as unknown;
      const view = {
        dbg_id: session.dbgId,
        mode: session.mode,
        tx_id: session.txId,
        redeemer: session.redeemer,
        script_hash: session.scriptHash,
        language: session.language,
        purpose: session.purpose,
        protocol_version: session.protocolVersion,
        term_count: session.termCount,
        term_id_base: session.termIdBase,
        uplc_lines: session.uplcLines,
        declared_ex_units: session.declaredExUnits,
        status: session.lastStatus,
        position: session.lastPosition,
        breakpoints: session.breakpoints,
        total_steps: session.totalSteps,
        version: session.version,
        machine_state: machine,
        note: "machine_state is the engine's lazy view (one level); placeholders carry _path — expand with debug_inspect what='value' path='state.<segments>'",
      };
      return { text: prettyJson(view), mimeType: "application/json" };
    }
    case "env.json": {
      const env = await client.inspect("env", { depth: 1, offset: 0, limit: 100, context_lines: 0, max_chars: MAX_RESOURCE_CHARS });
      return { text: prettyJson(env), mimeType: "application/json" };
    }
    case "traces.txt": {
      const traces = await client.tracesAll();
      return { text: traces.join("\n"), mimeType: "text/plain" };
    }
    case "profile.json": {
      const text = await client.profileJson(MAX_RESOURCE_CHARS);
      if (text === null) return undefined;
      // One row per line so ?offset=&limit= line windows can page it (the engine answers one line).
      try {
        return { text: prettyJson(parseJsonBigintSafe(text)), mimeType: "application/json" };
      } catch {
        return { text, mimeType: "application/json" };
      }
    }
    default:
      return undefined;
  }
}

/** One row per line (rowsJson): line windows (?offset=&limit=) page the JSON resources at about their compact size. */
function prettyJson(value: unknown): string {
  return rowsJson(value);
}

let registered = new WeakSet<AppContext>();

/** Plug the engine layer into the base layer's resources and server/info (idempotent per context). */
export function registerEngineProviders(ctx: AppContext, service: EngineService): void {
  if (registered.has(ctx)) return;
  registered.add(ctx);
  providersOf(ctx).register({
    sessionArtifact,
    serverInfo: () => ({ engines: { de_uplc_engine: service.info() } }),
  });
}

/** Test hook: forget registrations (a fresh context in the same process). */
export function resetEngineProviderRegistry(): void {
  registered = new WeakSet<AppContext>();
}
