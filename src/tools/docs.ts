// docs: the built-in domain reference for the model (src/docs/<topic>/NN-<slug>.md + errors.json).
//   docs()                       -> the topics, one line each
//   docs(topic)                  -> that topic's index: summary + every section with its gist and size
//   docs(topic?, section)        -> one section file (number, slug or heading; exact > prefix > substring)
//   docs(error)                  -> one error / warning catalogue entry
//   docs(query, topic?)          -> substring search over the section files (with context) and the catalogue
// The same texts are the cardano-debug://docs[/{topic}[/{section}]] resources.
//
// Exception to the text == structuredContent convention: a section is answered as plain markdown in
// the text block (readable, not sent twice); structuredContent carries only its metadata.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AppContext, ToolModule } from "../context.js";
import {
  allSections,
  DOC_TOPICS,
  errorNamesByGroup,
  findError,
  findSection,
  getTopic,
  loadDocs,
  loadErrors,
  searchErrors,
  searchSections,
  type DocSection,
  type DocTopic,
} from "../docs/index.js";
import { TOOL_TEXT } from "./descriptions.js";
import { fail, ok, resourceLink, type ResourceLink, type ToolResult } from "./_shared.js";

const QUERY_MAX_BLOCKS = 30;
const QUERY_MAX_CHARS = 12_000;
const T = TOOL_TEXT.docs;

const inputSchema = z.object({
  topic: z.enum(DOC_TOPICS).optional().describe(T.params.topic!),
  section: z.string().optional().describe(T.params.section!),
  error: z.string().optional().describe(T.params.error!),
  query: z.string().optional().describe(T.params.query!),
});

type Args = z.infer<typeof inputSchema>;

const topicLink = (topic: DocTopic): ResourceLink => resourceLink(`cardano-debug://docs/${topic}`, `docs ${topic}`, "text/markdown", `${getTopic(topic).title}: summary and sections`);
const sectionUri = (s: DocSection) => `cardano-debug://docs/${s.topic}/${s.slug}`;

function indexResult(): ToolResult {
  const topics = Array.from(loadDocs().values()).map((t) => ({ topic: t.id, title: t.title, when: t.when, sections: t.sections.length }));
  return ok(
    { topics, error_names: loadErrors().size, usage: "docs(topic) lists its sections; docs(topic, section) reads one; docs(error=<Name>) explains an error or warning name; docs(query=…) searches every section and the error catalogue." },
    { links: [resourceLink("cardano-debug://docs", "docs index", "text/markdown", "Markdown index of the built-in docs")] },
  );
}

function topicResult(topic: DocTopic): ToolResult {
  const t = getTopic(topic);
  const body: Record<string, unknown> = {
    topic,
    title: t.title,
    summary: t.summary,
    sections: t.sections.map((s) => ({ section: s.slug, title: s.title, gist: s.gist, chars: s.chars })),
    usage: `docs(topic='${topic}', section=<section>) reads one section (also by number or heading).`,
  };
  if (topic === "validation-errors") {
    body.errors = errorNamesByGroup();
    body.usage = `${body.usage as string} docs(error=<Name>) explains one name.`;
  }
  return ok(body, { links: [topicLink(topic)] });
}

function sectionResult(args: Args): ToolResult {
  const wanted = args.section!.trim();
  const match = findSection(wanted, args.topic);
  if (!match) {
    const available = (args.topic ? getTopic(args.topic).sections : allSections()).map((s) => (args.topic ? s.slug : `${s.topic}/${s.slug}`));
    return fail({
      code: "invalid_argument",
      message: `No section matches ${JSON.stringify(wanted)}${args.topic ? ` in ${args.topic}` : ""}; pick one of the available ids, or use query=… for a full-text search.`,
      argument: "section",
      available,
    });
  }
  const s = match.section;
  const siblings = getTopic(s.topic).sections;
  const at = siblings.indexOf(s);
  const meta: Record<string, unknown> = { topic: s.topic, section: s.slug, title: s.title, matched_by: match.how, chars: s.chars, resource: sectionUri(s) };
  if (at > 0) meta.previous = siblings[at - 1]!.slug;
  if (at + 1 < siblings.length) meta.next = siblings[at + 1]!.slug;
  if (match.also.length > 0) meta.also_matching = match.also.slice(0, 10);
  const link = resourceLink(sectionUri(s), `docs ${s.topic}/${s.slug}`, "text/markdown", s.title);
  // Markdown once, as the text block; the metadata in structuredContent (see the header comment).
  return { content: [{ type: "text", text: s.text }, link], structuredContent: { ...meta, resources: [{ uri: link.uri, name: link.name, mimeType: link.mimeType }] } };
}

function errorResult(args: Args): ToolResult {
  const found = findError(args.error!);
  if (!found.entry) {
    return fail({
      code: "invalid_argument",
      message: `No catalogue entry is named ${JSON.stringify(args.error!.trim())}${found.similar.length > 0 ? "; close names are listed" : ""}. docs(topic='validation-errors') lists every name; docs(query=…) searches the entries.`,
      argument: "error",
      similar: found.similar,
    });
  }
  return ok({ name: found.name!, ...found.entry, more: "docs(topic='validation-errors') for how results are surfaced, phase-2 sub-cases and defaults_applied." });
}

function queryResult(args: Args): ToolResult {
  const query = args.query!.trim();
  if (query.length < 2) return fail({ code: "invalid_argument", message: "query must be at least 2 characters.", argument: "query" });
  let sections = args.topic ? getTopic(args.topic).sections : allSections();
  if (args.section?.trim()) {
    const match = findSection(args.section.trim(), args.topic);
    if (!match) return sectionResult(args);
    sections = [match.section];
  }
  const result = searchSections(sections, query, { context: 2, maxBlocks: QUERY_MAX_BLOCKS, maxChars: QUERY_MAX_CHARS });
  const errors = !args.topic || args.topic === "validation-errors" ? searchErrors(query) : { total: 0, names: [] };
  const body: Record<string, unknown> = {
    query,
    scope: { topic: args.topic ?? "all", ...(sections.length === 1 ? { section: sections[0]!.slug } : {}) },
    total_matches: result.total_matches,
    blocks_returned: result.blocks.length,
    blocks: result.blocks,
    legend: "lines starting with '> ' match, '  ' are context; line numbers are within the section; read a whole section with docs(topic, section)",
  };
  if (errors.total > 0) body.errors = { total: errors.total, names: errors.names, read: "docs(error=<Name>)" };
  if (result.truncated) {
    body.truncated = true;
    body.hint = `${result.total_matches} matching lines, ${result.blocks.length} blocks shown (cap: ${QUERY_MAX_BLOCKS} blocks / ${QUERY_MAX_CHARS.toLocaleString("en-US")} chars of block text): narrow with topic / section or a longer query.`;
  }
  if (result.total_matches === 0 && errors.total === 0) body.hint = "No line or catalogue entry contains the query; try a shorter form, or docs() for the topics.";
  return ok(body);
}

/** Dispatch on the arguments present: error > query > section > topic > index. */
export function answerDocs(args: Args): ToolResult {
  if (args.error !== undefined && args.error.trim() !== "") return errorResult(args);
  if (args.query !== undefined && args.query.trim() !== "") return queryResult(args);
  if (args.section !== undefined && args.section.trim() !== "") return sectionResult(args);
  if (args.topic) return topicResult(args.topic);
  return indexResult();
}

export const docsTool: ToolModule = {
  name: "docs",
  register(server: McpServer, _ctx: AppContext) {
    // Parse at registration so a malformed or missing doc fails the server start, not a call.
    loadDocs();
    loadErrors();
    server.registerTool(
      "docs",
      {
        title: T.title,
        description: T.description,
        inputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        _meta: { "anthropic/maxResultSizeChars": 120_000 },
      },
      async (args) => answerDocs(args),
    );
  },
};
