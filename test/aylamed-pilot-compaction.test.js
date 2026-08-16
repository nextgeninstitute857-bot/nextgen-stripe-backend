import assert from "node:assert/strict";
import test from "node:test";

import { compactAylaPrivatePilotPlans } from "../lib/aylamed-pilot-compaction.js";

test("private pilot compaction keeps one current plan per date and completed history", () => {
  const db = {
    aylaPilotCohorts: {
      cohort: { id: "cohort", private: true, studentIds: ["pilot"] },
    },
    aylaDailyPlans: {
      old: { id: "old", studentId: "pilot", date: "2026-08-10", status: "superseded", version: 1 },
      active1: { id: "active1", studentId: "pilot", date: "2026-08-10", status: "active", version: 2 },
      active2: { id: "active2", studentId: "pilot", date: "2026-08-10", status: "active", version: 3 },
      complete: { id: "complete", studentId: "pilot", date: "2026-08-09", status: "completed", version: 1 },
      ordinary: { id: "ordinary", studentId: "real", date: "2026-08-10", status: "superseded", version: 1 },
    },
    aylaResourceAssignments: {
      oldAssignment: { id: "oldAssignment", studentId: "pilot", dailyPlanId: "old", status: "superseded" },
      currentAssignment: { id: "currentAssignment", studentId: "pilot", dailyPlanId: "active2", status: "pending" },
      completeAssignment: { id: "completeAssignment", studentId: "pilot", dailyPlanId: "complete", status: "completed" },
      ordinaryAssignment: { id: "ordinaryAssignment", studentId: "real", dailyPlanId: "ordinary", status: "superseded" },
    },
  };

  const result = compactAylaPrivatePilotPlans(db);

  assert.deepEqual(result, {
    changed: true,
    pilot_student_count: 1,
    plans_removed: 2,
    assignments_removed: 1,
  });
  assert.deepEqual(Object.keys(db.aylaDailyPlans).sort(), ["active2", "complete", "ordinary"]);
  assert.deepEqual(Object.keys(db.aylaResourceAssignments).sort(), ["completeAssignment", "currentAssignment", "ordinaryAssignment"]);
});

test("private pilot compaction is a no-op without private cohorts", () => {
  const db = {
    aylaPilotCohorts: {},
    aylaDailyPlans: { plan: { id: "plan", studentId: "real", status: "active" } },
    aylaResourceAssignments: {},
  };

  assert.deepEqual(compactAylaPrivatePilotPlans(db), {
    changed: false,
    pilot_student_count: 0,
    plans_removed: 0,
    assignments_removed: 0,
  });
  assert.equal(db.aylaDailyPlans.plan.id, "plan");
});
