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

test("taxonomy summary covers every non-Step-1 launch exam", () => {
  const summary = multiExamSourceTaxonomySummary();
  assert.deepEqual(summary.hierarchy, ["system", "subsystem", "topic", "subtopic"]);
  assert.deepEqual(summary.exams, ["usmle-step-2", "usmle-step-3", "amc", "mccqe", "nclex", "plab"]);
});
