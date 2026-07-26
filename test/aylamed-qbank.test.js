import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  canRevealAylaQbankAnswer,
  canSubmitAylaQbankRoadmapSession,
  createAylaQbankSession,
  finalizeAylaQbankSession,
  mergeConcurrentAylaQbankCollection,
  normalizeAylaQbankExamTrack,
  normalizeAylaQbankMode,
  normalizeAylaQbankPurpose,
  qbankRoadmapAssignmentQuestionIds,
  qbankRoadmapSessionMatchesAssignment,
  recordAylaQbankAnswer,
  resolveAylaQbankEntitlement,
  sanitizeAylaQbankQuestion,
  sanitizeAylaQbankSession,
} from "../lib/aylamed-qbank.js";
import {
  contentQbankQuestionDisplay,
  normalizeContentQbankPresentationPolicy,
  normalizeContentSourceProfile,
  resolveContentQbankStudentSourceProfile,
} from "../lib/content-registry-postgres.js";

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
  media: [
    { id: "stem-image", placement: "question", kind: "image", content_type: "image/png", url: "signed-stem" },
    { id: "heart-sound", placement: "question", kind: "audio", content_type: "audio/mpeg", url: "signed-audio" },
    { id: "explanation-image", placement: "explanation", kind: "image", content_type: "image/png", url: "signed-explanation" },
  ],
  videos: [{ id: "explanation-video", placement: "explanation", embed_url: "https://player.vimeo.com/video/1" }],
};

test("AylaMed and Content Registry exam aliases resolve to one canonical boundary", () => {
  assert.equal(normalizeAylaQbankExamTrack("usmle_step_1"), "usmle-step-1");
  assert.equal(normalizeAylaQbankExamTrack("USMLE Step 2 CK"), "usmle-step-2");
  assert.equal(normalizeAylaQbankExamTrack("usmle_step_3"), "usmle-step-3");
  assert.equal(normalizeAylaQbankMode("assessment mode"), "test");
  assert.equal(normalizeAylaQbankPurpose("take diagnostic"), "baseline_diagnostic");
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

test("administrator QBank presentation controls keep source choice separate from question identity", () => {
  assert.equal(normalizeContentSourceProfile("", "UWorld licensed bank"), "uworld_style");
  assert.equal(normalizeContentSourceProfile("AMBOSS style"), "amboss_style");
  assert.equal(normalizeContentSourceProfile("", "CanadaQBank"), "canadaqbank_style");
  assert.equal(normalizeContentSourceProfile("", "ACE QBank"), "aceqbank_style");
  assert.equal(normalizeContentSourceProfile("", "Amedex"), "amedex_style");
  assert.equal(normalizeContentSourceProfile("", "MPlusX"), "mplusx_style");
  const unified = normalizeContentQbankPresentationPolicy({
    student_bank_mode: "unified",
  }, "USMLE Step 1");
  assert.equal(unified.student_bank_mode, "unified_aylamed");
  assert.equal(unified.student_can_choose_source_profile, false);
  assert.equal(unified.roadmap_source_strategy, "all_approved_profiles");
  assert.throws(
    () => resolveContentQbankStudentSourceProfile(unified, "uworld_style"),
    (error) => error.code === "QBANK_SOURCE_SWITCH_DISABLED" && error.statusCode === 403,
  );

  const switchable = {
    ...normalizeContentQbankPresentationPolicy({
      student_bank_mode: "student_choice",
    }, "USMLE Step 1"),
    available_source_profiles: [
      { source_profile: "uworld_style", question_count: 100 },
      { source_profile: "amboss_style", question_count: 80 },
    ],
  };
  assert.equal(resolveContentQbankStudentSourceProfile(switchable, "UWorld"), "uworld_style");
  assert.equal(resolveContentQbankStudentSourceProfile(switchable, "AMBOSS"), "amboss_style");
  assert.equal(resolveContentQbankStudentSourceProfile(switchable, ""), "");
  assert.throws(
    () => resolveContentQbankStudentSourceProfile(switchable, "AylaMed Original"),
    (error) => error.code === "QBANK_SOURCE_PROFILE_UNAVAILABLE" && error.statusCode === 400,
  );
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

test("self-study sessions preserve the selected source profile while roadmap sessions may remain combined", () => {
  const session = createAylaQbankSession({
    id: "source-session",
    userId: "user-1",
    studentId: "student-1",
    examTrack: "usmle-step-1",
    sourceProfile: "amboss_style",
    questions: [{ ref: "one", contentQuestionId: "q1" }],
  });
  assert.equal(session.sourceProfile, "amboss_style");
  assert.equal(sanitizeAylaQbankSession(session).source_profile, "amboss_style");
  assert.equal(sessionFixture("tutor").sourceProfile, null);
});

test("roadmap QBank sessions use only the assignment's explicit question identities", () => {
  const question1 = "11111111-1111-4111-8111-111111111111";
  const question2 = "22222222-2222-4222-8222-222222222222";
  const question3 = "33333333-3333-4333-8333-333333333333";
  const unrelatedAlias = "44444444-4444-4444-8444-444444444444";
  const ids = qbankRoadmapAssignmentQuestionIds({
    resourceIds: [question2, unrelatedAlias, "legacy-question-id"],
    items: [
      { contentQuestionId: question1, resourceId: "legacy-one" },
      { content_question_id: question2 },
      { resourceId: question3 },
    ],
  });
  assert.deepEqual(ids, [question1, question2, question3]);
  assert.deepEqual(qbankRoadmapAssignmentQuestionIds({
    resourceIds: [question1, question2, question1, "legacy-question-id"],
  }), [question1, question2]);
  assert.equal(qbankRoadmapSessionMatchesAssignment({
    questions: [
      { ref: "one", contentQuestionId: question1 },
      { ref: "two", contentQuestionId: question2 },
      { ref: "three", contentQuestionId: question3 },
    ],
  }, {
    resourceIds: [question1, question2, question3],
  }), true);
  assert.equal(qbankRoadmapSessionMatchesAssignment({
    questions: [{ ref: "one", contentQuestionId: question2 }],
  }, {
    resourceIds: [question1],
  }), false);
});

test("a roadmap QBank block cannot complete while assigned questions remain unanswered", () => {
  const session = createAylaQbankSession({
    id: "roadmap-session",
    userId: "user-1",
    studentId: "student-1",
    examTrack: "usmle_step_1",
    mode: "tutor",
    origin: "roadmap",
    roadmapAssignmentId: "assignment-1",
    questions: [
      { ref: "one", contentQuestionId: "q1" },
      { ref: "two", contentQuestionId: "q2" },
    ],
  });
  assert.equal(canSubmitAylaQbankRoadmapSession(session), false);
  const oneAnswered = recordAylaQbankAnswer(session, {
    questionRef: "one",
    selectedAnswerId: 1,
    correctAnswerId: 1,
  }).session;
  oneAnswered.answers.unrelated = { selectedAnswerId: 1 };
  assert.equal(canSubmitAylaQbankRoadmapSession(oneAnswered), false);
  const complete = recordAylaQbankAnswer(oneAnswered, {
    questionRef: "two",
    selectedAnswerId: 1,
    correctAnswerId: 2,
  }).session;
  assert.equal(canSubmitAylaQbankRoadmapSession(complete), true);
  assert.equal(canSubmitAylaQbankRoadmapSession(sessionFixture("test", 2)), true);
});

test("server keeps exact roadmap QBank identity through create, resume, and completion", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /const AYLA_SINGLE_ROADMAP_BUILD = "v230-single-roadmap-execution"/);
  const createRoute = server.slice(
    server.indexOf('app.post("/api/ayla/qbank/sessions"'),
    server.indexOf('app.get("/api/ayla/qbank/sessions/:sessionId"'),
  );
  const submitRoute = server.slice(
    server.indexOf('app.post("/api/ayla/qbank/sessions/:sessionId/submit"'),
    server.indexOf('app.get("/api/ayla/qbank/history"'),
  );
  assert.match(createRoute, /qbankRoadmapAssignmentQuestionIds\(assignment\)/);
  assert.match(createRoute, /qbankRoadmapSessionMatchesAssignment\(activeRoadmapSession, assignment\)/);
  assert.match(createRoute, /getContentQbankQuestions\(\{\s*questionIds: roadmapQuestionIds/s);
  assert.match(createRoute, /private_drafts_exposed: false/);
  assert.match(submitRoute, /canSubmitAylaQbankRoadmapSession\(current\)/);
  assert.match(submitRoute, /assignmentIsActive/);
  assert.match(submitRoute, /qbankRoadmapSessionMatchesAssignment\(finalized\.session, assignment\)/);
});

test("baseline diagnostics are explicitly tagged and can only use sealed test mode", () => {
  const session = createAylaQbankSession({
    id: "diagnostic-session",
    userId: "user-1",
    studentId: "student-1",
    examTrack: "USMLE Step 1",
    mode: "test",
    purpose: "baseline_diagnostic",
    questions: [{ ref: "one", contentQuestionId: "q1" }],
  });
  const safe = sanitizeAylaQbankSession(session);
  assert.equal(session.purpose, "baseline_diagnostic");
  assert.equal(safe.purpose, "baseline_diagnostic");
  assert.throws(
    () => createAylaQbankSession({
      id: "unsafe-diagnostic",
      userId: "user-1",
      studentId: "student-1",
      examTrack: "USMLE Step 1",
      mode: "tutor",
      purpose: "baseline_diagnostic",
      questions: [{ ref: "one", contentQuestionId: "q1" }],
    }),
    (error) => error.code === "DIAGNOSTIC_REQUIRES_TEST_MODE",
  );
});

test("tutor mode hides answer material until the immutable answer is recorded", () => {
  const session = sessionFixture("tutor");
  const before = sanitizeAylaQbankQuestion(registryQuestion, { session, questionRef: "ref-1" });
  assert.equal(before.correct_answer_id, null);
  assert.equal(before.explanation_html, null);
  assert.deepEqual(before.media.map((row) => row.id), ["stem-image", "heart-sound"]);
  assert.equal(before.media.find((row) => row.id === "heart-sound").kind, "audio");
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

test("answer-choice images stay attached to their own answer before and after reveal", () => {
  const session = sessionFixture("tutor");
  const question = {
    ...registryQuestion,
    media: [
      ...registryQuestion.media,
      { id: "choice-a-image", placement: "answer:1", kind: "image", content_type: "image/png", url: "signed-choice-a" },
    ],
  };
  const before = sanitizeAylaQbankQuestion(question, {
    session,
    questionRef: "ref-1",
  });
  assert.deepEqual(before.answers[0].media.map((item) => item.id), ["choice-a-image"]);
  assert.deepEqual(before.answers[1].media, []);
  assert.equal(before.media.some((item) => item.id === "choice-a-image"), false);

  const answered = recordAylaQbankAnswer(session, {
    questionRef: "ref-1",
    selectedAnswerId: 2,
    correctAnswerId: 2,
  });
  const after = sanitizeAylaQbankQuestion(question, {
    session: answered.session,
    questionRef: "ref-1",
  });
  assert.deepEqual(after.answers[0].media.map((item) => item.id), ["choice-a-image"]);
  assert.equal(after.media.some((item) => item.id === "choice-a-image"), false);
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
