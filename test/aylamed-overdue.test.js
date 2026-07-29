import test from "node:test";
import assert from "node:assert/strict";

import {
  aylaOriginalOverdueAssignment,
  aylaOverdueBaseTitle,
  aylaOverdueTitle,
} from "../lib/aylamed-overdue.js";

test("overdue title remains single-prefixed for current and legacy records", () => {
  assert.equal(aylaOverdueTitle("Read chapter 4"), "Overdue: Read chapter 4");
  assert.equal(aylaOverdueTitle("Overdue: Read chapter 4"), "Overdue: Read chapter 4");
  assert.equal(
    aylaOverdueTitle("Overdue: Overdue: Read chapter 4"),
    "Overdue: Read chapter 4",
  );
  assert.equal(aylaOverdueBaseTitle("  overdue : Topic quiz "), "Topic quiz");
  assert.equal(aylaOverdueTitle(""), "Overdue: Priority assignment");
});

test("only original unfinished assignments are eligible for carry-forward", () => {
  assert.equal(aylaOriginalOverdueAssignment({ category: "reading" }), true);
  assert.equal(
    aylaOriginalOverdueAssignment({
      category: "reading",
      linkedAssignmentIds: ["AYLA-ASN-original"],
    }),
    false,
  );
  assert.equal(
    aylaOriginalOverdueAssignment({ category: "reading", overdueCarry: true }),
    false,
  );
  assert.equal(
    aylaOriginalOverdueAssignment({ category: "overdue_review" }),
    false,
  );
  assert.equal(
    aylaOriginalOverdueAssignment({
      category: "reading",
      linked_assignment_ids: "AYLA-ASN-original",
    }),
    false,
  );
});
