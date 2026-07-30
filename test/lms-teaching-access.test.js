import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  LMS_FULL_TEACHING_PLAN_ID,
  LMS_TEACHING_ACCESS_MODE,
  lmsPlanUsesTeachingSchedule,
  reconcileConfirmedTeachingPlanAccess,
  resolveTeachingPlanExpiry,
  summarizeCourseTeachingSchedule,
} from "../lib/lms-teaching-access.js";

const courseId = "course-step-1";
const fullPlan = {
  id: LMS_FULL_TEACHING_PLAN_ID,
  name: "Premium Live Batch",
  price_cents: 35000,
  billing_type: "one_time",
  access_days: null,
};
const monthlyPlan = {
  id: "e24ba713-4b60-45bf-8fe0-75c93056ecf4",
  name: "Premium Live Batch Monthly",
  price_cents: 10000,
  billing_type: "subscription_monthly",
  access_days: null,
};

function liveDb({ finalDate = "2026-11-27", enrollments = {} } = {}) {
  return {
    plans: {
      [fullPlan.id]: structuredClone(fullPlan),
      [monthlyPlan.id]: structuredClone(monthlyPlan),
    },
    enrollments,
    roadmaps: {
      [courseId]: {
        id: courseId,
        course_id: courseId,
        updated_at: "2026-07-31T00:00:00.000Z",
        days: [
          { id: "holiday-1", date: "2026-07-01", status: "holiday", is_schedule_placeholder: true },
          { id: "day-1", date: "2026-07-02", status: "scheduled", instructional_day_number: 1 },
          { id: "holiday-2", date: "2026-07-03", status: "holiday", is_schedule_placeholder: true },
          { id: "day-2", date: "2026-07-04", status: "scheduled", instructional_day_number: 2 },
          { id: "day-final", date: finalDate, status: "scheduled", instructional_day_number: 124 },
        ],
      },
    },
  };
}

function enrollment(overrides = {}) {
  return {
    id: "enrollment-full",
    user_id: "student-full",
    course_id: courseId,
    plan_id: fullPlan.id,
    is_demo: false,
    access_granted: true,
    access_starts_at: "2026-07-02T00:00:00.000Z",
    access_expires_at: "2026-08-01T00:00:00.000Z",
    renewal_due_at: "2026-08-01T00:00:00.000Z",
    billing_notifications_sent: {
      renewal_7_days: "2026-07-25T00:00:00.000Z",
      renewal_3_days: "2026-07-29T00:00:00.000Z",
    },
    ...overrides,
  };
}

test("only the confirmed full teaching plan uses the course roadmap", () => {
  assert.equal(lmsPlanUsesTeachingSchedule(fullPlan), true);
  assert.equal(lmsPlanUsesTeachingSchedule(monthlyPlan), false);
  assert.equal(lmsPlanUsesTeachingSchedule({
    id: "future-full-plan",
    name: "Future cohort",
    access_expiry_mode: LMS_TEACHING_ACCESS_MODE,
  }), true);
});

test("roadmap summary excludes holidays and uses the actual final teaching day", () => {
  const db = liveDb();
  const summary = summarizeCourseTeachingSchedule(db, courseId, new Date("2026-07-31T12:00:00.000Z"));
  assert.equal(summary.schedule_rows, 5);
  assert.equal(summary.no_class_days, 2);
  assert.equal(summary.teaching_days, 3);
  assert.equal(summary.teaching_days_elapsed, 2);
  assert.equal(summary.teaching_days_remaining, 1);
  assert.equal(summary.final_teaching_date, "2026-11-27");
  assert.equal(summary.final_teaching_expiry_at, "2026-11-27T23:59:59.999Z");
});

test("roadmap summary excludes every supported no-class marker", () => {
  const db = liveDb();
  db.roadmaps[courseId].days.push(
    { id: "no-class-flag", date: "2026-08-01", is_no_class_day: true },
    { id: "no-class-copy", date: "2026-08-02", description: "Tutor unavailable" },
    { id: "sunday-off", date: "2026-08-03", title: "Sunday Off" },
  );

  const summary = summarizeCourseTeachingSchedule(db, courseId, new Date("2026-07-31T12:00:00.000Z"));
  assert.equal(summary.teaching_days, 3);
  assert.equal(summary.no_class_days, 5);
  assert.equal(summary.final_teaching_date, "2026-11-27");
});

test("confirmed full access is extended to the final teaching day and wrong reminders are reset", () => {
  const row = enrollment();
  const db = liveDb({ enrollments: { [row.id]: row } });
  const result = reconcileConfirmedTeachingPlanAccess(db, {
    now: new Date("2026-07-31T12:00:00.000Z"),
    source: "unit_test",
  });

  assert.equal(result.confirmed_unique_students, 1);
  assert.equal(result.at_risk_unique_students, 1);
  assert.equal(result.enrollments_updated, 1);
  assert.equal(db.plans[fullPlan.id].access_days, 120);
  assert.equal(db.plans[fullPlan.id].access_expiry_mode, LMS_TEACHING_ACCESS_MODE);
  assert.equal(row.access_expires_at, "2026-11-27T23:59:59.999Z");
  assert.equal(row.renewal_due_at, "2026-11-27T23:59:59.999Z");
  assert.equal(row.program_final_teaching_date, "2026-11-27");
  assert.deepEqual(row.billing_notifications_sent, {});

  const followUp = reconcileConfirmedTeachingPlanAccess(db, {
    now: new Date("2026-08-01T12:00:00.000Z"),
    source: "unit_test_follow_up",
  });
  assert.equal(followUp.at_risk_unique_students, 1);
  assert.equal(followUp.enrollments_updated, 0);
});

test("monthly and ambiguous legacy enrollments remain unchanged", () => {
  const monthly = enrollment({
    id: "enrollment-monthly",
    user_id: "student-monthly",
    plan_id: monthlyPlan.id,
  });
  const legacy = enrollment({
    id: "enrollment-legacy",
    user_id: "student-legacy",
    plan_id: null,
  });
  const beforeMonthly = structuredClone(monthly);
  const beforeLegacy = structuredClone(legacy);
  const db = liveDb({ enrollments: { [monthly.id]: monthly, [legacy.id]: legacy } });

  const result = reconcileConfirmedTeachingPlanAccess(db, {
    now: new Date("2026-07-31T12:00:00.000Z"),
  });

  assert.equal(result.confirmed_enrollment_rows, 0);
  assert.deepEqual(monthly, beforeMonthly);
  assert.deepEqual(legacy, beforeLegacy);
  assert.equal(db.plans[monthlyPlan.id].access_days, null);
});

test("only an automatic access_expired revocation is restored", () => {
  const automatic = enrollment({
    id: "automatic",
    user_id: "student-auto",
    access_granted: false,
    revoked_reason: "access_expired",
    revoked_at: "2026-07-31T01:00:00.000Z",
  });
  const manual = enrollment({
    id: "manual",
    user_id: "student-manual",
    access_granted: false,
    revoked_reason: "admin_revoked",
    revoked_at: "2026-07-20T01:00:00.000Z",
  });
  const db = liveDb({ enrollments: { automatic, manual } });

  const result = reconcileConfirmedTeachingPlanAccess(db, {
    now: new Date("2026-07-31T12:00:00.000Z"),
  });

  assert.equal(result.auto_expired_restored, 1);
  assert.equal(result.skipped_manual_revocations, 1);
  assert.equal(automatic.access_granted, true);
  assert.equal(automatic.revoked_reason, null);
  assert.equal(automatic.access_expires_at, "2026-11-27T23:59:59.999Z");
  assert.equal(manual.access_granted, false);
  assert.equal(manual.revoked_reason, "admin_revoked");
  assert.equal(manual.access_expires_at, "2026-08-01T00:00:00.000Z");
});

test("a later holiday push extends access again without shortening a manual extension", () => {
  const row = enrollment();
  const db = liveDb({ enrollments: { [row.id]: row } });
  reconcileConfirmedTeachingPlanAccess(db, { now: new Date("2026-07-31T12:00:00.000Z") });
  assert.equal(row.access_expires_at, "2026-11-27T23:59:59.999Z");

  db.roadmaps[courseId].days.at(-1).date = "2026-11-28";
  reconcileConfirmedTeachingPlanAccess(db, { now: new Date("2026-08-01T12:00:00.000Z") });
  assert.equal(row.access_expires_at, "2026-11-28T23:59:59.999Z");

  row.access_expires_at = "2026-12-31T23:59:59.999Z";
  const resolution = resolveTeachingPlanExpiry(db, row, db.plans[fullPlan.id], {
    now: new Date("2026-08-02T12:00:00.000Z"),
  });
  assert.equal(resolution.effective_expiry_at, "2026-12-31T23:59:59.999Z");
  reconcileConfirmedTeachingPlanAccess(db, { now: new Date("2026-08-02T12:00:00.000Z") });
  assert.equal(row.access_expires_at, "2026-12-31T23:59:59.999Z");
});

test("a reminder sent for the correct teaching-day expiry is not cleared by later writes", () => {
  const row = enrollment({
    access_expires_at: "2026-11-27T23:59:59.999Z",
    renewal_due_at: "2026-11-27T23:59:59.999Z",
    access_expiry_mode: LMS_TEACHING_ACCESS_MODE,
    minimum_teaching_days: 120,
    program_teaching_days: 3,
    program_final_teaching_date: "2026-11-27",
    billing_notifications_sent: {
      renewal_7_days: "2026-11-20T12:00:00.000Z",
    },
  });
  const db = liveDb({ enrollments: { [row.id]: row } });

  reconcileConfirmedTeachingPlanAccess(db, {
    now: new Date("2026-11-21T12:00:00.000Z"),
  });

  assert.deepEqual(row.billing_notifications_sent, {
    renewal_7_days: "2026-11-20T12:00:00.000Z",
  });
});

test("server wires protection into writes, expiry checks, startup, health, and the admin audit", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /const LMS_TEACHING_ACCESS_BUILD = "v255-course-teaching-day-access"/);
  assert.match(server, /ngApplyTeachingAccessReconciliation\(db/);
  assert.match(server, /source: `\$\{source\}_pre_expiry_protection`/);
  assert.match(server, /app\.get\("\/admin\/billing\/teaching-access-audit"/);
  assert.match(server, /lms_teaching_access: ngTeachingAccessReconciliationState/);
  assert.match(server, /ngRunTeachingAccessStartupReconciliation\(\)/);
});
