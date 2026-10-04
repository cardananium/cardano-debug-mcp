// Strict tool inputs (src/tools/index.ts): an argument a tool does not know is an error that names the valid
// ones, instead of being dropped silently by zod.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import * as z from "zod/v4";

import { loadConfig } from "../../src/config.js";
import { createAppContext } from "../../src/context.js";
import { ALL_TOOLS, compactAnnotations, compactJsonSchema, editDistance, registerAllTools, strictInputSchema, suggestParameter, unknownParametersMessage, withStrictInputs } from "../../src/tools/index.js";

type Std = { "~standard": { validate(value: unknown): { issues?: Array<{ message: string; path?: unknown[] }>; value?: unknown } | Promise<unknown> } };
const validate = (schema: unknown, value: unknown) => (schema as Std)["~standard"].validate(value) as { issues?: Array<{ message: string; path?: unknown[] }>; value?: unknown };

describe("did-you-mean", () => {
  it("edit distance", () => {
    expect(editDistance("", "")).toBe(0);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("rule", "rul")).toBe(1);
  });

  it("suggests typos, case and underscore variants, containment and the usual synonyms; nothing for the unrelated", () => {
    const valid = ["hex", "cddl", "rule", "tx_id", "tx_cbor", "script_hash", "line", "dbg_id"];
    expect(suggestParameter("rul", valid)).toBe("rule");
    expect(suggestParameter("txId", valid)).toBe("tx_id");
    expect(suggestParameter("scriptHash", valid)).toBe("script_hash");
    expect(suggestParameter("lines", valid)).toBe("line");
    expect(suggestParameter("era", valid)).toBe("cddl");
    expect(suggestParameter("schema", valid)).toBe("cddl");
    expect(suggestParameter("session", valid)).toBe("dbg_id");
    expect(suggestParameter("banana", valid)).toBeUndefined();
    // a synonym is only offered when the tool has the parameter
    expect(suggestParameter("era", ["hex", "rule"])).toBeUndefined();
  });

  it("the message names the tool, every unknown name, every valid name and the suggestion", () => {
    const message = unknownParametersMessage("cbor_validate", ["era", "schema"], ["hex", "cddl", "rule"]);
    expect(message).toBe("unknown parameters 'era', 'schema' for cbor_validate; valid parameters: hex, cddl, rule ('era' -> did you mean 'cddl'? 'schema' -> did you mean 'cddl'?)");
    expect(unknownParametersMessage("docs", ["zzz"], ["topic", "query"])).toBe("unknown parameter 'zzz' for docs; valid parameters: topic, query");
  });
});

describe("strictInputSchema", () => {
  const schema = z.object({ hex: z.string().min(1), cddl: z.string().optional(), nested: z.object({ a: z.number() }).optional() });

  it("accepts what the schema accepted and rejects the rest with the message", () => {
    const strict = strictInputSchema("cbor_validate", schema);
    expect(validate(strict, { hex: "aa", cddl: "conway" }).issues).toBeUndefined();
    const bad = validate(strict, { hex: "aa", era: "babbage", schema: "babbage" });
    expect(bad.issues).toHaveLength(1);
    expect(bad.issues![0]!.message).toContain("unknown parameters 'era', 'schema' for cbor_validate; valid parameters: hex, cddl, nested");
    expect(bad.issues![0]!.message).toContain("'era' -> did you mean 'cddl'?");
  });

  it("keeps the other errors of the schema (a missing field) and its own messages", () => {
    const strict = strictInputSchema("cbor_validate", schema);
    const issues = validate(strict, { era: "x" }).issues!.map((issue) => issue.message);
    expect(issues.some((m) => m.includes("unknown parameter 'era'"))).toBe(true);
    expect(issues.some((m) => /expected string/i.test(m))).toBe(true);
    expect(validate(strict, "not an object").issues![0]!.message).not.toContain("unknown parameter");
  });

  it("is strict at the top level only: nested objects keep their behaviour", () => {
    const strict = strictInputSchema("t", schema);
    expect(validate(strict, { hex: "aa", nested: { a: 1, extra: true } }).issues).toBeUndefined();
  });

  it("the JSON schema says additionalProperties: false", () => {
    const json = z.toJSONSchema(strictInputSchema("t", schema) as z.ZodType, { io: "input" }) as { additionalProperties?: unknown; properties: Record<string, unknown> };
    expect(json.additionalProperties).toBe(false);
    expect(Object.keys(json.properties)).toEqual(["hex", "cddl", "nested"]);
  });

  it("accepts a raw shape, leaves undefined alone, leaves other schemas and schemas with checks untouched", () => {
    const logged: string[] = [];
    const log = (m: string) => logged.push(m);
    expect(strictInputSchema("raw", { hex: z.string() }, log)).not.toBeUndefined();
    expect(validate(strictInputSchema("raw", { hex: z.string() }, log), { hex: "a", more: 1 }).issues![0]!.message).toContain("unknown parameter 'more' for raw; valid parameters: hex");
    expect(strictInputSchema("none", undefined, log)).toBeUndefined();
    expect(logged).toEqual([]);

    const notObject = z.string();
    expect(strictInputSchema("str", notObject, log)).toBe(notObject);
    const refined = z.object({ a: z.string() }).refine((v) => v.a !== "x", "no x");
    expect(strictInputSchema("refined", refined, log)).toBe(refined);
    expect(logged).toEqual(["input schema of str is not a plain object schema; left non-strict", "input schema of refined has checks; left non-strict"]);
  });
});

describe("registration", () => {
  /** A stand-in for McpServer that records what each tool registers. */
  function recorder() {
    const registered: Array<{ name: string; config: { inputSchema?: unknown; description?: string }; handler: unknown }> = [];
    const server = {
      registerTool(name: string, config: { inputSchema?: unknown }, handler: unknown) {
        registered.push({ name, config, handler });
        return {};
      },
    };
    return { server: server as unknown as Parameters<typeof withStrictInputs>[0], registered };
  }
  // A real context: some tools attach their service at registration. No worker starts until a tool is called.
  const ctx = createAppContext({ config: loadConfig({ CARDANO_DEBUG_CACHE_DIR: mkdtempSync(path.join(os.tmpdir(), "cdm-strict-")) }) });
  afterAll(() => ctx.shutdown());

  it("every registered tool gets a strict input schema; handlers and the rest of the config pass through", () => {
    const { server, registered } = recorder();
    registerAllTools(server, ctx);
    expect(registered.map((r) => r.name).sort()).toEqual(ALL_TOOLS.map((t) => t.name).sort());
    for (const { name, config, handler } of registered) {
      expect(typeof handler, name).toBe("function");
      expect(config.description, name).toBeTruthy();
      const issues = validate(config.inputSchema, { __unknown_param__: 1 }).issues ?? [];
      const message = issues.find((issue) => issue.message.includes("unknown parameter"))?.message ?? "";
      expect(message, `${name} must reject an unknown parameter`).toContain(`unknown parameter '__unknown_param__' for ${name}; valid parameters: `);
      // the valid list is the schema's own property list
      const json = z.toJSONSchema(config.inputSchema as z.ZodType, { io: "input" }) as { properties?: Record<string, unknown>; additionalProperties?: unknown };
      expect(json.additionalProperties, name).toBe(false);
      for (const key of Object.keys(json.properties ?? {})) expect(message, `${name}.${key}`).toContain(key);
    }
  });

  it("cbor_validate rejects era / schema, the case that answered 'valid' under the wrong preset", () => {
    const { server, registered } = recorder();
    registerAllTools(server, ctx);
    const schema = registered.find((r) => r.name === "cbor_validate")!.config.inputSchema;
    const result = validate(schema, { hex: "00", era: "babbage", schema: "babbage" });
    expect(result.issues![0]!.message).toMatch(/^unknown parameters 'era', 'schema' for cbor_validate; valid parameters: hex, cddl, rule,/);
    expect(validate(schema, { hex: "00", cddl: "babbage" }).issues).toBeUndefined();
  });

  it("withStrictInputs forwards every other member of the server", () => {
    const calls: string[] = [];
    const base = {
      marker: 7,
      registerResource: (...args: unknown[]) => calls.push(`resource:${String(args[0])}`),
      registerTool: () => ({}),
    };
    const wrapped = withStrictInputs(base as unknown as Parameters<typeof withStrictInputs>[0]) as unknown as typeof base;
    wrapped.registerResource("r");
    expect(calls).toEqual(["resource:r"]);
    expect(wrapped.marker).toBe(7);
  });
});

describe("compact catalogue", () => {
  const json = (schema: unknown) => (schema as { "~standard": { jsonSchema: { input(options: unknown): Record<string, unknown> } } })["~standard"].jsonSchema.input({ target: "draft-2020-12" });

  it("compactJsonSchema drops $schema and the safe-integer bounds, nothing else", () => {
    const schema = { $schema: "x", type: "object", properties: { a: { type: "integer", minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }, b: { type: "integer", minimum: 1, maximum: 50 }, c: { type: "array", items: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } } } };
    expect(compactJsonSchema(schema)).toEqual({ type: "object", properties: { a: { type: "integer" }, b: { type: "integer", minimum: 1, maximum: 50 }, c: { type: "array", items: { type: "integer", minimum: 0 } } } });
  });

  it("a strict input schema advertises the compact JSON schema (still additionalProperties: false) and still validates", () => {
    const strict = strictInputSchema("t", z.object({ n: z.number().int().min(1), s: z.string().optional() })) as z.ZodType;
    const schema = json(strict);
    expect(schema).not.toHaveProperty("$schema");
    expect(JSON.stringify(schema)).not.toContain(String(Number.MAX_SAFE_INTEGER));
    expect(schema).toMatchObject({ type: "object", additionalProperties: false, required: ["n"], properties: { n: { type: "integer", minimum: 1 } } });
    expect(validate(strict, { n: 2 }).issues).toBeUndefined();
    expect(validate(strict, { n: 0 }).issues).toBeDefined();
    expect(validate(strict, { n: 2, extra: 1 }).issues?.[0]?.message).toMatch(/unknown parameter 'extra' for t/);
  });

  it("compactAnnotations drops what the MCP spec implies", () => {
    expect(compactAnnotations({ readOnlyHint: true, idempotentHint: true, openWorldHint: false })).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(compactAnnotations({ readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false })).toEqual({ destructiveHint: false, openWorldHint: false });
    expect(compactAnnotations({ readOnlyHint: false, idempotentHint: true, destructiveHint: false })).toEqual({ idempotentHint: true, destructiveHint: false });
  });
});
