import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AYLA_STUDENT_FEATURES,
  aylaScopedEnrollmentKey,
  normalizeAylaRegistryExamTrack,
  normalizeAylaShellExamTrack,
  resolveAylaExamFeatureEntitlement,
  resolveAylaStudentShell,
} from "../lib/aylamed-student-shell.js";

const now = new Date("2026-07-19T12:00:00.000Z");
const future = "2099-01-01T00:00:00.000Z";
const plans = {
  full: { id: "full", included_features: AYLA_STUDENT_FEATURES.map((feature) => feature.key) },
  roadmap: { id: "roadmap", included_features: ["roadmap", "progress"] },
  demo: { id: "demo", is_demo: true, included_features: ["roadmap", "qbank"] },
};

function student(id, examTrackId, updatedAt = "2026-07-19T10:00:00.000Z") {
  return { id, ayla_user_id: "user-1", examTrackId, updatedAt };
}

function enrollment(id, planId, examTrack = null, extra = {}) {
  return {
    id,
    user_id: "user-1",
    plan_id: planId,
    status: "active",
    access_granted: true,
    access_expires_at: future,
    ...(examTrack ? { exam_track_id: examTrack } : {}),
    ...extra,
  };
}

test("all supported exam aliases converge at the shell and registry boundary", () => {
  const cases = [
    ["USMLE Step 1", "usmle_step_1", "usmle-step-1"],
    ["step 2 ck", "usmle_step_2_ck", "usmle-step-2"],
    ["usmle_step_3", "usmle_step_3", "usmle-step-3"],
    ["PLAB", "plab", "plab"],
    ["AMC", "amc", "amc"],
    ["MCCQE", "mccqe", "mccqe"],
    ["NCLEX", "nclex", "nclex"],
  ];
  for (const [input, shellId, registryId] of cases) {
    assert.equal(normalizeAylaShellExamTrack(input), shellId);
    assert.equal(normalizeAylaRegistryExamTrack(input), registryId);
  }
  assert.equal(normalizeAylaShellExamTrack("unknown-board"), null);
  assert.equal(normalizeAylaRegistryExamTrack(""), null);
});

test("exam-scoped enrollment IDs cannot overwrite another exam enrollment", () => {
  const step1 = aylaScopedEnrollmentKey("user-1", "monthly", "paid", "USMLE Step 1");
  const nclex = aylaScopedEnrollmentKey("user-1", "monthly", "paid", "NCLEX");
  assert.equal(step1, "ayla:user-1:monthly:paid:usmle_step_1");
  assert.equal(nclex, "ayla:user-1:monthly:paid:nclex");
  assert.notEqual(step1, nclex);
  assert.equal(aylaScopedEnrollmentKey("user-1", "monthly", "paid"), "ayla:user-1:monthly:paid");
  assert.throws(() => aylaScopedEnrollmentKey("user-1", "monthly", "paid", "not-an-exam"));
});

test("one user receives isolated paid dashboards for two entitled exams", () => {
  const shell = resolveAylaStudentShell({
    userId: "user-1",
    students: [student("step-1-student", "usmle_step_1"), student("nclex-student", "nclex")],
    enrollments: [
      enrollment("step-1-paid", "full", "usmle_step_1", { student_id: "step-1-student" }),
      enrollment("nclex-paid", "full", "nclex", { student_id: "nclex-student" }),
    ],
    plansById: plans,
    activeStudentId: "step-1-student",
    now,
  });
  assert.equal(shell.dashboards.length, 2);
  assert.deepEqual(shell.dashboards.map((row) => row.exam_track_id), ["nclex", "usmle_step_1"]);
  assert.equal(shell.active_student_id, "step-1-student");
  assert.equal(shell.can_switch, true);
  assert.equal(shell.dashboards.every((row) => row.navigation.every((item) => item.path.startsWith(`/app/exams/${row.exam_track_id}/`))), true);
});

test("paid access is authoritative and demo access cannot add a disabled feature", () => {
  const enrollments = [
    enrollment("demo-access", "demo", "usmle_step_1", { is_demo: true, updatedAt: "2026-07-19T11:00:00.000Z" }),
    enrollment("paid-access", "roadmap", "usmle_step_1", { updatedAt: "2026-07-19T10:00:00.000Z" }),
  ];
  const qbank = resolveAylaExamFeatureEntitlement({ enrollments, plansById: plans, userId: "user-1", requestedExamTrack: "usmle_step_1", feature: "qbank", now });
  assert.equal(qbank.allowed, false);
  assert.equal(qbank.reason, "feature_not_included");
  assert.equal(qbank.entitlement_type, "paid");
  assert.equal(qbank.enrollment_id, "paid-access");
});

test("legacy unscoped access binds only to the selected profile", () => {
  const students = [student("step-1-student", "usmle_step_1"), student("nclex-student", "nclex")];
  const enrollments = [enrollment("legacy-paid", "full")];
  const shell = resolveAylaStudentShell({ userId: "user-1", students, enrollments, plansById: plans, activeStudentId: "step-1-student", now });
  assert.deepEqual(shell.dashboards.map((row) => row.exam_track_id), ["usmle_step_1"]);

  const tampered = resolveAylaStudentShell({
    userId: "user-1",
    students,
    enrollments,
    plansById: plans,
    activeStudentId: "step-1-student",
    requestedStudentId: "nclex-student",
    requestedExamTrack: "nclex",
    now,
  });
  assert.equal(tampered.active_dashboard, null);
  assert.equal(tampered.denied_reason, "no_active_exam_entitlement");
});

test("an explicit entitlement creates a setup-required dashboard without inventing a profile", () => {
  const shell = resolveAylaStudentShell({
    userId: "user-1",
    students: [],
    enrollments: [enrollment("nclex-paid", "full", "nclex")],
    plansById: plans,
    now,
  });
  assert.equal(shell.dashboards.length, 1);
  assert.equal(shell.active_dashboard.profile_status, "setup_required");
  assert.equal(shell.active_dashboard.student_id, null);
});

test("invalid exams, foreign students, and student/exam mismatches never fall back", () => {
  const students = [student("step-1-student", "usmle_step_1"), student("nclex-student", "nclex")];
  const enrollments = [
    enrollment("step-1-paid", "full", "usmle_step_1", { student_id: "step-1-student" }),
    enrollment("nclex-paid", "full", "nclex", { student_id: "nclex-student" }),
  ];
  const base = { userId: "user-1", students, enrollments, plansById: plans, activeStudentId: "step-1-student", now };
  assert.equal(resolveAylaStudentShell({ ...base, requestedExamTrack: "made-up-exam" }).denied_reason, "invalid_exam_track");
  assert.equal(resolveAylaStudentShell({ ...base, requestedStudentId: "foreign-student" }).denied_reason, "student_not_owned");
  assert.equal(resolveAylaStudentShell({ ...base, requestedStudentId: "step-1-student", requestedExamTrack: "nclex" }).denied_reason, "student_exam_mismatch");
});

test("an enrollment scoped to one profile cannot be borrowed by another profile on the same exam", () => {
  const students = [
    student("entitled-profile", "usmle_step_1", "2026-07-19T09:00:00.000Z"),
    student("other-profile", "usmle_step_1", "2026-07-19T11:00:00.000Z"),
  ];
  const shell = resolveAylaStudentShell({
    userId: "user-1",
    students,
    enrollments: [enrollment("scoped", "full", "usmle_step_1", { student_id: "entitled-profile" })],
    plansById: plans,
    activeStudentId: "other-profile",
    requestedStudentId: "other-profile",
    requestedExamTrack: "usmle_step_1",
    now,
  });
  assert.equal(shell.dashboards[0].student_id, "entitled-profile");
  assert.equal(shell.active_dashboard, null);
  assert.equal(shell.denied_reason, "no_active_exam_entitlement");

  const directAccess = resolveAylaExamFeatureEntitlement({
    enrollments: [enrollment("scoped", "full", "usmle_step_1", { student_id: "entitled-profile" })],
    plansById: plans,
    userId: "user-1",
    requestedExamTrack: "usmle_step_1",
    legacyExamTrack: "usmle_step_1",
    legacyStudentId: "other-profile",
    enforceStudentScope: true,
    now,
  });
  assert.equal(directAccess.allowed, false);
  assert.equal(directAccess.reason, "no_active_exam_entitlement");
});

test("feature navigation is deterministic and disabled routes stay visible but locked", () => {
  const shell = resolveAylaStudentShell({
    userId: "user-1",
    students: [student("step-1-student", "usmle_step_1")],
    enrollments: [enrollment("roadmap-paid", "roadmap", "usmle_step_1")],
    plansById: plans,
    activeStudentId: "step-1-student",
    now,
  });
  const dashboard = shell.active_dashboard;
  assert.deepEqual(dashboard.navigation.map((item) => item.key), AYLA_STUDENT_FEATURES.map((item) => item.key));
  assert.equal(dashboard.features.roadmap, true);
  assert.equal(dashboard.features.progress, true);
  assert.equal(dashboard.features.qbank, false);
  assert.equal(dashboard.navigation.find((item) => item.key === "qbank").reason, "feature_not_included");
});

test("non-navigation setup features can still be enforced by the same entitlement contract", () => {
  const access = resolveAylaExamFeatureEntitlement({
    enrollments: [enrollment("setup", "setup-plan", "nclex")],
    plansById: { "setup-plan": { id: "setup-plan", included_features: ["diagnostic"] } },
    userId: "user-1",
    requestedExamTrack: "nclex",
    feature: "diagnostic",
    now,
  });
  assert.equal(access.allowed, true);
});

test("server integration keeps v206 and v207 additive while routing v208 through one guard", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /const AYLA_BACKEND_BUILD = "aylamed-safe-shared-student-profile-v219"/);
  assert.match(server, /schema_version: 15/);
  assert.match(server, /app\.get\("\/api\/ayla\/shell"/);
  assert.match(server, /app\.post\("\/api\/ayla\/shell\/switch"/);
  assert.match(server, /function aylaV189RequireStudent[\s\S]*?aylaDashboardEntitlement\(db, auth\.user, student/);
  assert.match(server, /function aylaEnrollmentKey[\s\S]*?aylaScopedEnrollmentKey\(userId, planId, type, examTrack\)/);
  assert.match(server, /aylaExamTrackId: pendingEnrollment\.exam_track_id/);
  assert.match(server, /preserveActiveDuringCheckout[\s\S]*?aylaId\("AYLA-ENR-PENDING"\)/);
  assert.match(server, /exam_identity_immutable/);
  assert.match(server, /role: "student"[\s\S]*?studentId: null[\s\S]*?activeExamTrackId: null/);
  assert.match(server, /function aylaBindLegacyEnrollmentScopes[\s\S]*?legacy_bound_from_unscoped = true/);
  assert.match(server, /app\.post\("\/api\/ayla\/shell\/switch"[\s\S]*?aylaBindLegacyEnrollmentScopes/);
  assert.match(server, /function aylaV189RequireStudent[\s\S]*?aylaBindLegacyEnrollmentScopes/);

  const authMe = server.slice(server.indexOf('app.get("/api/ayla/auth/me"'), server.indexOf('app.post("/api/ayla/auth/update-password"'));
  assert.match(authMe, /aylaCurrentStudentShell/);
  assert.doesNotMatch(authMe, /sort\(\(a, b\).*updatedAt/);

  const dashboard = server.slice(server.indexOf('app.get("/api/ayla/students/:id/dashboard"'), server.indexOf('app.post("/api/ayla/generate-roadmap"'));
  assert.match(dashboard, /aylaV189RequireStudent/);
  assert.match(dashboard, /dashboardAccess/);

  assert.match(server, /registry_backed_qbank_catalog: true/);
  assert.match(server, /flashcardCapabilities\("aylamed"\)/);
  assert.match(server, /lms_crm_operational_writes: false/);
});
