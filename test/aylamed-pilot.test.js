import test from "node:test";
import assert from "node:assert/strict";
import {
  AYLA_STEP1_PILOT,
  advanceAylaPilotStudyDate,
  aylaPilotStudyDate,
  buildAylaMateActivityFeed,
  buildAylaStep1PilotScenarios,
} from "../lib/aylamed-pilot.js";
import {
  aylaPilotContentScope,
  aylaPilotContentVisibleToStudent,
} from "../lib/aylamed-pilot-content.js";

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

test("Ayla notification feed distinguishes delivered work from pending promises and narrates verified reviews", () => {
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
      outcome: "incorrect",
      system: "Cardiovascular",
      topic: "Heart failure",
    }],
    flashcardReviews: [{
      id: "review-1",
      studentId: "pilot-1",
      serverVerified: true,
      resourceId: "card-1",
      system: "Cardiovascular",
      topic: "Cardiac preload",
      rating: "good",
      nextReviewDate: "2026-07-31",
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
  const review = feed.find((row) => row.id === "flashcard-review-review-1");
  assert.equal(review.status, "delivered");
  assert.match(review.message, /next recall is scheduled for 2026-07-31/i);
});

test("private pilot content is invisible to ordinary students", () => {
  const resource = {
    id: "book-1",
    accessScope: "private_pilot",
    pilotCohortId: "cohort-1",
  };
  assert.deepEqual(aylaPilotContentScope(resource), {
    accessScope: "private_pilot",
    pilotOnly: true,
    pilotCohortId: "cohort-1",
    pilotStudentIds: [],
  });
  assert.equal(aylaPilotContentVisibleToStudent(resource, {
    id: "ordinary-1",
    pilotTest: false,
    pilotCohortId: "cohort-1",
  }), false);
  assert.equal(aylaPilotContentVisibleToStudent(resource, {
    id: "pilot-other",
    pilotTest: true,
    pilotCohortId: "cohort-2",
  }), false);
  assert.equal(aylaPilotContentVisibleToStudent(resource, {
    id: "pilot-1",
    pilotTest: true,
    pilotCohortId: "cohort-1",
  }), true);
});

test("pilot student allowlists narrow cohort content without affecting standard resources", () => {
  const scoped = {
    pilot_only: true,
    pilot_student_ids: ["pilot-1", "pilot-2"],
  };
  assert.equal(aylaPilotContentVisibleToStudent(scoped, {
    id: "pilot-1",
    pilotTest: true,
  }), true);
  assert.equal(aylaPilotContentVisibleToStudent(scoped, {
    id: "pilot-3",
    pilotTest: true,
  }), false);
  assert.equal(aylaPilotContentVisibleToStudent({
    id: "ordinary-book",
  }, {
    id: "ordinary-1",
    pilotTest: false,
  }), true);
});
