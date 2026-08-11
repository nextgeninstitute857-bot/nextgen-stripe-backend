import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function passwordRecord(password, salt = "0123456789abcdef0123456789abcdef") {
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
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl, child, output, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Smoke server exited early (${child.exitCode})\n${output.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The isolated server may still be loading dependencies.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for smoke server\n${output.join("")}`);
}

async function api(baseUrl, route, {
  method = "GET",
  token = "",
  body = null,
  headers = {},
} = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${route} returned ${response.status} non-JSON: ${text.slice(0, 500)}`);
  }
  return { response, payload };
}

test("isolated continuity flow requires target entitlement and baseline, prefills habits only, and cannot send email by default", { timeout: 40000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aylamed-continuity-http-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const crmPath = path.join(dataDir, "crm-db.json");
  const aylaPath = path.join(dataDir, "aylamed-db.json");
  const password = "ContinuitySmoke9!";
  const adminEmail = "continuity-admin@example.com";
  const adminPassword = "ContinuityAdmin9!";
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 365 * 86400000).toISOString();
  const examDate = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);
  const liveSentinel = JSON.stringify({
    sentinel: "lms-untouched-continuity",
    users: {
      admin: {
        id: "admin",
        email: adminEmail,
        name: "Continuity Admin",
        role: "admin",
        status: "active",
        ...passwordRecord(adminPassword, "continuityadmincontinuityadmin12"),
        created_at: now,
        updated_at: now,
      },
    },
  });
  const crmSentinel = JSON.stringify({
    sentinel: "crm-untouched-continuity",
    ai_training_documents: [],
    ai_training_items: [],
  });
  const aylaDb = {
    schema_version: 14,
    qbank_state_version: 0,
    aylaSettings: {
      continuity: {
        email_delivery_enabled: false,
        coaching_email_default_opt_in: false,
        max_coaching_emails_per_day: 1,
        quiet_hours_start: 21,
        quiet_hours_end: 8,
      },
    },
    aylaUsers: {
      "user-1": {
        id: "user-1",
        email: "continuity-smoke@example.com",
        name: "Continuity Smoke",
        role: "student",
        status: "active",
        studentId: "step1-student",
        activeExamTrackId: "usmle_step_1",
        authVersion: 1,
        ...passwordRecord(password),
        createdAt: now,
        updatedAt: now,
      },
    },
    aylaStudents: {
      "step1-student": {
        id: "step1-student",
        ayla_user_id: "user-1",
        user_id: "user-1",
        name: "Continuity Smoke",
        examTrackId: "usmle_step_1",
        exam: "USMLE Step 1",
        examCompletedAt: now,
        serverVerifiedBaseline: true,
        currentScore: 72,
        systemBaselines: {
          Renal: { score: 68, serverVerified: true },
        },
        weakAreas: ["Renal"],
        timezone: "Asia/Karachi",
        dailyHours: 4,
        weeklyStudyDays: 6,
        preferredStudyDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
        sessionLength: 50,
        restDay: "Sunday",
        onboardingPath: "diagnostic_test",
        onboardingStatus: "complete",
        createdAt: now,
        updatedAt: now,
      },
    },
    aylaPlans: {
      "step1-plan": {
        id: "step1-plan",
        name: "Step 1",
        status: "active",
        is_active: true,
        is_full_access: true,
        exam_tracks: ["usmle_step_1"],
      },
      "step2-plan": {
        id: "step2-plan",
        name: "Step 2 CK",
        status: "active",
        is_active: true,
        is_full_access: true,
        exam_tracks: ["usmle_step_2_ck"],
      },
    },
    aylaEnrollments: {
      "step1-enrollment": {
        id: "step1-enrollment",
        user_id: "user-1",
        ayla_user_id: "user-1",
        student_id: "step1-student",
        plan_id: "step1-plan",
        exam_track_id: "usmle_step_1",
        status: "active",
        type: "paid",
        access_granted: true,
        access_starts_at: now,
        access_expires_at: future,
      },
      "step2-enrollment": {
        id: "step2-enrollment",
        user_id: "user-1",
        ayla_user_id: "user-1",
        plan_id: "step2-plan",
        exam_track_id: "usmle_step_2_ck",
        status: "active",
        type: "paid",
        access_granted: true,
        access_starts_at: now,
        access_expires_at: future,
      },
    },
    aylaRevisionQueue: {
      "revision-1": {
        id: "revision-1",
        studentId: "step1-student",
        examTrackId: "usmle_step_1",
        system: "Renal",
        subsystem: "Acid-base physiology",
        topic: "Metabolic acidosis",
        reason: "Repeated verified miss",
        status: "due",
        createdAt: now,
        updatedAt: now,
      },
    },
  };
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
      PORT: String(port),
      DATA_DIR: dataDir,
      AYLA_AUTH_JWT_SECRET: "continuity-isolated-ayla-secret",
      AUTH_JWT_SECRET: "continuity-isolated-lms-secret",
      AYLA_CONTINUITY_EMAIL_DELIVERY_ENABLED: "false",
      AYLA_CONTINUITY_EMAIL_RUNNER_ENABLED: "false",
      NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false",
      ZOOM_RECORDING_RECOVERY_ENABLED: "false",
      AYLA_VIMEO_FOLDER_SYNC_ENABLED: "false",
      DATABASE_URL: "",
      RESEND_API_KEY: "",
      SENDGRID_API_KEY: "",
      SMTP_HOST: "",
      SMTP_USER: "",
      SMTP_PASS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    await waitForHealth(baseUrl, child, output);
    const adminLogin = await api(baseUrl, "/auth/login", {
      method: "POST",
      body: { email: adminEmail, password: adminPassword },
    });
    assert.equal(adminLogin.response.status, 200, JSON.stringify(adminLogin.payload));
    const adminToken = adminLogin.payload.token;

    const login = await api(baseUrl, "/api/ayla/auth/login", {
      method: "POST",
      body: { email: "continuity-smoke@example.com", password },
    });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    const token = login.payload.token;

    const initial = await api(baseUrl, "/api/ayla/students/step1-student/continuity", {
      token,
    });
    assert.equal(initial.response.status, 200, JSON.stringify(initial.payload));
    assert.equal(initial.payload.suggestedTargetExamTrack, "usmle_step_2_ck");
    assert.equal(initial.payload.preferences.coachingEmailOptIn, false);
    assert.equal(initial.payload.policy.newTargetBaselineRequired, true);

    const handoff = await api(baseUrl, "/api/ayla/students/step1-student/exam-handoffs", {
      method: "POST",
      token,
      body: { targetExamTrack: "usmle_step_2_ck" },
    });
    assert.equal(handoff.response.status, 201, JSON.stringify(handoff.payload));
    assert.equal(handoff.payload.handoff.status, "target_setup_required");
    assert.equal(handoff.payload.handoff.targetEntitled, true);
    assert.equal(handoff.payload.handoff.sourceScoresCopied, false);
    assert.equal(handoff.payload.handoff.sourceBaselineCopied, false);
    assert.doesNotMatch(
      JSON.stringify(handoff.payload.handoff.carryContext),
      /72|currentScore|systemBaselines|weakAreas/,
    );

    const targetSetup = await api(baseUrl, "/api/ayla/diagnostic-submissions", {
      method: "POST",
      token,
      body: {
        examTrackId: "usmle_step_2_ck",
        studentName: "Continuity Smoke",
        onboardingPath: "starting_fresh",
        examDate,
        selectedResources: ["book", "video", "qbank"],
      },
    });
    assert.equal(targetSetup.response.status, 201, JSON.stringify(targetSetup.payload));
    assert.equal(targetSetup.payload.student.examTrackId, "usmle_step_2_ck");
    assert.equal(targetSetup.payload.student.onboardingPath, "diagnostic_test");
    assert.equal(targetSetup.payload.student.onboardingStatus, "diagnostic_pending");
    assert.equal(targetSetup.payload.student.serverVerifiedBaseline, false);
    assert.equal(targetSetup.payload.student.currentScore, 0);
    assert.equal(targetSetup.payload.student.dailyHours, 4);
    assert.equal(targetSetup.payload.student.weeklyStudyDays, 6);
    assert.equal(targetSetup.payload.student.timezone, "Asia/Karachi");
    assert.equal(targetSetup.payload.student.sourceScoresCopied, false);
    assert.equal(targetSetup.payload.nextStep.type, "baseline_diagnostic");

    const afterSetup = await api(baseUrl, "/api/ayla/students/step1-student/continuity", {
      token,
    });
    assert.equal(afterSetup.response.status, 200, JSON.stringify(afterSetup.payload));
    assert.equal(afterSetup.payload.handoffs[0].status, "baseline_required");
    assert.equal(afterSetup.payload.handoffs[0].targetStudentId, targetSetup.payload.student.id);
    assert.equal(afterSetup.payload.handoffs[0].targetBaselineVerified, false);

    const preferences = await api(
      baseUrl,
      "/api/ayla/students/step1-student/continuity/preferences",
      {
        method: "PUT",
        token,
        body: {
          coachingEmailOptIn: true,
          weeklySummaryEmailOptIn: true,
          timezone: "Asia/Karachi",
        },
      },
    );
    assert.equal(preferences.response.status, 200, JSON.stringify(preferences.payload));
    assert.equal(preferences.payload.preferences.coachingEmailOptIn, true);

    const preview = await api(
      baseUrl,
      "/api/ayla/admin/continuity/engagement-preview?studentId=step1-student",
      { token: adminToken },
    );
    assert.equal(preview.response.status, 200, JSON.stringify(preview.payload));
    assert.equal(preview.payload.read_only, true);
    assert.equal(preview.payload.write_performed, false);
    assert.equal(preview.payload.email_sent, false);
    assert.equal(preview.payload.delivery_runtime.ready, false);

    const blockedSend = await api(baseUrl, "/api/ayla/admin/continuity/engagement-delivery", {
      method: "POST",
      token: adminToken,
      body: {
        dry_run: false,
        confirm: "SEND_ELIGIBLE_CONTINUITY_EMAILS",
        studentId: "step1-student",
      },
    });
    assert.equal(blockedSend.response.status, 409, JSON.stringify(blockedSend.payload));
    assert.equal(blockedSend.payload.details.email_sent, false);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 2000);
    });
  }

  assert.equal(await fs.readFile(livePath, "utf8"), liveSentinel);
  assert.equal(await fs.readFile(crmPath, "utf8"), crmSentinel);
  const stored = JSON.parse(await fs.readFile(aylaPath, "utf8"));
  assert.equal(stored.schema_version, 15);
  assert.equal(stored.aylaStudents["step1-student"].currentScore, 72);
  const targetStudent = Object.values(stored.aylaStudents)
    .find((student) => student.examTrackId === "usmle_step_2_ck");
  assert.ok(targetStudent);
  assert.equal(targetStudent.currentScore, 0);
  assert.equal(targetStudent.serverVerifiedBaseline, false);
  assert.equal(targetStudent.onboardingPath, "diagnostic_test");
  assert.equal(Object.keys(stored.aylaEngagementDeliveries || {}).length, 0);
});
