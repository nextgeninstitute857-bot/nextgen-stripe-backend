import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function passwordRecord(password, salt = "studentpasswordsessionstudent12") {
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

async function waitForHealth(baseUrl, child, output, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Server exited (${child.exitCode})\n${output.join("")}`);
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Health timeout\n${output.join("")}`);
}

async function api(baseUrl, route, { method = "GET", token = "", oldKey = "", body = null } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(oldKey ? { "x-admin-token": oldKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, payload: await response.json() };
}

test("AylaMed Control Center accepts only the bootstrap admin email/password session", { timeout: 30_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aylamed-admin-password-"));
  const now = new Date().toISOString();
  const studentPassword = "OrdinaryStudent9!";
  await fs.writeFile(path.join(dataDir, "live-session-db.json"), JSON.stringify({
    users: {
      student: {
        id: "student",
        email: "ordinary-student@example.com",
        name: "Ordinary Student",
        role: "student",
        verified: true,
        ...passwordRecord(studentPassword),
        created_at: now,
        updated_at: now,
      },
    },
  }));
  await fs.writeFile(path.join(dataDir, "crm-db.json"), JSON.stringify({ ai_training_documents: [], ai_training_items: [] }));
  await fs.writeFile(path.join(dataDir, "aylamed-db.json"), JSON.stringify({ schema_version: 15 }));

  const adminEmail = "aylamed-admin@example.com";
  const adminPassword = "AylaMedAdminSession9!";
  const oldKey = "retired-shared-admin-key";
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      AUTH_JWT_SECRET: "admin-password-session-lms-secret",
      AYLA_AUTH_JWT_SECRET: "admin-password-session-ayla-secret",
      BOOTSTRAP_ADMIN_EMAIL: adminEmail,
      BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      BOOTSTRAP_ADMIN_NAME: "AylaMed Administrator",
      AYLA_ADMIN_TOKEN: oldKey,
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

    const retiredKey = await api(baseUrl, "/api/ayla/admin/settings", { oldKey });
    assert.equal(retiredKey.response.status, 401, JSON.stringify(retiredKey.payload));

    const studentLogin = await api(baseUrl, "/auth/login", {
      method: "POST",
      body: { email: "ordinary-student@example.com", password: studentPassword },
    });
    assert.equal(studentLogin.response.status, 200, JSON.stringify(studentLogin.payload));
    const studentDenied = await api(baseUrl, "/api/ayla/admin/settings", { token: studentLogin.payload.token });
    assert.equal(studentDenied.response.status, 403, JSON.stringify(studentDenied.payload));

    const adminLogin = await api(baseUrl, "/auth/login", {
      method: "POST",
      body: { email: adminEmail, password: adminPassword },
    });
    assert.equal(adminLogin.response.status, 200, JSON.stringify(adminLogin.payload));
    assert.equal(adminLogin.payload.user.role, "admin");

    const settings = await api(baseUrl, "/api/ayla/admin/settings", { token: adminLogin.payload.token });
    assert.equal(settings.response.status, 200, JSON.stringify(settings.payload));
    assert.equal(settings.payload.admin_auth_configured, true);
    assert.equal(settings.payload.admin_auth_mode, "email_password");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 2_000);
    });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
