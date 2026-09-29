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


test("a past day with an empty recording is removed and later days renumber without moving dates", { timeout: 70_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-remove-day-http-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const courseId = "course-remove-day";
  const password = "RoadmapAdmin9!";
  const now = new Date().toISOString();
  const days = Array.from({ length: 12 }, (_, i) => teachingDay({ id: `msk${i + 1}`, courseId, date: dateKey(-20 + i), system: "MSK", systemDay: i + 1, title: `MSK — Day ${i + 1} — FA 2026 pp. ${449 + i * 4}–${452 + i * 4}`, pages: `FA 2026 pp. ${449 + i * 4}–${452 + i * 4}`, sessionId: `s-msk${i + 1}` }));
  days.forEach((day, index) => { day.order = index + 1; day.day_number = index + 1; day.instructional_day_number = index + 1; day.schedule_slot_number = index + 1; });
  const sessions = Object.fromEntries(days.map((day) => [day.live_session_id, { id: day.live_session_id, course_id: courseId, roadmap_day_id: day.id, scheduled_date: day.date, status: "completed", system: "MSK", system_day: day.system_day, title: day.title, topic: day.title, created_at: now, updated_at: now }]));
  const liveDb = {
    users: { admin: { id: "admin", email: "roadmap-admin@example.com", name: "Admin", role: "admin", status: "active", verified: true, ...passwordRecord(password), created_at: now, updated_at: now } },
    courses: { [courseId]: { id: courseId, name: "Remove Day Course", status: "active", is_active: true } },
    roadmaps: { [courseId]: { id: `roadmap:${courseId}`, course_id: courseId, start_date: days[0].date, skip_sundays: false, settings: { start_date: days[0].date, skip_sundays: false }, days, created_at: now, updated_at: now } },
    liveSessions: sessions,
    recordings: {
      "rec-msk9": { id: "rec-msk9", course_id: courseId, session_id: "s-msk9", roadmap_day_id: "msk9", topic: days[8].title, system: "MSK", system_day: 9, published: true, recording_url: "https://zoom.us/rec/9", updated_at: now },
      "rec-msk10": { id: "rec-msk10", course_id: courseId, session_id: "s-msk10", roadmap_day_id: "msk10", topic: days[9].title, system: "MSK", system_day: 10, published: true, recording_url: "https://vimeo.com/10", label_correction_locked: true, corrected_system_day: 10, corrected_topic: days[9].title, updated_at: now },
    },
    recordingVimeoTransfers: { "rec-msk9": { vimeo_video_id: "9", vimeo_status: "available", vimeo_duration_seconds: 2 } },
    notes: { "s-msk9": { session_id: "s-msk9", course_id: courseId, roadmap_day_id: "msk9", published: true, notes: "x" } },
    attendance: { "att-9": { course_id: courseId, session_id: "s-msk9", user_id: "student-1", status: "present" } },
    assessments: {}, assessmentAttempts: {}, flashcards: {}, flashcardProgress: {}, roadmapProgress: {}, dailyTaskProgress: {}, pointEvents: {}, weakConceptLogs: {},
  };
  await fs.writeFile(livePath, JSON.stringify(liveDb, null, 2));
  await fs.writeFile(path.join(dataDir, "crm-db.json"), JSON.stringify({ sentinel: "crm" }));
  await fs.writeFile(path.join(dataDir, "aylamed-db.json"), JSON.stringify({ sentinel: "ayla" }));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, PORT: String(port), TZ: "UTC", DATA_DIR: dataDir, AUTH_JWT_SECRET: "remove-day-secret", AYLA_AUTH_JWT_SECRET: "remove-day-ayla-secret", DATABASE_URL: "", OPENAI_API_KEY: "",
      NEXTGEN_BACKEND_HEARTBEAT_ENABLED: "false", NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false", ZOOM_RECORDING_RECOVERY_ENABLED: "false", NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  try {
    await waitForHealth(baseUrl, child, output);
    const login = await api(baseUrl, "/auth/login", { method: "POST", body: { email: "roadmap-admin@example.com", password } });
    const token = login.payload.token;
    const blocked = await api(baseUrl, "/admin/roadmap/msk10/remove-unrecorded-day", { method: "POST", token, body: { course_id: courseId } });
    assert.equal(blocked.response.status, 409, "a day with a playable recording is never removed");

    const preview = await api(baseUrl, "/admin/roadmap/msk9/remove-unrecorded-day", { method: "POST", token, body: { course_id: courseId } });
    assert.equal(preview.response.status, 200, JSON.stringify(preview.payload));
    assert.equal(preview.payload.attendance_rows_kept, 1);
    const before = await fs.readFile(livePath, "utf8");
    assert.equal(await fs.readFile(livePath, "utf8"), before, "preview must not write");

    const applied = await api(baseUrl, "/admin/roadmap/msk9/remove-unrecorded-day", { method: "POST", token, body: { course_id: courseId, dry_run: false, confirm: "REMOVE_UNRECORDED_TEACHING_DAY", expected_roadmap_updated_at: preview.payload.roadmap_updated_at } });
    assert.equal(applied.response.status, 200, JSON.stringify(applied.payload));
    const after = JSON.parse(await fs.readFile(livePath, "utf8"));
    const byId = Object.fromEntries(after.roadmaps[courseId].days.map((day) => [day.id, day]));
    assert.equal(byId.msk9.status, "cancelled");
    assert.equal(byId.msk8.system_day, 8);
    assert.equal(byId.msk10.system_day, 9);
    assert.equal(byId.msk12.system_day, 11);
    assert.match(byId.msk10.title, /MSK — Day 9 — FA 2026 pp\. 485–488/);
    for (const day of days) assert.equal(byId[day.id].date, day.date, `${day.id} keeps its date`);
    assert.equal(after.recordings["rec-msk9"].published, false);
    assert.equal(after.recordings["rec-msk9"].hidden_from_recordings, true);
    assert.equal(after.recordings["rec-msk10"].corrected_system_day, 9);
    assert.equal(after.notes["s-msk9"].published, false);
    assert.equal(after.notes["s-msk9"].notes, "x", "notes are hidden, not deleted");
    assert.ok(after.attendance["att-9"], "attendance is kept");
    assert.equal(after.liveSessions["s-msk9"].archived_from_active, true);
  } finally {
    if (child.exitCode === null) await new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGTERM"); });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
