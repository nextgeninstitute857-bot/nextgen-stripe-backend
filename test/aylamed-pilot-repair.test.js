import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  AYLA_PILOT_FLOW_REPAIR_VERSION,
  buildAylaPilotFlowRepairPlan,
} from "../lib/aylamed-pilot-repair.js";

function fixture(overrides = {}) {
  return {
    cohort: {
      id: "AYLA-PILOT-1",
      private: true,
      status: "active",
      examTrackId: "usmle_step_1",
      studentIds: ["student-diagnostic", "student-qbank"],
      ...overrides.cohort,
    },
    students: [
      { id: "student-diagnostic", pilotScenarioKey: "diagnostic_karachi" },
      { id: "student-qbank", pilotScenarioKey: "qbank_half_london" },
    ],
    dailyPlans: [
      { id: "plan-active", studentId: "student-diagnostic", status: "active" },
      { id: "plan-complete", studentId: "student-qbank", status: "completed" },
    ],
    assignments: [
      { id: "assignment-pending", studentId: "student-diagnostic", status: "pending" },
      { id: "assignment-complete", studentId: "student-qbank", status: "completed" },
    ],
    revisionQueue: [
      {
        id: "revision-renal",
        studentId: "student-qbank",
        status: "due",
        system: "1",
        topic: "Diabetic Kidney Disease",
        resourceId: "question-1",
      },
      {
        id: "revision-renal-duplicate",
        studentId: "student-qbank",
        status: "assigned",
        system: "1",
        topic: "Diabetic Kidney Disease",
        resourceId: "question-1",
      },
      {
        id: "revision-unsafe",
        studentId: "student-qbank",
        status: "due",
        system: "1021",
        topic: "Unmapped pilot residue",
      },
    ],
    qbankSessions: [
      {
        id: "legacy-zero",
        studentId: "student-diagnostic",
        purpose: "baseline_diagnostic",
        status: "in_progress",
        diagnosticBlueprintVersion: 1,
        answers: {},
      },
    ],
    ...overrides,
  };
}

test("pilot repair is cohort-scoped, reversible, and preserves completed history", () => {
  const plan = buildAylaPilotFlowRepairPlan(fixture());
  assert.equal(plan.version, AYLA_PILOT_FLOW_REPAIR_VERSION);
  assert.equal(plan.eligible, true);
  assert.deepEqual(plan.activePlanIds, ["plan-active"]);
  assert.deepEqual(plan.unfinishedAssignmentIds, ["assignment-pending"]);
  assert.deepEqual(plan.completedAssignmentIds, ["assignment-complete"]);
  assert.deepEqual(plan.zeroAnswerInvalidDiagnosticIds, ["legacy-zero"]);
  assert.deepEqual(plan.unsafeRevisionIds, ["revision-unsafe"]);
  assert.deepEqual(plan.duplicateRevisionIds, ["revision-renal-duplicate"]);
  assert.deepEqual(plan.canonicalRevisionUpdates, [
    { id: "revision-renal", system: "Renal" },
    { id: "revision-renal-duplicate", system: "Renal" },
  ]);
  assert.equal(plan.safeguards.questionAttemptsPreserved, true);
  assert.equal(plan.safeguards.ordinaryStudentsUntouched, true);
});

test("an answered legacy diagnostic blocks automatic pilot repair", () => {
  const input = fixture();
  input.qbankSessions[0].answers = { "question-1": "answer-a" };
  const plan = buildAylaPilotFlowRepairPlan(input);
  assert.equal(plan.eligible, false);
  assert.equal(plan.blocked, "answered_legacy_diagnostic_requires_manual_review");
  assert.deepEqual(plan.answeredInvalidDiagnosticIds, ["legacy-zero"]);
  assert.deepEqual(plan.zeroAnswerInvalidDiagnosticIds, []);
});

test("ordinary student records are never selected by the pilot repair", () => {
  const input = fixture();
  input.dailyPlans.push({ id: "ordinary-plan", studentId: "ordinary-student", status: "active" });
  input.assignments.push({ id: "ordinary-assignment", studentId: "ordinary-student", status: "pending" });
  const plan = buildAylaPilotFlowRepairPlan(input);
  assert.equal(plan.activePlanIds.includes("ordinary-plan"), false);
  assert.equal(plan.unfinishedAssignmentIds.includes("ordinary-assignment"), false);
});

test("server exposes preview-first, typed-confirmation pilot repair routes", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /repair-preview/);
  assert.match(server, /`REPAIR \$\{cohort\.id\}`/);
  assert.match(server, /app\.post\("\/api\/ayla\/admin\/pilot\/cohorts\/:cohortId\/repair"/);
  assert.match(server, /questionAttemptsPreserved: true/);
  assert.match(server, /ordinaryStudentsUntouched: true/);
});
