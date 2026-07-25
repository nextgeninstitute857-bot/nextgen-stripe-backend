import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  aylaAdaptiveEvidenceMatchesStudent,
  aylaAdaptiveSystemsForStudent,
  buildAylaMistakeFlashcard,
  mergeAylaMistakeFlashcard,
} from "../lib/aylamed-adaptive-core.js";

const student = { id: "student-1", examTrackId: "usmle_step_2_ck" };

test("adaptive evidence is student-owned, exam-isolated, and optionally server-verified", () => {
  assert.equal(aylaAdaptiveEvidenceMatchesStudent({ studentId: "student-1" }, student), true);
  assert.equal(aylaAdaptiveEvidenceMatchesStudent({ studentId: "student-1", examTrack: "USMLE Step 2 CK" }, student), true);
  assert.equal(aylaAdaptiveEvidenceMatchesStudent({ studentId: "student-1", examTrack: "usmle-step-1" }, student), false);
  assert.equal(aylaAdaptiveEvidenceMatchesStudent({ studentId: "student-1", examTrackId: "usmle_step_2_ck", exam: "USMLE Step 1" }, student), false);
  assert.equal(aylaAdaptiveEvidenceMatchesStudent({ studentId: "student-1", examTrack: "made-up-exam" }, student), false);
  assert.equal(aylaAdaptiveEvidenceMatchesStudent({ studentId: "student-2", examTrack: "usmle-step-2" }, student), false);
  assert.equal(aylaAdaptiveEvidenceMatchesStudent({ studentId: "student-1", serverVerified: false }, student, { verifiedOnly: true }), false);
  assert.equal(aylaAdaptiveEvidenceMatchesStudent({ studentId: "student-1", serverVerified: true }, student, { verifiedOnly: true }), true);
});

test("adaptive systems come from the student's exam registry instead of a Step 1 constant", () => {
  const registry = {
    usmle_step_1: { systems: ["Cardiovascular"] },
    usmle_step_2_ck: { systems: ["Internal Medicine", "Surgery", "Pediatrics"] },
  };
  assert.deepEqual(aylaAdaptiveSystemsForStudent(student, registry, ["Legacy"]), ["Internal Medicine", "Surgery", "Pediatrics"]);
  assert.deepEqual(aylaAdaptiveSystemsForStudent({ id: "student-1", examTrackId: "unknown" }, registry, ["Legacy"]), ["Legacy"]);
});

test("server-verified mistakes become deterministic private weak-area cards", () => {
  const question = {
    id: "question-1",
    question_html: "<p>What is the diagnosis?</p>",
    explanation_html: "<p>The murmur is diagnostic.</p>",
    correct_answer_id: 2,
    answers: [
      { answer_id: 1, text_html: "Choice A" },
      { answer_id: 2, text_html: "<strong>Choice B</strong>" },
    ],
    taxonomy: { system_key: "Cardiovascular", topic_key: "Murmurs" },
  };
  const first = buildAylaMistakeFlashcard({
    student,
    examTrack: "usmle-step-2",
    sourceType: "qbank_mistake",
    sourceIdentity: question.id,
    sourceSessionId: "session-1",
    sourceQuestionRef: "ref-1",
    sourceAttemptId: "attempt-1",
    question,
    now: "2026-07-23T10:00:00.000Z",
  });
  const second = buildAylaMistakeFlashcard({
    student,
    examTrack: "USMLE Step 2 CK",
    sourceType: "qbank_mistake",
    sourceIdentity: question.id,
    sourceSessionId: "session-2",
    sourceQuestionRef: "ref-2",
    sourceAttemptId: "attempt-2",
    question,
    now: "2026-07-24T10:00:00.000Z",
  });

  assert.equal(first.id, second.id);
  assert.equal(first.ownerStudentId, student.id);
  assert.equal(first.examTrackId, "usmle_step_2_ck");
  assert.equal(first.bucket, "weak_area");
  assert.equal(first.back, "<strong>Choice B</strong>");
  assert.equal(first.authorizationStatus, "owned");
  assert.equal(first.sourceAccessMode, "protected");
  assert.equal(first.sourceLabelVisible, false);
  assert.deepEqual(first.deliveryDestinations, ["aylamed_private_student"]);

  const merged = mergeAylaMistakeFlashcard(first, second);
  assert.equal(merged.mistakeCount, 2);
  assert.deepEqual(merged.sourceAttemptIds, ["attempt-1", "attempt-2"]);
  assert.deepEqual(merged.sourceSessionIds, ["session-1", "session-2"]);
  assert.equal(merged.createdAt, first.createdAt);
  assert.equal(merged.updatedAt, second.updatedAt);
});

test("a mistake card is not created without a verified answer-bearing prompt", () => {
  assert.equal(buildAylaMistakeFlashcard({
    student,
    sourceType: "assessment_mistake",
    sourceIdentity: "missing-answer",
    question: { stem: "Prompt without an answer" },
  }), null);
});

test("server wires the verified adaptive loop without replacing ingestion or completed roadmap history", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /const CONTENT_INGESTION_BUILD = "v232\.2-resumable-media-finalization"/);
  assert.match(server, /const AYLA_ADAPTIVE_CORE_BUILD = "v227-verified-adaptive-loop"/);
  assert.match(server, /function aylaV227SystemsForStudent[\s\S]*?aylaAdaptiveSystemsForStudent\(student, AYLA_EXAM_REGISTRY/);
  assert.match(server, /function aylaRecordQbankAttempt[\s\S]*?aylaV227UpsertMistakeFlashcard/);
  assert.match(server, /function aylaRecordQbankAttempt[\s\S]*?serverVerified: true/);
  assert.match(server, /qbank_future_roadmap_refresh_deferred/);
  assert.match(server, /aylaV189BuildDailyPlan\(db, fresh\.student, tomorrow, \{[\s\S]*?force: true[\s\S]*?skipAi: true/);
  assert.match(server, /if \(existing && String\(existing\.status \|\| ""\)\.toLowerCase\(\) === "completed"\)[\s\S]*?completedHistoryProtected: true/);
  assert.match(server, /function aylaV189UpdatePlanCompletion[\s\S]*?\["completed", "cancelled", "superseded"\]\.includes/);
  assert.match(server, /weakAreaLogs: aylaValues\(db, "aylaWeakAreaLogs"\)[\s\S]*?aylaAdaptiveEvidenceMatchesStudent/);
});
