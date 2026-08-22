import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";

function passwordRecord(password, salt) {
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

async function waitForHealth(baseUrl, child, output, timeoutMs = 90_000) {
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

test("premium LMS restores public catalog, account access, and timed invitations", { timeout: 150_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-public-site-restored-"));
  const now = new Date().toISOString();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const password = "ExistingStudent9!";
  const authSecret = "existing-students-only-auth-secret";

  const users = {
    active: {
      id: "active",
      email: "active@example.com",
      name: "Active Student",
      role: "student",
      verified: true,
      ...passwordRecord(password, "active-student-password-salt"),
      created_at: now,
      updated_at: now,
    },
    demo: {
      id: "demo",
      email: "demo@example.com",
      name: "Demo Student",
      role: "student",
      verified: true,
      ...passwordRecord(password, "demo-student-password-salt"),
      created_at: now,
      updated_at: now,
    },
    expired: {
      id: "expired",
      email: "expired@example.com",
      name: "Expired Student",
      role: "student",
      verified: true,
      ...passwordRecord(password, "expired-student-password-salt"),
      created_at: now,
      updated_at: now,
    },
  };

  await fs.writeFile(path.join(dataDir, "live-session-db.json"), JSON.stringify({
    users,
    courses: {
      course: { id: "course", name: "Existing Student Course", status: "active" },
    },
    plans: {
      plan: { id: "plan", name: "Active Plan", is_active: true, included_features: ["video_library"] },
    },
    enrollments: {
      "course:active:paid": {
        id: "course:active:paid",
        user_id: "active",
        course_id: "course",
        plan_id: "plan",
        is_demo: false,
        access_granted: true,
        created_at: now,
        updated_at: now,
      },
      "course:demo:demo": {
        id: "course:demo:demo",
        user_id: "demo",
        course_id: "course",
        is_demo: true,
        access_granted: true,
        demo_expiry: tomorrow,
        created_at: now,
        updated_at: now,
      },
      "course:expired:paid": {
        id: "course:expired:paid",
        user_id: "expired",
        course_id: "course",
        plan_id: "plan",
        is_demo: false,
        access_granted: true,
        access_expires_at: yesterday,
        created_at: now,
        updated_at: now,
      },
    },
  }));
  await fs.writeFile(path.join(dataDir, "crm-db.json"), JSON.stringify({ ai_training_documents: [], ai_training_items: [] }));
  await fs.writeFile(path.join(dataDir, "aylamed-db.json"), JSON.stringify({ schema_version: 15 }));

  const adminEmail = "admin@example.com";
  const adminPassword = "ExistingAdmin9!";
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      AUTH_JWT_SECRET: authSecret,
      AYLA_AUTH_JWT_SECRET: "existing-students-only-ayla-secret",
      BOOTSTRAP_ADMIN_EMAIL: adminEmail,
      BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      DATABASE_URL: "",
      OPENAI_API_KEY: "",
      NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false",
      ZOOM_RECORDING_RECOVERY_ENABLED: "false",
      NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED: "false",
      EXTERNAL_LIBRARY_URL: "https://lectureslibrary.online",
      EXTERNAL_LIBRARY_SSO_SECRET: "recorded-library-sso-test-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    await waitForHealth(baseUrl, child, output);

    const health = await api(baseUrl, "/health");
    assert.equal(health.payload.lms_admission_mode, "open");

    const signup = await api(baseUrl, "/auth/signup", {
      method: "POST",
      body: { name: "New Student", email: "new@example.com", password, passwordConfirm: password },
    });
    assert.equal(signup.response.status, 200, JSON.stringify(signup.payload));
    assert.equal(signup.payload.created, true);

    const plans = await api(baseUrl, "/plans");
    assert.equal(plans.response.status, 200, JSON.stringify(plans.payload));
    assert.equal(plans.payload.count, 1);

    const demoStart = await api(baseUrl, "/demo/start", { method: "POST", body: { course_id: "course" } });
    assert.equal(demoStart.response.status, 401);

    const demoLogin = await api(baseUrl, "/auth/login", {
      method: "POST",
      body: { email: users.demo.email, password },
    });
    assert.equal(demoLogin.response.status, 200, JSON.stringify(demoLogin.payload));

    const demoLibrary = await api(baseUrl, "/student/external-library/access", {
      method: "POST",
      token: demoLogin.payload.token,
      body: { course_id: "course" },
    });
    assert.equal(demoLibrary.response.status, 403, JSON.stringify(demoLibrary.payload));

    const expiredLogin = await api(baseUrl, "/auth/login", {
      method: "POST",
      body: { email: users.expired.email, password },
    });
    assert.equal(expiredLogin.response.status, 200, JSON.stringify(expiredLogin.payload));

    const activeLogin = await api(baseUrl, "/auth/login", {
      method: "POST",
      body: { email: users.active.email, password },
    });
    assert.equal(activeLogin.response.status, 200, JSON.stringify(activeLogin.payload));
    assert.equal(activeLogin.payload.admission_mode, "open");

    const activeLibrary = await api(baseUrl, "/student/external-library/access", {
      method: "POST",
      token: activeLogin.payload.token,
      body: { course_id: "course" },
    });
    assert.equal(activeLibrary.response.status, 200, JSON.stringify(activeLibrary.payload));
    assert.match(activeLibrary.payload.redirect_url, /^https:\/\/lectureslibrary\.online\/sso-login\?token=/);

    const courses = await api(baseUrl, "/courses", { token: activeLogin.payload.token });
    assert.equal(courses.response.status, 200, JSON.stringify(courses.payload));

    const publicCourses = await api(baseUrl, "/courses");
    assert.equal(publicCourses.response.status, 200, JSON.stringify(publicCourses.payload));
    assert.equal(publicCourses.payload.count, 1);

    const demoToken = jwt.sign(
      { sub: users.demo.id, email: users.demo.email, role: "student" },
      authSecret,
      { expiresIn: "5m" },
    );
    const demoTokenAccess = await api(baseUrl, "/auth/me", { token: demoToken });
    assert.equal(demoTokenAccess.response.status, 200, JSON.stringify(demoTokenAccess.payload));

    const checkout = await api(baseUrl, "/enrollments/prepare-checkout", {
      method: "POST",
      token: activeLogin.payload.token,
      body: { course_id: "course" },
    });
    assert.equal(checkout.response.status, 200, JSON.stringify(checkout.payload));
    assert.equal(checkout.payload.already_active, true);

    const adminLogin = await api(baseUrl, "/auth/login", {
      method: "POST",
      body: { email: adminEmail, password: adminPassword },
    });
    assert.equal(adminLogin.response.status, 200, JSON.stringify(adminLogin.payload));
    assert.equal(adminLogin.payload.user.role, "admin");

    const timedInvite = await api(baseUrl, "/admin/mobile/invitations", {
      method: "POST",
      token: adminLogin.payload.token,
      body: {
        product: "lms",
        name: "Invited Doctor",
        email: "invited-doctor@example.com",
        course_id: "course",
        plan_id: "plan",
        access_duration: 2,
        access_unit: "hours",
        send_email: false,
        return_password: true,
      },
    });
    assert.equal(timedInvite.response.status, 201, JSON.stringify(timedInvite.payload));
    const invitation = timedInvite.payload.results[0];
    assert.equal(invitation.student_created, true);
    assert.equal(invitation.password_reset_required, true);
    assert.equal(invitation.user.must_change_password, true);
    assert.equal(invitation.enrollment.access_expiry_mode, "admin_timed");
    assert.equal(invitation.enrollment.access_duration, "2 hours");
    assert.equal(invitation.access_report.duration_unit, "hour");
    assert.match(invitation.temporary_password, /^NG-[A-Za-z0-9_-]{8}-\d{4}$/);
    const twoHourExpiry = new Date(invitation.access_report.expires_at).getTime();
    assert.ok(twoHourExpiry > Date.now() + 119 * 60 * 1000);
    assert.ok(twoHourExpiry < Date.now() + 121 * 60 * 1000);

    const invitedLogin = await api(baseUrl, "/auth/login", {
      method: "POST",
      body: { email: invitation.access_report.email, password: invitation.temporary_password },
    });
    assert.equal(invitedLogin.response.status, 200, JSON.stringify(invitedLogin.payload));
    assert.equal(invitedLogin.payload.user.must_change_password, true);

    const replacementPassword = "ChangedStudentPassword9!";
    const changedPassword = await api(baseUrl, "/auth/update-password", {
      method: "POST",
      token: invitedLogin.payload.token,
      body: { current_password: invitation.temporary_password, new_password: replacementPassword },
    });
    assert.equal(changedPassword.response.status, 200, JSON.stringify(changedPassword.payload));

    const changedLogin = await api(baseUrl, "/auth/login", {
      method: "POST",
      body: { email: invitation.access_report.email, password: replacementPassword },
    });
    assert.equal(changedLogin.response.status, 200, JSON.stringify(changedLogin.payload));
    assert.equal(changedLogin.payload.user.must_change_password, false);

    const monthInvite = await api(baseUrl, "/admin/mobile/invitations", {
      method: "POST",
      token: adminLogin.payload.token,
      body: {
        product: "lms",
        email: "monthly-doctor@example.com",
        course_id: "course",
        access_duration: 1,
        access_unit: "months",
        send_email: false,
      },
    });
    assert.equal(monthInvite.response.status, 201, JSON.stringify(monthInvite.payload));
    assert.equal(monthInvite.payload.results[0].access_report.duration, "1 month");
    const monthLengthDays = (
      new Date(monthInvite.payload.results[0].access_report.expires_at).getTime()
      - new Date(monthInvite.payload.results[0].access_report.starts_at).getTime()
    ) / (24 * 60 * 60 * 1000);
    assert.ok(monthLengthDays >= 28 && monthLengthDays <= 31);

    const emailSettings = await api(baseUrl, "/admin/email-settings", { token: adminLogin.payload.token });
    assert.equal(emailSettings.response.status, 200, JSON.stringify(emailSettings.payload));
    const invitationTemplate = emailSettings.payload.templates.find((item) => item.key === "lms_timed_access_invitation");
    assert.ok(invitationTemplate);
    assert.match(invitationTemplate.body, /ACCESS REPORT/);
    assert.match(invitationTemplate.body, /Temporary password: \{\{temporary_password\}\}/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 2_000);
    });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
