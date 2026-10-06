// Built-in domain docs for the model, one file per section:
//   src/docs/<topic>/index.md        front matter `when:`, `# Title`, one-paragraph summary
//   src/docs/<topic>/NN-<slug>.md    front matter `gist:`, `# Heading`, the section body
//   src/docs/errors.json             the error / warning catalogue (name -> entry)
// Parsed once per process and served by the `docs` tool (src/tools/docs.ts) and the
// cardano-debug://docs[/{topic}[/{section}]] resources (src/resources.ts). tsup copies the tree to
// dist/docs; docsDir() locates it in both run modes (tsx src/server.ts and dist).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { textAssetDir } from "../wasm-assets.js";

export const DOC_TOPICS = ["tx-anatomy", "script-context", "uplc-cek", "validation-errors", "debug-playbook", "cbor-cddl", "cips", "tools"] as const;
export type DocTopic = (typeof DOC_TOPICS)[number];

export function isDocTopic(value: unknown): value is DocTopic {
  return typeof value === "string" && (DOC_TOPICS as readonly string[]).includes(value);
}

export interface DocSection {
  topic: DocTopic;
  /** Two-digit order number from the file name ("03"). */
  n: string;
  /** File name without the number and extension ("collateral"): the section id. */
  slug: string;
  /** The `# Heading` text. */
  title: string;
  /** One line: what the section answers (front matter `gist:`). */
  gist: string;
  /** The served markdown: `# Heading` + body (front matter removed). */
  text: string;
  chars: number;
  /** Size of the file on disk (front matter included): what the per-file cap measures. */
  file_chars: number;
}

export interface ParsedTopic {
  id: DocTopic;
  title: string;
  /** One line: when to read the topic (index.md front matter `when:`). */
  when: string;
  /** The paragraph(s) after the title in index.md. */
  summary: string;
  /** index.md as served (front matter removed). */
  text: string;
  file_chars: number;
  sections: DocSection[];
}

export interface ErrorEntry {
  phase: 1 | 2;
  kind: "error" | "warning";
  group: string;
  meaning: string;
  causes?: string;
  inspect?: string;
  fix?: string;
  node_may_accept?: string;
  /** false: the library declares the name but no check produces it. */
  emitted?: false;
}

/** Split `---\nkey: value\n---\n` front matter from a markdown file. */
export function parseFrontMatter(markdown: string): { meta: Record<string, string>; body: string } {
  const text = markdown.replace(/\r\n/g, "\n");
  const meta: Record<string, string> = {};
  if (!text.startsWith("---\n")) return { meta, body: text.trim() };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { meta, body: text.trim() };
  for (const line of text.slice(4, end).split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { meta, body: text.slice(end + 5).trim() };
}

/** `# Title` on the first line -> {title, rest}; else the fallback title. */
function splitTitle(body: string, fallback: string): { title: string; rest: string } {
  const lines = body.split("\n");
  if (lines[0]?.startsWith("# ")) return { title: lines[0].slice(2).trim(), rest: lines.slice(1).join("\n").trim() };
  return { title: fallback, rest: body };
}

export const SECTION_FILE = /^(\d{2})-([a-z0-9-]+)\.md$/;

/** Parse one section file (exported for tests). */
export function parseSection(topic: DocTopic, fileName: string, markdown: string): DocSection {
  const m = SECTION_FILE.exec(fileName);
  if (!m) throw new Error(`docs: ${topic}/${fileName} is not named NN-<slug>.md`);
  const { meta, body } = parseFrontMatter(markdown);
  const { title } = splitTitle(body, m[2]!);
  return { topic, n: m[1]!, slug: m[2]!, title, gist: meta.gist ?? "", text: body, chars: body.length, file_chars: markdown.length };
}

/** Parse a topic's index.md (exported for tests). */
export function parseTopicIndex(topic: DocTopic, markdown: string, sections: DocSection[]): ParsedTopic {
  const { meta, body } = parseFrontMatter(markdown);
  const { title, rest } = splitTitle(body, topic);
  return { id: topic, title, when: meta.when ?? "", summary: rest, text: body, file_chars: markdown.length, sections };
}

/** Directory holding the doc tree (src/docs in dev, dist/docs after build). */
export function docsDir(): string {
  return textAssetDir("docs");
}

let cache: Map<DocTopic, ParsedTopic> | null = null;
let errorCache: Map<string, ErrorEntry> | null = null;

/** Every topic with its sections, parsed once per process (a missing or malformed file is a startup error). */
export function loadDocs(): Map<DocTopic, ParsedTopic> {
  if (cache) return cache;
  const root = docsDir();
  const docs = new Map<DocTopic, ParsedTopic>();
  for (const topic of DOC_TOPICS) {
    const dir = path.join(root, topic);
    const files = readdirSync(dir).filter((f) => SECTION_FILE.test(f)).sort();
    const sections = files.map((f) => parseSection(topic, f, readFileSync(path.join(dir, f), "utf8")));
    if (new Set(sections.map((s) => s.slug)).size !== sections.length) throw new Error(`docs: duplicate section slug in ${topic}`);
    docs.set(topic, parseTopicIndex(topic, readFileSync(path.join(dir, "index.md"), "utf8"), sections));
  }
  cache = docs;
  return docs;
}

export function getTopic(topic: DocTopic): ParsedTopic {
  return loadDocs().get(topic)!;
}

export function allSections(): DocSection[] {
  return Array.from(loadDocs().values()).flatMap((t) => t.sections);
}

/** The error / warning catalogue, in file order. */
export function loadErrors(): Map<string, ErrorEntry> {
  if (errorCache) return errorCache;
  const raw = JSON.parse(readFileSync(path.join(docsDir(), "errors.json"), "utf8")) as Record<string, ErrorEntry>;
  errorCache = new Map(Object.entries(raw));
  return errorCache;
}

/** One catalogue entry by name (case-insensitive); `similar` lists close names when there is none. */
export function findError(name: string): { name?: string; entry?: ErrorEntry; similar: string[] } {
  const wanted = name.trim().toLowerCase();
  const errors = loadErrors();
  for (const [key, entry] of errors) if (key.toLowerCase() === wanted) return { name: key, entry, similar: [] };
  const stem = wanted.slice(0, 6);
  const similar = Array.from(errors.keys()).filter((n) => {
    const lower = n.toLowerCase();
    return (wanted.length >= 3 && lower.includes(wanted)) || (stem.length >= 4 && lower.startsWith(stem));
  });
  return { similar: similar.slice(0, 12) };
}

/** Names grouped by catalogue group (the validation-errors topic answer lists them). */
export function errorNamesByGroup(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, entry] of loadErrors()) (out[entry.group] ??= []).push(name);
  return out;
}

/** One-line rendering of an entry (the search target). */
export function errorLine(name: string, entry: ErrorEntry): string {
  const parts = [`${name} (phase ${entry.phase} ${entry.kind}${entry.emitted === false ? ", never emitted" : ""}): ${entry.meaning}`];
  if (entry.causes) parts.push(`Causes: ${entry.causes}`);
  if (entry.inspect) parts.push(`Inspect: ${entry.inspect}`);
  if (entry.fix) parts.push(`Fix: ${entry.fix}`);
  if (entry.node_may_accept) parts.push(`Node: ${entry.node_may_accept}`);
  return parts.join(" ");
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .replace(/^#+\s*/, "")
    .replace(/[\s_-]+/g, " ")
    .trim();
}

export interface SectionMatch {
  section: DocSection;
  /** Other sections that also matched, as `topic/slug`, for the model to refine. */
  also: string[];
  how: "number" | "exact" | "prefix" | "substring";
}

const MATCH_RANK: Record<SectionMatch["how"], number> = { number: 0, exact: 0, prefix: 1, substring: 2 };

/**
 * Find a section by number ("3", "03"; with a topic), slug or heading (case-insensitive; `-`, `_` and
 * spaces equal): exact, then prefix, then substring. `topic/slug` is accepted. Without a topic every
 * topic is searched and the best match kind wins (topic order breaks ties).
 */
export function findSection(query: string, topic?: DocTopic): SectionMatch | undefined {
  let wanted = query.trim();
  let scope: DocTopic | undefined = topic;
  const slash = wanted.indexOf("/");
  if (slash > 0 && isDocTopic(wanted.slice(0, slash))) {
    scope = wanted.slice(0, slash) as DocTopic;
    wanted = wanted.slice(slash + 1);
  }
  const candidates = scope ? getTopic(scope).sections : allSections();
  const norm = normalize(wanted);
  if (!norm) return undefined;
  const hits: Array<{ section: DocSection; how: SectionMatch["how"] }> = [];
  for (const section of candidates) {
    const keys = [normalize(section.slug), normalize(section.title)];
    if (scope && /^\d{1,2}$/.test(wanted) && Number(wanted) === Number(section.n)) hits.push({ section, how: "number" });
    else if (keys.some((k) => k === norm)) hits.push({ section, how: "exact" });
    else if (keys.some((k) => k.startsWith(norm))) hits.push({ section, how: "prefix" });
    else if (keys.some((k) => k.includes(norm))) hits.push({ section, how: "substring" });
  }
  if (hits.length === 0) return undefined;
  hits.sort((a, b) => MATCH_RANK[a.how] - MATCH_RANK[b.how]);
  const [best, ...rest] = hits;
  return { section: best!.section, how: best!.how, also: rest.map((h) => `${h.section.topic}/${h.section.slug}`) };
}

export interface SearchOptions {
  /** Lines of context on each side of a matching line (default 2). */
  context?: number;
  /** Cap on the number of blocks returned (default 30). */
  maxBlocks?: number;
  /** Cap on the total characters of block text (default 12,000); the JSON envelope is not counted. */
  maxChars?: number;
}

export interface SearchBlock {
  topic: DocTopic;
  /** Section id (slug) of the file holding the block. */
  section: string;
  /** 1-based first and last line of the block within the section text. */
  line_from: number;
  line_to: number;
  /** The block's lines; matching lines start with `> `, context lines with two spaces. */
  text: string;
}

export interface SearchResult {
  query: string;
  /** Matching lines over every searched section, counted before any cap applies. */
  total_matches: number;
  blocks: SearchBlock[];
  truncated: boolean;
}

/** Case-insensitive substring search over `sections`; matching lines are returned with context, adjacent hits merged. */
export function searchSections(sections: readonly DocSection[], query: string, options: SearchOptions = {}): SearchResult {
  const needle = query.toLowerCase();
  const context = Math.max(0, options.context ?? 2);
  const maxBlocks = Math.max(1, options.maxBlocks ?? 30);
  const maxChars = Math.max(200, options.maxChars ?? 12_000);
  const blocks: SearchBlock[] = [];
  let totalMatches = 0;
  let chars = 0;
  let truncated = false;
  if (!needle) return { query, total_matches: 0, blocks, truncated: false };
  for (const section of sections) {
    const lines = section.text.split("\n");
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) if (lines[i]!.toLowerCase().includes(needle)) hits.push(i);
    totalMatches += hits.length; // every hit counts, whatever the caps cut
    const ranges: Array<{ start: number; end: number; hits: number[] }> = [];
    for (const hit of hits) {
      const start = Math.max(0, hit - context);
      const end = Math.min(lines.length - 1, hit + context);
      const last = ranges[ranges.length - 1];
      if (last && start <= last.end + 1) {
        last.end = Math.max(last.end, end);
        last.hits.push(hit);
      } else {
        ranges.push({ start, end, hits: [hit] });
      }
    }
    for (const range of ranges) {
      if (truncated) break;
      if (blocks.length >= maxBlocks) {
        truncated = true;
        break;
      }
      const hitSet = new Set(range.hits);
      const text = lines
        .slice(range.start, range.end + 1)
        .map((line, k) => (hitSet.has(range.start + k) ? "> " : "  ") + line)
        .join("\n");
      if (chars + text.length > maxChars && blocks.length > 0) {
        truncated = true;
        break;
      }
      chars += text.length;
      blocks.push({ topic: section.topic, section: section.slug, line_from: range.start + 1, line_to: range.end + 1, text });
    }
  }
  return { query, total_matches: totalMatches, blocks, truncated };
}

/** Catalogue entries whose name or one-line rendering contains the query (case-insensitive), name hits first. */
export function searchErrors(query: string, max = 15): { total: number; names: string[] } {
  const needle = query.toLowerCase();
  const byName: string[] = [];
  const byText: string[] = [];
  for (const [name, entry] of loadErrors()) {
    if (name.toLowerCase().includes(needle)) byName.push(name);
    else if (errorLine(name, entry).toLowerCase().includes(needle)) byText.push(name);
  }
  const all = [...byName, ...byText];
  return { total: all.length, names: all.slice(0, max) };
}

// ---------- markdown renderings (resources) ----------

/** cardano-debug://docs: one line per topic. */
export function docIndexMarkdown(): string {
  const out = ["# cardano-debug built-in docs", "", "A topic's sections: cardano-debug://docs/{topic}; one section: cardano-debug://docs/{topic}/{section}; one error entry: the docs tool with error=<Name>.", ""];
  for (const topic of loadDocs().values()) out.push(`- ${topic.id}: ${topic.title} (${topic.sections.length} sections). ${topic.when}`);
  return out.join("\n");
}

/** cardano-debug://docs/{topic}: summary + every section with its gist and size. */
export function topicIndexMarkdown(topic: DocTopic): string {
  const t = getTopic(topic);
  const out = [`# ${t.title}`, "", t.summary, "", `Sections (cardano-debug://docs/${topic}/{section}):`];
  for (const s of t.sections) out.push(`- ${s.slug}: ${s.title} (${s.chars} chars). ${s.gist}`);
  if (topic === "validation-errors") out.push("", `Error catalogue: ${loadErrors().size} names; one entry each via the docs tool (error=<Name>).`);
  return out.join("\n");
}
