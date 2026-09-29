import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function passwordRecord(password, salt = "roadmapextensionsalt1234567890") {
  return {
    salt,
    password_hash: crypto.pbkdf2Sync(password, salt, 120000, 64, "sha512").toString("hex"),
  };
}

function dateKey(offset = 0) {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
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

async function waitForHealth(baseUrl, child, output, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Roadmap test server exited (${child.exitCode})\n${output.join("")}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Roadmap test server health timeout\n${output.join("")}`);
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
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${route} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return { response, payload };
}

test("reading copilot settings does not rewrite an initialized CRM database", { timeout: 60_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-settings-"));
  const password = "CopilotAdmin9!";
  const now = new Date().toISOString();
  await fs.writeFile(path.join(dataDir, "live-session-db.json"), JSON.stringify({
    users: { admin: { id: "admin", email: "copilot-admin@example.com", name: "Admin", role: "admin", status: "active", verified: true, ...passwordRecord(password), created_at: now, updated_at: now } },
  }));
  await fs.writeFile(path.join(dataDir, "aylamed-db.json"), JSON.stringify({ sentinel: "ayla" }));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, PORT: String(port), TZ: "UTC", DATA_DIR: dataDir, AUTH_JWT_SECRET: "copilot-secret", AYLA_AUTH_JWT_SECRET: "copilot-ayla-secret", DATABASE_URL: "", OPENAI_API_KEY: "",
      NEXTGEN_BACKEND_HEARTBEAT_ENABLED: "false", NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false", ZOOM_RECORDING_RECOVERY_ENABLED: "false", NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED: "false", NEXTGEN_AUTO_VIMEO_TRANSFER_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const crmPath = path.join(dataDir, "crm-db.json");
  try {
    await waitForHealth(baseUrl, child, output);
    const login = await api(baseUrl, "/auth/login", { method: "POST", body: { email: "copilot-admin@example.com", password } });
    const token = login.payload.token;
    const first = await api(baseUrl, "/admin/copilot/settings", { token });
    assert.equal(first.response.status, 200, JSON.stringify(first.payload));
    assert.equal(first.payload.settings.assistant_name, "Ayla");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stored = JSON.parse(await fs.readFile(crmPath, "utf8"));
    assert.ok(stored.copilot_settings?.assistant_name, "a missing copilot store is still initialized and saved");

    const before = await fs.stat(crmPath);
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (let i = 0; i < 3; i += 1) assert.equal((await api(baseUrl, "/admin/copilot/settings", { token })).response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await fs.stat(crmPath);
    assert.equal(after.mtimeMs, before.mtimeMs, "reading settings again must not rewrite the CRM database");
  } finally {
    if (child.exitCode === null) await new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGTERM"); });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
