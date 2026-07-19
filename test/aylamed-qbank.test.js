import test from "node:test";
import assert from "node:assert/strict";
import {
  canRevealAylaQbankAnswer,
  createAylaQbankSession,
  finalizeAylaQbankSession,
  mergeConcurrentAylaQbankCollection,
  normalizeAylaQbankExamTrack,
  normalizeAylaQbankMode,
  recordAylaQbankAnswer,
  resolveAylaQbankEntitlement,
  sanitizeAylaQbankQuestion,
  sanitizeAylaQbankSession,
} from "../lib/aylamed-qbank.js";
import { contentQbankQuestionDisplay } from "../lib/content-registry-postgres.js";

const future = "2099-01-01T00:00:00.000Z";

function entitlementFixture({ enrollments, studentExam = "usmle_step_1", requestedExam = "usmle-step-1", plans = {} } = {}) {
  return resolveAylaQbankEntitlement({
    enrollments,
    plansById: plans,
    userId: "user-1",
    student: { id: "student-1", examTrackId: studentExam },
    requestedExamTrack: requestedExam,
    now: new Date("2026-07-19T12:00:00.000Z"),
  });
}

function sessionFixture(mode = "tutor", count = 1) {
  return createAylaQbankSession({
    id: "session-1",
    userId: "user-1",
    studentId: "student-1",
    examTrack: "usmle_step_1",
    mode,
    questions: Array.from({ length: count }, (_, index) => ({ ref: `ref-${index + 1}`, contentQuestionId: `question-${index + 1}` })),
    blockSize: 2,
    now: new Date("2026-07-19T12:00:00.000Z"),
  });
}

const registryQuestion = {
  id: "question-1",
  title: "Clinical vignette",
  question_html: "What is the diagnosis?",
  explanation_html: "The finding establishes the diagnosis.",
  correct_answer_id: 2,
  answers: [
    { answer_id: 1, text_html: "Choice A" },
    { answer_id: 2, text_html: "Choice B" },
  ],
  taxonomy: { system_key: "cardiovascular", topic_key: "murmurs" },
  media: [{ id: "stem-image", placement: "question", url: "signed-stem" }, { id: "explanation-image", placement: "explanation", url: "signed-explanation" }],
  videos: [{ id: "explanation-video", placement: "explanation", embed_url: "https://player.vimeo.com/video/1" }],
};

test("AylaMed and Content Registry exam aliases resolve to one canonical boundary", () => {
  assert.equal(normalizeAylaQbankExamTrack("usmle_step_1"), "usmle-step-1");
  assert.equal(normalizeAylaQbankExamTrack("USMLE Step 2 CK"), "usmle-step-2");
  assert.equal(normalizeAylaQbankExamTrack("usmle_step_3"), "usmle-step-3");
  assert.equal(normalizeAylaQbankMode("assessment mode"), "test");
});

test("unscoped legacy enrollment is restricted to the owned student profile exam", () => {
  const enrollments = [{ id: "paid", user_id: "user-1", plan_id: "full", status: "active", access_granted: true, access_expires_at: future }];
  const plans = { full: { id: "full", included_features: ["qbank"] } };
  assert.equal(entitlementFixture({ enrollments, plans }).allowed, true);
  const otherExam = entitlementFixture({ enrollments, plans, requestedExam: "nclex" });
  assert.equal(otherExam.allowed, false);
  assert.equal(otherExam.reason, "no_active_exam_entitlement");
});

test("explicit exam-scoped entitlement permits a second dashboard without weakening isolation", () => {
  const enrollments = [{ id: "nclex-paid", user_id: "user-1", plan_id: "full", exam_track: "nclex", status: "active", access_granted: true, access_expires_at: future }];
  const access = entitlementFixture({ enrollments, plans: { full: { id: "full", included_features: ["qbank"] } }, requestedExam: "nclex" });
  assert.equal(access.allowed, true);
  assert.equal(access.exam_track, "nclex");
  assert.equal(access.explicitly_scoped, true);
});

test("active paid plan is authoritative over a demo feature grant", () => {
  const enrollments = [
    { id: "demo", user_id: "user-1", plan_id: "demo-plan", is_demo: true, status: "active", access_granted: true, access_expires_at: future },
    { id: "paid", user_id: "user-1", plan_id: "paid-plan", status: "active", access_granted: true, access_expires_at: future },
  ];
  const access = entitlementFixture({
    enrollments,
    plans: {
      "demo-plan": { id: "demo-plan", is_demo: true, included_features: ["qbank"] },
      "paid-plan": { id: "paid-plan", included_features: ["roadmap"] },
    },
  });
  assert.equal(access.allowed, false);
  assert.equal(access.reason, "feature_not_included");
  assert.equal(access.entitlement_type, "paid");
});

test("collection display policy reveals only the administrator-approved question identity", () => {
  const raw = {
    id: "internal-uuid",
    student_qid: "NGQ-00000001",
    source_item_id: "PRIVATE-123",
    source_provider: "Private Provider",
    display_policy: { question_id_mode: "hidden", source_label_mode: "hidden" },
    question_html: "Stem",
  };
  const hidden = contentQbankQuestionDisplay(raw);
  assert.equal(hidden.display_question_id, null);
  assert.equal(hidden.question_identifiers, null);
  assert.equal(hidden.source_label, null);
  assert.equal("student_qid" in hidden, false);
  assert.equal("source_item_id" in hidden, false);
  assert.equal("source_provider" in hidden, false);

  const both = contentQbankQuestionDisplay({
    ...raw,
    display_policy: { question_id_mode: "both", source_label_mode: "neutral" },
  });
  assert.deepEqual(both.question_identifiers, { internal: "NGQ-00000001", source: "PRIVATE-123" });
  assert.equal(both.source_label, "Source QID");
});

test("session builder deduplicates questions and creates bounded blocks", () => {
  const session = createAylaQbankSession({
    id: "session-blocks", userId: "user-1", studentId: "student-1", examTrack: "step 1", mode: "tutor",
    questions: [
      { ref: "one", contentQuestionId: "q1" },
      { ref: "two", contentQuestionId: "q2" },
      { ref: "duplicate", contentQuestionId: "q2" },
      { ref: "three", contentQuestionId: "q3" },
    ],
    blockSize: 2,
  });
  assert.equal(session.questionCount, 3);
  assert.deepEqual(session.blocks.map((block) => block.questionRefs), [["one", "two"], ["three"]]);
  assert.deepEqual(sanitizeAylaQbankSession(session).questions, [{ question_ref: "one" }, { question_ref: "two" }, { question_ref: "three" }]);
});

test("tutor mode hides answer material until the immutable answer is recorded", () => {
  const session = sessionFixture("tutor");
  const before = sanitizeAylaQbankQuestion(registryQuestion, { session, questionRef: "ref-1" });
  assert.equal(before.correct_answer_id, null);
  assert.equal(before.explanation_html, null);
  assert.deepEqual(before.media.map((row) => row.id), ["stem-image"]);
  assert.deepEqual(before.videos, []);

  const recorded = recordAylaQbankAnswer(session, { questionRef: "ref-1", selectedAnswerId: 1, correctAnswerId: 2, now: new Date("2026-07-19T12:01:00.000Z") });
  const after = sanitizeAylaQbankQuestion(registryQuestion, { session: recorded.session, questionRef: "ref-1" });
  assert.deepEqual(after.result, { correct: false, answered_at: "2026-07-19T12:01:00.000Z" });
  assert.equal(after.correct_answer_id, 2);
  assert.equal(after.explanation_html, registryQuestion.explanation_html);
  assert.equal(after.videos.length, 1);

  assert.equal(recordAylaQbankAnswer(recorded.session, { questionRef: "ref-1", selectedAnswerId: 1, correctAnswerId: 2 }).replayed, true);
  assert.throws(
    () => recordAylaQbankAnswer(recorded.session, { questionRef: "ref-1", selectedAnswerId: 2, correctAnswerId: 2 }),
    (error) => error.code === "QBANK_ANSWER_LOCKED" && error.statusCode === 409,
  );
});

test("test mode withholds correctness, explanation, and automatic revision signal until submit", () => {
  const session = sessionFixture("test");
  const recorded = recordAylaQbankAnswer(session, { questionRef: "ref-1", selectedAnswerId: 1, correctAnswerId: 2 });
  assert.equal(canRevealAylaQbankAnswer(recorded.session, "ref-1"), false);
  const hidden = sanitizeAylaQbankQuestion(registryQuestion, {
    session: recorded.session,
    questionRef: "ref-1",
    revision: { status: "due", reasons: ["incorrect_answer"] },
  });
  assert.equal(hidden.result, null);
  assert.equal(hidden.correct_answer_id, null);
  assert.equal(hidden.explanation_html, null);
  assert.equal(hidden.in_revision, false);
  assert.equal(sanitizeAylaQbankSession(recorded.session).correct_count, null);

  const finalized = finalizeAylaQbankSession(recorded.session, new Date("2026-07-19T12:10:00.000Z"));
  const revealed = sanitizeAylaQbankQuestion(registryQuestion, { session: finalized.session, questionRef: "ref-1" });
  assert.equal(revealed.result.correct, false);
  assert.equal(revealed.correct_answer_id, 2);
  assert.equal(finalized.session.scorePercent, 0);
});

test("final scoring counts unanswered questions without fabricating answer attempts", () => {
  const session = sessionFixture("test", 3);
  const first = recordAylaQbankAnswer(session, { questionRef: "ref-1", selectedAnswerId: 2, correctAnswerId: 2 }).session;
  const finalized = finalizeAylaQbankSession(first).session;
  assert.equal(finalized.answeredCount, 1);
  assert.equal(finalized.correctCount, 1);
  assert.equal(finalized.incorrectCount, 2);
  assert.equal(finalized.unansweredCount, 2);
  assert.equal(finalized.scorePercent, 33.33);
  assert.equal(Object.keys(finalized.answers).length, 1);
  assert.equal(finalizeAylaQbankSession(finalized).replayed, true);
});

test("stale general AylaMed writes cannot roll back newer QBank state", () => {
  const latest = {
    session: { id: "session", answeredCount: 1, updatedAt: "2026-07-19T12:05:00.000Z" },
    latestOnly: { id: "latestOnly", updatedAt: "2026-07-19T12:04:00.000Z" },
  };
  const incoming = {
    session: { id: "session", answeredCount: 0, updatedAt: "2026-07-19T12:00:00.000Z" },
    incomingOnly: { id: "incomingOnly", updatedAt: "2026-07-19T12:06:00.000Z" },
  };
  const merged = mergeConcurrentAylaQbankCollection(latest, incoming);
  assert.equal(merged.session.answeredCount, 1);
  assert.equal(merged.latestOnly.id, "latestOnly");
  assert.equal(merged.incomingOnly.id, "incomingOnly");
});
