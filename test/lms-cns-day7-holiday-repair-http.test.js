import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COURSE_ID = "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c";
const BUILD = "v269-cns-day7-aug29-holiday";
const SATURDAY_DAY_ID = `${COURSE_ID}:day:35:c248b193-b5d4-4951-aed2-c14e65be4d85`;
const SATURDAY_SESSION_ID = "09637d55-ef9d-488b-be8c-71aca212d27a";
const MONDAY_DAY_ID = `${COURSE_ID}:day:36:326cf4d1-3ee5-4980-9ddf-f9e901b77baa`;
const MONDAY_SESSION_ID = "c6a25c20-8a65-4910-93be-6950f5113123";
const NEW_TAIL_DAY_ID = `${COURSE_ID}:day:retrospective:2026-08-29-holiday`;
const RECORDED_SESSION_ID = "recorded-september-1-session";
const RECORDING_ID = "zoom-recording:september-1";
const RECORDING_URL = "https://zoom.example/rec/september-1";

const DERM_ROWS = [
  ["2026-08-15", 1, `${COURSE_ID}:day:dermatology:b2a63e8b-bbe1-486a-8ea5-a0150ec12716`, "2aa21d07-415a-44e6-b046-5564ce9527ae"],
  ["2026-08-17", 2, `${COURSE_ID}:day:dermatology:7cb197f6-dbc8-4a3d-8611-9074eb4b300c`, "8806a5e3-a990-4fe3-b02d-5c45d4feca85"],
  ["2026-08-18", 3, `${COURSE_ID}:day:dermatology:cd531369-481b-4d07-bc1a-f0f41b5b3558`, "f75c2925-0d93-47bd-9467-3d08a869d143"],
  ["2026-08-20", 4, `${COURSE_ID}:day:dermatology:8ca285a5-7c12-48e5-a827-d2ec2bf7934d`, "35b88a22-6ff8-46f7-8426-c7b90330d89d"],
];
const DERM_HOLIDAY_ID = `${COURSE_ID}:day:holiday:f6e7dda7-da1b-43da-867a-d73325308153`;
const CNS_DAY1_ID = `${COURSE_ID}:day:28:aee5474e-c0ba-4c8d-be9c-d1110f3f2d4c`;
const CNS_DAY1_SESSION_ID = "37301895-5a31-4af8-87b0-2ae52162c9ae";

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

function teachingDay({ id, date, system, systemDay, sessionId, pages }) {
  return {
    id,
    course_id: COURSE_ID,
    date,
    scheduled_date: date,
    system,
    chapter: system,
    system_day: systemDay,
    day_in_system: systemDay,
    title: `${system} — Day ${systemDay} — FA 2026 pp. ${pages}`,
    first_aid_pages: `FA 2026 pp. ${pages}`,
    first_aid_topics: `${system} pages ${pages}`,
    live_teaching_topic: `${system} pages ${pages}`,
    lecture_title: `${system} Lecture ${systemDay}`,
    video_library_lecture: `${system} Lecture ${systemDay}`,
    uworld_qids: [`${systemDay}01`, `${systemDay}02`],
    mapped_uworld_qids: [`${systemDay}01`, `${systemDay}02`],
    live_session_id: sessionId,
    session_id: sessionId,
    status: "scheduled",
    roadmap_status: "scheduled",
    is_published: true,
  };
}

function liveSession(day, { recorded = false, completed = false } = {}) {
  return {
    id: day.live_session_id,
    course_id: COURSE_ID,
    roadmap_day_id: day.id,
    scheduled_date: day.date,
    scheduled_time: "12:00",
    scheduled_timezone: "America/New_York",
    title: day.title,
    topic: day.title,
    system: day.system,
    system_day: day.system_day,
    status: completed || recorded ? "completed" : "scheduled",
    join_url: `https://zoom.example/join/${day.live_session_id}`,
    start_url: `https://zoom.example/start/${day.live_session_id}`,
    ...(recorded ? { recording_url: RECORDING_URL } : {}),
  };
}

function buildFixture() {
  const dermDays = DERM_ROWS.map(([date, systemDay, id, sessionId]) => teachingDay({
    id, date, system: "Dermatology", systemDay, sessionId, pages: `${495 + systemDay * 4}–${498 + systemDay * 4}`,
  }));
  const dermHoliday = {
    id: DERM_HOLIDAY_ID,
    course_id: COURSE_ID,
    date: "2026-08-19",
    scheduled_date: "2026-08-19",
    title: "Holiday / No Live Class",
    status: "holiday",
    roadmap_status: "holiday",
    is_schedule_placeholder: true,
    live_session_id: null,
    session_id: null,
  };
  const cnsDates = ["2026-08-21", "2026-08-22", "2026-08-24", "2026-08-25", "2026-08-26", "2026-08-28", "2026-08-29", "2026-08-31", "2026-09-01"];
  const cnsIds = [
    CNS_DAY1_ID,
    `${COURSE_ID}:day:29:test-cns-2`,
    `${COURSE_ID}:day:30:test-cns-3`,
    `${COURSE_ID}:day:31:test-cns-4`,
    `${COURSE_ID}:day:32:test-cns-5`,
    `${COURSE_ID}:day:34:test-cns-6`,
    SATURDAY_DAY_ID,
    MONDAY_DAY_ID,
    `${COURSE_ID}:day:37:test-cns-9`,
  ];
  const cnsSessions = [
    CNS_DAY1_SESSION_ID,
    "test-cns-2-session",
    "test-cns-3-session",
    "test-cns-4-session",
    "test-cns-5-session",
    "test-cns-6-session",
    SATURDAY_SESSION_ID,
    MONDAY_SESSION_ID,
    RECORDED_SESSION_ID,
  ];
  const cnsDays = cnsDates.map((date, index) => teachingDay({
    id: cnsIds[index],
    date,
    system: "Central Nervous System",
    systemDay: index + 1,
    sessionId: cnsSessions[index],
    pages: `${499 + index * 4}–${502 + index * 4}`,
  }));
  const reproductiveDay = teachingDay({
    id: `${COURSE_ID}:day:38:test-reproductive-1`,
    date: "2026-09-02",
    system: "Reproductive",
    systemDay: 1,
    sessionId: "test-reproductive-1-session",
    pages: "629–632",
  });
  const cnsHoliday = {
    id: `${COURSE_ID}:day:holiday:2026-08-27-test`,
    course_id: COURSE_ID,
    date: "2026-08-27",
    scheduled_date: "2026-08-27",
    title: "Holiday / No Live Class",
    status: "holiday",
    roadmap_status: "holiday",
    is_schedule_placeholder: true,
    live_session_id: null,
    session_id: null,
  };
  const days = [
    ...dermDays.slice(0, 3), dermHoliday, dermDays[3],
    ...cnsDays.slice(0, 5), cnsHoliday, ...cnsDays.slice(5),
    reproductiveDay,
  ];
  const liveSessions = {};
  for (const day of days.filter((item) => item.live_session_id)) {
    liveSessions[day.live_session_id] = liveSession(day, {
      completed: day.id === SATURDAY_DAY_ID,
      recorded: day.live_session_id === RECORDED_SESSION_ID,
    });
  }
  return {
    sentinel: "cns-day7-holiday-sentinel",
    users: {}, enrollments: {}, payments: {}, plans: {},
    courses: { [COURSE_ID]: { id: COURSE_ID, name: "120-Day USMLE Step 1 Marathon", status: "active" } },
    roadmaps: {
      [COURSE_ID]: {
        id: `roadmap:${COURSE_ID}`,
        course_id: COURSE_ID,
        start_date: "2026-08-15",
        skip_sundays: true,
        settings: { start_date: "2026-08-15", skip_sundays: true, class_time: "12:00", timezone: "America/New_York", system_sequence: ["Dermatology", "Central Nervous System", "Reproductive"] },
        days,
      },
    },
    liveSessions,
    recordings: {
      [RECORDING_ID]: {
        id: RECORDING_ID,
        recording_key: RECORDING_ID,
        session_id: RECORDED_SESSION_ID,
        course_id: COURSE_ID,
        roadmap_day_id: cnsDays[8].id,
        meeting_id: "85825517950",
        recording_url: RECORDING_URL,
        transcript_url: `${RECORDING_URL}/transcript`,
        published: true,
      },
    },
    notes: {
      [RECORDED_SESSION_ID]: {
        id: RECORDED_SESSION_ID,
        session_id: RECORDED_SESSION_ID,
        course_id: COURSE_ID,
        roadmap_day_id: cnsDays[8].id,
        notes: "CNS teaching notes. ".repeat(30),
        published: true,
      },
    },
    flashcards: {}, flashcardProgress: {}, assessments: {}, assessmentAttempts: {}, roadmapProgress: {},
    dailyTaskProgress: {}, pointEvents: {}, weakConceptLogs: {}, adaptiveAssignments: {},
    adaptiveFlashcardQueues: {},
    attendance: {
      "saturday-attendance-audit": {
        id: "saturday-attendance-audit",
        session_id: SATURDAY_SESSION_ID,
        roadmap_day_id: SATURDAY_DAY_ID,
        user_id: "student-audit",
        joined_at: "2026-08-29T16:00:00.000Z",
        source: "provider_audit",
      },
    },
    leaderboard: {}, announcements: {},
  };
}

async function launchServer(dataDir) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
    env: {
      ...process.env,
      PORT: String(port),
      TZ: "UTC",
      DATA_DIR: dataDir,
      AUTH_JWT_SECRET: "cns-day7-holiday-secret",
      AYLA_AUTH_JWT_SECRET: "cns-day7-holiday-ayla-secret",
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
  return { child, baseUrl, output };
}

async function waitForRepair(server, timeoutMs = 70_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (server.child.exitCode !== null) throw new Error(`Server exited (${server.child.exitCode})\n${server.output.join("")}`);
    try {
      const response = await fetch(`${server.baseUrl}/health`);
      const health = await response.json();
      if (health.lms_cns_day7_holiday_repair?.last_error) throw new Error(`Holiday repair failed: ${health.lms_cns_day7_holiday_repair.last_error}\n${server.output.join("")}`);
      if (response.ok && health.lms_cns_day7_holiday_repair?.last_result) return health;
    } catch (error) {
      if (String(error?.message || "").startsWith("Holiday repair failed:")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`CNS Day 7 holiday repair timeout\n${server.output.join("")}`);
}

async function stopServer(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  const exited = new Promise((resolve) => server.child.once("exit", resolve));
  server.child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill("SIGKILL");
}

test("startup turns August 29 into a holiday and moves CNS Day 7 to Monday without moving recordings", { timeout: 150_000 }, async () => {
  const fixture = buildFixture();
  const originalSessionIds = Object.keys(fixture.liveSessions);
  const originalUrls = Object.fromEntries(originalSessionIds.map((id) => [id, {
    join_url: fixture.liveSessions[id].join_url,
    start_url: fixture.liveSessions[id].start_url,
    recording_url: fixture.liveSessions[id].recording_url || null,
  }]));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-cns-day7-holiday-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  await fs.writeFile(livePath, JSON.stringify(fixture, null, 2));
  await fs.writeFile(path.join(dataDir, "crm-db.json"), JSON.stringify({ sentinel: "crm-untouched" }));
  await fs.writeFile(path.join(dataDir, "aylamed-db.json"), JSON.stringify({ sentinel: "ayla-untouched" }));

  let server = await launchServer(dataDir);
  try {
    const health = await waitForRepair(server);
    const report = health.lms_cns_day7_holiday_repair.last_result;
    assert.equal(health.lms_cns_day7_holiday_repair_build, BUILD);
    assert.equal(report.repaired, true);
    assert.equal(report.reason, "repaired_transactionally");
    assert.equal(report.recordings_deleted, 0);
    assert.equal(report.notes_deleted, 0);
    assert.equal(report.sessions_deleted, 0);
    assert.equal(report.holiday_attendance_preserved, 1);
    assert.equal(report.checks.august_29_is_holiday, true);
    assert.equal(report.checks.monday_is_cns_day_7, true);
    assert.equal(report.checks.every_recording_identity_and_url_preserved, true);
    assert.equal(report.checks.every_recorded_session_anchor_preserved, true);
    assert.equal(report.checks.every_holiday_attendance_record_preserved, true);

    const roadmapResponse = await fetch(`${server.baseUrl}/roadmap/course/${COURSE_ID}`);
    const publicRoadmap = await roadmapResponse.json();
    const at = (date) => publicRoadmap.days.find((day) => day.date === date);
    assert.equal(roadmapResponse.ok, true);
    assert.equal(at("2026-08-29").status, "holiday");
    assert.equal(at("2026-08-29").title, "Holiday / No Live Class");
    assert.equal(at("2026-08-31").system_day, 7);
    assert.equal(at("2026-09-01").system_day, 8);
    assert.equal(at("2026-09-02").system_day, 9);
    assert.equal(at("2026-09-03").id, NEW_TAIL_DAY_ID);

    const sessionsResponse = await fetch(`${server.baseUrl}/live-sessions?course_id=${COURSE_ID}`);
    const publicSessions = await sessionsResponse.json();
    assert.equal(sessionsResponse.ok, true);
    assert.equal(publicSessions.sessions.some((item) => item.id === SATURDAY_SESSION_ID), false);
    assert.equal(publicSessions.sessions.find((item) => item.id === MONDAY_SESSION_ID).system_day, 7);

    const saved = JSON.parse(await fs.readFile(livePath, "utf8"));
    assert.equal(saved.sentinel, "cns-day7-holiday-sentinel");
    assert.equal(saved.roadmaps[COURSE_ID].schedule_slots, saved.roadmaps[COURSE_ID].days.length);
    assert.equal(saved.roadmaps[COURSE_ID].settings.schedule_slots, saved.roadmaps[COURSE_ID].days.length);
    assert.equal(new Set(saved.roadmaps[COURSE_ID].days.map((day) => day.order)).size, saved.roadmaps[COURSE_ID].days.length);
    assert.equal(saved.liveSessions[SATURDAY_SESSION_ID].status, "cancelled");
    assert.equal(saved.liveSessions[SATURDAY_SESSION_ID].student_visible, false);
    assert.equal(saved.liveSessions[SATURDAY_SESSION_ID].archived_from_active, true);
    assert.deepEqual(saved.attendance["saturday-attendance-audit"], fixture.attendance["saturday-attendance-audit"]);
    assert.equal(saved.liveSessions[RECORDED_SESSION_ID].scheduled_date, "2026-09-01");
    assert.equal(saved.recordings[RECORDING_ID].recording_url, RECORDING_URL);
    assert.equal(saved.notes[RECORDED_SESSION_ID].roadmap_day_id, `${COURSE_ID}:day:37:test-cns-9`);
    for (const id of originalSessionIds) {
      assert.ok(saved.liveSessions[id], `session ${id} was preserved`);
      assert.deepEqual({
        join_url: saved.liveSessions[id].join_url,
        start_url: saved.liveSessions[id].start_url,
        recording_url: saved.liveSessions[id].recording_url || null,
      }, originalUrls[id], `session URLs changed for ${id}`);
    }
    const announcement = Object.values(saved.announcements).find((item) => item.metadata?.notification_key === `roadmap_holiday:${COURSE_ID}:${SATURDAY_DAY_ID}`);
    assert.ok(announcement);
    assert.match(announcement.title, /CNS Day 7 moved to Monday/);
  } finally {
    await stopServer(server);
  }

  server = await launchServer(dataDir);
  try {
    const health = await waitForRepair(server);
    const savedAfterRestart = JSON.parse(await fs.readFile(livePath, "utf8"));
    const restartDays = [CNS_DAY1_ID, ...DERM_ROWS.map((row) => row[2]), DERM_HOLIDAY_ID, SATURDAY_DAY_ID, MONDAY_DAY_ID, NEW_TAIL_DAY_ID].map((id) => {
      const day = savedAfterRestart.roadmaps[COURSE_ID].days.find((item) => item.id === id);
      return day ? { id: day.id, date: day.date, title: day.title, system: day.system, system_day: day.system_day, status: day.status } : null;
    });
    assert.equal(
      health.lms_cns_day7_holiday_repair.last_result.already_correct,
      true,
      JSON.stringify({
        report: health.lms_cns_day7_holiday_repair.last_result,
        dermatologyRepair: health.lms_dermatology_cns_schedule_repair?.last_result,
        knownRepair: health.lms_known_schedule_repair?.last_result,
        restartDays,
      }),
    );
    assert.equal(health.lms_cns_day7_holiday_repair.last_result.changed, false);
    const saved = savedAfterRestart;
    assert.equal(saved.roadmaps[COURSE_ID].days.filter((day) => day.id === NEW_TAIL_DAY_ID).length, 1);
    assert.equal(Object.values(saved.announcements).filter((item) => item.metadata?.notification_key === `roadmap_holiday:${COURSE_ID}:${SATURDAY_DAY_ID}`).length, 1);
  } finally {
    await stopServer(server);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
