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

function teachingDay({ id, courseId, date, system, systemDay, title, pages, sessionId = null }) {
  return {
    id,
    course_id: courseId,
    date,
    scheduled_date: date,
    system,
    chapter: system,
    system_day: systemDay,
    day_in_system: systemDay,
    title,
    first_aid_pages: pages,
    first_aid_topics: title,
    description: `${title} mapped teaching packet`,
    homework: `${title} follow-up work`,
    resources: ["Live class", "Class notes", "Recording"],
    task_items: [{ key: "live_attendance", id: "live_attendance", label: "Attend live class", points: 10, order: 1, required: true }],
    status: "scheduled",
    roadmap_status: "scheduled",
    live_session_id: sessionId,
    session_id: sessionId,
    is_published: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

test("system-aware roadmap extension recovers reached adjacent days and preserves every academic identity", { timeout: 70_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-extension-http-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const crmPath = path.join(dataDir, "crm-db.json");
  const aylaPath = path.join(dataDir, "aylamed-db.json");
  const courseId = "course-roadmap-extension";
  const password = "RoadmapAdmin9!";
  const now = new Date().toISOString();

  const cardioDays = Array.from({ length: 12 }, (_, index) => teachingDay({
    id: `cardio-${index + 1}`,
    courseId,
    date: dateKey(index - 13),
    system: "Cardiology",
    systemDay: index + 1,
    title: `Cardiology — Day ${index + 1} — FA ${280 + index * 4}-${283 + index * 4}`,
    pages: `${280 + index * 4}-${283 + index * 4}`,
  }));

  const msk1 = teachingDay({
    id: "msk-day-1-reached",
    courseId,
    date: dateKey(-1),
    system: "MSK",
    systemDay: 1,
    title: "MSK — Day 1 — FA 449-452",
    pages: "449-452",
    sessionId: "session-reached-1",
  });
  const msk2 = teachingDay({
    id: "msk-day-2-current",
    courseId,
    date: dateKey(0),
    system: "MSK",
    systemDay: 2,
    title: "MSK — Day 2 — FA 453-456",
    pages: "453-456",
    sessionId: "session-current-2",
  });
  const msk3 = teachingDay({
    id: "msk-day-3-future",
    courseId,
    date: dateKey(1),
    system: "MSK",
    systemDay: 3,
    title: "MSK — Day 3 — FA 457-460",
    pages: "457-460",
    sessionId: "session-future-3",
  });
  const cns1 = teachingDay({
    id: "cns-day-1-future",
    courseId,
    date: dateKey(2),
    system: "Central Nervous System",
    systemDay: 1,
    title: "Central Nervous System — Day 1 — FA 500-503",
    pages: "500-503",
    sessionId: "session-cns-1",
  });

  const days = [...cardioDays, msk1, msk2, msk3, cns1];
  days.forEach((day, index) => {
    day.order = index + 1;
    day.day_number = index + 1;
    day.instructional_day_number = index + 1;
    day.schedule_slot_number = index + 1;
    day.week_number = Math.ceil((index + 1) / 7);
  });

  const liveDb = {
    sentinel: "roadmap-extension-sentinel",
    users: {
      admin: {
        id: "admin",
        email: "roadmap-admin@example.com",
        name: "Roadmap Admin",
        role: "admin",
        status: "active",
        verified: true,
        ...passwordRecord(password),
        created_at: now,
        updated_at: now,
      },
    },
    courses: {
      [courseId]: { id: courseId, name: "Roadmap Extension Course", status: "active", is_active: true },
    },
    roadmaps: {
      [courseId]: {
        id: `roadmap:${courseId}`,
        course_id: courseId,
        course_name: "Roadmap Extension Course",
        start_date: days[0].date,
        skip_sundays: false,
        settings: { start_date: days[0].date, skip_sundays: false, class_time: "13:00", timezone: "America/New_York" },
        days,
        created_at: now,
        updated_at: now,
      },
    },
    liveSessions: {
      "session-reached-1": {
        id: "session-reached-1", course_id: courseId, roadmap_day_id: msk1.id,
        scheduled_date: msk1.date, scheduled_time: "13:00", title: msk1.title, topic: msk1.title,
        system: "MSK", system_day: 1, day_number: 13, status: "completed", zoom_meeting_id: "zoom-reached-1",
        created_at: now, updated_at: now,
      },
      "session-current-2": {
        id: "session-current-2", course_id: courseId, roadmap_day_id: msk2.id,
        scheduled_date: msk2.date, scheduled_time: "13:00", title: msk2.title, topic: msk2.title,
        system: "MSK", system_day: 2, day_number: 14, status: "scheduled",
        created_at: now, updated_at: now,
      },
      "session-future-3": {
        id: "session-future-3", course_id: courseId, roadmap_day_id: msk3.id,
        scheduled_date: msk3.date, scheduled_time: "13:00", title: msk3.title, topic: msk3.title,
        system: "MSK", system_day: 3, day_number: 15, status: "scheduled",
        created_at: now, updated_at: now,
      },
      "session-cns-1": {
        id: "session-cns-1", course_id: courseId, roadmap_day_id: cns1.id,
        scheduled_date: cns1.date, scheduled_time: "13:00", title: cns1.title, topic: cns1.title,
        system: "Central Nervous System", system_day: 1, day_number: 16, status: "scheduled",
        created_at: now, updated_at: now,
      },
    },
    notes: {
      "note-reached": { id: "note-reached", course_id: courseId, session_id: "session-reached-1", roadmap_day_id: msk1.id, title: "Actual reached-day notes", updated_at: now },
    },
    recordings: {
      "recording-reached": { id: "recording-reached", course_id: courseId, session_id: "session-reached-1", roadmap_day_id: msk1.id, topic: "Actual reached-day recording", published: true, updated_at: now },
    },
    attendance: {
      "attendance-reached": { id: "attendance-reached", course_id: courseId, session_id: "session-reached-1", roadmap_day_id: msk1.id, user_id: "student-1", status: "present", updated_at: now },
    },
    assessments: {
      "future-msk-assessment": {
        id: "future-msk-assessment", course_id: courseId, session_id: "session-future-3", roadmap_day_id: msk3.id,
        title: "MSK — Day 3 check", system: "MSK", system_day: 3, day_number: 15,
        due_date: msk3.date, is_published: false, questions: [], created_at: now, updated_at: now,
      },
    },
    assessmentAttempts: {},
    flashcards: {},
    flashcardProgress: {},
    roadmapProgress: {
      sentinel: { id: "sentinel", course_id: courseId, user_id: "student-1", day_id: cardioDays[0].id, completed: true },
    },
    dailyTaskProgress: {},
    pointEvents: {
      sentinel: { id: "sentinel", course_id: courseId, user_id: "student-1", roadmap_day_id: cardioDays[0].id, points: 10 },
    },
    weakConceptLogs: {},
    leaderboard: {
      sentinel: { id: "sentinel", course_id: courseId, user_id: "student-1", total_points: 10 },
    },
    enrollments: { sentinel: { id: "sentinel", course_id: courseId, user_id: "student-1", status: "active" } },
    payments: { sentinel: { id: "sentinel", course_id: courseId, user_id: "student-1", status: "paid" } },
  };
  const crmOriginal = JSON.stringify({ sentinel: "crm-untouched-roadmap-extension" });
  const aylaOriginal = JSON.stringify({ sentinel: "ayla-untouched-roadmap-extension" });
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
      AUTH_JWT_SECRET: "roadmap-extension-secret",
      AYLA_AUTH_JWT_SECRET: "roadmap-extension-ayla-secret",
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
    const login = await api(baseUrl, "/auth/login", {
      method: "POST",
      body: { email: "roadmap-admin@example.com", password },
    });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    const token = login.payload.token;
    const beforePreview = await fs.readFile(livePath, "utf8");
    const requestBody = {
      course_id: courseId,
      system: "Cardiology",
      after_day_id: cardioDays[11].id,
      count: 4,
      quick_add: true,
      reuse_adjacent_started_days: 2,
      days: [{}, {}, {}, {}],
    };

    const preview = await api(baseUrl, "/admin/roadmap/extend-system", {
      method: "POST",
      token,
      body: { ...requestBody, dry_run: true },
    });
    assert.equal(preview.response.status, 200, JSON.stringify(preview.payload));
    assert.equal(preview.payload.dry_run, true);
    assert.equal(preview.payload.applied, false);
    assert.equal(preview.payload.added_system_days, 4);
    assert.equal(preview.payload.roadmap_days_added, 4);
    assert.equal(preview.payload.reused_adjacent_started_days, 2);
    assert.equal(preview.payload.inserted_days.length, 4);
    assert.deepEqual(preview.payload.inserted_days.map((day) => day.system_day), [13, 14, 15, 16]);
    assert.equal(preview.payload.reassigned_existing_days[0].before.system, "MSK");
    assert.equal(preview.payload.reassigned_existing_days[0].after.system, "Cardiology");
    assert.deepEqual(preview.payload.restored_displaced_days.map((day) => day.system_day), [1, 2]);
    assert.match(preview.payload.restored_displaced_days[0].title, /MSK.*Day 1/i);
    assert.equal(await fs.readFile(livePath, "utf8"), beforePreview, "dry-run must not write the LMS database");

    const stale = await api(baseUrl, "/admin/roadmap/extend-system", {
      method: "POST",
      token,
      body: {
        ...requestBody,
        dry_run: false,
        confirm: "EXTEND_SYSTEM_ROADMAP",
        expected_roadmap_updated_at: "stale-preview-version",
      },
    });
    assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));
    assert.match(stale.payload.error, /changed after preview/i);
    assert.equal(await fs.readFile(livePath, "utf8"), beforePreview, "stale preview must not write the LMS database");

    const applied = await api(baseUrl, "/admin/roadmap/extend-system", {
      method: "POST",
      token,
      body: {
        ...requestBody,
        dry_run: false,
        confirm: "EXTEND_SYSTEM_ROADMAP",
        expected_roadmap_updated_at: preview.payload.roadmap_updated_at,
      },
    });
    assert.equal(applied.response.status, 200, JSON.stringify(applied.payload));
    assert.equal(applied.payload.applied, true);
    assert.equal(applied.payload.added_system_days, 4);
    assert.equal(applied.payload.reused_adjacent_started_days, 2);
    assert.equal(applied.payload.users_deleted, 0);
    assert.equal(applied.payload.attempts_deleted, 0);
    assert.equal(applied.payload.recordings_deleted, 0);
    assert.equal(applied.payload.points_deleted, 0);

    const saved = JSON.parse(await fs.readFile(livePath, "utf8"));
    const savedRoadmap = saved.roadmaps[courseId];
    assert.equal(savedRoadmap.days.length, days.length + 4);
    for (const originalDay of days) {
      assert.ok(savedRoadmap.days.some((day) => day.id === originalDay.id), `Original day identity lost: ${originalDay.id}`);
    }

    const recovered13 = savedRoadmap.days.find((day) => day.id === msk1.id);
    const recovered14 = savedRoadmap.days.find((day) => day.id === msk2.id);
    assert.equal(recovered13.system, "Cardiology");
    assert.equal(recovered13.system_day, 13);
    assert.equal(recovered13.live_session_id, "session-reached-1");
    assert.equal(recovered14.system, "Cardiology");
    assert.equal(recovered14.system_day, 14);
    assert.equal(recovered14.live_session_id, "session-current-2");

    assert.equal(saved.liveSessions["session-reached-1"].roadmap_day_id, msk1.id);
    assert.equal(saved.liveSessions["session-reached-1"].status, "completed");
    assert.equal(saved.liveSessions["session-reached-1"].system, "Cardiology");
    assert.equal(saved.liveSessions["session-reached-1"].system_day, 13);
    assert.match(saved.liveSessions["session-reached-1"].title, /Cardiology.*Day 13/i);
    assert.equal(saved.liveSessions["session-current-2"].roadmap_day_id, msk2.id);
    assert.equal(saved.liveSessions["session-current-2"].system_day, 14);

    const systemsFromThirteen = savedRoadmap.days
      .filter((day) => Number(day.day_number || 0) >= 13 && Number(day.day_number || 0) <= 19)
      .map((day) => `${day.system}:${day.system_day}`);
    assert.deepEqual(systemsFromThirteen, [
      "Cardiology:13",
      "Cardiology:14",
      "Cardiology:15",
      "Cardiology:16",
      "MSK:1",
      "MSK:2",
      "MSK:3",
    ]);

    const restoredMsk = savedRoadmap.days.filter((day) => day.source === "admin_system_extension_displaced_restore");
    assert.equal(restoredMsk.length, 2);
    assert.match(restoredMsk[0].title, /MSK.*Day 1/i);
    assert.match(restoredMsk[1].title, /MSK.*Day 2/i);
    assert.equal(savedRoadmap.days.find((day) => day.id === msk3.id).system_day, 3);
    assert.equal(saved.liveSessions["session-future-3"].roadmap_day_id, msk3.id);
    assert.equal(saved.liveSessions["session-future-3"].scheduled_date, dateKey(5));

    assert.equal(saved.recordings["recording-reached"].session_id, "session-reached-1");
    assert.equal(saved.recordings["recording-reached"].roadmap_day_id, msk1.id);
    assert.equal(saved.recordings["recording-reached"].system, "Cardiology");
    assert.equal(saved.notes["note-reached"].session_id, "session-reached-1");
    assert.equal(saved.notes["note-reached"].system, "Cardiology");
    assert.equal(saved.attendance["attendance-reached"].session_id, "session-reached-1");
    assert.equal(saved.assessments["future-msk-assessment"].roadmap_day_id, msk3.id);
    assert.equal(saved.assessments["future-msk-assessment"].system, "MSK");
    assert.equal(saved.assessments["future-msk-assessment"].system_day, 3);
    assert.equal(saved.assessments["future-msk-assessment"].due_date, dateKey(5));

    assert.ok(saved.users.admin);
    assert.ok(saved.enrollments.sentinel);
    assert.ok(saved.payments.sentinel);
    assert.ok(saved.roadmapProgress.sentinel);
    assert.ok(saved.pointEvents.sentinel);
    assert.ok(saved.leaderboard.sentinel);
    assert.equal(saved.sentinel, "roadmap-extension-sentinel");
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
