import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTENT_TAXONOMY_CLASSIFIER_AUTO_APPROVAL_PERCENT,
  buildContentTaxonomyProviderPairRequest,
  contentTaxonomyClassifierMaxOutputTokens,
  normalizeContentTaxonomyProviderPairClassification,
} from "../lib/content-taxonomy-classifier.js";

function pair(overrides = {}) {
  return {
    exam_track: "usmle-step-1",
    source_namespace: "private-step-1",
    source_system_id: "12",
    source_subject_id: "44",
    question_count: 2,
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    total: 2,
    questions: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        student_qid: "NGQ-00000001",
        title: "Vitamin B12 deficiency",
        question_html: "<p>A patient has macrocytosis and loss of vibration sense.</p>",
        explanation_html: "<p>Defective DNA synthesis causes megaloblastic anemia.</p>",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        student_qid: "NGQ-00000002",
        title: "Pernicious anemia",
        question_html: "<p>Autoantibodies prevent cobalamin absorption.</p>",
        explanation_html: "<p>Intrinsic factor loss causes vitamin B12 deficiency.</p>",
      },
    ],
    ...overrides,
  };
}

function proposal(overrides = {}) {
  return {
    system: "Hematology",
    subsystem: "Red blood cell disorders",
    topic: "Megaloblastic anemia",
    subtopic: "Vitamin B12 deficiency",
    pair_homogeneous: true,
    every_question_reviewed: true,
    confidence_percent: 99,
    ambiguity_flags: [],
    outlier_question_ids: [],
    classification_reason: "Both questions test cobalamin-deficiency megaloblastic anemia.",
    ...overrides,
  };
}

test("taxonomy classifier uses a bounded output budget suitable for reasoning", () => {
  assert.equal(contentTaxonomyClassifierMaxOutputTokens(), 12_000);
  assert.equal(contentTaxonomyClassifierMaxOutputTokens("2000"), 8_000);
  assert.equal(contentTaxonomyClassifierMaxOutputTokens("16000"), 16_000);
  assert.equal(contentTaxonomyClassifierMaxOutputTokens("90000"), 30_000);
});

test("provider-pair evidence contains every question and strips markup", () => {
  const request = buildContentTaxonomyProviderPairRequest(pair(), evidence(), {
    examLabel: "USMLE Step 1",
    allowedSystems: ["Cardiovascular", "Hematology"],
  });
  assert.equal(request.evidenceComplete, true);
  assert.equal(request.questions.length, 2);
  assert.equal(request.questions[0].stem_signal.includes("<p>"), false);
  assert.match(request.systemPrompt, /every supplied question/i);
  assert.match(request.userPrompt, /Vitamin B12 deficiency/);
  assert.equal(request.textFormat.type, "json_schema");
  assert.equal(request.reasoning.effort, "low");
});

test("only complete, homogeneous, all-question, very-high-confidence mappings auto-approve", () => {
  const request = buildContentTaxonomyProviderPairRequest(pair(), evidence(), {
    examLabel: "USMLE Step 1",
    allowedSystems: ["Cardiovascular", "Hematology"],
  });
  const normalized = normalizeContentTaxonomyProviderPairClassification(proposal(), request);
  assert.equal(normalized.autoApprovalReady, true);
  assert.equal(normalized.confidencePercent, 99);
  assert.equal(CONTENT_TAXONOMY_CLASSIFIER_AUTO_APPROVAL_PERCENT, 97);
  assert.deepEqual(normalized.mappingTaxonomy, {
    system_key: "hematology",
    subsystem_key: "red_blood_cell_disorders",
    topic_key: "megaloblastic_anemia",
    subtopic_key: "vitamin_b12_deficiency",
    labels: {
      system: "Hematology",
      subsystem: "Red blood cell disorders",
      topic: "Megaloblastic anemia",
      subtopic: "Vitamin B12 deficiency",
    },
  });
});

test("mixed or incomplete provider pairs fail closed for manual review", () => {
  const request = buildContentTaxonomyProviderPairRequest(pair({ question_count: 3 }), evidence({
    total: 3,
  }), {
    examLabel: "USMLE Step 1",
    allowedSystems: ["Cardiovascular", "Hematology"],
  });
  const normalized = normalizeContentTaxonomyProviderPairClassification(proposal({
    pair_homogeneous: false,
    every_question_reviewed: true,
    confidence_percent: 99,
    ambiguity_flags: ["One question concerns iron deficiency"],
    outlier_question_ids: ["22222222-2222-4222-8222-222222222222"],
  }), request);
  assert.equal(request.evidenceComplete, false);
  assert.equal(normalized.autoApprovalReady, false);
  assert.ok(normalized.reviewReasons.includes("incomplete_pair_evidence"));
  assert.ok(normalized.reviewReasons.includes("heterogeneous_provider_pair"));
  assert.ok(normalized.reviewReasons.includes("question_outliers"));
});

test("a system outside the exam taxonomy cannot be auto-approved", () => {
  const request = buildContentTaxonomyProviderPairRequest(pair(), evidence(), {
    examLabel: "USMLE Step 1",
    allowedSystems: ["Cardiovascular", "Hematology"],
  });
  const normalized = normalizeContentTaxonomyProviderPairClassification(proposal({
    system: "Pediatrics",
  }), request);
  assert.equal(normalized.autoApprovalReady, false);
  assert.equal(normalized.mappingTaxonomy.system_key, "unclassified");
  assert.ok(normalized.reviewReasons.includes("system_outside_exam_taxonomy"));
});
