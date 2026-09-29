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


test("roadmap restructure relabels taught days, merges future days and removes surplus days safely", { timeout: 70_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "roadmap-restructure-http-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const courseId = "course-roadmap-restructure";
  const password = "RoadmapAdmin9!";
  const now = new Date().toISOString();
  let offset = -22;
  const mk = (id, system, systemDay, pages, extra = {}) => {
    const day = teachingDay({ id, courseId, date: dateKey(offset++), system, systemDay, title: `${system} — Day ${systemDay} — FA 2026 pp. ${pages}`, pages: `FA 2026 pp. ${pages}`, sessionId: `s-${id}` });
    const qids = [`${id}-q1`, `${id}-q2`];
    Object.assign(day, {
      lecture_title: `${system} Lecture ${systemDay}`, video_library_lecture: `${system} Lecture ${systemDay}`,
      uworld_qids: qids, mapped_uworld_qids: qids, qid_count: 2,
      description: `Read assigned book pages: FA 2026 pp. ${pages}. Watch: ${system} Lecture ${systemDay}. Complete mapped QIDs: ${qids.join(", ")}.`,
    }, extra);
    return day;
  };
  // System days are numbered by position, so the fixture needs the earlier CNS days that the live roadmap has.
  const cnsEarly = Array.from({ length: 18 }, (_, i) => mk(`cns${i + 1}`, "Central Nervous System", i + 1, `${512 + i * 3}–${514 + i * 3}`));
  const cns19 = mk("cns19", "Central Nervous System", 19, "566–568");
  const rep1 = mk("rep1", "Reproductive", 1, "629–632");
  const rep2 = mk("rep2", "Reproductive", 2, "633–636");
  const rep3 = mk("rep3", "Reproductive", 3, "637–640");
  offset = 0;
  const rep4 = mk("rep4", "Reproductive", 4, "641–644");
  const rep5 = mk("rep5", "Reproductive", 5, "645–648");
  const imm = Array.from({ length: 7 }, (_, i) => mk(`imm${i + 1}`, "Immunology", i + 1, `${93 + i * 4}–${96 + i * 4}`));
  const hem = Array.from({ length: 11 }, (_, i) => mk(`hem${i + 1}`, "Hematology", i + 1, `${409 + i * 4}–${412 + i * 4}`));
  const psych1 = mk("psych1", "Psychiatry", 1, "569–572");
  const days = [...cnsEarly, cns19, rep1, rep2, rep3, rep4, rep5, ...imm, ...hem, psych1];
  days.forEach((day, index) => { day.order = index + 1; day.day_number = index + 1; day.instructional_day_number = index + 1; day.schedule_slot_number = index + 1; });
  const sessions = Object.fromEntries(days.map((day) => [day.live_session_id, {
    id: day.live_session_id, course_id: courseId, roadmap_day_id: day.id, scheduled_date: day.date, scheduled_time: "13:00",
    title: day.title, topic: day.title, system: day.system, system_day: day.system_day,
    status: day.date < dateKey(0) ? "completed" : "scheduled", created_at: now, updated_at: now,
  }]));
  const liveDb = {
    users: { admin: { id: "admin", email: "roadmap-admin@example.com", name: "Roadmap Admin", role: "admin", status: "active", verified: true, ...passwordRecord(password), created_at: now, updated_at: now } },
    courses: { [courseId]: { id: courseId, name: "Restructure Course", status: "active", is_active: true } },
    roadmaps: { [courseId]: { id: `roadmap:${courseId}`, course_id: courseId, start_date: days[0].date, skip_sundays: false,
      settings: { start_date: days[0].date, skip_sundays: false, class_time: "13:00", timezone: "America/New_York" }, days, created_at: now, updated_at: now } },
    liveSessions: sessions,
    recordings: {
      "rec-rep1": { id: "rec-rep1", course_id: courseId, session_id: "s-rep1", roadmap_day_id: "rep1", topic: rep1.title, system: "Reproductive", published: true, recording_url: "https://vimeo.com/1", updated_at: now },
      "rec-rep2": { id: "rec-rep2", course_id: courseId, session_id: "s-rep2", roadmap_day_id: "rep2", topic: rep2.title, system: "Reproductive", published: true, recording_url: "https://vimeo.com/2", updated_at: now },
    },
    notes: { "s-rep2": { id: "note-rep2", course_id: courseId, session_id: "s-rep2", roadmap_day_id: "rep2", title: rep2.title, updated_at: now } },
    attendance: { "att-rep1": { id: "att-rep1", course_id: courseId, session_id: "s-rep1", roadmap_day_id: "rep1", user_id: "student-1", status: "present" } },
    assessments: {}, assessmentAttempts: {}, flashcards: {}, flashcardProgress: {}, roadmapProgress: {}, pointEvents: {}, weakConceptLogs: {},
    dailyTaskProgress: { "dtp-rep5": { id: "dtp-rep5", course_id: courseId, roadmap_day_id: "rep5", user_id: "student-1", task_key: "read_pages", completed: true } },
  };
  await fs.writeFile(livePath, JSON.stringify(liveDb, null, 2));
  await fs.writeFile(path.join(dataDir, "crm-db.json"), JSON.stringify({ sentinel: "crm" }));
  await fs.writeFile(path.join(dataDir, "aylamed-db.json"), JSON.stringify({ sentinel: "ayla" }));

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, PORT: String(port), TZ: "UTC", DATA_DIR: dataDir, AUTH_JWT_SECRET: "roadmap-restructure-secret",
      AYLA_AUTH_JWT_SECRET: "roadmap-restructure-ayla-secret", DATABASE_URL: "", OPENAI_API_KEY: "",
      NEXTGEN_BACKEND_HEARTBEAT_ENABLED: "false", NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false", ZOOM_RECORDING_RECOVERY_ENABLED: "false", NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  try {
    await waitForHealth(baseUrl, child, output);
    const login = await api(baseUrl, "/auth/login", { method: "POST", body: { email: "roadmap-admin@example.com", password } });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    const token = login.payload.token;

    const hemGroups = [["hem1", "hem2"], ["hem2", "hem3"], ["hem3", "hem4"], ["hem4", "hem5", "hem6"], ["hem6", "hem7"], ["hem7", "hem8"], ["hem8", "hem9", "hem10"], ["hem10", "hem11"]];
    const request = {
      course_id: courseId,
      first_movable_day_id: "rep4",
      allow_today_unstarted: true,
      content_changes: {
        rep1: { system: "Central Nervous System", source_day_ids: ["cns19"] },
        rep2: { system: "Immunology", source_day_ids: ["imm1"] },
        rep3: { system: "Immunology", source_day_ids: ["imm2"] },
        rep4: { system: "Immunology", source_day_ids: ["imm3", "imm4"], first_aid_pages: "101–105" },
        rep5: { system: "Immunology", source_day_ids: ["imm4", "imm5"], first_aid_pages: "106–110" },
        imm1: { system: "Immunology", source_day_ids: ["imm5", "imm6"], first_aid_pages: "111–115" },
        imm2: { system: "Immunology", source_day_ids: ["imm6", "imm7"], first_aid_pages: "116–120" },
        ...Object.fromEntries(hemGroups.map((group, i) => [`hem${i + 1}`, { system: "Hematology", source_day_ids: group, first_aid_pages: `${409 + i * 5}–${413 + i * 5}` }])),
        imm3: { system: "Reproductive", source_day_ids: ["rep1"] },
        imm4: { system: "Reproductive", source_day_ids: ["rep2"] },
        imm5: { system: "Reproductive", source_day_ids: ["rep3"] },
        imm6: { system: "Reproductive", source_day_ids: ["rep4"] },
        imm7: { system: "Reproductive", source_day_ids: ["rep5"] },
      },
      remove_day_ids: ["hem9", "hem10", "hem11"],
      ordered_day_ids: ["rep4", "rep5", "imm1", "imm2", ...Array.from({ length: 8 }, (_, i) => `hem${i + 1}`), "imm3", "imm4", "imm5", "imm6", "imm7", "psych1"],
    };
    const before = await fs.readFile(livePath, "utf8");
    const blocked = await api(baseUrl, "/admin/roadmap/resequence", { method: "POST", token, body: { ...request, dry_run: true } });
    assert.equal(blocked.response.status, 409, "future day with student progress is protected by default");
    const blockedDay = blocked.payload.protected_days.find((day) => day.roadmap_day_id === "rep5");
    assert.equal(blockedDay.reason, "student progress recorded");
    assert.deepEqual(blockedDay.student_progress, { records: { dailyTaskProgress: 1 }, students: 1, kinds: { "dailyTaskProgress:read_pages": 1 } });

    request.allow_student_progress_day_ids = ["rep5"];
    const preview = await api(baseUrl, "/admin/roadmap/resequence", { method: "POST", token, body: { ...request, dry_run: true } });
    assert.equal(preview.payload.student_progress_days_allowed?.[0]?.roadmap_day_id, "rep5");
    assert.equal(preview.response.status, 200, JSON.stringify(preview.payload));
    assert.equal(await fs.readFile(livePath, "utf8"), before, "preview must not write");

    const unsafe = await api(baseUrl, "/admin/roadmap/resequence", { method: "POST", token, body: { ...request, first_movable_day_id: "rep3", ordered_day_ids: ["rep3", ...request.ordered_day_ids], dry_run: true } });
    assert.equal(unsafe.response.status, 409, "a completed day inside the movable part cannot get new content");

    const applied = await api(baseUrl, "/admin/roadmap/resequence", { method: "POST", token, body: { ...request, dry_run: false, confirm: "RESEQUENCE_ROADMAP", expected_roadmap_updated_at: preview.payload.roadmap_updated_at } });
    assert.equal(applied.response.status, 200, JSON.stringify(applied.payload));
    const after = JSON.parse(await fs.readFile(livePath, "utf8"));
    const road = after.roadmaps[courseId].days;
    const byId = Object.fromEntries(road.map((day) => [day.id, day]));
    const label = (id) => `${byId[id].system}:${byId[id].system_day}`;
    assert.equal(label("cns19"), "Central Nervous System:19");
    assert.equal(label("rep1"), "Central Nervous System:20");
    assert.equal(label("rep2"), "Immunology:1");
    assert.equal(label("rep3"), "Immunology:2");
    assert.equal(label("rep4"), "Immunology:3");
    assert.equal(label("imm2"), "Immunology:6");
    assert.equal(label("hem8"), "Hematology:8");
    assert.equal(label("imm3"), "Reproductive:1");
    assert.equal(label("imm7"), "Reproductive:5");
    assert.equal(road.length, days.length - 3);
    assert.ok(!byId.hem9 && !byId.hem10 && !byId.hem11);
    for (const id of ["cns19", "rep1", "rep2", "rep3"]) assert.equal(byId[id].date, days.find((d) => d.id === id).date, `${id} keeps its date`);
    assert.equal(byId.rep4.date, dateKey(0));
    assert.match(byId.rep2.title, /Immunology — Day 1 — FA 2026 pp\. 93–96/);
    assert.match(byId.rep4.first_aid_pages, /101–105/);
    assert.deepEqual(byId.rep4.uworld_qids, ["imm3-q1", "imm3-q2", "imm4-q1", "imm4-q2"]);
    assert.match(byId.imm3.title, /Reproductive — Day 1 — FA 2026 pp\. 629–632/);
    assert.equal(byId.rep1.live_session_id, "s-rep1");
    assert.equal(after.liveSessions["s-rep1"].status, "completed");
    assert.equal(after.liveSessions["s-rep1"].system, "Central Nervous System");
    assert.equal(after.recordings["rec-rep1"].session_id, "s-rep1");
    assert.equal(after.recordings["rec-rep1"].published, true);
    assert.equal(after.recordings["rec-rep1"].assignment_locked, true);
    assert.equal(after.recordings["rec-rep1"].assignment_source, "admin_explicit_session");
    assert.equal(after.recordings["rec-rep2"].system, "Immunology");
    assert.equal(after.notes["s-rep2"].session_id, "s-rep2");
    assert.equal(after.attendance["att-rep1"].session_id, "s-rep1");
    const keptProgress = after.dailyTaskProgress["dtp-rep5"];
    assert.equal(keptProgress?.roadmap_day_id, "rep5", "allowed progress is kept, not deleted");
    assert.equal(keptProgress.user_id, "student-1");
    assert.equal(keptProgress.completed, true);
    for (const id of ["hem9", "hem10", "hem11"]) assert.equal(after.liveSessions[`s-${id}`].status, "cancelled");
    assert.equal(after.liveSessions["s-imm3"].status, "scheduled");
    assert.match(after.liveSessions["s-rep4"].title, /Immunology/);
  } finally {
    if (child.exitCode === null) await new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGTERM"); });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
