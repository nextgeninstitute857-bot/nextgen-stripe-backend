import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  CONTENT_SOURCE_ADAPTERS,
  adaptUniversalQuestion,
  resolveContentSourceAdapter,
  validateAdaptedQuestion,
} from "../lib/content-import-adapter.js";
import {
  resolveStep1SourceTaxonomy,
  step1SourceTaxonomyLedgerSummary,
} from "../lib/step1-source-taxonomy.js";

const answers = [1, 2, 3, 4, 5].map((answerId) => ({
  id: answerId,
  qId: 1,
  answerId,
  answerText: `Choice ${answerId}`,
}));

function sourceQuestion(overrides = {}) {
  return {
    id: 1,
    question: "<p>Question stem</p>",
    explanation: "<p>Explanation</p>",
    corrAns: 3,
    sysId: 1148,
    subId: 116,
    title: "Poststreptococcal Glomerulonephritis",
    ...overrides,
  };
}

test("Step 1 source taxonomy resolves all four controlled levels deterministically", () => {
  const first = resolveStep1SourceTaxonomy({
    nativeSysId: 1148,
    nativeSubId: 116,
    title: "Poststreptococcal Glomerulonephritis",
  });
  const same = resolveStep1SourceTaxonomy({
    nativeSysId: "1148",
    nativeSubId: "116",
    title: "  poststreptococcal   glomerulonephritis  ",
  });
  assert.deepEqual(first.errors, []);
  assert.equal(first.taxonomy.subtopic_key, same.taxonomy.subtopic_key);
  for (const field of ["system_key", "subsystem_key", "topic_key", "subtopic_key"]) {
    assert.ok(first.taxonomy[field]);
  }
  assert.equal(first.taxonomy.topic_key, "topic:uw-sys-1148");
  assert.match(first.taxonomy.subtopic_key, /^subtopic:uw-sys-1148:poststreptococcal-glomerulonephritis:[a-f0-9]{12}$/);
  assert.equal(first.taxonomy.labels.subtopic, "Poststreptococcal Glomerulonephritis");
});

test("Step 1 source taxonomy fails closed for unknown native IDs or a missing subtopic title", () => {
  const result = resolveStep1SourceTaxonomy({ nativeSysId: 9999, nativeSubId: 999, title: "" });
  assert.equal(result.taxonomy, null);
  assert.deepEqual(result.errors.sort(), [
    "taxonomy_discipline_not_in_step1_ledger",
    "taxonomy_subsystem_not_in_step1_ledger",
    "taxonomy_subtopic_title_required",
    "taxonomy_system_not_in_step1_ledger",
    "taxonomy_topic_not_in_step1_ledger",
  ]);
});

test("the source adapter persists controlled taxonomy without treating source questions as AylaMed originals", () => {
  const row = adaptUniversalQuestion(sourceQuestion(), answers, {
    examTrack: "usmle-step-1",
    sourceNamespace: "step1-2026-march",
    sourceProvider: "Imported source",
    collectionKey: "step1-2026-march",
    collectionTitle: "Step 1 March 2026",
    sourceFile: "step1-2026-march_questions.json",
    sourcePosition: 1,
  });
  assert.equal(row.sourceData.source_adapter, CONTENT_SOURCE_ADAPTERS.step1SourceTaxonomySba);
  assert.notEqual(row.sourceData.source_adapter, CONTENT_SOURCE_ADAPTERS.aylaMedOwnedSba);
  assert.equal(row.sourceData.taxonomy_import_ready, true);
  assert.equal(row.sourceData.taxonomy_publication_ready, false);
  assert.equal(row.taxonomy.source, "step1_source_taxonomy_ledger");
  assert.deepEqual(validateAdaptedQuestion(row), []);
});

test("Step 1 source-shaped rows fail closed when native taxonomy IDs are unknown", () => {
  const invalidQuestion = sourceQuestion({ sysId: 9999, subId: 999 });
  const adapter = resolveContentSourceAdapter({ examTrack: "usmle-step-1" }, invalidQuestion, answers);
  const row = adaptUniversalQuestion(invalidQuestion, answers, {
    examTrack: "usmle-step-1",
    sourceNamespace: "step1-2026-march",
  });
  assert.equal(adapter, CONTENT_SOURCE_ADAPTERS.step1SourceTaxonomySba);
  assert.equal(row.sourceData.source_adapter, CONTENT_SOURCE_ADAPTERS.step1SourceTaxonomySba);
  assert.equal(row.sourceData.taxonomy_import_ready, false);
  assert.ok(validateAdaptedQuestion(row).includes("taxonomy_topic_not_in_step1_ledger"));
});

test("the approved Step 1 ledger contains the complete 11/27/169 hierarchy and 13 disciplines", () => {
  const summary = step1SourceTaxonomyLedgerSummary();
  assert.equal(summary.systems, 11);
  assert.equal(summary.subsystems, 27);
  assert.equal(summary.topics, 169);
  assert.equal(summary.disciplines, 13);
});

test("the in-place repair is count-locked, preview-locked, private-only, and taxonomy-only", async () => {
  const postgres = await fs.readFile(new URL("../lib/content-registry-postgres.js", import.meta.url), "utf8");
  const server = await fs.readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /content-registry\/collections\/:collectionId\/taxonomy-repair-preview/);
  assert.match(server, /content-registry\/collections\/:collectionId\/repair-taxonomy/);
  assert.match(server, /REPAIR TAXONOMY \$\{expectedQuestionCount\}/);
  assert.match(postgres, /STEP1_TAXONOMY_REPAIR_COUNT_CHANGED/);
  assert.match(postgres, /STEP1_TAXONOMY_REPAIR_PREVIEW_CHANGED/);
  assert.match(postgres, /student_destination_enabled/);
  assert.match(postgres, /approved_or_delivered_question_present/);
  assert.match(postgres, /questions_created: 0/);
  assert.match(postgres, /answers_changed: 0/);
  assert.match(postgres, /source_ids_changed: 0/);
  assert.match(postgres, /media_changed: 0/);
  assert.match(postgres, /publication_state_changed: false/);
  assert.match(postgres, /Taxonomy verification did not reach 100%; the transaction was rolled back/);
});
