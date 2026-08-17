import assert from "node:assert/strict";
import test from "node:test";

import { buildAylaScheduleRisk } from "../lib/aylamed-schedule-risk.js";

test("schedule risk quantifies backlog, delay, and daily recovery time", () => {
  const risk = buildAylaScheduleRisk({
    backlogCount: 6,
    backlogMinutes: 420,
    dailyCapacityMinutes: 180,
    studyDaysRemaining: 14,
    daysToTarget: 18,
    targetLabel: "Step 2 CK exam",
    requiredDailyMinutes: 210,
  });

  assert.equal(risk.level, "high");
  assert.equal(risk.backlogHours, 7);
  assert.equal(risk.studyDaysBehind, 3);
  assert.equal(risk.projectedDelayStudyDays, 3);
  assert.equal(risk.recoveryExtraDailyMinutes, 30);
  assert.equal(risk.extraDailyMinutes, 30);
  assert.match(risk.message, /6 unfinished tasks \(7 hours\)/);
  assert.match(risk.message, /3 study days behind/);
  assert.match(risk.assessmentImpact, /studies the weak area before testing it/);
});

test("schedule risk stays on track without backlog or capacity pressure", () => {
  const risk = buildAylaScheduleRisk({
    backlogCount: 0,
    backlogMinutes: 0,
    dailyCapacityMinutes: 180,
    studyDaysRemaining: 30,
    requiredDailyMinutes: 150,
  });

  assert.equal(risk.level, "on_track");
  assert.equal(risk.studyDaysBehind, 0);
  assert.equal(risk.extraDailyMinutes, 0);
  assert.deepEqual(risk.recoveryActions, []);
});
