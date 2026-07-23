import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function passwordRecord(password, salt) {
  return { salt, password_hash: crypto.pbkdf2Sync(password, salt, 120000, 64, "sha512").toString("hex") };
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

async function waitForHealth(baseUrl, child, output, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Smoke server exited early (${child.exitCode})\n${output.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for smoke server\n${output.join("")}`);
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
  try { payload = JSON.parse(text); } catch { throw new Error(`${method} ${route} returned ${response.status}: ${text.slice(0, 500)}`); }
  return { response, payload };
}

test("v214 federates progress read-only and keeps social lifecycle inside AylaMed", { timeout: 50000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aylamed-v214-http-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const crmPath = path.join(dataDir, "crm-db.json");
  const aylaPath = path.join(dataDir, "aylamed-db.json");
  const password = "ProgressSmoke9!";
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const at = (date, hour = "08") => `${date}T${hour}:00:00.000Z`;
  const future = new Date(Date.now() + 365 * 86400000).toISOString();

  const liveDb = {
    sentinel: "lms-untouched-v214",
    users: {
      "lms-1": { id: "lms-1", email: "progress@example.com", name: "LMS Progress Doctor", role: "student", status: "active" },
      "lms-2": { id: "lms-2", email: "candidate@example.com", name: "LMS Candidate Doctor", role: "student", status: "active" },
      "lms-3": { id: "lms-3", email: "other-track@example.com", name: "Other Track", role: "student", status: "active" },
    },
    courses: {
      "course-step1": { id: "course-step1", title: "USMLE Step 1 Marathon", exam_type: "USMLE Step 1" },
      "course-step2": { id: "course-step2", title: "USMLE Step 2 CK", exam_type: "USMLE Step 2 CK" },
    },
    enrollments: {
      "enroll-1": { id: "enroll-1", user_id: "lms-1", course_id: "course-step1", access_granted: true, is_demo: false },
      "enroll-2": { id: "enroll-2", user_id: "lms-1", course_id: "course-step2", access_granted: true, is_demo: false },
      "enroll-3": { id: "enroll-3", user_id: "lms-2", course_id: "course-step1", access_granted: true, is_demo: false },
    },
    roadmaps: {
      "course-step1": {
        course_id: "course-step1",
        days: [
          { id: "day-1", date: daysAgo(2), system: "Cardiovascular", day_number: 1, week_number: 1, is_published: true },
          { id: "day-2", date: daysAgo(1), system: "Renal", day_number: 2, week_number: 1, is_published: true },
          { id: "day-3", date: today, system: "Respiratory", day_number: 3, week_number: 1, is_published: true },
        ],
      },
    },
    dailyTaskProgress: {
      "lms-day-1": { id: "lms-day-1", course_id: "course-step1", user_id: "lms-1", day_id: "day-1", date: daysAgo(2), completed: true, completed_task_count: 1, updated_at: at(daysAgo(2)) },
      "lms-day-2": { id: "lms-day-2", course_id: "course-step1", user_id: "lms-1", day_id: "day-2", date: daysAgo(1), completed: true, completed_task_count: 1, updated_at: at(daysAgo(1)) },
    },
    roadmapProgress: {},
    attendance: {},
    pointEvents: {},
    leaderboard: {
      "course-step1:lms-1": { id: "course-step1:lms-1", course_id: "course-step1", user_id: "lms-1", user_name: "LMS Progress Doctor", attendance_points: 10, task_points: 30, assessment_points: 20, total_points: 60, updated_at: at(today) },
      "course-step1:lms-2": { id: "course-step1:lms-2", course_id: "course-step1", user_id: "lms-2", user_name: "LMS Candidate Doctor", attendance_points: 5, task_points: 25, assessment_points: 10, total_points: 40, updated_at: at(today) },
      "course-step2:lms-1": { id: "course-step2:lms-1", course_id: "course-step2", user_id: "lms-1", user_name: "SHOULD-NOT-CROSS-EXAM", total_points: 999 },
    },
    weakAreaProfiles: {
      "course-step1:lms-1": {
        id: "course-step1:lms-1",
        course_id: "course-step1",
        user_id: "lms-1",
        baseline_status: "completed",
        systems: {
          Cardiovascular: { system: "Cardiovascular", current_mastery: 45, baseline_mastery: 55, improvement: -10, questions_attempted: 8, weak_topics: ["Perfusion"] },
        },
        updated_at: at(today),
      },
    },
    studyPartnerProfiles: {
      "profile-1": { id: "profile-1", user_id: "lms-1", exam_type: "USMLE Step 1", timezone: "Asia/Karachi", current_subjects: ["Perfusion"], preferred_time_blocks: ["Evening"], language_preference: ["English"], study_style: "Accountability", available_hours_per_day: 3, status: "active", visibility: "students_only", allow_requests: true, email: "PRIVATE-LMS-OWNER@example.com", whatsapp: "+111111111", telegram_username: "private_owner" },
      "profile-2": { id: "profile-2", user_id: "lms-2", exam_type: "USMLE Step 1", timezone: "Asia/Karachi", current_subjects: ["Perfusion"], preferred_time_blocks: ["Evening"], language_preference: ["English"], study_style: "Accountability", available_hours_per_day: 3, status: "active", visibility: "students_only", allow_requests: true, email: "PRIVATE-LMS-CANDIDATE@example.com", whatsapp: "+222222222", telegram_username: "private_candidate" },
    },
  };
  const liveSentinel = JSON.stringify(liveDb, null, 2);
  const crmSentinel = JSON.stringify({ sentinel: "crm-untouched-v214", ai_training_documents: [], ai_training_items: [] }, null, 2);
  const aylaDb = {
    schema_version: 8,
    qbank_state_version: 0,
    aylaUsers: {
      "user-1": { id: "user-1", email: "progress@example.com", name: "Progress Doctor", role: "student", status: "active", studentId: "student-1", activeExamTrackId: "usmle_step_1", authVersion: 1, ...passwordRecord(password, "1234567890abcdef1234567890abcdef"), createdAt: at(today), updatedAt: at(today) },
      "user-2": { id: "user-2", email: "candidate@example.com", name: "Candidate Doctor", role: "student", status: "active", studentId: "student-2", activeExamTrackId: "usmle_step_1", authVersion: 1, ...passwordRecord(password, "abcdef1234567890abcdef1234567890"), createdAt: at(today), updatedAt: at(today) },
    },
    aylaStudents: {
      "student-1": { id: "student-1", ayla_user_id: "user-1", user_id: "user-1", lms_user_id: "lms-1", name: "Progress Doctor", examTrackId: "usmle_step_1", exam: "USMLE Step 1", targetDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), dailyHours: 3, weakAreas: ["Cardiovascular"], studyPartnerOptIn: true, timezone: "Asia/Karachi", createdAt: at(today), updatedAt: at(today) },
      "student-2": { id: "student-2", ayla_user_id: "user-2", user_id: "user-2", lms_user_id: "lms-2", name: "Candidate Doctor", examTrackId: "usmle_step_1", exam: "USMLE Step 1", targetDate: new Date(Date.now() + 35 * 86400000).toISOString().slice(0, 10), dailyHours: 3, weakAreas: ["Perfusion"], studyPartnerOptIn: true, createdAt: at(today), updatedAt: at(today) },
    },
    aylaPlans: { full: { id: "full", name: "Full Test Access", status: "active", is_active: true, is_full_access: true, exam_tracks: ["usmle_step_1"] } },
    aylaEnrollments: {
      "ayla-enroll-1": { id: "ayla-enroll-1", user_id: "user-1", student_id: "student-1", plan_id: "full", exam_track_id: "usmle_step_1", status: "active", access_granted: true, access_expires_at: future },
      "ayla-enroll-2": { id: "ayla-enroll-2", user_id: "user-2", student_id: "student-2", plan_id: "full", exam_track_id: "usmle_step_1", status: "active", access_granted: true, access_expires_at: future },
    },
    aylaResourceAssignments: {
      "assignment-1": { id: "assignment-1", studentId: "student-1", category: "reading", status: "completed", system: "Cardiovascular", topic: "Perfusion", scheduledDate: today, completedAt: at(today), updatedAt: at(today) },
      "assignment-2": { id: "assignment-2", studentId: "student-2", category: "reading", status: "completed", system: "Cardiovascular", topic: "Perfusion", scheduledDate: today, completedAt: at(today), updatedAt: at(today) },
    },
    aylaQuestionAttempts: {
      "attempt-1": { id: "attempt-1", studentId: "student-1", resourceId: "question-1", serverVerified: true, outcome: "incorrect", system: "Cardiovascular", topic: "Perfusion", correctAnswer: "PRIVATE-CORRECT-ANSWER", createdAt: at(today) },
      "attempt-2": { id: "attempt-2", studentId: "student-1", resourceId: "question-2", serverVerified: true, outcome: "incorrect", system: "Renal", topic: "Perfusion", correctAnswerIndex: 2, createdAt: at(today) },
      "attempt-fake": { id: "attempt-fake", studentId: "student-1", serverVerified: false, outcome: "incorrect", system: "Neurology", topic: "CLIENT-FABRICATED-WEAKNESS", createdAt: at(today) },
    },
    aylaFlashcardReviews: {
      "review-1": { id: "review-1", studentId: "student-1", resourceId: "card-1", serverVerified: true, rating: "hard", system: "Respiratory", topic: "Perfusion", nextReviewDate: today, createdAt: at(today) },
    },
    aylaQbankSessions: {
      "session-1": { id: "session-1", userId: "user-1", studentId: "student-1", examTrack: "usmle-step-1", mode: "test", status: "in_progress", questions: [{ ref: "qref-1", contentQuestionId: "question-marked" }], answers: {}, marks: { "qref-1": true }, createdAt: at(today), updatedAt: at(today) },
    },
    aylaQbankBookmarks: {
      "bookmark-1": { id: "bookmark-1", userId: "user-1", studentId: "student-1", examTrack: "usmle-step-1", contentQuestionId: "question-bookmarked", questionRef: "qref-2", createdAt: at(today), updatedAt: at(today) },
    },
    aylaRevisionQueue: {
      "revision-tutor": { id: "revision-tutor", studentId: "student-1", sourceType: "tutor_scheduled", sourceId: "tutor-perfusion", system: "Cardiovascular", topic: "Perfusion", reasons: ["tutor_scheduled"], dueDate: today, status: "due", createdAt: at(today), updatedAt: at(today) },
    },
    aylaCommunityProfiles: {
      "community-1": { id: "community-1", userId: "user-1", studentId: "student-1", username: "progress_doctor", displayName: "Progress Doctor" },
      "community-2": { id: "community-2", userId: "user-2", studentId: "student-2", username: "candidate_doctor", displayName: "Candidate Doctor" },
    },
  };
  await fs.writeFile(livePath, liveSentinel);
  await fs.writeFile(crmPath, crmSentinel);
  await fs.writeFile(aylaPath, JSON.stringify(aylaDb));

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
    env: {
      ...process.env,
      PORT: String(port), DATA_DIR: dataDir,
      AYLA_AUTH_JWT_SECRET: "v214-ayla-secret", AUTH_JWT_SECRET: "v214-lms-secret", AYLA_ADMIN_TOKEN: "v214-admin",
      NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false", ZOOM_RECORDING_RECOVERY_ENABLED: "false", NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED: "false",
      DATABASE_URL: "", OPENAI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    await waitForHealth(baseUrl, child, output);
    const login = await api(baseUrl, "/api/ayla/auth/login", { method: "POST", body: { email: "progress@example.com", password } });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    const token = login.payload.token;

    const progress = await api(baseUrl, `/api/ayla/students/student-1/progress?date=${today}`, { token });
    assert.equal(progress.response.status, 200, JSON.stringify(progress.payload));
    assert.equal(progress.payload.build, "aylamed-safe-shared-student-profile-v219");
    assert.equal(progress.payload.progress.lms.linked, true);
    assert.deepEqual(progress.payload.progress.lms.courses.map((row) => row.course_id), ["course-step1"]);
    assert.equal(progress.payload.progress.streaks.aylamed.study_streak, 1);
    assert.ok(progress.payload.progress.streaks.federated.study_streak >= 3, JSON.stringify(progress.payload.progress.streaks));
    assert.equal(progress.payload.progress.streaks.lms_bonus_points_unchanged, true);
    assert.equal(progress.payload.progress.weakAreas.sharedUnderlyingTopics[0].topic, "Perfusion");
    assert.ok(progress.payload.progress.weakAreas.sharedUnderlyingTopics[0].sources.includes("lms:course-step1"));
    const origins = new Set(progress.payload.progress.revision.items.flatMap((row) => row.origins));
    for (const source of ["marked_question", "bookmark", "verified_mistake", "difficult_card", "verified_weak_topic", "tutor_scheduled"]) assert.equal(origins.has(source), true, `${source}: ${JSON.stringify([...origins])}`);
    assert.doesNotMatch(JSON.stringify(progress.payload), /PRIVATE-|CLIENT-FABRICATED-WEAKNESS|correctAnswer|whatsapp|telegram/i);

    const revision = await api(baseUrl, `/api/ayla/students/student-1/revision?date=${today}`, { token });
    assert.equal(revision.response.status, 200, JSON.stringify(revision.payload));
    assert.equal(revision.payload.revision.answer_keys_included, false);
    assert.equal(revision.payload.privacy.correct_answers_server_only, true);

    const leaderboard = await api(baseUrl, "/api/ayla/community/leaderboard?studentId=student-1&period=weekly", { token });
    assert.equal(leaderboard.response.status, 200, JSON.stringify(leaderboard.payload));
    assert.equal(leaderboard.payload.cross_product_points_combined, false);
    assert.equal(leaderboard.payload.lms_leaderboard_unchanged, true);
    assert.deepEqual(leaderboard.payload.lanes.lms.map((row) => row.course_id), ["course-step1"]);
    assert.doesNotMatch(JSON.stringify(leaderboard.payload), /SHOULD-NOT-CROSS-EXAM/);

    const matches = await api(baseUrl, "/api/ayla/study-partners/matches?studentId=student-1", { token });
    assert.equal(matches.response.status, 200, JSON.stringify(matches.payload));
    assert.equal(matches.payload.matches[0].studentId, "student-2");
    assert.equal(matches.payload.matches[0].preferenceSource, "aylamed_plus_lms_read_only");
    assert.equal(matches.payload.matches[0].lmsContactsExposed, false);
    assert.ok(matches.payload.matches[0].compatibilityScore > 0);
    assert.doesNotMatch(JSON.stringify(matches.payload), /PRIVATE-|222222222|private_candidate|email|whatsapp|telegram/i);

    const requestBody = { studentId: "student-1", targetStudentId: "student-2" };
    const concurrent = await Promise.all([
      api(baseUrl, "/api/ayla/study-partners/requests", { method: "POST", token, body: requestBody }),
      api(baseUrl, "/api/ayla/study-partners/requests", { method: "POST", token, body: requestBody }),
    ]);
    assert.deepEqual(concurrent.map((row) => row.response.status).sort(), [200, 201]);
    assert.equal(concurrent[0].payload.request.id, concurrent[1].payload.request.id);
    assert.deepEqual(concurrent.map((row) => row.payload.duplicate).sort(), [false, true]);
    const requestId = concurrent[0].payload.request.id;

    const cancelled = await api(baseUrl, `/api/ayla/study-partners/requests/${requestId}`, { method: "PATCH", token, body: { studentId: "student-1", action: "cancel" } });
    assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.payload));
    assert.equal(cancelled.payload.request.status, "cancelled");
    const replay = await api(baseUrl, `/api/ayla/study-partners/requests/${requestId}`, { method: "PATCH", token, body: { studentId: "student-1", action: "cancel" } });
    assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
    assert.equal(replay.payload.idempotent, true);

    const reportBody = { studentId: "student-1", reason: "Safety concern", details: "Please review", idempotencyKey: "report-once" };
    const report = await api(baseUrl, `/api/ayla/study-partners/requests/${requestId}/report`, { method: "POST", token, body: reportBody });
    const reportReplay = await api(baseUrl, `/api/ayla/study-partners/requests/${requestId}/report`, { method: "POST", token, body: reportBody });
    assert.equal(report.response.status, 201, JSON.stringify(report.payload));
    assert.equal(reportReplay.response.status, 200, JSON.stringify(reportReplay.payload));
    assert.equal(reportReplay.payload.duplicate, true);
    assert.equal(report.payload.report.id, reportReplay.payload.report.id);

    const stored = JSON.parse(await fs.readFile(aylaPath, "utf8"));
    assert.equal(Object.keys(stored.aylaStudyPartnerRequests || {}).length, 1);
    assert.equal(Object.keys(stored.aylaCommunityReports || {}).length, 1);
    assert.equal(await fs.readFile(livePath, "utf8"), liveSentinel);
    assert.equal(await fs.readFile(crmPath, "utf8"), crmSentinel);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
