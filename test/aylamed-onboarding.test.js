import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AYLA_ONBOARDING_PRESETS,
  buildAylaVerifiedDiagnosticBaseline,
  normalizeAylaOnboardingSubmission,
} from "../lib/aylamed-onboarding.js";

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
  assert.equal("Respiratory" in baseline.systemBaselines, false);
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

test("server wires onboarding into the existing isolated diagnostic and QBank routes", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
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

  assert.match(diagnosticRoute, /normalizeAylaOnboardingSubmission\(req\.body, \{ examDefinition \}\)/);
  assert.match(diagnosticRoute, /onboarding\.selectedWeakAreas/);
  assert.match(diagnosticRoute, /type: "baseline_diagnostic"/);
  assert.match(qbankCreate, /purpose === "baseline_diagnostic" \? "test"/);
  assert.match(qbankCreate, /resumed_existing_diagnostic: true/);
  assert.match(qbankSubmit, /buildAylaVerifiedDiagnosticBaseline/);
  assert.match(qbankSubmit, /verified_baseline: verifiedBaseline/);
  assert.match(qbankSubmit, /aylaV189BuildDailyPlan\(db, fresh\.student, tomorrow/);
});
