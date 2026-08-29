import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  demoPredatesPaidActivation,
  latestPaidActivationTimestamp,
  reconcilePaidDemoEnrollments,
  supersedeDemoEnrollmentsForPaidAccess,
} from "../lib/lms-paid-demo-consolidation.js";

const DEMO_ID = "course:user:demo";
const PAID_ID = "course:user:paid";

function fixture(overrides = {}) {
  return {
    enrollments: {
      [DEMO_ID]: {
        id: DEMO_ID,
        user_id: "user",
        course_id: "course",
        is_demo: true,
        access_granted: true,
        demo_expiry: "2026-08-29",
        created_at: "2026-07-13T21:40:44.596Z",
      },
      [PAID_ID]: {
        id: PAID_ID,
        user_id: "user",
        course_id: "course",
        plan_id: "monthly",
        is_demo: false,
        access_granted: true,
        access_starts_at: "2026-07-16T06:21:08.000Z",
        access_expires_at: "2026-09-15T13:14:11.000Z",
        paid_at: "2026-07-16T06:21:08.000Z",
        created_at: "2026-07-14T18:17:53.158Z",
      },
    },
    payments: {
      renewal: {
        id: "renewal",
        enrollment_id: PAID_ID,
        user_id: "user",
        course_id: "course",
        plan_id: "monthly",
        amount_cents: 4500,
        status: "completed",
        paid_at: "2026-08-16T13:14:11.000Z",
      },
    },
    ...overrides,
  };
}

test("a successful paid activation archives the earlier demo without changing paid access", () => {
  const db = fixture();
  const paidBefore = structuredClone(db.enrollments[PAID_ID]);
  const result = supersedeDemoEnrollmentsForPaidAccess(db, db.enrollments[PAID_ID], {
    source: "test_paid_upgrade",
    at: "2026-08-29T12:00:00.000Z",
  });

  assert.equal(result.changed_count, 1);
  assert.deepEqual(db.enrollments[PAID_ID], paidBefore);
  assert.equal(db.enrollments[DEMO_ID].access_granted, false);
  assert.equal(db.enrollments[DEMO_ID].revoked_reason, "upgraded_to_paid");
  assert.equal(db.enrollments[DEMO_ID].superseded_by_enrollment_id, PAID_ID);
  assert.equal(db.enrollments[DEMO_ID].demo_expiry, "2026-08-29");
});

test("reconciliation is idempotent and ignores expired checkout attempts", () => {
  const db = fixture({
    payments: {
      abandoned: {
        id: "abandoned",
        enrollment_id: PAID_ID,
        user_id: "user",
        course_id: "course",
        status: "expired",
        created_at: "2026-09-20T00:00:00.000Z",
      },
      renewal: fixture().payments.renewal,
    },
  });

  assert.equal(latestPaidActivationTimestamp(db, db.enrollments[PAID_ID]), Date.parse("2026-08-16T13:14:11.000Z"));
  const first = reconcilePaidDemoEnrollments(db, { at: "2026-08-29T12:00:00.000Z" });
  const second = reconcilePaidDemoEnrollments(db, { at: "2026-08-29T12:01:00.000Z" });
  assert.equal(first.superseded_demo_count, 1);
  assert.equal(second.superseded_demo_count, 0);
  assert.equal(second.changed, false);
});

test("a pending paid checkout does not cancel a legitimate demo", () => {
  const db = fixture({ payments: {} });
  db.enrollments[PAID_ID] = {
    ...db.enrollments[PAID_ID],
    access_granted: false,
    access_starts_at: null,
    paid_at: null,
    created_at: null,
  };

  assert.equal(demoPredatesPaidActivation(db, db.enrollments[DEMO_ID], db.enrollments[PAID_ID]), false);
  assert.equal(reconcilePaidDemoEnrollments(db).changed, false);
  assert.equal(db.enrollments[DEMO_ID].access_granted, true);
});

test("active paid access archives a same-course demo even when that demo was created later", () => {
  const db = fixture();
  db.enrollments[DEMO_ID].created_at = "2026-08-20T00:00:00.000Z";

  assert.equal(demoPredatesPaidActivation(db, db.enrollments[DEMO_ID], db.enrollments[PAID_ID]), true);
  assert.equal(reconcilePaidDemoEnrollments(db).changed, true);
  assert.equal(db.enrollments[DEMO_ID].access_granted, false);
});

test("a new demo can remain after a genuinely expired paid term", () => {
  const db = fixture();
  db.enrollments[DEMO_ID].created_at = "2026-08-20T00:00:00.000Z";
  db.enrollments[PAID_ID].access_expires_at = "2026-08-01T00:00:00.000Z";
  db.enrollments[PAID_ID].renewal_due_at = "2026-08-01T00:00:00.000Z";

  assert.equal(demoPredatesPaidActivation(db, db.enrollments[DEMO_ID], db.enrollments[PAID_ID]), false);
  assert.equal(reconcilePaidDemoEnrollments(db).changed, false);
  assert.equal(db.enrollments[DEMO_ID].access_granted, true);
});

test("the server consolidates on payment, startup, and before demo notices", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

  assert.match(server, /function ngApplyPaidAccessWindow[\s\S]*?supersedeDemoEnrollmentsForPaidAccess/);
  assert.match(server, /async function ngRunPaidDemoStartupConsolidation[\s\S]*?reconcilePaidDemoEnrollments/);
  assert.match(server, /async function ngRunDemoEmailLifecycleCheck[\s\S]*?pre_demo_notice/);
  assert.match(server, /enrollment\.access_granted === false \|\| enrollment\.superseded_by_enrollment_id/);
});
