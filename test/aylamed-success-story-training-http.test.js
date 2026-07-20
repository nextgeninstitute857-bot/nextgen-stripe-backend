import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  normalizeAylaSuccessStoryDraft,
  reviewAylaSuccessStory,
} from "../lib/aylamed-success-story-training.js";

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
    if (child.exitCode !== null) throw new Error(`Server exited (${child.exitCode})\n${output.join("")}`);
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* starting */ }
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
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`${method} ${route} returned ${response.status}: ${text.slice(0, 500)}`); }
  return { response, payload };
}

function approvedFixture({ id, examTrack, tag, action, now }) {
  const draft = normalizeAylaSuccessStoryDraft({
    title: `${tag} strategy`,
    exam_track_id: examTrack,
    challenge_tags: [tag],
    strategy_tags: ["focused review"],
    strategy_steps: [{ action }],
    applicability_notes: "Use only when it fits the current roadmap assignment.",
    limitations: "Outcomes vary.",
    evidence_basis: "verified_platform_progress",
    outcome_summary: "Verified platform progress improved during the reviewed period.",
    source_reference: `REF_${id.replace(/[^a-z0-9]/gi, "_")}`,
    consent_verified: true,
    anonymized: true,
  }, {}, now);
  draft.id = id;
  return reviewAylaSuccessStory(draft, { action: "approve", reviewer: { id: "fixture-reviewer", email: "fixture-reviewer@example.com" } }, now);
}

test("v216 governs success stories in CRM and feeds only approved outcome-free strategies to Personal Tutor", { timeout: 50000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aylamed-v216-http-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const crmPath = path.join(dataDir, "crm-db.json");
  const aylaPath = path.join(dataDir, "aylamed-db.json");
  const adminPassword = "GovernanceAdmin9!";
  const studentPassword = "GovernanceStudent9!";
  const date = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 365 * 86400000).toISOString();
  const liveDb = {
    sentinel: "lms-identity-only-v216",
    users: {
      "admin-1": { id: "admin-1", email: "governance-admin@example.com", name: "Governance Admin", role: "admin", status: "active", ...passwordRecord(adminPassword, "adminv216adminv216adminv216admin1"), created_at: now, updated_at: now },
    },
  };
  const crossExam = approvedFixture({ id: "cross-exam-story", examTrack: "PLAB", tag: "Perfusion", action: "CROSS-EXAM-STRATEGY-MUST-NOT-APPEAR", now });
  const draftStory = normalizeAylaSuccessStoryDraft({ title: "Unapproved perfusion idea", exam_track_id: "USMLE Step 1", challenge_tags: ["Perfusion"], strategy_steps: ["DRAFT-STRATEGY-MUST-NOT-APPEAR"] }, {}, now);
  draftStory.id = "draft-story";
  const crmDb = {
    sentinel: "crm-governance-v216",
    ai_training_documents: [{ id: "generic-document-sentinel" }],
    ai_training_items: [{ id: "generic-training-sentinel" }],
    ai_success_stories: [crossExam, draftStory],
    ai_success_story_audit_logs: [],
  };
  const aylaDb = {
    schema_version: 10,
    aylaUsers: {
      "user-1": { id: "user-1", email: "story-student@example.com", name: "Story Student", role: "student", status: "active", studentId: "student-1", activeExamTrackId: "usmle_step_1", authVersion: 1, ...passwordRecord(studentPassword, "studentv216studentv216studentv21"), createdAt: now, updatedAt: now },
    },
    aylaStudents: {
      "student-1": { id: "student-1", ayla_user_id: "user-1", user_id: "user-1", name: "Story Student", examTrackId: "usmle_step_1", exam: "USMLE Step 1", targetDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), dailyHours: 3, weeklyStudyDays: 6, weakAreas: ["Cardiology", "Perfusion"], createdAt: now, updatedAt: now },
    },
    aylaPlans: {
      access: { id: "access", name: "Tutor Access", plan_type: "monthly", billing_type: "subscription_monthly", is_active: true, is_public: true, is_full_access: false, included_features: ["personal_tutor", "roadmap"], exam_tracks: ["usmle_step_1"], feature_matrix_version: 1 },
    },
    aylaEnrollments: {
      access: { id: "access", user_id: "user-1", student_id: "student-1", plan_id: "access", exam_track_id: "usmle_step_1", type: "paid", status: "active", access_granted: true, access_starts_at: now, access_expires_at: future, createdAt: now, updatedAt: now },
    },
    aylaResources: {
      "question-1": { id: "question-1", type: "internal_mcq", title: "Verified perfusion question", examTrackId: "usmle_step_1", system: "Cardiology", topic: "Perfusion", approved: true, status: "active", verificationStatus: "approved", correctAnswer: "PRIVATE-SERVER-ANSWER", explanation: "PRIVATE-SERVER-EXPLANATION", estimatedMinutes: 2 },
    },
    aylaDailyPlans: {
      current: { id: "current", studentId: "student-1", userId: "user-1", date, version: 3, status: "active", capacityMinutes: 180, plannedMinutes: 30, completionPercent: 0, assignmentIds: ["assignment-1"], focusSystem: "Cardiology", focusTopic: "Perfusion", createdAt: now, updatedAt: now },
    },
    aylaResourceAssignments: {
      "assignment-1": { id: "assignment-1", studentId: "student-1", userId: "user-1", dailyPlanId: "current", scheduledDate: date, category: "internal_mcqs", type: "internal_mcqs", title: "Perfusion focused block", system: "Cardiology", topic: "Perfusion", resourceIds: ["question-1"], items: [{ resourceId: "question-1", title: "Verified perfusion question", system: "Cardiology", topic: "Perfusion" }], estimatedMinutes: 30, status: "pending", priority: "High", createdAt: now, updatedAt: now },
    },
  };
  const originalLive = JSON.stringify(liveDb);
  await fs.writeFile(livePath, originalLive);
  await fs.writeFile(crmPath, JSON.stringify(crmDb));
  await fs.writeFile(aylaPath, JSON.stringify(aylaDb));

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
    env: {
      ...process.env,
      PORT: String(port), DATA_DIR: dataDir,
      AUTH_JWT_SECRET: "v216-lms-secret", AYLA_AUTH_JWT_SECRET: "v216-ayla-secret", AYLA_ADMIN_TOKEN: "v216-ayla-admin",
      NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false", ZOOM_RECORDING_RECOVERY_ENABLED: "false", NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED: "false",
      DATABASE_URL: "", OPENAI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    await waitForHealth(baseUrl, child, output);
    const unauthorized = await api(baseUrl, "/admin/crm/ai-training/success-stories", { method: "POST", body: { title: "No auth" } });
    assert.equal(unauthorized.response.status, 401, JSON.stringify(unauthorized.payload));

    const adminLogin = await api(baseUrl, "/auth/login", { method: "POST", body: { email: "governance-admin@example.com", password: adminPassword } });
    assert.equal(adminLogin.response.status, 200, JSON.stringify(adminLogin.payload));
    const adminToken = adminLogin.payload.token;
    const studentLogin = await api(baseUrl, "/api/ayla/auth/login", { method: "POST", body: { email: "story-student@example.com", password: studentPassword } });
    assert.equal(studentLogin.response.status, 200, JSON.stringify(studentLogin.payload));
    const studentToken = studentLogin.payload.token;

    const created = await api(baseUrl, "/admin/crm/ai-training/success-stories", {
      method: "POST", token: adminToken,
      body: {
        title: "Focused perfusion recovery",
        exam_track_id: "USMLE Step 1",
        challenge_tags: ["Cardiology", "Perfusion"],
        strategy_tags: ["focused block", "error log"],
        strategy_steps: [{ action: "STUDENT-SAFE-FOCUSED-PERFUSION-TACTIC", why_it_helped: "Reduced context switching", use_when: "The roadmap focus is Perfusion" }],
        applicability_notes: "Adapt this tactic to the current roadmap assignment only.",
        limitations: "It may not fit every learner and does not replace the roadmap.",
        outcome_summary: "CONFIDENTIAL-OUTCOME-SUMMARY: verified completion and accuracy improved.",
        source_reference: "PRIVATE_SOURCE_REFERENCE_216",
      },
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    const storyId = created.payload.story.id;
    assert.equal(created.payload.story.governance_version, 1);
    assert.equal(created.payload.story.status, "draft");

    const blockedApproval = await api(baseUrl, `/admin/crm/ai-training/success-stories/${storyId}/review`, { method: "POST", token: adminToken, body: { expected_governance_version: 1, action: "approve" } });
    assert.equal(blockedApproval.response.status, 400, JSON.stringify(blockedApproval.payload));
    assert.equal(blockedApproval.payload.code, "SUCCESS_STORY_APPROVAL_BLOCKED");
    assert.ok(blockedApproval.payload.details.reasons.includes("consent_verification_required"));

    const completed = await api(baseUrl, `/admin/crm/ai-training/success-stories/${storyId}`, {
      method: "PUT", token: adminToken,
      body: { expected_governance_version: 1, consent_verified: true, anonymized: true, evidence_basis: "mixed_verified_evidence" },
    });
    assert.equal(completed.response.status, 200, JSON.stringify(completed.payload));
    assert.equal(completed.payload.story.governance_version, 2);

    const stale = await api(baseUrl, `/admin/crm/ai-training/success-stories/${storyId}`, { method: "PUT", token: adminToken, body: { expected_governance_version: 1, limitations: "Stale edit" } });
    assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));
    assert.equal(stale.payload.code, "STALE_SUCCESS_STORY_VERSION");

    const approved = await api(baseUrl, `/admin/crm/ai-training/success-stories/${storyId}/review`, { method: "POST", token: adminToken, body: { expected_governance_version: 2, action: "approve", note: "Evidence and anonymization reviewed" } });
    assert.equal(approved.response.status, 200, JSON.stringify(approved.payload));
    assert.equal(approved.payload.story.status, "approved");
    assert.equal(approved.payload.story.governance_version, 3);
    assert.equal(approved.payload.story.consumption_eligible, true);

    const tutor = await api(baseUrl, `/api/ayla/students/student-1/personal-tutor?date=${date}`, { token: studentToken });
    assert.equal(tutor.response.status, 200, JSON.stringify(tutor.payload));
    assert.equal(tutor.payload.decision.successStoryGuidance.count, 1);
    assert.equal(tutor.payload.decision.successStoryGuidance.changesRoadmapAutomatically, false);
    assert.equal(tutor.payload.decision.successStoryGuidance.strategies[0].strategySteps[0].action, "STUDENT-SAFE-FOCUSED-PERFUSION-TACTIC");
    const tutorJson = JSON.stringify(tutor.payload);
    assert.doesNotMatch(tutorJson, /CONFIDENTIAL-OUTCOME-SUMMARY|PRIVATE_SOURCE_REFERENCE_216|governance-admin@example\.com|fixture-reviewer@example\.com|CROSS-EXAM-STRATEGY|DRAFT-STRATEGY|PRIVATE-SERVER-ANSWER|PRIVATE-SERVER-EXPLANATION/);

    const edited = await api(baseUrl, `/admin/crm/ai-training/success-stories/${storyId}`, { method: "PUT", token: adminToken, body: { expected_governance_version: 3, limitations: "Updated limitation requires fresh approval." } });
    assert.equal(edited.response.status, 200, JSON.stringify(edited.payload));
    assert.equal(edited.payload.reapproval_required, true);
    assert.equal(edited.payload.story.status, "needs_review");
    assert.equal(edited.payload.story.active, false);
    assert.equal(edited.payload.story.governance_version, 4);

    const tutorAfterEdit = await api(baseUrl, `/api/ayla/students/student-1/personal-tutor?date=${date}`, { token: studentToken });
    assert.equal(tutorAfterEdit.response.status, 200, JSON.stringify(tutorAfterEdit.payload));
    assert.equal(tutorAfterEdit.payload.decision.successStoryGuidance.count, 0);

    const archived = await api(baseUrl, `/admin/crm/ai-training/success-stories/${storyId}`, { method: "DELETE", token: adminToken, body: { expected_governance_version: 4, note: "Archived after governance test" } });
    assert.equal(archived.response.status, 200, JSON.stringify(archived.payload));
    assert.equal(archived.payload.deleted, false);
    assert.equal(archived.payload.history_preserved, true);
    assert.equal(archived.payload.story.status, "archived");

    const audit = await api(baseUrl, `/admin/crm/ai-training/success-stories/audit?story_id=${storyId}`, { token: adminToken });
    assert.equal(audit.response.status, 200, JSON.stringify(audit.payload));
    assert.ok(audit.payload.count >= 5);
    assert.ok(audit.payload.audit.some((row) => row.action === "approve"));
    assert.ok(audit.payload.audit.some((row) => row.action === "archive"));

    const storedCrm = JSON.parse(await fs.readFile(crmPath, "utf8"));
    const storedAyla = JSON.parse(await fs.readFile(aylaPath, "utf8"));
    assert.equal(storedCrm.sentinel, "crm-governance-v216");
    assert.deepEqual(storedCrm.ai_training_documents, [{ id: "generic-document-sentinel" }]);
    assert.deepEqual(storedCrm.ai_training_items, [{ id: "generic-training-sentinel" }]);
    assert.ok(storedCrm.ai_success_stories.some((story) => story.id === storyId && story.status === "archived"));
    assert.ok(storedCrm.ai_success_story_audit_logs.length >= 5);
    assert.doesNotMatch(JSON.stringify(storedAyla), new RegExp(storyId));
    assert.equal(await fs.readFile(livePath, "utf8"), originalLive);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
