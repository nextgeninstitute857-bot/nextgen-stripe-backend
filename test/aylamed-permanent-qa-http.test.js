import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function passwordRecord(password, salt = "permanentqaadminsalt0123456789") {
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

async function waitForHealth(baseUrl, child, output) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited (${child.exitCode})\n${output.join("")}`);
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Health timeout\n${output.join("")}`);
}

test("permanent QA follows register, admin entitlement, and normal onboarding", { timeout: 40000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aylamed-permanent-qa-http-"));
  const now = new Date().toISOString();
  const adminEmail = "qa-admin@example.com";
  const adminPassword = "PermanentQaAdmin9!";
  await fs.writeFile(path.join(dataDir, "live-session-db.json"), JSON.stringify({
    users: {
      admin: { id: "admin", email: adminEmail, name: "QA Admin", role: "admin", status: "active", ...passwordRecord(adminPassword), created_at: now, updated_at: now },
    },
  }));
  await fs.writeFile(path.join(dataDir, "crm-db.json"), JSON.stringify({ ai_training_documents: [], ai_training_items: [] }));
  await fs.writeFile(path.join(dataDir, "aylamed-db.json"), JSON.stringify({
    schema_version: 1,
    aylaExamPublicationControls: {
      "AYLA-EXAM-PUBLICATION-usmle_step_1": { id: "AYLA-EXAM-PUBLICATION-usmle_step_1", type: "exam_publication_control", examTrackId: "usmle_step_1", enabled: true },
    },
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
      AYLA_AUTH_JWT_SECRET: "permanent-qa-ayla-secret",
      AUTH_JWT_SECRET: "permanent-qa-admin-secret",
      NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false",
      ZOOM_RECORDING_RECOVERY_ENABLED: "false",
      NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED: "false",
      DATABASE_URL: "",
      OPENAI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    await waitForHealth(baseUrl, child, output);
    const adminLogin = await api(baseUrl, "/auth/login", { method: "POST", body: { email: adminEmail, password: adminPassword } });
    assert.equal(adminLogin.response.status, 200, JSON.stringify(adminLogin.payload));

    const email = "qa.usmle-step-1.one-week@aylamedapp.com";
    const password = "PermanentQaStudent9!";
    const registration = await api(baseUrl, "/api/ayla/auth/register", { method: "POST", body: { email, password, name: "QA Step 1 One Week" } });
    assert.equal(registration.response.status, 201, JSON.stringify(registration.payload));

    const grant = await api(baseUrl, "/api/ayla/enrollments/grant-access", {
      method: "POST",
      token: adminLogin.payload.token,
      body: {
        email,
        plan_id: "AYLA-PLAN-PERMANENT-QA",
        exam_track_id: "usmle_step_1",
        type: "qa",
        source: "permanent_qa_test",
        permanent_access: true,
        test_account: true,
        confirmation: "GRANT PERMANENT AYLAMED ACCESS",
      },
    });
    assert.equal(grant.response.status, 201, JSON.stringify(grant.payload));
    assert.equal(grant.payload.enrollment.access_expires_at, null);
    assert.equal(grant.payload.enrollment.permanent_access, true);

    const examDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const onboarding = await api(baseUrl, "/api/ayla/diagnostic-submissions", {
      method: "POST",
      token: registration.payload.token,
      body: {
        examTrackId: "usmle_step_1",
        onboardingPath: "quick_profile",
        goalType: "Exam Day",
        examDate,
        timezone: "America/Los_Angeles",
        dailyHours: 6,
        weeklyStudyDays: 7,
        studyStage: "first_pass_in_progress",
        qbankCompleted: 50,
        qbankAverage: 55,
        selectedWeakAreas: ["Cardiovascular", "Renal"],
        targetScore: 65,
        questionSourcePreference: "hybrid",
        studyPartnerOptIn: false,
      },
    });
    assert.equal(onboarding.response.status, 201, JSON.stringify(onboarding.payload));
    assert.equal(onboarding.payload.student.onboardingPath, "quick_profile");
    assert.equal(onboarding.payload.student.testAccount, true);
    assert.equal(onboarding.payload.student.excludeFromLeaderboard, true);

    const shell = await api(baseUrl, "/api/ayla/shell", { token: registration.payload.token });
    assert.equal(shell.response.status, 200, JSON.stringify(shell.payload));
    assert.equal(shell.payload.activeDashboard.exam_track_id, "usmle_step_1");
    assert.equal(Object.values(shell.payload.activeDashboard.features).every(Boolean), true);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
