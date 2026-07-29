import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  applyAylaPlanFeaturePatch,
  aylaPlanFeatureMatrixRow,
  normalizeAylaPlanFeature,
  normalizeAylaPlanFeatures,
  publicAylaPlanFeatureCatalog,
} from "../lib/aylamed-plan-controls.js";
import { resolveAylaExamFeatureEntitlement, resolveAylaStudentShell } from "../lib/aylamed-student-shell.js";

const future = "2099-01-01T00:00:00.000Z";

test("legacy feature names converge to one canonical plan feature", () => {
  assert.equal(normalizeAylaPlanFeature("AI Coach"), "personal_tutor");
  assert.equal(normalizeAylaPlanFeature("weak-areas"), "revision");
  assert.equal(normalizeAylaPlanFeature("knowledge_search"), "library");
  assert.deepEqual(normalizeAylaPlanFeatures(["roadmap", "weak_areas", "ai_coach", "knowledge_search"]).features, ["roadmap", "personal_tutor", "library", "revision"]);
  assert.equal(publicAylaPlanFeatureCatalog().length, 14);
});

test("feature patches replace or toggle a matrix and reject unknown controls", () => {
  const plan = { id: "paid", included_features: ["roadmap", "qbank"], is_full_access: false };
  assert.deepEqual(applyAylaPlanFeaturePatch(plan, { feature_overrides: { roadmap: false, personal_tutor: true } }), {
    included_features: ["personal_tutor", "qbank"],
    is_full_access: false,
  });
  const full = applyAylaPlanFeaturePatch(plan, { is_full_access: true });
  assert.equal(full.is_full_access, true);
  assert.equal(full.included_features.length, 14);
  assert.throws(() => applyAylaPlanFeaturePatch(plan, { feature_overrides: { invented_feature: true } }), (error) => error.code === "UNKNOWN_PLAN_FEATURE");
});

test("matrix rows expose every control with deterministic versioning", () => {
  const row = aylaPlanFeatureMatrixRow({ id: "demo", name: "Demo", plan_type: "demo", is_demo: true, included_features: ["diagnostic", "roadmap"], feature_matrix_version: 4 });
  assert.equal(row.feature_matrix_version, 4);
  assert.equal(row.features.diagnostic, true);
  assert.equal(row.features.roadmap, true);
  assert.equal(row.features.qbank, false);
  assert.equal(Object.keys(row.features).length, 14);
});

test("stored plan controls override stale enrollment feature snapshots", () => {
  const enrollment = { id: "enrollment", user_id: "user-1", plan_id: "paid", exam_track_id: "usmle_step_1", student_id: "student-1", access_granted: true, access_expires_at: future, included_features: ["roadmap", "personal_tutor"], is_full_access: true };
  const plan = { id: "paid", included_features: ["qbank"], is_full_access: false };
  const denied = resolveAylaExamFeatureEntitlement({ enrollments: [enrollment], plansById: { paid: plan }, userId: "user-1", requestedExamTrack: "usmle_step_1", legacyExamTrack: "usmle_step_1", legacyStudentId: "student-1", feature: "roadmap" });
  const allowed = resolveAylaExamFeatureEntitlement({ enrollments: [enrollment], plansById: { paid: plan }, userId: "user-1", requestedExamTrack: "usmle_step_1", legacyExamTrack: "usmle_step_1", legacyStudentId: "student-1", feature: "qbank" });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "feature_not_included");
  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.enabled_features, ["qbank"]);
});

test("ambiguous legacy aliases no longer unlock several navigation screens", () => {
  const shell = resolveAylaStudentShell({
    userId: "user-1",
    students: [{ id: "student-1", ayla_user_id: "user-1", examTrackId: "usmle_step_1" }],
    enrollments: [{ id: "enrollment", user_id: "user-1", plan_id: "legacy", exam_track_id: "usmle_step_1", student_id: "student-1", access_granted: true, access_expires_at: future }],
    plansById: { legacy: { id: "legacy", included_features: ["knowledge_search", "roadmap"] } },
    activeStudentId: "student-1",
  });
  assert.equal(shell.active_dashboard.features.library, true);
  assert.equal(shell.active_dashboard.features.roadmap, true);
  assert.equal(shell.active_dashboard.features.content_hub, false);
  assert.equal(shell.active_dashboard.features.dynamic_notebook, false);
  assert.equal(shell.active_dashboard.features.progress, false);
});

test("server protects plan writes and exposes atomic feature/demo control routes", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /const NEXTGEN_BACKEND_BUILD = "v219-safe-shared-student-profile"/);
  assert.match(server, /const AYLA_BACKEND_BUILD = "aylamed-safe-shared-student-profile-v219"/);
  assert.match(server, /schema_version: 14/);
  assert.match(server, /app\.get\("\/api\/ayla\/admin\/plan-feature-matrix"/);
  assert.match(server, /app\.put\("\/api\/ayla\/admin\/plans\/:planId\/features"/);
  assert.match(server, /app\.put\("\/api\/ayla\/admin\/demo-controls"/);
  assert.match(server, /STALE_PLAN_FEATURE_MATRIX/);
  const crud = server.slice(server.indexOf("function aylaRegisterCrud"), server.indexOf("for (const [collectionKey"));
  assert.match(crud, /app\.put[\s\S]*?await aylaRequireAdmin\(req\)/);
  assert.match(crud, /Archived AylaMed plan without deleting enrollment history/);
});
