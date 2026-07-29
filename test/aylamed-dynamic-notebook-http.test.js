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
    if (child.exitCode !== null) throw new Error(`Smoke server exited early (${child.exitCode})\n${output.join("")}`);
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

async function api(baseUrl, route, { method = "GET", token = "", body = null, headers = {} } = {}) {
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

test("isolated HTTP flow captures exact pages and timestamps, is idempotent, and hides revoked source text", { timeout: 30000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aylamed-v212-http-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const crmPath = path.join(dataDir, "crm-db.json");
  const aylaPath = path.join(dataDir, "aylamed-db.json");
  const password = "NotebookSmoke9!";
  const now = "2020-01-01T00:00:00.000Z";
  const future = "2030-07-20T00:00:00.000Z";
  const liveSentinel = JSON.stringify({ sentinel: "lms-untouched-v212" });
  const crmSentinel = JSON.stringify({ sentinel: "crm-untouched-v212", ai_training_documents: [], ai_training_items: [] });
  const aylaDb = {
    schema_version: 6,
    qbank_state_version: 0,
    aylaUsers: {
      "user-1": {
        id: "user-1",
        email: "notebook-smoke@example.com",
        name: "Notebook Smoke",
        role: "student",
        status: "active",
        studentId: "student-1",
        activeExamTrackId: "usmle_step_1",
        authVersion: 1,
        ...passwordRecord(password),
        createdAt: now,
        updatedAt: now,
      },
    },
    aylaStudents: {
      "student-1": {
        id: "student-1",
        ayla_user_id: "user-1",
        user_id: "user-1",
        name: "Notebook Smoke",
        examTrackId: "usmle_step_1",
        exam: "USMLE Step 1",
        selectedResourceTypes: ["book", "reading", "vimeo_video"],
        createdAt: now,
        updatedAt: now,
      },
    },
    aylaPlans: {
      "plan-1": {
        id: "plan-1",
        name: "Full Test Access",
        status: "active",
        is_active: true,
        is_full_access: true,
        exam_tracks: ["usmle_step_1"],
        included_features: ["dynamic_notebook", "library", "content_hub", "qbank", "assessments", "revision", "roadmap"],
      },
    },
    aylaEnrollments: {
      "enrollment-1": {
        id: "enrollment-1",
        user_id: "user-1",
        ayla_user_id: "user-1",
        student_id: "student-1",
        plan_id: "plan-1",
        exam_track_id: "usmle_step_1",
        exam_track: "usmle-step-1",
        type: "paid",
        status: "active",
        access_granted: true,
        access_starts_at: now,
        access_expires_at: future,
        createdAt: now,
        updatedAt: now,
      },
    },
    aylaResources: {
      "reading-1": {
        id: "reading-1",
        type: "book",
        title: "Cardiac murmurs",
        description: "Exact approved reading",
        examTrackId: "usmle_step_1",
        examTrack: "USMLE Step 1",
        system: "Cardiovascular",
        topic: "Murmurs",
        bookTitle: "Authorized Review Book",
        pdfPageStart: 12,
        pdfPageEnd: 12,
        printedPageStart: 8,
        printedPageEnd: 8,
        authorizationStatus: "licensed",
        verificationStatus: "approved_ai_training_center",
        approved: true,
        status: "active",
        sourceLabelVisible: false,
        sourceLabel: "Hidden Publisher",
        readerPages: [{ pdfPage: 12, printedPage: 8, text: "Canonical approved murmur page text.", complete: true }],
      },
      "reading-nclex": {
        id: "reading-nclex",
        type: "book",
        title: "NCLEX isolation",
        examTrackId: "nclex",
        examTrack: "NCLEX",
        system: "Safety",
        topic: "Isolation",
        pdfPageStart: 1,
        pdfPageEnd: 1,
        authorizationStatus: "licensed",
        verificationStatus: "approved",
        approved: true,
        status: "active",
        readerPages: [{ pdfPage: 1, printedPage: 1, text: "Wrong-exam source.", complete: true }],
      },
      "video-1": {
        id: "video-1",
        type: "vimeo_video",
        title: "Murmur timing",
        examTrackId: "usmle_step_1",
        examTrack: "USMLE Step 1",
        system: "Cardiovascular",
        topic: "Murmurs",
        vimeoId: "123456789",
        durationSeconds: 600,
        authorizationStatus: "licensed",
        verificationStatus: "admin_verified",
        approved: true,
        status: "active",
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
      AYLA_AUTH_JWT_SECRET: "v212-isolated-smoke-secret",
      AUTH_JWT_SECRET: "v212-isolated-lms-secret",
      AYLA_ADMIN_TOKEN: "v212-isolated-admin",
      NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false",
      ZOOM_RECORDING_RECOVERY_ENABLED: "false",
      DATABASE_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    await waitForHealth(baseUrl, child, output);
    const login = await api(baseUrl, "/api/ayla/auth/login", {
      method: "POST",
      body: { email: "notebook-smoke@example.com", password },
    });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    const token = login.payload.token;

    const libraryCaptureBody = {
      source: {
        sourceType: "library_page",
        resourceId: "reading-1",
        pageKey: "pdf:12",
        sourceExcerpt: "approved murmur page",
      },
      noteText: "My own murmur mnemonic.",
    };
    const first = await api(baseUrl, "/api/ayla/students/student-1/notebooks/capture", {
      method: "POST",
      token,
      body: libraryCaptureBody,
    });
    assert.equal(first.response.status, 201, JSON.stringify(first.payload));
    assert.equal(first.payload.idempotentReplay, false);
    assert.equal(first.payload.notebook.blocks[0].text, "approved murmur page");
    assert.equal(first.payload.notebook.blocks[0].returnLink.href, "/dashboard/library/reading-1/page/pdf%3A12");
    assert.equal(first.payload.notebook.blocks[0].visualStyle, "clean");
    assert.equal(first.payload.notebook.blocks[1].visualStyle, "handwriting");
    assert.doesNotMatch(JSON.stringify(first.payload), /Hidden Publisher|Authorized Review Book|sourceUrl|vimeoId|providerVideoId|player\.vimeo/i);

    const replay = await api(baseUrl, "/api/ayla/students/student-1/notebooks/capture", {
      method: "POST",
      token,
      body: libraryCaptureBody,
    });
    assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
    assert.equal(replay.payload.idempotentReplay, true);
    assert.equal(replay.payload.notebook.id, first.payload.notebook.id);
    assert.equal(replay.payload.notebook.blocks.length, 2);

    const video = await api(baseUrl, "/api/ayla/students/student-1/notebooks/capture", {
      method: "POST",
      token,
      body: {
        notebookId: first.payload.notebook.id,
        pageId: "page-two",
        source: { sourceType: "content_video", resourceId: "video-1", timestampSeconds: 83 },
        noteText: "Opening snap occurs after S2.",
      },
    });
    assert.equal(video.response.status, 201, JSON.stringify(video.payload));
    const videoBlock = video.payload.notebook.blocks.find((block) => block.sourceType === "content_video");
    assert.equal(videoBlock.returnLink.href, "/dashboard/content-hub/video-1?t=83");
    assert.equal(videoBlock.timestampLabel, "1:23");
    assert.equal(videoBlock.pageId, "page-two");
    assert.doesNotMatch(JSON.stringify(video.payload), /123456789|vimeoId|providerVideoId|player\.vimeo/i);

    const outsideDuration = await api(baseUrl, "/api/ayla/students/student-1/notebooks/capture", {
      method: "POST",
      token,
      body: { source: { sourceType: "content_video", resourceId: "video-1", timestampSeconds: 601 } },
    });
    assert.equal(outsideDuration.response.status, 409, JSON.stringify(outsideDuration.payload));

    const forgedExcerpt = await api(baseUrl, "/api/ayla/students/student-1/notebooks/capture", {
      method: "POST",
      token,
      body: { source: { sourceType: "library_page", resourceId: "reading-1", pageKey: "pdf:12", sourceExcerpt: "fabricated correct answer" } },
    });
    assert.equal(forgedExcerpt.response.status, 409, JSON.stringify(forgedExcerpt.payload));

    const wrongExam = await api(baseUrl, "/api/ayla/students/student-1/notebooks/capture", {
      method: "POST",
      token,
      body: { source: { sourceType: "library_page", resourceId: "reading-nclex", pageKey: "pdf:1" } },
    });
    assert.equal(wrongExam.response.status, 404, JSON.stringify(wrongExam.payload));

    const revoke = await api(baseUrl, "/api/ayla/resources/reading-1", {
      method: "PUT",
      headers: { "x-ayla-admin-token": "v212-isolated-admin" },
      body: { status: "disabled" },
    });
    assert.equal(revoke.response.status, 200, JSON.stringify(revoke.payload));
    const afterRevocation = await api(baseUrl, "/api/ayla/students/student-1/notebooks", { token });
    assert.equal(afterRevocation.response.status, 200, JSON.stringify(afterRevocation.payload));
    const revokedBlock = afterRevocation.payload.notebooks[0].blocks.find((block) => block.sourceType === "library_page");
    assert.equal(revokedBlock.sourceState, "unavailable");
    assert.equal(revokedBlock.text, "");
    assert.equal(revokedBlock.returnLink, null);
    assert.ok(afterRevocation.payload.notebooks[0].blocks.some((block) => block.text === "My own murmur mnemonic."));

    const stored = JSON.parse(await fs.readFile(aylaPath, "utf8"));
    const storedNotebook = Object.values(stored.aylaNotebooks).find((row) => row.id === first.payload.notebook.id);
    const storedVideo = storedNotebook.blocks.find((block) => block.source?.kind === "content_video");
    assert.equal(storedVideo.source.providerVideoId, "123456789");
    assert.equal(storedVideo.source.timestampSeconds, 83);
    assert.equal(await fs.readFile(livePath, "utf8"), liveSentinel);
    assert.equal(await fs.readFile(crmPath, "utf8"), crmSentinel);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 1500).unref();
    });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
