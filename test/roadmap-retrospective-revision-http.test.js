import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function passwordRecord(password, salt = "revisionholidaysalt123456789012") {
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
    if (child.exitCode !== null) throw new Error(`Revision holiday test server exited (${child.exitCode})\n${output.join("")}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Revision holiday test server health timeout\n${output.join("")}`);
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

function teachingDay({ id, courseId, date, system, systemDay, pages, sessionId }) {
  const title = `${system} — Day ${systemDay} — FA 2026 pp. ${pages}`;
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
    uworld_qids: [`${systemDay}001`, `${systemDay}002`],
    description: `${title} teaching packet`,
    homework: `Complete the Day ${systemDay} work`,
    resources: ["Live class", "Class notes", "Recording"],
    task_items: [{ key: "live_attendance", label: "Attend live class", points: 10 }],
    status: "scheduled",
    roadmap_status: "scheduled",
    live_session_id: sessionId,
    session_id: sessionId,
    is_published: true,
  };
}

test("recorded weekend revision is preserved but hidden while Aug 10 and Aug 11 become MSK Days 10 and 11", { timeout: 70_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "revision-holiday-http-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const crmPath = path.join(dataDir, "crm-db.json");
  const aylaPath = path.join(dataDir, "aylamed-db.json");
  const courseId = "course-revision-holiday";
  const password = "RevisionAdmin9!";
  const now = "2026-08-11T12:00:00.000Z";
  const revisionDayId = "roadmap-msk-day-10-aug-8";
  const revisionSessionId = "session-revision-aug-8";
  const revisionRecordingKey = "revision-recording-aug-8";

  const day9 = teachingDay({ id: "roadmap-msk-day-9", courseId, date: "2026-08-07", system: "MSK", systemDay: 9, pages: "481–484", sessionId: "session-aug-7" });
  const revisionDay = teachingDay({ id: revisionDayId, courseId, date: "2026-08-08", system: "MSK", systemDay: 10, pages: "485–488", sessionId: revisionSessionId });
  const aug10 = teachingDay({ id: "roadmap-msk-day-11-aug-10", courseId, date: "2026-08-10", system: "MSK", systemDay: 11, pages: "489–492", sessionId: "session-aug-10" });
  const aug11 = teachingDay({ id: "roadmap-msk-day-12-aug-11", courseId, date: "2026-08-11", system: "MSK", systemDay: 12, pages: "493–496", sessionId: "session-aug-11" });
  const aug12 = teachingDay({ id: "roadmap-msk-day-13-aug-12", courseId, date: "2026-08-12", system: "MSK", systemDay: 13, pages: "497–500", sessionId: "session-aug-12" });
  const aug13 = teachingDay({ id: "roadmap-cns-day-1-aug-13", courseId, date: "2026-08-13", system: "Central Nervous System", systemDay: 1, pages: "501–504", sessionId: "session-aug-13" });
  const aug14 = teachingDay({ id: "roadmap-cns-day-2-aug-14", courseId, date: "2026-08-14", system: "Central Nervous System", systemDay: 2, pages: "505–508", sessionId: "session-aug-14" });
  const days = [day9, revisionDay, aug10, aug11, aug12, aug13, aug14];
  days.forEach((day, index) => {
    day.order = index + 23;
    day.day_number = index + 23;
    day.instructional_day_number = index + 23;
    day.schedule_slot_number = index + 23;
    day.week_number = 4;
    day.created_at = now;
    day.updated_at = now;
  });

  const sessions = Object.fromEntries(days.map((day) => {
    const sessionId = day.live_session_id;
    return [sessionId, {
      id: sessionId,
      course_id: courseId,
      roadmap_day_id: day.id,
      scheduled_date: day.date,
      scheduled_time: "13:00",
      title: day.title,
      topic: day.title,
      system: day.system,
      system_day: day.system_day,
      day_number: day.day_number,
      status: day.date <= "2026-08-10" ? "completed" : "scheduled",
      student_visible: true,
      created_at: now,
      updated_at: now,
    }];
  }));
  Object.assign(sessions[revisionSessionId], {
    recording_key: revisionRecordingKey,
    recording_url: "https://zoom.example/revision-source",
    recording_published: true,
    zoom_meeting_id: "revision-meeting-aug-8",
  });
  Object.assign(sessions["session-aug-10"], {
    recording_key: "real-recording-aug-10",
    recording_url: "https://zoom.example/real-aug-10",
    recording_published: true,
    zoom_meeting_id: "real-meeting-aug-10",
  });

  const liveDb = {
    sentinel: "revision-holiday-sentinel",
    users: {
      admin: {
        id: "admin",
        email: "revision-admin@example.com",
        name: "Revision Admin",
        role: "admin",
        status: "active",
        verified: true,
        ...passwordRecord(password),
        created_at: now,
        updated_at: now,
      },
    },
    courses: { [courseId]: { id: courseId, name: "Revision Holiday Course", status: "active", is_active: true } },
    roadmaps: {
      [courseId]: {
        id: `roadmap:${courseId}`,
        course_id: courseId,
        course_name: "Revision Holiday Course",
        start_date: day9.date,
        skip_sundays: true,
        settings: { start_date: day9.date, skip_sundays: true, class_time: "13:00", timezone: "America/New_York" },
        days,
        created_at: now,
        updated_at: now,
      },
    },
    liveSessions: sessions,
    recordings: {
      [revisionRecordingKey]: {
        id: revisionRecordingKey,
        recording_key: revisionRecordingKey,
        meeting_id: "revision-meeting-aug-8",
        course_id: courseId,
        session_id: revisionSessionId,
        roadmap_day_id: revisionDayId,
        topic: revisionDay.title,
        start_time: "2026-08-08T17:00:00.000Z",
        duration: 2,
        recording_url: "https://zoom.example/revision-source",
        share_url: "https://zoom.example/revision-share",
        transcript_url: "https://zoom.example/revision-transcript",
        published: true,
        created_at: now,
        updated_at: now,
      },
      "real-recording-aug-10": {
        id: "real-recording-aug-10",
        recording_key: "real-recording-aug-10",
        meeting_id: "real-meeting-aug-10",
        course_id: courseId,
        session_id: "session-aug-10",
        roadmap_day_id: aug10.id,
        topic: aug10.title,
        start_time: "2026-08-10T17:00:00.000Z",
        duration: 4380,
        recording_url: "https://zoom.example/real-aug-10",
        share_url: "https://zoom.example/real-aug-10-share",
        published: true,
        created_at: now,
        updated_at: now,
      },
    },
    notes: {
      "session-aug-10": {
        id: "session-aug-10",
        session_id: "session-aug-10",
        course_id: courseId,
        roadmap_day_id: aug10.id,
        title: "Real Aug 10 notes",
        notes: "Preserve the complete real August 10 lecture notes.",
        published: true,
        recording_url: "https://zoom.example/real-aug-10",
        created_at: now,
        updated_at: now,
      },
    },
    attendance: {
      "attendance-aug-10": { id: "attendance-aug-10", course_id: courseId, session_id: "session-aug-10", roadmap_day_id: aug10.id, user_id: "student-1", status: "present" },
      ...Object.fromEntries(Array.from({ length: 7 }, (_, index) => {
        const id = `attendance-revision-${index + 1}`;
        return [id, { id, course_id: courseId, session_id: revisionSessionId, roadmap_day_id: revisionDayId, user_id: `revision-student-${index + 1}`, status: "present" }];
      })),
    },
    assessments: {},
    assessmentAttempts: { sentinel: { id: "sentinel", user_id: "student-1", score: 80 } },
    flashcards: {},
    flashcardProgress: {},
    roadmapProgress: { sentinel: { id: "sentinel", course_id: courseId, user_id: "student-1", day_id: day9.id, completed: true } },
    dailyTaskProgress: {},
    pointEvents: { sentinel: { id: "sentinel", course_id: courseId, user_id: "student-1", roadmap_day_id: day9.id, points: 10 } },
    weakConceptLogs: {},
    leaderboard: { sentinel: { id: "sentinel", course_id: courseId, user_id: "student-1", total_points: 10 } },
    enrollments: { sentinel: { id: "sentinel", course_id: courseId, user_id: "student-1", status: "active" } },
    payments: { sentinel: { id: "sentinel", course_id: courseId, user_id: "student-1", status: "paid" } },
  };
  const crmOriginal = JSON.stringify({ sentinel: "crm-untouched-revision-holiday" });
  const aylaOriginal = JSON.stringify({ sentinel: "ayla-untouched-revision-holiday" });
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
      AUTH_JWT_SECRET: "revision-holiday-secret",
      AYLA_AUTH_JWT_SECRET: "revision-holiday-ayla-secret",
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
      body: { email: "revision-admin@example.com", password },
    });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    const token = login.payload.token;
    const route = `/admin/roadmap/${encodeURIComponent(revisionDayId)}/retrospective-holiday`;

    const beforeBlocked = await fs.readFile(livePath, "utf8");
    const blocked = await api(baseUrl, route, {
      method: "POST",
      token,
      body: { course_id: courseId, dry_run: true },
    });
    assert.equal(blocked.response.status, 409, JSON.stringify(blocked.payload));
    assert.equal(blocked.payload.revision_override_available, true);
    assert.equal(await fs.readFile(livePath, "utf8"), beforeBlocked);

    const preview = await api(baseUrl, route, {
      method: "POST",
      token,
      body: { course_id: courseId, dry_run: true, archive_selected_revision: true, preserve_revision_attendance: true },
    });
    assert.equal(preview.response.status, 200, JSON.stringify(preview.payload));
    assert.equal(preview.payload.dry_run, true);
    assert.equal(preview.payload.confirmation_required, "APPLY_RECORDED_REVISION_HOLIDAY");
    assert.equal(preview.payload.selected_revision.session_id, revisionSessionId);
    assert.deepEqual(preview.payload.selected_revision.recording_keys, [revisionRecordingKey]);
    assert.equal(preview.payload.selected_revision.recordings[0].duration, 2);
    assert.equal(preview.payload.selected_revision.attendance_count, 7);
    assert.deepEqual(preview.payload.selected_revision.attendance_keys, Array.from({ length: 7 }, (_, index) => `attendance-revision-${index + 1}`));
    assert.equal(await fs.readFile(livePath, "utf8"), beforeBlocked, "Preview must not modify the database");

    const rejected = await api(baseUrl, route, {
      method: "POST",
      token,
      body: {
        course_id: courseId,
        apply: true,
        archive_selected_revision: true,
        preserve_revision_attendance: true,
        preview_token: preview.payload.preview_token,
        expected_revision_session_id: revisionSessionId,
        expected_revision_recording_keys: ["wrong-recording-key"],
        expected_revision_attendance_keys: preview.payload.selected_revision.attendance_keys,
        confirm: "APPLY_RECORDED_REVISION_HOLIDAY",
      },
    });
    assert.equal(rejected.response.status, 409, JSON.stringify(rejected.payload));
    assert.equal(await fs.readFile(livePath, "utf8"), beforeBlocked, "Mismatched apply must not modify the database");

    const applied = await api(baseUrl, route, {
      method: "POST",
      token,
      body: {
        course_id: courseId,
        apply: true,
        archive_selected_revision: true,
        preserve_revision_attendance: true,
        preview_token: preview.payload.preview_token,
        expected_revision_session_id: revisionSessionId,
        expected_revision_recording_keys: [revisionRecordingKey],
        expected_revision_attendance_keys: preview.payload.selected_revision.attendance_keys,
        confirm: "APPLY_RECORDED_REVISION_HOLIDAY",
        reason: "August 8 and 9 were weekend non-teaching days; the short August 8 revision does not count as an MSK day.",
      },
    });
    assert.equal(applied.response.status, 200, JSON.stringify(applied.payload));
    assert.equal(applied.payload.applied, true);
    assert.equal(applied.payload.revision_session_archived, revisionSessionId);
    assert.equal(applied.payload.revision_recordings_hidden, 1);
    assert.equal(applied.payload.recordings_deleted, 0);
    assert.equal(applied.payload.notes_deleted, 0);
    assert.equal(applied.payload.sessions_deleted, 0);
    assert.equal(applied.payload.attendance_deleted, 0);
    assert.equal(applied.payload.students_deleted, 0);

    const saved = JSON.parse(await fs.readFile(livePath, "utf8"));
    const savedDays = saved.roadmaps[courseId].days;
    const savedAug8 = savedDays.find((day) => day.date === "2026-08-08");
    const savedAug10 = savedDays.find((day) => day.date === "2026-08-10");
    const savedAug11 = savedDays.find((day) => day.date === "2026-08-11");
    const savedAug13 = savedDays.find((day) => day.date === "2026-08-13");
    const savedAug14 = savedDays.find((day) => day.date === "2026-08-14");
    assert.equal(savedAug8.status, "holiday");
    assert.equal(savedAug8.live_session_id, null);
    assert.equal(savedAug10.system, "MSK");
    assert.equal(savedAug10.system_day, 10);
    assert.match(savedAug10.title, /MSK.*Day 10/);
    assert.deepEqual(savedAug10.uworld_qids, ["10001", "10002"]);
    assert.equal(savedAug11.system, "MSK");
    assert.equal(savedAug11.system_day, 11);
    assert.match(savedAug11.title, /MSK.*Day 11/);
    assert.equal(savedAug13.system, "MSK");
    assert.equal(savedAug13.system_day, 13);
    assert.equal(savedAug14.system, "Central Nervous System");
    assert.equal(savedAug14.system_day, 1);

    assert.ok(saved.liveSessions[revisionSessionId], "The short revision session must be preserved");
    assert.equal(saved.liveSessions[revisionSessionId].archived_from_active, true);
    assert.equal(saved.liveSessions[revisionSessionId].student_visible, false);
    assert.equal(saved.liveSessions[revisionSessionId].revision_only, true);
    assert.equal(saved.liveSessions[revisionSessionId].recording_url, "https://zoom.example/revision-source");
    assert.ok(saved.recordings[revisionRecordingKey], "The source revision recording row must be preserved");
    assert.equal(saved.recordings[revisionRecordingKey].published, false);
    assert.equal(saved.recordings[revisionRecordingKey].hidden_from_recordings, true);
    assert.equal(saved.recordings[revisionRecordingKey].recording_url, "https://zoom.example/revision-source");
    assert.equal(saved.recordings[revisionRecordingKey].share_url, "https://zoom.example/revision-share");
    assert.equal(saved.recordings[revisionRecordingKey].transcript_url, "https://zoom.example/revision-transcript");

    assert.ok(saved.liveSessions["session-aug-10"]);
    assert.equal(saved.liveSessions["session-aug-10"].scheduled_date, "2026-08-10");
    assert.equal(saved.liveSessions["session-aug-10"].recording_url, "https://zoom.example/real-aug-10");
    assert.ok(saved.recordings["real-recording-aug-10"]);
    assert.equal(saved.recordings["real-recording-aug-10"].recording_url, "https://zoom.example/real-aug-10");
    assert.equal(saved.recordings["real-recording-aug-10"].published, true);
    assert.ok(saved.notes["session-aug-10"]);
    assert.equal(saved.notes["session-aug-10"].notes, "Preserve the complete real August 10 lecture notes.");
    assert.ok(saved.attendance["attendance-aug-10"]);
    for (let index = 1; index <= 7; index += 1) {
      assert.deepEqual(saved.attendance[`attendance-revision-${index}`], liveDb.attendance[`attendance-revision-${index}`]);
    }
    assert.ok(saved.users.admin);
    assert.ok(saved.enrollments.sentinel);
    assert.ok(saved.payments.sentinel);
    assert.ok(saved.assessmentAttempts.sentinel);
    assert.ok(saved.roadmapProgress.sentinel);
    assert.ok(saved.pointEvents.sentinel);
    assert.equal(saved.sentinel, "revision-holiday-sentinel");
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
