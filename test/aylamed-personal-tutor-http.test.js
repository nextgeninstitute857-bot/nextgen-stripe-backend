import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function passwordRecord(password, salt = "fedcba9876543210fedcba9876543210") {
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

async function waitForHealth(baseUrl, child, output, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Smoke server exited early (${child.exitCode})\n${output.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
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
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${route} returned ${response.status} non-JSON: ${text.slice(0, 500)}`);
  }
  return { response, payload };
}

test("authenticated Personal Tutor rebalances only the versioned adaptive roadmap and preserves isolation", { timeout: 40000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aylamed-v213-http-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const crmPath = path.join(dataDir, "crm-db.json");
  const aylaPath = path.join(dataDir, "aylamed-db.json");
  const password = "TutorSmoke9!";
  const date = new Date().toISOString().slice(0, 10);
  const previous = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 365 * 86400000).toISOString();
  const liveSentinel = JSON.stringify({ sentinel: "lms-untouched-v213", students: [{ id: "lms-student" }] });
  const crmSentinel = JSON.stringify({ sentinel: "crm-untouched-v213", ai_training_documents: [], ai_training_items: [] });
  const resources = {};
  for (let index = 1; index <= 24; index += 1) {
    resources[`question-${index}`] = {
      id: `question-${index}`,
      type: "internal_mcq",
      title: `Verified shock question ${index}`,
      resourceNumber: `NGQ-${String(index).padStart(8, "0")}`,
      questionNumber: `NGQ-${String(index).padStart(8, "0")}`,
      examTrackId: "usmle_step_1",
      examTrack: "USMLE Step 1",
      system: index % 2 ? "Cardiology" : "Renal",
      topic: "Perfusion",
      stem: `Original verified stem ${index}`,
      options: ["A", "B", "C", "D"],
      correctAnswer: "PRIVATE-CORRECT-ANSWER",
      correctAnswerIndex: 2,
      explanation: "PRIVATE-SERVER-EXPLANATION",
      estimatedMinutes: 2,
      approved: true,
      status: "active",
      verificationStatus: "approved_ai_training_center",
    };
  }
  resources["verified-card"] = {
    id: "verified-card",
    type: "flashcard",
    ownerStudentId: "student-1",
    examTrackId: "usmle_step_1",
    examTrack: "USMLE Step 1",
    system: "Cardiology",
    topic: "Perfusion",
    front: "What controls perfusion?",
    back: "Verified recall answer",
    approved: true,
    status: "active",
    authorizationStatus: "owned",
    verificationStatus: "server_verified_mistake",
  };
  const currentItems = Object.values(resources).slice(0, 20).map((row) => ({
    resourceId: row.id,
    resourceNumber: row.resourceNumber,
    questionNumber: row.questionNumber,
    title: row.title,
    system: row.system,
    topic: row.topic,
    correctAnswer: row.correctAnswer,
    correctAnswerIndex: row.correctAnswerIndex,
    explanation: row.explanation,
  }));
  const aylaDb = {
    schema_version: 7,
    qbank_state_version: 0,
    aylaUsers: {
      "user-1": {
        id: "user-1",
        email: "tutor-smoke@example.com",
        name: "Tutor Smoke",
        role: "student",
        status: "active",
        studentId: "student-1",
        activeExamTrackId: "usmle_step_1",
        authVersion: 1,
        ...passwordRecord(password),
        createdAt: now,
        updatedAt: now,
      },
    },
    aylaStudents: {
      "student-1": {
        id: "student-1",
        ayla_user_id: "user-1",
        user_id: "user-1",
        name: "Tutor Smoke",
        examTrackId: "usmle_step_1",
        exam: "USMLE Step 1",
        targetDate: new Date(Date.now() + 25 * 86400000).toISOString().slice(0, 10),
        dailyHours: 3,
        weeklyStudyDays: 6,
        weakAreas: ["Cardiology", "Renal"],
        questionSourcePreference: "internal",
        createdAt: now,
        updatedAt: now,
      },
    },
    aylaPlans: {
      "access-plan": {
        id: "access-plan",
        name: "Tutor Test Access",
        status: "active",
        is_active: true,
        is_full_access: true,
        exam_tracks: ["usmle_step_1"],
        included_features: ["personal_tutor", "roadmap", "dynamic_notebook", "assessments", "revision"],
      },
    },
    aylaEnrollments: {
      "enrollment-1": {
        id: "enrollment-1",
        user_id: "user-1",
        ayla_user_id: "user-1",
        student_id: "student-1",
        plan_id: "access-plan",
        exam_track_id: "usmle_step_1",
        exam_track: "usmle-step-1",
        type: "paid",
        status: "active",
        access_granted: true,
        access_starts_at: now,
        access_expires_at: future,
        createdAt: now,
        updatedAt: now,
      },
    },
    aylaResources: resources,
    aylaDailyPlans: {
      "plan-current": {
        id: "plan-current",
        studentId: "student-1",
        userId: "user-1",
        date,
        version: 4,
        status: "active",
        questionSourceMode: "internal",
        capacityMinutes: 180,
        plannedMinutes: 220,
        completionPercent: 0,
        assignmentIds: ["assignment-current", "assignment-completed"],
        focusSystem: "Cardiology",
        focusTopic: "Perfusion",
        tutorBrain: { selectedFocus: { id: "focus-1", system: "Cardiology", topic: "Perfusion" } },
        assessmentTutor: { status: "monitoring", type: "not_due", label: "Monitoring", reason: "No assessment due", questionCount: 0 },
        createdAt: now,
        updatedAt: now,
      },
      "plan-old-1": { id: "plan-old-1", studentId: "student-1", date: previous(1), version: 1, status: "active", completionPercent: 30, capacityMinutes: 180, plannedMinutes: 180 },
      "plan-old-2": { id: "plan-old-2", studentId: "student-1", date: previous(2), version: 1, status: "active", completionPercent: 35, capacityMinutes: 180, plannedMinutes: 180 },
      "plan-old-3": { id: "plan-old-3", studentId: "student-1", date: previous(3), version: 1, status: "active", completionPercent: 40, capacityMinutes: 180, plannedMinutes: 180 },
    },
    aylaResourceAssignments: {
      "assignment-current": {
        id: "assignment-current",
        studentId: "student-1",
        userId: "user-1",
        dailyPlanId: "plan-current",
        scheduledDate: date,
        category: "internal_mcqs",
        type: "internal_mcqs",
        title: "20 verified perfusion questions",
        system: "Cardiology",
        topic: "Perfusion",
        resourceIds: currentItems.map((row) => row.resourceId),
        items: currentItems,
        estimatedMinutes: 220,
        status: "pending",
        priority: "High",
        createdAt: now,
        updatedAt: now,
      },
      "assignment-completed": {
        id: "assignment-completed",
        studentId: "student-1",
        userId: "user-1",
        dailyPlanId: "plan-current",
        scheduledDate: date,
        category: "flashcards",
        title: "Completed recall",
        system: "Cardiology",
        topic: "Perfusion",
        resourceIds: ["already-completed-resource"],
        items: [{ resourceId: "already-completed-resource" }],
        estimatedMinutes: 5,
        status: "completed",
        priority: "Critical",
        completedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    },
    aylaQuestionAttempts: {
      "attempt-1": { id: "attempt-1", studentId: "student-1", serverVerified: true, outcome: "incorrect", system: "Cardiology", topic: "Perfusion", createdAt: now, correctAnswer: "PRIVATE-ATTEMPT-ANSWER" },
      "attempt-2": { id: "attempt-2", studentId: "student-1", serverVerified: true, outcome: "incorrect", system: "Renal", topic: "Perfusion", createdAt: now, correctAnswer: "PRIVATE-ATTEMPT-ANSWER" },
      "foreign-attempt": { id: "foreign-attempt", studentId: "student-other", serverVerified: true, outcome: "incorrect", system: "Neurology", topic: "FOREIGN-EXAM-TOPIC", createdAt: now },
    },
    aylaFlashcardReviews: {
      "review-1": { id: "review-1", studentId: "student-1", serverVerified: true, rating: "hard", system: "Respiratory", topic: "Perfusion", createdAt: now },
    },
    aylaNotebooks: {
      "notebook-1": {
        id: "notebook-1",
        studentId: "student-1",
        userId: "user-1",
        examTrackId: "usmle_step_1",
        title: "Perfusion notebook",
        system: "Cardiology",
        topic: "Perfusion",
        blocks: [{ id: "student-note", type: "text", text: "My own perfusion mnemonic", contentOrigin: "student_authored", visualStyle: "handwriting", createdAt: now, updatedAt: now }],
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    },
  };
  await fs.writeFile(livePath, liveSentinel);
  await fs.writeFile(crmPath, crmSentinel);
  await fs.writeFile(aylaPath, JSON.stringify(aylaDb));

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      AYLA_AUTH_JWT_SECRET: "v213-isolated-smoke-secret",
      AUTH_JWT_SECRET: "v213-isolated-lms-secret",
      NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false",
      ZOOM_RECORDING_RECOVERY_ENABLED: "false",
      DATABASE_URL: "",
      OPENAI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    await waitForHealth(baseUrl, child, output);
    const login = await api(baseUrl, "/api/ayla/auth/login", {
      method: "POST",
      body: { email: "tutor-smoke@example.com", password },
    });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    const token = login.payload.token;

    const first = await api(baseUrl, `/api/ayla/students/student-1/personal-tutor?date=${date}`, { token });
    assert.equal(first.response.status, 200, JSON.stringify(first.payload));
    assert.equal(first.payload.decision.engine, "ayla_adaptive_roadmap_v189");
    assert.equal(first.payload.decision.authority.oneStoredRoadmap, true);
    assert.equal(first.payload.decision.authority.tutorCreatesSecondPlan, false);
    assert.equal(first.payload.plan.id, "plan-current");
    assert.equal(first.payload.plan.version, 4);
    assert.equal(first.payload.decision.workload.state, "overloaded");
    assert.equal(first.payload.decision.workload.questionVolumeAdjustment, "reduce");
    assert.equal(first.payload.decision.crossSystemWeakTopic.topic, "Perfusion");
    assert.deepEqual(first.payload.decision.crossSystemWeakTopic.systems, ["Cardiology", "Renal", "Respiratory"]);
    assert.equal(first.payload.decision.notebook.studentNotePreview, "My own perfusion mnemonic");
    assert.doesNotMatch(JSON.stringify(first.payload), /PRIVATE-CORRECT-ANSWER|PRIVATE-SERVER-EXPLANATION|PRIVATE-ATTEMPT-ANSWER|FOREIGN-EXAM-TOPIC|correctAnswerIndex/);
    const reduction = first.payload.decision.recommendations.find((row) => row.kind === "reduce_workload");
    assert.ok(reduction?.id, JSON.stringify(first.payload.decision.recommendations));

    const applyBody = {
      date,
      expectedPlanId: first.payload.plan.id,
      expectedPlanVersion: first.payload.plan.version,
      recommendationId: reduction.id,
      directive: { workloadAdjustment: "intensive", questionVolumeAdjustment: "intensive", includeAssessment: true },
    };
    const applied = await api(baseUrl, "/api/ayla/students/student-1/personal-tutor/apply", { method: "POST", token, body: applyBody });
    assert.equal(applied.response.status, 200, JSON.stringify(applied.payload));
    assert.equal(applied.payload.applied, true);
    assert.equal(applied.payload.idempotentReplay, false);
    assert.notEqual(applied.payload.plan.id, "plan-current");
    assert.equal(applied.payload.plan.version, 5);
    assert.equal(applied.payload.plan.tutorBrain.mode, "personal_tutor_applied_single_roadmap");
    assert.equal(applied.payload.plan.tutorBrain.workloadAdjustment, "reduce");
    assert.equal(applied.payload.plan.tutorBrain.questionVolumeAdjustment, "reduce");
    assert.equal(applied.payload.plan.tutorBrain.createsSecondPlan, false);
    assert.doesNotMatch(JSON.stringify(applied.payload), /PRIVATE-CORRECT-ANSWER|PRIVATE-SERVER-EXPLANATION|PRIVATE-ATTEMPT-ANSWER|correctAnswerIndex/);

    const replay = await api(baseUrl, "/api/ayla/students/student-1/personal-tutor/apply", { method: "POST", token, body: applyBody });
    assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
    assert.equal(replay.payload.idempotentReplay, true);
    assert.equal(replay.payload.plan.id, applied.payload.plan.id);

    const newChange = applied.payload.decision.recommendations.find((row) => row.planChange);
    const stale = await api(baseUrl, "/api/ayla/students/student-1/personal-tutor/apply", {
      method: "POST",
      token,
      body: {
        date,
        expectedPlanId: applied.payload.plan.id,
        expectedPlanVersion: 4,
        recommendationId: newChange.id,
      },
    });
    assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));
    assert.equal(stale.payload.details.code, "STALE_TUTOR_RECOMMENDATION");

    const chat = await api(baseUrl, "/api/ayla/ai/coach", {
      method: "POST",
      token,
      body: { studentId: "student-1", date, question: "What should I study next and am I overloaded?" },
    });
    assert.equal(chat.response.status, 200, JSON.stringify(chat.payload));
    assert.equal(chat.payload.deterministic, true);
    assert.equal(chat.payload.personal_tutor.engine, "ayla_adaptive_roadmap_v189");
    assert.equal(chat.payload.usage, null);
    assert.equal(chat.payload.roadmap.plan.id, applied.payload.plan.id);

    const fabricatedCard = await api(baseUrl, "/api/ayla/students/student-1/flashcard-reviews", {
      method: "POST",
      token,
      body: { resourceId: "client-invented-card", system: "Neurology", topic: "CLIENT-FABRICATED-WEAKNESS", rating: "hard" },
    });
    assert.equal(fabricatedCard.response.status, 404, JSON.stringify(fabricatedCard.payload));

    const verifiedCard = await api(baseUrl, "/api/ayla/students/student-1/flashcard-reviews", {
      method: "POST",
      token,
      body: {
        resourceId: "verified-card",
        system: "Neurology",
        topic: "CLIENT-FABRICATED-WEAKNESS",
        rating: "good",
      },
    });
    assert.equal(verifiedCard.response.status, 201, JSON.stringify(verifiedCard.payload));
    assert.equal(verifiedCard.payload.review.serverVerified, true);
    assert.equal(verifiedCard.payload.review.system, "Cardiology");
    assert.equal(verifiedCard.payload.review.topic, "Perfusion");
    assert.doesNotMatch(JSON.stringify(verifiedCard.payload), /CLIENT-FABRICATED-WEAKNESS/);

    const stored = JSON.parse(await fs.readFile(aylaPath, "utf8"));
    assert.equal(stored.aylaDailyPlans["plan-current"].status, "superseded");
    assert.equal(stored.aylaResourceAssignments["assignment-completed"].status, "completed");
    assert.equal(Object.values(stored.aylaActivityHistory || {}).filter((row) => row.type === "personal_tutor_recommendation_applied").length, 1);
    assert.equal(await fs.readFile(livePath, "utf8"), liveSentinel);
    assert.equal(await fs.readFile(crmPath, "utf8"), crmSentinel);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
