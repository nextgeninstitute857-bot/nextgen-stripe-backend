import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COURSE_ID = "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c";
const BUILD = "v263-dermatology-cns-transactional-schedule-repair";
const DERM_SESSION_IDS = [
  "2aa21d07-415a-44e6-b046-5564ce9527ae",
  "8806a5e3-a990-4fe3-b02d-5c45d4feca85",
  "f75c2925-0d93-47bd-9467-3d08a869d143",
  "a760f71d-7876-4299-8b90-804b65c78c89",
  "35b88a22-6ff8-46f7-8426-c7b90330d89d",
];
const CNS_START_SESSION_ID = "37301895-5a31-4af8-87b0-2ae52162c9ae";
const CNS_DAY_IDS = [
  `${COURSE_ID}:day:28:aee5474e-c0ba-4c8d-be9c-d1110f3f2d4c`,
  `${COURSE_ID}:day:29:77d9db7c-042e-4988-bb4d-0f68368e453d`,
  `${COURSE_ID}:day:30:579a5ba8-ee68-41cc-9e58-505a3b732946`,
  `${COURSE_ID}:day:31:c31a8d85-0b6d-4f36-8c1d-f9a07122517c`,
  `${COURSE_ID}:day:32:b96e4833-2064-40ab-9eeb-6bdf42ff0ef8`,
  `${COURSE_ID}:day:33:07f524f6-3fcf-4166-b72c-78854bad936e`,
  `${COURSE_ID}:day:34:test-cns-7`,
  `${COURSE_ID}:day:35:test-cns-8`,
];
const DERM_DAY_IDS = [
  `${COURSE_ID}:day:dermatology:b2a63e8b-bbe1-486a-8ea5-a0150ec12716`,
  `${COURSE_ID}:day:dermatology:7cb197f6-dbc8-4a3d-8611-9074eb4b300c`,
  `${COURSE_ID}:day:dermatology:cd531369-481b-4d07-bc1a-f0f41b5b3558`,
  `${COURSE_ID}:day:dermatology:8ca285a5-7c12-48e5-a827-d2ec2bf7934d`,
];
const HOLIDAY_DAY_ID = `${COURSE_ID}:day:holiday:f6e7dda7-da1b-43da-867a-d73325308153`;
const RECORDING_ID = "zoom-recording:dermatology-day-1";
const RECORDING_URL = "https://zoom.example/dermatology/day-1";
const TRANSCRIPT_URL = "https://zoom.example/dermatology/day-1/transcript";

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

async function waitForRepair(baseUrl, child, output, timeoutMs = 70_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Schedule-repair server exited (${child.exitCode})\n${output.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      const health = await response.json();
      if (response.ok && health.lms_dermatology_cns_schedule_repair?.last_result) return health;
      if (response.ok && health.lms_dermatology_cns_schedule_repair?.last_error) {
        throw new Error(`Dermatology/CNS startup repair failed: ${health.lms_dermatology_cns_schedule_repair.last_error}\n${output.join("")}`);
      }
    } catch (error) {
      if (String(error?.message || "").startsWith("Dermatology/CNS startup repair failed:")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Dermatology/CNS schedule-repair health timeout\n${output.join("")}`);
}

function teachingDay({ id, date, system, systemDay, sessionId, pages }) {
  const qids = [`${systemDay}01`, `${systemDay}02`];
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
    uworld_qids: qids,
    mapped_uworld_qids: qids,
    qid_count: qids.length,
    task_items: [],
    tasks: [],
    flashcards_enabled: true,
    live_session_id: sessionId,
    session_id: sessionId,
    status: "scheduled",
    roadmap_status: "scheduled",
    is_published: true,
  };
}

function session({ id, date, dayId, system, systemDay, recorded = false }) {
  return {
    id,
    course_id: COURSE_ID,
    roadmap_day_id: dayId,
    scheduled_date: date,
    scheduled_time: "13:00",
    scheduled_timezone: "America/New_York",
    title: `${system} — Day ${systemDay}`,
    topic: `${system} — Day ${systemDay}`,
    system,
    system_day: systemDay,
    status: recorded ? "completed" : "scheduled",
    join_url: `https://zoom.example/join/${id}`,
    start_url: `https://zoom.example/start/${id}`,
    ...(recorded ? { recording_url: RECORDING_URL, transcript_url: TRANSCRIPT_URL } : {}),
  };
}

function buildFixture() {
  const prefixDay = teachingDay({
    id: `${COURSE_ID}:day:pushed:0583edbc-11e3-4188-905b-3a01c1e6e74e`,
    date: "2026-08-14",
    system: "MSK",
    systemDay: 13,
    sessionId: "2899c92d-144c-4c43-9068-2b91f1b512df",
    pages: "496–498",
  });
  const dates = ["2026-08-15", "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-24", "2026-08-25", "2026-08-26"];
  const sessionIds = [
    ...DERM_SESSION_IDS,
    CNS_START_SESSION_ID,
    "449b3547-126b-4034-8622-26d1ea5b2550",
    "64cb7e2b-668b-4e63-9861-8a94a4d1b1eb",
    "bc9ad7ed-ff3a-4744-8f94-e6dd772d39bf",
    "07a1b838-db39-4526-b573-3f0574563db4",
  ];
  const suffixDays = dates.map((date, index) => {
    if (index < 8) return teachingDay({ id: CNS_DAY_IDS[index], date, system: "Central Nervous System", systemDay: index + 1, sessionId: sessionIds[index], pages: `${499 + index * 4}–${502 + index * 4}` });
    return teachingDay({ id: `${COURSE_ID}:day:${36 + index}:tail-${index}`, date, system: index === 8 ? "Reproductive" : "Psychiatry", systemDay: 1, sessionId: sessionIds[index], pages: index === 8 ? "629–632" : "569–572" });
  });

  const liveSessions = {
    [prefixDay.live_session_id]: session({ id: prefixDay.live_session_id, date: prefixDay.date, dayId: prefixDay.id, system: "MSK", systemDay: 13 }),
  };
  for (const [index, day] of suffixDays.entries()) {
    liveSessions[sessionIds[index]] = session({
      id: sessionIds[index],
      date: dates[index],
      dayId: day.id,
      system: day.system,
      systemDay: day.system_day,
      recorded: index === 0,
    });
  }

  return {
    sentinel: "dermatology-cns-repair-sentinel",
    users: {}, enrollments: {}, payments: {}, plans: {},
    courses: { [COURSE_ID]: { id: COURSE_ID, name: "120-Day USMLE Step 1 Marathon", status: "active" } },
    roadmaps: {
      [COURSE_ID]: {
        id: `roadmap:${COURSE_ID}`,
        course_id: COURSE_ID,
        start_date: "2026-07-01",
        settings: { start_date: "2026-07-01", skip_sundays: true, class_time: "13:00", timezone: "America/New_York", system_sequence: ["Cardiology", "MSK", "Central Nervous System", "Reproductive", "Psychiatry"] },
        days: [prefixDay, ...suffixDays],
      },
    },
    liveSessions,
    recordings: {
      [RECORDING_ID]: {
        id: RECORDING_ID,
        recording_key: RECORDING_ID,
        session_id: DERM_SESSION_IDS[0],
        course_id: COURSE_ID,
        roadmap_day_id: CNS_DAY_IDS[0],
        topic: "Central Nervous System — Day 1",
        meeting_id: "85825517950",
        recording_url: RECORDING_URL,
        transcript_url: TRANSCRIPT_URL,
        published: true,
      },
    },
    notes: {
      [DERM_SESSION_IDS[0]]: {
        id: DERM_SESSION_IDS[0],
        session_id: DERM_SESSION_IDS[0],
        course_id: COURSE_ID,
        roadmap_day_id: CNS_DAY_IDS[0],
        notes: "Dermatology teaching notes. ".repeat(20),
        cleaned_notes: "Dermatology teaching notes. ".repeat(20),
        published: true,
        is_published: true,
        status: "published",
      },
    },
    flashcards: {
      "derm-card-1": {
        id: "derm-card-1",
        session_id: DERM_SESSION_IDS[0],
        course_id: COURSE_ID,
        roadmap_day_id: CNS_DAY_IDS[0],
        system: "Central Nervous System",
        front: "Dermatology prompt",
        back: "Dermatology answer",
        is_published: true,
        status: "published",
      },
    },
    flashcardProgress: {}, assessments: {}, assessmentAttempts: {}, roadmapProgress: {},
    dailyTaskProgress: {}, pointEvents: {}, weakConceptLogs: {}, adaptiveAssignments: {},
    adaptiveFlashcardQueues: {}, attendance: {}, leaderboard: {},
  };
}

async function withFixture(fixture, callback) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-dermatology-cns-repair-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  await fs.writeFile(livePath, JSON.stringify(fixture, null, 2));
  await fs.writeFile(path.join(dataDir, "crm-db.json"), JSON.stringify({ sentinel: "crm-untouched" }));
  await fs.writeFile(path.join(dataDir, "aylamed-db.json"), JSON.stringify({ sentinel: "ayla-untouched" }));
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
      AUTH_JWT_SECRET: "dermatology-cns-repair-secret",
      AYLA_AUTH_JWT_SECRET: "dermatology-cns-repair-ayla-secret",
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
    await callback({ health, livePath, baseUrl, output });
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

test("startup inserts four Dermatology days, disconnects its recording from CNS, and preserves the full later academic sequence", { timeout: 80_000 }, async () => {
  const fixture = buildFixture();
  const originalDayIds = fixture.roadmaps[COURSE_ID].days.map((day) => day.id);
  const originalSessionIds = Object.keys(fixture.liveSessions);
  const originalSessionUrls = Object.fromEntries(originalSessionIds.map((id) => [id, { join_url: fixture.liveSessions[id].join_url, start_url: fixture.liveSessions[id].start_url, recording_url: fixture.liveSessions[id].recording_url || null }]));
  const originalPackets = Object.fromEntries(fixture.roadmaps[COURSE_ID].days.slice(1).map((day) => [day.id, { system: day.system, pages: day.first_aid_pages, qids: day.uworld_qids, lecture: day.lecture_title }]));

  await withFixture(fixture, async ({ health, livePath, baseUrl }) => {
    const report = health.lms_dermatology_cns_schedule_repair.last_result;
    assert.equal(health.lms_dermatology_cns_schedule_repair_build, BUILD);
    assert.equal(report.repaired, true);
    assert.equal(report.reason, "repaired_transactionally");
    assert.equal(report.dermatology_days, 4);
    assert.equal(report.cns_days, 8);
    assert.equal(report.inserted_schedule_rows, 5);
    assert.equal(report.new_tail_sessions_created, 5);
    assert.equal(report.august_15_recording_preserved, true);
    assert.equal(report.august_15_recording_disconnected_from_cns, true);
    assert.equal(report.deleted_records, 0);

    const response = await fetch(`${baseUrl}/roadmap/course/${COURSE_ID}`);
    const publicRoadmap = await response.json();
    assert.equal(response.ok, true);
    const at = (date) => publicRoadmap.days.find((day) => day.date === date);
    assert.equal(at("2026-08-15").system, "Dermatology");
    assert.equal(at("2026-08-15").system_day, 1);
    assert.equal(at("2026-08-17").system_day, 2);
    assert.equal(at("2026-08-18").system_day, 3);
    assert.equal(at("2026-08-19").status, "holiday");
    assert.equal(at("2026-08-20").system_day, 4);
    assert.equal(at("2026-08-21").id, CNS_DAY_IDS[0]);
    assert.equal(at("2026-08-21").system, "Central Nervous System");
    assert.equal(at("2026-08-21").system_day, 1);
    assert.equal(at("2026-08-21").live_session_id, CNS_START_SESSION_ID);

    const saved = JSON.parse(await fs.readFile(livePath, "utf8"));
    const roadmap = saved.roadmaps[COURSE_ID];
    assert.equal(roadmap.days.length, originalDayIds.length + 5);
    for (const id of originalDayIds) assert.ok(roadmap.days.some((day) => day.id === id), `roadmap day ${id} was preserved`);
    for (const id of DERM_DAY_IDS) assert.ok(roadmap.days.some((day) => day.id === id), `Dermatology day ${id} was inserted`);
    assert.ok(roadmap.days.some((day) => day.id === HOLIDAY_DAY_ID));
    assert.deepEqual(roadmap.settings.system_sequence.slice(0, 4), ["Cardiology", "MSK", "Dermatology", "Central Nervous System"]);

    for (const [id, packet] of Object.entries(originalPackets)) {
      const day = roadmap.days.find((item) => item.id === id);
      assert.deepEqual({ system: day.system, pages: day.first_aid_pages, qids: day.uworld_qids, lecture: day.lecture_title }, packet, `academic packet ${id} changed`);
    }
    for (const id of originalSessionIds) {
      assert.ok(saved.liveSessions[id], `session ${id} was preserved`);
      assert.deepEqual({ join_url: saved.liveSessions[id].join_url, start_url: saved.liveSessions[id].start_url, recording_url: saved.liveSessions[id].recording_url || null }, originalSessionUrls[id], `session URLs changed for ${id}`);
    }
    assert.equal(saved.liveSessions[DERM_SESSION_IDS[0]].roadmap_day_id, DERM_DAY_IDS[0]);
    assert.equal(saved.liveSessions[DERM_SESSION_IDS[0]].system, "Dermatology");
    assert.equal(saved.liveSessions[CNS_START_SESSION_ID].roadmap_day_id, CNS_DAY_IDS[0]);
    assert.equal(saved.liveSessions[CNS_START_SESSION_ID].system, "Central Nervous System");
    assert.equal(saved.liveSessions[CNS_START_SESSION_ID].system_day, 1);
    assert.equal(saved.recordings[RECORDING_ID].session_id, DERM_SESSION_IDS[0]);
    assert.equal(saved.recordings[RECORDING_ID].roadmap_day_id, DERM_DAY_IDS[0]);
    assert.equal(saved.recordings[RECORDING_ID].recording_url, RECORDING_URL);
    assert.equal(saved.recordings[RECORDING_ID].transcript_url, TRANSCRIPT_URL);
    assert.equal(saved.notes[DERM_SESSION_IDS[0]].roadmap_day_id, DERM_DAY_IDS[0]);
    assert.equal(saved.flashcards["derm-card-1"].roadmap_day_id, DERM_DAY_IDS[0]);
    assert.equal(saved.flashcards["derm-card-1"].front, "Dermatology prompt");
    assert.equal(saved.liveSessions[DERM_SESSION_IDS[3]].status, "cancelled");
    assert.equal(new Set(roadmap.days.map((day) => day.date)).size, roadmap.days.length);
  });
});
