import test from "node:test";
import assert from "node:assert/strict";

import {
  aylaOriginalOverdueAssignment,
  aylaOverdueBaseTitle,
  aylaOverdueTitle,
  aylaCatchUpCutoffDate,
  aylaExpiredCatchUpAssignments,
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

test("catch-up work older than 7 days expires with its copies; recent and future work stays", () => {
  assert.equal(aylaCatchUpCutoffDate("2026-09-30"), "2026-09-23");
  assert.equal(aylaCatchUpCutoffDate("not-a-date"), "");
  const rows = [
    { id: "old", scheduledDate: "2026-08-31", status: "pending" },
    { id: "recent", scheduledDate: "2026-09-28", status: "pending" },
    { id: "old-copy", scheduledDate: "2026-09-29", status: "pending", overdueCarry: true, linkedAssignmentIds: ["old"] },
    { id: "future-copy", scheduledDate: "2026-10-01", status: "pending", overdueCarry: true, linkedAssignmentIds: ["old"] },
    { id: "done", scheduledDate: "2026-08-20", status: "completed" },
  ];
  const result = aylaExpiredCatchUpAssignments(rows, "2026-09-30");
  assert.deepEqual(result.roots.map((row) => row.id), ["old"]);
  assert.deepEqual(result.copies.map((row) => row.id), ["old-copy"]);
  assert.deepEqual(aylaExpiredCatchUpAssignments(rows, "").roots, []);
});
