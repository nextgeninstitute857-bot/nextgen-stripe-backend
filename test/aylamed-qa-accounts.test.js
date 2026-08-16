import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AYLA_PERMANENT_QA, buildAylaPermanentQaScenarios } from "../lib/aylamed-qa-accounts.js";

test("permanent QA coverage includes every launch exam", () => {
  assert.deepEqual(AYLA_PERMANENT_QA.examTracks, [
    "usmle_step_1", "usmle_step_2_ck", "usmle_step_3", "mccqe", "plab", "amc", "nclex",
  ]);
});

test("each exam receives stable accounts for all three onboarding paths", () => {
  const scenarios = buildAylaPermanentQaScenarios({
    examTrack: "mccqe",
    examLabel: "MCCQE",
    systems: ["Family Medicine", "Internal Medicine"],
    today: "2026-08-16T12:00:00.000Z",
  });
  assert.deepEqual(scenarios.map((row) => row.onboardingPath), ["quick_profile", "starting_fresh", "diagnostic_test"]);
  assert.deepEqual(scenarios.map((row) => row.examDate), ["2026-08-23", "2026-09-15", "2026-11-08"]);
  assert.deepEqual(scenarios.map((row) => row.email), [
    "qa.mccqe.one-week@aylamedapp.com",
    "qa.mccqe.one-month@aylamedapp.com",
    "qa.mccqe.diagnostic@aylamedapp.com",
  ]);
});

test("QA accounts use the normal registration, entitlement, and onboarding contracts", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const grantRoute = server.slice(
    server.indexOf('app.post("/api/ayla/enrollments/grant-access"'),
    server.indexOf('app.post("/api/ayla/enrollments/:id/revoke"'),
  );
  const onboardingRoute = server.slice(
    server.indexOf('app.post("/api/ayla/diagnostic-submissions"'),
    server.indexOf('app.get("/api/ayla/students/:id/dashboard"'),
  );
  assert.match(server, /app\.post\("\/api\/ayla\/auth\/register"/);
  assert.match(grantRoute, /GRANT PERMANENT AYLAMED ACCESS/);
  assert.match(grantRoute, /enrollment\.access_expires_at = null/);
  assert.match(onboardingRoute, /normalizeAylaOnboardingSubmission/);
  assert.match(onboardingRoute, /auth\?\.rawUser\?\.testAccount/);
});
