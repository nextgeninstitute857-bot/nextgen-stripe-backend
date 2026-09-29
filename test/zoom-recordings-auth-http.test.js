import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function passwordRecord(password, salt = "zoomrecordingsauthsalt1234567") {
  return { salt, password_hash: crypto.pbkdf2Sync(password, salt, 120000, 64, "sha512").toString("hex") };
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

async function waitForHealth(baseUrl, child, output, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Test server exited (${child.exitCode})\n${output.join("")}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Test server health timeout\n${output.join("")}`);
}

test("Zoom recording list requires a signed-in user with recording permission", { timeout: 60_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "zoom-recordings-auth-"));
  const password = "StudentPass9!";
  const now = new Date().toISOString();
  await fs.writeFile(path.join(dataDir, "live-session-db.json"), JSON.stringify({
    users: { student: { id: "student", email: "student@example.com", name: "Student", role: "student", status: "active", verified: true, ...passwordRecord(password), created_at: now, updated_at: now } },
  }));
  await fs.writeFile(path.join(dataDir, "crm-db.json"), JSON.stringify({ sentinel: "crm" }));
  await fs.writeFile(path.join(dataDir, "aylamed-db.json"), JSON.stringify({ sentinel: "ayla" }));

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, PORT: String(port), TZ: "UTC", DATA_DIR: dataDir, AUTH_JWT_SECRET: "zoom-recordings-auth-secret",
      AYLA_AUTH_JWT_SECRET: "zoom-recordings-auth-ayla-secret", DATABASE_URL: "", OPENAI_API_KEY: "",
      ZOOM_ACCOUNT_ID: "", ZOOM_CLIENT_ID: "", ZOOM_CLIENT_SECRET: "",
      NEXTGEN_BACKEND_HEARTBEAT_ENABLED: "false", NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false", ZOOM_RECORDING_RECOVERY_ENABLED: "false", NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  try {
    await waitForHealth(baseUrl, child, output);
    const anonymous = await fetch(`${baseUrl}/zoom/recordings?from=2026-09-01&to=2026-09-29`);
    assert.equal(anonymous.status, 401, "anonymous visitors cannot list Zoom recordings");

    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "student@example.com", password }),
    });
    const { token } = await login.json();
    assert.ok(token, "student can sign in");
    const student = await fetch(`${baseUrl}/zoom/recordings?from=2026-09-01&to=2026-09-29`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(student.status, 403, "students cannot list raw Zoom recordings");
  } finally {
    if (child.exitCode === null) await new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGTERM"); });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
