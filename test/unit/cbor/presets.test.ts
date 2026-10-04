// Era presets and the `cddl` argument resolution (file access through a temp dir; wasm in-process).
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { cddlAttribution, DEFAULT_ERA, ERA_PRESETS, isEraPreset, loadEraCddl, looksLikeCddlText, MAX_SCHEMA_FILE_BYTES, resolveSchemaInput } from "../../../src/cbor/presets.js";
import { ToolInputError } from "../../../src/tools/_shared.js";
import { toWireJson } from "../../../src/vocab/json.js";
import { packageRoot } from "../../../src/wasm-assets.js";
import { rawLib } from "../../helpers/inProcessLib.js";

describe("era presets", () => {
  it("lists every bundled era, conway first and default", () => {
    expect(ERA_PRESETS).toEqual(["conway", "babbage", "alonzo", "mary", "allegra", "shelley", "dijkstra"]);
    expect(DEFAULT_ERA).toBe("conway");
    expect(isEraPreset("babbage")).toBe(true);
    expect(isEraPreset("byron")).toBe(false);
    expect(isEraPreset(42)).toBe(false);
    const files = readdirSync(path.join(packageRoot(), "src", "assets", "cddl")).filter((f) => f.endsWith(".cddl")).sort();
    expect(files).toEqual([...ERA_PRESETS].map((e) => `${e}.cddl`).sort());
  });
  it("every preset parses and resolves with validate_cddl and declares the expected roots", () => {
    const lib = rawLib();
    for (const era of ERA_PRESETS) {
      const text = loadEraCddl(era);
      expect(text.startsWith("; This file was auto-generated"), era).toBe(true);
      expect(toWireJson(lib.validate_cddl!(text)), era).toEqual({ valid: true });
      const names = (toWireJson(lib.cddl_outline!(text)) as Array<{ name: string }>).map((e) => e.name);
      expect(names, era).toContain("transaction");
      expect(names, era).toContain("transaction_body");
      expect(names, era).toContain("transaction_witness_set");
    }
    expect(loadEraCddl("conway")).toBe(loadEraCddl("conway")); // cached
  });
  it("the attribution names the ledger revision and the licence", () => {
    const attribution = cddlAttribution();
    expect(attribution.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(attribution.text).toMatch(/Apache/);
    expect(attribution.text).toMatch(/cardano-ledger/);
  });
});

describe("looksLikeCddlText", () => {
  it("recognises rule assignments, comments and newlines, not names or paths", () => {
    expect(looksLikeCddlText("a = [int]")).toBe(true);
    expect(looksLikeCddlText("a /= tstr")).toBe(true);
    expect(looksLikeCddlText("$sock //= (1: int)")).toBe(true);
    expect(looksLikeCddlText("; comment only")).toBe(true);
    expect(looksLikeCddlText("x\ny")).toBe(true);
    expect(looksLikeCddlText("conway")).toBe(false);
    expect(looksLikeCddlText("./schema.cddl")).toBe(false);
    expect(looksLikeCddlText("/tmp/x/y.cddl")).toBe(false);
  });
});

describe("resolveSchemaInput", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cdm-presets-"));
  const file = path.join(dir, "mine.cddl");
  writeFileSync(file, "root = [int]\r\n");

  it("omitted -> the Conway preset; era names are case-insensitive", () => {
    const conway = resolveSchemaInput(undefined);
    expect(conway).toMatchObject({ origin: "preset", label: "preset:conway", era: "conway" });
    expect(conway.text).toBe(loadEraCddl("conway"));
    expect(resolveSchemaInput("  Babbage ")).toMatchObject({ origin: "preset", label: "preset:babbage", era: "babbage" });
    expect(resolveSchemaInput("")).toMatchObject({ era: "conway" });
  });
  it("schema text is inline (CRLF normalised)", () => {
    expect(resolveSchemaInput("a = [int]\r\nb = tstr")).toEqual({ origin: "inline", label: "inline", text: "a = [int]\nb = tstr" });
    expect(resolveSchemaInput("; nothing but a comment")).toMatchObject({ origin: "inline" });
  });
  it("an existing path is read as a file", () => {
    const fromFile = resolveSchemaInput(file);
    expect(fromFile).toMatchObject({ origin: "file", label: `file:${file}`, path: file, text: "root = [int]\n" });
    const home = os.homedir();
    if (file.startsWith(home)) expect(resolveSchemaInput(`~${file.slice(home.length)}`).path).toBe(file);
  });
  it("rejects a missing .cddl path, an oversized file and anything else with invalid_argument", () => {
    expect(() => resolveSchemaInput(path.join(dir, "nope.cddl"))).toThrow(ToolInputError);
    expect(() => resolveSchemaInput(path.join(dir, "nope.cddl"))).toThrow(/does not exist/);
    expect(() => resolveSchemaInput("nonsense")).toThrow(/era preset/);
    expect(() => resolveSchemaInput("byron")).toThrow(ToolInputError);
    const big = path.join(dir, "big.cddl");
    writeFileSync(big, "a".repeat(MAX_SCHEMA_FILE_BYTES + 1));
    expect(() => resolveSchemaInput(big)).toThrow(/capped/);
  });
  it("reads only absolute .cddl / .txt files: other extensions, directories and relative paths are refused", () => {
    const json = path.join(dir, "package.json");
    writeFileSync(json, '{"name": "x"}\n');
    expect(() => resolveSchemaInput(json)).toThrow(/not a \.cddl file/);
    expect(() => resolveSchemaInput("/etc/hosts")).toThrow(/not a \.cddl file/);
    expect(() => resolveSchemaInput(dir)).toThrow(/not a file/);
    expect(() => resolveSchemaInput("mine.cddl")).toThrow(/relative path/);
    expect(() => resolveSchemaInput("./schemas/mine.cddl")).toThrow(/relative path/);
    // a bare word that happens to be a file in the cwd is never read
    expect(() => resolveSchemaInput("package.json")).toThrow(/not a \.cddl file|era preset/);
    const txt = path.join(dir, "mine.txt");
    writeFileSync(txt, "root = tstr\n");
    expect(resolveSchemaInput(txt)).toMatchObject({ origin: "file", text: "root = tstr\n" });
  });
});

describe("cddl path: the extension rule applies to the file actually read", () => {
  it("refuses a *.cddl / *.txt symlink to another file, follows a symlink to a real schema", async () => {
    const { symlinkSync } = await import("node:fs");
    const dir = mkdtempSync(path.join(os.tmpdir(), "cdm-cddl-link-"));
    const secret = path.join(dir, "secrets.env");
    writeFileSync(secret, "API_KEY = sk-live-abc123\n");
    const schema = path.join(dir, "real.cddl");
    writeFileSync(schema, "root = uint\n");
    symlinkSync(secret, path.join(dir, "env_link.cddl"));
    symlinkSync(secret, path.join(dir, "env_link.txt"));
    symlinkSync(schema, path.join(dir, "schema_link.cddl"));
    for (const link of ["env_link.cddl", "env_link.txt"]) {
      expect(() => resolveSchemaInput(path.join(dir, link))).toThrow(ToolInputError);
      expect(() => resolveSchemaInput(path.join(dir, link))).toThrow(/a link to .*secrets\.env.*not a \.cddl file/);
    }
    const followed = resolveSchemaInput(path.join(dir, "schema_link.cddl"));
    expect(followed.origin).toBe("file");
    expect(followed.text).toBe("root = uint\n");
  });
});
