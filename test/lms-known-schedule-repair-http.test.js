import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COURSE_ID = "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c";
const BUILD = "v260-known-missed-holiday-transactional-recovery";
const HOLIDAY_DAY_ID = `${COURSE_ID}:day:16:76a0bbf1-6e31-4647-9a7f-0f68604679ab`;
const HOLIDAY_SESSION_ID = "b4bffbe7-33f9-4e0c-a795-02c4bbb1e199";
const RECORDED_SESSION_ID = "dd2943e0-16cc-4e65-9296-918414715d33";
const CURRENT_SESSION_ID = "ae8b6eb9-e930-4a83-af64-537253fe42fa";
const RECORDING_KEY = "zoom-recording:83509601689:A17uXMYsReyLnQRoG1jgKg:2026-07-30T16:58:41Z";
const RECORDING_URL = "https://zoom.example/msk-day-4/recording";
const SHARE_URL = "https://zoom.example/msk-day-4/share";
const TRANSCRIPT_URL = "https://zoom.example/msk-day-4/transcript";

const PREFIX = [
  { id: `${COURSE_ID}:day:1:ee429d9f-1a2a-463f-89f4-fbfd4fe2a0fc`, date: "2026-07-01", partial: "2026-07-01", holiday: true },
  { id: `${COURSE_ID}:day:pushed:b29be8d1-fd7e-4798-bf85-ffcb9ca8d597`, date: "2026-07-02", partial: "2026-07-02", session: "e80489ce-70e6-4af3-bc11-4ca1f7b25d8e" },
  { id: `${COURSE_ID}:day:2:2f21d999-81cf-4e3b-b5bd-b0c86d2790da`, date: "2026-07-03", partial: "2026-07-03", session: "ca2137f4-db8a-48db-9ec6-8029ae83b663" },
  { id: `${COURSE_ID}:day:3:7d582022-4e15-489e-b1c1-d534a2d7dea1`, date: "2026-07-04", partial: "2026-07-06", holiday: true },
  { id: `${COURSE_ID}:day:pushed:7a580580-a19e-4409-a82f-c2795245aa94`, date: "2026-07-06", partial: "2026-07-04", session: "ea3bd579-bac1-4527-909d-a40a39ca5067" },
  { id: `${COURSE_ID}:day:4:a84aa85e-cd4b-4059-9ae6-ff8f27816bbf`, date: "2026-07-07", partial: "2026-07-07", session: "8501ec50-fee8-49c2-b306-e252c09c08da" },
  { id: `${COURSE_ID}:day:5:acb6339b-b076-48a1-85b5-35617e9ff637`, date: "2026-07-08", partial: "2026-07-08", session: "5dcd27e3-1614-4c70-8122-117a80ac0bbf" },
  { id: `${COURSE_ID}:day:6:aecd0949-8504-4df7-b259-bdf0887fa092`, date: "2026-07-09", partial: "2026-07-13", holiday: true },
  { id: `${COURSE_ID}:day:pushed:105ba9e7-ca58-4091-804a-16fc2247aaac`, date: "2026-07-10", partial: "2026-07-15", holiday: true },
  { id: `${COURSE_ID}:day:pushed:4ec9308c-f20b-4c52-a2f5-89ead3d40e9a`, date: "2026-07-11", partial: "2026-07-09", session: "17426ec5-286a-4919-91c7-3a4d3f9f26f9" },
  { id: `${COURSE_ID}:day:7:f4219a4b-909b-4cf5-bf33-2fa1fb62620e`, date: "2026-07-12", partial: "2026-07-12", session: "c4abcae2-79d3-4f85-bfc7-7f91552dd5f1" },
  { id: `${COURSE_ID}:day:8:e34cd84e-5790-460e-9c70-a41e4079594c`, date: "2026-07-13", partial: "2026-07-14", session: "bd6cc888-cbf8-4c84-ba94-340315c41e87" },
  { id: `${COURSE_ID}:day:9:981a97a6-f01e-4e2c-86f9-4bb3603886e5`, date: "2026-07-14", partial: "2026-07-21", holiday: true },
  { id: `${COURSE_ID}:day:pushed:826f104d-8222-48f9-a672-13f354e58b55`, date: "2026-07-15", partial: "2026-07-16", session: "f756c0fc-3812-421f-880f-d294a60e73a2" },
  { id: `${COURSE_ID}:day:10:7ef39da5-f2c8-4ad6-929f-e9bfd5590f46`, date: "2026-07-16", partial: "2026-07-17", session: "5d0efb1f-6e13-4740-979a-a58df41dc582" },
  { id: `${COURSE_ID}:day:11:012176c3-19c9-4689-9b0b-fac81e96dd47`, date: "2026-07-17", partial: "2026-07-18", session: "09176f22-28ce-4aef-b2cc-18307b43a65f" },
  { id: `${COURSE_ID}:day:12:0d222da1-867e-4bad-a6ae-435f0966ab4a`, date: "2026-07-18", partial: "2026-07-27", holiday: true },
  { id: `${COURSE_ID}:day:pushed:b00ddfe0-5936-4e8e-926e-41bbe813ca07`, date: "2026-07-20", partial: "2026-07-20", session: "3a0969e3-3c85-4bd4-a728-d0c474a8014b" },
  { id: `${COURSE_ID}:day:13:badb20b2-ff97-475d-a37d-c8731be4bc66`, date: "2026-07-21", partial: "2026-07-22", session: "d699e77e-9201-4f5f-b5fd-eaba05a080b9" },
  { id: `${COURSE_ID}:day:14:c03675d0-2869-46e3-8b28-a789b88daa08`, date: "2026-07-22", partial: "2026-07-23", session: "6ddc8cbd-da24-4211-9f4a-4d2ef3bab87a" },
  { id: `${COURSE_ID}:day:extension:58f938f8-45c9-44c2-b285-f8101407fac5`, date: "2026-07-23", partial: "2026-07-24", session: "0140b2ed-18d2-4a71-93dd-8839566d3ce5" },
  { id: `${COURSE_ID}:day:extension:07f85cf7-eadd-4f13-a504-9afba29dd1ca`, date: "2026-07-24", partial: "2026-07-25", session: "338a387b-ea6c-4c64-b1b6-8f92ec359222" },
];

const MSK = [
  { id: `${COURSE_ID}:day:displaced:f481a1e9-b047-436c-8d8e-4aad8e28f088`, day: 1, pages: "449–452", desired: "2026-07-25", partial: "2026-07-28", exact: "5c5bf79b-6744-48a6-a4c2-021824357073", current: "duplicate-msk-1" },
  { id: `${COURSE_ID}:day:displaced:037a3971-4f27-425a-8fa1-33a8d81ba39c`, day: 2, pages: "453–456", desired: "2026-07-27", partial: "2026-07-29", exact: "4184f0c1-a396-44c5-96b9-c00244ee66bc", current: "duplicate-msk-2" },
  { id: `${COURSE_ID}:day:15:99fd55b6-d102-434e-a647-d7f0a400db71`, day: 3, pages: "457–460", desired: "2026-07-28", partial: "2026-07-30", exact: "78f27b9f-9547-42ea-990b-3c0ba272f39e", current: "duplicate-msk-3" },
  { id: `${COURSE_ID}:day:pushed:68d50440-edb7-4f8b-ab2d-b8bc6fc97e2a`, day: 4, pages: "461–464", desired: "2026-07-30", partial: "2026-08-07", exact: RECORDED_SESSION_ID, current: "duplicate-msk-4" },
  { id: `${COURSE_ID}:day:17:4f6cccff-d9b7-4232-ab25-5f94dad1f887`, day: 5, pages: "465–468", desired: "2026-07-31", partial: "2026-07-31", exact: CURRENT_SESSION_ID, current: "duplicate-msk-5" },
  { id: `${COURSE_ID}:day:18:de2a716f-0b6f-4ff0-8e01-d1b696326408`, day: 6, pages: "469–472", desired: "2026-08-01", partial: "2026-08-01", current: CURRENT_SESSION_ID },
  { id: `${COURSE_ID}:day:19:de11e51b-0980-4ce7-9106-7840f7babb8f`, day: 7, pages: "473–476", desired: "2026-08-03", partial: "2026-08-03", current: "session-msk-7" },
  { id: `${COURSE_ID}:day:20:3346870c-d855-4241-a912-e9aa221fad1b`, day: 8, pages: "477–480", desired: "2026-08-04", partial: "2026-08-04", current: "session-msk-8" },
  { id: `${COURSE_ID}:day:21:07904631-4c17-4140-9406-00a4981a7822`, day: 9, pages: "481–484", desired: "2026-08-05", partial: "2026-08-05", current: "session-msk-9" },
  { id: `${COURSE_ID}:day:22:5cfd0e46-a058-4dd3-bea7-68c7867129c0`, day: 10, pages: "485–488", desired: "2026-08-06", partial: "2026-08-08", current: "session-msk-10" },
  { id: `${COURSE_ID}:day:23:d347b0ca-c928-460f-8801-2eed937bf21f`, day: 11, pages: "489–492", desired: "2026-08-07", partial: "2026-08-10", current: "session-msk-11" },
  { id: `${COURSE_ID}:day:24:518211d2-a979-4a33-acfe-916353171060`, day: 12, pages: "493–495", desired: "2026-08-08", partial: "2026-08-11", current: "session-msk-12" },
  { id: `${COURSE_ID}:day:25:452872c2-6d1e-4985-9cbb-d1442b42b46f`, day: 13, pages: "496–498", desired: "2026-08-10", partial: "2026-08-12", current: "session-msk-13" },
];

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
      if (response.ok && health.lms_known_schedule_repair?.last_error) {
        throw new Error(`Schedule-repair startup failed: ${health.lms_known_schedule_repair.last_error}\n${output.join("")}`);
      }
    } catch (error) {
      if (String(error?.message || "").startsWith("Schedule-repair startup failed:")) throw error;
      // Startup reconciliation is still running.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Schedule-repair health timeout\n${output.join("")}`);
}

function courseDay({ id, date, system, systemDay, sessionId, pages = "", holiday = false }) {
  return {
    id,
    course_id: COURSE_ID,
    date,
    scheduled_date: date,
    day_number: holiday ? null : systemDay,
    instructional_day_number: holiday ? null : systemDay,
    system,
    system_day: holiday ? null : systemDay,
    day_in_system: holiday ? null : systemDay,
    title: holiday ? "Holiday / No Live Class" : `${system} — Day ${systemDay}${pages ? ` — FA 2026 pp. ${pages}` : ""}`,
    first_aid_pages: pages ? `FA 2026 pp. ${pages}` : null,
    live_session_id: holiday ? null : sessionId,
    session_id: holiday ? null : sessionId,
    status: holiday ? "holiday" : "scheduled",
    roadmap_status: holiday ? "holiday" : "scheduled",
    is_schedule_placeholder: holiday,
    is_published: true,
  };
}

function liveSession({ id, date, system, systemDay, roadmapDayId, recording = false }) {
  return {
    id,
    course_id: COURSE_ID,
    roadmap_day_id: roadmapDayId,
    scheduled_date: date,
    scheduled_time: "13:00",
    scheduled_timezone: "America/New_York",
    day_number: systemDay,
    instructional_day_number: systemDay,
    system,
    system_day: systemDay,
    title: `${system} — Day ${systemDay}`,
    topic: `${system} — Day ${systemDay}`,
    status: recording ? "completed" : "scheduled",
    join_url: `https://zoom.example/session/${id}`,
    ...(recording ? { recording_key: RECORDING_KEY, recording_url: RECORDING_URL } : {}),
  };
}

function buildPartialRepairFixture({ missingFinalTailSession = false } = {}) {
  const prefixDays = PREFIX.map((row, index) => courseDay({
    id: row.id,
    date: row.partial,
    system: "Cardiology",
    systemDay: index + 1,
    sessionId: row.holiday ? null : (row.partial === row.date ? row.session : `duplicate-prefix-${index}`),
    holiday: row.holiday,
  })).sort((left, right) => left.date.localeCompare(right.date));

  const mskDays = Object.fromEntries(MSK.map((row) => [row.day, courseDay({
    id: row.id,
    date: row.partial,
    system: "MSK",
    systemDay: row.day,
    sessionId: row.current,
    pages: row.pages,
  })]));
  const holiday = courseDay({
    id: HOLIDAY_DAY_ID,
    date: "2026-08-06",
    system: "MSK",
    systemDay: 4,
    sessionId: null,
    holiday: true,
  });
  holiday.description = "No live class was held on 29 July 2026.";
  holiday.original_day_snapshot = { ...mskDays[4], date: "2026-07-29", scheduled_date: "2026-07-29" };

  const cns1 = courseDay({ id: `${COURSE_ID}:day:26:cns-1`, date: "2026-08-13", system: "Central Nervous System", systemDay: 1, sessionId: "session-cns-1", pages: "499–502" });
  const cns2 = courseDay({ id: `${COURSE_ID}:day:27:cns-2`, date: "2026-08-14", system: "Central Nervous System", systemDay: 2, sessionId: "session-cns-2", pages: "503–506" });
  const partialMskOrder = [1, 2, 3, 5, 6, 7, 8, 9].map((day) => mskDays[day]);
  partialMskOrder.push(holiday, mskDays[4], mskDays[10], mskDays[11], mskDays[12], mskDays[13]);

  const liveSessions = {};
  for (const [index, row] of PREFIX.entries()) {
    if (!row.session) continue;
    liveSessions[row.session] = liveSession({ id: row.session, date: row.date, system: "Cardiology", systemDay: index + 1, roadmapDayId: row.id, recording: row.session === "0140b2ed-18d2-4a71-93dd-8839566d3ce5" });
    const day = prefixDays.find((item) => item.id === row.id);
    if (day.live_session_id !== row.session) {
      liveSessions[day.live_session_id] = liveSession({ id: day.live_session_id, date: row.partial, system: "Cardiology", systemDay: index + 1, roadmapDayId: row.id });
    }
  }
  for (const row of MSK) {
    const exactId = row.exact || row.current;
    if (!liveSessions[exactId]) {
      liveSessions[exactId] = liveSession({ id: exactId, date: row.desired, system: "MSK", systemDay: row.day, roadmapDayId: row.id, recording: exactId === RECORDED_SESSION_ID });
    }
    if (!liveSessions[row.current]) {
      liveSessions[row.current] = liveSession({ id: row.current, date: row.partial, system: "MSK", systemDay: row.day, roadmapDayId: row.id });
    }
  }
  liveSessions[HOLIDAY_SESSION_ID] = liveSession({ id: HOLIDAY_SESSION_ID, date: "2026-08-06", system: "MSK", systemDay: 4, roadmapDayId: HOLIDAY_DAY_ID });
  liveSessions["session-cns-1"] = liveSession({ id: "session-cns-1", date: "2026-08-13", system: "Central Nervous System", systemDay: 1, roadmapDayId: cns1.id });
  liveSessions["session-cns-2"] = liveSession({ id: "session-cns-2", date: "2026-08-14", system: "Central Nervous System", systemDay: 2, roadmapDayId: cns2.id });
  if (missingFinalTailSession) delete liveSessions["session-cns-2"];

  return {
    sentinel: "known-schedule-repair-sentinel",
    users: {},
    courses: { [COURSE_ID]: { id: COURSE_ID, name: "120-Day USMLE Step 1 Marathon", status: "active", is_active: true } },
    roadmaps: {
      [COURSE_ID]: {
        id: `roadmap:${COURSE_ID}`,
        course_id: COURSE_ID,
        start_date: "2026-07-01",
        skip_sundays: true,
        settings: { start_date: "2026-07-01", skip_sundays: true, class_time: "13:00", timezone: "America/New_York" },
        days: [...prefixDays, ...partialMskOrder, cns1, cns2],
      },
    },
    liveSessions,
    recordings: {
      [RECORDING_KEY]: {
        id: RECORDING_KEY,
        recording_key: RECORDING_KEY,
        meeting_id: "83509601689",
        session_id: RECORDED_SESSION_ID,
        course_id: COURSE_ID,
        roadmap_day_id: MSK[3].id,
        day_number: 20,
        instructional_day_number: 20,
        system: "MSK",
        system_day: 4,
        topic: "MSK — Day 4 — FA 2026 pp. 461–464",
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
        roadmap_day_id: MSK[3].id,
        notes: "# Clean Tutor Notes\n\n" + "Transcript-backed MSK teaching point. ".repeat(20),
        cleaned_notes: "# Clean Tutor Notes\n\n" + "Transcript-backed MSK teaching point. ".repeat(20),
        student_notes: "# Clean Tutor Notes\n\n" + "Transcript-backed MSK teaching point. ".repeat(20),
        published: true,
        is_published: true,
        status: "published",
      },
    },
    plans: {}, enrollments: {}, payments: {}, assessments: {}, assessmentAttempts: {},
    flashcards: {}, flashcardProgress: {}, roadmapProgress: {}, dailyTaskProgress: {},
    pointEvents: {}, weakConceptLogs: {}, adaptiveAssignments: {}, adaptiveFlashcardQueues: {},
    attendance: {}, leaderboard: {},
  };
}

async function withServerFixture(fixture, callback) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-known-schedule-repair-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const crmPath = path.join(dataDir, "crm-db.json");
  const aylaPath = path.join(dataDir, "aylamed-db.json");
  const crmOriginal = JSON.stringify({ sentinel: "crm-untouched-known-schedule" });
  const aylaOriginal = JSON.stringify({ sentinel: "ayla-untouched-known-schedule" });
  await fs.writeFile(livePath, JSON.stringify(fixture, null, 2));
  await fs.writeFile(crmPath, crmOriginal);
  await fs.writeFile(aylaPath, aylaOriginal);

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
      AUTH_JWT_SECRET: "known-schedule-repair-secret",
      AYLA_AUTH_JWT_SECRET: "known-schedule-repair-ayla-secret",
      DATABASE_URL: "",
      OPENAI_API_KEY: "",
      NEXTGEN_MSK_2026_07_30_RECORDING_KEY: RECORDING_KEY,
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
    await callback({ health, livePath, crmPath, aylaPath, crmOriginal, aylaOriginal, baseUrl, output });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

test("startup transactionally recovers the persisted July 29 partial repair without deleting identities or changing URLs", { timeout: 80_000 }, async () => {
  const fixture = buildPartialRepairFixture();
  const originalSessionIds = Object.keys(fixture.liveSessions);
  const originalSessionUrls = Object.fromEntries(originalSessionIds.map((id) => [id, fixture.liveSessions[id].join_url || null]));
  const originalRoadmapDayIds = fixture.roadmaps[COURSE_ID].days.map((day) => day.id);

  await withServerFixture(fixture, async ({ health, livePath, crmPath, aylaPath, crmOriginal, aylaOriginal }) => {
    const report = health.lms_known_schedule_repair.last_result;
    assert.equal(health.lms_known_schedule_repair_build, BUILD);
    assert.equal(report.repaired, true);
    assert.equal(report.reason, "repaired_transactionally");
    assert.equal(report.current_system_day, 5);
    assert.equal(report.recording_preserved, true);
    assert.equal(report.recording_session_preserved, true);
    assert.equal(report.session_ids_preserved, true);
    assert.equal(report.session_urls_preserved, true);
    assert.equal(report.roadmap_days_preserved, true);
    assert.equal(report.deleted_records, 0);
    assert.equal(report.new_tail_sessions_created, 1);
    assert.equal(report.final_teaching_date, "2026-08-12");

    const saved = JSON.parse(await fs.readFile(livePath, "utf8"));
    const roadmap = saved.roadmaps[COURSE_ID];
    const at = (date) => roadmap.days.find((day) => String(day.date).slice(0, 10) === date);
    assert.equal(roadmap.days.length, originalRoadmapDayIds.length);
    assert.deepEqual(new Set(roadmap.days.map((day) => day.id)), new Set(originalRoadmapDayIds));
    assert.equal(new Set(roadmap.days.map((day) => day.date)).size, roadmap.days.length);

    assert.equal(at("2026-07-04").status, "holiday");
    assert.equal(at("2026-07-11").system_day, 6);
    assert.equal(at("2026-07-18").status, "holiday");
    assert.equal(at("2026-07-24").system_day, 16);
    assert.equal(at("2026-07-25").system_day, 1);
    assert.equal(at("2026-07-29").id, HOLIDAY_DAY_ID);
    assert.equal(at("2026-07-29").status, "holiday");
    assert.equal(at("2026-07-29").live_session_id, null);
    assert.equal(at("2026-07-30").id, MSK[3].id);
    assert.equal(at("2026-07-30").system_day, 4);
    assert.equal(at("2026-07-30").live_session_id, RECORDED_SESSION_ID);
    assert.equal(at("2026-07-31").id, MSK[4].id);
    assert.equal(at("2026-07-31").system_day, 5);
    assert.equal(at("2026-07-31").live_session_id, CURRENT_SESSION_ID);
    assert.equal(at("2026-08-01").system_day, 6);
    assert.equal(at("2026-08-01").live_session_id, "session-msk-7");
    assert.equal(at("2026-08-03").system_day, 7);
    assert.equal(at("2026-08-10").system_day, 13);
    assert.equal(at("2026-08-11").system, "Central Nervous System");
    assert.equal(at("2026-08-11").live_session_id, "session-cns-2");
    assert.notEqual(at("2026-08-12").live_session_id, "session-cns-2");

    assert.equal(Object.keys(saved.liveSessions).length, originalSessionIds.length + 1);
    for (const id of originalSessionIds) {
      assert.ok(saved.liveSessions[id], `session ${id} was preserved`);
      assert.equal(saved.liveSessions[id].join_url || null, originalSessionUrls[id], `session ${id} URL was preserved`);
    }
    assert.equal(saved.liveSessions["duplicate-msk-5"].status, "cancelled");
    assert.equal(saved.liveSessions[RECORDED_SESSION_ID].id, RECORDED_SESSION_ID);
    assert.equal(saved.liveSessions[RECORDED_SESSION_ID].roadmap_day_id, MSK[3].id);
    assert.equal(saved.liveSessions[RECORDED_SESSION_ID].recording_url, RECORDING_URL);
    assert.equal(saved.liveSessions[CURRENT_SESSION_ID].roadmap_day_id, MSK[4].id);
    assert.match(saved.liveSessions[CURRENT_SESSION_ID].title, /Day 5/i);

    const recording = saved.recordings[RECORDING_KEY];
    assert.equal(recording.recording_key, RECORDING_KEY);
    assert.equal(recording.session_id, RECORDED_SESSION_ID);
    assert.equal(recording.roadmap_day_id, MSK[3].id);
    assert.equal(recording.system_day, 4);
    assert.equal(recording.recording_url, RECORDING_URL);
    assert.equal(recording.share_url, SHARE_URL);
    assert.equal(recording.transcript_url, TRANSCRIPT_URL);
    assert.equal(recording.published, true);
    assert.equal(saved.notes[RECORDED_SESSION_ID].status, "published");
    assert.equal(saved.sentinel, "known-schedule-repair-sentinel");
    assert.equal(await fs.readFile(crmPath, "utf8"), crmOriginal);
    assert.equal(await fs.readFile(aylaPath, "utf8"), aylaOriginal);
  });
});

test("a late safety stop cannot leak staged roadmap mutations into the live file or cache", { timeout: 80_000 }, async () => {
  const fixture = buildPartialRepairFixture({ missingFinalTailSession: true });
  const originalJson = JSON.stringify(fixture, null, 2);

  await withServerFixture(fixture, async ({ health, livePath, baseUrl }) => {
    const report = health.lms_known_schedule_repair.last_result;
    assert.equal(report.changed, false);
    assert.equal(report.safe_stop, true);
    assert.match(report.reason, /^tail_session_missing:/);
    assert.equal(await fs.readFile(livePath, "utf8"), originalJson);

    const response = await fetch(`${baseUrl}/roadmap/course/${COURSE_ID}`);
    const publicRoadmap = await response.json();
    const july29 = publicRoadmap.days.find((day) => day.date === "2026-07-29");
    assert.equal(july29.system_day, 2);
    assert.equal(publicRoadmap.days.find((day) => day.id === HOLIDAY_DAY_ID).date, "2026-08-06");
  });
});
