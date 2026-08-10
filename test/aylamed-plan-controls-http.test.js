import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function passwordRecord(password, salt = "plancontrols1234plancontrols1234") {
  return { salt, password_hash: crypto.pbkdf2Sync(password, salt, 120000, 64, "sha512").toString("hex") };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl, child, output, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Server exited (${child.exitCode})\n${output.join("")}`);
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Health timeout\n${output.join("")}`);
}

async function api(baseUrl, route, { method = "GET", token = "", adminToken = "", body = null } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(adminToken ? { "x-ayla-admin-token": adminToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`${method} ${route} returned ${response.status}: ${text.slice(0, 500)}`); }
  return { response, payload };
}

test("v215 applies live plan/demo matrices without rewriting enrollments or learning history", { timeout: 50000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aylamed-v215-http-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const crmPath = path.join(dataDir, "crm-db.json");
  const aylaPath = path.join(dataDir, "aylamed-db.json");
  const password = "PlanControls9!";
  const adminToken = "v215-admin-token";
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 365 * 86400000).toISOString();
  const demoStart = new Date(Date.now() - 86400000).toISOString();
  const oldDemoExpiry = new Date(Date.now() + 6 * 86400000).toISOString();
  const liveSentinel = JSON.stringify({ sentinel: "lms-untouched-v215" }, null, 2);
  const crmSentinel = JSON.stringify({ sentinel: "crm-untouched-v215", ai_training_documents: [], ai_training_items: [] }, null, 2);
  const aylaDb = {
    schema_version: 9,
    aylaSettings: {
      product: { monthly_only: true, product_name: "AylaMed" },
      demo: { enabled: true, duration_days: 7, homepage_bar_enabled: true, homepage_bar_text: "Try {{days}} days", button_text: "Start Demo", plan_name: "AylaMed {{days}}-Day Demo", description: "Demo access", included_features: ["diagnostic", "personal_tutor"] },
    },
    aylaUsers: {
      "user-1": { id: "user-1", email: "plans@example.com", name: "Plan Doctor", role: "student", status: "active", studentId: "student-1", activeExamTrackId: "usmle_step_1", authVersion: 1, ...passwordRecord(password), createdAt: now, updatedAt: now },
    },
    aylaStudents: {
      "student-1": { id: "student-1", ayla_user_id: "user-1", user_id: "user-1", name: "Plan Doctor", examTrackId: "usmle_step_1", exam: "USMLE Step 1", createdAt: now, updatedAt: now },
    },
    aylaPlans: {
      paid: { id: "paid", name: "Paid Matrix", plan_type: "monthly", billing_type: "subscription_monthly", included_features: ["roadmap", "qbank"], exam_tracks: ["usmle_step_1"], is_full_access: false, is_active: true, is_public: true, feature_matrix_version: 1, createdAt: now, updatedAt: now },
      "AYLA-PLAN-DEMO": { id: "AYLA-PLAN-DEMO", name: "Demo", plan_type: "demo", billing_type: "free", is_demo: true, included_features: ["diagnostic", "personal_tutor"], exam_tracks: ["usmle_step_1"], is_active: true, is_public: true, access_days: 7, feature_matrix_version: 1, createdAt: now, updatedAt: now },
      "archive-me": { id: "archive-me", name: "Archive Me", plan_type: "monthly", billing_type: "subscription_monthly", included_features: ["qbank"], exam_tracks: ["usmle_step_1"], is_active: true, is_public: true, feature_matrix_version: 1, createdAt: now, updatedAt: now },
    },
    aylaEnrollments: {
      paid: { id: "paid", user_id: "user-1", student_id: "student-1", plan_id: "paid", exam_track_id: "usmle_step_1", type: "paid", status: "active", access_granted: true, access_starts_at: now, access_expires_at: future, included_features: ["roadmap", "personal_tutor", "content_hub"], is_full_access: true, createdAt: now, updatedAt: now },
      demo: { id: "demo", user_id: "user-1", student_id: "student-1", plan_id: "AYLA-PLAN-DEMO", exam_track_id: "usmle_step_1", type: "demo", is_demo: true, status: "active", access_granted: true, access_starts_at: demoStart, access_expires_at: oldDemoExpiry, included_features: ["personal_tutor"], createdAt: now, updatedAt: now },
    },
    aylaQuestionAttempts: {
      history: { id: "history", studentId: "student-1", serverVerified: true, outcome: "incorrect", system: "Cardiovascular", topic: "Perfusion", createdAt: now },
    },
  };
  const originalPaidEnrollment = structuredClone(aylaDb.aylaEnrollments.paid);
  await fs.writeFile(livePath, liveSentinel);
  await fs.writeFile(crmPath, crmSentinel);
  await fs.writeFile(aylaPath, JSON.stringify(aylaDb));

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
    env: {
      ...process.env,
      PORT: String(port), DATA_DIR: dataDir, AYLA_ADMIN_TOKEN: adminToken,
      AYLA_AUTH_JWT_SECRET: "v215-ayla-secret", AUTH_JWT_SECRET: "v215-lms-secret",
      NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false", ZOOM_RECORDING_RECOVERY_ENABLED: "false", NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED: "false",
      DATABASE_URL: "", OPENAI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    await waitForHealth(baseUrl, child, output);
    const login = await api(baseUrl, "/api/ayla/auth/login", { method: "POST", body: { email: "plans@example.com", password } });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    const token = login.payload.token;

    const beforeShell = await api(baseUrl, "/api/ayla/shell", { token });
    assert.equal(beforeShell.response.status, 200, JSON.stringify(beforeShell.payload));
    assert.equal(beforeShell.payload.activeDashboard.entitlement.type, "paid");
    assert.equal(beforeShell.payload.activeDashboard.features.roadmap, true);
    assert.equal(beforeShell.payload.activeDashboard.features.qbank, true);
    assert.equal(beforeShell.payload.activeDashboard.features.personal_tutor, false);
    assert.equal(beforeShell.payload.activeDashboard.features.content_hub, false);

    const globalTestingBefore = await api(baseUrl, "/api/ayla/admin/global-testing-access", { adminToken });
    assert.equal(globalTestingBefore.response.status, 200, JSON.stringify(globalTestingBefore.payload));
    assert.equal(globalTestingBefore.payload.access.enabled, false);
    assert.equal(globalTestingBefore.payload.access.student_count, 1);
    assert.equal(globalTestingBefore.payload.access.feature_count, 13);

    const globalTestingEnabled = await api(baseUrl, "/api/ayla/admin/global-testing-access", {
      method: "POST", adminToken,
      body: { action: "enable", expected_student_count: 1, confirmation: "ENABLE_ALL_AYLAMED_FEATURES_1" },
    });
    assert.equal(globalTestingEnabled.response.status, 200, JSON.stringify(globalTestingEnabled.payload));
    assert.equal(globalTestingEnabled.payload.access.enabled, true);
    assert.equal(globalTestingEnabled.payload.access.plans_changed, 0);
    assert.equal(globalTestingEnabled.payload.access.enrollments_changed, 0);

    const globalTestingShell = await api(baseUrl, "/api/ayla/shell", { token });
    assert.equal(globalTestingShell.response.status, 200, JSON.stringify(globalTestingShell.payload));
    assert.equal(Object.values(globalTestingShell.payload.activeDashboard.features).every(Boolean), true);
    assert.equal(globalTestingShell.payload.activeDashboard.entitlement.type, "testing");

    const globalTestingDisabled = await api(baseUrl, "/api/ayla/admin/global-testing-access", {
      method: "POST", adminToken,
      body: { action: "disable", expected_student_count: 1, confirmation: "DISABLE_ALL_AYLAMED_FEATURES_1" },
    });
    assert.equal(globalTestingDisabled.response.status, 200, JSON.stringify(globalTestingDisabled.payload));
    assert.equal(globalTestingDisabled.payload.access.enabled, false);
    const afterGlobalTesting = await api(baseUrl, "/api/ayla/shell", { token });
    assert.equal(afterGlobalTesting.payload.activeDashboard.features.personal_tutor, false);
    assert.equal(afterGlobalTesting.payload.activeDashboard.features.content_hub, false);

    const unauthenticated = await api(baseUrl, "/api/ayla/plans/paid", { method: "PUT", body: { included_features: ["roadmap", "qbank", "leaderboard"] } });
    assert.equal(unauthenticated.response.status, 401, JSON.stringify(unauthenticated.payload));

    const matrix = await api(baseUrl, "/api/ayla/admin/plan-feature-matrix", { adminToken });
    assert.equal(matrix.response.status, 200, JSON.stringify(matrix.payload));
    assert.equal(matrix.payload.featureCatalog.length, 14);
    assert.equal(matrix.payload.controls.plan_is_live_feature_authority, true);
    assert.equal(matrix.payload.plans.find((row) => row.plan_id === "paid").features.personal_tutor, false);

    const publicConfig = await api(baseUrl, "/api/ayla/public-config");
    assert.equal(publicConfig.response.status, 200, JSON.stringify(publicConfig.payload));
    assert.equal(publicConfig.payload.plans.some((plan) => plan.id === "paid"), true);
    assert.equal(publicConfig.payload.plans.some((plan) => plan.id === "archive-me"), true);

    const compatiblePlanUpdate = await api(baseUrl, "/api/ayla/plans/archive-me", {
      method: "PUT", adminToken,
      body: { expected_feature_matrix_version: 1, feature_overrides: { leaderboard: true } },
    });
    assert.equal(compatiblePlanUpdate.response.status, 200, JSON.stringify(compatiblePlanUpdate.payload));
    assert.equal(compatiblePlanUpdate.payload.plan.feature_matrix_version, 2);
    assert.deepEqual(compatiblePlanUpdate.payload.plan.included_features, ["qbank", "leaderboard"]);

    const changed = await api(baseUrl, "/api/ayla/admin/plans/paid/features", {
      method: "PUT", adminToken,
      body: { expected_feature_matrix_version: 1, feature_overrides: { roadmap: false, personal_tutor: true } },
    });
    assert.equal(changed.response.status, 200, JSON.stringify(changed.payload));
    assert.equal(changed.payload.plan.feature_matrix_version, 2);
    assert.equal(changed.payload.plan.features.roadmap, false);
    assert.equal(changed.payload.plan.features.personal_tutor, true);
    assert.equal(changed.payload.impact.enrollment_records_changed_by_feature_update, 0);

    const afterShell = await api(baseUrl, "/api/ayla/shell", { token });
    assert.equal(afterShell.response.status, 200, JSON.stringify(afterShell.payload));
    assert.equal(afterShell.payload.activeDashboard.features.roadmap, false);
    assert.equal(afterShell.payload.activeDashboard.features.qbank, true);
    assert.equal(afterShell.payload.activeDashboard.features.personal_tutor, true);
    assert.equal(afterShell.payload.activeDashboard.features.content_hub, false);

    const stale = await api(baseUrl, "/api/ayla/admin/plans/paid/features", { method: "PUT", adminToken, body: { expected_feature_matrix_version: 1, included_features: ["qbank"] } });
    assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));
    assert.equal(stale.payload.details.code, "STALE_PLAN_FEATURE_MATRIX");
    assert.equal(stale.payload.details.current_feature_matrix_version, 2);
    const unknown = await api(baseUrl, "/api/ayla/admin/plans/paid/features", { method: "PUT", adminToken, body: { expected_feature_matrix_version: 2, feature_overrides: { invented_feature: true } } });
    assert.equal(unknown.response.status, 400, JSON.stringify(unknown.payload));
    assert.equal(unknown.payload.details.code, "UNKNOWN_PLAN_FEATURE");

    const demoChanged = await api(baseUrl, "/api/ayla/admin/demo-controls", {
      method: "PUT", adminToken,
      body: { expected_feature_matrix_version: 1, duration_days: 14, included_features: ["diagnostic", "roadmap"], apply_to_active_enrollments: false },
    });
    assert.equal(demoChanged.response.status, 200, JSON.stringify(demoChanged.payload));
    assert.equal(demoChanged.payload.plan.feature_matrix_version, 2);
    assert.equal(demoChanged.payload.demo.duration_days, 14);
    assert.equal(demoChanged.payload.existing_demo_enrollments_adjusted, 0);
    let stored = JSON.parse(await fs.readFile(aylaPath, "utf8"));
    assert.equal(stored.aylaEnrollments.demo.access_expires_at, oldDemoExpiry);

    const demoApplied = await api(baseUrl, "/api/ayla/admin/demo-controls", {
      method: "PUT", adminToken,
      body: { expected_feature_matrix_version: 2, duration_days: 10, apply_to_active_enrollments: true },
    });
    assert.equal(demoApplied.response.status, 200, JSON.stringify(demoApplied.payload));
    assert.equal(demoApplied.payload.plan.feature_matrix_version, 3);
    assert.equal(demoApplied.payload.existing_demo_enrollments_adjusted, 1);
    stored = JSON.parse(await fs.readFile(aylaPath, "utf8"));
    assert.notEqual(stored.aylaEnrollments.demo.access_expires_at, oldDemoExpiry);

    const invalidDemo = await api(baseUrl, "/api/ayla/admin/demo-controls", { method: "PUT", adminToken, body: { expected_feature_matrix_version: 3, duration_days: 100 } });
    assert.equal(invalidDemo.response.status, 400, JSON.stringify(invalidDemo.payload));
    assert.equal(invalidDemo.payload.details.code, "INVALID_DEMO_DURATION");

    const archived = await api(baseUrl, "/api/ayla/plans/archive-me", { method: "DELETE", adminToken });
    assert.equal(archived.response.status, 200, JSON.stringify(archived.payload));
    assert.equal(archived.payload.deleted, false);
    assert.equal(archived.payload.history_preserved, true);

    const publicPlans = await api(baseUrl, "/api/ayla/plans");
    assert.equal(publicPlans.response.status, 200, JSON.stringify(publicPlans.payload));
    assert.equal(publicPlans.payload.aylaPlans.some((plan) => plan.id === "archive-me"), false);
    assert.equal(publicPlans.payload.aylaPlans.every((plan) => Object.keys(plan.feature_matrix || {}).length === 14), true);

    stored = JSON.parse(await fs.readFile(aylaPath, "utf8"));
    assert.deepEqual(stored.aylaEnrollments.paid, originalPaidEnrollment);
    assert.ok(stored.aylaPlans["archive-me"]);
    assert.equal(stored.aylaPlans["archive-me"].status, "archived");
    assert.ok(stored.aylaQuestionAttempts.history);
    assert.ok(Object.values(stored.aylaActionLogs || {}).some((row) => row.type === "plan_feature_matrix"));
    assert.equal(await fs.readFile(livePath, "utf8"), liveSentinel);
    assert.equal(await fs.readFile(crmPath, "utf8"), crmSentinel);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
