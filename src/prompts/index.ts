// Prompts. In Claude Code they appear as `/cardano-debug:debug_tx (MCP)` etc.
// The texts are markdown templates in src/prompts/<name>.md with {{placeholders}} (copied to
// dist/prompts by tsup); debug_tx and replay_bundle share the steps of debug-steps.md. The steps
// name the tools exactly and point at doc sections instead of restating them.

import { readFileSync } from "node:fs";
import path from "node:path";

import { completable, type McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AppContext } from "../context.js";
import { PURPOSES } from "../vocab/purpose.js";
import { textAssetDir } from "../wasm-assets.js";

export const PROMPT_TEMPLATES = ["debug_tx", "explain_script", "diagnose_cbor", "replay_bundle", "debug-steps"] as const;
export type PromptTemplate = (typeof PROMPT_TEMPLATES)[number];

const templateCache = new Map<PromptTemplate, string>();

/** The raw template text (trailing whitespace trimmed). */
export function loadTemplate(name: PromptTemplate): string {
  let text = templateCache.get(name);
  if (text === undefined) {
    text = readFileSync(path.join(textAssetDir("prompts"), `${name}.md`), "utf8").replace(/\r\n/g, "\n").trimEnd();
    templateCache.set(name, text);
  }
  return text;
}

/** Replace every `{{key}}`; a placeholder without a value is a programming error. */
export function renderTemplate(name: PromptTemplate, vars: Record<string, string>): string {
  return loadTemplate(name).replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`prompt template ${name}: no value for {{${key}}}`);
    return value;
  });
}

function userMessage(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

const NETWORKS = ["mainnet", "preprod", "preview"];
const PROVIDERS = ["koios", "blockfrost"];
const PLUTUS_VERSIONS = ["V1", "V2", "V3"];
const ERA_PRESETS = ["conway", "babbage", "alonzo", "mary", "allegra", "shelley", "dijkstra"];

const oneOf = (values: readonly string[], description: string) =>
  completable(z.string().optional().describe(description), (value) => values.filter((v) => v.toLowerCase().startsWith(String(value ?? "").toLowerCase())));

/** Every prompt with sample arguments, rendered (tests check sizes and placeholders). */
export function renderAllPrompts(): Record<string, string> {
  return {
    debug_tx: renderDebugTx({ tx: "<tx>" }),
    explain_script: renderExplainScript({ script: "<script>" }),
    diagnose_cbor: renderDiagnoseCbor({ hex: "<hex>" }),
    replay_bundle: renderReplayBundle({ bundle: "<bundle>" }),
  };
}

const steps = () => loadTemplate("debug-steps");

function renderDebugTx(a: { tx: string; network?: string; provider?: string }): string {
  return renderTemplate("debug_tx", { tx: a.tx, network: a.network ?? "(infer, or take it from the bundle)", provider: a.provider ?? "(server default)", steps: steps() });
}

function renderExplainScript(a: { script: string; plutus_version?: string; purpose?: string }): string {
  return renderTemplate("explain_script", { script: a.script, plutus_version: a.plutus_version ?? "(detect)", purpose: a.purpose ?? "(unknown)" });
}

function renderDiagnoseCbor(a: { hex: string; cddl?: string; rule?: string }): string {
  return renderTemplate("diagnose_cbor", { hex: a.hex, cddl: a.cddl ?? "(conway preset unless the bytes say otherwise)", rule: a.rule ?? "(auto-pick)" });
}

function renderReplayBundle(a: { bundle: string }): string {
  return renderTemplate("replay_bundle", { bundle: a.bundle, steps: steps() });
}

export function registerPrompts(server: McpServer, _ctx: AppContext): void {
  // Read every template at registration so a missing file fails the server start, not a call.
  for (const name of PROMPT_TEMPLATES) loadTemplate(name);

  server.registerPrompt(
    "debug_tx",
    {
      title: "Debug a transaction end-to-end",
      description: "Load, validate and step-debug a Cardano transaction; explain the root cause with evidence and a concrete fix.",
      argsSchema: z.object({
        tx: z.string().describe("Transaction CBOR (hex/base64), a 64-hex transaction hash, or an offline bundle (JSON text or file path)."),
        network: oneOf(NETWORKS, "mainnet | preprod | preview (required unless the bundle carries it)."),
        provider: oneOf(PROVIDERS, "koios | blockfrost (default: the server's configured provider)."),
      }),
    },
    (args) => userMessage(renderDebugTx(args)),
  );

  server.registerPrompt(
    "explain_script",
    {
      title: "Explain a Plutus script",
      description: "Decompile a script to readable pseudocode and summarise what the validator checks, its datum/redeemer shapes and its failure paths; confirm doubtful spots against the exact UPLC.",
      argsSchema: z.object({
        script: z.string().describe("Script bytes (hex) or the script hash of a script known to a loaded transaction."),
        plutus_version: oneOf(PLUTUS_VERSIONS, "V1 | V2 | V3 (detected when omitted)."),
        purpose: oneOf(PURPOSES, "spend | mint | withdraw | publish | vote | propose (helps the decompiler name the validator arguments)."),
      }),
    },
    (args) => userMessage(renderExplainScript(args)),
  );

  server.registerPrompt(
    "diagnose_cbor",
    {
      title: "Diagnose CBOR bytes",
      description: "Decode CBOR bytes, validate them against a CDDL schema (era preset or your own) and explain what is wrong, where (path, byte offset, hex excerpt) and how to fix it.",
      argsSchema: z.object({
        hex: z.string().describe("The bytes: CBOR as hex (0x ok), base64 or a cardano-cli JSON envelope."),
        cddl: oneOf(ERA_PRESETS, "Schema: era preset conway (default) | babbage | alonzo | mary | allegra | shelley | dijkstra, CDDL text, or a path to a .cddl file."),
        rule: z.string().optional().describe("Root rule to validate against (transaction, transaction_body, plutus_data, …); auto-picked when omitted."),
      }),
    },
    (args) => userMessage(renderDiagnoseCbor(args)),
  );

  server.registerPrompt(
    "replay_bundle",
    {
      title: "Replay an offline bundle",
      description: "Reproduce a debugging session from a bundle_export file without network access.",
      argsSchema: z.object({ bundle: z.string().describe("Bundle JSON text or the path to the bundle file.") }),
    },
    (args) => userMessage(renderReplayBundle(args)),
  );
}
