import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function passwordRecord(password, salt = "recordingcleanup123456789012345") {
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
    if (child.exitCode !== null) throw new Error(`Recording cleanup server exited (${child.exitCode})\n${output.join("")}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Recording cleanup server health timeout\n${output.join("")}`);
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

test("Day 9 cleanup preserves the keeper and atomically hides only exact zero-duration legacy-key clones", { timeout: 70_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "recording-duplicate-cleanup-http-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const crmPath = path.join(dataDir, "crm-db.json");
  const aylaPath = path.join(dataDir, "aylamed-db.json");
  const courseId = "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c";
  const sessionId = "f756c0fc-3812-421f-880f-d294a60e73a2";
  const roadmapDayId = `${courseId}:day:9:test`;
  const keeperKey = `zoom-recording:3894929704:keeper:${"K".repeat(220)}`;
  const cloneKeys = Array.from({ length: 4 }, (_, index) =>
    `zoom-recording:85288179974:clone-${index + 1}:${"C".repeat(220)}`
  );
  const unpublishedFragmentKey = `zoom-recording:85288179974:fragment:${"F".repeat(220)}`;
  const password = "RecordingCleanup9!";
  const now = new Date().toISOString();
  const title = "Cardiology — Day 9 — FA 2026 pp. 315–318";

  const recordings = {
    [keeperKey]: {
      id: keeperKey,
      recording_key: keeperKey,
      meeting_id: "3894929704",
      uuid: "keeper-uuid",
      course_id: courseId,
      session_id: sessionId,
      roadmap_day_id: roadmapDayId,
      topic: title,
      start_time: "2026-07-15T17:00:00.000Z",
      duration: 46,
      recording_url: "https://zoom.example/day9-keeper",
      share_url: "https://zoom.example/day9-keeper",
      published: true,
      published_at: now,
    },
    [unpublishedFragmentKey]: {
      id: unpublishedFragmentKey,
      recording_key: unpublishedFragmentKey,
      meeting_id: "85288179974",
      course_id: courseId,
      session_id: sessionId,
      topic: title,
      start_time: "2026-07-15T17:30:00.000Z",
      duration: 20,
      recording_url: "https://zoom.example/day9-unpublished-fragment",
      published: false,
    },
  };
  for (const [index, cloneKey] of cloneKeys.entries()) {
    recordings[cloneKey] = {
      id: cloneKey,
      recording_key: cloneKey,
      meeting_id: "85288179974",
      uuid: `clone-uuid-${index + 1}`,
      course_id: courseId,
      session_id: sessionId,
      roadmap_day_id: roadmapDayId,
      topic: title,
      start_time: "2026-07-15T18:00:00.000Z",
      duration: 0,
      recording_url: `https://zoom.example/day9-clone-${index + 1}`,
      share_url: `https://zoom.example/day9-clone-${index + 1}`,
      published: true,
    };
  }

  const liveDb = {
    sentinel: "recording-cleanup-sentinel",
    users: {
      admin: {
        id: "admin",
        email: "recording-cleanup-admin@example.com",
        name: "Recording Cleanup Admin",
        role: "admin",
        status: "active",
        verified: true,
        ...passwordRecord(password),
        created_at: now,
        updated_at: now,
      },
    },
    courses: {
      [courseId]: { id: courseId, name: "120-Day USMLE Step 1 Marathon", status: "active", is_active: true },
    },
    roadmaps: {
      [courseId]: {
        id: `roadmap:${courseId}`,
        course_id: courseId,
        days: [{
          id: roadmapDayId,
          course_id: courseId,
          system: "Cardiology",
          system_day: 9,
          day_number: 9,
          date: "2026-07-15",
          live_session_id: sessionId,
          title,
        }],
      },
    },
    liveSessions: {
      [sessionId]: {
        id: sessionId,
        course_id: courseId,
        roadmap_day_id: roadmapDayId,
        title,
        topic: title,
        system: "Cardiology",
        system_day: 9,
        day_number: 9,
        scheduled_date: "2026-07-15",
        scheduled_time: "13:00",
        status: "completed",
        recording_key: cloneKeys[3],
        recording_url: "https://zoom.example/day9-clone-4",
        recording_published: true,
      },
    },
    recordings,
    notes: {
      [sessionId]: {
        id: sessionId,
        session_id: sessionId,
        course_id: courseId,
        notes: "Preserve the real Day 9 notes text",
        recording_key: cloneKeys[3],
        recording_url: "https://zoom.example/day9-clone-4",
        recording_published: true,
      },
    },
    attendance: {},
    enrollments: { sentinel: { id: "sentinel", course_id: courseId, user_id: "student-1", status: "active" } },
    payments: { sentinel: { id: "sentinel", course_id: courseId, user_id: "student-1", status: "paid" } },
    assessmentAttempts: { sentinel: { id: "sentinel", user_id: "student-1", score: 80 } },
    pointEvents: { sentinel: { id: "sentinel", user_id: "student-1", points: 10 } },
  };
  const crmOriginal = JSON.stringify({ sentinel: "crm-untouched-recording-cleanup" });
  const aylaOriginal = JSON.stringify({ sentinel: "ayla-untouched-recording-cleanup" });
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
      AUTH_JWT_SECRET: "recording-cleanup-secret",
      AYLA_AUTH_JWT_SECRET: "recording-cleanup-ayla-secret",
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
    assert.equal(health.payload.recording_duplicate_cleanup_build, "v223-safe-recording-duplicate-cleanup");

    const login = await api(baseUrl, "/auth/login", {
      method: "POST",
      body: { email: "recording-cleanup-admin@example.com", password },
    });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    const token = login.payload.token;

    const requestBody = {
      course_id: courseId,
      session_id: sessionId,
      expected_session_date: "2026-07-15",
      keeper_recording_key: keeperKey,
      clone_recording_keys: cloneKeys,
      expected_keeper_meeting_id: "3894929704",
      expected_clone_meeting_id: "85288179974",
    };

    const beforeRejectedRequest = await fs.readFile(livePath, "utf8");
    const rejected = await api(baseUrl, "/admin/recordings/cleanup-session-duplicates", {
      method: "POST",
      token,
      body: { ...requestBody, confirm: "WRONG_CONFIRMATION" },
    });
    assert.equal(rejected.response.status, 400, JSON.stringify(rejected.payload));
    assert.equal(await fs.readFile(livePath, "utf8"), beforeRejectedRequest);

    const cleaned = await api(baseUrl, "/admin/recordings/cleanup-session-duplicates", {
      method: "POST",
      token,
      body: { ...requestBody, confirm: "CLEANUP_SESSION_RECORDING_DUPLICATES" },
    });
    assert.equal(cleaned.response.status, 200, JSON.stringify(cleaned.payload));
    assert.equal(cleaned.payload.recording_duplicate_cleanup_build, "v223-safe-recording-duplicate-cleanup");
    assert.equal(cleaned.payload.keeper_recording_key, keeperKey);
    assert.deepEqual(cleaned.payload.clone_recording_keys, cloneKeys);
    assert.equal(cleaned.payload.clones_hidden, 4);
    assert.equal(cleaned.payload.recordings_deleted, 0);
    assert.equal(cleaned.payload.live_sessions_deleted, 0);
    assert.equal(cleaned.payload.roadmap_days_deleted, 0);
    assert.equal(cleaned.payload.notes_deleted, 0);
    assert.equal(cleaned.payload.users_deleted, 0);
    assert.equal(cleaned.payload.payments_deleted, 0);

    const saved = JSON.parse(await fs.readFile(livePath, "utf8"));
    assert.equal(Object.keys(saved.recordings).length, 6, "Every recording row must be preserved");
    assert.ok(saved.recordings[keeperKey]);
    assert.equal(saved.recordings[keeperKey].published, true);
    assert.equal(saved.recordings[keeperKey].hidden_from_recordings, false);
    assert.equal(saved.recordings[keeperKey].session_id, sessionId);
    assert.equal(saved.recordings[keeperKey].recording_url, "https://zoom.example/day9-keeper");

    for (const [index, cloneKey] of cloneKeys.entries()) {
      assert.ok(saved.recordings[cloneKey], `Clone ${index + 1} metadata must be preserved`);
      assert.equal(saved.recordings[cloneKey].recording_url, `https://zoom.example/day9-clone-${index + 1}`);
      assert.equal(saved.recordings[cloneKey].published, false);
      assert.equal(saved.recordings[cloneKey].hidden_from_recordings, true);
      assert.equal(saved.recordings[cloneKey].auto_publish_disabled, true);
      assert.equal(saved.recordings[cloneKey].session_id, null);
      assert.equal(saved.recordings[cloneKey].detached_from_session_id, sessionId);
    }

    assert.ok(saved.recordings[unpublishedFragmentKey], "Unselected unpublished fragment must remain untouched");
    assert.equal(saved.recordings[unpublishedFragmentKey].published, false);
    assert.equal(saved.recordings[unpublishedFragmentKey].hidden_from_recordings, undefined);

    assert.ok(saved.liveSessions[sessionId]);
    assert.equal(saved.liveSessions[sessionId].recording_key, keeperKey);
    assert.equal(saved.liveSessions[sessionId].recording_url, "https://zoom.example/day9-keeper");
    assert.equal(saved.liveSessions[sessionId].recording_published, true);
    assert.ok(saved.roadmaps[courseId].days.some((day) => day.id === roadmapDayId));

    assert.ok(saved.notes[sessionId]);
    assert.equal(saved.notes[sessionId].notes, "Preserve the real Day 9 notes text");
    assert.equal(saved.notes[sessionId].recording_key, keeperKey);
    assert.equal(saved.notes[sessionId].recording_url, "https://zoom.example/day9-keeper");
    assert.equal(saved.notes[sessionId].recording_published, true);

    assert.ok(saved.users.admin);
    assert.ok(saved.enrollments.sentinel);
    assert.ok(saved.payments.sentinel);
    assert.ok(saved.assessmentAttempts.sentinel);
    assert.ok(saved.pointEvents.sentinel);
    assert.equal(saved.sentinel, "recording-cleanup-sentinel");

    const visibleAdminRecordings = await api(
      baseUrl,
      `/live/recordings?course_id=${encodeURIComponent(courseId)}`,
      { token }
    );
    assert.equal(visibleAdminRecordings.response.status, 200, JSON.stringify(visibleAdminRecordings.payload));
    assert.equal(
      visibleAdminRecordings.payload.recordings.filter((recording) => cloneKeys.includes(recording.recording_key)).length,
      0
    );
    assert.equal(
      visibleAdminRecordings.payload.recordings.some((recording) => recording.recording_key === keeperKey),
      true
    );

    const hiddenAdminRecordings = await api(
      baseUrl,
      `/live/recordings?course_id=${encodeURIComponent(courseId)}&include_hidden=true`,
      { token }
    );
    assert.equal(hiddenAdminRecordings.response.status, 200, JSON.stringify(hiddenAdminRecordings.payload));
    assert.equal(
      hiddenAdminRecordings.payload.recordings.filter((recording) => cloneKeys.includes(recording.recording_key)).length,
      4
    );

    const backupStat = await fs.stat(cleaned.payload.backup_path);
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
