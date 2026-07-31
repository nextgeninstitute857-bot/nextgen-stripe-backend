import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

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

async function waitForRepair(baseUrl, child, output, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Schedule-repair server exited (${child.exitCode})\n${output.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      const health = await response.json();
      if (response.ok && health.lms_known_schedule_repair?.last_result) return health;
    } catch {
      // The server or startup reconciliation is still running.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Schedule-repair health timeout\n${output.join("")}`);
}

function roadmapDay({ id, date, systemDay, sessionId, pages }) {
  return {
    id,
    course_id: COURSE_ID,
    date,
    scheduled_date: date,
    day_number: systemDay,
    instructional_day_number: systemDay,
    system: "MSK",
    system_day: systemDay,
    day_in_system: systemDay,
    title: `MSK — Day ${systemDay} — FA 2026 pp. ${pages}`,
    first_aid_pages: pages,
    live_session_id: sessionId,
    session_id: sessionId,
    status: "scheduled",
    roadmap_status: "scheduled",
    is_published: true,
  };
}

function liveSession({ id, date, systemDay, roadmapDayId, status = "scheduled", recording = false }) {
  return {
    id,
    course_id: COURSE_ID,
    roadmap_day_id: roadmapDayId,
    scheduled_date: date,
    scheduled_time: "13:00",
    scheduled_timezone: "America/New_York",
    day_number: systemDay,
    instructional_day_number: systemDay,
    system: "MSK",
    system_day: systemDay,
    title: `MSK — Day ${systemDay}`,
    topic: `MSK — Day ${systemDay}`,
    status,
    ...(recording ? { recording_key: RECORDING_KEY, recording_url: RECORDING_URL } : {}),
  };
}

const COURSE_ID = "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c";
const HOLIDAY_DAY_ID = `${COURSE_ID}:day:16:76a0bbf1-6e31-4647-9a7f-0f68604679ab`;
const DAY_5_ID = `${COURSE_ID}:day:17:4f6cccff-d9b7-4232-ab25-5f94dad1f887`;
const DAY_6_ID = `${COURSE_ID}:day:18:de2a716f-0b6f-4ff0-8e01-d1b696326408`;
const HOLIDAY_SESSION_ID = "b4bffbe7-33f9-4e0c-a795-02c4bbb1e199";
const RECORDED_SESSION_ID = "dd2943e0-16cc-4e65-9296-918414715d33";
const CURRENT_SESSION_ID = "ae8b6eb9-e930-4a83-af64-537253fe42fa";
const DAY_7_SESSION_ID = "session-msk-day-7";
const RECORDING_KEY = "zoom-recording:83509601689:A17uXMYsReyLnQRoG1jgKg:2026-07-30T16:58:41Z";
const RECORDING_URL = "https://zoom.example/msk-day-4/recording";
const SHARE_URL = "https://zoom.example/msk-day-4/share";
const TRANSCRIPT_URL = "https://zoom.example/msk-day-4/transcript";

test("startup repairs the missed July 29 holiday atomically while preserving the recorded session and URLs", { timeout: 80_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-known-schedule-repair-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const crmPath = path.join(dataDir, "crm-db.json");
  const aylaPath = path.join(dataDir, "aylamed-db.json");

  const day1 = roadmapDay({ id: "day-msk-1", date: "2026-07-25", systemDay: 1, sessionId: "session-msk-1", pages: "449–452" });
  const day2 = roadmapDay({ id: "day-msk-2", date: "2026-07-27", systemDay: 2, sessionId: "session-msk-2", pages: "453–456" });
  const day3 = roadmapDay({ id: "day-msk-3", date: "2026-07-28", systemDay: 3, sessionId: "session-msk-3", pages: "457–460" });
  const day4 = roadmapDay({ id: HOLIDAY_DAY_ID, date: "2026-07-29", systemDay: 4, sessionId: HOLIDAY_SESSION_ID, pages: "461–464" });
  const day5 = roadmapDay({ id: DAY_5_ID, date: "2026-07-30", systemDay: 5, sessionId: RECORDED_SESSION_ID, pages: "465–468" });
  const day6 = roadmapDay({ id: DAY_6_ID, date: "2026-07-31", systemDay: 6, sessionId: CURRENT_SESSION_ID, pages: "469–472" });
  const day7 = roadmapDay({ id: "day-msk-7", date: "2026-08-01", systemDay: 7, sessionId: DAY_7_SESSION_ID, pages: "473–476" });

  const liveDb = {
    sentinel: "known-schedule-repair-sentinel",
    users: {},
    courses: {
      [COURSE_ID]: { id: COURSE_ID, name: "120-Day USMLE Step 1 Marathon", status: "active", is_active: true },
    },
    roadmaps: {
      [COURSE_ID]: {
        id: `roadmap:${COURSE_ID}`,
        course_id: COURSE_ID,
        start_date: "2026-07-25",
        skip_sundays: true,
        settings: { start_date: "2026-07-25", skip_sundays: true, class_time: "13:00", timezone: "America/New_York" },
        days: [day1, day2, day3, day4, day5, day6, day7],
      },
    },
    liveSessions: {
      "session-msk-1": liveSession({ id: "session-msk-1", date: "2026-07-25", systemDay: 1, roadmapDayId: day1.id, status: "completed" }),
      "session-msk-2": liveSession({ id: "session-msk-2", date: "2026-07-27", systemDay: 2, roadmapDayId: day2.id, status: "completed" }),
      "session-msk-3": liveSession({ id: "session-msk-3", date: "2026-07-28", systemDay: 3, roadmapDayId: day3.id, status: "completed" }),
      [HOLIDAY_SESSION_ID]: liveSession({ id: HOLIDAY_SESSION_ID, date: "2026-07-29", systemDay: 4, roadmapDayId: HOLIDAY_DAY_ID }),
      [RECORDED_SESSION_ID]: liveSession({ id: RECORDED_SESSION_ID, date: "2026-07-30", systemDay: 5, roadmapDayId: DAY_5_ID, status: "completed", recording: true }),
      [CURRENT_SESSION_ID]: liveSession({ id: CURRENT_SESSION_ID, date: "2026-07-31", systemDay: 6, roadmapDayId: DAY_6_ID }),
      [DAY_7_SESSION_ID]: liveSession({ id: DAY_7_SESSION_ID, date: "2026-08-01", systemDay: 7, roadmapDayId: day7.id }),
    },
    recordings: {
      [RECORDING_KEY]: {
        id: RECORDING_KEY,
        recording_key: RECORDING_KEY,
        meeting_id: "83509601689",
        session_id: RECORDED_SESSION_ID,
        course_id: COURSE_ID,
        roadmap_day_id: DAY_5_ID,
        day_number: 5,
        instructional_day_number: 5,
        system: "MSK",
        system_day: 5,
        topic: "MSK — Day 5 — FA 2026 pp. 465–468",
        start_time: "2026-07-30T16:58:41Z",
        recording_url: RECORDING_URL,
        share_url: SHARE_URL,
        transcript_url: TRANSCRIPT_URL,
        transcript_download_url: `${TRANSCRIPT_URL}/download`,
        transcript_imported: true,
        published: true,
      },
    },
    notes: {
      [RECORDED_SESSION_ID]: {
        id: RECORDED_SESSION_ID,
        session_id: RECORDED_SESSION_ID,
        course_id: COURSE_ID,
        roadmap_day_id: DAY_5_ID,
        notes: "# Clean Tutor Notes\n\n" + "Transcript-backed MSK teaching point. ".repeat(20),
        cleaned_notes: "# Clean Tutor Notes\n\n" + "Transcript-backed MSK teaching point. ".repeat(20),
        student_notes: "# Clean Tutor Notes\n\n" + "Transcript-backed MSK teaching point. ".repeat(20),
        published: true,
        is_published: true,
        status: "published",
      },
    },
    plans: {},
    enrollments: {},
    payments: {},
    assessments: {},
    assessmentAttempts: {},
    flashcards: {},
    flashcardProgress: {},
    roadmapProgress: {},
    dailyTaskProgress: {},
    pointEvents: {},
    weakConceptLogs: {},
    adaptiveAssignments: {},
    adaptiveFlashcardQueues: {},
    attendance: {},
    leaderboard: {},
  };

  const crmOriginal = JSON.stringify({ sentinel: "crm-untouched-known-schedule" });
  const aylaOriginal = JSON.stringify({ sentinel: "ayla-untouched-known-schedule" });
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
      AUTH_JWT_SECRET: "known-schedule-repair-secret",
      AYLA_AUTH_JWT_SECRET: "known-schedule-repair-ayla-secret",
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
    const health = await waitForRepair(baseUrl, child, output);
    assert.equal(health.lms_known_schedule_repair_build, "v259-known-missed-holiday-schedule");
    assert.equal(health.lms_known_schedule_repair.last_result.repaired, true);
    assert.equal(health.lms_known_schedule_repair.last_result.current_system_day, 5);
    assert.equal(health.lms_known_schedule_repair.last_result.recording_preserved, true);
    assert.equal(health.lms_known_schedule_repair.last_result.deleted_records, 0);

    const saved = JSON.parse(await fs.readFile(livePath, "utf8"));
    const roadmap = saved.roadmaps[COURSE_ID];
    const at = (date) => roadmap.days.find((day) => String(day.date).slice(0, 10) === date);
    const july29 = at("2026-07-29");
    const july30 = at("2026-07-30");
    const july31 = at("2026-07-31");
    const august1 = at("2026-08-01");

    assert.equal(july29.status, "holiday");
    assert.equal(july29.is_schedule_placeholder, true);
    assert.equal(july29.live_session_id, null);
    assert.equal(july30.system_day, 4);
    assert.equal(july30.live_session_id, RECORDED_SESSION_ID);
    assert.match(july30.title, /MSK\s+—\s+Day 4/i);
    assert.equal(july31.system_day, 5);
    assert.equal(july31.live_session_id, CURRENT_SESSION_ID);
    assert.match(july31.title, /MSK\s+—\s+Day 5/i);
    assert.equal(august1.system_day, 6);
    assert.equal(august1.live_session_id, DAY_7_SESSION_ID);
    assert.equal(at("2026-08-03").system_day, 7);

    assert.equal(saved.liveSessions[HOLIDAY_SESSION_ID].status, "cancelled");
    assert.equal(saved.liveSessions[RECORDED_SESSION_ID].id, RECORDED_SESSION_ID);
    assert.equal(saved.liveSessions[RECORDED_SESSION_ID].roadmap_day_id, july30.id);
    assert.equal(saved.liveSessions[RECORDED_SESSION_ID].system_day, 4);
    assert.equal(saved.liveSessions[RECORDED_SESSION_ID].recording_url, RECORDING_URL);
    assert.equal(saved.liveSessions[CURRENT_SESSION_ID].roadmap_day_id, july31.id);
    assert.equal(saved.liveSessions[CURRENT_SESSION_ID].system_day, 5);
    assert.match(saved.liveSessions[CURRENT_SESSION_ID].title, /Day 5/i);

    const recording = saved.recordings[RECORDING_KEY];
    assert.equal(recording.recording_key, RECORDING_KEY);
    assert.equal(recording.session_id, RECORDED_SESSION_ID);
    assert.equal(recording.roadmap_day_id, july30.id);
    assert.equal(recording.system_day, 4);
    assert.equal(recording.recording_url, RECORDING_URL);
    assert.equal(recording.share_url, SHARE_URL);
    assert.equal(recording.transcript_url, TRANSCRIPT_URL);
    assert.equal(recording.published, true);

    assert.equal(saved.notes[RECORDED_SESSION_ID].session_id, RECORDED_SESSION_ID);
    assert.equal(saved.notes[RECORDED_SESSION_ID].roadmap_day_id, july30.id);
    assert.equal(saved.notes[RECORDED_SESSION_ID].system_day, 4);
    assert.equal(saved.notes[RECORDED_SESSION_ID].status, "published");
    assert.equal(saved.sentinel, "known-schedule-repair-sentinel");
    assert.equal(await fs.readFile(crmPath, "utf8"), crmOriginal);
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
