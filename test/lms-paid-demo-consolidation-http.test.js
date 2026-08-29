import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

test("startup archives a pre-upgrade demo and the admin list exposes only one effective enrollment", { timeout: 150_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-paid-demo-consolidation-"));
  const password = "PaidDemoStudent9!";
  const adminEmail = "admin@example.com";
  const adminPassword = "PaidDemoAdmin9!";
  const demoId = "course:student:demo";
  const paidId = "course:student:paid";
  const paidExpiry = new Date(Date.now() + 17 * 24 * 60 * 60 * 1000).toISOString();

  await fs.writeFile(path.join(dataDir, "live-session-db.json"), JSON.stringify({
    users: {
      student: {
        id: "student",
        email: "paid-demo@example.com",
        name: "Paid Demo Student",
        role: "student",
        verified: true,
        ...passwordRecord(password, "paid-demo-student-salt"),
      },
    },
    courses: {
      course: { id: "course", name: "Course", status: "active", demo_access_enabled: true },
    },
    plans: {
      monthly: { id: "monthly", name: "Monthly", is_active: true, access_days: 30, included_features: ["live_classes"] },
    },
    enrollments: {
      [demoId]: {
        id: demoId,
        user_id: "student",
        course_id: "course",
        is_demo: true,
        access_granted: true,
        demo_expiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        created_at: "2026-07-13T21:40:44.596Z",
      },
      [paidId]: {
        id: paidId,
        user_id: "student",
        course_id: "course",
        plan_id: "monthly",
        is_demo: false,
        access_granted: true,
        access_starts_at: "2026-07-16T06:21:08.000Z",
        access_expires_at: paidExpiry,
        renewal_due_at: paidExpiry,
        access_days: 30,
        paid_at: "2026-07-16T06:21:08.000Z",
        created_at: "2026-07-14T18:17:53.158Z",
      },
    },
    payments: {
      renewal: {
        id: "renewal",
        enrollment_id: paidId,
        user_id: "student",
        student_id: "student",
        course_id: "course",
        plan_id: "monthly",
        amount_cents: 4500,
        status: "completed",
        payment_status: "completed",
        paid_at: "2026-08-16T13:14:11.000Z",
      },
    },
  }));
  await fs.writeFile(path.join(dataDir, "crm-db.json"), JSON.stringify({ ai_training_documents: [], ai_training_items: [] }));
  await fs.writeFile(path.join(dataDir, "aylamed-db.json"), JSON.stringify({ schema_version: 15 }));

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      AUTH_JWT_SECRET: "paid-demo-consolidation-auth-secret",
      AYLA_AUTH_JWT_SECRET: "paid-demo-consolidation-ayla-secret",
      BOOTSTRAP_ADMIN_EMAIL: adminEmail,
      BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      DATABASE_URL: "",
      OPENAI_API_KEY: "",
      NEXTGEN_BACKEND_HEARTBEAT_ENABLED: "false",
      NEXTGEN_EMAIL_QUEUE_DISABLED: "true",
      NEXTGEN_EMAIL_AUTOMATION_DISABLED: "true",
      NEXTGEN_BILLING_RUNNER_DISABLED: "true",
      NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false",
      ZOOM_RECORDING_RECOVERY_ENABLED: "false",
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

    let effective;
    const started = Date.now();
    while (Date.now() - started < 15_000) {
      effective = await api(baseUrl, "/admin/enrollments", { token: adminLogin.payload.token });
      if (effective.payload.count === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.equal(effective.payload.count, 1, JSON.stringify(effective.payload));
    assert.equal(effective.payload.enrollments[0].id, paidId);
    assert.equal(effective.payload.enrollments[0].access_expires_at, paidExpiry);

    const history = await api(baseUrl, "/admin/enrollments?include_superseded=true", { token: adminLogin.payload.token });
    assert.equal(history.payload.count, 2, JSON.stringify(history.payload));
    const archivedDemo = history.payload.enrollments.find((item) => item.id === demoId);
    assert.equal(archivedDemo.access_granted, false);
    assert.equal(archivedDemo.revoked_reason, "upgraded_to_paid");
    assert.equal(archivedDemo.superseded_by_enrollment_id, paidId);

    const studentLogin = await api(baseUrl, "/auth/login", {
      method: "POST",
      body: { email: "paid-demo@example.com", password },
    });
    const demoStart = await api(baseUrl, "/demo/start", {
      method: "POST",
      token: studentLogin.payload.token,
      body: { course_id: "course" },
    });
    assert.equal(demoStart.response.status, 200, JSON.stringify(demoStart.payload));
    assert.equal(demoStart.payload.already_paid_count, 1);
    assert.equal(demoStart.payload.created_count, 0);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 2_000);
    });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
