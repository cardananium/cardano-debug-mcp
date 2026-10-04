// Size caps and the no-duplication rule for every model-facing text: doc sections and topic
// indexes, the error catalogue, prompt templates, tool / parameter descriptions and the server
// instructions. The tools/list catalogue as a whole is measured over stdio (test/e2e/server.e2e.test.ts).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { allSections, DOC_TOPICS, docsDir, getTopic, loadErrors } from "../../src/docs/index.js";
import { loadTemplate, PROMPT_TEMPLATES, renderAllPrompts } from "../../src/prompts/index.js";
import { SERVER_INSTRUCTIONS } from "../../src/server.js";
import { TOOL_TEXT } from "../../src/tools/descriptions.js";

const CAPS = {
  section: 2_500,
  topicIndex: 1_200,
  promptTemplate: 2_500,
  toolDescription: 600,
  paramDescription: 300,
  instructions: 1_600,
} as const;

/** Every model-facing text as [where, text]. */
function sources(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const s of allSections()) out.push([`docs ${s.topic}/${s.slug}`, s.text]);
  for (const topic of DOC_TOPICS) out.push([`docs ${topic}/index`, `${getTopic(topic).when}\n${getTopic(topic).summary}`]);
  for (const [name, entry] of loadErrors()) for (const [field, value] of Object.entries(entry)) if (typeof value === "string") out.push([`error ${name}.${field}`, value]);
  for (const name of PROMPT_TEMPLATES) out.push([`prompt ${name}`, loadTemplate(name)]);
  for (const [tool, text] of Object.entries(TOOL_TEXT)) {
    out.push([`tool ${tool}`, text.description]);
    for (const [param, description] of Object.entries(text.params as Record<string, string>)) out.push([`tool ${tool}.${param}`, description]);
  }
  out.push(["server instructions", SERVER_INSTRUCTIONS]);
  return out;
}

/** Sentences and lines of at least `min` characters, whitespace-normalised. */
function longSentences(text: string, min = 80): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z`(])/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= min);
}

describe("model-facing text caps", () => {
  it("each doc section file <= 2,500 characters, each topic index.md <= 1,200", () => {
    for (const s of allSections()) expect(s.file_chars, `${s.topic}/${s.slug}`).toBeLessThanOrEqual(CAPS.section);
    for (const topic of DOC_TOPICS) expect(getTopic(topic).file_chars, `${topic}/index.md`).toBeLessThanOrEqual(CAPS.topicIndex);
  });

  it("each prompt template <= 2,500 characters, every placeholder filled, rendered prompts stay small", () => {
    for (const name of PROMPT_TEMPLATES) expect(loadTemplate(name).length, name).toBeLessThanOrEqual(CAPS.promptTemplate);
    const files = readdirSync(path.join(docsDir(), "..", "prompts")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
    expect(files).toEqual([...PROMPT_TEMPLATES].sort());
    for (const [name, text] of Object.entries(renderAllPrompts())) {
      expect(text, name).not.toMatch(/\{\{/);
      expect(text.length, name).toBeLessThan(3_500);
    }
  });

  it("each tool description <= 600 characters and each parameter description <= 300", () => {
    for (const [tool, text] of Object.entries(TOOL_TEXT)) {
      expect(text.description.length, tool).toBeLessThanOrEqual(CAPS.toolDescription);
      expect(text.title.length, tool).toBeLessThan(60);
      for (const [param, description] of Object.entries(text.params as Record<string, string>)) expect(description.length, `${tool}.${param}`).toBeLessThanOrEqual(CAPS.paramDescription);
    }
  });

  it("server instructions <= 1,600 characters: routing first, docs pointers", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(CAPS.instructions);
    expect(SERVER_INSTRUCTIONS.indexOf("tx_load")).toBeLessThan(SERVER_INSTRUCTIONS.indexOf("docs(error=<Name>)"));
    for (const topic of DOC_TOPICS) expect(SERVER_INSTRUCTIONS, topic).toContain(topic === "validation-errors" ? "docs(error=<Name>)" : topic);
  });

  it("every tool's parameters are described in the table and nothing else is", async () => {
    // The registered schemas read their texts from TOOL_TEXT: a key without a parameter is a stale row.
    const { ALL_TOOLS } = await import("../../src/tools/index.js");
    expect(ALL_TOOLS.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_TEXT).sort());
    const sourceDir = path.join(docsDir(), "..", "tools");
    for (const [tool, text] of Object.entries(TOOL_TEXT)) {
      const source = readFileSync(path.join(sourceDir, `${tool}.ts`), "utf8");
      for (const param of Object.keys(text.params)) {
        const used = tool === "docs" ? source.includes(`T.params.${param}`) : source.includes(`T.params[${JSON.stringify(param)}]`);
        expect(used, `${tool}.${param} is not used by the schema`).toBe(true);
      }
    }
  });
});

describe("no duplicated text", () => {
  it("no sentence or line of 80+ characters appears in two places (docs, errors, prompts, tool texts, instructions)", () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [where, text] of sources()) {
      for (const sentence of new Set(longSentences(text))) {
        const first = seen.get(sentence);
        if (first !== undefined && first !== where) duplicates.push(`${first} and ${where}: ${sentence.slice(0, 120)}`);
        else seen.set(sentence, where);
      }
    }
    expect(duplicates).toEqual([]);
  });
});
