// Type-check-only mirror of the parts of `@cardananium/de-uplc-core` this package uses.
//
// The real package ships TypeScript SOURCES (package.json main -> src/index.ts) and is bundled by
// tsup / transformed by vitest / loaded by tsx. Type-checking those sources with this project's
// stricter options (verbatimModuleSyntax, noUncheckedIndexedAccess) fails inside the package, so
// `tsconfig.typecheck.json` maps `@cardananium/de-uplc-core` here for `tsc` only (`paths`); tsconfig.json (used
// by tsup, tsx and vitest) has no such mapping and resolves the real sources. Keep in sync with
// packages/core/src/term-viewer/{serialize,term-index}.ts and debugger-types/index.ts (Term).

export declare namespace DebuggerTypes {
  type Type =
    | { type: "Bool" | "Integer" | "String" | "ByteString" | "Unit" | "Data" | "Bls12_381G1Element" | "Bls12_381G2Element" | "Bls12_381MlResult" }
    | { type: "List"; elementType: Type }
    | { type: "Pair"; first_type: Type; second_type: Type };

  type PlutusData =
    | { type: "Constr"; tag: number; any_constructor?: number | null; fields: PlutusData[] }
    | { type: "Map"; key_value_pairs: Array<{ key: PlutusData; value: PlutusData }> }
    | { type: "BoundedBytes"; value: string }
    | { type: "Array"; values: PlutusData[] }
    | { Int: string; type?: string }
    | { BigUInt: string; type?: string }
    | { BigNInt: string; type?: string };

  type Constant =
    | { type: "Integer"; value: string }
    | { type: "ByteString"; value: string }
    | { type: "String"; value: string }
    | { type: "Bool"; value: boolean }
    | { type: "Unit" }
    | { type: "ProtoList"; elementType: Type; values: Constant[] }
    | { type: "ProtoPair"; first_type: Type; second_type: Type; first_element: Constant; second_element: Constant }
    | { type: "Data"; data: PlutusData }
    | { type: "Bls12_381G1Element"; serialized: string }
    | { type: "Bls12_381G2Element"; serialized: string }
    | { type: "Bls12_381MlResult" };

  type Term =
    | { id: number; name: string; term_type: "Var" }
    | { id: number; term: Term; term_type: "Delay" }
    | { body: Term; id: number; parameterName: string; term_type: "Lambda" }
    | { argument: Term; function: Term; id: number; term_type: "Apply" }
    | { constant: Constant; id: number; term_type: "Constant" }
    | { id: number; term: Term; term_type: "Force" }
    | { id: number; term_type: "Error" }
    | { fun: string; id: number; term_type: "Builtin" }
    | { constructorTag: number; fields: Term[]; id: number; term_type: "Constr" }
    | { branches: Term[]; constr: Term; id: number; term_type: "Case" };
}

export interface TermLocation {
  startLine: number;
  /** Exclusive in the tree renderer, inclusive in the canonical (uplc) renderer; TermIndex normalises. */
  endLine: number;
  termId: number;
  kind: DebuggerTypes.Term["term_type"];
  label?: string;
}

export interface TermHintInfo {
  line: number;
  character: number;
  text: string;
  kind: "term" | "name" | "constant_type" | "builtin_function";
}

export interface SerializedTerm {
  text: string;
  locations: TermLocation[];
  hints: TermHintInfo[];
}

export type TermView = "tree" | "uplc";

/** Canonical UPLC rendering: one term per line, `(lam x …)`, `[f a]`, `(con integer 42)`. */
export declare function serializeTermUplc(term: DebuggerTypes.Term): SerializedTerm;
/** Debug-tree rendering (`Apply { fun: … }`). */
export declare function serializeTerm(term: DebuggerTypes.Term): SerializedTerm;
export declare function builtinName(fun: string): string;

export declare class TermIndex {
  readonly locations: readonly TermLocation[];
  readonly view: TermView;
  readonly size: number;
  readonly byTermId: ReadonlyMap<number, number>;
  readonly byLine: ReadonlyMap<number, readonly number[]>;
  readonly startLine: Int32Array;
  readonly endLine: Int32Array;
  readonly parent: Int32Array;
  readonly firstChild: Int32Array;
  readonly nextSibling: Int32Array;
  readonly depth: Int32Array;
  constructor(locations: readonly TermLocation[], view: TermView);
  locationOf(termId: number): TermLocation | undefined;
  lineOfTerm(termId: number): number | undefined;
  children(i: number): number[];
  ancestors(i: number): number[];
  findTermAtLine(line: number): TermLocation | undefined;
  findNearestTerm(line: number): TermLocation | undefined;
  termAtLineForBreakpoint(line: number): { line: number; termId: number } | undefined;
}
export declare function termIndexFor(locations: readonly TermLocation[], view: TermView): TermIndex;
