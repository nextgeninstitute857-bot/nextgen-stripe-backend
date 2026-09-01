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
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl, child, output, timeoutMs = 25_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Notes server exited (${child.exitCode})\n${output.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return response.json();
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Notes health timeout\n${output.join("")}`);
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

test("manual Day 10 edits publish the corrected content and assessment scopes expose week/system/all notes", { timeout: 80_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-notes-publish-http-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const crmPath = path.join(dataDir, "crm-db.json");
  const aylaPath = path.join(dataDir, "aylamed-db.json");
  const courseId = "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c";
  const adminPassword = "NotesAdmin10!";
  const studentPassword = "NotesStudent10!";
  const now = "2026-07-31T00:00:00.000Z";
  const future = "2027-07-31T00:00:00.000Z";
  const corrected = "# Cardiology Day 10\n\n## 1. Corrected Topic\n\n- **Corrected point** from the tutor.".repeat(5);

  const days = [
    { id: "day-cardio-10", sessionId: "session-cardio-10", day: 10, week: 2, system: "Cardiology", date: "2026-07-16" },
    { id: "day-cardio-11", sessionId: "session-cardio-11", day: 11, week: 2, system: "Cardiology", date: "2026-07-17" },
    { id: "day-msk-1", sessionId: "session-msk-1", day: 17, systemDay: 1, week: 3, system: "MSK", date: "2026-07-25" },
  ];

  const roadmapDays = days.map((row) => ({
    id: row.id,
    course_id: courseId,
    live_session_id: row.sessionId,
    session_id: row.sessionId,
    day_number: row.day,
    instructional_day_number: row.day,
    system_day: row.systemDay || row.day,
    week_number: row.week,
    system: row.system,
    date: row.date,
    scheduled_date: row.date,
    title: `${row.system} — Day ${row.systemDay || row.day}`,
    status: "completed",
  }));
  const liveSessions = Object.fromEntries(days.map((row) => [row.sessionId, {
    id: row.sessionId,
    course_id: courseId,
    roadmap_day_id: row.id,
    day_number: row.day,
    instructional_day_number: row.day,
    system_day: row.systemDay || row.day,
    week_number: row.week,
    system: row.system,
    scheduled_date: row.date,
    scheduled_time: "13:00",
    title: `${row.system} — Day ${row.systemDay || row.day}`,
    topic: `${row.system} — Day ${row.systemDay || row.day}`,
    status: "completed",
  }]));

  const publishedCardio = "# Cardiology Day 11\n\n" + "Published cardiology teaching point. ".repeat(20);
  const publishedMsk = "# MSK Day 1\n\n" + "Published musculoskeletal teaching point. ".repeat(20);
  const liveDb = {
    sentinel: "notes-publish-sentinel",
    users: {
      admin: {
        id: "admin",
        email: "notes-admin@example.com",
        name: "Notes Admin",
        role: "admin",
        status: "active",
        verified: true,
        ...passwordRecord(adminPassword, "notesadminsalt123456789012345"),
      },
      student: {
        id: "student",
        email: "notes-student@example.com",
        name: "Notes Student",
        role: "student",
        status: "active",
        verified: true,
        ...passwordRecord(studentPassword, "notesstudentsalt1234567890123"),
      },
    },
    courses: {
      [courseId]: { id: courseId, name: "120-Day USMLE Step 1 Marathon", status: "active", is_active: true },
    },
    roadmaps: {
      [courseId]: {
        id: `roadmap:${courseId}`,
        course_id: courseId,
        days: roadmapDays,
      },
    },
    liveSessions,
    notes: {
      "session-cardio-10": {
        id: "session-cardio-10",
        session_id: "session-cardio-10",
        course_id: courseId,
        roadmap_day_id: "day-cardio-10",
        notes: "Old editor text",
        cleaned_notes: "Stale generated text shown to students",
        student_notes: "Stale generated text shown to students",
        published: false,
        is_published: false,
        status: "draft",
        created_at: now,
        updated_at: now,
      },
      "session-cardio-11": {
        id: "session-cardio-11",
        session_id: "session-cardio-11",
        course_id: courseId,
        roadmap_day_id: "day-cardio-11",
        notes: publishedCardio,
        cleaned_notes: publishedCardio,
        student_notes: publishedCardio,
        published: true,
        is_published: true,
        status: "published",
        created_at: now,
        updated_at: now,
      },
      "session-msk-1": {
        id: "session-msk-1",
        session_id: "session-msk-1",
        course_id: courseId,
        roadmap_day_id: "day-msk-1",
        notes: publishedMsk,
        cleaned_notes: publishedMsk,
        student_notes: publishedMsk,
        published: true,
        is_published: true,
        status: "published",
        created_at: now,
        updated_at: now,
      },
    },
    recordings: {},
    enrollments: {
      paid: {
        id: "paid",
        user_id: "student",
        course_id: courseId,
        type: "paid",
        status: "paid",
        is_demo: false,
        access_granted: true,
        paid_at: now,
        access_expires_at: future,
      },
    },
    payments: {},
    assessments: {},
    assessmentAttempts: {},
    flashcards: {},
    flashcardProgress: {},
    roadmapProgress: {},
    dailyTaskProgress: {},
    pointEvents: {},
    leaderboard: {},
    attendance: {},
  };
  const crmOriginal = JSON.stringify({ sentinel: "crm-untouched-notes-publish" });
  const aylaOriginal = JSON.stringify({ sentinel: "ayla-untouched-notes-publish" });
  await fs.writeFile(livePath, JSON.stringify(liveDb, null, 2));
  await fs.writeFile(crmPath, crmOriginal);
  await fs.writeFile(aylaPath, aylaOriginal);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
      TZ: "UTC",
      DATA_DIR: dataDir,
      AUTH_JWT_SECRET: "notes-publish-secret",
      AYLA_AUTH_JWT_SECRET: "notes-publish-ayla-secret",
      DATABASE_URL: "",
      OPENAI_API_KEY: "",
      NEXTGEN_BACKEND_HEARTBEAT_ENABLED: "false",
      NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false",
      ZOOM_RECORDING_RECOVERY_ENABLED: "false",
      NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED: "false",
      NEXTGEN_EMAIL_QUEUE_DISABLED: "true",
      NEXTGEN_EMAIL_AUTOMATION_DISABLED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    const health = await waitForHealth(baseUrl, child, output);
    assert.equal(health.lms_session_notes_build, "v256-session-notes-publish-invariants");
    assert.equal(health.lms_session_notes.auto_publish_notes, true);
    assert.equal(health.lms_session_notes.auto_publish_recordings, true);
    assert.equal(health.lms_session_notes.auto_publish_session_content, false);
    assert.equal(health.lms_assessment_notes_scope_build, "v257-assessment-notes-scopes");

    const adminLogin = await api(baseUrl, "/auth/login", {
      method: "POST",
      body: { email: "notes-admin@example.com", password: adminPassword },
    });
    assert.equal(adminLogin.response.status, 200, JSON.stringify(adminLogin.payload));
    const adminToken = adminLogin.payload.token;

    const savedDraft = await api(baseUrl, "/live/notes/session-cardio-10", {
      method: "POST",
      token: adminToken,
      body: {
        course_id: courseId,
        notes: corrected,
        published: false,
        is_published: false,
      },
    });
    assert.equal(savedDraft.response.status, 200, JSON.stringify(savedDraft.payload));
    assert.equal(savedDraft.payload.notes.notes, corrected);
    assert.equal(savedDraft.payload.notes.cleaned_notes, corrected);
    assert.equal(savedDraft.payload.notes.student_notes, corrected);
    assert.equal(savedDraft.payload.notes.status, "draft");

    const published = await api(baseUrl, "/live/notes/session-cardio-10/publish", {
      method: "POST",
      token: adminToken,
      body: {},
    });
    assert.equal(published.response.status, 200, JSON.stringify(published.payload));
    assert.equal(published.payload.notes.notes, corrected);
    assert.equal(published.payload.notes.cleaned_notes, corrected);
    assert.equal(published.payload.notes.student_notes, corrected);
    assert.equal(published.payload.notes.status, "published");
    assert.equal(published.payload.notes.published, true);
    assert.equal(published.payload.notes.is_published, true);

    const studentLogin = await api(baseUrl, "/auth/login", {
      method: "POST",
      body: { email: "notes-student@example.com", password: studentPassword },
    });
    assert.equal(studentLogin.response.status, 200, JSON.stringify(studentLogin.payload));
    const studentNote = await api(baseUrl, "/live/notes/session-cardio-10", {
      token: studentLogin.payload.token,
    });
    assert.equal(studentNote.response.status, 200, JSON.stringify(studentNote.payload));
    assert.equal(studentNote.payload.notes.cleaned_notes, corrected);

    const options = await api(
      baseUrl,
      `/admin/assessments/note-source-options?course_id=${encodeURIComponent(courseId)}`,
      { token: adminToken }
    );
    assert.equal(options.response.status, 200, JSON.stringify(options.payload));
    assert.equal(options.payload.build, "v257-assessment-notes-scopes");
    assert.equal(options.payload.total_notes, 3);
    assert.deepEqual(options.payload.scopes.map((item) => item.value), ["week", "system", "all", "selected"]);
    assert.equal(options.payload.systems.find((item) => item.system === "Cardiology")?.note_count, 2);
    assert.equal(options.payload.systems.find((item) => item.system === "MSK")?.note_count, 1);
    assert.equal(options.payload.weeks.find((item) => item.week_number === 2)?.note_count, 2);
    assert.equal(options.payload.weeks.find((item) => item.week_number === 3)?.note_count, 1);

    const saved = JSON.parse(await fs.readFile(livePath, "utf8"));
    assert.equal(saved.notes["session-cardio-10"].cleaned_notes, corrected);
    assert.equal(saved.notes["session-cardio-10"].status, "published");
    assert.equal(saved.roadmaps[courseId].days[0].notes_status, "published");
    assert.equal(saved.sentinel, "notes-publish-sentinel");
    assert.equal(JSON.parse(await fs.readFile(crmPath, "utf8")).sentinel, "crm-untouched-notes-publish");
    assert.equal(await fs.readFile(aylaPath, "utf8"), aylaOriginal);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
