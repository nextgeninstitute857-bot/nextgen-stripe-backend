import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function passwordRecord(password, salt = "recordingdetachsalt123456789012") {
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

async function waitForHealth(baseUrl, child, output, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Recording test server exited (${child.exitCode})\n${output.join("")}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Recording test server health timeout\n${output.join("")}`);
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
  const payload = await response.json();
  return { response, payload };
}

test("wrong unpublished future recording assignment is hidden and detached without deleting data", { timeout: 70_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "recording-detach-http-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const crmPath = path.join(dataDir, "crm-db.json");
  const aylaPath = path.join(dataDir, "aylamed-db.json");
  const courseId = "course-recording-detach";
  const sessionId = "future-msk-day-11";
  const roadmapDayId = "roadmap-msk-day-11";
  const recordingKey = "83497760527";
  const password = "RecordingAdmin9!";
  const now = new Date().toISOString();

  const liveDb = {
    sentinel: "recording-detach-sentinel",
    users: {
      admin: {
        id: "admin",
        email: "recording-admin@example.com",
        name: "Recording Admin",
        role: "admin",
        status: "active",
        verified: true,
        ...passwordRecord(password),
        created_at: now,
        updated_at: now,
      },
    },
    courses: {
      [courseId]: { id: courseId, name: "Recording Detach Course", status: "active", is_active: true },
    },
    roadmaps: {
      [courseId]: {
        id: `roadmap:${courseId}`,
        course_id: courseId,
        days: [{ id: roadmapDayId, course_id: courseId, system: "MSK", system_day: 11, date: "2026-08-01" }],
      },
    },
    liveSessions: {
      [sessionId]: {
        id: sessionId,
        course_id: courseId,
        roadmap_day_id: roadmapDayId,
        title: "MSK — Day 11 — FA 489-492",
        topic: "MSK — Day 11 — FA 489-492",
        system: "MSK",
        system_day: 11,
        scheduled_date: "2026-08-01",
        scheduled_time: "13:00",
        status: "scheduled",
        recording_key: recordingKey,
        recording_url: "https://zoom.example/wrong-recording",
        recording_published: false,
      },
    },
    recordings: {
      [recordingKey]: {
        id: recordingKey,
        recording_key: recordingKey,
        meeting_id: recordingKey,
        course_id: courseId,
        session_id: sessionId,
        roadmap_day_id: null,
        topic: "MSK — Day 11 — FA 489-492",
        start_time: "2026-07-17T16:51:26.079Z",
        recording_url: "https://zoom.example/wrong-recording",
        share_url: "https://zoom.example/wrong-recording",
        published: false,
      },
    },
    notes: {
      [sessionId]: {
        id: sessionId,
        session_id: sessionId,
        course_id: courseId,
        notes: "Preserve this notes text",
        recording_key: recordingKey,
        recording_url: "https://zoom.example/wrong-recording",
        recording_published: false,
      },
    },
    attendance: {},
    enrollments: { sentinel: { id: "sentinel", course_id: courseId, user_id: "student-1", status: "active" } },
    payments: { sentinel: { id: "sentinel", course_id: courseId, user_id: "student-1", status: "paid" } },
    assessmentAttempts: { sentinel: { id: "sentinel", user_id: "student-1", score: 80 } },
    pointEvents: { sentinel: { id: "sentinel", user_id: "student-1", points: 10 } },
  };
  const crmOriginal = JSON.stringify({ sentinel: "crm-untouched-recording-detach" });
  const aylaOriginal = JSON.stringify({ sentinel: "ayla-untouched-recording-detach" });
  await fs.writeFile(livePath, JSON.stringify(liveDb, null, 2));
  await fs.writeFile(crmPath, crmOriginal);
  await fs.writeFile(aylaPath, aylaOriginal);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
    env: {
      ...process.env,
      PORT: String(port),
      TZ: "UTC",
      DATA_DIR: dataDir,
      AUTH_JWT_SECRET: "recording-detach-secret",
      AYLA_AUTH_JWT_SECRET: "recording-detach-ayla-secret",
      DATABASE_URL: "",
      OPENAI_API_KEY: "",
      NEXTGEN_BACKEND_HEARTBEAT_ENABLED: "false",
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
    const health = await api(baseUrl, "/health");
    assert.equal(health.payload.recording_assignment_build, "v222-safe-recording-detach");

    const login = await api(baseUrl, "/auth/login", {
      method: "POST",
      body: { email: "recording-admin@example.com", password },
    });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    const token = login.payload.token;

    const beforeRejectedRequest = await fs.readFile(livePath, "utf8");
    const rejected = await api(baseUrl, "/admin/recordings/detach-assignment", {
      method: "POST",
      token,
      body: {
        recording_key: recordingKey,
        expected_session_id: sessionId,
        expected_start_date: "2026-07-17",
        confirm: "WRONG_CONFIRMATION",
      },
    });
    assert.equal(rejected.response.status, 400, JSON.stringify(rejected.payload));
    assert.equal(await fs.readFile(livePath, "utf8"), beforeRejectedRequest);

    const detached = await api(baseUrl, "/admin/recordings/detach-assignment", {
      method: "POST",
      token,
      body: {
        recording_key: recordingKey,
        expected_session_id: sessionId,
        expected_start_date: "2026-07-17",
        hide: true,
        confirm: "DETACH_RECORDING_ASSIGNMENT",
      },
    });
    assert.equal(detached.response.status, 200, JSON.stringify(detached.payload));
    assert.equal(detached.payload.recording_preserved, true);
    assert.equal(detached.payload.recording_hidden, true);
    assert.equal(detached.payload.live_session_preserved, true);
    assert.equal(detached.payload.recordings_deleted, 0);
    assert.equal(detached.payload.notes_deleted, 0);
    assert.equal(detached.payload.users_deleted, 0);
    assert.equal(detached.payload.payments_deleted, 0);

    const saved = JSON.parse(await fs.readFile(livePath, "utf8"));
    assert.ok(saved.recordings[recordingKey], "Zoom recording metadata must be preserved");
    assert.equal(saved.recordings[recordingKey].recording_url, "https://zoom.example/wrong-recording");
    assert.equal(saved.recordings[recordingKey].session_id, null);
    assert.equal(saved.recordings[recordingKey].roadmap_day_id, null);
    assert.equal(saved.recordings[recordingKey].published, false);
    assert.equal(saved.recordings[recordingKey].hidden_from_recordings, true);
    assert.equal(saved.recordings[recordingKey].auto_publish_disabled, true);
    assert.equal(saved.recordings[recordingKey].detached_from_session_id, sessionId);

    assert.ok(saved.liveSessions[sessionId], "Real future live session must be preserved");
    assert.equal(saved.liveSessions[sessionId].roadmap_day_id, roadmapDayId);
    assert.equal(saved.liveSessions[sessionId].recording_key, null);
    assert.equal(saved.liveSessions[sessionId].recording_url, null);
    assert.ok(saved.roadmaps[courseId].days.some((day) => day.id === roadmapDayId));

    assert.ok(saved.notes[sessionId], "Notes row must be preserved");
    assert.equal(saved.notes[sessionId].notes, "Preserve this notes text");
    assert.equal(saved.notes[sessionId].recording_key, null);
    assert.ok(saved.users.admin);
    assert.ok(saved.enrollments.sentinel);
    assert.ok(saved.payments.sentinel);
    assert.ok(saved.assessmentAttempts.sentinel);
    assert.ok(saved.pointEvents.sentinel);
    assert.equal(saved.sentinel, "recording-detach-sentinel");

    const adminRecordings = await api(baseUrl, `/live/recordings?course_id=${encodeURIComponent(courseId)}`, { token });
    assert.equal(adminRecordings.response.status, 200, JSON.stringify(adminRecordings.payload));
    assert.equal(adminRecordings.payload.recordings.some((recording) => recording.recording_key === recordingKey), false);

    const backupStat = await fs.stat(detached.payload.backup_path);
    assert.ok(backupStat.size > 0);
    assert.equal(await fs.readFile(crmPath, "utf8"), crmOriginal);
    assert.equal(await fs.readFile(aylaPath, "utf8"), aylaOriginal);
  } finally {
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGTERM");
      });
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
