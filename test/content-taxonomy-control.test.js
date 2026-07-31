import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  CONTENT_TAXONOMY_EXAM_TRACKS,
  buildContentTaxonomyCoverageReport,
  contentTaxonomyIsComplete,
  contentTaxonomyMappingReviewState,
  normalizeContentTaxonomy,
  normalizeContentTaxonomyExamTrack,
  normalizeContentTaxonomyReviewAction,
} from "../lib/content-taxonomy-control.js";

test("taxonomy governance recognizes every supported exam without cross-exam fallback", () => {
  const cases = [
    ["USMLE Step 1", "usmle-step-1"],
    ["usmle_step_2_ck", "usmle-step-2"],
    ["step 3", "usmle-step-3"],
    ["PLAB", "plab"],
    ["AMC", "amc"],
    ["MCCQE", "mccqe"],
    ["NCLEX", "nclex"],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeContentTaxonomyExamTrack(input), expected);
  assert.equal(normalizeContentTaxonomyExamTrack("unknown-board"), null);
  assert.equal(CONTENT_TAXONOMY_EXAM_TRACKS.length, 7);
});

test("taxonomy keys are canonical and approved mappings require the full hierarchy", () => {
  assert.deepEqual(normalizeContentTaxonomy({
    systemKey: "Cardiovascular System",
    topicKey: "Valvular Disease",
    labels: { short_name: "Cardio" },
  }, { requireTopic: true }), {
    system_key: "cardiovascular_system",
    subsystem_key: "",
    topic_key: "valvular_disease",
    subtopic_key: "",
    labels: { short_name: "Cardio" },
  });
  assert.throws(() => normalizeContentTaxonomy({ system_key: "cardiology" }, { requireTopic: true }), /topic_key/);
  assert.throws(() => normalizeContentTaxonomy({
    system_key: "cardiology",
    topic_key: "murmurs",
  }, { requireHierarchy: true }), /subsystem_key/);
  assert.throws(() => normalizeContentTaxonomy({
    system_key: "cardiology",
    subsystem_key: "valvular_disease",
    topic_key: "murmurs",
  }, { requireHierarchy: true }), /subtopic_key/);
  assert.equal(contentTaxonomyIsComplete({
    system_key: "cardiology",
    subsystem_key: "valvular_disease",
    topic_key: "murmurs",
    subtopic_key: "aortic_stenosis",
  }), true);
  assert.equal(contentTaxonomyIsComplete({ system_key: "cardiology", topic_key: "murmurs" }), false);
  assert.equal(contentTaxonomyIsComplete({ system_key: "cardiology" }), false);
});

test("mapping lifecycle distinguishes pending, rejected, disabled, approved, and unmapped", () => {
  assert.equal(contentTaxonomyMappingReviewState({}), "unmapped");
  assert.equal(contentTaxonomyMappingReviewState({ id: "1", status: "pending", review_status: "pending" }), "needs_review");
  assert.equal(contentTaxonomyMappingReviewState({ id: "1", status: "rejected", review_status: "rejected" }), "rejected");
  assert.equal(contentTaxonomyMappingReviewState({ id: "1", status: "disabled", review_status: "approved" }), "disabled");
  assert.equal(contentTaxonomyMappingReviewState({
    id: "1",
    status: "active",
    review_status: "approved",
    system_key: "cardiovascular",
    subsystem_key: "ischemic_heart_disease",
    topic_key: "acute_coronary_syndrome",
    subtopic_key: "myocardial_infarction",
  }), "approved");
  assert.equal(contentTaxonomyMappingReviewState({
    id: "1",
    status: "active",
    review_status: "approved",
    system_key: "cardiovascular",
    topic_key: "acute_coronary_syndrome",
  }), "needs_review");
  assert.equal(normalizeContentTaxonomyReviewAction("re-open"), "reopen");
  assert.equal(normalizeContentTaxonomyReviewAction("delete"), null);
});

test("coverage validation reports every exam and fails closed on incomplete taxonomy", () => {
  const report = buildContentTaxonomyCoverageReport([
    {
      exam_track: "usmle_step_1",
      total_questions: 10,
      approved_questions: 8,
      system_classified_questions: 10,
      subsystem_classified_questions: 9,
      topic_classified_questions: 9,
      subtopic_classified_questions: 9,
      complete_questions: 9,
      provider_pairs_total: 3,
      provider_pairs_approved: 2,
      provider_pairs_unmapped: 1,
    },
    {
      exam_track: "nclex",
      total_questions: 4,
      approved_questions: 4,
      system_classified_questions: 4,
      subsystem_classified_questions: 4,
      topic_classified_questions: 4,
      subtopic_classified_questions: 4,
      complete_questions: 4,
      question_override_count: 1,
      provider_pairs_total: 2,
      provider_pairs_approved: 2,
    },
  ]);
  assert.equal(report.coverage.length, 7);
  const step1 = report.coverage.find((row) => row.exam_track === "usmle-step-1");
  assert.equal(step1.ready, false);
  assert.equal(step1.question_coverage_percent, 90);
  assert.deepEqual(step1.issues, ["incomplete_question_taxonomy", "unreviewed_provider_pairs"]);
  const nclex = report.coverage.find((row) => row.exam_track === "nclex");
  assert.equal(nclex.ready, true);
  assert.equal(report.summary.ready_exam_tracks, 1);
  assert.equal(report.summary.all_exam_tracks_ready, false);
  assert.equal(report.summary.all_content_exam_tracks_ready, false);
});

test("v209 server and Postgres contracts expose review, override, audit, and all-exam coverage", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const postgres = fs.readFileSync(new URL("../lib/content-registry-postgres.js", import.meta.url), "utf8");
  assert.match(server, /v209-content-taxonomy-governance/);
  assert.match(server, /content-registry\/taxonomy\/review-queue/);
  assert.match(server, /content-registry\/taxonomy\/coverage/);
  assert.match(server, /taxonomy-mappings\/:mappingId\/review/);
  assert.match(server, /taxonomy-mappings\/suggest/);
  assert.match(server, /questions\/:questionId\/taxonomy-override/);
  assert.match(server, /api\/ayla\/admin\/resources\/content-taxonomy\/coverage/);
  assert.match(server, /api\/ayla\/admin\/resources\/content-taxonomy\/review-queue/);
  assert.match(server, /api\/ayla\/admin\/resources\/content-taxonomy\/mappings/);
  assert.match(server, /api\/ayla\/admin\/resources\/content-taxonomy\/classification-jobs/);
  assert.match(server, /api\/ayla\/admin\/resources\/classification-status/);
  assert.match(server, /content_taxonomy_provider_pair_classification/);
  assert.match(server, /auto_approve_high_confidence/);
  assert.match(server, /question_complete_when: \["system_key", "subsystem_key", "topic_key", "subtopic_key"\]/);
  assert.match(postgres, /content_taxonomy_audit_events/);
  assert.match(postgres, /content_question_taxonomy_overrides/);
  assert.match(postgres, /getContentTaxonomyProviderPairEvidence/);
  assert.match(postgres, /COUNT\(\*\) OVER\(\)::int AS pair_question_count/);
  assert.match(postgres, /review_status='approved'/);
  assert.match(postgres, /automatic_suggestion_skipped/);
  assert.match(postgres, /SELECT q\.id FROM content_questions q[\s\S]*?FOR UPDATE[\s\S]*?content_question_taxonomy_overrides/);
  assert.match(postgres, /NOT EXISTS[\s\S]*content_question_taxonomy_overrides/);
});
