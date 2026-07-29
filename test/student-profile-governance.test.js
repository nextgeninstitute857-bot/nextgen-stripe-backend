import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  STUDENT_PROFILE_CONTRACT_VERSION,
  applyStudentProfilePatch,
  moderateStudentProfileText,
  normalizeStudentProfilePhone,
  sanitizeStudentProfileForOwner,
  sanitizeStudentProfileForPublic,
  studentProfileContainsPublicContact,
  studentProfilePolicy,
} from "../lib/student-profile-governance.js";

const now = new Date("2026-07-20T12:00:00.000Z");

function user(extra = {}) {
  return {
    id: "student-1",
    email: "student@example.com",
    verified: true,
    name: "Original Student",
    avatar_url: "https://managed.example/avatar/student-1",
    role: "student",
    ...extra,
  };
}

test("one shared contract normalizes a complete safe international student profile", () => {
  const result = applyStudentProfilePatch(user(), {
    display_name: "  Dr. José O’Neil  ",
    username: "Med_Student.26",
    bio: "Preparing carefully for my licensing exam.",
    phone: "00 92 (300) 123-4567",
    address: {
      line_1: "Flat #4, Main Road",
      line_2: "Block A",
      city: "Karachi",
      region: "Sindh",
      postal_code: "75500",
      country_code: "pk",
    },
    timezone: "Asia/Karachi",
    language: "ur-pk",
    profile_visibility: "students_only",
    discoverable: true,
  }, {
    now,
    userId: "student-1",
    events: [],
    isUsernameAvailable: () => true,
  });

  assert.equal(result.changed, true);
  assert.equal(result.profile.contract_version, STUDENT_PROFILE_CONTRACT_VERSION);
  assert.equal(result.profile.display_name, "Dr. José O’Neil");
  assert.equal(result.profile.username, "med_student.26");
  assert.equal(result.profile.phone, "+923001234567");
  assert.equal(result.profile.phone_verified, false);
  assert.equal(result.profile.country_code, "PK");
  assert.equal(result.profile.timezone, "Asia/Karachi");
  assert.equal(result.profile.language, "ur-PK");
  assert.equal(result.profile.discoverable, true);
  assert.equal(result.phoneChanged, true);
});

test("owner and student-visible projections keep private contact data separated", () => {
  const record = user({
    student_profile: {
      contract_version: STUDENT_PROFILE_CONTRACT_VERSION,
      display_name: "Safe Student",
      username: "safe_student",
      bio: "Focused learner",
      phone: "+923001234567",
      phone_verified: false,
      address_line_1: "Private home",
      address_line_2: "Unit 2",
      city: "Karachi",
      region: "Sindh",
      postal_code: "75500",
      country_code: "PK",
      timezone: "Asia/Karachi",
      language: "en-PK",
      profile_visibility: "students_only",
      discoverable: true,
      updated_at: now.toISOString(),
    },
  });

  const owner = sanitizeStudentProfileForOwner(record);
  assert.equal(owner.email, "student@example.com");
  assert.equal(owner.phone, "+923001234567");
  assert.equal(owner.address_line_1, "Private home");
  assert.equal(Object.hasOwn(owner, "role"), false);

  const publicProfile = sanitizeStudentProfileForPublic(record);
  assert.equal(publicProfile.display_name, "Safe Student");
  assert.equal(Object.hasOwn(publicProfile, "email"), false);
  assert.equal(Object.hasOwn(publicProfile, "phone"), false);
  assert.equal(Object.hasOwn(publicProfile, "address_line_1"), false);

  record.student_profile.profile_visibility = "private";
  assert.equal(sanitizeStudentProfileForPublic(record), null);
});

test("profanity moderation catches leetspeak, spacing bypasses, and embedded username bypasses", () => {
  assert.equal(moderateStudentProfileText("Professional Pakistan Student", { strictCompact: true }).ok, true);
  assert.equal(moderateStudentProfileText("f u c k", { strictCompact: true }).ok, false);
  assert.equal(moderateStudentProfileText("sh1t", { strictCompact: true }).ok, false);
  assert.equal(moderateStudentProfileText("badword", { extraBlockedWords: ["badword"], strictCompact: true }).ok, false);

  assert.throws(
    () => applyStudentProfilePatch(user(), { username: "fuckingdoctor" }, { now, userId: "student-1", isUsernameAvailable: () => true }),
    (error) => error.code === "PROFILE_LANGUAGE_NOT_ALLOWED",
  );
  assert.throws(
    () => applyStudentProfilePatch(user(), { display_name: "f u c k" }, { now, userId: "student-1" }),
    (error) => error.code === "PROFILE_LANGUAGE_NOT_ALLOWED",
  );
});

test("public profile fields cannot be used to publish contact details or links", () => {
  for (const bio of [
    "Email me at student@example.com",
    "My number is +92 300 1234567",
    "See https://example.com/profile",
    "Message @private_handle",
  ]) {
    assert.equal(studentProfileContainsPublicContact(bio), true);
    assert.throws(
      () => applyStudentProfilePatch(user(), { bio }, { now, userId: "student-1" }),
      (error) => error.code === "PROFILE_PUBLIC_CONTACT_NOT_ALLOWED",
    );
  }
});

test("hidden characters, HTML, unsupported fields, and security-controlled fields fail closed", () => {
  assert.throws(
    () => applyStudentProfilePatch(user(), { display_name: "Safe\u202EName" }, { now, userId: "student-1" }),
    (error) => error.code === "PROFILE_HIDDEN_CHARACTERS",
  );
  assert.throws(
    () => applyStudentProfilePatch(user(), { bio: "<b>Doctor</b>" }, { now, userId: "student-1" }),
    (error) => error.code === "PROFILE_HTML_NOT_ALLOWED",
  );
  assert.throws(
    () => applyStudentProfilePatch(user(), { favorite_color: "blue" }, { now, userId: "student-1" }),
    (error) => error.code === "PROFILE_FIELD_UNSUPPORTED",
  );
  assert.throws(
    () => applyStudentProfilePatch(user(), { address: { line_1: "Safe Road", role: "admin" } }, { now, userId: "student-1" }),
    (error) => error.code === "PROFILE_FIELD_IMMUTABLE" && error.statusCode === 403,
  );
  assert.throws(
    () => applyStudentProfilePatch(user(), { address_line_1: "Safe Road", address: { line_1: "Different Road" } }, { now, userId: "student-1" }),
    (error) => error.code === "PROFILE_FIELD_CONFLICT",
  );
  assert.throws(
    () => applyStudentProfilePatch(user(), { role: "admin", email: "other@example.com" }, { now, userId: "student-1" }),
    (error) => error.code === "PROFILE_FIELD_IMMUTABLE" && error.statusCode === 403,
  );
  assert.throws(
    () => applyStudentProfilePatch(user(), { profileImageUrl: "https://tracker.example/pixel" }, { now, userId: "student-1" }),
    (error) => error.code === "PROFILE_FIELD_IMMUTABLE",
  );
});

test("phone edits require E.164 and always clear prior verification", () => {
  assert.equal(normalizeStudentProfilePhone("+1 (202) 555-0123"), "+12025550123");
  assert.throws(() => normalizeStudentProfilePhone("03001234567"), (error) => error.code === "PROFILE_PHONE_INVALID");

  const record = user({
    phone: "+12025550123",
    phone_verified: true,
    phone_verified_at: "2026-07-01T00:00:00.000Z",
  });
  const result = applyStudentProfilePatch(record, { phone: "+44 20 7946 0958" }, { now, userId: record.id });
  assert.equal(result.profile.phone, "+442079460958");
  assert.equal(result.profile.phone_verified, false);
  assert.equal(result.profile.phone_verified_at, null);
});

test("display-name and username cooldowns allow privacy removal but stop rapid identity hopping", () => {
  const record = user({
    student_profile: {
      display_name: "Current Name",
      username: "current_name",
      profile_visibility: "students_only",
      discoverable: true,
      display_name_changed_at: "2026-07-20T11:30:00.000Z",
      username_changed_at: "2026-07-19T12:00:00.000Z",
    },
  });
  assert.throws(
    () => applyStudentProfilePatch(record, { display_name: "Another Name" }, { now, userId: record.id }),
    (error) => error.code === "PROFILE_FIELD_COOLDOWN" && error.statusCode === 429,
  );
  assert.throws(
    () => applyStudentProfilePatch(record, { username: "another_name" }, { now, userId: record.id, isUsernameAvailable: () => true }),
    (error) => error.code === "PROFILE_FIELD_COOLDOWN",
  );
  const privacyRemoval = applyStudentProfilePatch(record, { username: "", profile_visibility: "private" }, { now, userId: record.id });
  assert.equal(privacyRemoval.profile.username, "");
  assert.equal(privacyRemoval.profile.profile_visibility, "private");
  assert.equal(privacyRemoval.profile.discoverable, false);
});

test("successful-event rate limiting and username uniqueness are enforced server-side", () => {
  const events = Array.from({ length: 10 }, (_, index) => ({
    id: `event-${index}`,
    user_id: "student-1",
    created_at: new Date(now.getTime() - index * 60_000).toISOString(),
  }));
  assert.throws(
    () => applyStudentProfilePatch(user(), { bio: "A new bio" }, { now, userId: "student-1", events }),
    (error) => error.code === "PROFILE_RATE_LIMITED" && error.statusCode === 429,
  );
  assert.throws(
    () => applyStudentProfilePatch(user(), { username: "already_taken" }, { now, userId: "student-1", isUsernameAvailable: () => false }),
    (error) => error.code === "PROFILE_USERNAME_TAKEN" && error.statusCode === 409,
  );
});

test("location, timezone, language, and discoverability use controlled formats", () => {
  assert.throws(
    () => applyStudentProfilePatch(user(), { country_code: "ZZ" }, { now, userId: "student-1" }),
    (error) => error.code === "PROFILE_COUNTRY_CODE_INVALID",
  );
  assert.throws(
    () => applyStudentProfilePatch(user(), { timezone: "Karachi/Now" }, { now, userId: "student-1" }),
    (error) => error.code === "PROFILE_TIMEZONE_INVALID",
  );
  assert.throws(
    () => applyStudentProfilePatch(user(), { language: "not_a_locale" }, { now, userId: "student-1" }),
    (error) => error.code === "PROFILE_LANGUAGE_INVALID",
  );
  assert.throws(
    () => applyStudentProfilePatch(user(), { discoverable: true }, { now, userId: "student-1" }),
    (error) => error.code === "PROFILE_DISCOVERABILITY_CONFLICT",
  );
  assert.throws(
    () => applyStudentProfilePatch(user(), { profile_visibility: "public" }, { now, userId: "student-1" }),
    (error) => error.code === "PROFILE_VISIBILITY_INVALID",
  );
});

test("policy tells both clients which data is private and which changes require separate verification", () => {
  const policy = studentProfilePolicy();
  assert.equal(policy.contract_version, STUDENT_PROFILE_CONTRACT_VERSION);
  assert.equal(policy.privacy.phone_and_address, "owner_only");
  assert.equal(policy.privacy.email_change, "separate_reverification_required");
  assert.equal(policy.privacy.phone_change, "stored_unverified_and_never_used_as_an_authenticator");
  assert.equal(policy.privacy.audit_values, "field_names_only");
  assert.deepEqual(policy.visibility_options, ["private", "students_only"]);
});

test("server wires v219 through the shared contract without crossing the LMS/Ayla database boundary", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /const NEXTGEN_BACKEND_BUILD = "v219-safe-shared-student-profile"/);
  assert.match(server, /const AYLA_BACKEND_BUILD = "aylamed-safe-shared-student-profile-v219"/);
  assert.match(server, /schema_version: 15/);
  assert.match(server, /studentProfileAuditEvents: \{\}/);
  assert.match(server, /aylaProfileAuditEvents: \{\}/);
  assert.match(server, /app\.patch\("\/auth\/me"/);
  assert.match(server, /app\.get\("\/api\/ayla\/account\/profile"/);
  assert.match(server, /app\.patch\("\/api\/ayla\/account\/profile"/);
  assert.match(server, /app\.put\("\/api\/ayla\/profile"[\s\S]*?aylaV219LegacyAccountProfilePatch/);

  const lmsRoute = server.slice(server.indexOf('app.patch("/auth/me"'), server.indexOf('app.post("/auth/logout"'));
  assert.match(lmsRoute, /mutateLiveDb\(async \(db\)/);
  assert.doesNotMatch(lmsRoute, /mutateAylaDb|writeAylaDb|writeCrmDb/);

  const aylaAccountRoutes = server.slice(server.indexOf('app.get("/api/ayla/account/profile"'), server.indexOf('app.post("/api/ayla/profile/preview"'));
  assert.match(aylaAccountRoutes, /mutateAylaDb\(async \(db\)/);
  assert.doesNotMatch(aylaAccountRoutes, /readLiveDb|writeLiveDb|mutateLiveDb|writeCrmDb/);

  const aylaLegacyRoute = server.slice(server.indexOf('app.put("/api/ayla/profile"'), server.indexOf("// Resource sync/registration"));
  assert.match(aylaLegacyRoute, /mutateAylaDb\(async \(db\)/);
  assert.doesNotMatch(aylaLegacyRoute, /readLiveDb|writeLiveDb|mutateLiveDb|writeCrmDb/);

  const studyPartnerRoute = server.slice(server.indexOf('app.post("/study-partner/profile/me"'), server.indexOf('app.get("/study-partner/matches"'));
  assert.match(studyPartnerRoute, /mutateLiveDb\(async \(db\)/);
  assert.doesNotMatch(studyPartnerRoute, /readAylaDb|writeAylaDb|mutateAylaDb|writeCrmDb/);
});
