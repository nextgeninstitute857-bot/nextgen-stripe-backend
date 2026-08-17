import test from "node:test";
import assert from "node:assert/strict";

import {
  AYLA_ADAPTATION_FAST_FORWARD_CHECKPOINT_DAYS,
  runAylaAdaptationFastForward,
  runAylaAdaptationFastForwardSuite,
} from "../lib/aylamed-adaptation-fast-forward.js";

for (const examVariant of ["nclex_rn", "nclex_pn"]) {
  test(`${examVariant} safely fast-forwards 14, 30, 120 and 150 days`, () => {
    const result = runAylaAdaptationFastForward({ days: 150, examVariant });
    assert.deepEqual(Object.keys(result.checkpoints).map(Number), [...AYLA_ADAPTATION_FAST_FORWARD_CHECKPOINT_DAYS]);
    assert.deepEqual(result.simulation.productionIsolation, {
      databaseWrites: 0,
      filesystemWrites: 0,
      networkRequests: 0,
      realStudentRecordsTouched: 0,
      productionClockChanged: false,
    });
    assert.ok(Object.values(result.acceptance).every(Boolean));
    assert.equal(result.totals.maximumAssessmentsInOneDay, 1);
    assert.ok(result.totals.resurfacedCards > 0);
    assert.ok(result.checkpoints[150].averageCardIntervalDays > result.checkpoints[14].averageCardIntervalDays);
    assert.ok(result.checkpoints[150].recentAccuracyPercent > result.checkpoints[14].recentAccuracyPercent);
  });
}

test("the control learner remains weak instead of receiving invented improvement", () => {
  const result = runAylaAdaptationFastForward({ days: 150, scenario: "stagnant", examVariant: "nclex_rn" });
  assert.equal(result.acceptance.performanceRespondsToEvidence, true);
  assert.equal(result.acceptance.personalTutorTracksWeakestSystem, true);
  assert.ok(result.checkpoints[14].expectedWeakestSystems.includes(result.checkpoints[14].tutorWeakSystem));
  assert.ok(result.checkpoints[150].weakAreas.length > 0);
  assert.ok(result.checkpoints[150].averageCardIntervalDays <= 3);
});

test("the paired suite distinguishes improving evidence from stagnant evidence", () => {
  const suite = runAylaAdaptationFastForwardSuite({ days: 150, examVariant: "nclex_rn" });
  assert.equal(suite.comparison.improvementDetected, true);
  assert.equal(suite.comparison.nonImprovementNotInvented, true);
  assert.equal(suite.comparison.safeToUseAsProductionMigration, false);
});
