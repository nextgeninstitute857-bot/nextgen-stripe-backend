import test from "node:test";
import assert from "node:assert/strict";
import {
  AYLA_STEP1_PILOT,
  advanceAylaPilotStudyDate,
  aylaPilotStudyDate,
  buildAylaMateActivityFeed,
  buildAylaStep1PilotScenarios,
} from "../lib/aylamed-pilot.js";

test("Step 1 pilot matrix covers five distinct onboarding and timing conditions", () => {
  const scenarios = buildAylaStep1PilotScenarios("2026-07-27");
  assert.equal(scenarios.length, 5);
  assert.equal(scenarios.filter((row) => row.onboardingPath === "diagnostic_test").length, 2);
  assert.equal(scenarios.filter((row) => row.onboardingPath === "starting_fresh").length, 1);
  assert.equal(scenarios.filter((row) => row.onboardingPath === "quick_profile").length, 2);
  assert.ok(scenarios.some((row) => row.qbankCompleted === 50));
  assert.ok(scenarios.some((row) => row.qbankCompleted === 0));
  assert.ok(scenarios.some((row) => !row.examDate && !row.timezone));
  assert.equal(AYLA_STEP1_PILOT.features.includes("content_hub"), true);
});

test("pilot time advances independently and is capped at two weeks", () => {
  const student = {
    id: "pilot-1",
    pilotTest: true,
    pilotSimulation: { anchorDate: "2026-07-27", dayOffset: 0 },
  };
  const advanced = advanceAylaPilotStudyDate(student, 7);
  assert.equal(aylaPilotStudyDate(advanced).date, "2026-08-03");
  assert.equal(aylaPilotStudyDate(advanceAylaPilotStudyDate(advanced, 14)).dayOffset, 14);
  assert.throws(() => advanceAylaPilotStudyDate({ id: "real-1" }, 1), /Only a private pilot student/);
});

test("AylaMate feed distinguishes delivered work from pending promises", () => {
  const feed = buildAylaMateActivityFeed({
    student: { id: "pilot-1", pilotTest: true, examDate: "", timezone: "" },
    date: "2026-07-28",
    systemProgress: [{
      system: "Cardiovascular",
      systemKey: "cardiovascular",
      baselinePercent: 40,
      masteryPercent: 55,
      improvementPercent: 15,
      evidenceCount: 3,
      evidenceTypes: ["qbank"],
      trend: "improving",
    }],
    questionAttempts: [{
      id: "attempt-1",
      studentId: "pilot-1",
      serverVerified: true,
      correct: false,
      system: "Cardiovascular",
      topic: "Heart failure",
    }],
    resources: [],
    plan: { id: "plan-1", version: 2, reason: "Verified weak-area evidence." },
    assignments: [{ id: "a-1", status: "pending" }],
  });
  assert.ok(feed.some((row) => row.id === "rolling-plan-no-exam-date"));
  assert.ok(feed.some((row) => row.id === "timezone-needed"));
  assert.ok(feed.some((row) => row.title === "Cardiovascular is improving"));
  const miss = feed.find((row) => row.id === "question-miss-attempt-1");
  assert.equal(miss.status, "recorded");
  assert.match(miss.message, /no mistake card is marked as delivered yet/i);
});
