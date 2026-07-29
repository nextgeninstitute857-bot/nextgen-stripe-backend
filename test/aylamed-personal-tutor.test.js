import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AYLA_PERSONAL_TUTOR_ENGINE,
  buildAylaPersonalTutorDecision,
  formatAylaPersonalTutorAnswer,
  isAylaPersonalTutorPlanningIntent,
  validateAylaPersonalTutorPlanCommand,
} from "../lib/aylamed-personal-tutor.js";

const plan = {
  id: "plan-current",
  version: 4,
  date: "2026-07-20",
  status: "active",
  capacityMinutes: 180,
  plannedMinutes: 180,
  focusSystem: "Cardiovascular",
  focusTopic: "Shock",
  assessmentTutor: { status: "monitoring", type: "not_due", label: "Monitoring", reason: "Not due", questionCount: 0 },
};

function assignment(id, category, extra = {}) {
  return {
    id,
    dailyPlanId: plan.id,
    scheduledDate: plan.date,
    status: "pending",
    priority: "High",
    category,
    title: `${category} task`,
    system: "Cardiovascular",
    topic: "Shock",
    estimatedMinutes: 30,
    resourceIds: [`resource-${id}`],
    items: [{ resourceId: `resource-${id}` }],
    ...extra,
  };
}

function baseInput(extra = {}) {
  return {
    date: plan.date,
    student: { examTrackId: "usmle_step_1", targetDate: "2026-08-20", dailyHours: 3, weakAreas: ["Cardiovascular"] },
    plan,
    assignments: [assignment("read-1", "reading")],
    recentPlans: [],
    warning: { level: "on_track", backlogMinutes: 0 },
    questionAttempts: [],
    assessmentAttempts: [],
    flashcardReviews: [],
    conceptMastery: [],
    revisionItems: [],
    notebooks: [],
    surfaceProgress: {},
    ...extra,
  };
}

test("Personal Tutor chooses the next modality from the one stored roadmap", () => {
  const decision = buildAylaPersonalTutorDecision(baseInput({
    assignments: [
      assignment("read-1", "reading", { priority: "High" }),
      assignment("revision-1", "flashcards", { priority: "Critical", revisionQueueIds: ["revision-q-1"], title: "Due recall" }),
    ],
  }));
  assert.equal(decision.engine, AYLA_PERSONAL_TUTOR_ENGINE);
  assert.equal(decision.authority.oneStoredRoadmap, true);
  assert.equal(decision.authority.tutorCreatesSecondPlan, false);
  assert.equal(decision.generatedFromPlan.id, plan.id);
  assert.equal(decision.nextAction.assignmentId, "revision-1");
  assert.equal(decision.nextAction.modality, "revise");
  assert.equal(decision.nextAction.returnLink, "/roadmap/assignments/revision-1");
  assert.deepEqual(decision.nextAction.actionTarget, {
    kind: "roadmap_assignment",
    route: "/dashboard/roadmap",
    query: { assignment: "revision-1" },
    appRoute: "/dashboard/roadmap?assignment=revision-1",
    assignmentId: "revision-1",
  });
  const navigation = decision.recommendations.find((row) => row.kind === "continue_next_assignment");
  assert.equal(navigation.appRoute, "/dashboard/roadmap?assignment=revision-1");
  assert.equal(navigation.actionTarget.assignmentId, "revision-1");
});

test("overload reduces question volume and produces only a version-checked single-roadmap directive", () => {
  const decision = buildAylaPersonalTutorDecision(baseInput({
    warning: { level: "high", backlogMinutes: 400 },
    assignments: [assignment("questions-1", "internal_mcqs", {
      estimatedMinutes: 220,
      resourceIds: Array.from({ length: 20 }, (_, index) => `q-${index + 1}`),
      items: Array.from({ length: 20 }, (_, index) => ({ resourceId: `q-${index + 1}`, correctAnswer: "private" })),
    })],
    recentPlans: [
      { date: "2026-07-19", completionPercent: 30, status: "active" },
      { date: "2026-07-18", completionPercent: 35, status: "active" },
      { date: "2026-07-17", completionPercent: 40, status: "active" },
    ],
  }));
  assert.equal(decision.workload.state, "overloaded");
  assert.equal(decision.workload.questionVolumeAdjustment, "reduce");
  assert.ok(decision.workload.recommendedQuestionCount < 20);
  const change = decision.recommendations.find((row) => row.kind === "reduce_workload");
  assert.equal(change.planChange, true);
  assert.equal(change.action, "rebuild_single_roadmap");
  assert.deepEqual(change.directive, { workloadAdjustment: "reduce", questionVolumeAdjustment: "reduce", includeAssessment: false });
  assert.doesNotMatch(JSON.stringify(decision), /correctAnswer|private/);
});

test("strong completion can increase questions without replacing the roadmap", () => {
  const decision = buildAylaPersonalTutorDecision(baseInput({
    plan: { ...plan, plannedMinutes: 90 },
    recentPlans: [
      { date: "2026-07-19", completionPercent: 100, status: "completed" },
      { date: "2026-07-18", completionPercent: 90, status: "completed" },
      { date: "2026-07-17", completionPercent: 95, status: "completed" },
    ],
    questionAttempts: Array.from({ length: 8 }, (_, index) => ({ serverVerified: true, outcome: index < 7 ? "correct" : "incorrect", system: "Cardiovascular", topic: "Shock" })),
    assessmentAttempts: [{ serverVerified: true, scorePercent: 82 }],
  }));
  assert.equal(decision.workload.state, "ready_for_more");
  assert.equal(decision.workload.questionVolumeAdjustment, "intensive");
  assert.equal(decision.recommendations.some((row) => row.kind === "increase_question_volume" && row.planChange), true);
  assert.equal(decision.authority.tutorCreatesSecondPlan, false);
});

test("Personal Tutor suggests an exam-scoped full self-assessment without creating a second roadmap", () => {
  const decision = buildAylaPersonalTutorDecision(baseInput({
    student: {
      examTrackId: "usmle_step_2_ck",
      targetDate: "2026-08-20",
      dailyHours: 3,
      weakAreas: ["Internal Medicine"],
    },
    nbmeForms: [{
      id: "nbme-step-2-ck-form-15",
      formType: "comprehensive_self_assessment",
      examTrack: "usmle-step-2",
      studentEnabled: true,
    }, {
      id: "nbme-step-1-form-31",
      formType: "comprehensive_self_assessment",
      examTrack: "usmle-step-1",
      studentEnabled: true,
    }],
    nbmeAttempts: [],
  }));
  assert.equal(decision.nbmeReadiness.exam_track, "usmle-step-2");
  assert.equal(decision.nbmeReadiness.available_full_forms, 1);
  assert.equal(decision.nbmeReadiness.recommendation.form_id, "nbme-step-2-ck-form-15");
  const recommendation = decision.recommendations.find((row) => row.kind === "self_assessment_readiness");
  assert.equal(recommendation.planChange, false);
  assert.equal(recommendation.actionTarget.appRoute, "/dashboard/nbme");
  assert.equal(decision.authority.tutorCreatesSecondPlan, false);
});

test("Personal Tutor resumes the exact active self-assessment route", () => {
  const decision = buildAylaPersonalTutorDecision(baseInput({
    student: {
      examTrackId: "usmle_step_2_ck",
      targetDate: "2026-08-20",
      dailyHours: 3,
    },
    nbmeForms: [{
      id: "nbme-step-2-ck-form-15",
      formType: "comprehensive_self_assessment",
      examTrack: "usmle-step-2",
      studentEnabled: true,
    }],
    nbmeAttempts: [{
      id: "attempt-active-15",
      formId: "nbme-step-2-ck-form-15",
      formType: "comprehensive_self_assessment",
      title: "Step 2 CK Self-Assessment Form 15",
      status: "in_progress",
      examTrack: "usmle-step-2",
      updatedAt: "2026-07-29T09:00:00.000Z",
    }],
  }));
  const recommendation = decision.recommendations.find((row) => row.kind === "self_assessment_readiness");
  assert.equal(decision.nbmeReadiness.recommendation.state, "resume_in_progress");
  assert.equal(recommendation.actionTarget.appRoute, "/dashboard/nbme/attempt/attempt-active-15");
});

test("cross-system weakness is reported only from repeated verified evidence", () => {
  const decision = buildAylaPersonalTutorDecision(baseInput({
    questionAttempts: [
      { serverVerified: true, outcome: "incorrect", system: "Cardiovascular", topic: "Perfusion" },
      { serverVerified: true, outcome: "incorrect", system: "Renal", topic: "Perfusion" },
      { serverVerified: false, outcome: "incorrect", system: "Respiratory", topic: "Fabricated topic" },
    ],
    flashcardReviews: [{ serverVerified: true, rating: "hard", system: "Respiratory", topic: "Perfusion" }],
  }));
  assert.equal(decision.crossSystemWeakTopic.topic, "Perfusion");
  assert.deepEqual(decision.crossSystemWeakTopic.systems, ["Cardiovascular", "Renal", "Respiratory"]);
  assert.doesNotMatch(JSON.stringify(decision), /Fabricated topic/);
});

test("external self-reported outcomes cannot change Personal Tutor workload or weak areas", () => {
  const decision = buildAylaPersonalTutorDecision(baseInput({
    questionAttempts: Array.from({ length: 12 }, (_, index) => ({
      serverVerified: false,
      sourceType: "external",
      outcome: "incorrect",
      system: index % 2 ? "Renal" : "Cardiovascular",
      topic: "CLIENT-CLAIMED-WEAKNESS",
    })),
  }));
  assert.equal(decision.progressEvidence.verifiedQuestionAttempts, 0);
  assert.equal(decision.progressEvidence.verifiedQuestionAccuracyPercent, null);
  assert.equal(decision.crossSystemWeakTopic, null);
  assert.doesNotMatch(JSON.stringify(decision), /CLIENT-CLAIMED-WEAKNESS/);
});

test("a newer correct answer or successful card review resolves older weak evidence for that resource", () => {
  const decision = buildAylaPersonalTutorDecision(baseInput({
    questionAttempts: [
      { resourceId: "question-1", serverVerified: true, outcome: "correct", system: "Cardiovascular", topic: "Resolved topic" },
      { resourceId: "question-1", serverVerified: true, outcome: "incorrect", system: "Cardiovascular", topic: "Resolved topic" },
    ],
    flashcardReviews: [
      { resourceId: "card-1", serverVerified: true, rating: "good", system: "Renal", topic: "Resolved topic" },
      { resourceId: "card-1", serverVerified: true, rating: "hard", system: "Renal", topic: "Resolved topic" },
    ],
  }));
  assert.equal(decision.progressEvidence.verifiedQuestionAttempts, 1);
  assert.equal(decision.progressEvidence.verifiedQuestionAccuracyPercent, 100);
  assert.equal(decision.crossSystemWeakTopic, null);
});

test("notebook recommendation uses only student-authored text, never imported source blocks", () => {
  const decision = buildAylaPersonalTutorDecision(baseInput({
    notebooks: [{
      id: "notebook-1",
      title: "Shock review",
      system: "Cardiovascular",
      topic: "Shock",
      updatedAt: "2026-07-20T10:00:00.000Z",
      blocks: [
        { type: "book_source", contentOrigin: "approved_source", text: "PRIVATE PUBLISHER SOURCE ANSWER", updatedAt: "2026-07-20T11:00:00.000Z" },
        { type: "text", contentOrigin: "student_authored", text: "My own perfusion mnemonic", updatedAt: "2026-07-20T09:00:00.000Z" },
      ],
    }],
    surfaceProgress: { notebooks: 1 },
  }));
  assert.equal(decision.notebook.notebookId, "notebook-1");
  assert.equal(decision.notebook.studentNotePreview, "My own perfusion mnemonic");
  assert.equal(decision.notebook.actionTarget.appRoute, "/dashboard/notebook/notebook-1");
  assert.doesNotMatch(JSON.stringify(decision), /PRIVATE PUBLISHER SOURCE ANSWER/);
});

test("plan commands reject stale versions, arbitrary recommendations, and navigation-only actions", () => {
  const overloaded = buildAylaPersonalTutorDecision(baseInput({ warning: { level: "high", backlogMinutes: 400 } }));
  const change = overloaded.recommendations.find((row) => row.planChange);
  assert.throws(() => validateAylaPersonalTutorPlanCommand({
    expectedPlanId: plan.id,
    expectedPlanVersion: 3,
    recommendationId: change.id,
  }, overloaded), (error) => error.code === "STALE_TUTOR_RECOMMENDATION");
  assert.throws(() => validateAylaPersonalTutorPlanCommand({
    expectedPlanId: plan.id,
    expectedPlanVersion: 4,
    recommendationId: "client-invented",
  }, overloaded), (error) => error.code === "TUTOR_RECOMMENDATION_NOT_FOUND");
  const navigation = overloaded.recommendations.find((row) => !row.planChange);
  assert.throws(() => validateAylaPersonalTutorPlanCommand({
    expectedPlanId: plan.id,
    expectedPlanVersion: 4,
    recommendationId: navigation.id,
  }, overloaded), (error) => error.code === "TUTOR_RECOMMENDATION_IS_NAVIGATION_ONLY");
  const accepted = validateAylaPersonalTutorPlanCommand({
    expectedPlanId: plan.id,
    expectedPlanVersion: 4,
    recommendationId: change.id,
    directive: { workloadAdjustment: "intensive", includeAssessment: true },
  }, overloaded);
  assert.equal(accepted.directive.workloadAdjustment, "reduce");
  assert.equal(accepted.directive.includeAssessment, false);
});

test("completed roadmap days never receive a mutable tutor recommendation", () => {
  const decision = buildAylaPersonalTutorDecision(baseInput({
    plan: { ...plan, status: "completed" },
    warning: { level: "high", backlogMinutes: 400 },
  }));
  assert.deepEqual(decision.planChangeRecommendationIds, []);
  assert.equal(decision.recommendations.every((row) => row.planChange === false), true);
  assert.throws(() => validateAylaPersonalTutorPlanCommand({
    expectedPlanId: plan.id,
    expectedPlanVersion: plan.version,
    recommendationId: "anything",
  }, decision), (error) => error.code === "TUTOR_PLAN_NOT_ACTIVE");
});

test("planning questions stay deterministic while general knowledge questions remain separate", () => {
  assert.equal(isAylaPersonalTutorPlanningIntent("What should I study next today?"), true);
  assert.equal(isAylaPersonalTutorPlanningIntent("I am overloaded; reduce my questions"), true);
  assert.equal(isAylaPersonalTutorPlanningIntent("Explain the physiology of an S3 heart sound"), false);
  const answer = formatAylaPersonalTutorAnswer(buildAylaPersonalTutorDecision(baseInput()));
  assert.match(answer, /Next, read:/);
  assert.match(answer, /stored roadmap unchanged/);
});

test("server wires v213 Personal Tutor into the existing adaptive plan without LMS or CRM writes", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /const NEXTGEN_BACKEND_BUILD = "v219-safe-shared-student-profile"/);
  assert.match(server, /const AYLA_BACKEND_BUILD = "aylamed-safe-shared-student-profile-v219"/);
  assert.match(server, /schema_version: 14/);
  assert.match(server, /async function aylaV213PersonalTutorSnapshot/);
  assert.match(server, /app\.get\("\/api\/ayla\/students\/:studentId\/personal-tutor"/);
  assert.match(server, /app\.post\("\/api\/ayla\/students\/:studentId\/personal-tutor\/apply"/);
  assert.match(server, /validateAylaPersonalTutorPlanCommand/);
  assert.match(server, /aylaV189BuildDailyPlan\(db, student, date, \{[\s\S]*?tutorDirective: validated\.directive/);
  assert.match(server, /personal_tutor_applied_single_roadmap/);
  assert.match(server, /isAylaPersonalTutorPlanningIntent\(question\)/);
  const section = server.slice(server.indexOf("async function aylaV213PersonalTutorSnapshot"), server.indexOf("function aylaV189RecordActivity"));
  assert.doesNotMatch(section, /writeLiveDb\s*\(/);
  assert.doesNotMatch(section, /writeCrmDb\s*\(/);
});
