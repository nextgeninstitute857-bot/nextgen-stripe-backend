import test from "node:test";
import assert from "node:assert/strict";
import {
  aylaExamPreparationProfile,
  compareAylaExamPathways,
  estimateAylaExamPathway,
} from "../lib/aylamed-pathway-estimator.js";

test("Step 1 uses the new official delivery structure after May 14, 2026", () => {
  const plan = estimateAylaExamPathway({
    examTrackId: "usmle_step_1",
    examDate: "2026-08-26",
    weeklyStudyDays: 6,
    dailyHoursAvailable: 6,
  }, { today: "2026-07-27" });
  assert.equal(plan.exam.format.blocks, 14);
  assert.equal(plan.exam.format.minutesPerBlock, 30);
  assert.equal(plan.exam.format.totalItemsMaximum, 280);
});

test("pathway estimator makes a one-month fresh start harder than a three-month plan", () => {
  const [oneMonth, twoMonths, threeMonths] = compareAylaExamPathways({
    examTrackId: "usmle_step_1",
    weeklyStudyDays: 6,
    dailyHoursAvailable: 6,
    qbankCompletedPercent: 0,
    lectureCompletedPercent: 0,
    readingCompletedPercent: 0,
  }, { today: "2026-07-27" });
  assert.ok(oneMonth.workload.requiredHoursPerStudyDay > threeMonths.workload.requiredHoursPerStudyDay);
  assert.equal(oneMonth.confidence.level, "low");
  assert.equal(oneMonth.feasibility.key, "not_currently_feasible");
  assert.ok(twoMonths.workload.studyDays > oneMonth.workload.studyDays);
});

test("verified progress reduces workload and increases confidence without promising a pass", () => {
  const plan = estimateAylaExamPathway({
    examTrackId: "usmle_step_1",
    targetDays: 60,
    weeklyStudyDays: 6,
    dailyHoursAvailable: 8,
    qbankCompletedPercent: 50,
    lectureCompletedPercent: 70,
    readingCompletedPercent: 60,
    latestAssessmentPercent: 64,
    baselineVerified: true,
  }, { today: "2026-07-27" });
  assert.equal(plan.confidence.level, "high");
  assert.equal(plan.workload.components.questions.remaining, 1800);
  assert.match(plan.disclaimer, /not a prediction or guarantee/i);
  assert.ok(plan.aylaMedWillProvide.some((row) => /what changed/i.test(row)));
  assert.equal(aylaExamPreparationProfile("usmle_step_1").currentFormat.blocks, 14);
});

test("student can estimate an exact date outside the 30, 60, and 90 day shortcuts", () => {
  const plan = estimateAylaExamPathway({
    examTrackId: "usmle_step_1",
    examDate: "2026-11-19",
    weeklyStudyDays: 5,
    dailyHoursAvailable: 4,
    qbankCompletedPercent: 25,
  }, { today: "2026-07-27" });
  assert.equal(plan.exam.examDate, "2026-11-19");
  assert.equal(plan.exam.targetDays, 115);
  assert.equal(plan.inputs.weeklyStudyDays, 5);
  assert.equal(plan.inputs.dailyHoursAvailable, 4);
});

test("pathway estimator rejects invalid or non-future exact dates", () => {
  assert.throws(
    () => estimateAylaExamPathway({ examDate: "2026-02-30" }, { today: "2026-07-27" }),
    /valid exam date/i,
  );
  assert.throws(
    () => estimateAylaExamPathway({ examDate: "2026-07-27" }, { today: "2026-07-27" }),
    /after today/i,
  );
  assert.throws(
    () => estimateAylaExamPathway({ examDate: "2026-07-01" }, { today: "2026-07-27" }),
    /after today/i,
  );
});
