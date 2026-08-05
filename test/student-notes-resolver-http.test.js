import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function passwordRecord(password, salt = "studentnotesresolver1234567890") {
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
    if (child.exitCode !== null) {
      throw new Error(`Student notes resolver server exited (${child.exitCode})\n${output.join("")}`);
    }
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Student notes resolver health timeout\n${output.join("")}`);
}

async function api(baseUrl, route, { method = "GET", token = "", body = null } = {}) {
  try {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json();
    return { response, payload };
  } catch (error) {
    throw new Error(`${method} ${route} failed: ${error.message}`);
  }
}

function session({ id, courseId, day, roadmapDayId, date, pages, status = "completed" }) {
  const title = `Cardiology — Day ${day} — FA 2026 pp. ${pages}`;
  return {
    id,
    course_id: courseId,
    roadmap_day_id: roadmapDayId,
    title,
    topic: title,
    system: "Cardiology",
    system_day: day,
    day_number: day,
    instructional_day_number: day,
    scheduled_date: date,
    scheduled_time: "13:00",
    scheduled_timezone: "America/New_York",
    duration_minutes: 60,
    status,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-22T00:00:00.000Z",
  };
}

test("student notes resolve published legacy records by session, roadmap, or exact course system-day identity without rewriting data", { timeout: 70_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "student-notes-resolver-http-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const crmPath = path.join(dataDir, "crm-db.json");
  const aylaPath = path.join(dataDir, "aylamed-db.json");
  const courseId = "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c";
  const studentId = "student-notes-user";
  const password = "StudentNotes10!";
  const now = "2026-07-23T00:00:00.000Z";
  const future = "2027-07-23T00:00:00.000Z";

  const allDayNumbers = Array.from({ length: 13 }, (_, index) => index + 1);
  const dayIds = Object.fromEntries(allDayNumbers.map((day) => [day, `${courseId}:day:${day}:test`]));
  const sessionIds = Object.fromEntries(allDayNumbers.map((day) => [day, `current-cardio-day-${day}`]));
  const dates = Object.fromEntries(allDayNumbers.map((day) => [
    day,
    new Date(Date.UTC(2026, 6, 7 + day - 1)).toISOString().slice(0, 10),
  ]));
  const pages = Object.fromEntries(allDayNumbers.map((day) => [day, `${280 + day * 3}–${282 + day * 3}`]));
  pages[10] = "319–322";
  pages[11] = "323–325";
  pages[12] = "326–328";
  pages[13] = "329–332";

  const days = allDayNumbers.map((day) => ({
    id: dayIds[day],
    course_id: courseId,
    live_session_id: sessionIds[day],
    session_id: sessionIds[day],
    system: "Cardiology",
    chapter: "Cardiology",
    system_day: day,
    day_in_system: day,
    day_number: day,
    instructional_day_number: day,
    schedule_slot_number: day,
    order: day,
    week_number: Math.ceil(day / 7),
    date: dates[day],
    scheduled_date: dates[day],
    title: `Cardiology — Day ${day} — FA 2026 pp. ${pages[day]}`,
    is_published: true,
  }));

  const currentSessions = Object.fromEntries(allDayNumbers.map((day) => [
    sessionIds[day],
    session({
      id: sessionIds[day],
      courseId,
      day,
      roadmapDayId: dayIds[day],
      date: dates[day],
      pages: pages[day],
    }),
  ]));
  const oldDay11Session = session({
    id: "old-cardio-day-11-session",
    courseId,
    day: 11,
    roadmapDayId: dayIds[11],
    date: "2026-07-15",
    pages: pages[11],
  });

  const notes = {
    "legacy-note-day-10": {
      id: "legacy-note-day-10",
      // This reproduces the remaining live failure after the roadmap repair:
      // the note still points at a session slot later reused for Day 13 and no
      // longer has its original roadmap-day id. Its preserved Cardiology Day
      // 10 identity is the only safe way to reconnect it for student reads.
      session_id: sessionIds[13],
      course_id: courseId,
      roadmap_day_id: null,
      system: "Cardiology",
      system_day: 10,
      cleaned_notes: "Cardiology Day 10 clean tutor notes. ".repeat(8),
      published: true,
      is_published: true,
      updated_at: "2026-07-18T12:00:00.000Z",
    },
    "legacy-note-day-11": {
      id: "legacy-note-day-11",
      session_id: oldDay11Session.id,
      course_id: courseId,
      roadmap_day_id: dayIds[11],
      cleaned_notes: "Cardiology Day 11 clean tutor notes. ".repeat(8),
      published: true,
      is_published: true,
      updated_at: "2026-07-18T13:00:00.000Z",
    },
    [sessionIds[11]]: {
      id: sessionIds[11],
      session_id: sessionIds[11],
      course_id: courseId,
      roadmap_day_id: dayIds[11],
      cleaned_notes: "Unpublished draft must not hide the published legacy Day 11 notes.",
      published: false,
      is_published: false,
      status: "draft",
      updated_at: "2026-07-22T13:00:00.000Z",
    },
    [sessionIds[12]]: {
      id: sessionIds[12],
      session_id: sessionIds[12],
      course_id: courseId,
      roadmap_day_id: dayIds[12],
      cleaned_notes: "Legacy Cardiology Day 12 notes without explicit publication flags. ".repeat(6),
      updated_at: "2026-07-20T13:00:00.000Z",
    },
    [sessionIds[13]]: {
      id: sessionIds[13],
      session_id: sessionIds[13],
      course_id: courseId,
      roadmap_day_id: dayIds[13],
      cleaned_notes: "Cardiology Day 13 clean tutor notes. ".repeat(8),
      published: true,
      is_published: true,
      updated_at: "2026-07-21T13:00:00.000Z",
    },
    "wrong-course-day-11": {
      id: "wrong-course-day-11",
      session_id: "wrong-course-session",
      course_id: "different-course",
      roadmap_day_id: dayIds[11],
      cleaned_notes: "This newer wrong-course note must never be returned.",
      published: true,
      is_published: true,
      updated_at: "2026-07-23T13:00:00.000Z",
    },
    "unknown-course-cardio-day-10": {
      id: "unknown-course-cardio-day-10",
      session_id: "missing-session",
      system: "Cardiology",
      system_day: 10,
      cleaned_notes: "A note without a verified course must not be used by the system-day fallback.",
      published: true,
      is_published: true,
      updated_at: "2026-07-24T13:00:00.000Z",
    },
  };

  const liveDb = {
    sentinel: "student-notes-resolver-sentinel",
    users: {
      [studentId]: {
        id: studentId,
        email: "student-notes@example.com",
        name: "Student Notes Doctor",
        role: "student",
        status: "active",
        verified: true,
        ...passwordRecord(password),
        created_at: now,
        updated_at: now,
      },
    },
    courses: {
      [courseId]: { id: courseId, name: "120-Day USMLE Step 1 Marathon", status: "active", is_active: true },
      "different-course": { id: "different-course", name: "Different Course", status: "active", is_active: true },
    },
    roadmaps: {
      [courseId]: {
        id: `roadmap:${courseId}`,
        course_id: courseId,
        start_date: dates[1],
        skip_sundays: false,
        settings: { start_date: dates[1], skip_sundays: false, class_time: "13:00", timezone: "America/New_York" },
        days,
        created_at: now,
        updated_at: now,
      },
    },
    liveSessions: {
      ...currentSessions,
      [oldDay11Session.id]: oldDay11Session,
    },
    notes,
    enrollments: {
      paid: {
        id: "paid",
        user_id: studentId,
        course_id: courseId,
        type: "paid",
        status: "paid",
        is_demo: false,
        access_granted: true,
        paid_at: now,
        access_expires_at: future,
        created_at: now,
        updated_at: now,
      },
    },
    payments: { sentinel: { id: "sentinel", course_id: courseId, user_id: studentId, status: "paid" } },
    recordings: {},
    attendance: {},
    assessments: {},
    assessmentAttempts: { sentinel: { id: "sentinel", course_id: courseId, user_id: studentId, score: 80 } },
    flashcards: {},
    flashcardProgress: {},
    roadmapProgress: {},
    dailyTaskProgress: {},
    pointEvents: { sentinel: { id: "sentinel", course_id: courseId, user_id: studentId, points: 10 } },
    leaderboard: { sentinel: { id: "sentinel", course_id: courseId, user_id: studentId, total_points: 10 } },
  };
  const notesBefore = JSON.parse(JSON.stringify(notes));
  const crmOriginal = JSON.stringify({ sentinel: "crm-untouched-student-notes-resolver" });
  const aylaOriginal = JSON.stringify({ sentinel: "ayla-untouched-student-notes-resolver" });
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
      AUTH_JWT_SECRET: "student-notes-resolver-secret",
      AYLA_AUTH_JWT_SECRET: "student-notes-resolver-ayla-secret",
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
    assert.equal(health.payload.student_notes_resolver_build, "v225-course-system-day-notes-resolver");

    const login = await api(baseUrl, "/auth/login", {
      method: "POST",
      body: { email: "student-notes@example.com", password },
    });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    const token = login.payload.token;

    const list = await api(baseUrl, `/student/notes/sessions?course_id=${encodeURIComponent(courseId)}`, { token });
    assert.equal(list.response.status, 200, JSON.stringify(list.payload));
    assert.equal(list.payload.student_notes_resolver_build, "v225-course-system-day-notes-resolver");
    assert.deepEqual(list.payload.sessions.map((item) => item.id), [
      sessionIds[13],
      sessionIds[12],
      sessionIds[11],
      sessionIds[10],
    ]);
    assert.deepEqual(list.payload.sessions.map((item) => item.system_day), [13, 12, 11, 10]);
    assert.equal(list.payload.sessions.some((item) => item.id === oldDay11Session.id), false);

    const day10 = await api(baseUrl, `/live/notes/${sessionIds[10]}`, { token });
    assert.equal(day10.response.status, 200, JSON.stringify(day10.payload));
    assert.equal(day10.payload.notes.session_id, sessionIds[10]);
    assert.match(day10.payload.notes.cleaned_notes, /Day 10 clean tutor notes/);

    const day11 = await api(baseUrl, `/live/notes/${sessionIds[11]}`, { token });
    assert.equal(day11.response.status, 200, JSON.stringify(day11.payload));
    assert.equal(day11.payload.notes.session_id, sessionIds[11]);
    assert.match(day11.payload.notes.cleaned_notes, /Day 11 clean tutor notes/);
    assert.doesNotMatch(day11.payload.notes.cleaned_notes, /wrong-course/);

    const day12 = await api(baseUrl, `/live/notes/${sessionIds[12]}`, { token });
    assert.equal(day12.response.status, 200, JSON.stringify(day12.payload));
    assert.equal(day12.payload.notes.session_id, sessionIds[12]);
    assert.match(day12.payload.notes.cleaned_notes, /without explicit publication flags/);

    const day13 = await api(baseUrl, `/live/notes/${sessionIds[13]}`, { token });
    assert.equal(day13.response.status, 200, JSON.stringify(day13.payload));
    assert.equal(day13.payload.notes.session_id, sessionIds[13]);
    assert.match(day13.payload.notes.cleaned_notes, /Day 13 clean tutor notes/);
    assert.doesNotMatch(day13.payload.notes.cleaned_notes, /Day 10 clean tutor notes/);

    const saved = JSON.parse(await fs.readFile(livePath, "utf8"));
    assert.deepEqual(saved.notes, notesBefore, "Read-only note resolution must not rewrite or duplicate notes");
    assert.equal(Object.keys(saved.users || {}).length, 1);
    assert.equal(Object.keys(saved.enrollments || {}).length, 1);
    assert.equal(Object.keys(saved.payments || {}).length, 1);
    assert.equal(Object.keys(saved.assessmentAttempts || {}).length, 1);
    assert.equal(Object.keys(saved.pointEvents || {}).length, 1);
    assert.equal(await fs.readFile(crmPath, "utf8"), crmOriginal);
    assert.equal(await fs.readFile(aylaPath, "utf8"), aylaOriginal);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
