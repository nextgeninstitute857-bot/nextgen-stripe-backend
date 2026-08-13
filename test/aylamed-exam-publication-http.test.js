import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function passwordRecord(password, salt = "publicationadminpublication1234") {
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

test("publication controls stay available when the QBank registry is unavailable", { timeout: 30000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aylamed-publication-http-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const crmPath = path.join(dataDir, "crm-db.json");
  const aylaPath = path.join(dataDir, "aylamed-db.json");
  const adminEmail = "publication-admin@example.com";
  const adminPassword = "PublicationAdmin9!";
  const now = new Date().toISOString();
  await fs.writeFile(livePath, JSON.stringify({
    users: {
      admin: {
        id: "admin",
        email: adminEmail,
        name: "Publication Admin",
        role: "admin",
        status: "active",
        ...passwordRecord(adminPassword),
        created_at: now,
        updated_at: now,
      },
    },
  }));
  await fs.writeFile(crmPath, JSON.stringify({ ai_training_documents: [], ai_training_items: [] }));
  await fs.writeFile(aylaPath, JSON.stringify({
    schema_version: 14,
    aylaResources: {
      "amc-book": {
        id: "amc-book",
        type: "book",
        title: "AMC handbook",
        examTrackId: "amc",
        status: "active",
      },
    },
    aylaVimeoCatalogSources: {},
    aylaExamPublicationControls: {},
    aylaResourcePublicationControls: {},
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
      AYLA_AUTH_JWT_SECRET: "publication-ayla-secret",
      AUTH_JWT_SECRET: "publication-lms-secret",
      DATABASE_URL: "postgres://127.0.0.1:1/unavailable",
      NEXTGEN_CONTENT_PG_CONNECT_TIMEOUT_MS: "500",
      NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false",
      ZOOM_RECORDING_RECOVERY_ENABLED: "false",
      NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED: "false",
      OPENAI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    await waitForHealth(baseUrl, child, output);
    const login = await api(baseUrl, "/auth/login", {
      method: "POST",
      body: { email: adminEmail, password: adminPassword },
    });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));

    const controls = await api(baseUrl, "/api/ayla/admin/publication-controls", { token: login.payload.token });
    assert.equal(controls.response.status, 200, JSON.stringify(controls.payload));
    assert.equal(controls.payload.build, "aylamed-multiexam-publication-taxonomy-v220");
    assert.equal(controls.payload.multiexam_build, "aylamed-multiexam-publication-taxonomy-v220");
    assert.equal(controls.payload.exams.length, 7);
    assert.equal(controls.payload.exams.find((exam) => exam.examTrackId === "usmle_step_1").enabled, true);
    assert.equal(controls.payload.exams.find((exam) => exam.examTrackId === "amc").enabled, false);
    assert.equal(controls.payload.available_resources.some((resource) => resource.id === "amc-book"), true);
    assert.equal(controls.payload.publication_registry_warning.code, "qbank_registry_unavailable");
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
