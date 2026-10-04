// The dehosk option catalogue (`options_catalogue()` of @cardananium/de-uplc-decompiler-wasm): the crate is the
// single source of option names, enum tokens and defaults. Parsed once per worker generation;
// everything user-facing is validated against it so a renamed crate option surfaces as a clear
// `invalid_argument` instead of a serde error from inside the wasm.

export interface CatalogueChoicePayload {
  type: "count";
  key: string;
  min: number;
  default: number;
}

export interface CatalogueChoice {
  value: string;
  label: string;
  summary: string;
  payload?: CatalogueChoicePayload | null;
}

export type CatalogueOptionKind = { type: "toggle" } | { type: "choice"; unset: string | null; choices: CatalogueChoice[] };

export interface CatalogueOption {
  path: string[];
  field: string;
  label: string;
  summary: string;
  detail: string[];
  cliFlag?: string | null;
  kind: CatalogueOptionKind;
}

export interface CatalogueGroup {
  id: string;
  title: string;
  summary: string;
  detail: string[];
  masterPath: string[] | null;
  options: CatalogueOption[];
}

/** Opaque wire bag (`DecompileOptionsDto`); reached into only through catalogue paths. */
export type OptionsBag = Record<string, unknown>;

export interface OptionCatalogue {
  version: number;
  groups: CatalogueGroup[];
  defaults: OptionsBag;
}

export class CatalogueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogueError";
  }
}

/** Parse and shape-check the catalogue JSON text. */
export function parseCatalogue(text: string): OptionCatalogue {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CatalogueError("options_catalogue() did not return JSON");
  }
  if (json === null || typeof json !== "object") throw new CatalogueError("catalogue is not an object");
  const cat = json as Record<string, unknown>;
  if (!Array.isArray(cat.groups)) throw new CatalogueError("catalogue has no `groups` array");
  if (cat.defaults === null || typeof cat.defaults !== "object") throw new CatalogueError("catalogue has no `defaults` object");
  cat.groups.forEach((group, i) => {
    if (group === null || typeof group !== "object") throw new CatalogueError(`group ${i} is not an object`);
    const g = group as Record<string, unknown>;
    if (!Array.isArray(g.options)) throw new CatalogueError(`group ${i} has no \`options\` array`);
    g.options.forEach((option, j) => {
      if (option === null || typeof option !== "object") throw new CatalogueError(`group ${i} option ${j} is not an object`);
      const o = option as Record<string, unknown>;
      if (!Array.isArray(o.path) || o.path.some((p) => typeof p !== "string")) throw new CatalogueError(`group ${i} option ${j} has no \`path\``);
      const kind = o.kind as Record<string, unknown> | null | undefined;
      if (!kind || typeof kind.type !== "string") throw new CatalogueError(`group ${i} option ${j} has no \`kind.type\``);
      if (kind.type === "choice" && !Array.isArray(kind.choices)) throw new CatalogueError(`group ${i} option ${j} is a choice without \`choices\``);
    });
  });
  return { version: typeof cat.version === "number" ? cat.version : 0, groups: cat.groups as CatalogueGroup[], defaults: cat.defaults as OptionsBag };
}

export function getAtPath(bag: OptionsBag, path: readonly string[]): unknown {
  let current: unknown = bag;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Immutable set: returns a new bag with `path` set to `value`. */
export function setAtPath(bag: OptionsBag, path: readonly string[], value: unknown): OptionsBag {
  if (path.length === 0) return bag;
  const [head, ...rest] = path as [string, ...string[]];
  const child = bag[head];
  return {
    ...bag,
    [head]: rest.length === 0 ? value : setAtPath(child !== null && typeof child === "object" ? (child as OptionsBag) : {}, rest, value),
  };
}

/** One catalogue option looked up by its dotted path (`validator_shape.purpose`). */
export interface OptionInfo {
  option: CatalogueOption;
  pathKey: string;
}

/**
 * Index over the catalogue: option lookup by path, token validation, defaults access.
 * Built once per worker generation (the catalogue cannot change while the wasm is loaded).
 */
export class CatalogueIndex {
  readonly catalogue: OptionCatalogue;
  private readonly byPath = new Map<string, CatalogueOption>();

  constructor(catalogue: OptionCatalogue) {
    this.catalogue = catalogue;
    for (const group of catalogue.groups) {
      for (const option of group.options) this.byPath.set(option.path.join("."), option);
    }
  }

  get defaults(): OptionsBag {
    return structuredClone(this.catalogue.defaults);
  }

  get version(): number {
    return this.catalogue.version;
  }

  get optionCount(): number {
    return this.byPath.size;
  }

  /** All option paths (dotted). */
  paths(): string[] {
    return Array.from(this.byPath.keys());
  }

  option(path: string | readonly string[]): CatalogueOption | undefined {
    return this.byPath.get(typeof path === "string" ? path : path.join("."));
  }

  has(path: string | readonly string[]): boolean {
    return this.option(path) !== undefined;
  }

  /** Enum tokens of a choice option (`[]` for toggles / unknown options). */
  tokens(path: string | readonly string[]): string[] {
    const option = this.option(path);
    if (!option || option.kind.type !== "choice") return [];
    return option.kind.choices.map((c) => c.value);
  }

  /**
   * Match a user token to a catalogue enum token, case-insensitively and ignoring `_`/`-`
   * (`uplc_canonical` → `UplcCanonical`, `plutusv2` → `PlutusV2`). Undefined when it is not a token.
   */
  matchToken(path: string | readonly string[], input: string): string | undefined {
    const wanted = foldToken(input);
    for (const token of this.tokens(path)) {
      if (foldToken(token) === wanted) return token;
    }
    return undefined;
  }

  /**
   * Validate a value for the option at `path` (as the wire expects it): booleans for toggles,
   * known tokens (or `null` for choices that allow unset, or `{<payload.key>: n}` for a payload
   * choice) for choices. Returns an error message or undefined.
   */
  validateValue(path: readonly string[], value: unknown): string | undefined {
    const key = path.join(".");
    const option = this.byPath.get(key);
    if (!option) return `unknown option '${key}'`;
    if (option.kind.type === "toggle") {
      return typeof value === "boolean" ? undefined : `option '${key}' takes true|false (got ${JSON.stringify(value)})`;
    }
    const tokens = option.kind.choices.map((c) => c.value);
    if (value === null || value === undefined) {
      return option.kind.unset !== null ? undefined : `option '${key}' cannot be unset; use one of ${tokens.join("|")}`;
    }
    if (typeof value === "string") {
      return tokens.includes(value) ? undefined : `option '${key}' must be one of ${tokens.join("|")} (got ${JSON.stringify(value)})`;
    }
    if (typeof value === "object") {
      // Payload choice, e.g. applied_kind Explicit → {"runtime_count": n}
      const payloadChoices = option.kind.choices.filter((c) => c.payload);
      const record = value as Record<string, unknown>;
      for (const choice of payloadChoices) {
        const payload = choice.payload!;
        const n = record[payload.key];
        if (typeof n === "number" && Number.isInteger(n) && n >= payload.min && Object.keys(record).length === 1) return undefined;
      }
      if (payloadChoices.length > 0) {
        const p = payloadChoices[0]!.payload!;
        return `option '${key}' object form is {"${p.key}": <integer >= ${p.min}>} (got ${JSON.stringify(value)})`;
      }
    }
    return `option '${key}' must be one of ${tokens.join("|")} (got ${JSON.stringify(value)})`;
  }

  /**
   * Validate a whole bag against the catalogue: every leaf must be a known option with a valid
   * value; unknown keys are reported (not silently ignored — serde would reject them anyway).
   */
  validateBag(bag: OptionsBag): string[] {
    const errors: string[] = [];
    const groupPrefixes = new Set<string>();
    for (const key of this.byPath.keys()) {
      const parts = key.split(".");
      for (let i = 1; i < parts.length; i++) groupPrefixes.add(parts.slice(0, i).join("."));
    }
    const walk = (node: unknown, path: string[]) => {
      const key = path.join(".");
      if (this.byPath.has(key)) {
        const error = this.validateValue(path, node);
        if (error) errors.push(error);
        return;
      }
      if (node !== null && typeof node === "object" && !Array.isArray(node) && (path.length === 0 || groupPrefixes.has(key))) {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, [...path, k]);
        return;
      }
      errors.push(`unknown option '${key}'`);
    };
    walk(bag, []);
    return errors;
  }
}

function foldToken(token: string): string {
  return token.toLowerCase().replace(/[_\-\s]/g, "");
}
