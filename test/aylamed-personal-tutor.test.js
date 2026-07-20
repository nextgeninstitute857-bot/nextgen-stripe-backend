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

test("cross-system weakness is reported only from repeated verified evidence", () => {
  const decision = buildAylaPersonalTutorDecision(baseInput({
    questionAttempts: [
      { serverVerified: true, outcome: "incorrect", system: "Cardiovascular", topic: "Perfusion" },
      { serverVerified: true, outcome: "incorrect", system: "Renal", topic: "Perfusion" },
      { serverVerified: false, outcome: "incorrect", system: "Respiratory", topic: "Fabricated topic" },
    ],
    flashcardReviews: [{ rating: "hard", system: "Respiratory", topic: "Perfusion" }],
  }));
  assert.equal(decision.crossSystemWeakTopic.topic, "Perfusion");
  assert.deepEqual(decision.crossSystemWeakTopic.systems, ["Cardiovascular", "Renal", "Respiratory"]);
  assert.doesNotMatch(JSON.stringify(decision), /Fabricated topic/);
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
  assert.match(server, /schema_version: 13/);
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
