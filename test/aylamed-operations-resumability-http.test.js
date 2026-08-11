import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function passwordRecord(password, salt = "operationsv217operationsv217op") {
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

async function waitForHealth(baseUrl, child, output, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Server exited (${child.exitCode})\n${output.join("")}`);
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Health timeout\n${output.join("")}`);
}

async function jsonApi(baseUrl, route, { method = "GET", token = "", adminToken = "", body = null } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(adminToken ? { "x-admin-token": adminToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error(`${method} ${route} returned ${response.status}: ${text.slice(0, 500)}`); }
  return { response, payload };
}

async function chunkApi(baseUrl, route, token, bytes) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
      "x-chunk-sha256": crypto.createHash("sha256").update(bytes).digest("hex"),
    },
    body: bytes,
  });
  return { response, payload: await response.json() };
}

test("v217 HTTP flow keeps chunked ZIPs admin-only, resumable, checksummed, and outside product databases", { timeout: 50_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aylamed-v217-http-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const crmPath = path.join(dataDir, "crm-db.json");
  const aylaPath = path.join(dataDir, "aylamed-db.json");
  const password = "OperationsAdmin9!";
  const now = new Date().toISOString();
  const liveDb = {
    sentinel: "lms-untouched-v217",
    users: {
      admin: { id: "admin", email: "operations-admin@example.com", name: "Operations Admin", role: "admin", status: "active", ...passwordRecord(password), created_at: now, updated_at: now },
    },
  };
  const liveOriginal = JSON.stringify(liveDb);
  const crmOriginal = JSON.stringify({ sentinel: "crm-untouched-v217", ai_training_documents: [], ai_training_items: [] });
  const aylaOriginal = JSON.stringify({ schema_version: 10, sentinel: "ayla-untouched-v217" });
  await fs.writeFile(livePath, liveOriginal);
  await fs.writeFile(crmPath, crmOriginal);
  await fs.writeFile(aylaPath, aylaOriginal);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
    env: {
      ...process.env,
      PORT: String(port), DATA_DIR: dataDir,
      AUTH_JWT_SECRET: "v217-lms-secret", AYLA_AUTH_JWT_SECRET: "v217-ayla-secret",
      AYLA_ADMIN_TOKEN: "operations-ayla-admin-token",
      DATABASE_URL: "", OPENAI_API_KEY: "",
      NEXTGEN_CONTENT_UPLOAD_CHUNK_BYTES: String(256 * 1024),
      NEXTGEN_CONTENT_UPLOAD_MAX_CHUNK_BYTES: String(1024 * 1024),
      NEXTGEN_BACKEND_HEARTBEAT_ENABLED: "false",
      NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false", ZOOM_RECORDING_RECOVERY_ENABLED: "false",
      NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    await waitForHealth(baseUrl, child, output);
    const bytes = crypto.randomBytes(600_123);
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const unauthorized = await jsonApi(baseUrl, "/admin/crm/ai-training/content-uploads", {
      method: "POST", body: { original_filename: "questions.zip", total_bytes: bytes.length, sha256: digest },
    });
    assert.equal(unauthorized.response.status, 401, JSON.stringify(unauthorized.payload));

    const legacyKeyRejected = await jsonApi(baseUrl, "/admin/crm/ai-training/content-uploads", {
      method: "POST", adminToken: "operations-ayla-admin-token",
      body: {
        original_filename: "questions.zip", total_bytes: bytes.length, sha256: digest,
        purpose: "question_zip", metadata: { source_provider: "AylaMed", source_profile: "aylamed_original", source_rights_status: "owned", source_namespace: "fixture" },
      },
    });
    assert.equal(legacyKeyRejected.response.status, 401, JSON.stringify(legacyKeyRejected.payload));



    const login = await jsonApi(baseUrl, "/auth/login", {
      method: "POST", body: { email: "operations-admin@example.com", password },
    });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    const token = login.payload.token;
    const created = await jsonApi(baseUrl, "/admin/crm/ai-training/content-uploads", {
      method: "POST", token,
      body: {
        original_filename: "questions.zip", total_bytes: bytes.length, sha256: digest,
        purpose: "question_zip", metadata: { exam_track: "usmle-step-1", source_namespace: "fixture" },
      },
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    const session = created.payload.upload;
    assert.equal(session.chunk_count, 3);
    assert.equal(JSON.stringify(created.payload).includes(dataDir), false);

    const firstBytes = bytes.subarray(0, session.chunk_size);
    const first = await chunkApi(baseUrl, `/admin/crm/ai-training/content-uploads/${session.id}/chunks/0`, token, firstBytes);
    assert.equal(first.response.status, 201, JSON.stringify(first.payload));
    const duplicate = await chunkApi(baseUrl, `/admin/crm/ai-training/content-uploads/${session.id}/chunks/0`, token, firstBytes);
    assert.equal(duplicate.response.status, 200, JSON.stringify(duplicate.payload));
    assert.equal(duplicate.payload.deduplicated, true);

    const incomplete = await jsonApi(baseUrl, `/admin/crm/ai-training/content-uploads/${session.id}/finalize`, { method: "POST", token, body: {} });
    assert.equal(incomplete.response.status, 409, JSON.stringify(incomplete.payload));
    const status = await jsonApi(baseUrl, `/admin/crm/ai-training/content-uploads/${session.id}`, { token });
    assert.equal(status.response.status, 200, JSON.stringify(status.payload));
    assert.deepEqual(status.payload.upload.missing_ranges, [{ start: 1, end: 2 }]);

    for (let index = 1; index < session.chunk_count; index += 1) {
      const start = index * session.chunk_size;
      const chunk = bytes.subarray(start, Math.min(bytes.length, start + session.chunk_size));
      const result = await chunkApi(baseUrl, `/admin/crm/ai-training/content-uploads/${session.id}/chunks/${index}`, token, chunk);
      assert.equal(result.response.status, 201, JSON.stringify(result.payload));
    }
    const finalized = await jsonApi(baseUrl, `/admin/crm/ai-training/content-uploads/${session.id}/finalize`, { method: "POST", token, body: {} });
    assert.equal(finalized.response.status, 200, JSON.stringify(finalized.payload));
    assert.equal(finalized.payload.sha256, digest);
    assert.equal(finalized.payload.upload.status, "finalized");
    const aylaWrongOwnerBundle = await jsonApi(baseUrl, "/admin/crm/ai-training/content-imports/missing-parent/media-bundle/import-draft", {
      method: "POST", adminToken: "operations-ayla-admin-token", body: { upload_id: session.id },
    });
    assert.equal(aylaWrongOwnerBundle.response.status, 401, JSON.stringify(aylaWrongOwnerBundle.payload));

    const operations = await jsonApi(baseUrl, "/admin/crm/operations/content-jobs", { token });
    assert.equal(operations.response.status, 200, JSON.stringify(operations.payload));
    assert.equal(operations.payload.upload_summary.counts.finalized, 1);
    assert.equal(operations.payload.registry_jobs, null);
    assert.match(operations.payload.registry_error, /DATABASE_URL/);
    assert.doesNotMatch(JSON.stringify(operations.payload), new RegExp(dataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const storage = await jsonApi(baseUrl, "/admin/crm/operations/storage-performance", { token });
    assert.equal(storage.response.status, 200, JSON.stringify(storage.payload));
    assert.equal(storage.payload.safety.binary_uploads_in_postgres, false);
    assert.equal(storage.payload.safety.question_imports_run_in_student_requests, false);
    assert.equal(storage.payload.safety.correct_answers_server_only_until_submission, true);
    assert.equal(storage.payload.storage.databases.lms.exists, true);
    assert.equal(JSON.stringify(storage.payload).includes("v217-lms-secret"), false);

    const cancelled = await jsonApi(baseUrl, `/admin/crm/ai-training/content-uploads/${session.id}`, { method: "DELETE", token });
    assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.payload));
    assert.equal(cancelled.payload.upload.status, "cancelled");
    assert.equal(await fs.readFile(livePath, "utf8"), liveOriginal);
    assert.equal(await fs.readFile(crmPath, "utf8"), crmOriginal);
    assert.equal(await fs.readFile(aylaPath, "utf8"), aylaOriginal);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
