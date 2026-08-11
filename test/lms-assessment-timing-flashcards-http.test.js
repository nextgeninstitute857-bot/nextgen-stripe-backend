import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function passwordRecord(password, salt = "assessmentflashcardaudit123456") {
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
    if (child.exitCode !== null) throw new Error(`Server exited (${child.exitCode})\n${output.join("")}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Health timeout\n${output.join("")}`);
}

async function api(baseUrl, route, { method = "GET", token = "", body = null } = {}) {
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
}

test("assessment timing is server-owned and flashcard reads are immediate and schedule-aware", { timeout: 70_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "assessment-flashcard-audit-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const crmPath = path.join(dataDir, "crm-db.json");
  const aylaPath = path.join(dataDir, "aylamed-db.json");
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const courseId = "course-assessment-flashcard-audit";
  const studentId = "student-assessment-flashcard-audit";
  const assessmentId = "assessment-timer-audit";
  const password = "AssessmentAudit10!";
  const roadmapDayId = "roadmap-msk-today";

  const liveDb = {
    users: {
      [studentId]: {
        id: studentId,
        email: "assessment-flashcard-audit@example.com",
        name: "Assessment Flashcard Audit Student",
        role: "student",
        status: "active",
        verified: true,
        ...passwordRecord(password),
      },
    },
    courses: {
      [courseId]: { id: courseId, name: "Internal Training Course", status: "active", is_active: true },
    },
    enrollments: {
      enrolled: {
        id: "enrolled",
        user_id: studentId,
        course_id: courseId,
        status: "paid",
        access_granted: true,
        access_expires_at: "2030-01-01T00:00:00.000Z",
      },
    },
    roadmaps: {
      [courseId]: {
        id: courseId,
        course_id: courseId,
        days: [{
          id: roadmapDayId,
          course_id: courseId,
          date: today,
          scheduled_date: today,
          day_number: 10,
          system_day: 10,
          system: "MSK",
          title: "MSK Day 10",
          is_published: true,
        }],
      },
    },
    assessments: {
      [assessmentId]: {
        id: assessmentId,
        course_id: courseId,
        title: "Timed Assessment",
        is_published: true,
        duration_minutes: 0.001,
        total_duration_minutes: 0.001,
        questions: [
          { id: "q1", stem: "Question 1", options: ["A", "B"], correct_index: 0, topic: "MSK", system: "MSK" },
          { id: "q2", stem: "Question 2", options: ["A", "B"], correct_index: 1, topic: "MSK", system: "MSK" },
        ],
      },
    },
    assessmentAttempts: {},
    assessmentRuns: {},
    flashcards: {
      "msk-due": { id: "msk-due", course_id: courseId, roadmap_day_id: roadmapDayId, system: "MSK", front: "MSK due", back: "Answer", scope: "official_daily", due_date: today, is_published: true, status: "published" },
      "cns-due": { id: "cns-due", course_id: courseId, system: "Central Nervous System", front: "CNS due", back: "Answer", scope: "official_daily", due_date: today, is_published: true, status: "published" },
      "future-card": { id: "future-card", course_id: courseId, system: "MSK", front: "Future", back: "Answer", scope: "official_daily", due_date: tomorrow, is_published: true, status: "published" },
      "future-progress": { id: "future-progress", course_id: courseId, system: "MSK", front: "Not due again", back: "Answer", scope: "official_daily", due_date: today, is_published: true, status: "published" },
      "not-due-again": { id: "not-due-again", course_id: courseId, system: "MSK", front: "Scheduled for tomorrow", back: "Answer", scope: "official_daily", due_date: today, is_published: true, status: "published" },
      "reviewed-today": { id: "reviewed-today", course_id: courseId, system: "MSK", front: "Reviewed today", back: "Answer", scope: "official_daily", due_date: today, is_published: true, status: "published" },
    },
    flashcardProgress: {
      [`${courseId}:${studentId}:future-progress`]: {
        id: `${courseId}:${studentId}:future-progress`, course_id: courseId, user_id: studentId,
        flashcard_id: "future-progress", reviewed: true, reviewed_at: `${today}T01:00:00.000Z`, next_review_date: tomorrow,
      },
      [`${courseId}:${studentId}:reviewed-today`]: {
        id: `${courseId}:${studentId}:reviewed-today`, course_id: courseId, user_id: studentId,
        flashcard_id: "reviewed-today", reviewed: true, reviewed_at: `${today}T02:00:00.000Z`, next_review_date: tomorrow,
      },
      [`${courseId}:${studentId}:not-due-again`]: {
        id: `${courseId}:${studentId}:not-due-again`, course_id: courseId, user_id: studentId,
        flashcard_id: "not-due-again", reviewed: true, reviewed_at: `${yesterday}T02:00:00.000Z`, next_review_date: tomorrow,
      },
    },
    flashcardReviewEvents: {},
    adaptiveFlashcardQueues: {
      [`${courseId}:${studentId}:${today}`]: {
        id: `${courseId}:${studentId}:${today}`, course_id: courseId, user_id: studentId,
        queue_date: today, current_system: "Central Nervous System", card_ids: ["cns-due"], limit: 27,
      },
    },
    notes: {}, recordings: {}, attendance: {}, dailyTaskProgress: {}, roadmapProgress: {}, pointEvents: {}, leaderboard: {},
  };

  const crmOriginal = JSON.stringify({ sentinel: "crm-must-not-be-read-or-written-by-flashcard-get" });
  await fs.writeFile(livePath, JSON.stringify(liveDb, null, 2));
  await fs.writeFile(crmPath, crmOriginal);
  await fs.writeFile(aylaPath, JSON.stringify({ sentinel: "ayla-untouched" }));

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
      AUTH_JWT_SECRET: "assessment-flashcard-audit-secret",
      AYLA_AUTH_JWT_SECRET: "assessment-flashcard-audit-ayla-secret",
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
      body: { email: "assessment-flashcard-audit@example.com", password },
    });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    const token = login.payload.token;

    const take = await api(baseUrl, `/student/assessments/${assessmentId}/take`, { token });
    assert.equal(take.response.status, 200, JSON.stringify(take.payload));
    assert.ok(take.payload.timing.remaining_seconds >= 0);
    assert.equal(take.payload.timing.status, "in_progress");
    assert.ok(take.payload.timing.started_at);
    assert.ok(take.payload.timing.expires_at);

    await new Promise((resolve) => setTimeout(resolve, 150));
    const submit = await api(baseUrl, `/student/assessments/${assessmentId}/submit`, {
      method: "POST",
      token,
      body: { answers: { q1: 0, q2: 1 }, auto_submitted: false },
    });
    assert.equal(submit.response.status, 200, JSON.stringify(submit.payload));
    assert.equal(submit.payload.attempt.auto_submitted, true);
    assert.equal(submit.payload.attempt.submission_reason, "time_expired");
    assert.match(submit.payload.message, /Time is up/i);

    const flashcardStarted = Date.now();
    const review = await api(baseUrl, `/student/flashcards/review?course_id=${courseId}&limit=27`, { token });
    const flashcardElapsed = Date.now() - flashcardStarted;
    assert.equal(review.response.status, 200, JSON.stringify(review.payload));
    assert.ok(flashcardElapsed < 2_000, `flashcard read took ${flashcardElapsed}ms`);
    assert.equal(review.payload.note_sync.deferred, true);
    assert.equal(review.payload.weak_area_sync.deferred, true);
    assert.equal(review.payload.flashcards[0].id, "msk-due", "current-system cards should replace a stale queue first");
    assert.equal(review.payload.flashcards.some((card) => card.id === "future-card"), false);
    assert.equal(review.payload.flashcards.some((card) => card.id === "not-due-again"), false, "older students should not receive a card before its next-review date");
    assert.equal(review.payload.flashcards.some((card) => card.id === "future-progress"), true, "cards reviewed today remain visible in today's stable queue");
    assert.equal(review.payload.flashcards.find((card) => card.id === "future-progress")?.reviewed, true);
    const savedCrm = JSON.parse(await fs.readFile(crmPath, "utf8"));
    assert.equal(savedCrm.sentinel, "crm-must-not-be-read-or-written-by-flashcard-get");

    const saved = JSON.parse(await fs.readFile(livePath, "utf8"));
    assert.equal(saved.assessmentRuns[`${assessmentId}:${studentId}`].status, "submitted");
    assert.equal(saved.adaptiveFlashcardQueues[`${courseId}:${studentId}:${today}`].current_system, "MSK");
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
