import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AYLA_ONBOARDING_PRESETS,
  aylaVerifiedDiagnosticPlanCanYield,
  buildAylaStartingReadinessReport,
  buildAylaVerifiedDiagnosticBaseline,
  normalizeAylaOnboardingSubmission,
  reconcileAylaRoadmapOutline,
} from "../lib/aylamed-onboarding.js";

test("a verified diagnostic releases current and future diagnostic-only roadmap placeholders", () => {
  const plan = { id: "plan-1", date: "2026-08-28", status: "active" };
  const assignments = [{ id: "diagnostic-1", category: "diagnostic", status: "pending" }];
  assert.equal(aylaVerifiedDiagnosticPlanCanYield({
    plan,
    assignments,
    student: { serverVerifiedBaseline: true },
    date: plan.date,
    today: "2026-08-21",
  }), true);
  assert.equal(aylaVerifiedDiagnosticPlanCanYield({
    plan,
    assignments,
    student: { serverVerifiedBaseline: false },
    date: plan.date,
    today: "2026-08-21",
  }), false);
  assert.equal(aylaVerifiedDiagnosticPlanCanYield({
    plan,
    assignments: [{ category: "internal_mcqs", status: "pending" }],
    student: { serverVerifiedBaseline: true },
    date: plan.date,
    today: "2026-08-21",
  }), false);
  assert.equal(aylaVerifiedDiagnosticPlanCanYield({
    plan: { ...plan, date: "2026-08-20" },
    assignments,
    student: { serverVerifiedBaseline: true },
    date: "2026-08-20",
    today: "2026-08-21",
  }), false);
});

const step1 = {
  id: "usmle_step_1",
  label: "USMLE Step 1",
  systems: ["Cardiovascular", "Renal", "Respiratory", "Gastrointestinal", "Neurology"],
};

const nclex = {
  id: "nclex",
  label: "NCLEX",
  systems: ["Management of Care", "Safety and Infection Control", "Physiological Adaptation"],
};

test("three onboarding paths normalize to one low-friction adaptive profile contract", () => {
  const diagnostic = normalizeAylaOnboardingSubmission({
    onboardingPath: "take diagnostic",
    selectedWeakAreas: ["Renal"],
    currentScore: 99,
  }, { examDefinition: step1 });
  assert.equal(diagnostic.onboardingPath, "diagnostic_test");
  assert.equal(diagnostic.onboardingStatus, "diagnostic_pending");
  assert.equal(diagnostic.studyStage, "diagnostic_pending");
  assert.equal(diagnostic.currentScore, 0);
  assert.deepEqual(diagnostic.selectedWeakAreas, []);
  assert.equal(diagnostic.serverVerifiedBaseline, false);

  const quick = normalizeAylaOnboardingSubmission({
    onboardingPath: "quick self assessment",
    studyStage: "first_pass_in_progress",
    qbankCompleted: 50,
    qbankAverage: 55,
    selectedWeakAreas: ["Cardiology", "Pulmonology", "Renal"],
  }, { examDefinition: step1 });
  assert.equal(quick.onboardingPath, "quick_profile");
  assert.equal(quick.baselineConfidence, "provisional");
  assert.equal(quick.serverVerifiedBaseline, false);
  assert.deepEqual(quick.selectedWeakAreas, ["Cardiovascular", "Respiratory", "Renal"]);
  assert.equal(quick.qbankCompleted, 50);
  assert.equal(quick.qbankAverage, 55);

  const fresh = normalizeAylaOnboardingSubmission({
    onboardingPath: "just starting",
    qbankCompleted: 100,
    qbankAverage: 75,
    selectedWeakAreas: ["Cardiovascular"],
  }, { examDefinition: step1 });
  assert.equal(fresh.onboardingPath, "starting_fresh");
  assert.equal(fresh.studyStage, "not_started");
  assert.equal(fresh.qbankCompleted, 0);
  assert.equal(fresh.qbankAverage, 0);
  assert.deepEqual(fresh.selectedWeakAreas, []);
  assert.equal(fresh.baselineSource, "new_student_self_report");
});

test("quick profile accepts only tappable presets and exam-owned systems", () => {
  assert.deepEqual(AYLA_ONBOARDING_PRESETS.qbankCompletion, [0, 25, 50, 75, 100]);
  assert.deepEqual(AYLA_ONBOARDING_PRESETS.qbankAverage, [0, 35, 45, 55, 65, 75]);

  assert.throws(
    () => normalizeAylaOnboardingSubmission({
      onboardingPath: "quick_profile",
      qbankCompleted: 37,
    }, { examDefinition: step1 }),
    (error) => error.code === "INVALID_ONBOARDING_PRESET" && error.statusCode === 400,
  );
  assert.throws(
    () => normalizeAylaOnboardingSubmission({
      onboardingPath: "quick_profile",
      qbankCompleted: 25,
      qbankAverage: 45,
      selectedWeakAreas: ["Cardiovascular"],
    }, { examDefinition: nclex }),
    (error) => error.code === "ONBOARDING_SYSTEM_EXAM_MISMATCH" && error.statusCode === 400,
  );
});

test("submitted diagnostic creates verified per-system baselines without inventing untested systems", () => {
  const session = {
    id: "diagnostic-1",
    purpose: "baseline_diagnostic",
    status: "submitted",
    questionCount: 4,
    answeredCount: 3,
    scorePercent: 50,
    submittedAt: "2026-07-24T12:00:00.000Z",
    questions: [
      { ref: "q1", contentQuestionId: "one" },
      { ref: "q2", contentQuestionId: "two" },
      { ref: "q3", contentQuestionId: "three" },
      { ref: "q4", contentQuestionId: "four" },
    ],
    answers: {
      q1: { correct: true },
      q2: { correct: false },
      q3: { correct: true },
    },
    diagnosticTaxonomyByQuestionId: {
      one: {
        system: "Cardiovascular",
        subsystem: "Cardiac conduction",
        topic: "AV block",
        subtopic: "First-degree AV block",
      },
      two: {
        system: "Cardiovascular",
        subsystem: "Cardiac conduction",
        topic: "AV block",
        subtopic: "Second-degree AV block",
      },
      three: {
        system: "Renal",
        subsystem: "Acid-base physiology",
        topic: "Metabolic acidosis",
        subtopic: "Anion gap",
      },
      four: {
        system: "Renal",
        subsystem: "Acid-base physiology",
        topic: "Metabolic acidosis",
        subtopic: "Respiratory compensation",
      },
    },
  };
  const questions = [
    { id: "one", taxonomy: { system_key: "cardiovascular" } },
    { id: "two", taxonomy: { system_key: "cardiology" } },
    { id: "three", taxonomy: { system_key: "renal" } },
    { id: "four", taxonomy: { system_key: "renal" } },
  ];
  const baseline = buildAylaVerifiedDiagnosticBaseline({ session, questions, examDefinition: step1 });
  assert.equal(baseline.currentScore, 50);
  assert.equal(baseline.serverVerifiedBaseline, true);
  assert.equal(baseline.onboardingStatus, "complete");
  assert.deepEqual(baseline.weakAreas, ["Cardiovascular", "Renal"]);
  assert.deepEqual(baseline.systemBaselines.Cardiovascular, {
    score: 50,
    correct: 1,
    answered: 2,
    total: 2,
    source: "verified_baseline_diagnostic",
    serverVerified: true,
    recordedAt: "2026-07-24T12:00:00.000Z",
  });
  assert.equal(baseline.systemBaselines.Renal.score, 50);
  assert.equal(baseline.diagnosticCoverage.mappedQuestionCount, 4);
  assert.equal(baseline.diagnosticCoverage.systemsCovered, 2);
  assert.equal(baseline.diagnosticCoverage.systemsExpected, 5);
  assert.equal(baseline.diagnosticCoverage.subsystemsSampled, 2);
  assert.equal(baseline.diagnosticCoverage.topicsSampled, 2);
  assert.equal(baseline.diagnosticCoverage.subtopicsSampled, 4);
  assert.equal(baseline.diagnosticCoverage.sampledTaxonomyOnly, true);
  assert.equal(baseline.diagnosticCoverage.allTopicsTested, false);
  assert.equal(baseline.diagnosticCoverage.untestedTaxonomyIsUnknown, true);
  assert.equal(
    baseline.topicBaselines["Cardiovascular > Cardiac conduction > AV block"].score,
    50,
  );
  assert.equal(
    baseline.topicBaselines["Renal > Acid-base physiology > Metabolic acidosis"].total,
    2,
  );
  assert.deepEqual(
    baseline.weakTopicSignals.map((row) => row.topic),
    ["AV block", "Metabolic acidosis"],
  );
  assert.equal(
    baseline.diagnosticTaxonomyEvidence.topicEvidence
      .every((row) => row.evidenceScope === "sampled_questions_only"),
    true,
  );
  assert.equal(baseline.diagnosticTaxonomyEvidence.untestedTaxonomyIsUnknown, true);
  assert.equal("Respiratory" in baseline.systemBaselines, false);
  assert.equal(
    Object.keys(baseline.topicBaselines)
      .some((key) => key.includes("Respiratory")),
    false,
  );
});

test("unsubmitted and ordinary practice sessions cannot manufacture a verified baseline", () => {
  assert.throws(
    () => buildAylaVerifiedDiagnosticBaseline({
      session: { purpose: "practice", status: "submitted" },
      examDefinition: step1,
    }),
    (error) => error.code === "DIAGNOSTIC_NOT_SUBMITTED",
  );
  assert.throws(
    () => buildAylaVerifiedDiagnosticBaseline({
      session: { purpose: "baseline_diagnostic", status: "in_progress" },
      examDefinition: step1,
    }),
    (error) => error.code === "DIAGNOSTIC_NOT_SUBMITTED",
  );
});

test("starting readiness report distinguishes verified, provisional, and discovery evidence", () => {
  const recommendation = {
    riskLevel: "Medium Risk",
    phase: "System Mastery",
    roadmapMode: "System-wise Strengthening Roadmap",
    reason: "Use the measured weak systems first.",
    dailyHours: 4,
    weeklyStudyDays: 6,
    dailyQuestionTarget: 30,
    dailyFlashcardTarget: 14,
    weeklyAssessment: "1 cumulative assessment",
  };
  const roadmapTasks = [
    {
      id: "task-1",
      scheduledDate: "2026-07-24",
      dayLabel: "Friday",
      title: "Revise Cardiovascular",
      category: "Concept Review",
      system: "Cardiovascular",
      durationMinutes: 60,
      status: "Pending",
    },
    {
      id: "old-task",
      scheduledDate: "2026-07-23",
      title: "Old provisional plan",
      category: "Concept Review",
      system: "Renal",
      durationMinutes: 60,
      status: "Pending",
    },
    {
      id: "completed-task",
      scheduledDate: "2026-07-24",
      title: "Already completed",
      category: "Concept Review",
      system: "Respiratory",
      durationMinutes: 45,
      status: "Completed",
    },
  ];
  const verified = buildAylaStartingReadinessReport({
    student: {
      id: "student-1",
      examTrackId: "usmle_step_1",
      exam: "USMLE Step 1",
      onboardingPath: "diagnostic_test",
      onboardingStatus: "complete",
      serverVerifiedBaseline: true,
      currentScore: 52,
      dailyHours: 4,
      weeklyStudyDays: 6,
      systemBaselines: {
        Cardiovascular: { score: 25, correct: 1, total: 4 },
        Renal: { score: 75, correct: 3, total: 4 },
      },
      diagnosticCoverage: {
        questionCount: 40,
        mappedQuestionCount: 40,
        systemsCovered: 5,
        systemsExpected: 5,
        coveragePercent: 100,
      },
    },
    recommendation,
    roadmapTasks,
    examDefinition: step1,
    generatedAt: "2026-07-24T13:00:00.000Z",
  });
  assert.equal(verified.evidence.kind, "server_verified_diagnostic");
  assert.equal(verified.readiness.score, 52);
  assert.equal(verified.readiness.passPrediction, false);
  assert.equal(verified.readiness.passProbability, null);
  assert.deepEqual(verified.weakAreas.map((row) => row.system), ["Cardiovascular"]);
  assert.equal(verified.firstSevenDays.taskCount, 1);
  assert.deepEqual(verified.firstSevenDays.days.map((day) => day.date), ["2026-07-24"]);
  assert.equal(verified.firstSevenDays.completedHistoryProtected, true);
  assert.equal(verified.firstSevenDays.kind, "adaptive_forecast");
  assert.equal(verified.firstSevenDays.readOnly, true);
  assert.equal(verified.firstSevenDays.authoritativeExecution, false);
  assert.equal(verified.firstSevenDays.executionRoute, "/dashboard/roadmap");
  assert.equal(verified.tutorBriefing.authoritativeRoadmap, true);
  assert.equal(verified.tutorBriefing.forecastIsAuthoritativeExecution, false);
  assert.equal(verified.nextAction.route, "/dashboard/personal-tutor");

  const provisional = buildAylaStartingReadinessReport({
    student: {
      id: "student-2",
      examTrackId: "usmle_step_1",
      exam: "USMLE Step 1",
      onboardingPath: "quick_profile",
      onboardingStatus: "ready",
      qbankAverage: 55,
      qbankCompleted: 50,
      weakAreas: ["Renal"],
    },
    recommendation,
    roadmapTasks,
    examDefinition: step1,
  });
  assert.equal(provisional.evidence.kind, "provisional_self_report");
  assert.equal(provisional.readiness.score, null);
  assert.equal(provisional.reportedStartingPoint.qbankAverageBand, "50–59%");
  assert.deepEqual(provisional.weakAreas.map((row) => row.system), ["Renal"]);
  assert.equal(provisional.weakAreas[0].confidence, "provisional");

  const fresh = buildAylaStartingReadinessReport({
    student: {
      id: "student-3",
      examTrackId: "nclex",
      exam: "NCLEX",
      onboardingPath: "starting_fresh",
      onboardingStatus: "ready",
    },
    recommendation: {
      ...recommendation,
      riskLevel: "Baseline Needed",
      phase: "Baseline & Planning",
      roadmapMode: "Beginner Diagnostic Roadmap",
    },
    examDefinition: nclex,
  });
  assert.equal(fresh.evidence.kind, "discovery_start");
  assert.equal(fresh.readiness.score, null);
  assert.equal(fresh.noWeaknessInvented, true);
  assert.equal(fresh.tutorBriefing.primaryFocus, "Baseline discovery");
});

test("pending diagnostic report never presents an unverified score", () => {
  const report = buildAylaStartingReadinessReport({
    student: {
      id: "student-pending",
      examTrackId: "usmle_step_1",
      exam: "USMLE Step 1",
      onboardingPath: "diagnostic_test",
      onboardingStatus: "diagnostic_pending",
      currentScore: 99,
      serverVerifiedBaseline: false,
    },
    recommendation: {
      riskLevel: "Baseline Needed",
      phase: "Baseline & Planning",
      roadmapMode: "Beginner Diagnostic Roadmap",
    },
    examDefinition: step1,
  });
  assert.equal(report.evidence.kind, "diagnostic_pending");
  assert.equal(report.readiness.score, null);
  assert.equal(report.nextAction.kind, "complete_diagnostic");
  assert.equal(report.nextAction.route, "/dashboard/qbank?diagnostic=1");
});

test("roadmap reconciliation preserves completed and past rows while superseding future incomplete work", () => {
  const existingTasks = [
    {
      id: "completed",
      studentId: "student-1",
      scheduledDate: "2026-07-24",
      status: "Completed",
      title: "Finished task",
    },
    {
      id: "past",
      studentId: "student-1",
      scheduledDate: "2026-07-23",
      status: "Pending",
      title: "Past incomplete task",
    },
    {
      id: "future",
      studentId: "student-1",
      scheduledDate: "2026-07-25",
      status: "Pending",
      title: "Old future task",
    },
    {
      id: "foreign",
      studentId: "student-2",
      scheduledDate: "2026-07-25",
      status: "Pending",
      title: "Another student's task",
    },
  ];
  const snapshot = structuredClone(existingTasks);
  const refresh = reconcileAylaRoadmapOutline({
    existingTasks,
    nextTasks: [{
      id: "replacement",
      studentId: "student-1",
      scheduledDate: "2026-07-25",
      status: "Pending",
      title: "Verified replacement",
    }],
    studentId: "student-1",
    fromDate: "2026-07-24",
    generationId: "generation-1",
    reason: "verified_baseline_diagnostic",
    now: "2026-07-24T13:00:00.000Z",
  });

  assert.deepEqual(existingTasks, snapshot, "pure reconciliation must not mutate stored history");
  assert.equal(refresh.preservedCompleted, 1);
  assert.equal(refresh.preservedPast, 1);
  assert.equal(refresh.supersededFuture, 1);
  assert.equal(refresh.updates[0].id, "future");
  assert.equal(refresh.updates[0].status, "Superseded");
  assert.equal(refresh.generatedTasks[0].roadmapGenerationId, "generation-1");
  assert.deepEqual(
    refresh.activeTasks.map((row) => row.id),
    ["past", "completed", "replacement"],
  );
  assert.equal(refresh.activeTasks.some((row) => row.id === "foreign"), false);
  assert.equal(refresh.completedHistoryProtected, true);
});

test("server wires onboarding into the existing isolated diagnostic and QBank routes", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /const AYLA_STARTING_READINESS_BUILD = "v229-starting-readiness-loop"/);
  const diagnosticRoute = server.slice(
    server.indexOf('app.post("/api/ayla/diagnostic-submissions"'),
    server.indexOf('app.get("/api/ayla/students/:id/dashboard"'),
  );
  const qbankCreate = server.slice(
    server.indexOf('app.post("/api/ayla/qbank/sessions"'),
    server.indexOf('app.get("/api/ayla/qbank/sessions/:sessionId"'),
  );
  const qbankSubmit = server.slice(
    server.indexOf('app.post("/api/ayla/qbank/sessions/:sessionId/submit"'),
    server.indexOf('app.get("/api/ayla/qbank/history"'),
  );

  assert.match(diagnosticRoute, /aylaContinuityPrefillTargetSetup\(req\.body, incomingHandoff\)/);
  assert.match(diagnosticRoute, /normalizeAylaOnboardingSubmission\(continuityPrefill\.input, \{[\s\S]*examDefinition: onboardingExamDefinition,[\s\S]*\}\)/);
  assert.match(diagnosticRoute, /onboarding\.selectedWeakAreas/);
  assert.match(diagnosticRoute, /type: "baseline_diagnostic"/);
  assert.match(qbankCreate, /purpose === "baseline_diagnostic" \? "test"/);
  assert.match(qbankCreate, /resumed_existing_diagnostic: true/);
  assert.match(qbankSubmit, /buildAylaVerifiedDiagnosticBaseline/);
  assert.match(qbankSubmit, /verified_baseline: verifiedBaseline/);
  assert.match(qbankSubmit, /aylaV229StoreFutureRoadmapOutline/);
  assert.match(qbankSubmit, /starting_readiness_report: startingReadinessReport/);
  assert.match(qbankSubmit, /aylaV189BuildDailyPlan\(db, fresh\.student, tomorrow/);
  assert.match(diagnosticRoute, /buildAylaStartingReadinessReport/);
  assert.doesNotMatch(server, /aylaDeleteItem\(db, "aylaRoadmapTasks"/);
});
