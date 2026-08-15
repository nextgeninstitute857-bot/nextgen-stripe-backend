import test from "node:test";
import assert from "node:assert/strict";
import {
  AYLA_NBME_CONTENT_DESTINATION,
  AYLA_NBME_STEP1_REVIEWED_RELEASE_FORM_IDS,
  assertAylaNbmeExamPlacement,
  assertAylaNbmeReviewedReleaseForm,
  buildAylaNbmeFormRecord,
  buildAylaNbmeReadinessSnapshot,
  createAylaNbmeAttempt,
  finalizeAylaNbmeAttempt,
  normalizeAylaNbmeManifest,
  parseAylaNbmeCollectionKey,
  recordAylaNbmeAnswer,
  sanitizeAylaNbmeAttempt,
  validateAylaNbmeStudentEnable,
} from "../lib/aylamed-nbme-center.js";

function readyForm(collectionKey, extra = {}) {
  const definition = parseAylaNbmeCollectionKey(collectionKey);
  return buildAylaNbmeFormRecord({
    collectionKey,
    sourceQuestionCount: definition.expectedQuestionCount,
    importedQuestionCount: definition.expectedQuestionCount,
    missingExplanations: 0,
    orphanAnswers: 0,
    invalidAnswerKeys: 0,
    missingMedia: 0,
    ambiguousMedia: 0,
    corruptMedia: 0,
    collectionId: "11111111-1111-4111-8111-111111111111",
    registryStatus: "approved",
    rightsStatus: "licensed",
    destinationEnabled: true,
    studentEnabled: true,
    ...extra,
  }, {}, new Date("2026-07-29T10:00:00.000Z"));
}

function questions(count = 200) {
  return Array.from({ length: count }, (_, index) => ({
    id: `question-${index + 1}`,
    question_ref: `ref-${index + 1}`,
    canonical_hash: `hash-${index + 1}`,
    source_position: index + 1,
  }));
}

test("form mapping separates Step 1, Step 2 CK, Step 3 and Step 2 clinical subject forms", () => {
  assert.deepEqual(
    {
      exam: parseAylaNbmeCollectionKey("nbme-1-31").examTrack,
      type: parseAylaNbmeCollectionKey("nbme-1-31").formType,
    },
    { exam: "usmle-step-1", type: "comprehensive_self_assessment" },
  );
  assert.equal(parseAylaNbmeCollectionKey("nbme-2-15.db").examTrack, "usmle-step-2");
  assert.equal(parseAylaNbmeCollectionKey("nbme-3-8").examTrack, "usmle-step-3");
  const surgery = parseAylaNbmeCollectionKey("nbme-Surgery-9");
  assert.equal(surgery.examTrack, "usmle-step-2");
  assert.equal(surgery.formType, "clinical_subject");
  assert.equal(surgery.specialtyKey, "surgery");
  assert.equal(surgery.expectedQuestionCount, 50);
  assert.equal(parseAylaNbmeCollectionKey("nbme-Emergency Medicine-3").specialtyKey, "emergency_medicine");
  assert.equal(parseAylaNbmeCollectionKey("nbme-Family Medicine-5").examTrack, "usmle-step-2");
  assert.equal(AYLA_NBME_CONTENT_DESTINATION, "aylamed_nbme");
});

test("manifest rejects any declared exam that conflicts with the form identity", () => {
  assert.throws(() => normalizeAylaNbmeManifest({
    forms: [{
      collection_key: "nbme-3-8",
      exam_track: "usmle-step-1",
      source_question_count: 200,
      imported_question_count: 200,
    }],
  }), (error) => error.code === "NBME_MANIFEST_EXAM_MISMATCH");
  assert.throws(
    () => assertAylaNbmeExamPlacement(parseAylaNbmeCollectionKey("nbme-2-15"), "usmle-step-1"),
    (error) => error.code === "NBME_FORM_EXAM_MISMATCH",
  );
});

test("reviewed release keeps Step 1 allowlisted and accepts matching Step 2 and Step 3 forms", () => {
  assert.deepEqual(AYLA_NBME_STEP1_REVIEWED_RELEASE_FORM_IDS, [
    "nbme-step-1-form-25",
    "nbme-step-1-form-26",
    "nbme-step-1-form-28",
    "nbme-step-1-form-30",
    "nbme-step-1-form-31",
    "nbme-step-1-form-32",
  ]);
  for (const formId of AYLA_NBME_STEP1_REVIEWED_RELEASE_FORM_IDS) {
    const formNumber = formId.split("-").at(-1);
    assert.equal(
      assertAylaNbmeReviewedReleaseForm(formId, `nbme-1-${formNumber}`).formId,
      formId,
    );
  }
  assert.throws(
    () => assertAylaNbmeReviewedReleaseForm("nbme-step-1-form-27", "nbme-1-27"),
    (error) => error.code === "NBME_RELEASE_FORM_NOT_REVIEWED",
  );
  assert.throws(
    () => assertAylaNbmeReviewedReleaseForm("nbme-step-1-form-25", "nbme-1-26"),
    (error) => error.code === "NBME_RELEASE_FORM_COLLECTION_MISMATCH",
  );
  assert.equal(
    assertAylaNbmeReviewedReleaseForm("nbme-step-2-ck-form-15", "nbme-2-15").examTrack,
    "usmle-step-2",
  );
  assert.equal(
    assertAylaNbmeReviewedReleaseForm("nbme-step-2-ck-surgery-form-9", "nbme-Surgery-9").formType,
    "clinical_subject",
  );
  assert.equal(
    assertAylaNbmeReviewedReleaseForm("nbme-step-3-form-8", "nbme-3-8").examTrack,
    "usmle-step-3",
  );
});

test("incomplete forms remain private and cannot be enabled without an explicit reviewed override", () => {
  const incomplete = buildAylaNbmeFormRecord({
    collectionKey: "nbme-1-21",
    sourceQuestionCount: 199,
    importedQuestionCount: 0,
    missingExplanations: 199,
    orphanAnswers: 1,
    collectionId: "11111111-1111-4111-8111-111111111111",
    registryStatus: "approved",
    rightsStatus: "licensed",
    destinationEnabled: true,
  });
  assert.equal(incomplete.status, "private_draft");
  assert.equal(incomplete.qualityGate.ready, false);
  assert.deepEqual(
    incomplete.qualityGate.reasons,
    ["unexpected_question_count", "incomplete_import", "missing_explanations", "orphan_answers"],
  );
  assert.throws(
    () => validateAylaNbmeStudentEnable(incomplete),
    (error) => error.code === "NBME_FORM_QUALITY_GATE_FAILED",
  );
  const override = validateAylaNbmeStudentEnable(incomplete, {
    confirmQualityOverride: true,
    qualityOverrideReason: "Reviewed by the medical content owner; incomplete simulation label required.",
  });
  assert.equal(override.allowed, true);
  assert.equal(override.override, true);
});

test("attempts save resumable progress with version checks and withhold scoring until submission", () => {
  const form = readyForm("nbme-1-31");
  const attempt = createAylaNbmeAttempt({
    id: "attempt-1",
    userId: "user-1",
    studentId: "student-1",
    examTrack: "usmle-step-1",
    form,
    questions: questions(200),
    now: new Date("2026-07-29T10:00:00.000Z"),
  });
  assert.equal(attempt.blocks.length, 4);
  assert.equal(attempt.blocks.every((block) => block.questionRefs.length === 50), true);
  const first = recordAylaNbmeAnswer(attempt, {
    questionRef: "ref-1",
    selectedAnswerId: 2,
    correctAnswerId: 2,
    expectedVersion: 1,
    currentQuestionIndex: 1,
    now: new Date("2026-07-29T10:01:00.000Z"),
  });
  assert.equal(first.attempt.version, 2);
  assert.equal(first.attempt.answeredCount, 1);
  assert.equal(first.attempt.correctCount, 1);
  assert.throws(() => recordAylaNbmeAnswer(first.attempt, {
    questionRef: "ref-2",
    selectedAnswerId: 1,
    correctAnswerId: 2,
    expectedVersion: 1,
  }), (error) => error.code === "NBME_ATTEMPT_VERSION_CONFLICT");
  const safe = sanitizeAylaNbmeAttempt(first.attempt);
  assert.equal(safe.answers["ref-1"].selectedAnswerId, 2);
  assert.equal("correctAnswerId" in safe.answers["ref-1"], false);
  assert.equal("correctCount" in safe, false);
  assert.equal("incorrectCount" in safe, false);
  assert.equal("scorePercent" in safe, false);
  assert.equal("collectionId" in safe, false);
  assert.equal("userId" in safe, false);
  assert.equal("studentId" in safe, false);
  assert.equal("questionFingerprints" in safe, false);
});

test("submission is backend-scored, partial attempts require confirmation, and repeat exposure lowers confidence", () => {
  const form = readyForm("nbme-2-15");
  const previousAttempts = [{
    status: "submitted",
    serverVerified: true,
    questionFingerprints: ["hash-1", "hash-2", "hash-3"],
  }];
  let attempt = createAylaNbmeAttempt({
    id: "attempt-2",
    userId: "user-1",
    studentId: "student-2",
    examTrack: "usmle-step-2-ck",
    form,
    questions: questions(20),
    previousAttempts,
    now: new Date("2026-07-29T10:00:00.000Z"),
  });
  attempt = recordAylaNbmeAnswer(attempt, {
    questionRef: "ref-1",
    selectedAnswerId: 2,
    correctAnswerId: 2,
    expectedVersion: 1,
  }).attempt;
  assert.throws(
    () => finalizeAylaNbmeAttempt(attempt, { expectedVersion: 2 }),
    (error) => error.code === "NBME_ATTEMPT_PARTIAL_CONFIRMATION_REQUIRED",
  );
  const finalized = finalizeAylaNbmeAttempt(attempt, {
    expectedVersion: 2,
    confirmPartial: true,
    now: new Date("2026-07-29T12:00:00.000Z"),
  }).attempt;
  assert.equal(finalized.serverVerified, true);
  assert.equal(finalized.correctCount, 1);
  assert.equal(finalized.incorrectCount, 0);
  assert.equal(finalized.unansweredCount, 19);
  assert.equal(finalized.scorePercent, 5);
  assert.equal(finalized.readinessSignal.official_predicted_score, null);
  assert.equal(finalized.readinessSignal.pass_guarantee, false);
  assert.equal(finalized.readinessSignal.confidence, "limited_incomplete_form");
  const safe = sanitizeAylaNbmeAttempt(finalized);
  assert.equal(safe.scorePercent, 5);
  assert.equal(safe.correctCount, 1);
  assert.equal(safe.answers["ref-1"].correct, true);
});

test("Personal Tutor readiness recommends the correct exam form and defers during overload", () => {
  const step1 = readyForm("nbme-1-31");
  const step2 = readyForm("nbme-2-15");
  const baseline = buildAylaNbmeReadinessSnapshot({
    student: { examTrackId: "usmle_step_2_ck", targetDate: "2026-08-20" },
    forms: [step1, step2],
    attempts: [],
    warning: { level: "on_track", backlogMinutes: 0 },
    date: "2026-07-29",
  });
  assert.equal(baseline.available_full_forms, 1);
  assert.equal(baseline.recommendation.state, "baseline_due");
  assert.equal(baseline.recommendation.form_id, step2.id);
  const overloaded = buildAylaNbmeReadinessSnapshot({
    student: { examTrackId: "usmle_step_2_ck", targetDate: "2026-08-20" },
    forms: [step1, step2],
    attempts: [],
    warning: { level: "high", backlogMinutes: 400, dailyCapacityMinutes: 180 },
    date: "2026-07-29",
  });
  assert.equal(overloaded.recommendation.state, "recover_workload_first");
  assert.equal(overloaded.authority.one_stored_roadmap, true);
  assert.equal(overloaded.authority.pass_guarantee, false);
});
