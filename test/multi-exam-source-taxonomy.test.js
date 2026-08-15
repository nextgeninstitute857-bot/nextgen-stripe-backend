import assert from "node:assert/strict";
import test from "node:test";
import { adaptUniversalQuestion, validateAdaptedQuestion } from "../lib/content-import-adapter.js";
import {
  multiExamSourceQuestionTaxonomy,
  multiExamSourceTaxonomySummary,
} from "../lib/multi-exam-source-taxonomy.js";

const question = (overrides = {}) => ({
  id: 42,
  sysId: 1012,
  subId: 102,
  title: "Acute coronary syndrome management",
  question: "A 62-year-old patient has chest pain. What is the next best step in management?",
  explanation: "This presentation requires urgent management.",
  corrAns: 1,
  ...overrides,
});

test("Step 2 and Step 3 source IDs resolve to complete exam-specific hierarchies", () => {
  const step2 = multiExamSourceQuestionTaxonomy(question(), { examTrack: "usmle-step-2", sourceProvider: "UWorld" });
  assert.deepEqual(step2.errors, []);
  assert.equal(step2.taxonomy.labels.system, "Cardiovascular");
  assert.equal(step2.taxonomy.labels.subsystem, "Medicine");
  assert.equal(step2.taxonomy.labels.subtopic, "Management");

  const step3 = multiExamSourceQuestionTaxonomy(question({ sysId: 1018, subId: 106 }), { examTrack: "usmle-step-3" });
  assert.equal(step3.taxonomy.labels.system, "Pulmonary");
  assert.equal(step3.taxonomy.labels.subsystem, "Surgery");
  for (const field of ["system_key", "subsystem_key", "topic_key", "subtopic_key"]) {
    assert.ok(step3.taxonomy[field]);
  }
});

test("AMC providers retain their source systems and gain AMC patient-group terminology", () => {
  const amedex = multiExamSourceQuestionTaxonomy(question({ sysId: 231, title: "0015 - Paediatric asthma" }), {
    examTrack: "amc",
    sourceProvider: "Amedex",
  });
  assert.equal(amedex.taxonomy.labels.system, "Child Health");
  assert.equal(amedex.taxonomy.labels.subsystem, "Adult and General Population");
  assert.equal(amedex.taxonomy.labels.topic, "Paediatric asthma");

  const mplusx = multiExamSourceQuestionTaxonomy(question({ sysId: 39, title: "Question - 42" }), {
    examTrack: "amc",
    sourceProvider: "MPlusX",
  });
  assert.equal(mplusx.taxonomy.labels.system, "Cardiovascular");
  assert.match(mplusx.taxonomy.labels.topic, /chest pain/i);
});

test("the universal importer persists and validates multi-exam taxonomy", () => {
  const adapted = adaptUniversalQuestion(question(), [
    { answerId: 1, answerText: "Treat now" },
    { answerId: 2, answerText: "Observe" },
  ], {
    examTrack: "usmle-step-2",
    sourceProvider: "UWorld",
    sourceNamespace: "uworld-step2-2026",
    collectionKey: "step2",
  });
  assert.equal(adapted.sourceData.source_taxonomy_adapter, "multi_exam_source_taxonomy_v1");
  assert.equal(adapted.sourceData.taxonomy_import_ready, true);
  assert.equal(validateAdaptedQuestion(adapted).length, 0);
});

test("AMBOSS uses its verified provider-wide system ledger across all USMLE banks", () => {
  for (const examTrack of ["usmle-step-1", "usmle-step-2", "usmle-step-3"]) {
    const result = multiExamSourceQuestionTaxonomy(question({ sysId: "4,16", subId: "23,42" }), {
      examTrack,
      sourceProvider: "AMBOSS",
      sourceNamespace: `ambossqb-${examTrack}-2025`,
    });
    assert.deepEqual(result.errors, [], examTrack);
    assert.equal(result.taxonomy.labels.system, "Cardiovascular", examTrack);
    assert.deepEqual(result.taxonomy.provider_tag_ids, ["23", "42"], examTrack);
    assert.equal(result.taxonomy.review_status, "source_evidence_verified_mapping", examTrack);
    for (const field of ["system_key", "subsystem_key", "topic_key", "subtopic_key"]) {
      assert.ok(result.taxonomy[field], `${examTrack}:${field}`);
    }
  }
});

test("an unknown AMBOSS system fails taxonomy validation instead of silently publishing", () => {
  const result = multiExamSourceQuestionTaxonomy(question({ sysId: 99 }), {
    examTrack: "usmle-step-2",
    sourceProvider: "AMBOSS",
  });
  assert.deepEqual(result.errors, ["amboss_system_not_in_verified_map"]);
});

test("taxonomy summary covers every launch exam", () => {
  const summary = multiExamSourceTaxonomySummary();
  assert.deepEqual(summary.hierarchy, ["system", "subsystem", "topic", "subtopic"]);
  assert.deepEqual(summary.exams, ["usmle-step-1", "usmle-step-2", "usmle-step-3", "amc", "mccqe", "nclex", "plab"]);
  assert.equal(summary.amboss_systems, 18);
});
