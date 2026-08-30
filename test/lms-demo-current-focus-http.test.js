import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function passwordRecord(password, salt = "democurrentfocustestsalt") {
  return {
    salt,
    password_hash: crypto.pbkdf2Sync(password, salt, 120000, 64, "sha512").toString("hex"),
  };
}

function easternDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function plusDays(dateKey, amount) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child, output, timeoutMs = 70_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Server exited (${child.exitCode})\n${output.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Health timeout\n${output.join("")}`);
}

async function requestJson(baseUrl, route, { method = "GET", token = "", body = null } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, payload: await response.json() };
}

test("a newly activated demo dashboard uses the next CNS class instead of historical Cardiology Day 1", { timeout: 100_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-demo-current-focus-"));
  const courseId = "demo-focus-course";
  const userId = "demo-focus-student";
  const email = "demo-focus@example.com";
  const password = "DemoFocus9!";
  const today = easternDateKey();
  const nextTeachingDate = plusDays(today, 1);
  const demoExpiry = plusDays(today, 7);
  const nowIso = new Date().toISOString();
  const priorCnsDays = Array.from({ length: 6 }, (_, index) => ({
    id: `cns-day-${index + 1}`,
    course_id: courseId,
    date: plusDays(today, index - 7),
    day_number: 29 + index,
    system: "Central Nervous System",
    system_day: index + 1,
    title: `Central Nervous System — Day ${index + 1} — Neurology / CNS`,
    status: "completed",
    is_published: true,
  }));

  await fs.writeFile(path.join(dataDir, "live-session-db.json"), JSON.stringify({
    users: {
      [userId]: {
        id: userId,
        email,
        name: "Demo Student",
        role: "student",
        verified: true,
        ...passwordRecord(password),
        created_at: nowIso,
        updated_at: nowIso,
      },
    },
    courses: {
      [courseId]: {
        id: courseId,
        name: "120-Day USMLE Step 1 Marathon",
        status: "active",
        is_active: true,
        demo_access_enabled: true,
      },
    },
    enrollments: {
      [`${courseId}:${userId}:demo`]: {
        id: `${courseId}:${userId}:demo`,
        user_id: userId,
        user_name: "Demo Student",
        course_id: courseId,
        access_granted: true,
        is_demo: true,
        demo_expiry: demoExpiry,
        expires_at: demoExpiry,
        created_at: nowIso,
        updated_at: nowIso,
      },
    },
    demoSettings: { enabled: true, duration_days: 7 },
    roadmaps: {
      [courseId]: {
        id: `roadmap:${courseId}`,
        course_id: courseId,
        settings: { timezone: "America/New_York", skip_sundays: true },
        days: [
          {
            id: "cardiology-day-1",
            course_id: courseId,
            date: "2026-07-02",
            day_number: 1,
            system: "Cardiology",
            system_day: 1,
            title: "Cardiology — Day 1",
            status: "scheduled",
            is_published: true,
          },
          ...priorCnsDays,
          {
            id: "cns-day-7",
            course_id: courseId,
            date: nextTeachingDate,
            day_number: 36,
            system: "Central Nervous System",
            system_day: 7,
            title: "Central Nervous System — Day 7 — Neurology / CNS",
            status: "scheduled",
            is_published: true,
            live_session_id: "cns-day-7-session",
          },
        ],
      },
    },
    liveSessions: {
      "cns-day-7-session": {
        id: "cns-day-7-session",
        course_id: courseId,
        roadmap_day_id: "cns-day-7",
        scheduled_date: nextTeachingDate,
        scheduled_time: "12:00",
        scheduled_timezone: "America/New_York",
        title: "Central Nervous System — Day 7 — Neurology / CNS",
        topic: "Central Nervous System — Day 7 — Neurology / CNS",
        system: "Central Nervous System",
        system_day: 7,
        status: "scheduled",
      },
    },
    plans: {}, payments: {}, notes: {}, recordings: {}, assessments: {}, assessmentAttempts: {},
    flashcards: {}, flashcardProgress: {}, roadmapProgress: {}, dailyTaskProgress: {}, pointEvents: {},
    weakConceptLogs: {}, adaptiveAssignments: {}, adaptiveFlashcardQueues: {}, attendance: {},
    leaderboard: {}, announcements: {},
  }));
  await fs.writeFile(path.join(dataDir, "crm-db.json"), JSON.stringify({}));
  await fs.writeFile(path.join(dataDir, "aylamed-db.json"), JSON.stringify({}));

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      AUTH_JWT_SECRET: "demo-current-focus-secret",
      AYLA_AUTH_JWT_SECRET: "demo-current-focus-ayla-secret",
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
    await waitForHealth(baseUrl, child, output);
    const login = await requestJson(baseUrl, "/auth/login", {
      method: "POST",
      body: { email, password },
    });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));

    const dashboard = await requestJson(baseUrl, "/student/dashboard/bootstrap", { token: login.payload.token });
    assert.equal(dashboard.response.status, 200, JSON.stringify(dashboard.payload));
    const bundle = dashboard.payload.course_bundles[0];
    assert.equal(bundle.status, "demo_active");
    assert.equal(bundle.dailyTask.packet.id, "cns-day-7");
    assert.equal(bundle.dailyTask.packet.system, "Central Nervous System");
    assert.match(bundle.dailyTask.packet.title, /Central Nervous System.*Day 7/i);

    const fallback = await requestJson(baseUrl, `/student/daily-task?course_id=${courseId}`, { token: login.payload.token });
    assert.equal(fallback.response.status, 200, JSON.stringify(fallback.payload));
    assert.equal(fallback.payload.packet.id, "cns-day-7");

    const saved = JSON.parse(await fs.readFile(path.join(dataDir, "live-session-db.json"), "utf8"));
    const createdProgress = Object.values(saved.dailyTaskProgress || {});
    assert.equal(createdProgress.some((item) => item.roadmap_day_id === "cardiology-day-1"), false);
    assert.equal(createdProgress.some((item) => item.roadmap_day_id === "cns-day-7"), true);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 2_000);
    });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
