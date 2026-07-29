import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  AYLA_CONTINUITY_EXAM_TRACKS,
  buildAylaCarryContext,
  buildAylaEngagementMessages,
  buildAylaExamHandoffState,
  createAylaExamHandoff,
  normalizeAylaContinuityExamTrack,
  normalizeAylaEngagementPreferences,
  suggestAylaNextExam,
} from "../lib/aylamed-exam-continuity.js";

test("all supported exam dashboards use the same continuity policy without inventing progressions", () => {
  assert.deepEqual(AYLA_CONTINUITY_EXAM_TRACKS, [
    "usmle_step_1",
    "usmle_step_2_ck",
    "usmle_step_3",
    "plab",
    "amc",
    "mccqe",
    "nclex",
  ]);
  assert.equal(normalizeAylaContinuityExamTrack("USMLE Step 2 CK"), "usmle_step_2_ck");
  assert.equal(suggestAylaNextExam("USMLE Step 1"), "usmle_step_2_ck");
  assert.equal(suggestAylaNextExam("USMLE Step 2 CK"), "usmle_step_3");
  assert.equal(suggestAylaNextExam("PLAB"), null);
  assert.equal(suggestAylaNextExam("NCLEX"), null);
});

test("handoff requires source completion, target entitlement, target setup and a new target baseline", () => {
  assert.equal(buildAylaExamHandoffState({
    sourceExamTrack: "usmle_step_1",
    targetExamTrack: "usmle_step_2_ck",
  }).state, "awaiting_source_completion");
  assert.equal(buildAylaExamHandoffState({
    sourceExamTrack: "usmle_step_1",
    targetExamTrack: "usmle_step_2_ck",
    sourceCompletionStatus: "confirmed",
  }).state, "awaiting_target_entitlement");
  assert.equal(buildAylaExamHandoffState({
    sourceExamTrack: "usmle_step_1",
    targetExamTrack: "usmle_step_2_ck",
    sourceCompletionStatus: "confirmed",
    targetEntitled: true,
  }).state, "target_setup_required");
  assert.equal(buildAylaExamHandoffState({
    sourceExamTrack: "usmle_step_1",
    targetExamTrack: "usmle_step_2_ck",
    sourceCompletionStatus: "confirmed",
    targetEntitled: true,
    targetProfileExists: true,
  }).state, "baseline_required");
  const activated = buildAylaExamHandoffState({
    sourceExamTrack: "usmle_step_1",
    targetExamTrack: "usmle_step_2_ck",
    sourceCompletionStatus: "confirmed",
    targetEntitled: true,
    targetProfileExists: true,
    targetBaselineVerified: true,
  });
  assert.equal(activated.state, "activated");
  assert.equal(activated.targetRoadmapMayUseSourceScores, false);
});

test("carry context includes study behavior and reference-only revision, never scores or mastery", () => {
  const carry = buildAylaCarryContext({
    sourceStudent: {
      examTrackId: "usmle_step_1",
      timezone: "Asia/Karachi",
      dailyHours: 4,
      weeklyStudyDays: 6,
      preferredStudyDays: ["Monday", "Tuesday"],
      currentScore: 78,
      serverVerifiedBaseline: true,
      weakAreas: ["Renal"],
    },
    behaviorEvidence: {
      completedStudyDays: 24,
      missedStudyDays: 3,
      averageCompletedMinutes: 190,
    },
    revisionItems: [
      { system: "Renal", topic: "Acid base", reasons: ["repeat miss"] },
      { system: "Renal", topic: "Acid base", reasons: ["duplicate"] },
    ],
  });
  assert.equal(carry.studyBehavior.dailyHours, 4);
  assert.equal(carry.revisionReferences.length, 1);
  assert.equal(carry.revisionReferences[0].referenceOnly, true);
  assert.equal(carry.revisionReferences[0].appliedToTargetMastery, false);
  assert.equal(carry.transferPolicy.newTargetBaselineRequired, true);
  assert.doesNotMatch(JSON.stringify(carry), /78|currentScore|serverVerifiedBaseline|weakAreas/);

  const record = createAylaExamHandoff({
    idFactory: () => "handoff-1",
    now: new Date("2026-07-30T10:00:00.000Z"),
    userId: "user-1",
    sourceStudentId: "step-1",
    sourceCompletionStatus: "confirmed",
    sourceExamTrack: "usmle_step_1",
    targetExamTrack: "usmle_step_2_ck",
    targetEntitled: true,
    targetProfileExists: true,
    carryContext: carry,
  });
  assert.equal(record.status, "baseline_required");
  assert.equal(record.sourceScoresCopied, false);
  assert.equal(record.sourceBaselineCopied, false);
  assert.equal(record.targetBaselineRequired, true);
});

test("coaching email defaults to opt-out and honors quiet hours, dedupe and a one-per-day cap", () => {
  const defaults = normalizeAylaEngagementPreferences({}, { timezone: "UTC" });
  assert.equal(defaults.coachingEmailOptIn, false);
  assert.equal(defaults.weeklySummaryEmailOptIn, false);
  assert.equal(defaults.maxCoachingEmailsPerDay, 1);

  const facts = {
    student: { id: "student-1", name: "Ayla Student", timezone: "UTC", exam: "USMLE Step 1" },
    user: { name: "Ayla Student" },
    progress: {
      totalTasksToday: 4,
      completedTasksToday: 2,
      minutesRemainingToday: 35,
      plannedTasksThisWeek: 20,
      completedTasksThisWeek: 15,
      verifiedImprovementPercent: 6,
      readinessDaysLow: 18,
      readinessDaysHigh: 24,
    },
    preferences: {
      coachingEmailOptIn: true,
      weeklySummaryEmailOptIn: true,
      timezone: "UTC",
      weeklySummaryDay: "Sunday",
      quietHoursStart: 21,
      quietHoursEnd: 8,
      maxCoachingEmailsPerDay: 1,
    },
  };
  const preview = buildAylaEngagementMessages({
    ...facts,
    now: new Date("2026-08-02T19:00:00.000Z"),
  });
  assert.equal(preview.messages.length, 1);
  assert.equal(preview.messages[0].kind, "daily_incomplete");
  assert.equal(preview.suppressed.some((row) => row.reason === "daily_frequency_cap"), true);

  const quiet = buildAylaEngagementMessages({
    ...facts,
    now: new Date("2026-08-02T22:00:00.000Z"),
  });
  assert.equal(quiet.messages.length, 0);
  assert.equal(quiet.suppressed.some((row) => row.reason === "quiet_hours"), true);

  const replay = buildAylaEngagementMessages({
    ...facts,
    now: new Date("2026-08-02T19:00:00.000Z"),
    deliveries: [{
      status: "sent",
      category: "coaching",
      localDateKey: "2026-08-02",
      messageKey: "daily_incomplete:student-1:2026-08-02",
    }],
  });
  assert.equal(replay.messages.length, 0);

  const activeClaim = buildAylaEngagementMessages({
    ...facts,
    now: new Date("2026-08-02T19:00:00.000Z"),
    deliveries: [{
      status: "queued",
      category: "coaching",
      localDateKey: "2026-08-02",
      messageKey: "daily_incomplete:student-1:2026-08-02",
      claimExpiresAt: "2026-08-02T19:30:00.000Z",
    }],
  });
  assert.equal(activeClaim.messages.length, 0);

  const expiredClaim = buildAylaEngagementMessages({
    ...facts,
    now: new Date("2026-08-02T19:00:00.000Z"),
    deliveries: [{
      status: "queued",
      category: "coaching",
      localDateKey: "2026-08-02",
      messageKey: "daily_incomplete:student-1:2026-08-02",
      claimExpiresAt: "2026-08-02T18:30:00.000Z",
    }],
  });
  assert.equal(expiredClaim.messages[0]?.kind, "daily_incomplete");
});

test("renewal notices are factual, exam-scoped and do not copy a baseline to another exam", () => {
  const preview = buildAylaEngagementMessages({
    now: new Date("2026-07-30T12:00:00.000Z"),
    student: { id: "student-1", name: "Student", timezone: "UTC", exam: "USMLE Step 1" },
    user: { name: "Student" },
    enrollment: {
      id: "enrollment-1",
      access_expires_at: "2026-08-06T12:00:00.000Z",
    },
    preferences: { accountEmailEnabled: true, timezone: "UTC" },
  });
  assert.equal(preview.messages.length, 1);
  assert.equal(preview.messages[0].kind, "renewal_notice");
  assert.match(preview.messages[0].text, /different exam still requires its own entitlement and a new baseline/i);
});

test("continuity messaging contains no shame or dependency language", () => {
  const source = fs.readFileSync(
    new URL("../lib/aylamed-exam-continuity.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\bdon'?t be lazy\b|\blazy\b|later regret|can'?t study without|make .*dependent/i);
  assert.match(source, /opt out of coaching messages/i);
  assert.match(source, /not a pass guarantee/i);
});

test("server keeps continuity delivery off by default and consumes carry context only after the target baseline", () => {
  const server = fs.readFileSync(
    new URL("../server.js", import.meta.url),
    "utf8",
  );
  assert.match(server, /schema_version: 15/);
  assert.match(server, /email_delivery_enabled: false/);
  assert.match(server, /AYLA_CONTINUITY_EMAIL_DELIVERY_ENABLED/);
  assert.match(server, /AYLA_CONTINUITY_EMAIL_RUNNER_ENABLED/);
  assert.match(server, /SEND_ELIGIBLE_CONTINUITY_EMAILS/);
  assert.match(server, /function aylaClaimContinuityDelivery/);
  assert.match(server, /attempts >= 3/);
  assert.match(server, /function aylaContinuityActivatedCarryForStudent/);
  assert.match(server, /student\.serverVerifiedBaseline !== true/);
  assert.match(server, /targetBaselineAuthoritative: true/);
  assert.match(server, /Reference-only prior-exam revision topic/);
  assert.match(server, /sourceScoresCopied: false/);
  assert.match(server, /sourceBaselineCopied: false/);
});
