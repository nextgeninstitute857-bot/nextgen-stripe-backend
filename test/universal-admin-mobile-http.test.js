import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function passwordRecord(password, salt = "universaladminmobiletestsalt12") {
  return {
    salt,
    password_hash: crypto.pbkdf2Sync(password, salt, 120000, 64, "sha512").toString("hex"),
  };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child, output, timeoutMs = 70_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Server exited (${child.exitCode})\n${output.join("")}`);
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Health timeout\n${output.join("")}`);
}

async function api(baseUrl, route, { method = "GET", token = "", body = null } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, payload: await response.json() };
}

test("universal admin dashboard keeps LMS open and grants private minute-level AylaMed access", { timeout: 100_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "universal-admin-mobile-"));
  const now = new Date();
  const nowIso = now.toISOString();
  const oldIso = new Date(now.getFullYear(), now.getMonth() - 2, 10).toISOString();
  const futureIso = new Date(Date.now() + 95 * 86400000).toISOString();
  const today = nowIso.slice(0, 10);
  const adminEmail = "mobile-admin@example.com";
  const adminPassword = "MobileAdmin9!";

  await fs.writeFile(path.join(dataDir, "live-session-db.json"), JSON.stringify({
    users: {
      admin: { id: "admin", email: adminEmail, name: "Mobile Admin", role: "admin", verified: true, ...passwordRecord(adminPassword), created_at: nowIso, updated_at: nowIso },
      recurring: { id: "recurring", email: "recurring@example.com", name: "Recurring Student", role: "student", verified: true, ...passwordRecord("Recurring9!"), created_at: nowIso, updated_at: nowIso },
      manual: { id: "manual", email: "manual@example.com", name: "Manual Student", role: "student", verified: true, ...passwordRecord("ManualUser9!"), created_at: nowIso, updated_at: nowIso },
    },
    courses: { course: { id: "course", name: "USMLE Live", status: "active", is_active: true } },
    plans: {
      monthly: { id: "monthly", name: "Four Month Plan", billing_type: "subscription_monthly", price_cents: 12500, access_days: 120, is_active: true, course_id: "course" },
      once: { id: "once", name: "One Time", billing_type: "one_time", price_cents: 30000, access_days: 120, is_active: true, course_id: "course" },
    },
    enrollments: {
      recurring: { id: "recurring", user_id: "recurring", course_id: "course", plan_id: "monthly", access_granted: true, access_expires_at: futureIso, stripe_subscription_id: "sub_lms_1", subscription_status: "active", is_demo: false, created_at: nowIso },
      manual: { id: "manual", user_id: "manual", course_id: "course", plan_id: "monthly", access_granted: true, access_expires_at: futureIso, is_demo: false, source: "manual", created_at: nowIso },
    },
    payments: {
      currentSubscription: { id: "currentSubscription", user_id: "recurring", plan_id: "monthly", amount_cents: 12500, payment_status: "completed", stripe_subscription_id: "sub_lms_1", paid_at: nowIso },
      currentOneTime: { id: "currentOneTime", user_id: "manual", plan_id: "once", amount_cents: 30000, payment_status: "completed", paid_at: nowIso },
      oldPayment: { id: "oldPayment", user_id: "manual", plan_id: "once", amount_cents: 9000, payment_status: "completed", paid_at: oldIso },
    },
    liveSessions: { today: { id: "today", course_id: "course", topic: "Cardiology Day 1", scheduled_date: today, scheduled_time: "13:00", timezone: "America/New_York", status: "scheduled", zoom_meeting_id: "123456789" } },
    roadmaps: { course: { id: "roadmap", course_id: "course", days: [{ id: "day-1", date: today, title: "Cardiology Day 1", live_session_id: "today", status: "scheduled" }] } },
    notes: { today: { id: "note-today", session_id: "today", cleaned_notes: "Published notes", published: true, updated_at: nowIso } },
    recordings: {},
  }));

  await fs.writeFile(path.join(dataDir, "crm-db.json"), JSON.stringify({ ai_training_documents: [], ai_training_items: [] }));
  await fs.writeFile(path.join(dataDir, "aylamed-db.json"), JSON.stringify({
    schema_version: 15,
    aylaUsers: { aylaRecurring: { id: "aylaRecurring", email: "ayla@example.com", name: "Ayla Student", role: "student", status: "active", authVersion: 1, ...passwordRecord("AylaUser9!"), createdAt: nowIso, updatedAt: nowIso } },
    aylaPlans: { aylaMonthly: { id: "aylaMonthly", name: "Ayla Monthly", plan_type: "monthly", billing_type: "subscription_monthly", price_cents: 5000, access_days: 30, is_active: true, is_public: true, is_full_access: true, included_features: [] } },
    aylaEnrollments: { aylaEnrollment: { id: "aylaEnrollment", user_id: "aylaRecurring", ayla_user_id: "aylaRecurring", plan_id: "aylaMonthly", access_granted: true, status: "active", stripe_subscription_id: "sub_ayla_1", subscription_status: "active", access_expires_at: futureIso, createdAt: nowIso } },
    aylaPayments: { aylaPayment: { id: "aylaPayment", user_id: "aylaRecurring", plan_id: "aylaMonthly", amount_cents: 5000, payment_status: "completed", paid_at: nowIso } },
  }));

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      AUTH_JWT_SECRET: "universal-admin-mobile-secret",
      AYLA_AUTH_JWT_SECRET: "universal-admin-mobile-ayla-secret",
      DATABASE_URL: "",
      OPENAI_API_KEY: "",
      NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false",
      ZOOM_RECORDING_RECOVERY_ENABLED: "false",
      NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    await waitForHealth(baseUrl, child, output);
    const login = await api(baseUrl, "/auth/login", { method: "POST", body: { email: adminEmail, password: adminPassword } });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    const token = login.payload.token;

    const blockedAylaSignup = await api(baseUrl, "/api/ayla/auth/register", {
      method: "POST",
      body: { email: "blocked@example.com", password: "BlockedUser9!" },
    });
    assert.equal(blockedAylaSignup.response.status, 403, JSON.stringify(blockedAylaSignup.payload));

    const publicConfig = await api(baseUrl, "/api/ayla/public-config");
    assert.equal(publicConfig.response.status, 200, JSON.stringify(publicConfig.payload));
    assert.equal(publicConfig.payload.admission_mode, "admin_only");
    assert.equal(publicConfig.payload.google_client_id, "");
    assert.equal(publicConfig.payload.settings.demo.enabled, false);
    assert.equal(publicConfig.payload.plans.some((plan) => plan.is_demo), false);

    const dashboard = await api(baseUrl, "/admin/mobile/dashboard", { token });
    assert.equal(dashboard.response.status, 200, JSON.stringify(dashboard.payload));
    assert.equal(dashboard.payload.lms.revenue.monthly_sales_cents, 42500);
    assert.equal(dashboard.payload.lms.revenue.recurring_subscribers, 1, "manual monthly access must not be called a subscription");
    assert.equal(dashboard.payload.lms.revenue.monthly_recurring_revenue_cents, 12500);
    assert.equal(dashboard.payload.aylamed.revenue.monthly_sales_cents, 5000);
    assert.equal(dashboard.payload.aylamed.revenue.recurring_subscribers, 1);
    assert.equal(dashboard.payload.combined.monthly_recurring_revenue_cents, 17500);
    assert.equal(dashboard.payload.lms.today_sessions[0].roadmap_day.id, "day-1");
    assert.equal(dashboard.payload.lms.today_sessions[0].notes_check.published, true);
    assert.equal(dashboard.payload.lms.today_sessions[0].recording_check.exists, false);

    const invite = await api(baseUrl, "/admin/mobile/invitations", {
      method: "POST",
      token,
      body: { product: "lms", email: "invited@example.com", name: "Invited Student", course_id: "course", plan_id: "once", access_days: 45, send_email: false },
    });
    assert.equal(invite.response.status, 201, JSON.stringify(invite.payload));
    assert.equal(invite.payload.results[0].student_created, true);
    assert.equal(invite.payload.results[0].user.must_change_password, true);
    assert.equal(invite.payload.results[0].enrollment.access_days, 45);
    const expiryMs = new Date(invite.payload.results[0].enrollment.access_expires_at).getTime();
    assert.ok(expiryMs > Date.now() + 44 * 86400000 && expiryMs < Date.now() + 46 * 86400000);

    const aylaInvite = await api(baseUrl, "/admin/mobile/invitations", {
      method: "POST",
      token,
      body: { product: "aylamed", email: "ayla-invited@example.com", name: "Ayla Invited", ayla_plan_id: "aylaMonthly", access_duration: 5, access_unit: "minutes", amount: 12.5, send_email: false },
    });
    assert.equal(aylaInvite.response.status, 201, JSON.stringify(aylaInvite.payload));
    assert.equal(aylaInvite.payload.results[0].user.mustChangePassword, true);
    const aylaInvitation = aylaInvite.payload.results[0];
    assert.equal(aylaInvitation.enrollment.access_duration, "5 minutes");
    assert.equal(aylaInvitation.enrollment.recorded_amount_cents, 1250);
    assert.equal(aylaInvitation.payment.amount_cents, 1250);
    const fiveMinuteExpiry = new Date(aylaInvitation.enrollment.access_expires_at).getTime();
    assert.ok(fiveMinuteExpiry > Date.now() + 4 * 60000 && fiveMinuteExpiry < Date.now() + 6 * 60000);

    const existingStudentInvite = await api(baseUrl, "/admin/mobile/invitations", {
      method: "POST",
      token,
      body: { product: "aylamed", email: "ayla@example.com", name: "Emily", ayla_plan_id: "aylaMonthly", exam_track_id: "usmle_step_1", access_duration: 1, access_unit: "hour", return_password: true, send_email: false },
    });
    assert.equal(existingStudentInvite.response.status, 201, JSON.stringify(existingStudentInvite.payload));
    const existingStudentResult = existingStudentInvite.payload.results[0];
    assert.equal(existingStudentResult.student_created, false);
    assert.equal(existingStudentResult.user.name, "Emily");
    assert.equal(existingStudentResult.user.authVersion, 2);
    assert.equal(existingStudentResult.password_reset_required, true);
    assert.ok(existingStudentResult.temporary_password);
    const existingEnrollmentExpiry = existingStudentResult.enrollment.access_expires_at;

    const existingStudentLogin = await api(baseUrl, "/api/ayla/auth/login", {
      method: "POST",
      body: { email: "ayla@example.com", password: existingStudentResult.temporary_password },
    });
    assert.equal(existingStudentLogin.response.status, 200, JSON.stringify(existingStudentLogin.payload));
    assert.equal(existingStudentLogin.payload.user.mustChangePassword, true);

    const credentialsOnlyResend = await api(baseUrl, "/admin/mobile/invitations", {
      method: "POST",
      token,
      body: { product: "aylamed", email: "ayla@example.com", name: "Emily", exam_track_id: "usmle_step_1", preserve_existing_access: true, access_duration: 99, access_unit: "hour", amount: 999, return_password: true, send_email: false },
    });
    assert.equal(credentialsOnlyResend.response.status, 201, JSON.stringify(credentialsOnlyResend.payload));
    const resendResult = credentialsOnlyResend.payload.results[0];
    assert.equal(resendResult.access_unchanged, true);
    assert.equal(resendResult.payment, null);
    assert.equal(resendResult.enrollment.id, existingStudentResult.enrollment.id);
    assert.equal(resendResult.enrollment.access_expires_at, existingEnrollmentExpiry);
    assert.ok(resendResult.temporary_password);
    assert.notEqual(resendResult.temporary_password, existingStudentResult.temporary_password);

    const resentStudentLogin = await api(baseUrl, "/api/ayla/auth/login", {
      method: "POST",
      body: { email: "ayla@example.com", password: resendResult.temporary_password },
    });
    assert.equal(resentStudentLogin.response.status, 200, JSON.stringify(resentStudentLogin.payload));
    assert.equal(resentStudentLogin.payload.user.authVersion, 3);

    const upgraded = await api(baseUrl, `/api/ayla/enrollments/${encodeURIComponent(aylaInvitation.enrollment.id)}/extend`, {
      method: "POST",
      token,
      body: { access_duration: 10, access_unit: "minutes", access_window_mode: "replace", amount: 20 },
    });
    assert.equal(upgraded.response.status, 200, JSON.stringify(upgraded.payload));
    assert.equal(upgraded.payload.enrollment.access_duration, "10 minutes");
    assert.equal(upgraded.payload.enrollment.total_recorded_amount_cents, 3250);
    assert.equal(upgraded.payload.payment.amount_cents, 2000);

    const updatedDashboard = await api(baseUrl, "/admin/mobile/dashboard", { token });
    assert.equal(updatedDashboard.payload.aylamed.revenue.monthly_sales_cents, 8250);
    assert.equal(updatedDashboard.payload.aylamed.revenue.total_collected_cents, 8250);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 2_000);
    });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
