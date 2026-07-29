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

async function waitForHealth(baseUrl, child, output, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Profile smoke server exited (${child.exitCode})\n${output.join("")}`);
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Profile smoke server health timeout\n${output.join("")}`);
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
  try { payload = JSON.parse(text); }
  catch { throw new Error(`${method} ${route} returned ${response.status}: ${text.slice(0, 500)}`); }
  return { response, payload };
}

test("v219 serves one safe profile contract through isolated LMS and AylaMed stores", { timeout: 60_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "student-profile-v219-http-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const aylaPath = path.join(dataDir, "aylamed-db.json");
  const crmPath = path.join(dataDir, "crm-db.json");
  const lmsPassword = "LmsProfile9!";
  const aylaPassword = "AylaProfile9!";
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 365 * 86_400_000).toISOString();

  const liveDb = {
    sentinel: "lms-profile-v219",
    users: {
      "lms-user-1": {
        id: "lms-user-1", email: "lms-profile@example.com", name: "Original LMS Name", role: "student", verified: true,
        ...passwordRecord(lmsPassword, "lmsprofilesalt1234567890abcdef"), created_at: now, updated_at: now,
      },
      "lms-user-2": {
        id: "lms-user-2", email: "second@example.com", name: "Second Student", role: "student", verified: true,
        student_profile: { username: "already_taken", profile_visibility: "students_only", discoverable: true },
      },
    },
    leaderboard: {
      "course:lms-user-1": { id: "course:lms-user-1", course_id: "course", user_id: "lms-user-1", user_name: "Original LMS Name", total_points: 77, task_points: 40 },
    },
    globalCommunityPosts: {
      post: { id: "post", user_id: "lms-user-1", user_name: "Original LMS Name", content: "DO-NOT-CHANGE-CONTENT", status: "active" },
    },
    globalCommunityComments: {
      comment: { id: "comment", post_id: "post", user_id: "lms-user-1", user_name: "Original LMS Name", content: "DO-NOT-CHANGE-COMMENT", status: "active" },
    },
    studyPartnerProfiles: {
      partner: { id: "partner", user_id: "lms-user-1", user_name: "Original LMS Name", email: "lms-profile@example.com", whatsapp: "+12025550123", visibility: "students_only", status: "active" },
    },
    courses: {
      course: { id: "course", name: "Profile Safety Course", is_active: true, status: "active" },
    },
    plans: {
      profile: { id: "profile", name: "Profile Access", is_active: true, status: "active", included_features: ["study_partner"] },
    },
    enrollments: {
      "profile-access": {
        id: "profile-access", user_id: "lms-user-1", course_id: "course", plan_id: "profile",
        is_demo: false, access_granted: true, status: "active", access_expires_at: future,
      },
    },
    studentProfileAuditEvents: {},
  };
  const aylaDb = {
    sentinel: "ayla-profile-v219",
    schema_version: 12,
    aylaUsers: {
      "ayla-user-1": {
        id: "ayla-user-1", email: "ayla-profile@example.com", name: "Original Ayla Name", role: "student", status: "active",
        studentId: null, activeExamTrackId: "usmle_step_1", authVersion: 1,
        ...passwordRecord(aylaPassword, "aylaprofilesalt123456789abcdef"), createdAt: now, updatedAt: now,
      },
      "ayla-user-2": {
        id: "ayla-user-2", email: "ayla-second@example.com", name: "Second Ayla", role: "student", status: "active", authVersion: 1,
        student_profile: { username: "ayla_taken", profile_visibility: "students_only", discoverable: true },
      },
    },
    aylaStudents: {
      "ayla-student-1": {
        id: "ayla-student-1", ayla_user_id: "ayla-user-1", user_id: "ayla-user-1", name: "Original Ayla Name",
        examTrackId: "usmle_step_1", exam: "USMLE Step 1", dailyHours: 3, weeklyStudyDays: 6, studyPartnerOptIn: true,
        createdAt: now, updatedAt: now,
      },
    },
    aylaPlans: {
      full: { id: "full", name: "Full", is_active: true, status: "active", is_full_access: true, exam_tracks: ["usmle_step_1"] },
    },
    aylaEnrollments: {
      access: { id: "access", user_id: "ayla-user-1", student_id: "ayla-student-1", plan_id: "full", exam_track_id: "usmle_step_1", status: "active", access_granted: true, access_expires_at: future },
    },
    aylaCommunityProfiles: {},
    aylaProfileAuditEvents: {},
  };
  const crmOriginal = JSON.stringify({ sentinel: "crm-profile-untouched-v219", ai_training_documents: [], ai_training_items: [] }, null, 2);
  const aylaOriginal = JSON.stringify(aylaDb, null, 2);
  await fs.writeFile(livePath, JSON.stringify(liveDb, null, 2));
  await fs.writeFile(aylaPath, aylaOriginal);
  await fs.writeFile(crmPath, crmOriginal);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
    env: {
      ...process.env,
      PORT: String(port), DATA_DIR: dataDir,
      AUTH_JWT_SECRET: "v219-lms-profile-secret", AYLA_AUTH_JWT_SECRET: "v219-ayla-profile-secret",
      DATABASE_URL: "", OPENAI_API_KEY: "",
      NEXTGEN_BACKEND_HEARTBEAT_ENABLED: "false", NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false",
      ZOOM_RECORDING_RECOVERY_ENABLED: "false", NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    await waitForHealth(baseUrl, child, output);
    const health = await api(baseUrl, "/health");
    assert.equal(health.payload.build, "v219-safe-shared-student-profile");

    const lmsLogin = await api(baseUrl, "/auth/login", { method: "POST", body: { email: "lms-profile@example.com", password: lmsPassword } });
    assert.equal(lmsLogin.response.status, 200, JSON.stringify(lmsLogin.payload));
    const lmsToken = lmsLogin.payload.token;
    const lmsMe = await api(baseUrl, "/auth/me", { token: lmsToken });
    assert.equal(lmsMe.response.status, 200, JSON.stringify(lmsMe.payload));
    assert.match(lmsMe.response.headers.get("cache-control") || "", /private, no-store/);
    assert.equal(lmsMe.payload.profile_contract, "v219.1");
    assert.equal(lmsMe.payload.profile.email, "lms-profile@example.com");
    assert.equal(lmsMe.payload.profile_policy.privacy.phone_and_address, "owner_only");

    const lmsUpdated = await api(baseUrl, "/auth/me", {
      method: "PATCH", token: lmsToken,
      body: {
        display_name: "Dr. Amna Khan", username: "amna_khan", bio: "Focused licensing-exam learner.",
        phone: "+92 300 1234567", address_line_1: "Flat #9, Main Road", address_line_2: "Block B",
        city: "Karachi", region: "Sindh", postal_code: "75500", country_code: "PK",
        timezone: "Asia/Karachi", language: "en-PK", profile_visibility: "students_only", discoverable: true,
      },
    });
    assert.equal(lmsUpdated.response.status, 200, JSON.stringify(lmsUpdated.payload));
    assert.equal(lmsUpdated.payload.profile.phone, "+923001234567");
    assert.equal(lmsUpdated.payload.profile.phone_verified, false);
    assert.equal(lmsUpdated.payload.profile.address_line_1, "Flat #9, Main Road");
    assert.equal(lmsUpdated.payload.user.email, "lms-profile@example.com");
    assert.equal(lmsUpdated.payload.user.role, "student");

    const lmsRoleAttack = await api(baseUrl, "/auth/me", { method: "PATCH", token: lmsToken, body: { role: "admin" } });
    assert.equal(lmsRoleAttack.response.status, 403, JSON.stringify(lmsRoleAttack.payload));
    assert.equal(lmsRoleAttack.payload.code, "PROFILE_FIELD_IMMUTABLE");
    const lmsProfanity = await api(baseUrl, "/auth/me", { method: "PATCH", token: lmsToken, body: { display_name: "f u c k" } });
    assert.equal(lmsProfanity.response.status, 400, JSON.stringify(lmsProfanity.payload));
    const lmsContactLeak = await api(baseUrl, "/auth/me", { method: "PATCH", token: lmsToken, body: { bio: "Call +92 300 9999999" } });
    assert.equal(lmsContactLeak.response.status, 400, JSON.stringify(lmsContactLeak.payload));

    const partnerEmailAttack = await api(baseUrl, "/study-partner/profile/me", { method: "POST", token: lmsToken, body: { email: "attacker@example.com" } });
    assert.equal(partnerEmailAttack.response.status, 403, JSON.stringify(partnerEmailAttack.payload));
    const partnerStatusAttack = await api(baseUrl, "/study-partner/profile/me", { method: "POST", token: lmsToken, body: { status: "approved" } });
    assert.equal(partnerStatusAttack.response.status, 403, JSON.stringify(partnerStatusAttack.payload));
    const partnerContactLeak = await api(baseUrl, "/study-partner/profile/me", { method: "POST", token: lmsToken, body: { bio: "Call me at +92 300 9999999" } });
    assert.equal(partnerContactLeak.response.status, 400, JSON.stringify(partnerContactLeak.payload));
    const partnerProfanity = await api(baseUrl, "/study-partner/profile/me", { method: "POST", token: lmsToken, body: { study_style: "f u c k" } });
    assert.equal(partnerProfanity.response.status, 400, JSON.stringify(partnerProfanity.payload));
    const partnerHandleProfanity = await api(baseUrl, "/study-partner/profile/me", { method: "POST", token: lmsToken, body: { telegram_username: "fuck_you" } });
    assert.equal(partnerHandleProfanity.response.status, 400, JSON.stringify(partnerHandleProfanity.payload));
    const partnerUnsafeBoolean = await api(baseUrl, "/study-partner/profile/me", { method: "POST", token: lmsToken, body: { allow_requests: "false" } });
    assert.equal(partnerUnsafeBoolean.response.status, 400, JSON.stringify(partnerUnsafeBoolean.payload));
    const partnerUpdated = await api(baseUrl, "/study-partner/profile/me", {
      method: "POST", token: lmsToken,
      body: {
        email: "lms-profile@example.com", whatsapp: "+44 20 7946 0958", telegram_username: "safe_student",
        exam_type: "USMLE Step 1", current_stage: "Dedicated study", timezone: "Asia/Karachi", country: "PK",
        target_exam_date: "2027-07-20", current_resources: ["First Aid", "UWorld"], current_subjects: ["Pathology"],
        available_hours_per_day: 4, available_hours_per_week: 24, preferred_time_blocks: ["Evening"],
        study_style: "Structured question review", looking_for: ["Accountability"], language_preference: ["English"],
        bio: "Consistent learner seeking focused study sessions.", visibility: "students_only",
        allow_requests: true, show_contact_after_accept: true, status: "active",
      },
    });
    assert.equal(partnerUpdated.response.status, 200, JSON.stringify(partnerUpdated.payload));
    assert.match(partnerUpdated.response.headers.get("cache-control") || "", /private, no-store/);
    assert.equal(partnerUpdated.payload.profile.whatsapp, "+442079460958");
    assert.equal(partnerUpdated.payload.profile.email, "lms-profile@example.com");
    assert.equal(partnerUpdated.payload.profile.status, "active");
    const partnerMe = await api(baseUrl, "/study-partner/profile/me", { token: lmsToken });
    assert.equal(partnerMe.response.status, 200, JSON.stringify(partnerMe.payload));
    assert.match(partnerMe.response.headers.get("cache-control") || "", /private, no-store/);

    const liveAfterLms = await fs.readFile(livePath, "utf8");
    const storedLive = JSON.parse(liveAfterLms);
    assert.equal(storedLive.users["lms-user-1"].role, "student");
    assert.equal(storedLive.users["lms-user-1"].email, "lms-profile@example.com");
    assert.equal(storedLive.leaderboard["course:lms-user-1"].user_name, "Dr. Amna Khan");
    assert.equal(storedLive.leaderboard["course:lms-user-1"].total_points, 77);
    assert.equal(storedLive.globalCommunityPosts.post.user_name, "Dr. Amna Khan");
    assert.equal(storedLive.globalCommunityPosts.post.content, "DO-NOT-CHANGE-CONTENT");
    assert.equal(storedLive.globalCommunityComments.comment.content, "DO-NOT-CHANGE-COMMENT");
    assert.equal(storedLive.studyPartnerProfiles.partner.whatsapp, "+442079460958");
    assert.equal(storedLive.studyPartnerProfiles.partner.email, "lms-profile@example.com");
    assert.equal(storedLive.studyPartnerProfiles.partner.status, "active");
    const lmsAudit = Object.values(storedLive.studentProfileAuditEvents || {});
    assert.equal(lmsAudit.length, 1);
    assert.equal(lmsAudit[0].contains_profile_values, false);
    assert.ok(lmsAudit[0].changed_fields.includes("address_line_1"));
    assert.doesNotMatch(JSON.stringify(lmsAudit), /Amna|923001234567|Main Road|amna_khan/);
    assert.equal(await fs.readFile(aylaPath, "utf8"), aylaOriginal);

    const aylaLogin = await api(baseUrl, "/api/ayla/auth/login", { method: "POST", body: { email: "ayla-profile@example.com", password: aylaPassword } });
    assert.equal(aylaLogin.response.status, 200, JSON.stringify(aylaLogin.payload));
    const aylaToken = aylaLogin.payload.token;
    const accountBefore = await api(baseUrl, "/api/ayla/account/profile", { token: aylaToken });
    assert.equal(accountBefore.response.status, 200, JSON.stringify(accountBefore.payload));
    assert.equal(accountBefore.payload.profile_contract, "v219.1");

    const aylaUpdated = await api(baseUrl, "/api/ayla/account/profile", {
      method: "PATCH", token: aylaToken,
      body: {
        display_name: "Dr. Sara Ali", username: "sara_ali", bio: "Preparing with an adaptive daily plan.",
        phone: "+1 (202) 555-0123", address_line_1: "22 Safe Street", city: "Boston", region: "MA",
        postal_code: "02108", country_code: "US", timezone: "America/New_York", language: "en-US",
        profile_visibility: "students_only", discoverable: true,
      },
    });
    assert.equal(aylaUpdated.response.status, 200, JSON.stringify(aylaUpdated.payload));
    assert.equal(aylaUpdated.payload.build, "aylamed-safe-shared-student-profile-v219");
    assert.equal(aylaUpdated.payload.profile.phone, "+12025550123");
    assert.equal(aylaUpdated.payload.profile.phone_verified, false);
    assert.equal(aylaUpdated.payload.user.role, "student");

    const aylaRoleAttack = await api(baseUrl, "/api/ayla/account/profile", { method: "PATCH", token: aylaToken, body: { role: "admin" } });
    assert.equal(aylaRoleAttack.response.status, 403, JSON.stringify(aylaRoleAttack.payload));
    const legacyProfanity = await api(baseUrl, "/api/ayla/profile", { method: "PUT", token: aylaToken, body: { studentId: "ayla-student-1", name: "sh1t doctor" } });
    assert.equal(legacyProfanity.response.status, 400, JSON.stringify(legacyProfanity.payload));
    const legacyRoleAttack = await api(baseUrl, "/api/ayla/profile", { method: "PUT", token: aylaToken, body: { studentId: "ayla-student-1", role: "admin" } });
    assert.equal(legacyRoleAttack.response.status, 403, JSON.stringify(legacyRoleAttack.payload));
    const aylaBeforeRollback = await fs.readFile(aylaPath, "utf8");
    const legacyRollback = await api(baseUrl, "/api/ayla/profile", {
      method: "PUT", token: aylaToken,
      body: { studentId: "ayla-student-1", bio: "This change must roll back safely.", examTrackId: "nclex" },
    });
    assert.equal(legacyRollback.response.status, 409, JSON.stringify(legacyRollback.payload));
    assert.equal(await fs.readFile(aylaPath, "utf8"), aylaBeforeRollback);
    const planningOnly = await api(baseUrl, "/api/ayla/profile", { method: "PUT", token: aylaToken, body: { studentId: "ayla-student-1", dailyHours: 4 } });
    assert.equal(planningOnly.response.status, 200, JSON.stringify(planningOnly.payload));
    assert.equal(planningOnly.payload.student.dailyHours, 4);

    const storedAyla = JSON.parse(await fs.readFile(aylaPath, "utf8"));
    assert.equal(storedAyla.schema_version, 14);
    assert.equal(storedAyla.aylaUsers["ayla-user-1"].role, "student");
    assert.equal(storedAyla.aylaUsers["ayla-user-1"].email, "ayla-profile@example.com");
    assert.equal(storedAyla.aylaStudents["ayla-student-1"].name, "Dr. Sara Ali");
    const community = Object.values(storedAyla.aylaCommunityProfiles || {})[0];
    assert.equal(community.displayName, "Dr. Sara Ali");
    assert.equal(community.username, "sara_ali");
    assert.equal(Object.hasOwn(community, "phone"), false);
    assert.equal(Object.hasOwn(community, "address_line_1"), false);
    const aylaAudit = Object.values(storedAyla.aylaProfileAuditEvents || {});
    assert.equal(aylaAudit.length, 1);
    assert.equal(aylaAudit[0].contains_profile_values, false);
    assert.doesNotMatch(JSON.stringify(aylaAudit), /Sara|12025550123|Safe Street|sara_ali/);

    assert.equal(await fs.readFile(livePath, "utf8"), liveAfterLms);
    assert.equal(await fs.readFile(crmPath, "utf8"), crmOriginal);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
