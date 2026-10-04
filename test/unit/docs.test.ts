import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  allSections,
  DOC_TOPICS,
  docIndexMarkdown,
  docsDir,
  errorLine,
  errorNamesByGroup,
  findError,
  findSection,
  getTopic,
  loadDocs,
  loadErrors,
  parseFrontMatter,
  parseSection,
  parseTopicIndex,
  searchErrors,
  searchSections,
  SECTION_FILE,
  topicIndexMarkdown,
  type DocTopic,
} from "../../src/docs/index.js";
import { ERROR_DOCS_MAX_NAMES, errorDocsPointer } from "../../src/chain/validate.js";
import { answerDocs } from "../../src/tools/docs.js";
import { fxBig, fxStr } from "../helpers/fixtures.js";

const SAMPLE = [
  "---",
  "gist: what the sample answers.",
  "---",
  "# Sample heading",
  "",
  "Body with FooBar in it.",
  "",
  "```json",
  "# not a heading (inside a fence)",
  "```",
  "",
  "- bullet about `frames`",
  "- another line mentioning foobar again",
  "",
].join("\n");

describe("section files", () => {
  it("front matter, title, gist, served text and sizes", () => {
    expect(parseFrontMatter("---\na: 1\nb: x: y\n---\n# T\n\nbody\n")).toEqual({ meta: { a: "1", b: "x: y" }, body: "# T\n\nbody" });
    expect(parseFrontMatter("# T\nbody")).toEqual({ meta: {}, body: "# T\nbody" });
    const s = parseSection("uplc-cek", "03-sample-heading.md", SAMPLE);
    expect(s).toMatchObject({ topic: "uplc-cek", n: "03", slug: "sample-heading", title: "Sample heading", gist: "what the sample answers." });
    expect(s.text.startsWith("# Sample heading\n")).toBe(true);
    expect(s.text).not.toContain("gist:");
    expect(s.chars).toBe(s.text.length);
    expect(s.file_chars).toBe(SAMPLE.length);
    expect(() => parseSection("uplc-cek", "sample.md", SAMPLE)).toThrow(/NN-<slug>/);
    const index = parseTopicIndex("tx-anatomy", "---\nwhen: always.\n---\n# Title here\n\nThe summary.\n", [s]);
    expect(index).toMatchObject({ id: "tx-anatomy", title: "Title here", when: "always.", summary: "The summary." });
  });

  it("searchSections: case-insensitive, context lines, merged hits, caps, the true total", () => {
    const s = parseSection("uplc-cek", "01-sample.md", SAMPLE);
    const other = parseSection("tx-anatomy", "02-other.md", "---\ngist: g\n---\n# Other\n\ne1\ne2\n\ne3");
    const merged = searchSections([s], "foobar", { context: 3 });
    expect(merged.total_matches).toBe(2);
    expect(merged.blocks).toHaveLength(1);
    expect(merged.blocks[0]!.text.split("\n")).toContain("> Body with FooBar in it.");
    const split = searchSections([s], "foobar", { context: 0 });
    expect(split.blocks.map((b) => [b.line_from, b.line_to])).toEqual([
      [3, 3],
      [10, 10],
    ]);
    expect(split.blocks.every((b) => b.topic === "uplc-cek" && b.section === "sample")).toBe(true);
    const capped = searchSections([s, other], "e", { context: 0, maxBlocks: 2 });
    expect(capped.blocks).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    expect(capped.total_matches).toBe(searchSections([s, other], "e", { context: 0 }).total_matches);
    expect(searchSections([s], "")).toEqual({ query: "", total_matches: 0, blocks: [], truncated: false });
  });
});

describe("the bundled docs (src/docs/<topic>/)", () => {
  it("every topic: index.md with title / when / summary, numbered section files with a heading and a gist", () => {
    expect(Array.from(loadDocs().keys())).toEqual([...DOC_TOPICS]);
    for (const topic of DOC_TOPICS) {
      const t = getTopic(topic);
      expect(t.title, topic).not.toBe(topic);
      expect(t.when.length, topic).toBeGreaterThan(40);
      expect(t.summary.length, topic).toBeGreaterThan(100);
      expect(t.sections.length, topic).toBeGreaterThanOrEqual(7);
      const files = readdirSync(path.join(docsDir(), topic));
      expect(files.filter((f) => f !== "index.md").every((f) => SECTION_FILE.test(f)), `${topic}: stray files`).toBe(true);
      expect(new Set(t.sections.map((s) => s.n)).size, `${topic}: duplicate numbers`).toBe(t.sections.length);
      for (const s of t.sections) {
        expect(s.gist.length, `${topic}/${s.slug} gist`).toBeGreaterThan(30);
        expect(s.gist, `${topic}/${s.slug}`).not.toMatch(/TODO/);
        expect(s.text.startsWith(`# ${s.title}\n`), `${topic}/${s.slug}`).toBe(true);
        expect(s.text, `${topic}/${s.slug}`).not.toMatch(/^## /m); // one section per file
      }
    }
  });

  it("served text: no pseudocode positional vocabulary, no local or repo paths", () => {
    for (const s of allSections()) {
      const id = `${s.topic}/${s.slug}`;
      // tools/ui-link-targets names the decompiler's annotation target kind `pseudo_line` (a link annotation, not a debugger position)
      const text = id === "tools/ui-link-targets" ? s.text.replace(/\{kind:'pseudo_line'/g, "") : s.text;
      expect(text, id).not.toMatch(/pseudo_line|pseudo_lines|pseudo_window|pseudocode_status|pseudocode_notes|view='pseudocode'/);
      expect(s.text, id).not.toMatch(/\/Users\/|~\/\.cargo|\.\.\/cquisitor|test\/fixtures|src\/[a-z_]+\/|\.json"\)/);
    }
  });

  it("every `topic/section` cross-reference in docs, error entries and prompts resolves", () => {
    const sources: Array<[string, string]> = allSections().map((s) => [`${s.topic}/${s.slug}`, s.text]);
    for (const topic of DOC_TOPICS) sources.push([`${topic}/index`, getTopic(topic).text]);
    for (const [name, entry] of loadErrors()) sources.push([`error ${name}`, errorLine(name, entry)]);
    const promptsDir = path.join(docsDir(), "..", "prompts");
    for (const f of readdirSync(promptsDir).filter((x) => x.endsWith(".md"))) sources.push([`prompt ${f}`, readFileSync(path.join(promptsDir, f), "utf8")]);
    const refs = new RegExp(`\\b(${DOC_TOPICS.join("|")})/([a-z0-9-]+)`, "g");
    const sectionArgs = /docs\(topic='([a-z-]+)', section='([^']+)'\)/g;
    let checked = 0;
    for (const [where, text] of sources) {
      for (const m of text.matchAll(refs)) {
        checked++;
        expect(findSection(m[2]!, m[1] as DocTopic)?.how, `${where}: ${m[0]}`).toBe("exact");
      }
      for (const m of text.matchAll(sectionArgs)) {
        checked++;
        expect(findSection(m[2]!, m[1] as DocTopic), `${where}: ${m[0]}`).toBeDefined();
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it("markdown renderings of the index and of a topic", () => {
    const index = docIndexMarkdown();
    expect(index.startsWith("# cardano-debug built-in docs")).toBe(true);
    for (const topic of DOC_TOPICS) expect(index).toContain(`- ${topic}: ${getTopic(topic).title}`);
    expect(index.length).toBeLessThan(4_000);
    const topic = topicIndexMarkdown("tx-anatomy");
    expect(topic.startsWith("# Cardano transaction anatomy")).toBe(true);
    for (const s of getTopic("tx-anatomy").sections) expect(topic).toContain(`- ${s.slug}: ${s.title} (${s.chars} chars). ${s.gist}`);
    expect(topicIndexMarkdown("validation-errors")).toMatch(/Error catalogue: 127 names/);
  });
});

describe("findSection", () => {
  it("by number (with a topic), slug, heading, prefix, topic/slug; best kind wins across topics", () => {
    expect(findSection("3", "uplc-cek")).toMatchObject({ how: "number", section: { slug: "de-bruijn" } });
    expect(findSection("03", "uplc-cek")?.section.slug).toBe("de-bruijn");
    expect(findSection("collateral", "tx-anatomy")).toMatchObject({ how: "exact", section: { title: "Collateral rules" } });
    expect(findSection("Collateral rules")).toMatchObject({ how: "exact", section: { topic: "tx-anatomy" } });
    expect(findSection("the cek machine", "uplc-cek")).toMatchObject({ how: "prefix", section: { slug: "cek-machine" } });
    expect(findSection("defaults_applied")).toMatchObject({ section: { topic: "validation-errors", slug: "defaults-applied" } });
    expect(findSection("tools/debug_run")).toMatchObject({ how: "exact", section: { topic: "tools", slug: "debug-run" } });
    const phase2 = findSection("Phase 2")!;
    expect(phase2.how).toBe("prefix");
    expect(phase2.also.some((id) => id.startsWith("debug-playbook/phase-2"))).toBe(true);
    expect(findSection("nothing like this")).toBeUndefined();
    expect(findSection("")).toBeUndefined();
    expect(findSection("99", "uplc-cek")).toBeUndefined();
  });
});

/** The four error / warning enums of cquisitor-lib (validators/phase_1 and phase_2 errors.rs), pinned: the catalogue covers each name. */
const LIBRARY_NAMES = {
  Phase1Error:
    "BadInputsUTxO OutsideValidityIntervalUTxO MaxTxSizeUTxO InputSetEmptyUTxO FeeTooSmallUTxO ValueNotConservedUTxO WrongNetwork WrongNetworkWithdrawal WrongNetworkInTxBody OutputTooSmallUTxO CollateralReturnTooSmall OutputBootAddrAttrsTooBig OutputsValueTooBig InsufficientCollateral ExUnitsTooBigUTxO CalculatedCollateralContainsNonAdaAssets CollateralInputContainsNonAdaAssets CollateralIsLockedByScript TooManyCollateralInputs NoCollateralInputs IncorrectTotalCollateralField InvalidSignature ExtraneousSignature NativeScriptIsUnsuccessful PlutusScriptIsUnsuccessful MissingVKeyWitnesses MissingScriptWitnesses MissingRedeemer MissingTxBodyMetadataHash MissingTxMetadata ConflictingMetadataHash InvalidMetadata ExtraneousScriptWitnesses StakeAlreadyRegistered StakeNotRegistered StakeNonZeroAccountBalance RewardAccountNotExisting WrongRequestedWithdrawalAmount StakePoolNotRegistered WrongRetirementEpoch StakePoolCostTooLow InsufficientFundsForMir InvalidCommitteeVote DRepIncorrectDeposit DRepDeregistrationWrongRefund DelegateeDRepNotRegistered StakeRegistrationWrongDeposit StakeDeregistrationWrongRefund PoolRegistrationWrongDeposit CommitteeHasPreviouslyResigned TreasuryValueMismatch RefScriptsSizeTooBig WithdrawalNotAllowedBecauseNotDelegatedToDRep CommitteeIsUnknown GovActionsDoNotExist MalformedProposal ProposalProcedureNetworkIdMismatch TreasuryWithdrawalsNetworkIdMismatch VotingProposalIncorrectDeposit DisallowedVoters ConflictingCommitteeUpdate ExpirationEpochTooSmall InvalidPrevGovActionId VotingOnExpiredGovAction ProposalCantFollow InvalidConstitutionPolicyHash VoterDoNotExist ZeroTreasuryWithdrawals ProposalReturnAccountDoesNotExist TreasuryWithdrawalReturnAccountsDoNotExist AuxiliaryDataHashMismatch AuxiliaryDataHashMissing AuxiliaryDataHashPresentButNotExpected GenesisKeyDelegationCertificateIsNotSupported MoveInstantaneousRewardsCertificateIsNotSupported UnknownError MissingDatum ExtraneousDatumWitnesses ScriptDataHashMismatch ReferenceInputOverlapsWithInput",
  Phase1Warning:
    "FeeIsBiggerThanMinFee InputsAreNotSorted WithdrawalsAreNotSorted CollateralIsUnnecessary TotalCollateralIsNotDeclared InputUsesRewardAddress CollateralInputUsesRewardAddress CannotCheckStakeDeregistrationRefund CannotCheckDRepDeregistrationRefund PoolAlreadyRegistered DRepAlreadyRegistered CommitteeAlreadyAuthorized DRepNotRegistered DelegationToRetiringPool DuplicateRegistrationInTx DuplicateCommitteeColdResignationInTx DuplicateCommitteeHotRegistrationInTx NativeScriptNotExamined",
  Phase2Error:
    "NoEnoughBudget InvalidRedeemerIndex MachineError NativeScriptIsReferencedByRedeemer CostModelNotFound ScriptDecodeError ResolvedInputNotFound ByronAddressNotAllowed InlineDatumNotAllowedForPlutusV1 ReferenceInputsNotAllowedForPlutusV1 UnreadableOutput UnreadableTransactionField CertificateNotSupportedInPlutusV1V2 FieldNotSupportedInPlutusV1V2 SlotTooFarInThePast NoPaymentCredential ExtraneousRedeemer BuildTxContextError RedeemerIndexOutOfBounds MissingRequiredScript MissingRequiredDatum NonScriptWithdrawal NonScriptCredential UnsupportedCertificateType NoGuardrailScriptForProcedure MissingRequiredInlineDatumOrHash ScriptLookupError",
  Phase2Warning: "BudgetIsBiggerThanExpected ScriptContextNotExamined",
};

describe("the error catalogue (src/docs/errors.json)", () => {
  const errors = loadErrors();

  it("covers exactly the library's error and warning names, with the right phase and kind", () => {
    const expected = new Map<string, { phase: number; kind: string }>();
    for (const [enumName, names] of Object.entries(LIBRARY_NAMES)) {
      for (const name of names.split(" ")) expected.set(name, { phase: enumName.startsWith("Phase1") ? 1 : 2, kind: enumName.endsWith("Warning") ? "warning" : "error" });
    }
    expect(expected.size).toBe(127);
    expect(Array.from(errors.keys()).sort()).toEqual(Array.from(expected.keys()).sort());
    for (const [name, entry] of errors) expect({ phase: entry.phase, kind: entry.kind }, name).toEqual(expected.get(name));
  });

  it("every entry says what it means; emitted errors say where to look or how to fix; never-emitted names are flagged", () => {
    const neverEmitted = Array.from(errors)
      .filter(([, e]) => e.emitted === false)
      .map(([n]) => n)
      .sort();
    expect(neverEmitted).toEqual(
      [
        "ConflictingMetadataHash",
        "ExpirationEpochTooSmall",
        "InputUsesRewardAddress",
        "InsufficientFundsForMir",
        "InvalidMetadata",
        "InvalidPrevGovActionId",
        "InvalidRedeemerIndex",
        "MalformedProposal",
        "MissingTxBodyMetadataHash",
        "MissingTxMetadata",
        "NativeScriptIsReferencedByRedeemer",
        "OutputBootAddrAttrsTooBig",
        "PlutusScriptIsUnsuccessful",
        "ProposalCantFollow",
        "UnknownError",
      ].sort(),
    );
    for (const [name, entry] of errors) {
      expect(entry.meaning.length, name).toBeGreaterThan(10);
      expect(entry.group, name).toMatch(/^[a-z0-9-]+$/);
      if (entry.emitted === false) expect(entry.meaning, name).toMatch(/never emitted/);
      else if (entry.kind === "error") expect(entry.fix ?? entry.inspect, name).toBeTruthy();
      expect(errorLine(name, entry).length, name).toBeLessThan(700);
    }
    expect(Object.values(errorNamesByGroup()).flat()).toHaveLength(errors.size);
  });

  it("findError is case-insensitive and suggests close names; searchErrors ranks name hits first", () => {
    expect(findError("feetoosmallutxo")).toMatchObject({ name: "FeeTooSmallUTxO" });
    expect(findError("FeeTooSmall")).toMatchObject({ similar: ["FeeTooSmallUTxO"] });
    expect(findError("zzz").similar).toEqual([]);
    const hits = searchErrors("collateral");
    expect(hits.names[0]).toMatch(/Collateral/);
    expect(hits.total).toBeGreaterThan(8);
  });
});

describe("tx_validate's error_docs pointer", () => {
  it("names each distinct catalogued name once, capped, and is absent without rows", () => {
    const names = Array.from(loadErrors().keys()).slice(0, 14);
    const row = (name: string) => ({ name });
    const pointer = errorDocsPointer({
      phase1: { errors: [row(names[0]!), row(names[0]!), row("NotACatalogueName"), ...names.slice(1, 8).map(row)], warnings: [row(names[8]!)] },
      phase2: { errors: names.slice(9, 12).map(row), warnings: [] },
      not_examined: { items: names.slice(12).map(row) },
    })!;
    expect(pointer.startsWith("docs(error=<Name>) explains each name: ")).toBe(true);
    expect(pointer).toContain(`${names.slice(0, ERROR_DOCS_MAX_NAMES).join(", ")} (+4 more)`);
    expect(pointer).not.toContain("NotACatalogueName");
    expect(pointer.length).toBeLessThan(400);
    expect(errorDocsPointer({ phase1: { errors: [], warnings: [] } })).toBeUndefined();
  });
});

describe("answerDocs (tool dispatch)", () => {
  const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.find((c) => c.type === "text")!.text!;

  it("no arguments -> the topics, one line each; topic -> summary and section list (not the text)", () => {
    const index = answerDocs({});
    const body = index.structuredContent as { topics: Array<{ topic: string }>; error_names: number; resources: Array<{ uri: string }> };
    expect(body.topics.map((t) => t.topic)).toEqual([...DOC_TOPICS]);
    expect(body.error_names).toBe(127);
    expect(body.resources.map((r) => r.uri)).toEqual(["cardano-debug://docs"]);
    expect(JSON.parse(text(index))).toEqual(index.structuredContent);
    expect(text(index).length).toBeLessThan(4_000);
    for (const topic of DOC_TOPICS) {
      const t = answerDocs({ topic });
      const s = t.structuredContent as { topic: string; sections: Array<{ section: string; gist: string; chars: number }>; errors?: Record<string, string[]> };
      expect(s.topic).toBe(topic);
      expect(s.sections.map((x) => x.section)).toEqual(getTopic(topic).sections.map((x) => x.slug));
      expect(text(t)).not.toContain(getTopic(topic).sections[1]!.text.split("\n")[2]!); // gists, not the text
      expect(text(t).length, topic).toBeLessThan(topic === "validation-errors" ? 8_000 : 5_000);
      if (topic === "validation-errors") expect(Object.values(s.errors!).flat()).toHaveLength(127);
    }
  });

  it("section -> the markdown once (text) with metadata; unknown -> invalid_argument with the ids", () => {
    const collateral = answerDocs({ topic: "tx-anatomy", section: "collateral" });
    const section = getTopic("tx-anatomy").sections.find((s) => s.slug === "collateral")!;
    expect(text(collateral)).toBe(section.text);
    expect(collateral.structuredContent).toMatchObject({ topic: "tx-anatomy", section: "collateral", title: "Collateral rules", matched_by: "exact", resource: "cardano-debug://docs/tx-anatomy/collateral", previous: "datums", next: "fees-min-utxo" });
    expect(collateral.structuredContent).not.toHaveProperty("text");
    const anywhere = answerDocs({ section: "Phase 2" });
    expect((anywhere.structuredContent as { also_matching: string[] }).also_matching.length).toBeGreaterThan(0);
    const missing = answerDocs({ topic: "uplc-cek", section: "no such heading" });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({ code: "invalid_argument", argument: "section", available: getTopic("uplc-cek").sections.map((s) => s.slug) });
    for (const s of allSections()) expect(text(answerDocs({ topic: s.topic, section: s.slug }))).toBe(s.text);
  });

  it("error -> one entry; unknown -> invalid_argument with close names", () => {
    const fee = answerDocs({ error: "FeeTooSmallUTxO" });
    expect(fee.structuredContent).toMatchObject({ name: "FeeTooSmallUTxO", phase: 1, kind: "error", group: "balance-fees" });
    expect(text(fee).length).toBeLessThan(1_200);
    const bad = answerDocs({ error: "FeeTooSmall" });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toMatchObject({ code: "invalid_argument", argument: "error", similar: ["FeeTooSmallUTxO"] });
  });

  it("query searches every section and the catalogue, with caps and hints", () => {
    const all = answerDocs({ query: "FeeTooSmallUTxO" });
    const q = all.structuredContent as { total_matches: number; blocks: Array<{ topic: string; section: string; text: string }>; errors: { names: string[] }; scope: { topic: string } };
    expect(q.scope.topic).toBe("all");
    expect(q.total_matches).toBeGreaterThanOrEqual(3);
    expect(q.blocks.every((b) => /FeeTooSmallUTxO/i.test(b.text) && b.section.length > 0)).toBe(true);
    expect(q.errors.names[0]).toBe("FeeTooSmallUTxO");
    const narrowed = answerDocs({ query: "headList", topic: "uplc-cek", section: "errors" });
    expect(narrowed.structuredContent).toMatchObject({ scope: { topic: "uplc-cek", section: "errors" } });
    expect((narrowed.structuredContent as { blocks: Array<{ section: string }> }).blocks.every((b) => b.section === "errors")).toBe(true);
    const broad = answerDocs({ query: "the" });
    const b = broad.structuredContent as { truncated?: boolean; hint?: string; total_matches: number; blocks_returned: number };
    expect(b.truncated).toBe(true);
    expect(b.hint).toMatch(/narrow/);
    expect(b.total_matches).toBeGreaterThan(b.blocks_returned);
    expect(text(broad).length).toBeLessThan(30_000);
    const none = answerDocs({ query: "zzz-definitely-absent-zzz" });
    expect(none.structuredContent).toMatchObject({ total_matches: 0, hint: expect.stringMatching(/No line/) });
    expect(answerDocs({ query: "headList", topic: "uplc-cek", section: "no such heading" }).isError).toBe(true);
    expect(answerDocs({ query: "x" }).isError).toBe(true);
  });
});

describe("doc facts that were wrong once (ledger rules and emitted fields)", () => {
  const topicText = (topic: DocTopic) => getTopic(topic).sections.map((s) => s.text).join("\n\n");
  const entry = (name: string) => errorLine(name, loadErrors().get(name)!);

  it("collateral is the ledger's ceiling, not integer division", () => {
    expect(topicText("tx-anatomy")).not.toMatch(/integer division/);
    expect(topicText("tx-anatomy")).toMatch(/ceil\(fee·pct\/100\)/);
    // the doc's example is the artificial S1 transaction: fee 267027 at 150 % needs ceil(400540.5) = 400541
    expect((fxBig("s01.fee") * 150n + 99n) / 100n).toBe(fxBig("s01.collateralTotal"));
    expect(topicText("validation-errors")).toMatch(new RegExp(`ceil\\(fee × pct / 100\\).*fee ${fxStr("s01.fee")}.*${fxStr("s01.collateralTotal")}`));
    expect(topicText("tx-anatomy")).toContain(`fee ${fxStr("s01.fee")} at 150 needs ${fxStr("s01.collateralTotal")}`);
  });

  it("Conway rejects V1 only for inline datums; ReferenceInputsNotAllowedForPlutusV1 is server-only", () => {
    expect(topicText("script-context")).not.toMatch(/ReferenceScriptsNotSupported/);
    expect(topicText("script-context")).toMatch(/reference scripts and reference inputs are accepted/);
    expect(topicText("tx-anatomy")).not.toMatch(/cannot carry inline datums\/reference inputs/);
    expect(topicText("validation-errors")).toMatch(/Node may accept server errors: ExtraneousSignature; ReferenceInputsNotAllowedForPlutusV1/);
    expect(entry("ReferenceInputsNotAllowedForPlutusV1")).toMatch(/server-only.*Node: the node accepts it/);
    expect(entry("InlineDatumNotAllowedForPlutusV1")).toMatch(/Conway rejects V1 only for inline datums/);
  });

  it("names only what the tools emit", () => {
    expect(topicText("tx-anatomy")).not.toMatch(/NativeScriptIsReferencedByRedeemer/);
    expect(entry("NativeScriptIsReferencedByRedeemer")).toMatch(/never emitted.*MissingRequiredScript/);
    expect(topicText("uplc-cek")).not.toMatch(/Report: `replayed`/);
    expect(topicText("script-context")).toContain('{"type":"Constr","tag":"121"');
    expect(topicText("cbor-cddl")).toMatch(/expected value 5, got 16/);
    expect(topicText("cbor-cddl")).toMatch(/Alonzo `#6\.259` map keys 0-2/);
    expect(topicText("cbor-cddl")).not.toMatch(/\| `invalid_hex: Odd number of digits`/);
  });

  it("CDDL behaviour of the current library: map-form redeemers validate, per-chunk `.size` only under bounded_bytes, unexpected-key fragments", () => {
    const cbor = topicText("cbor-cddl");
    expect(cbor).toMatch(/`\{\+ \[tag, index\] => \[data, ex_units\]\}` \(both validate\)/);
    expect(cbor).toMatch(/Per chunk only under `bounded_bytes`; every other `\.size` measures the whole string/);
    expect(cbor).toMatch(/a metadatum string over 64 bytes fails chunked or not/);
    expect(cbor).not.toMatch(/Only the upper bound of `\.size` reads per chunk/);
    expect(cbor).toMatch(/for `unexpected key` its map written out \(the choice if 2\+ alternatives are maps\)/);
    expect(cbor).not.toMatch(/the choice holding it/);
    expect(cbor).toMatch(/`\$\["a\.b"\]` if not an identifier/);
  });

  it("phase-2 context refusals and nesting refusals are documented as the tools answer them", () => {
    const v = topicText("validation-errors");
    expect(v).toMatch(/`not_run` never evaluated \(context refused/);
    expect(v).toMatch(/Context refusals \(the script never ran\): UnreadableOutput, UnreadableTransactionField, ByronAddressNotAllowed, CertificateNotSupportedInPlutusV1V2, FieldNotSupportedInPlutusV1V2/);
    for (const name of ["UnreadableOutput", "UnreadableTransactionField", "ByronAddressNotAllowed", "CertificateNotSupportedInPlutusV1V2", "FieldNotSupportedInPlutusV1V2"]) expect(entry(name), name).toMatch(/no context: .*the script never ran/);
    expect(entry("CertificateNotSupportedInPlutusV1V2")).toMatch(/Conway certificate \(kinds 9-18\)/);
    expect(v).toMatch(/context_build BuildTxContextError or a context refusal/);
    expect(v).toMatch(/tx nesting > 64 typed \/ 128 CSL \(tag-24 payloads count at their depth; native scripts exempt, ≤ 32768\): code unexamined/);
    expect(v).toMatch(/Context UTxO past 128 \(native script past 32768\): NativeScriptNotExamined/);
    expect(v).toMatch(/NativeScriptNotExamined \/ ScriptContextNotExamined \(redeemers not run\) = limit, not finding \(verdict not_examined\)/);
    expect(v).toMatch(/timeout\/not_examined/);
    expect(topicText("cbor-cddl")).toMatch(/`nesting_too_deep` \(more than 32768 levels, native scripts included/);
    expect(topicText("cbor-cddl")).toMatch(/`not_tried`: types skipped at the typed decoders' 64 levels, native scripts exempt/);
    for (const topic of ["validation-errors", "cbor-cddl", "tx-anatomy", "debug-playbook"] as const) expect(topicText(topic), topic).not.toMatch(/16384 levels|nesting > 256|> 512\b/);
    expect(topicText("tx-anatomy")).toMatch(/`exact\|slack\|over_budget\|not_run`/);
  });

  it("the playbook keeps the decode-failure path and the pointer to cbor-cddl", () => {
    const bytes = findSection("Bytes that will not decode", "debug-playbook");
    expect(bytes?.how).toBe("exact");
    for (const needle of ["decode_failed", "cbor_validate(hex, rule='transaction')", "cddl_check", "cbor-cddl"]) expect(bytes!.section.text).toContain(needle);
    const cbor = topicText("cbor-cddl");
    for (const needle of ["258", "121", "1280", "trailing_data", "unexpected_eof", "MapKeysNotSorted", "cddl_check", "cbor_decode", "cbor_validate"]) expect(cbor, needle).toContain(needle);
  });
});
