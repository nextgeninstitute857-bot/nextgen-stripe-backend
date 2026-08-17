import assert from "node:assert/strict";
import test from "node:test";

import { buildAylaPlanChangeNotice } from "../lib/aylamed-plan-change-notice.js";

test("roadmap changes are explained while completed history remains protected", () => {
  const notice = buildAylaPlanChangeNotice({
    previousPlan: { focusSystem: "Cardiovascular", focusTopic: "Shock" },
    currentPlan: { focusSystem: "Renal", focusTopic: "Acid-base" },
    previousAssignments: [
      { category: "video", title: "Shock review", status: "pending", system: "Cardiovascular", topic: "Shock" },
      { category: "reading", title: "Completed chapter", status: "completed", system: "Cardiovascular", topic: "Shock" },
    ],
    currentAssignments: [
      { category: "video", title: "Acid-base review", status: "pending", system: "Renal", topic: "Acid-base" },
    ],
    reason: "student_request",
  });

  assert.equal(notice.addedCount, 1);
  assert.equal(notice.movedOrRemovedCount, 1);
  assert.equal(notice.focusChanged, true);
  assert.equal(notice.completedHistoryPreserved, true);
  assert.equal(notice.completedHistoryPreservedCount, 1);
  assert.match(notice.message, /Completed work was preserved/);
});

test("initial plans do not pretend that a roadmap changed", () => {
  assert.equal(buildAylaPlanChangeNotice({ currentPlan: {}, currentAssignments: [] }), null);
});

